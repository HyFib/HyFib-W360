-- 0254_platform_ops_daily_activity: the platform's messages each day, for the operations console's
-- Usage tab (P5-10, ADR-333).
--
-- The tab shows each company's sending and receipts over 7, 30 or 90 days (0026, ADR-054) and the
-- window before (ADR-157), with nothing to show how they moved within the window: a day the
-- platform stopped sending, or a spike of failures, was hidden in the sums. This function gives the
-- whole platform's messages for each UTC day since a time at most 93 days back, as 0026's activity
-- function counts them: outbound messages, those of them that failed, and inbound messages, of the
-- companies not deleted. The first day is counted from that time and today up to now, so the days
-- add up to the activity function's totals for the same time in the same snapshot. Every day of the
-- window has a row, zero when nothing was written, and so has a later day with messages (a message
-- written by a transaction that began after this one's start and committed before its snapshot,
-- just past midnight): no message the totals count is left out of the days. Counts only, never a
-- company, a contact or a message. Like 0026's functions it refuses anyone but a platform
-- administrator and is owned by the definer role, which reads the companies and their messages
-- (0001's, 0005's and 0026's grants); each company's messages are read through
-- messages_tenant_created_idx, as the activity function reads them.
CREATE FUNCTION ops.platform_ops_daily_activity(p_since timestamptz)
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
     WHERE t.status <> 'deleted'
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
REVOKE EXECUTE ON FUNCTION ops.platform_ops_daily_activity(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_daily_activity(timestamptz) TO w360_platform;
ALTER FUNCTION ops.platform_ops_daily_activity(timestamptz) OWNER TO w360_definer;
