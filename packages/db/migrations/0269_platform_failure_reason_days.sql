-- Failed sends by reason kept as days pass, for a year of them (P5-10, ADR-350).
--
-- The Usage tab and a company's platform page list a window's failed sends by the code they failed
-- with, counted live from app.messages (0265), so 93 days back at most. The worker already counts
-- each UTC day once it has ended (0262, 0264); it now keeps each company's failed sends of the day
-- by code as well, in the same transaction, so the year's reasons are read from kept counts. A
-- failure Meta reports later is counted while its day is among the 7 counted again each day, as
-- the day's failed sends are. Counts a code only: never a contact, a message or its error title,
-- which may quote what was sent.

-- Each company's failed sends on each UTC day by code (the empty code for a failure recorded
-- without one); a code without failures has no row. A company's rows are deleted with the company
-- (step 36 below); none is kept past 400 days.
CREATE TABLE ops.platform_failure_reason_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  utc_day date NOT NULL,
  reason_code text NOT NULL CHECK (char_length(reason_code) <= 32),
  failed integer NOT NULL CHECK (failed > 0),
  CONSTRAINT platform_failure_reason_days_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT platform_failure_reason_days_tenant_day_code_uq UNIQUE (tenant_id, utc_day, reason_code)
);
CREATE INDEX platform_failure_reason_days_day_idx ON ops.platform_failure_reason_days (utc_day);
SELECT ops.apply_tenant_rls('ops.platform_failure_reason_days');
-- Only the definer role's functions below, and the company deletion's, read and write the counts;
-- the deletion's policies are those of every table it deletes (0028).
CREATE POLICY definer_all ON ops.platform_failure_reason_days TO w360_definer
  USING (true) WITH CHECK (true);
CREATE POLICY tenant_deletion_read ON ops.platform_failure_reason_days FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON ops.platform_failure_reason_days FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
GRANT SELECT, INSERT, DELETE ON ops.platform_failure_reason_days TO w360_definer;

-- Company deletion (0028) deletes every table with tenant_id or keeps it on purpose: the counts go
-- with the company, a batch at a time, as the day counts do (step 35).
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode)
VALUES (36, ARRAY['ops.platform_failure_reason_days']::regclass[], 'batch');

-- Whether a counted day's failed sends by code were counted with it: false for the days counted
-- before this migration, which are counted again, newest first, as 0264's days without their
-- sends cancelled, delivered and read are.
ALTER TABLE ops.platform_message_days_counted
  ADD COLUMN reasons boolean NOT NULL DEFAULT false;

-- Definer-owned functions are replaced as 0264 replaced its own: dropped as their owner, created
-- again, granted and handed back, all in this migration's transaction.
SET ROLE w360_definer;
DROP FUNCTION ops.purge_platform_message_days();
DROP FUNCTION ops.count_platform_message_days(integer);
RESET ROLE;

-- Deleting the counts kept past their time, as 0262 deletes them, the failed sends by code too:
-- those older than 400 days, and those of companies deleted in the last 30 days. How many company
-- days it deleted (day counts only, as before).
CREATE FUNCTION ops.purge_platform_message_days()
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_old integer;
  v_gone integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('w360:platform-message-days', 0));
  DELETE FROM ops.platform_message_days d WHERE d.utc_day < v_today - 400;
  GET DIAGNOSTICS v_old = ROW_COUNT;
  DELETE FROM ops.platform_failure_reason_days r WHERE r.utc_day < v_today - 400;
  DELETE FROM ops.platform_message_days_counted c WHERE c.utc_day < v_today - 400;
  DELETE FROM ops.platform_message_days d
   USING app.tenants t
   WHERE t.id = d.tenant_id AND t.status = 'deleted'
     AND t.status_changed_at > now() - interval '30 days';
  GET DIAGNOSTICS v_gone = ROW_COUNT;
  DELETE FROM ops.platform_failure_reason_days r
   USING app.tenants t
   WHERE t.id = r.tenant_id AND t.status = 'deleted'
     AND t.status_changed_at > now() - interval '30 days';
  RETURN v_old + v_gone;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.purge_platform_message_days() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.purge_platform_message_days() TO w360_app;
ALTER FUNCTION ops.purge_platform_message_days() OWNER TO w360_definer;

