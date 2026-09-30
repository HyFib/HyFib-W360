-- Emails to companies when HyFib staff cancel their plan subscription (P5-07, ADR-101). A platform
-- owner can cancel a company's Razorpay subscription at once from its platform page (ADR-063); the
-- cancellation went to both audit logs, but nobody at the company was told until the plan ended.
-- As for plan changes (ADR-100), the platform role only marks the cancellation, and the worker's
-- minute sweep emails the company's billing managers from the company's own scope.

-- A cancellation by staff the company has not been told of yet.
ALTER TABLE app.plan_subscriptions
  ADD COLUMN staff_cancel_notice_due boolean NOT NULL DEFAULT false;
GRANT UPDATE (staff_cancel_notice_due) ON app.plan_subscriptions TO w360_platform;
CREATE INDEX plan_subscriptions_staff_cancel_notice_idx ON app.plan_subscriptions (tenant_id)
  WHERE staff_cancel_notice_due;

-- Cancellations not told yet (for the minute sweep), oldest first; not companies being deleted.
CREATE FUNCTION ops.plan_subscription_cancel_notices_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, subscription_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, s.id
    FROM app.plan_subscriptions s
    JOIN app.tenants t ON t.id = s.tenant_id
   WHERE s.staff_cancel_notice_due
     AND t.status NOT IN ('pending_deletion', 'deleted')
   ORDER BY s.cancel_requested_at, s.id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
REVOKE EXECUTE ON FUNCTION ops.plan_subscription_cancel_notices_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.plan_subscription_cancel_notices_due(integer) TO w360_app;
ALTER FUNCTION ops.plan_subscription_cancel_notices_due(integer) OWNER TO w360_definer;

-- Takes a cancellation's notice, in the company's own scope and in the transaction that queues the
-- emails: true only for the first call, so each is told once. It only clears the mark, which the
-- runtime role cannot set: no company can make HyFib appear to have cancelled. The company row is
-- locked first, as the plan sweep and staff changes lock it before the company's plan records (the
-- emails' outbox rows reference it).
CREATE FUNCTION app.take_plan_subscription_cancel_notice(p_subscription_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  PERFORM 1 FROM app.tenants t WHERE t.id = v_tenant FOR KEY SHARE;
  UPDATE app.plan_subscriptions s SET staff_cancel_notice_due = false
   WHERE s.tenant_id = v_tenant AND s.id = p_subscription_id AND s.staff_cancel_notice_due;
  RETURN FOUND;
END
$$;
REVOKE EXECUTE ON FUNCTION app.take_plan_subscription_cancel_notice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.take_plan_subscription_cancel_notice(uuid) TO w360_app;
ALTER FUNCTION app.take_plan_subscription_cancel_notice(uuid) OWNER TO w360_definer;
-- The function's update: the mark only (the touch trigger sets updated_at itself).
GRANT UPDATE (staff_cancel_notice_due) ON app.plan_subscriptions TO w360_definer;
CREATE POLICY definer_update ON app.plan_subscriptions FOR UPDATE TO w360_definer
  USING (true) WITH CHECK (true);
