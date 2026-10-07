-- 0177_webhook_task_events: outgoing webhook events for CRM tasks (P5-09, P4-04, ADR-261).
-- task.created when a task is added, and task.status_changed when a task is completed, cancelled or
-- reopened: by a member, an automation (it adds tasks) or an API key alike. Captured by triggers
-- like the deal events of 0171; payloads are built when delivered, and erasing a contact deletes
-- its tasks, so their events then send nothing.

-- Event types ------------------------------------------------------------------------------------
-- A company has at most 10 endpoints, so the endpoints' check is validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check
    CHECK (cardinality(event_types) BETWEEN 1 AND 21
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'conversation.team_changed',
                             'contact.created', 'contact.updated', 'contact.erased',
                             'contact.merged', 'automation.run_started', 'automation.run_ended',
                             'order.received', 'order.status_changed',
                             'campaign.status_changed', 'deal.created', 'deal.stage_changed',
                             'deal.status_changed', 'task.created',
                             'task.status_changed']::text[]);

-- NOT VALID: new rows are checked at once, and 0178 checks the rows already there without holding
-- the lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'conversation.team_changed', 'contact.created',
    'contact.updated', 'contact.erased', 'contact.merged', 'automation.run_started',
    'automation.run_ended', 'order.received', 'order.status_changed', 'campaign.status_changed',
    'deal.created', 'deal.stage_changed', 'deal.status_changed', 'task.created',
    'task.status_changed', 'ping')) NOT VALID;

-- Tasks ------------------------------------------------------------------------------------------
-- The event keeps the task, and for a change the status before it, in `detail`, with the task's
-- contact (none for a task about nobody) and the status it reports. The rest is read when the event
-- is delivered. No endpoint filter narrows these events, so app.capture_webhook_event (0138) writes
-- one only when an active endpoint of the company takes it. Each is stamped with the time it is
-- captured, as the deal events are (0171): the task's row is locked while this runs, so a later
-- change is stamped later.
CREATE FUNCTION app.webhook_capture_task() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'task.created', NULL, NULL, NEW.contact_id,
      NULL, NEW.status, jsonb_build_object('taskId', NEW.id), clock_timestamp());
  ELSE
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'task.status_changed', NULL, NULL,
      NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('taskId', NEW.id, 'previousStatus', OLD.status), clock_timestamp());
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER crm_tasks_webhook_created AFTER INSERT ON app.crm_tasks
  FOR EACH ROW EXECUTE FUNCTION app.webhook_capture_task();
-- Edits, reminders, a merge moving a task to another contact and erasure deleting it do not change
-- its status, so none of them sends anything here.
CREATE TRIGGER crm_tasks_webhook_status AFTER UPDATE OF status ON app.crm_tasks
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION app.webhook_capture_task();

-- Trigger functions run with the rights of whoever makes the change: the runtime role in the
-- company's scope (members, automation runs and API keys), the only role that adds tasks or
-- changes their status.
REVOKE EXECUTE ON FUNCTION app.webhook_capture_task() FROM PUBLIC;
