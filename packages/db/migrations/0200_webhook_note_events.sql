-- 0200_webhook_note_events: an outgoing webhook event when a CRM note is added (P5-09, P4-04,
-- ADR-280). note.created is captured when a member adds a note on the contact or deal page, or an
-- API key through POST /notes (ADR-268): the only writers of notes, both as the runtime role in the
-- company's scope. Notes are never changed; a merge moves a note to the contact kept and erasure
-- deletes an erased contact's notes, and neither adds one, so neither sends anything. The payload
-- gives the note as it is when delivered without its text, which GET /notes/{id} reads with
-- `notes.read` (ADR-279). No endpoint filter narrows the event, so app.capture_webhook_event is
-- unchanged.

-- Event types ------------------------------------------------------------------------------------

-- A company has at most 10 endpoints, so the endpoints' check is validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check
    CHECK (cardinality(event_types) BETWEEN 1 AND 26
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'conversation.team_changed',
                             'contact.created', 'contact.updated', 'contact.erased',
                             'contact.merged', 'automation.run_started', 'automation.run_ended',
                             'order.received', 'order.status_changed',
                             'campaign.status_changed', 'deal.created', 'deal.updated',
                             'deal.stage_changed', 'deal.owner_changed', 'deal.status_changed',
                             'task.created', 'task.updated', 'task.assignee_changed',
                             'task.status_changed', 'note.created']::text[]);

-- NOT VALID: new rows are checked at once, and 0201 checks the rows already there without holding
-- the lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'conversation.team_changed', 'contact.created',
    'contact.updated', 'contact.erased', 'contact.merged', 'automation.run_started',
    'automation.run_ended', 'order.received', 'order.status_changed', 'campaign.status_changed',
    'deal.created', 'deal.updated', 'deal.stage_changed', 'deal.owner_changed',
    'deal.status_changed', 'task.created', 'task.updated', 'task.assignee_changed',
    'task.status_changed', 'note.created', 'ping')) NOT VALID;

-- Notes ------------------------------------------------------------------------------------------

-- The event keeps the note in `detail`, with its contact; the rest is read when the event is
-- delivered. app.capture_webhook_event (0194) writes one only when an active endpoint of the
-- company takes the type. It is stamped with the time it is captured, as the deal and task events
-- are (0171, 0177).
CREATE FUNCTION app.webhook_capture_note() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM app.capture_webhook_event(NEW.tenant_id, 'note.created', NULL, NULL, NEW.contact_id,
    NULL, NULL, jsonb_build_object('noteId', NEW.id), clock_timestamp());
  RETURN NULL;
END
$$;
CREATE TRIGGER crm_activities_webhook_note AFTER INSERT ON app.crm_activities
  FOR EACH ROW WHEN (NEW.kind = 'note') EXECUTE FUNCTION app.webhook_capture_note();

-- Trigger functions run with the rights of whoever makes the change: the runtime role in the
-- company's scope (members and API keys), the only role that adds notes.
REVOKE EXECUTE ON FUNCTION app.webhook_capture_note() FROM PUBLIC;
