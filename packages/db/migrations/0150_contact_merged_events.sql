-- 0150_contact_merged_events: integrations hear of a merge (P5-09, ADR-225). A merge (0147,
-- ADR-224) moves everything of the merged contact to the kept one and deletes the merged contact,
-- so integrations that keep copies of contacts had no way to learn that its id is gone. An
-- endpoint can now take contact.merged: one event per merge, naming the merged contact's id and
-- describing the contact it was merged into as it is when the event is delivered. The merge also
-- records a change of the kept contact for GET /contact-changes, which lists the contacts merged
-- into each contact it reads, so a reader following the feed learns of the merge even when the
-- merge changed nothing else the API describes of the kept contact.

-- Event types ------------------------------------------------------------------------------------
-- A company has at most 10 endpoints, so the endpoints' check is validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check CHECK (cardinality(event_types) BETWEEN 1 AND 16
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'conversation.team_changed',
                             'contact.created', 'contact.updated', 'contact.erased',
                             'contact.merged', 'automation.run_started', 'automation.run_ended',
                             'order.received', 'order.status_changed',
                             'campaign.status_changed']::text[]);

-- NOT VALID: new rows are checked at once, and 0151 checks the rows already there without holding
-- the lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'conversation.team_changed', 'contact.created',
    'contact.updated', 'contact.erased', 'contact.merged', 'automation.run_started',
    'automation.run_ended', 'order.received', 'order.status_changed', 'campaign.status_changed',
    'ping')) NOT VALID;

-- Capture ----------------------------------------------------------------------------------------
-- app.merge_contacts writes one app.contact_merges row per merge, after it deleted the merged
-- contact, and nothing else writes one; earlier merges into the merged contact are re-pointed by
-- an UPDATE, which is not a merge. The trigger runs with the merge's rights (the definer role,
-- which captures webhook events and contact changes as erasure does, 0047 and 0091).
--
-- The change of the kept contact is recorded once per transaction, as every change is. The event
-- goes through app.capture_webhook_event (0138): no endpoint filter narrows contact.merged, so it
-- is written only when an active endpoint of the company takes it, and delivered to each that
-- does. It names the kept contact, and the merged one in its detail; like the events of 0025 it
-- has no captured_xact, so it never takes the place of the contact.updated the merge captured for
-- the kept contact (0136 folds a contact's changes into the first contact event its transaction
-- captured). It is stamped with the time it is captured, after the changes the merge made.
CREATE FUNCTION app.contact_merges_capture() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM app.capture_contact_change(NEW.tenant_id, NEW.kept_contact_id);
  PERFORM app.capture_webhook_event(NEW.tenant_id, 'contact.merged', NULL, NULL,
    NEW.kept_contact_id, NULL, NULL,
    jsonb_build_object('mergedContactId', NEW.merged_contact_id), clock_timestamp());
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.contact_merges_capture() FROM PUBLIC;

CREATE TRIGGER contact_merges_capture AFTER INSERT ON app.contact_merges
  FOR EACH ROW EXECUTE FUNCTION app.contact_merges_capture();
