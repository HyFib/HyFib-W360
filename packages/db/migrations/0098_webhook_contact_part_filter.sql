-- Contact part filters on webhook endpoints (P5-09, ADR-123).
--
-- Since 0096 a contact.updated names what its change changed (name, phone, email, tags, and
-- fields.<key>). An endpoint can now take the event only for some of those parts (emails alone,
-- say): null keeps every change, as before; a list holds 1 to 5 of name, phone, email, tags and
-- fields (a change of any custom field), and only while the endpoint takes contact.updated, so a
-- list never outlives its event. A company has at most 10 endpoints, so the table is small and the
-- check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN contact_parts text[],
  ADD CONSTRAINT webhook_endpoints_contact_parts CHECK (
    contact_parts IS NULL
    OR (cardinality(contact_parts) BETWEEN 1 AND 5
        AND contact_parts <@ ARRAY['name', 'phone', 'email', 'tags', 'fields']::text[]
        AND 'contact.updated' = ANY (event_types)));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (contact_parts) ON app.webhook_endpoints TO w360_app;

-- 0096's capture with the filter. A contact.updated delivery is created for each active endpoint
-- that takes the event and whose list is null or holds a part the change names (fields.<key> is
-- the part fields). A later change of the same contact in the same transaction adds what it
-- changed to the event (0096) and then creates a delivery for each endpoint that takes one of
-- those parts and has none of this event yet: the event is the calling transaction's own, so no
-- replay or other delivery of it can exist, and a savepoint that rolls back takes back the
-- deliveries it created with the parts. The event is still written when an endpoint takes
-- contact.created or contact.updated, even if none takes the parts of the first change. Everything
-- else as in 0096; same signature, so its owner and grants stay.
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
           AND (e.contact_parts IS NULL
                OR EXISTS (SELECT 1 FROM unnest(p_changes) AS c
                            WHERE split_part(c, '.', 1) = ANY (e.contact_parts)))
           AND NOT EXISTS (SELECT 1 FROM app.webhook_deliveries d
                            WHERE d.tenant_id = p_tenant AND d.event_id = v_event
                              AND d.endpoint_id = e.id);
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
   WHERE e.tenant_id = p_tenant AND e.state = 'active' AND p_type = ANY (e.event_types)
     AND (p_type <> 'contact.updated' OR e.contact_parts IS NULL
          OR EXISTS (SELECT 1 FROM unnest(p_changes) AS c
                      WHERE split_part(c, '.', 1) = ANY (e.contact_parts)));
END
$$;
