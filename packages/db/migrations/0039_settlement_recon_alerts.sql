-- 0039_settlement_recon_alerts: platform owners are emailed when a day's settlement reconciliation
-- finishes with transactions waiting for a person, or fails (P5-05, ADR-066). The worker's minute
-- sweep lists the finished attempts not emailed yet and marks each in the transaction that queues
-- the emails, so an attempt is emailed once. Only days, counts and errors go into the email; the
-- transactions stay on Platform → Reconciliation.

-- The attempt (attempt_seq) whose outcome platform owners were emailed about. Running a day again
-- starts a new attempt, whose outcome is emailed again.
ALTER TABLE ops.settlement_recon_runs
  ADD COLUMN alerted_attempt integer CHECK (alerted_attempt > 0);
-- Runs finished before this migration are already on the reconciliation page: not emailed.
UPDATE ops.settlement_recon_runs SET alerted_attempt = attempt_seq
 WHERE status IN ('completed', 'failed') AND attempt_seq > 0;

-- Finished attempts not emailed yet (ids and attempt numbers, for the minute sweep): failed runs, and
-- completed runs with transactions still waiting for a person (not resolved), oldest day first.
CREATE FUNCTION ops.settlement_recon_alerts_due(p_limit integer)
  RETURNS TABLE (run_id uuid, attempt integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT r.id, r.attempt_seq
    FROM ops.settlement_recon_runs r
   WHERE r.attempt_seq > 0
     AND r.alerted_attempt IS DISTINCT FROM r.attempt_seq
     AND (r.status = 'failed'
          OR (r.status = 'completed'
              AND EXISTS (SELECT 1 FROM ops.settlement_recon_items i
                           WHERE i.run_id = r.id AND i.status IN ('mismatch', 'review', 'not_hyfib')
                             AND i.resolved_at IS NULL)))
   ORDER BY r.settlement_date
   LIMIT least(greatest(coalesce(p_limit, 10), 1), 50)
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_recon_alerts_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_recon_alerts_due(integer) TO w360_app;
ALTER FUNCTION ops.settlement_recon_alerts_due(integer) OWNER TO w360_definer;

-- Marks a finished attempt as emailed and returns what the email says about it: the day, the outcome,
-- the error of a failed run, and the transactions still waiting for a person, counted by status now.
-- Nothing is returned (and nothing marked) when it was marked already (another sweep got there first:
-- this call waits for it and then finds it marked), the run moved on to a new attempt, or nothing is
-- waiting for a person any more.
CREATE FUNCTION ops.settlement_recon_mark_alerted(p_run_id uuid, p_attempt integer)
  RETURNS TABLE (settlement_date date, status text, last_error text,
                 open_mismatch integer, open_review integer, open_not_hyfib integer)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  WITH o AS (
    SELECT count(*) FILTER (WHERE i.status = 'mismatch')::integer AS mismatch,
           count(*) FILTER (WHERE i.status = 'review')::integer AS review,
           count(*) FILTER (WHERE i.status = 'not_hyfib')::integer AS not_hyfib
      FROM ops.settlement_recon_items i
     WHERE i.run_id = p_run_id AND i.status IN ('mismatch', 'review', 'not_hyfib')
       AND i.resolved_at IS NULL)
  UPDATE ops.settlement_recon_runs r SET alerted_attempt = p_attempt
    FROM o
   WHERE r.id = p_run_id AND r.attempt_seq = p_attempt
     AND r.alerted_attempt IS DISTINCT FROM p_attempt
     AND (r.status = 'failed'
          OR (r.status = 'completed' AND o.mismatch + o.review + o.not_hyfib > 0))
  RETURNING r.settlement_date, r.status, r.last_error, o.mismatch, o.review, o.not_hyfib
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_recon_mark_alerted(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_recon_mark_alerted(uuid, integer) TO w360_app;
ALTER FUNCTION ops.settlement_recon_mark_alerted(uuid, integer) OWNER TO w360_definer;

-- Who is emailed: platform owners, who resolve transactions and run days again (operators only read).
CREATE FUNCTION ops.settlement_recon_alert_recipients()
  RETURNS TABLE (user_id text, email text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT u.id, u.email
    FROM ops.platform_admins a
    JOIN auth.users u ON u.id = a.user_id
   WHERE a.role = 'platform_owner'
   ORDER BY u.id
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_recon_alert_recipients() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_recon_alert_recipients() TO w360_app;
ALTER FUNCTION ops.settlement_recon_alert_recipients() OWNER TO w360_definer;
