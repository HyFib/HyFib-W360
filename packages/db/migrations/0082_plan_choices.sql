-- Companies choose the plan they pay for (P5-01/P5-07, ADR-105).
--
-- Platform owners offer published plan versions to companies. A company's owners and billing
-- managers choose one while it is on a trial or its plan has ended, without a subscription that
-- may still be charged, and then pay for it as before (ADR-063). The choice changes only the plan
-- version, through app.choose_plan, which checks everything in SQL under the locks a subscription
-- start, the plan sweep and staff changes take.

-- Offered versions ----------------------------------------------------------------------------------
-- Only a published version a company could pay for: Razorpay's minimum payment is ₹1 (R-064).
-- Retiring a version clears its offer in the same update (the second check refuses otherwise).
ALTER TABLE ops.plans
  ADD COLUMN offered_at timestamptz,
  ADD COLUMN offered_by_user_id text REFERENCES auth.users (id),
  ADD CONSTRAINT plans_offer_by CHECK ((offered_at IS NULL) = (offered_by_user_id IS NULL)),
  ADD CONSTRAINT plans_offer_published
    CHECK (offered_at IS NULL OR (status = 'published' AND price_minor >= 100));
GRANT UPDATE (offered_at, offered_by_user_id) ON ops.plans TO w360_platform;

-- As in 0069, with the offer: a published version can be offered or stop being offered, while
-- every term stays as it was published.
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
        NEW.api_requests_monthly, NEW.api_scopes, NEW.published_by_user_id, NEW.published_at)
       IS DISTINCT FROM
       (OLD.name, OLD.description, OLD.currency, OLD.price_minor, OLD.interval_months, OLD.trial_days,
        OLD.grace_days, OLD.seats_included, OLD.seat_price_minor, OLD.seats_max, OLD.numbers_included,
        OLD.number_price_minor, OLD.numbers_max, OLD.teams_max, OLD.live_automations_max,
        OLD.automation_runs_monthly, OLD.run_pack_size, OLD.run_pack_price_minor, OLD.modules,
        OLD.api_requests_monthly, OLD.api_scopes, OLD.published_by_user_id, OLD.published_at) THEN
      RAISE EXCEPTION 'A published plan version cannot change. Create a new version instead.'
        USING ERRCODE = 'W3403';
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

-- Choosing --------------------------------------------------------------------------------------------
-- The company's own choice of an offered version, in its own scope by the member in app.user_id
-- (the web checks `billing.manage` and a recent sign-in first). Allowed while the company is active
-- or restricted, has no subscription that may still be charged, is on a trial, past due, expired
-- or canceled, and paying for plans is set up (the tax on plan prices). Only the version changes;
-- the plan state's guard checks the add-ons against it, and the status, dates, add-ons and usage
-- period stay. Locks: the advisory lock a subscription start takes (so a start never records the
-- version being replaced), then the company row, shared (a deletion request updates it), then the
-- plan state, in the order the plan sweep and staff changes take them. The plan version is read
-- without a lock: a choice that races a withdrawal is as if made just before it. Returns 'chosen'
-- or 'unchanged', with the version the company was on.
CREATE FUNCTION app.choose_plan(p_plan_id uuid)
  RETURNS TABLE (result text, previous_plan_id uuid)
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
    RAISE EXCEPTION 'A plan is chosen by a member, in the company''s own scope.'
      USING ERRCODE = 'W3403';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('w360:plan-subscriptions:' || v_tenant::text, 0));
  SELECT t.status INTO v_company FROM app.tenants t WHERE t.id = v_tenant FOR SHARE;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'Company not found.' USING ERRCODE = 'W3404';
  END IF;
  IF v_company IN ('pending_deletion', 'deleted') THEN
    RAISE EXCEPTION 'Your company is being deleted, so its plan cannot change.'
      USING ERRCODE = 'W3412';
  END IF;
  IF v_company = 'suspended' THEN
    RAISE EXCEPTION 'Your company is suspended, so its plan cannot change.' USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO v FROM app.tenant_plans tp WHERE tp.tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The company has no plan state.' USING ERRCODE = 'W3404';
  END IF;
  IF v.status = 'complimentary' THEN
    RAISE EXCEPTION 'Your company has complimentary access, so there is no plan to choose.'
      USING ERRCODE = 'W3412';
  END IF;
  IF v.status = 'active' THEN
    RAISE EXCEPTION 'Your plan has a paid period. You can choose a plan once it ends, or ask HyFib to change it.'
      USING ERRCODE = 'W3412';
  END IF;
  IF EXISTS (SELECT 1 FROM app.plan_subscriptions s
              WHERE s.tenant_id = v_tenant
                AND s.status IN ('creating', 'created', 'authenticated', 'active', 'pending',
                                 'halted', 'paused')) THEN
    RAISE EXCEPTION 'Your company has a plan subscription that can still be charged. Cancel it, or let its payment window close, before choosing another plan.'
      USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO p FROM ops.plans pl WHERE pl.id = p_plan_id;
  IF NOT FOUND OR p.status <> 'published' OR p.offered_at IS NULL THEN
    RAISE EXCEPTION 'That plan is not offered.' USING ERRCODE = 'W3412';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ops.plan_settings s WHERE s.plan_tax_bp IS NOT NULL) THEN
    RAISE EXCEPTION 'Paying for plans here is not available yet. Ask HyFib to change your plan.'
      USING ERRCODE = 'W3412';
  END IF;
  IF v.plan_id = p.id THEN
    RETURN QUERY SELECT 'unchanged'::text, v.plan_id;
    RETURN;
  END IF;
  UPDATE app.tenant_plans
     SET plan_id = p.id,
         note = 'Chosen by the company.',
         changed_by_user_id = v_user, changed_at = now(), version = v.version + 1
   WHERE id = v.id;
  RETURN QUERY SELECT 'chosen'::text, v.plan_id;
END
$$;
REVOKE EXECUTE ON FUNCTION app.choose_plan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.choose_plan(uuid) TO w360_app;
ALTER FUNCTION app.choose_plan(uuid) OWNER TO w360_definer;
