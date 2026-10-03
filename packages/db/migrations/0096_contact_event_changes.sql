-- Which parts of a contact a contact.updated event changed (P5-09, ADR-121).
--
-- contact.updated is captured once per contact and transaction (0047, 0090), and the contact is sent
-- as it is when the event is delivered, so a receiver could not tell a new email from a new tag
-- without a copy to compare. The event now keeps the parts its transaction changed, in the API
-- contact's names: name, phone, email, tags, and fields.<key> for each custom field whose value
-- changed (ADR-112). Names only, never values, so events still hold no personal data.
--
-- NULL for every other type, and for contact.updated events captured before this migration (the
-- payload then says it does not know). NOT VALID: new rows are checked at once, and 0097 checks the
-- rows already there without holding the lock this change takes (every capture writes to this
-- table).
ALTER TABLE app.webhook_events
  ADD COLUMN contact_changes text[],
  ADD CONSTRAINT webhook_events_contact_changes_check CHECK (
    contact_changes IS NULL
    OR (type = 'contact.updated'
        AND array_ndims(contact_changes) = 1
        AND array_position(contact_changes, NULL) IS NULL
        AND array_to_string(contact_changes, ',')
          ~ '^(name|phone|email|tags|fields\.[a-z][a-z0-9_]{0,39})(,(name|phone|email|tags|fields\.[a-z][a-z0-9_]{0,39}))*$'))
    NOT VALID;

-- A later change of the same contact in the same transaction adds what it changed to the event
-- captured first, sorted and once each. Only an event captured by the calling transaction itself
-- (its captured_xact), which no delivery can have read yet, so neither role can change an event
-- once it is history: the runtime role still only inserts and reads events (0025), and the
-- definer role, which erasure runs as, updates this one column.
CREATE FUNCTION app.add_contact_webhook_changes(p_tenant uuid, p_event uuid, p_changes text[])
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  UPDATE app.webhook_events e
     SET contact_changes = (SELECT array_agg(DISTINCT c ORDER BY c)
                              FROM unnest(e.contact_changes || p_changes) AS c)
   WHERE e.tenant_id = p_tenant AND e.id = p_event AND e.type = 'contact.updated'
     AND e.captured_xact = pg_catalog.pg_current_xact_id();
$$;
REVOKE EXECUTE ON FUNCTION app.add_contact_webhook_changes(uuid, uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_contact_webhook_changes(uuid, uuid, text[])
  TO w360_app, w360_definer;
GRANT UPDATE (contact_changes) ON app.webhook_events TO w360_definer;
ALTER FUNCTION app.add_contact_webhook_changes(uuid, uuid, text[]) OWNER TO w360_definer;

-- 0047's capture with what changed: contact.updated must name at least one part, the other types
-- none. Everything else as before: one created or updated event per contact and transaction, a
-- contact added in the transaction stays added, and erasing drops the transaction's created and
-- updated events with their deliveries. Still runs as the role making the change.
CREATE FUNCTION app.capture_contact_webhook_event(p_tenant uuid, p_contact uuid, p_type text,
  p_changes text[])
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_event uuid;
  v_captured text;
BEGIN
  IF p_type NOT IN ('contact.created', 'contact.updated', 'contact.erased') THEN
    RAISE EXCEPTION 'not a contact event: %', p_type;
  END IF;
  IF (p_type = 'contact.updated') <> (coalesce(cardinality(p_changes), 0) > 0) THEN
    RAISE EXCEPTION 'only contact.updated names what changed, and it always does';
  END IF;
  IF p_type = 'contact.erased' THEN
    DELETE FROM app.webhook_events e
     WHERE e.tenant_id = p_tenant AND e.contact_id = p_contact
       AND e.captured_xact = pg_catalog.pg_current_xact_id()
       AND e.type IN ('contact.created', 'contact.updated');
    IF NOT app.webhook_subscribed(p_tenant, p_type) THEN
      RETURN;
    END IF;
  ELSE
    IF NOT (app.webhook_subscribed(p_tenant, 'contact.created')
            OR app.webhook_subscribed(p_tenant, 'contact.updated')) THEN
      RETURN;
    END IF;
    SELECT e.id, e.type INTO v_event, v_captured
      FROM app.webhook_events e
     WHERE e.tenant_id = p_tenant AND e.contact_id = p_contact
       AND e.captured_xact = pg_catalog.pg_current_xact_id()
     LIMIT 1;
    IF FOUND THEN
      IF v_captured = 'contact.updated' AND p_type = 'contact.updated' THEN
        PERFORM app.add_contact_webhook_changes(p_tenant, v_event, p_changes);
      END IF;
      RETURN;
    END IF;
  END IF;
  v_event := gen_random_uuid();
  INSERT INTO app.webhook_events (id, tenant_id, type, contact_id, captured_xact, contact_changes)
  VALUES (v_event, p_tenant, p_type, p_contact, pg_catalog.pg_current_xact_id(),
          (SELECT array_agg(DISTINCT c ORDER BY c) FROM unnest(p_changes) AS c));
  INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id)
  SELECT gen_random_uuid(), p_tenant, e.id, v_event
    FROM app.webhook_endpoints e
   WHERE e.tenant_id = p_tenant AND e.state = 'active' AND p_type = ANY (e.event_types);
