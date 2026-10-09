-- Contact event filters by the contact's custom field values on webhook endpoints (P5-09, ADR-332).
--
-- An endpoint that takes contact.created or contact.updated can narrow them by where contacts came
-- from (0136), what changed (0098, 0132) and the contact's tags (0239), but not by a custom field's
-- value. A receiver that keeps a segment of customers in step by a field (the contacts whose loyalty
-- tier is gold, say) was sent every other contact too. It can now name the field values of the
-- contacts whose events it takes (contact_event_field_values). Null keeps every contact, as before;
-- a list holds 1 to 50 pairs of a field's key and a value, [{"key": "tier", "value": "gold"}], the
-- value as the contact's field values are kept in app.contacts.attributes (0005): text of 1 to 500
-- characters without spaces around it (dates as YYYY-MM-DD), a number, or true or false. The
-- services check each key against the company's fields and each value against its field's type when
-- a list adds them, and keep a list to 4,000 bytes as JSON so that the audit entries carrying it
-- stay within app.audit_events' 8 KiB of metadata (0001); the check below allows 4,500 bytes of its
-- text here, which spaces out what JSON does not. A list is kept only while the endpoint takes
-- contact.created or contact.updated, so it never outlives them. A company has at most 10
-- endpoints, so the table is small and the check is validated here. The CASE reads the list's shape
-- before its keys and values, so a list that is not an array of such pairs fails the check before
-- the paths below read them.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN contact_event_field_values jsonb,
  ADD CONSTRAINT webhook_endpoints_contact_event_field_values CHECK (
    contact_event_field_values IS NULL
    OR CASE
         WHEN jsonb_typeof(contact_event_field_values) <> 'array' THEN false
         WHEN jsonb_array_length(contact_event_field_values) NOT BETWEEN 1 AND 50 THEN false
         WHEN octet_length(contact_event_field_values::text) > 4500 THEN false
         -- Each pair an object of a key and a value and nothing else, …
         WHEN jsonb_path_exists(contact_event_field_values,
                                'strict $[*] ? (@.type() != "object")') THEN false
         WHEN jsonb_path_exists(contact_event_field_values,
                                'strict $[*].keyvalue() ? (@.key != "key" && @.key != "value")')
           THEN false
         WHEN jsonb_array_length(jsonb_path_query_array(contact_event_field_values,
                                                        'strict $[*].keyvalue()'))
              <> 2 * jsonb_array_length(contact_event_field_values) THEN false
         -- … the key a field's key (0005's rule), and the value text of 1 to 500 characters
         -- without spaces around it, a number or a boolean.
         ELSE NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*].key ? (@.type() != "string" || !(@ like_regex "^[a-z][a-z0-9_]{0,39}$"))')
              AND NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*].value ? (@.type() != "string" && @.type() != "number" && @.type() != "boolean")')
              AND NOT jsonb_path_exists(contact_event_field_values,
                'strict $[*].value ? (@.type() == "string" && (@ == "" || @ like_regex "^\\s|\\s$" || @ like_regex "^.{250}.{251}" flag "s"))')
              AND ('contact.created' = ANY (event_types) OR 'contact.updated' = ANY (event_types))
       END);

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (contact_event_field_values) ON app.webhook_endpoints TO w360_app;

-- The capture below reads where a contact added in the calling transaction came from when a later
-- write of the same transaction gives it values an endpoint names, and that write may be a definer
-- function's (the definer role reads the contact's values since 0147, but not its source).
GRANT SELECT (source) ON app.contacts TO w360_definer;

-- Whether a contact's change passes an endpoint's list of field values: always for a null list;
-- otherwise when the contact has one of the values (text compared whatever its case, as the API's
-- contact search compares it, ADR-113; numbers as numbers; true and false as they are), or when the
-- change of a contact.updated (`p_changes`, everything its transaction changed so far) changed one
-- of the listed fields, so the change that takes a contact out of the receiver's segment is sent
-- too. An event does not say what a field was before, so a change between two values not listed
-- is sent as well. A contact.created passes no changes. Run by the capture and the tag delivery
-- below, as the role making the change.
CREATE FUNCTION app.webhook_contact_values_match(p_values jsonb, p_attributes jsonb,
  p_changes text[])
  RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT p_values IS NULL
      OR EXISTS (SELECT 1
                   FROM jsonb_array_elements(p_values) AS c(pair)
                  WHERE ('fields.' || (c.pair ->> 'key')) = ANY (coalesce(p_changes, '{}'::text[]))
                     OR CASE jsonb_typeof(c.pair -> 'value')
                          WHEN 'string' THEN
                            jsonb_typeof(p_attributes -> (c.pair ->> 'key')) = 'string'
                            AND lower(p_attributes ->> (c.pair ->> 'key')) = lower(c.pair ->> 'value')
                          ELSE (p_attributes -> (c.pair ->> 'key')) = (c.pair -> 'value')
                        END);
