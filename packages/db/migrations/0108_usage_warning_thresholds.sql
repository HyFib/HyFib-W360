-- Usage warning thresholds chosen per company (P5-01, ADR-144). Since ADR-062 the billing managers
-- are warned once when a monthly limit (automation runs, API requests, packs included) is 80% used;
-- a member who manages billing now chooses the share, from 50% to 95% in steps of 5. Every company
-- keeps 80% until one does.
ALTER TABLE app.tenants ADD COLUMN usage_warning_percent smallint NOT NULL DEFAULT 80
  CONSTRAINT tenants_usage_warning_percent
    CHECK (usage_warning_percent BETWEEN 50 AND 95 AND usage_warning_percent % 5 = 0);
GRANT UPDATE (usage_warning_percent) ON app.tenants TO w360_app;

-- The sweep's list as in 0088, at the company's own share of each limit (rounded up). The owner
-- drops the function and the migration role recreates it (see 0011).
SET ROLE w360_definer;
DROP FUNCTION ops.usage_warnings_due(integer);
RESET ROLE;

-- Counters at the company's warning share of their limit with its packs, below it, neither warned
-- nor notified (ids only).
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
     AND u.used >= ceil(l.usage_limit * t.usage_warning_percent / 100.0)
     AND u.used < l.usage_limit
   ORDER BY u.tenant_id
   LIMIT p_limit
$$;
REVOKE EXECUTE ON FUNCTION ops.usage_warnings_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.usage_warnings_due(integer) TO w360_app;
ALTER FUNCTION ops.usage_warnings_due(integer) OWNER TO w360_definer;
