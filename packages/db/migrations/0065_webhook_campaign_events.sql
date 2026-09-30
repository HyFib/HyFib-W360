-- 0065_webhook_campaign_events: outgoing webhook events for campaigns (P5-09, ADR-087).
-- campaign.status_changed whenever a campaign's status changes, whoever changes it: a member
-- submitting it for approval, withdrawing it, rejecting, approving, pausing, resuming or cancelling
-- it, or the runner starting, pausing (a cap, the template, the number, the member whose authority it
-- uses) or completing it. Captured by a trigger like the events of 0025, 0047, 0055 and 0063;
-- payloads are built when delivered.

-- Event types ------------------------------------------------------------------------------------------
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check CHECK (cardinality(event_types) BETWEEN 1 AND 14
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'contact.created', 'contact.updated',
                             'contact.erased', 'automation.run_started', 'automation.run_ended',
                             'order.received', 'order.status_changed',
                             'campaign.status_changed']::text[]);

-- NOT VALID: new rows are checked at once, and 0066 checks the rows already there without holding the
-- lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'contact.created', 'contact.updated', 'contact.erased',
    'automation.run_started', 'automation.run_ended', 'order.received', 'order.status_changed',
    'campaign.status_changed', 'ping')) NOT VALID;

-- Campaigns --------------------------------------------------------------------------------------------
-- The event keeps the campaign in `detail`, with the status before it and, for a pause or a
-- completion, why, and the status it reports. The name, template, number, times and counts are read
-- when the event is delivered. It is stamped with the time it is captured, not the transaction's:
-- the runner can start a campaign and pause it in one transaction, and the two must stay in order.
CREATE FUNCTION app.webhook_capture_campaign() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM app.capture_webhook_event(NEW.tenant_id, 'campaign.status_changed', NULL, NULL, NULL,
    NULL, NEW.status,
    jsonb_build_object('campaignId', NEW.id, 'previousStatus', OLD.status,
      'pauseReason', CASE WHEN NEW.status = 'paused' THEN NEW.pause_reason END,
      'completionReason', CASE WHEN NEW.status = 'completed' THEN NEW.completion_reason END),
    clock_timestamp());
  RETURN NULL;
END
$$;
-- Edits of a draft and the runner's progress change other columns only, so they send nothing.
CREATE TRIGGER campaigns_webhook_status AFTER UPDATE OF status ON app.campaigns
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION app.webhook_capture_campaign();

-- Trigger functions run with the rights of whoever makes the change: the runtime role in the
-- company's scope, the only role that changes a campaign's status.
REVOKE EXECUTE ON FUNCTION app.webhook_capture_campaign() FROM PUBLIC;