$$;
REVOKE EXECUTE ON FUNCTION app.webhook_contact_values_match(jsonb, jsonb, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.webhook_contact_values_match(jsonb, jsonb, text[])
  TO w360_app, w360_definer;

-- 0239's capture with the field value filter: a contact.created or contact.updated delivery is
-- created only for the active endpoints whose list is null or passes the contact's values, read from
-- the contact when an endpoint names values (the row itself: the triggers run after the write). A
-- later write of the same transaction matches the values against the contact as that write left it
-- and against everything the transaction changed so far, so the change is sent whatever the order
-- of its writes. A contact added in the transaction and given values by a later write of it (a
-- member adding a contact and then its fields, say) has its contact.created sent then to the
-- endpoints naming values it has, by their sources and tags as at its capture. Everything else as
-- in 0239; same signature, so its owner and grants stay.
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
  v_attributes jsonb;
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
    -- The contact's field values now, read only when an active endpoint of the company that takes
    -- contact.created or contact.updated names values.
    IF EXISTS (SELECT 1 FROM app.webhook_endpoints e
                WHERE e.tenant_id = p_tenant AND e.state = 'active'
                  AND e.contact_event_field_values IS NOT NULL
                  AND ('contact.created' = ANY (e.event_types)
                       OR 'contact.updated' = ANY (e.event_types))) THEN
      SELECT c.attributes INTO v_attributes
        FROM app.contacts c
       WHERE c.tenant_id = p_tenant AND c.id = p_contact;
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
           AND app.webhook_contact_values_match(e.contact_event_field_values, v_attributes,
                                                v_changes)
           AND NOT EXISTS (SELECT 1 FROM app.webhook_deliveries d
                            WHERE d.tenant_id = p_tenant AND d.event_id = v_event
                              AND d.endpoint_id = e.id);
      ELSIF v_captured = 'contact.created' AND p_type = 'contact.updated'
            AND v_attributes IS NOT NULL THEN
        -- A contact added in this transaction and changed again: its contact.created goes to the
        -- endpoints naming values that it has now and that its creation did not reach, by their
        -- sources (read only when one of them names sources) and its tags now.
        IF EXISTS (SELECT 1 FROM app.webhook_endpoints e
                    WHERE e.tenant_id = p_tenant AND e.state = 'active'
                      AND e.contact_event_field_values IS NOT NULL
                      AND e.contact_sources IS NOT NULL
                      AND 'contact.created' = ANY (e.event_types)) THEN
          SELECT c.source INTO v_source FROM app.contacts c
           WHERE c.tenant_id = p_tenant AND c.id = p_contact;
        END IF;
        INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id)
        SELECT gen_random_uuid(), p_tenant, e.id, v_event
          FROM app.webhook_endpoints e
         WHERE e.tenant_id = p_tenant AND e.state = 'active'
           AND 'contact.created' = ANY (e.event_types)
           AND e.contact_event_field_values IS NOT NULL
           AND (e.contact_sources IS NULL OR v_source = ANY (e.contact_sources))
           AND (e.contact_event_tags IS NULL OR v_tags && e.contact_event_tags)
           AND app.webhook_contact_values_match(e.contact_event_field_values, v_attributes, NULL)
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
          OR v_tags && e.contact_event_tags)
     AND (p_type = 'contact.erased'
          OR app.webhook_contact_values_match(e.contact_event_field_values, v_attributes,
               CASE WHEN p_type = 'contact.updated' THEN p_changes END));
END
$$;

-- 0239's matching of a tag added or removed, with the field value filter: an endpoint naming the
-- tag takes the change only when its list of values is null or passes the contact's values, read
-- when such an endpoint names values, and for a contact.updated everything the transaction changed
-- so far. Everything else as in 0239; same signature, so its owner and grants stay.
CREATE OR REPLACE FUNCTION app.deliver_contact_webhook_tag(p_tenant uuid, p_contact uuid,
  p_tag text)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_event uuid;
  v_captured text;
  v_changes text[];
  v_source text;
  v_attributes jsonb;
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
  IF EXISTS (SELECT 1 FROM app.webhook_endpoints e
              WHERE e.tenant_id = p_tenant AND e.state = 'active'
                AND p_tag = ANY (e.contact_event_tags)
                AND e.contact_event_field_values IS NOT NULL) THEN
    SELECT c.attributes INTO v_attributes FROM app.contacts c
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
     AND app.webhook_contact_values_match(e.contact_event_field_values, v_attributes,
           CASE WHEN v_captured = 'contact.updated' THEN v_changes END)
     AND NOT EXISTS (SELECT 1 FROM app.webhook_deliveries d
                      WHERE d.tenant_id = p_tenant AND d.event_id = v_event
                        AND d.endpoint_id = e.id);
END
$$;
