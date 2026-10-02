-- Emails about an API key's own monthly limit (P5-08, ADR-098). A key with a limit of its own
-- (ADR-097) was refused without anyone being told, unlike the company's limit (ADR-061, ADR-062).
-- The company's owners and administrators, who manage keys, are now emailed once when a key's
-- requests reach 80% of its limit in a period, and once when they reach the limit. The worker's
-- minute sweep lists the counters due (ids only) and marks each in the company's own scope, in the
-- transaction that queues the emails.

-- When owners and administrators were warned that the key reached 80% of its limit, and told that it
-- reached the limit. A period's counter is warned once and told once; the next period's counter is
-- a new row, so both are armed again.
ALTER TABLE app.api_key_usage
  ADD COLUMN warned_at timestamptz,
  ADD COLUMN notified_at timestamptz;
GRANT UPDATE (warned_at, notified_at) ON app.api_key_usage TO w360_app;

-- The counters the sweep looks at: those not told yet.
CREATE INDEX api_key_usage_notice_idx ON app.api_key_usage (period_start)
  WHERE notified_at IS NULL;

-- Counters due an email (company and counter ids, for the minute sweep): of the last month, of a
-- usable key with a limit of its own, of a company whose keys still work (not being deleted), at the
-- limit and not told, or at 80% of it (rounded up) and neither warned nor told. Limits of 1 to 4 have
-- no warning: 80% of them rounded up is the limit. The sweep checks each again in the company's
-- scope, including that the counter is of the current period.
CREATE FUNCTION ops.api_key_usage_notices_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, usage_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT u.tenant_id, u.id
    FROM app.api_key_usage u
    JOIN app.api_keys k ON k.tenant_id = u.tenant_id AND k.id = u.api_key_id
    JOIN app.tenants t ON t.id = u.tenant_id
   WHERE u.notified_at IS NULL
     AND u.period_start > now() - interval '32 days'
     AND k.monthly_request_limit IS NOT NULL
     AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
     AND t.status NOT IN ('pending_deletion', 'deleted')
     AND (u.used >= k.monthly_request_limit
          OR (u.warned_at IS NULL AND u.used >= ceil(k.monthly_request_limit * 0.8)))
   ORDER BY u.tenant_id, u.id
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000)
$$;
REVOKE EXECUTE ON FUNCTION ops.api_key_usage_notices_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.api_key_usage_notices_due(integer) TO w360_app;
-- What the function reads beyond the key columns the deletion functions already read (0073).
GRANT SELECT (api_key_id, period_start, used, warned_at, notified_at) ON app.api_key_usage
  TO w360_definer;
CREATE POLICY definer_read ON app.api_key_usage FOR SELECT TO w360_definer USING (true);
ALTER FUNCTION ops.api_key_usage_notices_due(integer) OWNER TO w360_definer;
