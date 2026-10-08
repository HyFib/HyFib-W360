-- Contact event filters by the contact's tags on webhook endpoints (P5-09, ADR-316).
--
-- An endpoint that takes contact.created or contact.updated receives every contact the company
-- adds or changes; it can narrow them by where contacts came from (0136) and by what changed (0098,
-- 0132), but not by tag. A receiver that keeps a segment of customers in step (a CRM list of `vip`
-- contacts, say) was sent every other contact too. It can now name the tags of the contacts whose
-- events it takes (contact_event_tags). Null keeps every contact, as before; a list holds 1 to 50
-- tags as contacts carry them (the same rule as 0183's contact_tags), and only while the endpoint
-- takes contact.created or contact.updated, so a list never outlives them. A change is sent when
-- the contact has one of the tags at one of its writes, or when it adds or removes one of them,
-- whatever the order of the writes in its transaction; a contact is added without tags, so its
-- contact.created is sent when its transaction tags it with one of them. contact.erased and
-- contact.merged are not narrowed. A company has at most 10 endpoints, so the table is small and
-- the check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN contact_event_tags text[],
  ADD CONSTRAINT webhook_endpoints_contact_event_tags CHECK (
    contact_event_tags IS NULL
    OR (cardinality(contact_event_tags) BETWEEN 1 AND 50
        AND array_ndims(contact_event_tags) = 1
        AND array_position(contact_event_tags, NULL) IS NULL
        AND strpos(array_to_string(contact_event_tags, ''), ',') = 0
        AND array_to_string(contact_event_tags, ',')
          ~ ('^[^, [:cntrl:]]([^,[:cntrl:]]{0,38}[^, [:cntrl:]])?'
             || '(,[^, [:cntrl:]]([^,[:cntrl:]]{0,38}[^, [:cntrl:]])?)*$')
        AND array_to_string(contact_event_tags, ',')
          = lower(array_to_string(contact_event_tags, ','))
        AND ('contact.created' = ANY (event_types) OR 'contact.updated' = ANY (event_types))));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (contact_event_tags) ON app.webhook_endpoints TO w360_app;

-- 0136's capture with the tag filter: a contact.created or contact.updated delivery is created only
-- for the active endpoints whose list is null or shares a tag with the contact, read from its tags
-- when an endpoint names tags. A later write of the same transaction matches the parts and fields
-- against everything the transaction changed so far, and the tags against the contact's and those
-- the transaction removed, so an endpoint naming parts and tags takes the change whatever the
-- order of the writes (a name changed before a tag is added, as the API writes them). The tag a
-- write adds or removes is matched by app.deliver_contact_webhook_tag below, which the tag trigger
-- calls once the tag is noted. Everything else as in 0136; same signature, so its owner and grants
-- stay.
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
  v_tags text[];
  v_changes text[];
  v_removed text[];
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
    -- The contact's tags now, read only when an active endpoint of the company that takes
    -- contact.created or contact.updated names tags.
    IF EXISTS (SELECT 1 FROM app.webhook_endpoints e
                WHERE e.tenant_id = p_tenant AND e.state = 'active'
                  AND e.contact_event_tags IS NOT NULL
                  AND ('contact.created' = ANY (e.event_types)
                       OR 'contact.updated' = ANY (e.event_types))) THEN
      SELECT coalesce(array_agg(t.tag), '{}'::text[]) INTO v_tags
        FROM app.contact_tags t
       WHERE t.tenant_id = p_tenant AND t.contact_id = p_contact;
    END IF;
    SELECT e.id, e.type INTO v_event, v_captured
      FROM app.webhook_events e
     WHERE e.tenant_id = p_tenant AND e.contact_id = p_contact
       AND e.captured_xact = pg_catalog.pg_current_xact_id()
     LIMIT 1;
    IF FOUND THEN
      IF v_captured = 'contact.updated' AND p_type = 'contact.updated' THEN
        PERFORM app.add_contact_webhook_changes(p_tenant, v_event, p_changes);
        -- Everything the transaction changed so far, and the tags it removed (0129 notes them).
        SELECT e.contact_changes, coalesce(e.tags_removed, '{}'::text[])
          INTO v_changes, v_removed
          FROM app.webhook_events e
         WHERE e.tenant_id = p_tenant AND e.id = v_event;
        INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id)
        SELECT gen_random_uuid(), p_tenant, e.id, v_event
          FROM app.webhook_endpoints e
         WHERE e.tenant_id = p_tenant AND e.state = 'active'
           AND 'contact.updated' = ANY (e.event_types)
           AND ((e.contact_parts IS NULL AND e.contact_field_keys IS NULL)
                OR EXISTS (SELECT 1 FROM unnest(v_changes) AS c
                            WHERE (e.contact_parts IS NULL
                                   OR split_part(c, '.', 1) = ANY (e.contact_parts))
                              AND (e.contact_field_keys IS NULL
                                   OR split_part(c, '.', 1) <> 'fields'
                                   OR split_part(c, '.', 2) = ANY (e.contact_field_keys))))
           AND (e.contact_event_tags IS NULL
                OR (v_tags || v_removed) && e.contact_event_tags)
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
          OR v_source = ANY (e.contact_sources))
     AND (p_type = 'contact.erased' OR e.contact_event_tags IS NULL
          OR v_tags && e.contact_event_tags);
