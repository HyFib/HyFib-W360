-- Paying companies change their plan or add-ons from the next period (P5-01/P5-07, ADR-109).
-- Razorpay cannot change the plan of a subscription paid by a domestic card, nor of one authorised
-- through UPI or eMandate (R-069), and a cancelled subscription cannot be renewed (R-068, R-122). So
-- a change cancels the current subscription at the end of its cycle and starts a new one when the
-- paid period ends (Razorpay's `start_at`, as ADR-102 does for a trial). The new subscription follows
-- the current one, and its first paid cycle puts the plan on the version and add-ons it was bought
-- for. The current subscription is cancelled before the new one is recorded, so two subscriptions
-- never both keep charging.

-- The subscription a new one follows; NULL for any other. Written when HyFib records the subscription
-- (the runtime role's INSERT, guarded below); no role may update it (0037's grants).
ALTER TABLE app.plan_subscriptions
  ADD COLUMN follows_subscription_id uuid,
  ADD CONSTRAINT plan_subscriptions_follows_fk FOREIGN KEY (tenant_id, follows_subscription_id)
    REFERENCES app.plan_subscriptions (tenant_id, id),
  ADD CONSTRAINT plan_subscriptions_follows_check
    CHECK (follows_subscription_id IS NULL
           OR (follows_subscription_id <> id AND starts_at IS NOT NULL));

-- One live subscription per company that keeps charging (0037 allowed one live subscription). The
-- current subscription stays live while it ends at its period's end, next to the one that follows it.
DROP INDEX app.plan_subscriptions_one_live_uq;
CREATE UNIQUE INDEX plan_subscriptions_one_live_uq ON app.plan_subscriptions (tenant_id)
  WHERE status IN ('creating', 'created', 'authenticated', 'active', 'pending', 'halted', 'paused')
    AND NOT cancel_at_period_end;

-- A subscription that follows another ------------------------------------------------------------------
-- Starts exactly when the period paid by the subscription it follows ends, once that one charges no
-- more after it (cancelled at the period's end, or ended), at least 48 hours ahead (Razorpay's notice
-- before a card debit, ADR-102), for a company that is not suspended or being deleted. Its version
-- is one the company may choose (offered, or its current version) and published, its add-ons are
-- within what the version sells, and its price is what the version charges for them with the tax set
-- now: the first paid cycle puts the plan on that version and those add-ons. Runs as the inserting
-- role: the runtime role, in the company's own scope.
CREATE FUNCTION app.guard_plan_subscription_follow() RETURNS trigger
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
     OR (NEW.run_packs > 0 AND pl.run_pack_size IS NULL) THEN
    RAISE EXCEPTION 'That plan does not sell these add-ons.' USING ERRCODE = 'W3412';
  END IF;
  SELECT st.plan_tax_bp INTO v_tax_bp FROM ops.plan_settings st;
  v_subtotal := pl.price_minor::numeric
              + NEW.extra_seats::numeric * coalesce(pl.seat_price_minor, 0)
              + NEW.extra_numbers::numeric * coalesce(pl.number_price_minor, 0)
              + NEW.run_packs::numeric * coalesce(pl.run_pack_price_minor, 0);
  IF v_tax_bp IS NULL OR NEW.interval_months <> pl.interval_months OR NEW.tax_bp <> v_tax_bp
     OR NEW.subtotal_minor <> v_subtotal
     OR NEW.tax_minor <> floor((v_subtotal * v_tax_bp + 5000) / 10000) THEN
    RAISE EXCEPTION 'A new subscription costs what its plan charges for its add-ons, with the tax.'
      USING ERRCODE = 'W3412';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_plan_subscription_follow() FROM PUBLIC;
CREATE TRIGGER plan_subscriptions_follow_guard BEFORE INSERT ON app.plan_subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.guard_plan_subscription_follow();

-- The plan guard: a retired version only as the plan of the subscription that follows ------------------------
-- As in 0023, except that a version retired after a company paid for it through the subscription
-- that follows the one that paid its plan is assigned all the same, together with that
-- subscription's cycle: companies on a retired version keep it (ADR-051), and this company paid for
-- it. Runs as its caller (app.apply_plan_subscription_period below, or a platform change).
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
  RETURN NEW;
END
$$;

-- Applying a paid billing cycle: the subscription that follows brings its plan ----------------------------
-- As in 0037, except that:
-- - a subscription for another version or other add-ons than the plan state is applied when it
--   follows the subscription that paid the plan's period: the plan then takes its version and
--   add-ons (ADR-109), and the audit records the previous ones;
-- - a cycle of another subscription that ends no later than the period paid by the plan's
--   subscription is 'stale' and never moves the period back.
-- Returns 'applied', 'unchanged', 'not_paid', 'mismatch' or 'stale'. The owner drops the function
-- and the migration role recreates it (see 0011).
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
     OR v.extra_numbers <> s.extra_numbers OR v.run_packs <> s.run_packs THEN
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
                                          'extra_seats', s.extra_seats,
                                          'extra_numbers', s.extra_numbers,
                                          'run_packs', s.run_packs)
                  ELSE '{}'::jsonb END);
  RETURN 'applied';
