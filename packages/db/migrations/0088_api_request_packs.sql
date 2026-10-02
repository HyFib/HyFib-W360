-- Packs of extra API requests (P5-01/P5-08, ADR-110).
--
-- A plan version with a monthly API request limit may sell packs of extra requests a month, as it
-- sells automation run packs (ADR-051): a pack size and a price per billing interval. Platform staff
-- set a company's packs with its plan; the company chooses them under Billing → Add-ons (ADR-106) and
-- when it changes its plan (ADR-109); a subscription records them and charges for them with the other
-- add-ons (ADR-063). The company's monthly limit is the version's limit plus its packs, wherever the
-- limit is read: the entitlements, the used-up notice and the warning before it.
--
-- A limit after packs is at most 2,000,000,000: the entitlements return limits as 32-bit integers.
-- The plan state's guard and the guard of a following subscription refuse more packs. The same bound
-- now applies to automation run packs: 10,000 packs of up to 10,000,000 runs could push that limit
-- past the integer range, and every entitlement check of the company then failed with "integer out
-- of range", as did the minute sweep's lookups for every company. Those lookups now add in 64 bits.

-- Plan versions ----------------------------------------------------------------------------------------
-- Both set or neither, and only with a monthly limit above 0: a version without a limit, or without
-- the API, has no limit to add to. Versions created before this migration sell none.
ALTER TABLE ops.plans
  ADD COLUMN api_request_pack_size integer
    CHECK (api_request_pack_size BETWEEN 1 AND 100000000),
  ADD COLUMN api_request_pack_price_minor bigint
    CHECK (api_request_pack_price_minor BETWEEN 0 AND 1000000000000),
  ADD CONSTRAINT plans_api_request_pack_pair_check
    CHECK ((api_request_pack_size IS NULL) = (api_request_pack_price_minor IS NULL)),
  ADD CONSTRAINT plans_api_request_pack_limit_check
    CHECK (api_request_pack_size IS NULL OR coalesce(api_requests_monthly, 0) > 0);
GRANT UPDATE (api_request_pack_size, api_request_pack_price_minor) ON ops.plans TO w360_platform;

-- The plan guard compares the new columns too, so a published version still cannot change (0083's
-- guard otherwise).
CREATE OR REPLACE FUNCTION ops.guard_plan() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF (NEW.id, NEW.code, NEW.version, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.code, OLD.version, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'A plan version keeps its code, number and author.' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'published', 'retired') THEN
      RAISE EXCEPTION 'Invalid plan status.' USING ERRCODE = 'W3403';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'published' AND NEW.status IN ('published', 'retired') THEN
    IF (NEW.name, NEW.description, NEW.currency, NEW.price_minor, NEW.interval_months, NEW.trial_days,
        NEW.grace_days, NEW.seats_included, NEW.seat_price_minor, NEW.seats_max, NEW.numbers_included,
        NEW.number_price_minor, NEW.numbers_max, NEW.teams_max, NEW.live_automations_max,
        NEW.automation_runs_monthly, NEW.run_pack_size, NEW.run_pack_price_minor, NEW.modules,
        NEW.api_requests_monthly, NEW.api_scopes, NEW.api_request_pack_size,
        NEW.api_request_pack_price_minor, NEW.published_by_user_id, NEW.published_at)
       IS DISTINCT FROM
       (OLD.name, OLD.description, OLD.currency, OLD.price_minor, OLD.interval_months, OLD.trial_days,
        OLD.grace_days, OLD.seats_included, OLD.seat_price_minor, OLD.seats_max, OLD.numbers_included,
        OLD.number_price_minor, OLD.numbers_max, OLD.teams_max, OLD.live_automations_max,
        OLD.automation_runs_monthly, OLD.run_pack_size, OLD.run_pack_price_minor, OLD.modules,
        OLD.api_requests_monthly, OLD.api_scopes, OLD.api_request_pack_size,
        OLD.api_request_pack_price_minor, OLD.published_by_user_id, OLD.published_at) THEN
      RAISE EXCEPTION 'A published plan version cannot change. Create a new version instead.'
        USING ERRCODE = 'W3403';
    END IF;
    -- The version stops being offered (withdrawn, or retired, which clears the offer): wait for
    -- choices of it in progress, which hold this lock shared (app.choose_plan), so none of them
    -- commits after the offer stops.
    IF OLD.offered_at IS NOT NULL AND NEW.offered_at IS NULL THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('w360:plan-offer:' || OLD.id::text, 0));
    END IF;
    IF NEW.status = 'retired'
       AND EXISTS (SELECT 1 FROM ops.plan_settings s WHERE s.default_trial_plan_id = OLD.id) THEN
      RAISE EXCEPTION 'This version is the default trial. Choose another default trial first.'
        USING ERRCODE = 'W3412';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A published plan version cannot change. Create a new version instead.'
    USING ERRCODE = 'W3403';
