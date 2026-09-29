-- 0047_webhook_conversation_contact_events: outgoing webhook events for conversations and contacts
-- (P5-09, ADR-074). Captured by triggers like the events of 0025: a conversation's status and whether
-- a member is assigned, and contacts added, changed and erased. A transaction captures one
-- contact.created or contact.updated per contact, and erasing drops those of its own transaction.

-- Event types ------------------------------------------------------------------------------------------
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check CHECK (cardinality(event_types) BETWEEN 1 AND 9
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'contact.created', 'contact.updated',
                             'contact.erased']::text[]);

-- NOT VALID: new rows are checked at once, and 0049 checks the rows already there without holding the
-- lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'contact.created', 'contact.updated', 'contact.erased',
    'ping')) NOT VALID,
  -- The top-level transaction that captured a contact event (the same inside savepoints), so one
  -- transaction captures one event per contact. NULL for the other events. 0048 indexes it.
  ADD COLUMN captured_xact xid8;

-- Conversations ----------------------------------------------------------------------------------------
-- conversation.status_changed (open, pending, resolved, whoever changed it) and
-- conversation.assignment_changed (a member assigned where none was, or none any more; a move between
-- members is not sent, as webhooks and the API name no members).
CREATE FUNCTION app.webhook_capture_conversation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'conversation.status_changed', NULL, NEW.id,
      NEW.contact_id, NULL, NEW.status, jsonb_build_object('previousStatus', OLD.status), NULL);
  END IF;
  IF (NEW.assigned_membership_id IS NULL) <> (OLD.assigned_membership_id IS NULL) THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'conversation.assignment_changed', NULL, NEW.id,
      NEW.contact_id, NULL, NULL,
      jsonb_build_object('assigned', NEW.assigned_membership_id IS NOT NULL), NULL);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER conversations_webhook AFTER UPDATE OF status, assigned_membership_id
  ON app.conversations
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status
    OR (NEW.assigned_membership_id IS NULL) <> (OLD.assigned_membership_id IS NULL))
  EXECUTE FUNCTION app.webhook_capture_conversation();

-- Contacts ---------------------------------------------------------------------------------------------
-- contact.created and contact.updated are captured when an active endpoint takes either, so a contact
-- added in this transaction is known as added (one created event, delivered to the endpoints that
-- take it) and later changes in the same transaction add nothing. contact.erased first deletes what
-- this transaction captured for the contact (erasure removes the tags before it marks the contact),
-- with its deliveries, so an erasure sends only that. Payloads are built when delivered.
CREATE FUNCTION app.capture_contact_webhook_event(p_tenant uuid, p_contact uuid, p_type text)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_event uuid;
BEGIN
  IF p_type = 'contact.erased' THEN
    DELETE FROM app.webhook_events e
     WHERE e.tenant_id = p_tenant AND e.contact_id = p_contact
       AND e.captured_xact = pg_catalog.pg_current_xact_id()
       AND e.type IN ('contact.created', 'contact.updated');
    IF NOT app.webhook_subscribed(p_tenant, p_type) THEN
      RETURN;
    END IF;
  ELSIF p_type IN ('contact.created', 'contact.updated') THEN
    IF NOT (app.webhook_subscribed(p_tenant, 'contact.created')
            OR app.webhook_subscribed(p_tenant, 'contact.updated')) THEN
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM app.webhook_events e
                WHERE e.tenant_id = p_tenant AND e.contact_id = p_contact
                  AND e.captured_xact = pg_catalog.pg_current_xact_id()) THEN
      RETURN;
    END IF;
  ELSE
    RAISE EXCEPTION 'not a contact event: %', p_type;
  END IF;
  v_event := gen_random_uuid();
  INSERT INTO app.webhook_events (id, tenant_id, type, contact_id, captured_xact)
  VALUES (v_event, p_tenant, p_type, p_contact, pg_catalog.pg_current_xact_id());
  INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id)
  SELECT gen_random_uuid(), p_tenant, e.id, v_event
    FROM app.webhook_endpoints e
   WHERE e.tenant_id = p_tenant AND e.state = 'active' AND p_type = ANY (e.event_types);
END
$$;

-- Added; its name, number or email changed while not erased; erased.
CREATE FUNCTION app.webhook_capture_contact() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_contact_webhook_event(NEW.tenant_id, NEW.id, 'contact.created');
  ELSIF NEW.erased_at IS NOT NULL THEN
    PERFORM app.capture_contact_webhook_event(NEW.tenant_id, NEW.id, 'contact.erased');
  ELSE
    PERFORM app.capture_contact_webhook_event(NEW.tenant_id, NEW.id, 'contact.updated');
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER contacts_webhook_created AFTER INSERT ON app.contacts
  FOR EACH ROW WHEN (NEW.erased_at IS NULL)
  EXECUTE FUNCTION app.webhook_capture_contact();
CREATE TRIGGER contacts_webhook_changed AFTER UPDATE OF display_name, phone_e164, email, erased_at
  ON app.contacts
  FOR EACH ROW WHEN ((OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL)
    OR (NEW.erased_at IS NULL AND (NEW.display_name IS DISTINCT FROM OLD.display_name
      OR NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164 OR NEW.email IS DISTINCT FROM OLD.email)))
  EXECUTE FUNCTION app.webhook_capture_contact();

-- A tag added or removed changes the contact.
CREATE FUNCTION app.webhook_capture_contact_tag() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app.capture_contact_webhook_event(OLD.tenant_id, OLD.contact_id, 'contact.updated');
  ELSE
    PERFORM app.capture_contact_webhook_event(NEW.tenant_id, NEW.contact_id, 'contact.updated');
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER contact_tags_webhook AFTER INSERT OR DELETE ON app.contact_tags
  FOR EACH ROW EXECUTE FUNCTION app.webhook_capture_contact_tag();

-- Trigger functions run with the rights of whoever makes the change: the runtime role in the
-- company's scope, or w360_definer inside a definer function such as erasure.
REVOKE EXECUTE ON FUNCTION app.capture_contact_webhook_event(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.capture_contact_webhook_event(uuid, uuid, text) TO w360_app, w360_definer;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_conversation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_contact() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_contact_tag() FROM PUBLIC;
