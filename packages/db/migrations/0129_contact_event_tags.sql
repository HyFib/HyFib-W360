-- The tags a contact.updated event added and removed (P5-09, ADR-182).
--
-- Since 0096 a contact.updated names the parts its transaction changed, `tags` among them, but not
-- which tags: a receiver that keeps a list in step with a tag (a CRM segment for `vip`, say) had to
-- keep a copy of every contact's tags to compare. The event now keeps the tags its transaction
-- added and those it removed, as the contact lists them, sorted. A tag added and removed again in
-- the same transaction is in neither list, so both are empty when a change of tags undid itself,
-- and for a change that touched no tag. Null for other types and for events captured before this
-- migration. Unlike the parts, tag names can say something about a person, so erasing a contact
-- clears both lists from all its events, which are kept 30 days like every event (0025). NOT VALID:
-- new rows are checked at once, and 0130 checks the rows already there without holding the lock
-- this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  ADD COLUMN tags_added text[],
  ADD COLUMN tags_removed text[],
  ADD CONSTRAINT webhook_events_tag_changes_check CHECK (
    (tags_added IS NULL) = (tags_removed IS NULL)
    AND (tags_added IS NULL
         OR (type = 'contact.updated'
             AND coalesce(array_ndims(tags_added), 1) = 1
             AND coalesce(array_ndims(tags_removed), 1) = 1
             AND array_position(tags_added, NULL) IS NULL
             AND array_position(tags_removed, NULL) IS NULL
             AND NOT (tags_added && tags_removed))))
    NOT VALID;

-- A tag added to or removed from a contact, noted on the contact.updated event its transaction
-- captured: adding a tag the transaction removed takes it off the removed list, and otherwise puts
-- it on the added list, and removing one likewise. Only an event captured by the calling
-- transaction itself (its captured_xact), which no delivery can have read yet, as for what changed
-- (0096); a contact added in the transaction has a contact.created event, which lists no tags. The
-- definer role owns it, so the runtime role still only inserts and reads events (0025).
CREATE FUNCTION app.note_contact_webhook_tag(p_tenant uuid, p_contact uuid, p_tag text,
  p_added boolean)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  UPDATE app.webhook_events e
     SET tags_added = CASE
           WHEN p_added AND NOT (p_tag = ANY (e.tags_removed))
             THEN (SELECT array_agg(DISTINCT t ORDER BY t)
                     FROM unnest(e.tags_added || p_tag) AS t)
           WHEN NOT p_added THEN array_remove(e.tags_added, p_tag)
           ELSE e.tags_added END,
         tags_removed = CASE
           WHEN NOT p_added AND NOT (p_tag = ANY (e.tags_added))
             THEN (SELECT array_agg(DISTINCT t ORDER BY t)
                     FROM unnest(e.tags_removed || p_tag) AS t)
           WHEN p_added THEN array_remove(e.tags_removed, p_tag)
           ELSE e.tags_removed END
   WHERE e.tenant_id = p_tenant AND e.contact_id = p_contact AND e.type = 'contact.updated'
     AND e.captured_xact = pg_catalog.pg_current_xact_id()
     AND e.tags_added IS NOT NULL;
$$;
REVOKE EXECUTE ON FUNCTION app.note_contact_webhook_tag(uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.note_contact_webhook_tag(uuid, uuid, text, boolean)
  TO w360_app, w360_definer;
-- The function's updates, and erasure's (which runs as the definer role) clearing the lists.
GRANT UPDATE (tags_added, tags_removed) ON app.webhook_events TO w360_definer;
ALTER FUNCTION app.note_contact_webhook_tag(uuid, uuid, text, boolean) OWNER TO w360_definer;

-- 0098's capture with the tag lists: a contact.updated starts with both empty, and contact.erased
-- drops the transaction's own created and updated events, as before (erasure deletes the contact's
-- tags first, which notes them on an event of its own transaction), then clears the lists from
-- every other event of the contact, found through the contact events' index (0048: every contact
-- event has a captured_xact). Only the definer role erases contacts (it alone writes erased_at,
-- 0005). Everything else as in 0098; same signature, so its owner and grants stay.
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
     AND (p_type <> 'contact.updated' OR e.contact_parts IS NULL
          OR EXISTS (SELECT 1 FROM unnest(p_changes) AS c
                      WHERE split_part(c, '.', 1) = ANY (e.contact_parts)));
END
$$;

-- 0096's tag trigger, which now notes the tag as well. Same signature, so the trigger, owner and
-- revoked grants stay.
CREATE OR REPLACE FUNCTION app.webhook_capture_contact_tag() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app.capture_contact_webhook_event(OLD.tenant_id, OLD.contact_id, 'contact.updated',
      ARRAY['tags']);
    PERFORM app.note_contact_webhook_tag(OLD.tenant_id, OLD.contact_id, OLD.tag, false);
  ELSE
    PERFORM app.capture_contact_webhook_event(NEW.tenant_id, NEW.contact_id, 'contact.updated',
      ARRAY['tags']);
    PERFORM app.note_contact_webhook_tag(NEW.tenant_id, NEW.contact_id, NEW.tag, true);
  END IF;
  RETURN NULL;
END
$$;