END
$$;

-- Company plan state -------------------------------------------------------------------------------------
-- The company's packs: none without a plan, like the other add-ons (0023's check).
ALTER TABLE app.tenant_plans
  ADD COLUMN api_request_packs integer NOT NULL DEFAULT 0
    CHECK (api_request_packs BETWEEN 0 AND 10000),
  ADD CONSTRAINT tenant_plans_api_request_packs_plan_check
    CHECK (plan_id IS NOT NULL OR api_request_packs = 0);
GRANT UPDATE (api_request_packs) ON app.tenant_plans TO w360_platform;

-- As in 0087, and packs stay within what the version sells: API request packs only from a version
-- that sells them, and no more packs of either kind than keep the limit within 2,000,000,000. The
-- sums are 64-bit, so a refusal never fails on the integer range itself.
CREATE OR REPLACE FUNCTION app.guard_tenant_plan() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v ops.plans%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.tenant_id) IS DISTINCT FROM (OLD.id, OLD.tenant_id) THEN
    RAISE EXCEPTION 'A plan state belongs to its company.' USING ERRCODE = 'W3403';
  END IF;
  IF NEW.plan_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v FROM ops.plans p WHERE p.id = NEW.plan_id;
  IF NOT FOUND OR v.status = 'draft'
     OR (v.status = 'retired' AND (TG_OP = 'INSERT' OR NEW.plan_id IS DISTINCT FROM OLD.plan_id)
         AND NOT (TG_OP = 'UPDATE' AND NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
                  AND EXISTS (
                    SELECT 1 FROM app.plan_subscriptions s
                     WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.subscription_id
                       AND s.follows_subscription_id = OLD.subscription_id
                       AND s.plan_id = NEW.plan_id
                       AND s.current_start = NEW.period_start
                       AND s.current_end = NEW.period_end))) THEN
    RAISE EXCEPTION 'Only a published plan version can be assigned.' USING ERRCODE = 'W3412';
  END IF;
  IF NEW.extra_seats > 0 AND (v.seat_price_minor IS NULL
       OR (v.seats_max IS NOT NULL AND v.seats_included + NEW.extra_seats > v.seats_max)) THEN
    RAISE EXCEPTION 'This plan does not sell that many extra seats.' USING ERRCODE = 'W3412';
  END IF;
  IF NEW.extra_numbers > 0 AND (v.number_price_minor IS NULL
       OR v.numbers_included + NEW.extra_numbers > coalesce(v.numbers_max, 100)) THEN
    RAISE EXCEPTION 'This plan does not sell that many extra WhatsApp numbers.' USING ERRCODE = 'W3412';
  END IF;
  IF NEW.run_packs > 0 AND v.run_pack_size IS NULL THEN
    RAISE EXCEPTION 'This plan does not sell automation run packs.' USING ERRCODE = 'W3412';
  END IF;
  IF NEW.run_packs > 0
     AND v.automation_runs_monthly::bigint + NEW.run_packs::bigint * v.run_pack_size > 2000000000 THEN
    RAISE EXCEPTION 'This plan does not sell that many automation run packs.' USING ERRCODE = 'W3412';
  END IF;
  IF NEW.api_request_packs > 0 AND v.api_request_pack_size IS NULL THEN
    RAISE EXCEPTION 'This plan does not sell API request packs.' USING ERRCODE = 'W3412';
  END IF;
  IF NEW.api_request_packs > 0
     AND v.api_requests_monthly::bigint + NEW.api_request_packs::bigint * v.api_request_pack_size
         > 2000000000 THEN
    RAISE EXCEPTION 'This plan does not sell that many API request packs.' USING ERRCODE = 'W3412';
  END IF;
  RETURN NEW;