END
$$;
REVOKE EXECUTE ON FUNCTION app.capture_contact_webhook_event(uuid, uuid, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.capture_contact_webhook_event(uuid, uuid, text, text[])
  TO w360_app, w360_definer;

-- The triggers of 0047 and 0090 say what changed. Same signatures, so the triggers, owners and
-- revoked grants stay.
CREATE OR REPLACE FUNCTION app.webhook_capture_contact() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_contact_webhook_event(NEW.tenant_id, NEW.id, 'contact.created', NULL);
  ELSIF NEW.erased_at IS NOT NULL THEN
    PERFORM app.capture_contact_webhook_event(NEW.tenant_id, NEW.id, 'contact.erased', NULL);
  ELSE
    PERFORM app.capture_contact_webhook_event(NEW.tenant_id, NEW.id, 'contact.updated',
      array_remove(ARRAY[
        CASE WHEN NEW.display_name IS DISTINCT FROM OLD.display_name THEN 'name' END,
        CASE WHEN NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164 THEN 'phone' END,
        CASE WHEN NEW.email IS DISTINCT FROM OLD.email THEN 'email' END]::text[], NULL));
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION app.webhook_capture_contact_tag() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app.capture_contact_webhook_event(OLD.tenant_id, OLD.contact_id, 'contact.updated',
      ARRAY['tags']);
  ELSE
    PERFORM app.capture_contact_webhook_event(NEW.tenant_id, NEW.contact_id, 'contact.updated',
      ARRAY['tags']);
  END IF;
  RETURN NULL;
END
$$;

-- Each of the company's fields whose value differs; as before, a field's deletion removes the row
-- before the values and so captures nothing, and a rename changes no value.
CREATE OR REPLACE FUNCTION app.webhook_capture_contact_fields() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_changes text[];
BEGIN
  SELECT array_agg('fields.' || f.key ORDER BY f.key) INTO v_changes
    FROM app.contact_fields f
   WHERE f.tenant_id = NEW.tenant_id
     AND (NEW.attributes -> f.key) IS DISTINCT FROM (OLD.attributes -> f.key);
  IF v_changes IS NOT NULL THEN
    PERFORM app.capture_contact_webhook_event(NEW.tenant_id, NEW.id, 'contact.updated', v_changes);
  END IF;
  RETURN NULL;
END
$$;

-- Nothing calls the old capture any more.
DROP FUNCTION app.capture_contact_webhook_event(uuid, uuid, text);
