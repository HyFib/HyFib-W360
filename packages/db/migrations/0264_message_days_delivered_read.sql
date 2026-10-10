-- Sends delivered and read a day, as shares of those sent (P5-10, ADR-346).
--
-- The Usage tab and a company's platform page draw each UTC day's messages sent and received and,
-- under them, the share of the sends that failed (ADR-344). Whether the sends reached the
-- customers was left to WhatsApp Manager: a day when deliveries fell, as when a template is paused
-- or a number's quality drops, looked like any other. A message's status only moves forward
-- (sent, then delivered, then read, then played for a voice message; packages/domain
-- messaging/status.ts), so its status says the furthest it got: a send was delivered when its
-- status is delivered, read or played, and read when read or played. The live days' function (0254,
-- 0255) and the kept counts (0262) now count both, outbound messages only, as they count the
-- failed ones. Counts a day only, never a contact or a message.

-- The kept counts gain the day's sends delivered and read: both null on a row counted before this
-- migration, which the counting job counts again (below), both set on every row it counts. A send
-- delivered did not fail (its status is one or the other), and one read was delivered.
ALTER TABLE ops.platform_message_days
  ADD COLUMN delivered integer,
  ADD COLUMN read integer,
  ADD CONSTRAINT platform_message_days_delivered_check
    CHECK ((delivered IS NULL) = (read IS NULL)
           AND (delivered IS NULL
                OR (delivered >= 0 AND delivered + failed <= outbound
                    AND read BETWEEN 0 AND delivered)));

-- Whether a counted day's sends delivered and read were counted with it: false for the days counted
-- before this migration, which are counted again, newest first, as the days never counted are.
ALTER TABLE ops.platform_message_days_counted
  ADD COLUMN deliveries boolean NOT NULL DEFAULT false;

-- Definer-owned functions are replaced as 0261 replaced its own: dropped as their owner, created
-- again, granted and handed back, all in this migration's transaction. 0255's one-argument
-- function reads the two-argument one by its columns' names, so it keeps working unchanged.
SET ROLE w360_definer;
DROP FUNCTION ops.platform_ops_daily_activity(timestamptz, uuid);
DROP FUNCTION ops.count_platform_message_days(integer);
DROP FUNCTION ops.platform_ops_message_days(integer, uuid);
RESET ROLE;

-- The live days (platform administrators), as 0255 counts them, with each day's sends delivered and
-- read. Web servers from before this migration read the columns they know by name.
CREATE FUNCTION ops.platform_ops_daily_activity(p_since timestamptz, p_tenant_id uuid)
  RETURNS TABLE (utc_day date, outbound integer, failed integer, inbound integer,
                 delivered integer, read integer)
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
           count(*) FILTER (WHERE m.direction = 'inbound')::integer AS received,
           count(*) FILTER (WHERE m.direction = 'outbound'
                              AND m.status IN ('delivered', 'read', 'played'))::integer
             AS sent_delivered,
           count(*) FILTER (WHERE m.direction = 'outbound' AND m.status IN ('read', 'played'))::integer
             AS sent_read
      FROM app.tenants t
      JOIN LATERAL (
        SELECT mm.created_at, mm.direction, mm.status
          FROM app.messages mm
         WHERE mm.tenant_id = t.id AND mm.created_at >= p_since) m ON true
     WHERE t.status <> 'deleted' AND (p_tenant_id IS NULL OR t.id = p_tenant_id)
     GROUP BY 1)
  SELECT d.on_day::date, coalesce(c.sent, 0), coalesce(c.sent_failed, 0), coalesce(c.received, 0),
         coalesce(c.sent_delivered, 0), coalesce(c.sent_read, 0)
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

