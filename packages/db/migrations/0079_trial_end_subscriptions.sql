-- Paying for a plan from the end of the trial (P5-01/P5-07, ADR-102). A company on a trial that
-- starts paying by Razorpay subscription was charged at once in Checkout, and the rest of its trial
-- was lost. A subscription can now start at the trial's end (Razorpay's `start_at`, R-064): Checkout
-- only authorises the payment method, and Razorpay charges the first period when the trial ends.
-- The trial then waits for that charge for the plan version's grace days, and the minute sweep asks
-- Razorpay hourly once the charge is due.

-- When the subscription's first charge is due; NULL for one charged at once in Checkout. Written when
-- HyFib records the subscription (the runtime role's INSERT); no role may update it (0037's grants).
ALTER TABLE app.plan_subscriptions
  ADD COLUMN starts_at timestamptz,
  ADD CONSTRAINT plan_subscriptions_starts_at_check
    CHECK (starts_at IS NULL OR starts_at > created_at);

-- Until when a trial that has ended waits for its first charge ---------------------------------------------
-- A trial whose company has a subscription starting at the trial's end (authorised, charged, or
-- retrying a failed first charge) waits for that charge until the plan version's grace days have
-- passed, as a paid period waits for its renewal (0037); NULL when it does not wait. The plan
-- transition, the sweep's due list and the company's plan card use this one rule. It runs as its
-- caller: the company's own scope (RLS) or the definer functions below.
CREATE FUNCTION app.trial_charge_wait_until(p_tenant_id uuid)
  RETURNS timestamptz
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT tp.trial_ends_at + make_interval(days => p.grace_days)
    FROM app.tenant_plans tp
    JOIN ops.plans p ON p.id = tp.plan_id
   WHERE tp.tenant_id = p_tenant_id
     AND tp.status = 'trialing'
     AND EXISTS (
       SELECT 1
         FROM app.plan_subscriptions s
        WHERE s.tenant_id = tp.tenant_id
          AND s.status IN ('authenticated', 'active', 'pending')
          AND s.starts_at = tp.trial_ends_at)
$$;
REVOKE EXECUTE ON FUNCTION app.trial_charge_wait_until(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.trial_charge_wait_until(uuid) TO w360_app, w360_definer;

-- Time moves plan states on: a trial waits for a first charge due at its end -------------------------------
-- As in 0037, except that a trial waiting for its first charge (above) is not ended: the charge
-- makes the plan active through app.apply_plan_subscription_period. ops.plan_transitions_due leaves
-- such a trial out, so the sweep does not list it every minute. The owner drops each function and
-- the migration role recreates it (see 0011).
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
    IF coalesce(v_sub_cancel, false) OR v_sub_status IN ('cancelled', 'completed', 'expired') THEN
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

SET ROLE w360_definer;
DROP FUNCTION ops.plan_transitions_due(integer);
RESET ROLE;
CREATE FUNCTION ops.plan_transitions_due(p_limit integer)
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT tp.tenant_id
    FROM app.tenant_plans tp
    JOIN app.tenants t ON t.id = tp.tenant_id AND t.status NOT IN ('pending_deletion', 'deleted')
   WHERE (tp.status = 'trialing' AND tp.trial_ends_at <= now()
          AND NOT coalesce(now() < app.trial_charge_wait_until(tp.tenant_id), false))
      OR (tp.status = 'active' AND tp.period_end <= now())
      OR (tp.status = 'past_due' AND tp.grace_ends_at <= now())
   ORDER BY tp.tenant_id
   LIMIT p_limit
$$;
REVOKE EXECUTE ON FUNCTION ops.plan_transitions_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.plan_transitions_due(integer) TO w360_app;
ALTER FUNCTION ops.plan_transitions_due(integer) OWNER TO w360_definer;

-- Subscriptions to check with Razorpay (minute sweep) -------------------------------------------------------
-- As in 0037, and hourly once a first charge due at the trial's end should have been made, until
-- one is recorded: a missed webhook then does not leave the trial waiting. Razorpay makes a
-- subscription `active` when its first cycle starts and then attempts the charge (R-119), so an
-- active one with no paid cycle is asked too.
SET ROLE w360_definer;
DROP FUNCTION ops.plan_subscriptions_due(integer);
RESET ROLE;
CREATE FUNCTION ops.plan_subscriptions_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, subscription_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, s.id FROM app.plan_subscriptions s
    JOIN app.tenants t ON t.id = s.tenant_id
   WHERE t.status <> 'deleted'
     AND ((s.status = 'creating' AND s.created_at < now() - interval '10 minutes')
       OR (s.status = 'created' AND s.authorize_by < now())
       OR (s.status IN ('authenticated', 'active', 'pending', 'halted', 'paused')
           AND (s.synced_at IS NULL OR s.synced_at < now() - interval '1 day'
                OR (s.current_end < now() AND s.status <> 'halted'
                    AND s.synced_at < greatest(s.current_end, now() - interval '1 hour'))
                OR (s.status IN ('authenticated', 'active', 'pending') AND s.paid_count = 0
                    AND s.starts_at <= now()
                    AND s.synced_at < greatest(s.starts_at, now() - interval '1 hour')))))
   ORDER BY coalesce(s.synced_at, s.created_at)
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000)
$$;
REVOKE EXECUTE ON FUNCTION ops.plan_subscriptions_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.plan_subscriptions_due(integer) TO w360_app;
ALTER FUNCTION ops.plan_subscriptions_due(integer) OWNER TO w360_definer;
