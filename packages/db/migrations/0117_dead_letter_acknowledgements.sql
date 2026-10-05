-- Acknowledging dead letters on the operations console (P5-10, ADR-169). Since ADR-091 every
-- platform administrator is emailed about each dead letter, and since ADR-108 one can send its job
-- back to its queue once. Many dead letters need no retry (the work is obsolete, or the company
-- fixed it and started it again), and nothing on the Queues tab said that someone had already
-- looked: an administrator now records it with a note, as failing integrations are acknowledged
-- (0107). A dead letter is kept 30 days after its job failed (0026), and its acknowledgement with
-- it: a later failure of the same work has a dead letter of its own.
ALTER TABLE ops.dead_letters
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN acknowledged_by_user_id text REFERENCES auth.users (id),
  ADD COLUMN acknowledgement text,
  ADD CONSTRAINT dead_letters_acknowledged CHECK (
    (acknowledged_at IS NULL) = (acknowledged_by_user_id IS NULL)
    AND (acknowledged_at IS NULL) = (acknowledgement IS NULL)
    AND (acknowledgement IS NULL OR char_length(acknowledgement) BETWEEN 10 AND 500));
GRANT UPDATE (acknowledged_at, acknowledged_by_user_id, acknowledgement)
  ON ops.dead_letters TO w360_definer;

-- Records an administrator's note on a dead letter the console lists, replacing an earlier one,
-- and audits it in the same transaction. Any dead letter still kept can be acknowledged, retried or
-- not. The company is named in the audit entry only through a signature that verified, as the
-- console names it (ADR-054), and only while it still exists. Platform administrators only.
CREATE FUNCTION ops.platform_acknowledge_dead_letter(p_dead_letter_id uuid, p_note text,
    p_correlation_id text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_note text := btrim(p_note);
  d ops.dead_letters%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF v_note IS NULL OR char_length(v_note) < 10 OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'Write a note of 10 to 500 characters.' USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO d FROM ops.dead_letters l WHERE l.id = p_dead_letter_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dead letter not found.' USING ERRCODE = 'W3404';
  END IF;
  UPDATE ops.dead_letters
     SET acknowledged_at = now(), acknowledged_by_user_id = v_actor, acknowledgement = v_note
   WHERE id = d.id;
  INSERT INTO ops.platform_audit_events
    (actor_user_id, action, target_tenant_id, reason, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.dead_letter_acknowledged',
          CASE WHEN d.verified THEN (SELECT t.id FROM app.tenants t WHERE t.id = d.tenant_id) END,
          v_note, 'success', p_correlation_id,
          jsonb_build_object('deadLetterId', d.id, 'queue', d.source_queue));
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_acknowledge_dead_letter(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_acknowledge_dead_letter(uuid, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_acknowledge_dead_letter(uuid, text, text) OWNER TO w360_definer;
