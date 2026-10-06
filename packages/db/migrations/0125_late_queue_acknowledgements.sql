-- Acknowledging late queues on the operations console (P5-10, ADR-177). Since ADR-096 every
-- platform administrator is emailed once each time a queue falls behind, and the Queues tab shows
-- since when; nothing there said that someone had already looked, or what they found. An
-- administrator now records it with a note, as dead letters (0117) and failing integrations (0107)
-- are acknowledged. A late queue recovers, so its acknowledgement lasts while the queue stays late:
-- the check that finds it back on time clears it, and the next time it falls behind it starts
-- unacknowledged, as it is emailed again.
ALTER TABLE ops.queue_waits
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN acknowledged_by_user_id text REFERENCES auth.users (id),
  ADD COLUMN acknowledgement text,
  ADD CONSTRAINT queue_waits_acknowledged CHECK (
    (acknowledged_at IS NULL) = (acknowledged_by_user_id IS NULL)
    AND (acknowledged_at IS NULL) = (acknowledgement IS NULL)
    AND (acknowledgement IS NULL OR char_length(acknowledgement) BETWEEN 10 AND 500)
    AND (acknowledged_at IS NULL OR late_since IS NOT NULL));

-- Platform staff read the notes with the rest of the row (0072's table grant). The worker reads only
-- what its sweep needs, so its table grant becomes one on the columns of the check.
REVOKE SELECT ON ops.queue_waits FROM w360_app;
GRANT SELECT (queue, waiting, oldest_waiting_since, limit_minutes, checked_at, late_since, alerted_at)
  ON ops.queue_waits TO w360_app;

-- 0072's check, clearing the acknowledgement when the queue is back on time, as it clears the
-- alert's mark: the same condition keeps both. The function is owned by w360_definer, which the
-- migration role cannot replace in place (0011's note): the owner drops it and the migration role
-- creates it again, granting before handing it back.
SET ROLE w360_definer;
DROP FUNCTION ops.record_queue_waits(jsonb);
RESET ROLE;
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
    END,
    acknowledged_at = CASE
      WHEN w.late_since IS NOT NULL
       AND excluded.oldest_waiting_since <= now() - make_interval(mins => excluded.limit_minutes) / 2
        THEN w.acknowledged_at
    END,
    acknowledged_by_user_id = CASE
      WHEN w.late_since IS NOT NULL
       AND excluded.oldest_waiting_since <= now() - make_interval(mins => excluded.limit_minutes) / 2
        THEN w.acknowledged_by_user_id
    END,
    acknowledgement = CASE
      WHEN w.late_since IS NOT NULL
       AND excluded.oldest_waiting_since <= now() - make_interval(mins => excluded.limit_minutes) / 2
        THEN w.acknowledgement
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

-- Records an administrator's note on a queue that is late now, replacing an earlier one, and audits
-- it in the same transaction. The page names the lateness it shows by its start (to the
-- millisecond, as the console reads it), so a page left open cannot acknowledge a later spell of the
-- same queue, or one that has recovered. Platform administrators only.
CREATE FUNCTION ops.platform_acknowledge_late_queue(p_queue text, p_late_since timestamptz,
    p_note text, p_correlation_id text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_note text := btrim(p_note);
  w ops.queue_waits%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF v_note IS NULL OR char_length(v_note) < 10 OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'Write a note of 10 to 500 characters.' USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO w FROM ops.queue_waits q WHERE q.queue = p_queue FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Queue not found.' USING ERRCODE = 'W3404';
  END IF;
  IF w.late_since IS NULL OR p_late_since IS NULL
     OR abs(extract(epoch FROM w.late_since - p_late_since)) >= 0.001 THEN
    RAISE EXCEPTION 'This queue is no longer late since then. Reload the page.' USING ERRCODE = 'W3409';
  END IF;
  UPDATE ops.queue_waits
     SET acknowledged_at = now(), acknowledged_by_user_id = v_actor, acknowledgement = v_note
   WHERE queue = w.queue;
  INSERT INTO ops.platform_audit_events
    (actor_user_id, action, target_tenant_id, reason, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.late_queue_acknowledged', NULL, v_note, 'success', p_correlation_id,
          jsonb_build_object('queue', w.queue, 'lateSince', w.late_since, 'waiting', w.waiting));
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_acknowledge_late_queue(text, timestamptz, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_acknowledge_late_queue(text, timestamptz, text, text)
  TO w360_platform;
ALTER FUNCTION ops.platform_acknowledge_late_queue(text, timestamptz, text, text)
  OWNER TO w360_definer;
