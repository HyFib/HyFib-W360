-- Retrying dead-lettered jobs from the operations console (P5-10, ADR-108).
--
-- A job that failed all its retries stays in pg-boss, failed, for its queue's retention, and the
-- worker records it in ops.dead_letters (ADR-054). Platform administrators can now send such a job
-- back to its queue once, with a reason: one more attempt, exactly as pg-boss's own retry makes it.
-- The retry, the mark on the dead letter and the platform audit event are one transaction.

ALTER TABLE ops.dead_letters
  ADD COLUMN retried_at timestamptz,
  ADD COLUMN retried_by_user_id text REFERENCES auth.users (id),
  ADD CONSTRAINT dead_letters_retried_by
    CHECK ((retried_at IS NULL) = (retried_by_user_id IS NULL));
GRANT UPDATE (retried_at, retried_by_user_id) ON ops.dead_letters TO w360_definer;

-- Sends a dead letter's job back to its queue, in the platform role's session by the administrator
-- in app.user_id. Refused for a dead letter already retried, one whose envelope did not verify (the
-- worker would refuse the job again), one of a company being deleted, a job pg-boss no longer keeps
-- as failed (after its queue's retention), a job of a queue that never retries its jobs
-- (billing.auto-recharge: an attempt is reconciled before anything is charged again; no producer
-- sets a job's retry limit, so a limit of 0 is the queue's), a job of a receipt queue (the receipt
-- retry of 0026 resets the receipt's attempts and refuses one whose body was erased), and a job
-- whose work is already waiting in an exclusive queue. The update is pg-boss 12's own retry
-- (`retryJobs`: state back to retry, one more attempt allowed, no completion time); the migration
-- runner grants the definer exactly the columns it needs on pgboss.job
-- (packages/db/src/migrate.ts). Returns the job's queue.
CREATE FUNCTION ops.platform_retry_dead_letter(p_dead_letter_id uuid, p_reason text,
    p_correlation_id text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  d ops.dead_letters%ROWTYPE;
  v_company text;
  v_state text;
  v_retry_limit integer;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters.' USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO d FROM ops.dead_letters l WHERE l.id = p_dead_letter_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dead letter not found.' USING ERRCODE = 'W3404';
  END IF;
  IF d.retried_at IS NOT NULL THEN
    RAISE EXCEPTION 'This job was already retried. If it failed again, it has a dead letter of its own.'
      USING ERRCODE = 'W3412';
  END IF;
  IF NOT d.verified OR d.source_job_id IS NULL THEN
    RAISE EXCEPTION 'This job''s envelope did not verify, so the worker would refuse it again.'
      USING ERRCODE = 'W3412';
  END IF;
  IF d.source_queue IN ('webhook.process', 'billing.event-process') THEN
    RAISE EXCEPTION 'Retry this job''s receipt on the Integrations page instead: that resets its attempts and checks its body is still kept.'
      USING ERRCODE = 'W3412';
  END IF;
  IF d.tenant_id IS NOT NULL THEN
    SELECT t.status INTO v_company FROM app.tenants t WHERE t.id = d.tenant_id;
    IF v_company IS NULL OR v_company IN ('pending_deletion', 'deleted') THEN
      RAISE EXCEPTION 'The job''s company is being deleted or is gone, so its job is not retried.'
        USING ERRCODE = 'W3412';
    END IF;
  END IF;
  SELECT j.state::text, j.retry_limit INTO v_state, v_retry_limit
    FROM pgboss.job j
   WHERE j.name = d.source_queue AND j.id = d.source_job_id
     FOR UPDATE;
  IF NOT FOUND OR v_state <> 'failed' THEN
    RAISE EXCEPTION 'pg-boss no longer keeps this job as failed (it keeps failed jobs for the queue''s retention), so it cannot be retried.'
      USING ERRCODE = 'W3412';
  END IF;
  IF v_retry_limit = 0 THEN
    RAISE EXCEPTION 'This job''s queue never retries its jobs, so it is not retried here either.'
      USING ERRCODE = 'W3412';
  END IF;
  BEGIN
    UPDATE pgboss.job j
       SET state = 'retry', retry_limit = j.retry_limit + 1, completed_on = NULL
     WHERE j.name = d.source_queue AND j.id = d.source_job_id AND j.state = 'failed';
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'A job for the same work is already waiting in its queue; it will do this job''s work.'
      USING ERRCODE = 'W3412';
  END;
  UPDATE ops.dead_letters SET retried_at = now(), retried_by_user_id = v_actor
   WHERE id = d.id;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, reason, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.dead_letter_retried', btrim(p_reason), 'success', p_correlation_id,
          jsonb_build_object('deadLetterId', d.id, 'queue', d.source_queue,
                             'jobId', d.source_job_id, 'tenantId', d.tenant_id));
  RETURN d.source_queue;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_retry_dead_letter(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_retry_dead_letter(uuid, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_retry_dead_letter(uuid, text, text) OWNER TO w360_definer;