END
$$;

-- Plan subscriptions -------------------------------------------------------------------------------------
-- The packs a subscription pays for, recorded with its other add-ons when HyFib records it (the runtime
-- role's INSERT); no role may update them (0037's grants).
ALTER TABLE app.plan_subscriptions
  ADD COLUMN api_request_packs integer NOT NULL DEFAULT 0
    CHECK (api_request_packs BETWEEN 0 AND 10000);

-- As in 0087, with API request packs among the add-ons the version must sell and in the price, and
-- packs of either kind kept within the bound the plan state's guard applies when the subscription's
-- first paid cycle puts them on the plan.
CREATE OR REPLACE FUNCTION app.guard_plan_subscription_follow() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_company text;
  v app.tenant_plans%ROWTYPE;
  p app.plan_subscriptions%ROWTYPE;
  pl ops.plans%ROWTYPE;
  v_tax_bp integer;
  v_subtotal numeric;
BEGIN
  IF NEW.follows_subscription_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT t.status INTO v_company FROM app.tenants t WHERE t.id = NEW.tenant_id;
  SELECT * INTO v FROM app.tenant_plans tp WHERE tp.tenant_id = NEW.tenant_id;
  SELECT * INTO p FROM app.plan_subscriptions s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.follows_subscription_id;
  IF v_company IS NULL OR v_company IN ('suspended', 'pending_deletion', 'deleted') THEN
    RAISE EXCEPTION 'The company cannot change its plan now.' USING ERRCODE = 'W3412';
  END IF;
  IF v.id IS NULL OR p.id IS NULL OR v.status <> 'active' OR v.subscription_id IS DISTINCT FROM p.id
     OR NOT ((p.status = 'active' AND p.cancel_at_period_end)
             OR p.status IN ('cancelled', 'completed', 'expired')) THEN
    RAISE EXCEPTION 'A new subscription follows the one that paid the plan, once that one charges no more.'
      USING ERRCODE = 'W3412';
  END IF;
  IF NEW.starts_at IS DISTINCT FROM v.period_end OR NEW.starts_at < now() + interval '48 hours' THEN
    RAISE EXCEPTION 'A new subscription starts when the paid period ends, at least 48 hours ahead.'
      USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO pl FROM ops.plans x WHERE x.id = NEW.plan_id;
  IF pl.id IS NULL OR pl.status <> 'published'
     OR NOT (pl.offered_at IS NOT NULL OR pl.id = v.plan_id) THEN
    RAISE EXCEPTION 'That plan cannot be chosen.' USING ERRCODE = 'W3412';
  END IF;
  IF (NEW.extra_seats > 0 AND (pl.seat_price_minor IS NULL
        OR (pl.seats_max IS NOT NULL AND pl.seats_included + NEW.extra_seats > pl.seats_max)))
     OR (NEW.extra_numbers > 0 AND (pl.number_price_minor IS NULL
        OR pl.numbers_included + NEW.extra_numbers > coalesce(pl.numbers_max, 100)))
     OR (NEW.run_packs > 0 AND (pl.run_pack_size IS NULL
        OR pl.automation_runs_monthly::bigint + NEW.run_packs::bigint * pl.run_pack_size
           > 2000000000))
     OR (NEW.api_request_packs > 0 AND (pl.api_request_pack_size IS NULL
        OR pl.api_requests_monthly::bigint + NEW.api_request_packs::bigint * pl.api_request_pack_size
           > 2000000000)) THEN
    RAISE EXCEPTION 'That plan does not sell these add-ons.' USING ERRCODE = 'W3412';
  END IF;
  SELECT st.plan_tax_bp INTO v_tax_bp FROM ops.plan_settings st;
  v_subtotal := pl.price_minor::numeric
              + NEW.extra_seats::numeric * coalesce(pl.seat_price_minor, 0)
              + NEW.extra_numbers::numeric * coalesce(pl.number_price_minor, 0)
              + NEW.run_packs::numeric * coalesce(pl.run_pack_price_minor, 0)
              + NEW.api_request_packs::numeric * coalesce(pl.api_request_pack_price_minor, 0);
  IF v_tax_bp IS NULL OR NEW.interval_months <> pl.interval_months OR NEW.tax_bp <> v_tax_bp
     OR NEW.subtotal_minor <> v_subtotal
     OR NEW.tax_minor <> floor((v_subtotal * v_tax_bp + 5000) / 10000) THEN
    RAISE EXCEPTION 'A new subscription costs what its plan charges for its add-ons, with the tax.'
      USING ERRCODE = 'W3412';
  END IF;
  RETURN NEW;