-- Counting (the worker, every minute, one day a call), as 0262 counts, with each company's sends
-- delivered and read, and one more kind of day due: a day counted before this migration, without
-- them. Newest first, so the latest days have their deliveries first after a deployment.
CREATE FUNCTION ops.count_platform_message_days(p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_day date;
  v_counted integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('w360:platform-message-days', 0));
  FOR v_day IN
    SELECT v_today - g.n
      FROM generate_series(1, 365) AS g(n)
      LEFT JOIN ops.platform_message_days_counted c ON c.utc_day = v_today - g.n
     WHERE c.utc_day IS NULL OR NOT c.deliveries
        OR (g.n <= 7 AND c.counted_at < now() - interval '1 day')
     ORDER BY g.n
     LIMIT least(greatest(coalesce(p_limit, 0), 0), 31)
  LOOP
    DELETE FROM ops.platform_message_days d WHERE d.utc_day = v_day;
    INSERT INTO ops.platform_message_days
      (tenant_id, utc_day, outbound, failed, inbound, delivered, read)
    SELECT t.id, v_day, m.sent, m.sent_failed, m.received, m.sent_delivered, m.sent_read
      FROM app.tenants t
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE mm.direction = 'outbound')::integer AS sent,
               count(*) FILTER (WHERE mm.direction = 'outbound' AND mm.status = 'failed')::integer
                 AS sent_failed,
               count(*) FILTER (WHERE mm.direction = 'inbound')::integer AS received,
               count(*) FILTER (WHERE mm.direction = 'outbound'
                                  AND mm.status IN ('delivered', 'read', 'played'))::integer
                 AS sent_delivered,
               count(*) FILTER (WHERE mm.direction = 'outbound'
                                  AND mm.status IN ('read', 'played'))::integer AS sent_read
          FROM app.messages mm
         WHERE mm.tenant_id = t.id
           AND mm.created_at >= (v_day::timestamp AT TIME ZONE 'UTC')
           AND mm.created_at < ((v_day + 1)::timestamp AT TIME ZONE 'UTC')) m
     WHERE t.status <> 'deleted' AND m.sent + m.received > 0
       AND NOT EXISTS (SELECT 1 FROM ops.tenant_deletions dl
                        WHERE dl.tenant_id = t.id AND dl.started_at IS NOT NULL);
    INSERT INTO ops.platform_message_days_counted (utc_day, counted_at, deliveries)
    VALUES (v_day, now(), true)
    ON CONFLICT (utc_day) DO UPDATE SET counted_at = excluded.counted_at, deliveries = true;
    v_counted := v_counted + 1;
  END LOOP;
  RETURN v_counted;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.count_platform_message_days(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.count_platform_message_days(integer) TO w360_app;
ALTER FUNCTION ops.count_platform_message_days(integer) OWNER TO w360_definer;

-- The kept days (platform administrators), as 0262 reads them, with the sends delivered and read:
-- null on a day counted without them (before this migration) or not counted at all. Web servers
-- from before this migration read the columns they know by name.
CREATE FUNCTION ops.platform_ops_message_days(p_days integer, p_tenant_id uuid)
  RETURNS TABLE (utc_day date, outbound integer, failed integer, inbound integer, counted boolean,
                 delivered integer, read integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'the period is 1 to 365 days' USING ERRCODE = 'W3412';
  END IF;
  RETURN QUERY
  SELECT d.day, coalesce(sum(m.outbound), 0)::integer, coalesce(sum(m.failed), 0)::integer,
         coalesce(sum(m.inbound), 0)::integer, (c.utc_day IS NOT NULL),
         CASE WHEN c.deliveries THEN coalesce(sum(m.delivered), 0)::integer END,
         CASE WHEN c.deliveries THEN coalesce(sum(m.read), 0)::integer END
    FROM (SELECT v_today - g.n AS day FROM generate_series(1, p_days) AS g(n)) d
    LEFT JOIN ops.platform_message_days_counted c ON c.utc_day = d.day
    LEFT JOIN ops.platform_message_days m
      ON m.utc_day = d.day AND (p_tenant_id IS NULL OR m.tenant_id = p_tenant_id)
     AND EXISTS (SELECT 1 FROM app.tenants t WHERE t.id = m.tenant_id AND t.status <> 'deleted')
   GROUP BY d.day, c.utc_day, c.deliveries
   ORDER BY d.day;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_message_days(integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_message_days(integer, uuid) TO w360_platform;
ALTER FUNCTION ops.platform_ops_message_days(integer, uuid) OWNER TO w360_definer;
