-- How long jobs wait in each queue, and alerts for queues that fall behind (P5-10, ADR-096). The
-- operations console showed pg-boss's counts (ADR-054), which carry no age: a queue whose workers
-- had stopped taking work looked like a queue with a few jobs in it, and nobody was told. The
-- worker's minute sweep now records, for each queue it declares, how many jobs pg-boss would hand
-- to a worker now and since when the oldest of them has waited. A queue whose oldest job has waited
-- longer than the queue's limit is late until the wait is back under half the limit; every
-- platform administrator is emailed once each time a queue becomes late, at most every 15 minutes.
-- Queue names, counts and times only: nothing of a job's payload leaves pg-boss.

CREATE TABLE ops.queue_waits (
  queue text PRIMARY KEY CHECK (queue ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  -- Jobs pg-boss would hand to a worker now (created or retried, due, not held by a dependency).
  waiting integer NOT NULL CHECK (waiting >= 0),
  -- When the oldest of them became due: its creation, or the time its retry or delay ran out.
  oldest_waiting_since timestamptz,
  limit_minutes integer NOT NULL CHECK (limit_minutes BETWEEN 1 AND 1440),
  checked_at timestamptz NOT NULL,
  -- Since when the queue has been late; null when it is on time.
  late_since timestamptz,
  -- When platform staff were emailed that it was late; null until then, and again once on time.
  alerted_at timestamptz,
  CHECK ((waiting = 0) = (oldest_waiting_since IS NULL)),
  CHECK (alerted_at IS NULL OR late_since IS NOT NULL)
);
-- The console reads it whole (queue names, counts and times); the worker reads what is due. Only
-- the two functions below write it.
GRANT SELECT ON ops.queue_waits TO w360_platform, w360_app;

-- Late queues have their own cadence: an alert about work that failed for good does not hold one
-- back, nor the other way round.
ALTER TABLE ops.platform_alerts
  DROP CONSTRAINT platform_alerts_kind_check,
  ADD CONSTRAINT platform_alerts_kind_check CHECK (kind IN ('failures', 'queues'));
INSERT INTO ops.platform_alerts (kind) VALUES ('queues');

-- Records one check: for each queue given, its waiting jobs, the oldest one's due time and its
-- limit, as the worker read them from pg-boss in the same transaction. A queue becomes late when
-- its oldest job has waited its limit, and stays late until nothing has waited half of it, so a
-- queue hovering around its limit is not told again and again; when it is back on time its alert
-- is re-armed. Rows no check has touched for 7 days (queues a release no longer declares) are
-- deleted. Returns how many of the given queues are late.
CREATE FUNCTION ops.record_queue_waits(p_waits jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_late integer;
BEGIN
  IF jsonb_typeof(p_waits) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'queue waits must be an array' USING ERRCODE = '22023';
  END IF;
  WITH given AS (
    SELECT x.queue, x.waiting, x.oldest_waiting_since, x.limit_minutes,
           x.oldest_waiting_since <= now() - make_interval(mins => x.limit_minutes) AS over_limit
      FROM jsonb_to_recordset(p_waits)
        AS x(queue text, waiting integer, oldest_waiting_since timestamptz, limit_minutes integer)
  )
  INSERT INTO ops.queue_waits AS w (queue, waiting, oldest_waiting_since, limit_minutes, checked_at,
                                    late_since, alerted_at)
  SELECT g.queue, g.waiting, g.oldest_waiting_since, g.limit_minutes, now(),
         CASE WHEN g.over_limit THEN now() END, NULL
    FROM given g
  ON CONFLICT (queue) DO UPDATE SET
    waiting = excluded.waiting,
    oldest_waiting_since = excluded.oldest_waiting_since,
    limit_minutes = excluded.limit_minutes,
    checked_at = excluded.checked_at,
    late_since = CASE
      WHEN w.late_since IS NULL THEN excluded.late_since
      WHEN excluded.oldest_waiting_since <= now() - make_interval(mins => excluded.limit_minutes) / 2
        THEN w.late_since
    END,
    alerted_at = CASE
      WHEN w.late_since IS NOT NULL
       AND excluded.oldest_waiting_since <= now() - make_interval(mins => excluded.limit_minutes) / 2
        THEN w.alerted_at
    END;
  DELETE FROM ops.queue_waits WHERE checked_at < now() - interval '7 days';
  SELECT count(*)::integer INTO v_late
    FROM ops.queue_waits w
   WHERE w.late_since IS NOT NULL
     AND w.queue IN (SELECT x.queue FROM jsonb_to_recordset(p_waits) AS x(queue text));
  RETURN v_late;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.record_queue_waits(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.record_queue_waits(jsonb) TO w360_app;
ALTER FUNCTION ops.record_queue_waits(jsonb) OWNER TO w360_definer;

-- Marks the late queues not yet told, in the transaction that queues the alert's emails, and
-- returns them. Nothing while the last queue alert went out less than 15 minutes ago: they wait for
-- the next one. Only queues checked in the last 5 minutes are told, so a row a stopped check left
-- behind is not reported as news. Two sweeps at once queue at most one alert (the row lock on
-- ops.platform_alerts), and the update checks its mark again.
CREATE FUNCTION ops.mark_queue_alert()
  RETURNS TABLE (queue text, waiting integer, oldest_waiting_since timestamptz,
                 limit_minutes integer, checked_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_last timestamptz;
BEGIN
  SELECT a.last_sent_at INTO v_last FROM ops.platform_alerts a WHERE a.kind = 'queues' FOR UPDATE;
  IF v_last > now() - interval '15 minutes' THEN
    RETURN;
  END IF;
  RETURN QUERY
    WITH marked AS (
      UPDATE ops.queue_waits w SET alerted_at = now()
       WHERE w.late_since IS NOT NULL AND w.alerted_at IS NULL
         AND w.checked_at > now() - interval '5 minutes'
      RETURNING w.queue, w.waiting, w.oldest_waiting_since, w.limit_minutes, w.checked_at
    )
    SELECT m.queue, m.waiting, m.oldest_waiting_since, m.limit_minutes, m.checked_at
      FROM marked m ORDER BY m.queue;
  IF FOUND THEN
    UPDATE ops.platform_alerts SET last_sent_at = now() WHERE kind = 'queues';
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.mark_queue_alert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.mark_queue_alert() TO w360_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.queue_waits TO w360_definer;
ALTER FUNCTION ops.mark_queue_alert() OWNER TO w360_definer;
