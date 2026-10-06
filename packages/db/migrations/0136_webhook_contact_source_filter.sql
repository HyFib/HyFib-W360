-- Contact source filters on webhook endpoints (P5-09, ADR-190).
--
-- An endpoint that takes contact.created receives every contact the company adds, wherever it came
-- from. A receiver that adds contacts itself through the API is sent its own contacts back, and one
-- that follows people who wrote on WhatsApp is sent every import and every store's customers. It
-- can now choose where the contacts it hears of came from: null keeps every contact, as before; a
-- list holds 1 to 5 of whatsapp, manual, import, api and store (the source the payload reports as
-- contact.source), and only while the endpoint takes contact.created, so a list never outlives its
-- event. contact.updated and contact.erased are not narrowed. A contact's source is set when it is
-- added and never changes. A company has at most 10 endpoints, so the table is small and the check
-- is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN contact_sources text[],
  ADD CONSTRAINT webhook_endpoints_contact_sources CHECK (
    contact_sources IS NULL
    OR (cardinality(contact_sources) BETWEEN 1 AND 5
        AND array_ndims(contact_sources) = 1
        AND array_position(contact_sources, NULL) IS NULL
        AND contact_sources <@ ARRAY['whatsapp', 'manual', 'import', 'api', 'store']::text[]
        AND 'contact.created' = ANY (event_types)));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (contact_sources) ON app.webhook_endpoints TO w360_app;

-- 0132's capture with the source filter: a contact.created delivery is created only for the active
-- endpoints that take the event and whose list is null or holds the contact's source, read from
-- the contact when an endpoint names sources. The event is still written when an endpoint takes
-- contact.created or contact.updated, so changes later in the same transaction fold into it as
-- before. Everything else as in 0132; same signature, so its owner and grants stay.
CREATE OR REPLACE FUNCTION app.capture_contact_webhook_event(p_tenant uuid, p_contact uuid,
  p_type text, p_changes text[])
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_event uuid;
  v_captured text;
  v_source text;
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
  -- Where an added contact came from, read only when an active endpoint of the company that takes
  -- contact.created names sources (the row itself: the trigger runs after the insert).
  IF p_type = 'contact.created'
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND e.contact_sources IS NOT NULL
                    AND 'contact.created' = ANY (e.event_types)) THEN
    SELECT c.source INTO v_source FROM app.contacts c
     WHERE c.tenant_id = p_tenant AND c.id = p_contact;
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
                             OR split_part(c, '.', 2) = ANY (e.contact_field_keys))))
     AND (p_type <> 'contact.created' OR e.contact_sources IS NULL
          OR v_source = ANY (e.contact_sources));
END
$$;