END
$$;

-- A subscription that follows none pays for the company's plan as it is now: the plan state's version
-- and add-ons (HyFib records them so, ADR-063 and ADR-102). A web server of the previous release, which
-- does not know API request packs, would otherwise record a subscription without them for a company
-- that has some, and its payments would never apply to the plan (a mismatch). Runs as the inserting
-- role: the runtime role, in the company's own scope.
CREATE FUNCTION app.guard_plan_subscription_start() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v app.tenant_plans%ROWTYPE;
BEGIN
  IF NEW.follows_subscription_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v FROM app.tenant_plans tp WHERE tp.tenant_id = NEW.tenant_id;
  IF v.id IS NULL OR v.plan_id IS DISTINCT FROM NEW.plan_id
     OR (v.extra_seats, v.extra_numbers, v.run_packs, v.api_request_packs)
        IS DISTINCT FROM (NEW.extra_seats, NEW.extra_numbers, NEW.run_packs, NEW.api_request_packs) THEN
    RAISE EXCEPTION 'A subscription pays for the plan and add-ons the company has now. Reload the page and try again.'
      USING ERRCODE = 'W3412';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_plan_subscription_start() FROM PUBLIC;
CREATE TRIGGER plan_subscriptions_start_guard BEFORE INSERT ON app.plan_subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.guard_plan_subscription_start();

