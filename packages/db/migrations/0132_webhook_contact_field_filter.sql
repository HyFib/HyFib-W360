-- Field filters for contact changes on webhook endpoints (P5-09, ADR-184).
--
-- An endpoint can take contact.updated only for some parts of a contact (0098), `fields` standing
-- for a change of any custom field, and ADR-123 left choosing fields one by one unbuilt: a receiver
-- that keeps a few fields in step (a loyalty tier, a city) was sent every field's change. It can
-- now name the fields: null keeps every field, as before; a list holds 1 to 50 field keys (a
-- company has at most 50 fields; GET /contact-fields lists their keys), and only while the endpoint
-- takes contact.updated and its parts take field changes (every part, or `fields` among them), so a
-- list never outlives what it narrows. A change of a custom field then counts only when its key is
-- listed; changes of the other parts are narrowed by the parts alone. The services accept only keys
-- of the company's fields when a list adds them; a field deleted later stays on the list, and a
-- field added later with the same key (keys never change) matches it again. A company has at most
-- 10 endpoints, so the table is small and the check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN contact_field_keys text[],
  ADD CONSTRAINT webhook_endpoints_contact_field_keys CHECK (
    contact_field_keys IS NULL
    OR (cardinality(contact_field_keys) BETWEEN 1 AND 50
        AND array_ndims(contact_field_keys) = 1
        AND array_position(contact_field_keys, NULL) IS NULL
        AND array_to_string(contact_field_keys, ',')
          ~ '^[a-z][a-z0-9_]{0,39}(,[a-z][a-z0-9_]{0,39})*$'
        AND 'contact.updated' = ANY (event_types)
        AND (contact_parts IS NULL OR 'fields' = ANY (contact_parts))));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (contact_field_keys) ON app.webhook_endpoints TO w360_app;

-- 0129's capture with the field filter: a contact.updated delivery is created for each active
-- endpoint that takes the event and whose parts (0098) and fields allow one of the parts the change
-- names, a field change (`fields.<key>`) counting only when its key is listed, and a later change
-- of the contact in the same transaction queues the endpoints it newly concerns, as before. The
-- event is still written when an endpoint takes contact.created or contact.updated. Everything else
-- as in 0129; same signature, so its owner and grants stay.
CREATE OR REPLACE FUNCTION app.capture_contact_webhook_event(p_tenant uuid, p_contact uuid,
  p_type text, p_changes text[])
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
    UPDATE app.webhook_events e SET tags_added = NULL, tags_removed = NULL
     WHERE e.tenant_id = p_tenant AND e.contact_id = p_contact AND e.captured_xact IS NOT NULL
       AND e.tags_added IS NOT NULL;
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
        INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id)
        SELECT gen_random_uuid(), p_tenant, e.id, v_event
          FROM app.webhook_endpoints e
         WHERE e.tenant_id = p_tenant AND e.state = 'active'
           AND 'contact.updated' = ANY (e.event_types)
           AND ((e.contact_parts IS NULL AND e.contact_field_keys IS NULL)
                OR EXISTS (SELECT 1 FROM unnest(p_changes) AS c
                            WHERE (e.contact_parts IS NULL
                                   OR split_part(c, '.', 1) = ANY (e.contact_parts))
                              AND (e.contact_field_keys IS NULL
                                   OR split_part(c, '.', 1) <> 'fields'
                                   OR split_part(c, '.', 2) = ANY (e.contact_field_keys))))
           AND NOT EXISTS (SELECT 1 FROM app.webhook_deliveries d
                            WHERE d.tenant_id = p_tenant AND d.event_id = v_event
                              AND d.endpoint_id = e.id);
      END IF;
      RETURN;
    END IF;
  END IF;
  v_event := gen_random_uuid();
  INSERT INTO app.webhook_events (id, tenant_id, type, contact_id, captured_xact, contact_changes,
    tags_added, tags_removed)
  VALUES (v_event, p_tenant, p_type, p_contact, pg_catalog.pg_current_xact_id(),
          (SELECT array_agg(DISTINCT c ORDER BY c) FROM unnest(p_changes) AS c),
          CASE WHEN p_type = 'contact.updated' THEN '{}'::text[] END,
          CASE WHEN p_type = 'contact.updated' THEN '{}'::text[] END);
  INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id)
  SELECT gen_random_uuid(), p_tenant, e.id, v_event
    FROM app.webhook_endpoints e
   WHERE e.tenant_id = p_tenant AND e.state = 'active' AND p_type = ANY (e.event_types)
     AND (p_type <> 'contact.updated'
          OR (e.contact_parts IS NULL AND e.contact_field_keys IS NULL)
          OR EXISTS (SELECT 1 FROM unnest(p_changes) AS c
                      WHERE (e.contact_parts IS NULL
                             OR split_part(c, '.', 1) = ANY (e.contact_parts))
                        AND (e.contact_field_keys IS NULL OR split_part(c, '.', 1) <> 'fields'
                             OR split_part(c, '.', 2) = ANY (e.contact_field_keys))));
END
$$;
