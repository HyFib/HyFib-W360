-- Messages a day kept as days pass, for a year of them on the Usage tab (P5-10, ADR-341).
--
-- The Usage tab and a company's platform page count messages a day live from app.messages (0254,
-- 0255), which is why they reach back 93 days at most: further back, each read would scan more of
-- the platform's messages. The worker now counts each UTC day once it has ended, for every company
-- not deleted, and keeps the counts: a few days a minute, newest first, back to a year ago, so a
-- new deployment has its year within hours. A message's status can still change after its day (a
-- failure Meta reports later), so the 7 days before today are counted again once a day; older
-- days keep their counts. Nothing here holds a contact, a message or its text: counts a day only.

-- Each company's messages on each UTC day it had any: sent, those of them failed, received. A
-- company's rows are deleted with the company (step 35 below); none is kept past 400 days.
CREATE TABLE ops.platform_message_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  utc_day date NOT NULL,
  outbound integer NOT NULL CHECK (outbound >= 0),
  failed integer NOT NULL CHECK (failed BETWEEN 0 AND outbound),
  inbound integer NOT NULL CHECK (inbound >= 0),
  CHECK (outbound + inbound > 0),
  CONSTRAINT platform_message_days_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT platform_message_days_tenant_day_uq UNIQUE (tenant_id, utc_day)
);
CREATE INDEX platform_message_days_day_idx ON ops.platform_message_days (utc_day);
SELECT ops.apply_tenant_rls('ops.platform_message_days');
-- Only the definer role's functions below, and the company deletion's, read and write the counts;
-- the deletion's policies are those of every table it deletes (0028).
CREATE POLICY definer_all ON ops.platform_message_days TO w360_definer
  USING (true) WITH CHECK (true);
CREATE POLICY tenant_deletion_read ON ops.platform_message_days FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON ops.platform_message_days FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
GRANT SELECT, INSERT, DELETE ON ops.platform_message_days TO w360_definer;

-- The days counted, and when each was last: a day without a row here is not counted yet, which a
-- day without messages cannot tell.
CREATE TABLE ops.platform_message_days_counted (
  utc_day date PRIMARY KEY,
  counted_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.platform_message_days_counted TO w360_definer;

-- Company deletion (0028) deletes every table with tenant_id or keeps it on purpose: the counts go
-- with the company, a batch at a time like the other platform records.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode)
VALUES (35, ARRAY['ops.platform_message_days']::regclass[], 'batch');

-- Counting (the worker, every minute, one day a call): deletes the counts older than 400 days and
-- those of companies deleted in the last 30 days (a count that raced a company's deletion, as it
-- finished, leaves them behind; the 400 days catch any older), then
-- counts up to p_limit days (at most 31) due, newest first: each of the 365 days before today never
-- counted, and each of the 7 before today counted more than a day ago. A day is counted whole,
-- replacing its rows, as 0255 counts the days it reads. One run at a time; how many days it
-- counted.
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
  DELETE FROM ops.platform_message_days d WHERE d.utc_day < v_today - 400;
  DELETE FROM ops.platform_message_days_counted c WHERE c.utc_day < v_today - 400;
  DELETE FROM ops.platform_message_days d
   USING app.tenants t
   WHERE t.id = d.tenant_id AND t.status = 'deleted'
     AND t.status_changed_at > now() - interval '30 days';
  FOR v_day IN
    SELECT v_today - g.n
      FROM generate_series(1, 365) AS g(n)
      LEFT JOIN ops.platform_message_days_counted c ON c.utc_day = v_today - g.n
     WHERE c.utc_day IS NULL OR (g.n <= 7 AND c.counted_at < now() - interval '1 day')
     ORDER BY g.n
     LIMIT least(greatest(coalesce(p_limit, 0), 0), 31)
  LOOP
    DELETE FROM ops.platform_message_days d WHERE d.utc_day = v_day;
    INSERT INTO ops.platform_message_days (tenant_id, utc_day, outbound, failed, inbound)
    SELECT t.id, v_day, m.sent, m.sent_failed, m.received
      FROM app.tenants t
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE mm.direction = 'outbound')::integer AS sent,
               count(*) FILTER (WHERE mm.direction = 'outbound' AND mm.status = 'failed')::integer
                 AS sent_failed,
               count(*) FILTER (WHERE mm.direction = 'inbound')::integer AS received
          FROM app.messages mm
         WHERE mm.tenant_id = t.id
           AND mm.created_at >= (v_day::timestamp AT TIME ZONE 'UTC')
           AND mm.created_at < ((v_day + 1)::timestamp AT TIME ZONE 'UTC')) m
     WHERE t.status <> 'deleted' AND m.sent + m.received > 0;
    INSERT INTO ops.platform_message_days_counted (utc_day, counted_at) VALUES (v_day, now())
    ON CONFLICT (utc_day) DO UPDATE SET counted_at = excluded.counted_at;
    v_counted := v_counted + 1;
  END LOOP;
  RETURN v_counted;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.count_platform_message_days(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.count_platform_message_days(integer) TO w360_app;
ALTER FUNCTION ops.count_platform_message_days(integer) OWNER TO w360_definer;

-- The kept days (platform administrators): each of the p_days days before today (1 to 365), with
-- every company's counts not deleted, or one company's, and whether the day was counted yet. Counts
-- a day only, never a contact or a message.
CREATE FUNCTION ops.platform_ops_message_days(p_days integer, p_tenant_id uuid)
  RETURNS TABLE (utc_day date, outbound integer, failed integer, inbound integer, counted boolean)
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
         coalesce(sum(m.inbound), 0)::integer, (c.utc_day IS NOT NULL)
    FROM (SELECT v_today - g.n AS day FROM generate_series(1, p_days) AS g(n)) d
    LEFT JOIN ops.platform_message_days_counted c ON c.utc_day = d.day
    LEFT JOIN ops.platform_message_days m
      ON m.utc_day = d.day AND (p_tenant_id IS NULL OR m.tenant_id = p_tenant_id)
     AND EXISTS (SELECT 1 FROM app.tenants t WHERE t.id = m.tenant_id AND t.status <> 'deleted')
   GROUP BY d.day, c.utc_day
   ORDER BY d.day;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_message_days(integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_message_days(integer, uuid) TO w360_platform;
ALTER FUNCTION ops.platform_ops_message_days(integer, uuid) OWNER TO w360_definer;