-- A paid cycle puts the subscription's packs on the plan -----------------------------------------------------
-- As in 0087, with API request packs among the add-ons a cycle applies, compares and audits. The owner
-- drops the function and the migration role recreates it (see 0011).
SET ROLE w360_definer;
DROP FUNCTION app.apply_plan_subscription_period(uuid, uuid);
RESET ROLE;
CREATE FUNCTION app.apply_plan_subscription_period(p_tenant_id uuid, p_subscription_id uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v app.tenant_plans%ROWTYPE;
  s app.plan_subscriptions%ROWTYPE;
  v_change boolean := false;
BEGIN
  IF app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'plan periods are applied in the company''s own scope' USING ERRCODE = 'W3403';
  END IF;
  -- The company row first, then its plan state: the order the sweep and staff changes lock them in.
  PERFORM 1 FROM app.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
  SELECT * INTO v FROM app.tenant_plans tp WHERE tp.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The company has no plan state.' USING ERRCODE = 'W3404';
  END IF;
  SELECT * INTO s FROM app.plan_subscriptions ps
   WHERE ps.tenant_id = p_tenant_id AND ps.id = p_subscription_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Subscription not found.' USING ERRCODE = 'W3404';
  END IF;
  IF s.status <> 'active' OR s.current_start IS NULL OR s.current_end IS NULL OR NOT EXISTS (
       SELECT 1 FROM app.plan_payments p
        WHERE p.tenant_id = p_tenant_id AND p.subscription_id = s.id
          AND p.period_start + (p.period_end - p.period_start) / 2
              BETWEEN s.current_start AND s.current_end) THEN
    RETURN 'not_paid';
  END IF;
  IF v.plan_id IS DISTINCT FROM s.plan_id OR v.extra_seats <> s.extra_seats
     OR v.extra_numbers <> s.extra_numbers OR v.run_packs <> s.run_packs
     OR v.api_request_packs <> s.api_request_packs THEN
    IF s.follows_subscription_id IS NULL
       OR s.follows_subscription_id IS DISTINCT FROM v.subscription_id THEN
      RETURN 'mismatch';
    END IF;
    v_change := true;
  END IF;
  IF v.subscription_id IS NOT NULL AND v.subscription_id <> s.id AND v.period_end IS NOT NULL
     AND s.current_end <= v.period_end THEN
    RETURN 'stale';
  END IF;
  IF v.status = 'active' AND v.subscription_id IS NOT DISTINCT FROM s.id
     AND v.period_start = s.current_start AND v.period_end = s.current_end THEN
    RETURN 'unchanged';
  END IF;
  UPDATE app.tenant_plans
     SET status = 'active',
         plan_id = s.plan_id,
         extra_seats = s.extra_seats,
         extra_numbers = s.extra_numbers,
         run_packs = s.run_packs,
         api_request_packs = s.api_request_packs,
         trial_ends_at = NULL,
         period_start = s.current_start,
         period_end = s.current_end,
         grace_ends_at = NULL,
         subscription_id = s.id,
         usage_anchor = CASE WHEN v.status IN ('active', 'past_due')
                              AND v.period_start = s.current_start
                             THEN v.usage_anchor ELSE s.current_start END,
         note = CASE WHEN v_change THEN 'Changed and paid by subscription through Razorpay.'
                     ELSE 'Paid by subscription through Razorpay.' END,
         changed_by_user_id = NULL, changed_at = now(), version = v.version + 1
   WHERE id = v.id;
  INSERT INTO app.audit_events (tenant_id, actor_type, actor_id, action, subject_type, subject_id, result,
                                metadata)
  VALUES (p_tenant_id, 'system', NULL, 'plan.subscription_period', 'tenant_plan', v.id::text, 'success',
          jsonb_build_object('previous_status', v.status, 'plan_id', s.plan_id,
                             'subscription_id', s.id, 'period_start', s.current_start,
                             'period_end', s.current_end)
          || CASE WHEN v_change
                  THEN jsonb_build_object('previous_plan_id', v.plan_id,
                                          'previous_extra_seats', v.extra_seats,
                                          'previous_extra_numbers', v.extra_numbers,
                                          'previous_run_packs', v.run_packs,
                                          'previous_api_request_packs', v.api_request_packs,
                                          'extra_seats', s.extra_seats,
                                          'extra_numbers', s.extra_numbers,
                                          'run_packs', s.run_packs,
                                          'api_request_packs', s.api_request_packs)
                  ELSE '{}'::jsonb END);
  RETURN 'applied';
END
$$;
REVOKE EXECUTE ON FUNCTION app.apply_plan_subscription_period(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_plan_subscription_period(uuid, uuid) TO w360_app;
ALTER FUNCTION app.apply_plan_subscription_period(uuid, uuid) OWNER TO w360_definer;

-- The company's own add-ons, API request packs included ------------------------------------------------------
-- As app.choose_add_ons (0084) with a fourth quantity, the API request packs, under the same
-- conditions and locks; the plan state's guard keeps them to what the version sells. The
-- three-quantity function stays for web servers of the previous release during a deploy (it leaves the
-- packs as they are) and is dropped by a later migration. Returns 'chosen' or 'unchanged', with the
-- quantities before.
CREATE FUNCTION app.choose_add_ons(p_extra_seats integer, p_extra_numbers integer,
                                   p_run_packs integer, p_api_request_packs integer)
  RETURNS TABLE (result text, previous_extra_seats integer, previous_extra_numbers integer,
                 previous_run_packs integer, previous_api_request_packs integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_user text := app.current_user_id();
  v_company text;
  v app.tenant_plans%ROWTYPE;
  p ops.plans%ROWTYPE;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'Add-ons are chosen by a member, in the company''s own scope.'
      USING ERRCODE = 'W3403';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('w360:plan-subscriptions:' || v_tenant::text, 0));
  SELECT t.status INTO v_company FROM app.tenants t WHERE t.id = v_tenant FOR SHARE;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'Company not found.' USING ERRCODE = 'W3404';
  END IF;
  IF v_company IN ('pending_deletion', 'deleted') THEN
    RAISE EXCEPTION 'Your company is being deleted, so its add-ons cannot change.'
      USING ERRCODE = 'W3412';
  END IF;
  IF v_company = 'suspended' THEN
    RAISE EXCEPTION 'Your company is suspended, so its add-ons cannot change.'
      USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO v FROM app.tenant_plans tp WHERE tp.tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The company has no plan state.' USING ERRCODE = 'W3404';
  END IF;
  IF v.status = 'complimentary' THEN
    RAISE EXCEPTION 'Your company has complimentary access, so there are no add-ons to choose.'
      USING ERRCODE = 'W3412';
  END IF;
  IF v.status = 'active' THEN
    RAISE EXCEPTION 'Your plan has a paid period. You can choose add-ons once it ends, or ask HyFib to change them.'
      USING ERRCODE = 'W3412';
  END IF;
  IF EXISTS (SELECT 1 FROM app.plan_subscriptions s
              WHERE s.tenant_id = v_tenant
                AND s.status IN ('creating', 'created', 'authenticated', 'active', 'pending',
                                 'halted', 'paused')) THEN
    RAISE EXCEPTION 'Your company has a plan subscription that can still be charged. Cancel it, or let its payment window close, before choosing add-ons.'
      USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO p FROM ops.plans pl WHERE pl.id = v.plan_id;
  IF NOT FOUND OR p.status <> 'published' THEN
    RAISE EXCEPTION 'Your plan version is no longer offered, so its add-ons cannot change. Choose another plan.'
      USING ERRCODE = 'W3412';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ops.plan_settings s WHERE s.plan_tax_bp IS NOT NULL) THEN
    RAISE EXCEPTION 'Paying for plans here is not available yet. Ask HyFib to change your add-ons.'
      USING ERRCODE = 'W3412';
  END IF;
  IF (v.extra_seats, v.extra_numbers, v.run_packs, v.api_request_packs)
     IS NOT DISTINCT FROM (p_extra_seats, p_extra_numbers, p_run_packs, p_api_request_packs) THEN
    RETURN QUERY SELECT 'unchanged'::text, v.extra_seats, v.extra_numbers, v.run_packs,
                        v.api_request_packs;
    RETURN;
  END IF;
  UPDATE app.tenant_plans
     SET extra_seats = p_extra_seats,
         extra_numbers = p_extra_numbers,
         run_packs = p_run_packs,
         api_request_packs = p_api_request_packs,
         note = 'Add-ons chosen by the company.',
         changed_by_user_id = v_user, changed_at = now(), version = v.version + 1
   WHERE id = v.id;
  RETURN QUERY SELECT 'chosen'::text, v.extra_seats, v.extra_numbers, v.run_packs,
                      v.api_request_packs;
END
$$;
REVOKE EXECUTE ON FUNCTION app.choose_add_ons(integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.choose_add_ons(integer, integer, integer, integer) TO w360_app;
ALTER FUNCTION app.choose_add_ons(integer, integer, integer, integer) OWNER TO w360_definer;

-- Entitlements ---------------------------------------------------------------------------------------------
-- As in 0069, with API request packs added to the monthly API limit as run packs are to the run limit,
-- both summed in 64 bits; the guards keep the sums within the integer range, so the cast never fails
-- for a plan state written since this migration.
CREATE OR REPLACE FUNCTION app.tenant_entitlements(p_tenant_id uuid)
  RETURNS TABLE (plan_status text, plan_id uuid, seats integer, numbers integer, teams integer,
    live_automations integer, automation_runs integer, modules text[], usage_anchor timestamptz,
    api_requests integer, api_scopes text[])
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT tp.status, tp.plan_id,
         CASE WHEN p.id IS NULL THEN NULL ELSE p.seats_included + tp.extra_seats END,
         CASE WHEN p.id IS NULL THEN NULL ELSE p.numbers_included + tp.extra_numbers END,
         p.teams_max,
         p.live_automations_max,
         CASE WHEN p.automation_runs_monthly IS NULL THEN NULL
              ELSE (p.automation_runs_monthly::bigint
                    + tp.run_packs::bigint * coalesce(p.run_pack_size, 0))::integer END,
         CASE WHEN p.id IS NULL THEN ARRAY['automations', 'flows', 'crm', 'commerce']::text[]
              ELSE p.modules END,
         tp.usage_anchor,
         CASE WHEN p.api_requests_monthly IS NULL THEN NULL
              ELSE (p.api_requests_monthly::bigint
                    + tp.api_request_packs::bigint * coalesce(p.api_request_pack_size, 0))::integer END,
         p.api_scopes
    FROM app.tenant_plans tp
    LEFT JOIN ops.plans p ON p.id = tp.plan_id
   WHERE tp.tenant_id = p_tenant_id
$$;

-- The sweep's lookups --------------------------------------------------------------------------------------
-- As in 0023, 0035 and 0036, with the API request packs in the API limit, and every limit summed in 64
-- bits, so one company's plan state can never stop the lookups for every company. The owner drops each
-- function and the migration role recreates it (see 0011).
SET ROLE w360_definer;
DROP FUNCTION ops.usage_limits_reached(integer);
DROP FUNCTION ops.api_quota_reached(integer);
DROP FUNCTION ops.usage_warnings_due(integer);
RESET ROLE;

-- Automation run counters at or over the month's limit, not yet notified (0023).
CREATE FUNCTION ops.usage_limits_reached(p_limit integer)
  RETURNS TABLE (tenant_id uuid, counter_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT u.tenant_id, u.id
    FROM app.usage_counters u
    JOIN app.tenant_plans tp ON tp.tenant_id = u.tenant_id
    JOIN ops.plans p ON p.id = tp.plan_id
    JOIN app.tenants t ON t.id = u.tenant_id AND t.status = 'active'
   WHERE u.metric = 'automation_runs' AND u.notified_at IS NULL
     AND u.period_start > now() - interval '32 days'
     AND p.automation_runs_monthly IS NOT NULL
     AND u.used >= p.automation_runs_monthly::bigint
                   + tp.run_packs::bigint * coalesce(p.run_pack_size, 0)
   ORDER BY u.tenant_id
   LIMIT p_limit
$$;
REVOKE EXECUTE ON FUNCTION ops.usage_limits_reached(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.usage_limits_reached(integer) TO w360_app;
ALTER FUNCTION ops.usage_limits_reached(integer) OWNER TO w360_definer;

-- API request counters at or over the month's limit with its packs, not yet notified (0035).
CREATE FUNCTION ops.api_quota_reached(p_limit integer)
  RETURNS TABLE (tenant_id uuid, counter_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT u.tenant_id, u.id
    FROM app.usage_counters u
    JOIN app.tenant_plans tp ON tp.tenant_id = u.tenant_id
    JOIN ops.plans p ON p.id = tp.plan_id
    JOIN app.tenants t ON t.id = u.tenant_id AND t.status = 'active'
   WHERE u.metric = 'api_requests' AND u.notified_at IS NULL
     AND u.period_start > now() - interval '32 days'
     AND p.api_requests_monthly > 0
     AND u.used >= p.api_requests_monthly::bigint
                   + tp.api_request_packs::bigint * coalesce(p.api_request_pack_size, 0)
   ORDER BY u.tenant_id
   LIMIT p_limit
$$;
REVOKE EXECUTE ON FUNCTION ops.api_quota_reached(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.api_quota_reached(integer) TO w360_app;
ALTER FUNCTION ops.api_quota_reached(integer) OWNER TO w360_definer;

-- Counters at 80% of their limit with its packs, below it, neither warned nor notified (0036).
CREATE FUNCTION ops.usage_warnings_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, counter_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT u.tenant_id, u.id
    FROM app.usage_counters u
    JOIN app.tenant_plans tp ON tp.tenant_id = u.tenant_id
    JOIN ops.plans p ON p.id = tp.plan_id
    JOIN app.tenants t ON t.id = u.tenant_id AND t.status = 'active'
    CROSS JOIN LATERAL (
      SELECT CASE u.metric
               WHEN 'automation_runs'
                 THEN p.automation_runs_monthly::bigint
                      + tp.run_packs::bigint * coalesce(p.run_pack_size, 0)
               WHEN 'api_requests'
                 THEN p.api_requests_monthly::bigint
                      + tp.api_request_packs::bigint * coalesce(p.api_request_pack_size, 0)
             END AS usage_limit) l
   WHERE u.warned_at IS NULL AND u.notified_at IS NULL
     AND u.period_start > now() - interval '32 days'
     AND l.usage_limit > 0
     AND u.used >= ceil(l.usage_limit * 0.8)
     AND u.used < l.usage_limit
   ORDER BY u.tenant_id
   LIMIT p_limit
$$;
REVOKE EXECUTE ON FUNCTION ops.usage_warnings_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.usage_warnings_due(integer) TO w360_app;
ALTER FUNCTION ops.usage_warnings_due(integer) OWNER TO w360_definer;