-- Counting (the worker, every minute, a few days a call), as 0264 counts, with each company's
-- failed sends of the day by code read in the same statement, and one more kind of day due: a day
-- counted before this migration, without them. Newest first, so the latest days have them first
-- after a deployment.
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
     WHERE c.utc_day IS NULL OR NOT c.outcomes OR NOT c.reasons
        OR (g.n <= 7 AND c.counted_at < now() - interval '1 day')
     ORDER BY g.n
     LIMIT least(greatest(coalesce(p_limit, 0), 0), 31)
  LOOP
    DELETE FROM ops.platform_message_days d WHERE d.utc_day = v_day;
    DELETE FROM ops.platform_failure_reason_days r WHERE r.utc_day = v_day;
    -- One statement reads the day's messages once, in one snapshot, and fills both tables: each
    -- company's counts, and its failed sends by code, which add up to its failed sends. A message
    -- whose status changes while the day is counted is in both or in neither.
    WITH tallies AS (
      SELECT t.id AS tenant_id, x.code, x.sent, x.sent_failed, x.received, x.sent_canceled,
             x.sent_delivered, x.sent_read
        FROM app.tenants t
        CROSS JOIN LATERAL (
          -- A row per code of the failed sends, and one (code null) for the other messages.
          SELECT CASE WHEN mm.direction = 'outbound' AND mm.status = 'failed'
                      THEN coalesce(mm.error_code, '') END AS code,
                 count(*) FILTER (WHERE mm.direction = 'outbound')::integer AS sent,
                 count(*) FILTER (WHERE mm.direction = 'outbound'
                                    AND mm.status = 'failed')::integer AS sent_failed,
                 count(*) FILTER (WHERE mm.direction = 'inbound')::integer AS received,
                 count(*) FILTER (WHERE mm.direction = 'outbound'
                                    AND mm.status = 'canceled')::integer AS sent_canceled,
                 count(*) FILTER (WHERE mm.direction = 'outbound'
                                    AND mm.status IN ('delivered', 'read', 'played'))::integer
                   AS sent_delivered,
                 count(*) FILTER (WHERE mm.direction = 'outbound'
                                    AND mm.status IN ('read', 'played'))::integer AS sent_read
            FROM app.messages mm
           WHERE mm.tenant_id = t.id
             AND mm.created_at >= (v_day::timestamp AT TIME ZONE 'UTC')
             AND mm.created_at < ((v_day + 1)::timestamp AT TIME ZONE 'UTC')
           GROUP BY 1) x
       WHERE t.status <> 'deleted'
         AND NOT EXISTS (SELECT 1 FROM ops.tenant_deletions dl
                          WHERE dl.tenant_id = t.id AND dl.started_at IS NOT NULL)),
    counts AS (
      INSERT INTO ops.platform_message_days
        (tenant_id, utc_day, outbound, failed, inbound, canceled, delivered, read)
      SELECT g.tenant_id, v_day, sum(g.sent)::integer, sum(g.sent_failed)::integer,
             sum(g.received)::integer, sum(g.sent_canceled)::integer,
             sum(g.sent_delivered)::integer, sum(g.sent_read)::integer
        FROM tallies g
       GROUP BY g.tenant_id
      HAVING sum(g.sent) + sum(g.received) > 0)
    INSERT INTO ops.platform_failure_reason_days (tenant_id, utc_day, reason_code, failed)
    SELECT g.tenant_id, v_day, g.code, g.sent_failed
      FROM tallies g
     WHERE g.code IS NOT NULL;
    INSERT INTO ops.platform_message_days_counted (utc_day, counted_at, outcomes, reasons)
    VALUES (v_day, now(), true, true)
    ON CONFLICT (utc_day) DO UPDATE
      SET counted_at = excluded.counted_at, outcomes = true, reasons = true;
    v_counted := v_counted + 1;
  END LOOP;
  RETURN v_counted;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.count_platform_message_days(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.count_platform_message_days(integer) TO w360_app;
ALTER FUNCTION ops.count_platform_message_days(integer) OWNER TO w360_definer;

-- The year's failed sends by code (platform administrators): those of the 365 days before today
-- whose failed sends by code are counted, every company's not deleted or one company's, listed as
-- 0265 lists a window's: the eight most frequent, most first (ties by code), then one row with no
-- code for the rest, with how many codes it holds, when two or more are left.
CREATE FUNCTION ops.platform_ops_failure_reason_year(p_tenant_id uuid)
  RETURNS TABLE (reason_code text, failed_sends integer, codes integer)
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
  RETURN QUERY
  WITH by_code AS (
    SELECT r.reason_code AS code, sum(r.failed)::integer AS n
      FROM ops.platform_failure_reason_days r
      JOIN ops.platform_message_days_counted c ON c.utc_day = r.utc_day AND c.reasons
      JOIN app.tenants t ON t.id = r.tenant_id
     WHERE r.utc_day >= v_today - 365 AND r.utc_day < v_today
       AND t.status <> 'deleted' AND (p_tenant_id IS NULL OR r.tenant_id = p_tenant_id)
     GROUP BY 1),
  ranked AS (
    SELECT b.code, b.n, row_number() OVER (ORDER BY b.n DESC, b.code) AS r,
           count(*) OVER () AS total
      FROM by_code b)
  SELECT CASE WHEN k.r <= 8 OR k.total <= 9 THEN k.code END, sum(k.n)::integer, count(*)::integer
    FROM ranked k
   GROUP BY CASE WHEN k.r <= 8 OR k.total <= 9 THEN k.code END
   ORDER BY min(k.r);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_failure_reason_year(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_failure_reason_year(uuid) TO w360_platform;
ALTER FUNCTION ops.platform_ops_failure_reason_year(uuid) OWNER TO w360_definer;

-- How many of the 365 days before today have their failed sends by code counted (platform
-- administrators), so the year's reasons say which days they cover.
CREATE FUNCTION ops.platform_ops_failure_reason_days()
  RETURNS integer
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_days integer;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  SELECT count(*)::integer INTO v_days
    FROM ops.platform_message_days_counted c
   WHERE c.reasons AND c.utc_day >= v_today - 365 AND c.utc_day < v_today;
  RETURN v_days;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_failure_reason_days() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_failure_reason_days() TO w360_platform;
ALTER FUNCTION ops.platform_ops_failure_reason_days() OWNER TO w360_definer;