END
$$;
REVOKE EXECUTE ON FUNCTION app.apply_plan_subscription_period(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_plan_subscription_period(uuid, uuid) TO w360_app;
ALTER FUNCTION app.apply_plan_subscription_period(uuid, uuid) OWNER TO w360_definer;

-- Time moves plan states on: a period followed by a new subscription is due like a renewal -------------------
-- As in 0079, except that a paid period whose subscription ends with it is not ended as canceled
-- when a subscription that follows it starts at its end (authorised, charged, or retrying a failed
-- first charge): the period is due like any renewal, past due within the grace days or expired, and
-- the new subscription's first paid cycle makes the plan active again. The owner drops the function
-- and the migration role recreates it (see 0011).
SET ROLE w360_definer;
DROP FUNCTION app.apply_plan_transition(uuid);
RESET ROLE;
CREATE FUNCTION app.apply_plan_transition(p_tenant_id uuid)
  RETURNS TABLE (previous_status text, new_status text, plan_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v app.tenant_plans%ROWTYPE;
  v_grace smallint;
  v_new text;
  v_note text;
  v_sub_status text;
  v_sub_cancel boolean := false;
BEGIN
  IF app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'plan transitions run in the company''s own scope' USING ERRCODE = 'W3403';
  END IF;
  -- The company row first, then its plan state: the order platform changes lock them in.
  PERFORM 1 FROM app.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
  SELECT * INTO v FROM app.tenant_plans tp WHERE tp.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v.status = 'trialing' AND v.trial_ends_at <= now() THEN
    IF now() < app.trial_charge_wait_until(p_tenant_id) THEN
      RETURN;
    END IF;
    v_new := 'expired';
    v_note := 'The trial ended.';
  ELSIF v.status = 'active' AND v.period_end <= now() THEN
    IF v.subscription_id IS NOT NULL THEN
      SELECT s.status, s.cancel_at_period_end INTO v_sub_status, v_sub_cancel
        FROM app.plan_subscriptions s
       WHERE s.tenant_id = p_tenant_id AND s.id = v.subscription_id;
    END IF;
    IF (coalesce(v_sub_cancel, false) OR v_sub_status IN ('cancelled', 'completed', 'expired'))
       AND NOT EXISTS (
         SELECT 1 FROM app.plan_subscriptions f
          WHERE f.tenant_id = p_tenant_id AND f.follows_subscription_id = v.subscription_id
            AND f.status IN ('authenticated', 'active', 'pending', 'halted')
            AND f.starts_at = v.period_end) THEN
      v_new := 'canceled';
      v_note := CASE WHEN v_sub_status = 'completed' THEN 'The subscription ended.'
                     ELSE 'The subscription was cancelled.' END;
    ELSE
      SELECT p.grace_days INTO v_grace FROM ops.plans p WHERE p.id = v.plan_id;
      v_new := CASE WHEN v.period_end + make_interval(days => coalesce(v_grace, 0)) > now()
                    THEN 'past_due' ELSE 'expired' END;
      v_note := 'The paid period ended.';
    END IF;
  ELSIF v.status = 'past_due' AND v.grace_ends_at <= now() THEN
    v_new := 'expired';
    v_note := 'The grace period ended.';
  ELSE
    RETURN;
  END IF;
  UPDATE app.tenant_plans
     SET status = v_new,
         grace_ends_at = CASE WHEN v_new = 'past_due'
                              THEN v.period_end + make_interval(days => coalesce(v_grace, 0)) END,
         note = v_note,
         changed_by_user_id = NULL, changed_at = now(), version = v.version + 1
   WHERE id = v.id;
  INSERT INTO app.audit_events (tenant_id, actor_type, actor_id, action, subject_type, subject_id, result,
                                metadata)
  VALUES (p_tenant_id, 'system', NULL, 'plan.' || v_new, 'tenant_plan', v.id::text, 'success',
          jsonb_build_object('previous_status', v.status, 'plan_id', v.plan_id,
                             'subscription_id', v.subscription_id));
  RETURN QUERY SELECT v.status, v_new, v.plan_id;
END
$$;
REVOKE EXECUTE ON FUNCTION app.apply_plan_transition(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_plan_transition(uuid) TO w360_app;
ALTER FUNCTION app.apply_plan_transition(uuid) OWNER TO w360_definer;
