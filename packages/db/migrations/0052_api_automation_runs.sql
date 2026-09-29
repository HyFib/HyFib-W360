-- 0052_api_automation_runs: starting automations through the public API (P5-08, ADR-077). A key
-- with the new `automations.start` scope starts a published automation whose trigger is "Started
-- through the API" for one contact. The run records the key that started it, and the run guard keeps
-- it fixed with everything else that started the run. Existing keys keep their scopes (the key
-- guard), so they gain nothing.

ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 9
  AND scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write', 'messages.send',
                      'messages.send_marketing', 'messages.reply', 'conversations.read',
                      'conversations.write', 'automations.start']::text[]);

-- api_key_id: the key a run started through the API came from (NULL for every other run). The
-- checks and the foreign key are added NOT VALID, so app.automation_runs is not read under this
-- migration's lock: rows already there have no key and a trigger type the new check allows. 0054
-- validates them; 0053 builds the index the foreign key's checks use.
ALTER TABLE app.automation_runs
  ADD COLUMN api_key_id uuid,
  DROP CONSTRAINT automation_runs_trigger_type_check,
  ADD CONSTRAINT automation_runs_trigger_type_check CHECK (trigger_type IN
    ('keyword', 'conversation_started', 'any_message', 'test', 'store_event', 'api')) NOT VALID,
  ADD CONSTRAINT automation_runs_api_key CHECK ((trigger_type = 'api') = (api_key_id IS NOT NULL))
    NOT VALID,
  ADD CONSTRAINT automation_runs_api_key_fk FOREIGN KEY (tenant_id, api_key_id)
    REFERENCES app.api_keys (tenant_id, id) NOT VALID;

-- What started a run stays fixed (0011, 0022, 0028), now including the key.
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
      NEW.started_by_membership_id, NEW.started_by_user_id, NEW.started_at, NEW.store_event,
      NEW.api_key_id)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.automation_id, OLD.version_id, OLD.conversation_id, OLD.contact_id,
      OLD.channel_account_id, OLD.mode, OLD.trigger_type, OLD.trigger_message_id,
      OLD.started_by_membership_id, OLD.started_by_user_id, OLD.started_at, OLD.store_event,
      OLD.api_key_id)
     OR (NEW.store_order_id IS DISTINCT FROM OLD.store_order_id AND NEW.store_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'what started an automation run is fixed' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.status NOT IN ('running', 'waiting') THEN
    IF (NEW.status, NEW.current_node_id, NEW.node_visit, NEW.waiting_for, NEW.wait_until,
        NEW.input_message_id, NEW.pending_message_id, NEW.retries, NEW.failures, NEW.step_count,
        NEW.message_count, NEW.http_call_count, NEW.visits, NEW.next_step_at, NEW.ended_at,
        NEW.end_reason, NEW.end_detail, NEW.ended_by_membership_id)
       IS DISTINCT FROM
       (OLD.status, OLD.current_node_id, OLD.node_visit, OLD.waiting_for, OLD.wait_until,
        OLD.input_message_id, OLD.pending_message_id, OLD.retries, OLD.failures, OLD.step_count,
        OLD.message_count, OLD.http_call_count, OLD.visits, OLD.next_step_at, OLD.ended_at,
        OLD.end_reason, OLD.end_detail, OLD.ended_by_membership_id)
       OR (NEW.variables IS DISTINCT FROM OLD.variables AND NEW.variables <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'an ended automation run cannot change' USING ERRCODE = 'W3403';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
