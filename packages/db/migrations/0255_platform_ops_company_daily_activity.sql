-- 0255_platform_ops_company_daily_activity: one company's messages each day, for the health card on
-- its platform page (P5-10, ADR-334).
--
-- The card gives a company's sending and receipts over 30 days as sums (0026, ADR-054); the Usage
-- tab now draws the whole platform's days (0254, ADR-333), and a company's own days answer the
-- question staff ask first about it: when did its sending stop, or its failures start? This
-- migration adds the company to the days' function, as 0026's activity function takes it: a second
-- argument, the company's id, or null for every company not deleted. A company's days count only
-- while it is not deleted, as its other facts. This release's web servers call the new function
-- for both. 0254's keeps its signature for any web server of the release that added it still
-- running during the rollout, and now reads every company's days through the new one, so the
-- platform's days and a company's are counted by one body.
--
-- Like 0254 it refuses anyone but a platform administrator and a start outside the last 93 days,
-- is owned by the definer role and returns counts a day only, never a contact or a message.
CREATE FUNCTION ops.platform_ops_daily_activity(p_since timestamptz, p_tenant_id uuid)
  RETURNS TABLE (utc_day date, outbound integer, failed integer, inbound integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF p_since IS NULL OR p_since > now() OR p_since < now() - interval '93 days' THEN
    RAISE EXCEPTION 'the period must start within the last 93 days' USING ERRCODE = 'W3412';
  END IF;
  RETURN QUERY
  WITH counted AS (
    SELECT (m.created_at AT TIME ZONE 'UTC')::date AS on_day,
           count(*) FILTER (WHERE m.direction = 'outbound')::integer AS sent,
           count(*) FILTER (WHERE m.direction = 'outbound' AND m.status = 'failed')::integer
             AS sent_failed,
           count(*) FILTER (WHERE m.direction = 'inbound')::integer AS received
      FROM app.tenants t
      JOIN LATERAL (
        SELECT mm.created_at, mm.direction, mm.status
          FROM app.messages mm
         WHERE mm.tenant_id = t.id AND mm.created_at >= p_since) m ON true
     WHERE t.status <> 'deleted' AND (p_tenant_id IS NULL OR t.id = p_tenant_id)
     GROUP BY 1)
  SELECT d.on_day::date, coalesce(c.sent, 0), coalesce(c.sent_failed, 0), coalesce(c.received, 0)
    FROM generate_series((p_since AT TIME ZONE 'UTC')::date::timestamp,
                         greatest((now() AT TIME ZONE 'UTC')::date,
                                  (SELECT max(l.on_day) FROM counted l))::timestamp,
                         interval '1 day') AS d(on_day)
    LEFT JOIN counted c ON c.on_day = d.on_day::date
   ORDER BY d.on_day;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_daily_activity(timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_daily_activity(timestamptz, uuid) TO w360_platform;
ALTER FUNCTION ops.platform_ops_daily_activity(timestamptz, uuid) OWNER TO w360_definer;

-- Every company's days, through the function above. 0254's function is owned by the definer role,
-- whose privileges the migration role does not hold (it may only SET ROLE to it): as 0011 and 0236
-- replace definer-owned functions, the owner drops it and the migration role creates it again,
-- granting before handing it back. The drop and the creation commit together.
SET ROLE w360_definer;
DROP FUNCTION ops.platform_ops_daily_activity(timestamptz);
RESET ROLE;
CREATE FUNCTION ops.platform_ops_daily_activity(p_since timestamptz)
  RETURNS TABLE (utc_day date, outbound integer, failed integer, inbound integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT a.utc_day, a.outbound, a.failed, a.inbound
    FROM ops.platform_ops_daily_activity(p_since, NULL::uuid) a
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_daily_activity(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_daily_activity(timestamptz) TO w360_platform;
ALTER FUNCTION ops.platform_ops_daily_activity(timestamptz) OWNER TO w360_definer;
