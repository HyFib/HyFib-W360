-- 0012_automation_sends: automation runs wait for Meta to accept each bot message. A run that
-- queued a message records it in pending_message_id and takes no further step until the send
-- worker records Meta's acceptance, so a run never reports "completed" (or moves on to its next
-- step) for a message the customer never got. A message that Meta rejects, that is cancelled, or
-- whose outcome is unknown fails the run with `send_failed` and passes the conversation to people;
-- so does a failure Meta reports later for any message of an active run.

ALTER TABLE app.automation_runs ADD COLUMN pending_message_id uuid;
ALTER TABLE app.automation_runs ADD CONSTRAINT automation_runs_pending_message_fk
  FOREIGN KEY (tenant_id, pending_message_id) REFERENCES app.messages (tenant_id, id)
  ON DELETE SET NULL (pending_message_id);

ALTER TABLE app.automation_runs DROP CONSTRAINT automation_runs_end;
ALTER TABLE app.automation_runs ADD CONSTRAINT automation_runs_end CHECK (
  (status IN ('running', 'waiting') AND ended_at IS NULL AND end_reason IS NULL AND ended_by_membership_id IS NULL)
  OR (status = 'completed' AND ended_at IS NOT NULL AND end_reason IN ('end_node', 'no_next'))
  OR (status = 'handed_off' AND ended_at IS NOT NULL AND end_reason = 'handoff_node')
  OR (status = 'taken_over' AND ended_at IS NOT NULL AND end_reason IN ('agent_replied', 'assigned', 'take_over'))
  OR (status = 'stopped' AND ended_at IS NOT NULL
      AND end_reason IN ('stopped_by_member', 'conversation_resolved', 'opted_out', 'contact_erased',
                         'automation_archived'))
  OR (status = 'failed' AND ended_at IS NOT NULL
      AND end_reason IN ('budget_steps', 'budget_loop', 'budget_messages', 'expired', 'send_blocked',
                         'send_failed', 'error')));

-- Same guard as 0011, with the pending message among the columns an ended run keeps.
CREATE OR REPLACE FUNCTION app.guard_automation_run() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'automation runs cannot be deleted' USING ERRCODE = 'W3403';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.automation_id, NEW.version_id, NEW.conversation_id, NEW.contact_id,
      NEW.channel_account_id, NEW.mode, NEW.trigger_type, NEW.trigger_message_id,
      NEW.started_by_membership_id, NEW.started_by_user_id, NEW.started_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.automation_id, OLD.version_id, OLD.conversation_id, OLD.contact_id,
      OLD.channel_account_id, OLD.mode, OLD.trigger_type, OLD.trigger_message_id,
      OLD.started_by_membership_id, OLD.started_by_user_id, OLD.started_at) THEN
    RAISE EXCEPTION 'what started an automation run is fixed' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.status NOT IN ('running', 'waiting') THEN
    IF (NEW.status, NEW.current_node_id, NEW.node_visit, NEW.waiting_for, NEW.wait_until,
        NEW.input_message_id, NEW.pending_message_id, NEW.retries, NEW.failures, NEW.step_count,
        NEW.message_count, NEW.visits, NEW.next_step_at, NEW.ended_at, NEW.end_reason, NEW.end_detail,
        NEW.ended_by_membership_id)
       IS DISTINCT FROM
       (OLD.status, OLD.current_node_id, OLD.node_visit, OLD.waiting_for, OLD.wait_until,
        OLD.input_message_id, OLD.pending_message_id, OLD.retries, OLD.failures, OLD.step_count,
        OLD.message_count, OLD.visits, OLD.next_step_at, OLD.ended_at, OLD.end_reason, OLD.end_detail,
        OLD.ended_by_membership_id)
       OR (NEW.variables IS DISTINCT FROM OLD.variables AND NEW.variables <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'an ended automation run cannot change' USING ERRCODE = 'W3403';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

GRANT UPDATE (pending_message_id) ON app.automation_runs TO w360_app;
