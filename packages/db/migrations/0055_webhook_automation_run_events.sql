-- 0055_webhook_automation_run_events: outgoing webhook events for automation runs (P5-09, ADR-078).
-- automation.run_started when a live run starts, whatever started it (a keyword, a new conversation,
-- any message, a store's order event, a call through the API), and automation.run_ended when it ends
-- (completed, handed off, taken over, stopped or failed). Members' test runs are not sent. Captured by
-- triggers like the events of 0025 and 0047; payloads are built when delivered.

-- Event types ------------------------------------------------------------------------------------------
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check CHECK (cardinality(event_types) BETWEEN 1 AND 11
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'contact.created', 'contact.updated',
                             'contact.erased', 'automation.run_started',
                             'automation.run_ended']::text[]);

-- NOT VALID: new rows are checked at once, and 0056 checks the rows already there without holding the
-- lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'contact.created', 'contact.updated', 'contact.erased',
    'automation.run_started', 'automation.run_ended', 'ping')) NOT VALID;

-- Automation runs --------------------------------------------------------------------------------------
-- The event keeps the run and its automation in `detail` (with the end reason once it ended), the
-- conversation and the contact, and the run's status when captured: running when it starts, the
-- ended status when it ends. What else the payload says is read when it is delivered.
CREATE FUNCTION app.webhook_capture_automation_run() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'automation.run_started', NULL,
      NEW.conversation_id, NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('runId', NEW.id, 'automationId', NEW.automation_id), NEW.started_at);
  ELSE
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'automation.run_ended', NULL,
      NEW.conversation_id, NEW.contact_id, NULL, NEW.status,
      jsonb_strip_nulls(jsonb_build_object('runId', NEW.id, 'automationId', NEW.automation_id,
        'endReason', NEW.end_reason)),
      NEW.ended_at);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER automation_runs_webhook_started AFTER INSERT ON app.automation_runs
  FOR EACH ROW WHEN (NEW.mode = 'live')
  EXECUTE FUNCTION app.webhook_capture_automation_run();
CREATE TRIGGER automation_runs_webhook_ended AFTER UPDATE OF status ON app.automation_runs
  FOR EACH ROW WHEN (NEW.mode = 'live' AND OLD.status IN ('running', 'waiting')
    AND NEW.status NOT IN ('running', 'waiting'))
  EXECUTE FUNCTION app.webhook_capture_automation_run();

-- Trigger functions run with the rights of whoever makes the change: the runtime role in the
-- company's scope, or w360_definer inside a definer function such as erasure.
REVOKE EXECUTE ON FUNCTION app.webhook_capture_automation_run() FROM PUBLIC;
