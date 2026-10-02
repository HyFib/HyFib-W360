-- Work that runs out of retries ends where the company can see it (P5-10, ADR-111).
--
-- Three queues leave their work in progress for good when their job dead-letters (ADR-108):
-- number setup (`channel.onboard`), the check of a company's Razorpay keys (`commerce.account`) and
-- a template deletion (`template.delete`). The minute sweep now settles that work in the company's
-- scope (the number's setup fails with the step it stopped at, the keys' check fails, the template
-- goes back to Meta's last status) and marks the dead letter, in one transaction, unless a job for
-- the same work is waiting or running again (the company started it again or saved the keys
-- again). A settled dead letter is not retried from the console; a retried one is not settled.

-- Dead letters ---------------------------------------------------------------------------------------
-- When the sweep settled the dead letter's work, and whether anything was left to end (the work may
-- have finished or been started again meanwhile). Only verified dead letters of the three queues are
-- settled, and a dead letter is either retried (ADR-108) or settled, never both.
ALTER TABLE ops.dead_letters
  ADD COLUMN settled_at timestamptz,
  ADD COLUMN settled_ended boolean,
  ADD CONSTRAINT dead_letters_settled_pair
    CHECK ((settled_at IS NULL) = (settled_ended IS NULL)),
  ADD CONSTRAINT dead_letters_settled_queue
    CHECK (settled_at IS NULL
           OR (verified AND source_queue IN ('channel.onboard', 'commerce.account', 'template.delete'))),
  ADD CONSTRAINT dead_letters_retried_or_settled
    CHECK (settled_at IS NULL OR retried_at IS NULL);
GRANT UPDATE (settled_at, settled_ended) ON ops.dead_letters TO w360_definer;

-- The sweep's lookup reads the few dead letters still to settle.
CREATE INDEX dead_letters_to_settle_idx ON ops.dead_letters (failed_at)
  WHERE settled_at IS NULL AND retried_at IS NULL AND verified
    AND source_queue IN ('channel.onboard', 'commerce.account', 'template.delete');

-- Whether a job for the dead letter's work is waiting or running again, found by the singleton keys
-- the three queues use: the number's id for its setup, the template's id and ':delete' for its
-- deletion, and the account's id, ':' and the save time for a check of the keys (each save queues
-- a check of its own). So a setup retried, a deletion asked for again or keys saved again since the
-- job died count. Reads pg-boss's job table through the columns the migration runner grants the
-- definer (packages/db/src/migrate.ts).
-- PL/pgSQL, so the job table is resolved when the function runs: pg-boss installs its schema after
-- the SQL migrations on a new database.
CREATE FUNCTION ops.dead_letter_work_live(p_queue text, p_ref text)
  RETURNS boolean
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM pgboss.job j
     WHERE j.name = p_queue
       AND j.state IN ('created', 'retry', 'active')
       AND CASE p_queue
             WHEN 'channel.onboard' THEN j.singleton_key = p_ref
             WHEN 'template.delete' THEN j.singleton_key = p_ref || ':delete'
             WHEN 'commerce.account' THEN starts_with(j.singleton_key, p_ref || ':')
             ELSE false
           END);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.dead_letter_work_live(text, text) FROM PUBLIC;
ALTER FUNCTION ops.dead_letter_work_live(text, text) OWNER TO w360_definer;

-- The sweep's lookup: verified dead letters of the three queues that no one retried and that are not
-- settled, of companies not being deleted, whose work no live job is doing again, oldest first. The
-- company and the work come from the envelope the worker verified when it recorded the dead letter.
CREATE FUNCTION ops.dead_letters_to_settle(p_limit integer)
  RETURNS TABLE (dead_letter_id uuid, source_queue text, tenant_id uuid, ref text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT d.id, d.source_queue, d.tenant_id, d.ref
    FROM ops.dead_letters d
    JOIN app.tenants t ON t.id = d.tenant_id AND t.status NOT IN ('pending_deletion', 'deleted')
   WHERE d.settled_at IS NULL AND d.retried_at IS NULL AND d.verified AND d.ref IS NOT NULL
     AND d.source_queue IN ('channel.onboard', 'commerce.account', 'template.delete')
     AND d.kind = d.source_queue
     AND NOT ops.dead_letter_work_live(d.source_queue, d.ref)
   ORDER BY d.failed_at
   LIMIT p_limit
$$;
REVOKE EXECUTE ON FUNCTION ops.dead_letters_to_settle(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.dead_letters_to_settle(integer) TO w360_app;
ALTER FUNCTION ops.dead_letters_to_settle(integer) OWNER TO w360_definer;

-- Marks a dead letter settled, in its company's own scope, in the transaction that ended (or found
-- nothing left of) its work. False when it was retried or settled meanwhile, or a job for its work
-- is waiting or running again: the caller then rolls its transaction back, so work a job is doing is
-- never ended under it. A retry or a new job committed after this lock waits for, or sees, the mark
-- and the ended work.
CREATE FUNCTION ops.settle_dead_letter(p_dead_letter_id uuid, p_ended boolean)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  d ops.dead_letters%ROWTYPE;
BEGIN
  IF v_tenant IS NULL OR p_ended IS NULL THEN
    RAISE EXCEPTION 'dead letters are settled in their company''s own scope' USING ERRCODE = 'W3403';
  END IF;
  SELECT * INTO d FROM ops.dead_letters l WHERE l.id = p_dead_letter_id FOR UPDATE;
  IF NOT FOUND OR d.tenant_id IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'Dead letter not found.' USING ERRCODE = 'W3404';
  END IF;
  IF NOT d.verified OR d.kind IS DISTINCT FROM d.source_queue
     OR d.source_queue NOT IN ('channel.onboard', 'commerce.account', 'template.delete') THEN
    RAISE EXCEPTION 'This dead letter''s work is not settled by the sweep.' USING ERRCODE = 'W3412';
  END IF;
  IF d.settled_at IS NOT NULL OR d.retried_at IS NOT NULL
     OR ops.dead_letter_work_live(d.source_queue, d.ref) THEN
    RETURN false;
  END IF;
  UPDATE ops.dead_letters SET settled_at = now(), settled_ended = p_ended WHERE id = d.id;
  RETURN true;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.settle_dead_letter(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settle_dead_letter(uuid, boolean) TO w360_app;
ALTER FUNCTION ops.settle_dead_letter(uuid, boolean) OWNER TO w360_definer;

-- Retrying from the console ----------------------------------------------------------------------------
-- As in 0086, and a settled dead letter is refused: its work was ended for its company, which can
-- start it again. The owner drops the function and the migration role recreates it (see 0011).
SET ROLE w360_definer;
DROP FUNCTION ops.platform_retry_dead_letter(uuid, text, text);
RESET ROLE;
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
  IF d.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'This job''s work was ended for its company, which can start it again.'
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
