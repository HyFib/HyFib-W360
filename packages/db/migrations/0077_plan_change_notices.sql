-- Emails to companies when HyFib staff change their plan (P5-01, ADR-100). Platform staff set a
-- company's plan on its platform page (ADR-051), and each change went to both audit logs, but
-- nobody at the company was told. The platform role cannot queue email, so a staff change marks the
-- plan state, and the worker's minute sweep emails the company's billing managers from the
-- company's own scope.

-- The version of the plan state staff set that the company has not been told of yet (the plan
-- sweep and subscriptions move the version on; staff changes set it to the version they write).
ALTER TABLE app.tenant_plans
  ADD COLUMN staff_notice_version integer,
  ADD CONSTRAINT tenant_plans_staff_notice_version_check
    CHECK (staff_notice_version IS NULL OR staff_notice_version BETWEEN 1 AND version);
GRANT UPDATE (staff_notice_version) ON app.tenant_plans TO w360_platform;
CREATE INDEX tenant_plans_staff_notice_idx ON app.tenant_plans (changed_at, tenant_id)
  WHERE staff_notice_version IS NOT NULL;

-- Companies with a staff change not told yet (for the minute sweep), oldest change first; not
-- companies being deleted.
CREATE FUNCTION ops.plan_change_notices_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT tp.tenant_id
    FROM app.tenant_plans tp
    JOIN app.tenants t ON t.id = tp.tenant_id
   WHERE tp.staff_notice_version IS NOT NULL
     AND t.status NOT IN ('pending_deletion', 'deleted')
   ORDER BY tp.changed_at, tp.tenant_id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
REVOKE EXECUTE ON FUNCTION ops.plan_change_notices_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.plan_change_notices_due(integer) TO w360_app;
ALTER FUNCTION ops.plan_change_notices_due(integer) OWNER TO w360_definer;

-- Takes the company's notice, in its own scope and in the transaction that queues the emails:
-- true when the plan is still the one staff set (the emails are due), false when a later change
-- replaced it (the plan sweep's or the subscription's own email tells the company), NULL when there
-- is nothing to tell. The mark is cleared either way, so a change is told at most once. The company
-- row is locked before its plan state, the order staff changes and the plan sweep lock them in (the
-- emails' outbox rows reference the company row).
CREATE FUNCTION app.take_plan_change_notice()
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_notice integer;
  v_version integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  PERFORM 1 FROM app.tenants t WHERE t.id = v_tenant FOR KEY SHARE;
  SELECT tp.staff_notice_version, tp.version INTO v_notice, v_version
    FROM app.tenant_plans tp WHERE tp.tenant_id = v_tenant
    FOR UPDATE;
  IF v_notice IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE app.tenant_plans tp SET staff_notice_version = NULL WHERE tp.tenant_id = v_tenant;
  RETURN v_notice = v_version;
END
$$;
REVOKE EXECUTE ON FUNCTION app.take_plan_change_notice() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.take_plan_change_notice() TO w360_app;
ALTER FUNCTION app.take_plan_change_notice() OWNER TO w360_definer;
