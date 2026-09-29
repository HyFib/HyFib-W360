-- A warning before a monthly limit is reached (ADR-062).

-- When the company's billing managers were warned that the counter reached 80% of its limit.
ALTER TABLE app.usage_counters ADD COLUMN warned_at timestamptz;
GRANT UPDATE (warned_at) ON app.usage_counters TO w360_app;

-- Counters of the last month at or over 80% of their company's current limit (rounded up) and still
-- below it, neither warned nor announced (ids only). Limits of 1 to 4 have no such counter.
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
                 THEN p.automation_runs_monthly + tp.run_packs * coalesce(p.run_pack_size, 0)
               WHEN 'api_requests' THEN p.api_requests_monthly
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
