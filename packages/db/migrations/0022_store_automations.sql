-- 0022_store_automations: store events in automations (P4-06e, ADR-050). An order message rule can
-- start a published automation instead of sending its template; the automation's trigger
-- (store_event) never matches a customer message. A run started this way keeps the order it is about
-- (a reference, not a copy) and the event; template steps let it message the customer before they
-- reply.

-- Runs ---------------------------------------------------------------------------------------------------
-- store_order_id: the order a run started by order messages (or a test run with a chosen order)
-- reads while it runs; cleared when the order is deleted. store_event: the event that started it.
ALTER TABLE app.automation_runs
  ADD COLUMN store_order_id uuid,
  ADD COLUMN store_event text CHECK (store_event IN
    ('order_placed', 'order_shipped', 'order_delivered', 'order_cancelled')),
  DROP CONSTRAINT automation_runs_trigger_type_check,
  ADD CONSTRAINT automation_runs_trigger_type_check CHECK (trigger_type IN
    ('keyword', 'conversation_started', 'any_message', 'test', 'store_event')),
  ADD CONSTRAINT automation_runs_store_event CHECK (
    (trigger_type = 'store_event') = (store_event IS NOT NULL)
    AND (store_order_id IS NULL OR trigger_type IN ('store_event', 'test'))),
  ADD CONSTRAINT automation_runs_store_order_fk FOREIGN KEY (tenant_id, store_order_id)
    REFERENCES app.commerce_store_orders (tenant_id, id) ON DELETE SET NULL (store_order_id);
CREATE INDEX automation_runs_store_order_idx ON app.automation_runs (tenant_id, store_order_id)
  WHERE store_order_id IS NOT NULL;

-- What started a run stays fixed (0011), now including the store event; the order reference may only
-- be cleared (the order was deleted).
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
      NEW.started_by_membership_id, NEW.started_by_user_id, NEW.started_at, NEW.store_event)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.automation_id, OLD.version_id, OLD.conversation_id, OLD.contact_id,
      OLD.channel_account_id, OLD.mode, OLD.trigger_type, OLD.trigger_message_id,
      OLD.started_by_membership_id, OLD.started_by_user_id, OLD.started_at, OLD.store_event)
     OR (NEW.store_order_id IS DISTINCT FROM OLD.store_order_id AND NEW.store_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'what started an automation run is fixed' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.status NOT IN ('running', 'waiting') THEN
    IF (NEW.status, NEW.current_node_id, NEW.node_visit, NEW.waiting_for, NEW.wait_until,
        NEW.input_message_id, NEW.retries, NEW.failures, NEW.step_count, NEW.message_count, NEW.visits,
        NEW.next_step_at, NEW.ended_at, NEW.end_reason, NEW.end_detail, NEW.ended_by_membership_id)
       IS DISTINCT FROM
       (OLD.status, OLD.current_node_id, OLD.node_visit, OLD.waiting_for, OLD.wait_until,
        OLD.input_message_id, OLD.retries, OLD.failures, OLD.step_count, OLD.message_count, OLD.visits,
        OLD.next_step_at, OLD.ended_at, OLD.end_reason, OLD.end_detail, OLD.ended_by_membership_id)
       OR (NEW.variables IS DISTINCT FROM OLD.variables AND NEW.variables <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'an ended automation run cannot change' USING ERRCODE = 'W3403';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Order message rules ---------------------------------------------------------------------------------
-- action: send the rule's template (P4-06c) or start automation_id. Only the four order events can
-- start automations: the cash on delivery confirmation records its answer from its own template, and
-- the cart reminders' checks depend on the first reminder having been sent. Only a switched-off rule
-- can name an automation that was never published, and deleting that draft clears the reference (a
-- published automation is archived, never deleted).
ALTER TABLE app.commerce_store_message_rules
  ADD COLUMN action text NOT NULL DEFAULT 'template' CHECK (action IN ('template', 'automation')),
  ADD COLUMN automation_id uuid,
  DROP CONSTRAINT commerce_store_message_rules_enabled,
  ADD CONSTRAINT commerce_store_message_rules_enabled CHECK (NOT enabled
    OR (enabled_at IS NOT NULL AND channel_account_id IS NOT NULL
      AND ((action = 'template' AND template_id IS NOT NULL)
        OR (action = 'automation' AND automation_id IS NOT NULL)))),
  ADD CONSTRAINT commerce_store_message_rules_action CHECK (action = 'template'
    OR event IN ('order_placed', 'order_shipped', 'order_delivered', 'order_cancelled')),
  ADD CONSTRAINT commerce_store_message_rules_automation_fk FOREIGN KEY (tenant_id, automation_id)
    REFERENCES app.automations (tenant_id, id) ON DELETE SET NULL (automation_id);
CREATE INDEX commerce_store_message_rules_automation_idx
  ON app.commerce_store_message_rules (tenant_id, automation_id) WHERE automation_id IS NOT NULL;

-- Store messages --------------------------------------------------------------------------------------
-- started: the rule started an automation run (automation_run_id, cleared when retention deletes the
-- run); the run's messages are the run's own.
ALTER TABLE app.commerce_store_messages
  ADD COLUMN automation_run_id uuid,
  DROP CONSTRAINT commerce_store_messages_state_check,
  ADD CONSTRAINT commerce_store_messages_state_check CHECK (state IN
    ('pending', 'queued', 'skipped', 'started')),
  DROP CONSTRAINT commerce_store_messages_state_shape,
  ADD CONSTRAINT commerce_store_messages_state_shape CHECK (
    (state = 'skipped') = (skip_reason IS NOT NULL)
    AND (state = 'queued') = (message_id IS NOT NULL)
    AND (state NOT IN ('queued', 'started') OR contact_id IS NOT NULL)
    AND (automation_run_id IS NULL OR state = 'started')),
  ADD CONSTRAINT commerce_store_messages_run_fk FOREIGN KEY (tenant_id, automation_run_id)
    REFERENCES app.automation_runs (tenant_id, id) ON DELETE SET NULL (automation_run_id);
CREATE UNIQUE INDEX commerce_store_messages_run_uq
  ON app.commerce_store_messages (tenant_id, automation_run_id) WHERE automation_run_id IS NOT NULL;

-- Privileges ------------------------------------------------------------------------------------------
-- automation_runs keeps its table-level INSERT (0011), which covers the new columns; the references
-- are never updated by the application (only cleared by their foreign keys).
GRANT UPDATE (action, automation_id) ON app.commerce_store_message_rules TO w360_app;
GRANT UPDATE (automation_run_id) ON app.commerce_store_messages TO w360_app;