END
$$;

-- A tag added to or removed from a contact, matched against the endpoints that name it, once the
-- tag trigger has captured the change and noted the tag (0129): the contact.updated of the calling
-- transaction goes to the active endpoints that take it, name the tag and take one of the changes
-- the transaction made so far (by their parts and fields, as the capture matches them); a
-- contact.created of the calling transaction (a tag given to a contact as it is added) goes to the
-- active endpoints that take it, name the tag and take its source (0136). Each endpoint gets each
-- event once. Nothing is read while no active endpoint of the company names tags. Run as the role
-- making the change, as the capture is: the definer role changes tags when it merges and erases
-- contacts, but adds no contact, so it never reads a source here (as in 0136's capture, a
-- contact.created is captured by the runtime role only).
CREATE FUNCTION app.deliver_contact_webhook_tag(p_tenant uuid, p_contact uuid, p_tag text)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_event uuid;
  v_captured text;
  v_changes text[];
  v_source text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND p_tag = ANY (e.contact_event_tags)) THEN
    RETURN;
  END IF;
  SELECT e.id, e.type, e.contact_changes INTO v_event, v_captured, v_changes
    FROM app.webhook_events e
   WHERE e.tenant_id = p_tenant AND e.contact_id = p_contact
     AND e.captured_xact = pg_catalog.pg_current_xact_id()
     AND e.type IN ('contact.created', 'contact.updated')
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_captured = 'contact.created' THEN
    SELECT c.source INTO v_source FROM app.contacts c
     WHERE c.tenant_id = p_tenant AND c.id = p_contact;
  END IF;
  INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id)
  SELECT gen_random_uuid(), p_tenant, e.id, v_event
    FROM app.webhook_endpoints e
   WHERE e.tenant_id = p_tenant AND e.state = 'active'
     AND v_captured = ANY (e.event_types)
     AND p_tag = ANY (e.contact_event_tags)
     AND (v_captured <> 'contact.updated'
          OR (e.contact_parts IS NULL AND e.contact_field_keys IS NULL)
          OR EXISTS (SELECT 1 FROM unnest(v_changes) AS c
                      WHERE (e.contact_parts IS NULL
                             OR split_part(c, '.', 1) = ANY (e.contact_parts))
                        AND (e.contact_field_keys IS NULL OR split_part(c, '.', 1) <> 'fields'
                             OR split_part(c, '.', 2) = ANY (e.contact_field_keys))))
     AND (v_captured <> 'contact.created' OR e.contact_sources IS NULL
          OR v_source = ANY (e.contact_sources))
     AND NOT EXISTS (SELECT 1 FROM app.webhook_deliveries d
                      WHERE d.tenant_id = p_tenant AND d.event_id = v_event
                        AND d.endpoint_id = e.id);
END
$$;
REVOKE EXECUTE ON FUNCTION app.deliver_contact_webhook_tag(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.deliver_contact_webhook_tag(uuid, uuid, text)
  TO w360_app, w360_definer;

-- 0129's tag trigger, which now matches the tag once it is noted. Same signature, so the trigger,
-- owner and revoked grants stay.
CREATE OR REPLACE FUNCTION app.webhook_capture_contact_tag() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app.capture_contact_webhook_event(OLD.tenant_id, OLD.contact_id, 'contact.updated',
      ARRAY['tags']);
    PERFORM app.note_contact_webhook_tag(OLD.tenant_id, OLD.contact_id, OLD.tag, false);
    PERFORM app.deliver_contact_webhook_tag(OLD.tenant_id, OLD.contact_id, OLD.tag);
  ELSE
    PERFORM app.capture_contact_webhook_event(NEW.tenant_id, NEW.contact_id, 'contact.updated',
      ARRAY['tags']);
    PERFORM app.note_contact_webhook_tag(NEW.tenant_id, NEW.contact_id, NEW.tag, true);
    PERFORM app.deliver_contact_webhook_tag(NEW.tenant_id, NEW.contact_id, NEW.tag);
  END IF;
  RETURN NULL;
END
$$;
