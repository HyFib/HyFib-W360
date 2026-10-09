-- Which parts of a contact changed, in the API's contact change feed (P5-08, ADR-329).
--
-- GET /contact-changes (0091, ADR-114) reads each contact once, at its latest change, as it is now,
-- so a reader could not tell a new email from a new tag without a copy to compare; the webhooks
-- name what a contact.updated event changed since ADR-121. Each change now keeps the parts its
-- transaction changed (`parts`), in the API contact's names: name, phone, email, tags,
-- fields.<key> for each custom field whose value changed (a field's deletion included),
-- consent.marketing, consent.utility, source, and merged for a contact another one was merged
-- into; `added` stands alone for a transaction that adds the contact and `erased` for one that
-- erases it, whatever else they changed. Names only, never values. NULL for the changes recorded
-- before this migration, whose parts nobody knows.
--
-- The compaction deletes the changes a later change of the same contact replaced (0091); it now
-- keeps, on the change that replaced them, where each part last changed among them (`replaced`:
-- part -> [transaction, change id], `*` for the changes recorded before this migration). The feed
-- then tells a reader exactly the parts changed since its pass through the feed began (the cursor
-- seals where), whatever was compacted since.
-- The map holds one entry per part, so it stays small; an erasing change keeps none, since an
-- erased contact is read as erased alone.
--
-- NOT VALID: new rows are checked at once, and 0252 checks the rows already there (none has parts)
-- without holding the lock this change takes (every change of a contact writes to this table).
ALTER TABLE app.contact_changes
  ADD COLUMN parts text[],
  ADD COLUMN replaced jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT contact_changes_parts_check CHECK (
    parts IS NULL
    OR (cardinality(parts) >= 1
        AND array_ndims(parts) = 1
        AND array_position(parts, NULL) IS NULL
        AND array_to_string(parts, ',')
          ~ '^(added|name|phone|email|tags|source|erased|merged|consent\.(marketing|utility)|fields\.[a-z][a-z0-9_]{0,39})(,(added|name|phone|email|tags|source|erased|merged|consent\.(marketing|utility)|fields\.[a-z][a-z0-9_]{0,39}))*$'))
    NOT VALID,
  ADD CONSTRAINT contact_changes_replaced_check CHECK (jsonb_typeof(replaced) = 'object')
    NOT VALID;

-- Whoever records a change records its parts with it: members and keys (the runtime role) and the
-- definer functions that change contacts, tags and consent. A later change of the same contact in
-- the same transaction adds its parts through the definer function below, and the compaction keeps
-- the parts of the changes it deletes; nothing else updates a change.
GRANT INSERT (parts) ON app.contact_changes TO w360_app, w360_definer;
GRANT SELECT (parts, replaced), UPDATE (parts, replaced) ON app.contact_changes TO w360_definer;
CREATE POLICY definer_parts ON app.contact_changes FOR UPDATE TO w360_definer
  USING (true) WITH CHECK (true);

-- The parts of two changes as one change's: sorted in byte order, once each; `erased` alone when
-- either erased the contact, else `added` alone when either added it.
CREATE FUNCTION app.contact_change_parts_union(p_parts text[], p_more text[]) RETURNS text[]
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT CASE
           WHEN 'erased' = ANY (p_parts || p_more) THEN ARRAY['erased']
           WHEN 'added' = ANY (p_parts || p_more) THEN ARRAY['added']
           ELSE (SELECT array_agg(d.part ORDER BY d.part COLLATE "C")
                   FROM (SELECT DISTINCT unnest(p_parts || p_more) AS part) d)
         END;
$$;
REVOKE EXECUTE ON FUNCTION app.contact_change_parts_union(text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contact_change_parts_union(text[], text[])
  TO w360_app, w360_definer;

-- A later change of the same contact in the same transaction adds what it changed to the change
-- the transaction recorded first. Only a change recorded by the calling transaction itself (its
-- xact), which neither the feed nor the compaction has read (both read finished transactions
-- only), so no role can change a change once it is history.
CREATE FUNCTION app.add_contact_change_parts(p_tenant uuid, p_contact uuid, p_parts text[])
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  UPDATE app.contact_changes c
     SET parts = app.contact_change_parts_union(c.parts, p_parts)
   WHERE c.tenant_id = p_tenant AND c.contact_id = p_contact
     AND c.xact = pg_catalog.pg_current_xact_id();
$$;
REVOKE EXECUTE ON FUNCTION app.add_contact_change_parts(uuid, uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_contact_change_parts(uuid, uuid, text[])
  TO w360_app, w360_definer;
ALTER FUNCTION app.add_contact_change_parts(uuid, uuid, text[]) OWNER TO w360_definer;

-- 0091's capture with the parts: records a change of the contact once per transaction, with what
-- it changed, and adds what later changes of the transaction change. A change that changed no
-- part the API describes is not recorded. Still runs as the role making the change.
CREATE FUNCTION app.capture_contact_change(p_tenant uuid, p_contact uuid, p_parts text[])
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF coalesce(cardinality(p_parts), 0) = 0 THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM app.contact_changes c
              WHERE c.tenant_id = p_tenant AND c.contact_id = p_contact
                AND c.xact = pg_catalog.pg_current_xact_id()) THEN
    PERFORM app.add_contact_change_parts(p_tenant, p_contact, p_parts);
  ELSE
    INSERT INTO app.contact_changes (tenant_id, contact_id, parts)
    VALUES (p_tenant, p_contact, app.contact_change_parts_union(NULL, p_parts));
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.capture_contact_change(uuid, uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.capture_contact_change(uuid, uuid, text[]) TO w360_app, w360_definer;

-- The triggers of 0091 and 0150 say what changed. Same signatures, so the triggers, owners and
-- revoked grants stay.
--
-- A contact added: added. Erased: erased; no longer erased (nothing does this): added, so a reader
-- takes it whole again. Otherwise each column the API describes that changed, and fields.<key> for
-- each value that differs under a key a field can have, a deleted field's values included (a value
-- under any other key is never read by the API, and changes nothing it describes).
CREATE OR REPLACE FUNCTION app.contact_changes_capture_contact() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_contact_change(NEW.tenant_id, NEW.id, ARRAY['added']);
  ELSIF NEW.erased_at IS NOT NULL AND OLD.erased_at IS NULL THEN
    PERFORM app.capture_contact_change(NEW.tenant_id, NEW.id, ARRAY['erased']);
  ELSIF NEW.erased_at IS NULL AND OLD.erased_at IS NOT NULL THEN
    PERFORM app.capture_contact_change(NEW.tenant_id, NEW.id, ARRAY['added']);
  ELSE
    PERFORM app.capture_contact_change(NEW.tenant_id, NEW.id,
      array_remove(ARRAY[
        CASE WHEN NEW.display_name IS DISTINCT FROM OLD.display_name THEN 'name' END,
        CASE WHEN NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164 THEN 'phone' END,
        CASE WHEN NEW.email IS DISTINCT FROM OLD.email THEN 'email' END,
        CASE WHEN NEW.source IS DISTINCT FROM OLD.source THEN 'source' END]::text[], NULL)
      || coalesce((SELECT array_agg('fields.' || k.key)
                     FROM (SELECT jsonb_object_keys(OLD.attributes)
                           UNION SELECT jsonb_object_keys(NEW.attributes)) AS k (key)
                    WHERE k.key ~ '^[a-z][a-z0-9_]{0,39}$'
                      AND (OLD.attributes -> k.key) IS DISTINCT FROM (NEW.attributes -> k.key)),
                  '{}'::text[]));
  END IF;
  RETURN NULL;
END
$$;

-- A tag added or removed: tags. A consent state set or changed: consent.<purpose>.
CREATE OR REPLACE FUNCTION app.contact_changes_capture_child() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_TABLE_NAME = 'contact_consents' THEN
    PERFORM app.capture_contact_change(NEW.tenant_id, NEW.contact_id,
      ARRAY['consent.' || NEW.purpose]);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM app.capture_contact_change(OLD.tenant_id, OLD.contact_id, ARRAY['tags']);
  ELSE
    PERFORM app.capture_contact_change(NEW.tenant_id, NEW.contact_id, ARRAY['tags']);
  END IF;
  RETURN NULL;
END
$$;

-- 0150's merge capture: the change of the kept contact names the merge; the event as before.
CREATE OR REPLACE FUNCTION app.contact_merges_capture() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM app.capture_contact_change(NEW.tenant_id, NEW.kept_contact_id, ARRAY['merged']);
  PERFORM app.capture_webhook_event(NEW.tenant_id, 'contact.merged', NULL, NULL,
    NEW.kept_contact_id, NULL, NULL,
    jsonb_build_object('mergedContactId', NEW.merged_contact_id), clock_timestamp());
  RETURN NULL;
END
$$;

-- Nothing calls the two-argument capture any more.
DROP FUNCTION app.capture_contact_change(uuid, uuid);

-- 0091's compaction, keeping on each change it reads where every part last changed among the
-- changes it deletes: their parts at their places (`*` for a change recorded before this
-- migration), the entries they kept, and the change's own entries, the latest place of each part.
-- An erasing change keeps none. The owner drops the function and the migration role recreates it
-- (see 0011).
SET ROLE w360_definer;
DROP FUNCTION ops.compact_contact_changes(integer);
RESET ROLE;
CREATE FUNCTION ops.compact_contact_changes(p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_xact xid8;
  v_id bigint;
  v_change record;
  v_count integer;
  v_replaced jsonb;
  v_deleted integer := 0;
BEGIN
  SELECT s.xact, s.change_id INTO v_xact, v_id
    FROM ops.contact_change_compaction s FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  FOR v_change IN
    SELECT c.id, c.tenant_id, c.contact_id, c.xact, c.parts, c.replaced
      FROM app.contact_changes c
     WHERE (c.xact, c.id) > (v_xact, v_id)
       AND c.xact < pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot())
     ORDER BY c.xact, c.id
     LIMIT least(greatest(p_limit, 1), 10000)
  LOOP
    WITH gone AS (
      DELETE FROM app.contact_changes o
       WHERE o.tenant_id = v_change.tenant_id AND o.contact_id = v_change.contact_id
         AND (o.xact, o.id) < (v_change.xact, v_change.id)
      RETURNING o.xact, o.id, o.parts, o.replaced
    ), places AS (
      SELECT p.part, g.xact, g.id
        FROM gone g, unnest(coalesce(g.parts, ARRAY['*'])) AS p (part)
      UNION ALL
      SELECT r.key, (r.value ->> 0)::xid8, (r.value ->> 1)::bigint
        FROM gone g, jsonb_each(g.replaced) AS r
      UNION ALL
      SELECT r.key, (r.value ->> 0)::xid8, (r.value ->> 1)::bigint
        FROM jsonb_each(v_change.replaced) AS r
    ), latest AS (
      SELECT DISTINCT ON (l.part) l.part, l.xact, l.id
        FROM places l
       ORDER BY l.part, l.xact DESC, l.id DESC
    )
    SELECT (SELECT count(*) FROM gone)::integer,
           coalesce(jsonb_object_agg(l.part, jsonb_build_array(l.xact::text, l.id)), '{}'::jsonb)
      INTO v_count, v_replaced
      FROM latest l;
    v_deleted := v_deleted + v_count;
    IF v_count > 0 AND NOT coalesce('erased' = ANY (v_change.parts), false) THEN
      UPDATE app.contact_changes c SET replaced = v_replaced
       WHERE c.tenant_id = v_change.tenant_id AND c.id = v_change.id;
    END IF;
    v_xact := v_change.xact;
    v_id := v_change.id;
  END LOOP;
  UPDATE ops.contact_change_compaction
     SET xact = v_xact, change_id = v_id, compacted_at = now();
  RETURN v_deleted;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.compact_contact_changes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.compact_contact_changes(integer) TO w360_app;
ALTER FUNCTION ops.compact_contact_changes(integer) OWNER TO w360_definer;

-- What changed of a contact after the place given (where the reader's pass began), up to the change
-- the feed reads it at: the parts of its changes in between, and the entries they kept of the
-- changes they replaced that lie after that place; sorted in byte order, once each, with `*` when one of them was recorded before
-- this migration (the feed answers `added` or `erased` alone whatever else changed, else nothing
-- named when `*` is there). Every change up to the one read is finished, as the feed reads only
-- finished changes. Runs as the reader, so it reads the company's changes only.
CREATE FUNCTION app.contact_changed_parts(p_tenant uuid, p_contact uuid, p_after_xact xid8,
    p_after_id bigint, p_upto_xact xid8, p_upto_id bigint)
  RETURNS text[]
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  WITH changes AS (
    SELECT c.parts, c.replaced
      FROM app.contact_changes c
     WHERE c.tenant_id = p_tenant AND c.contact_id = p_contact
       AND (c.xact, c.id) > (p_after_xact, p_after_id)
       AND (c.xact, c.id) <= (p_upto_xact, p_upto_id)
  ), named AS (
    SELECT p.part
      FROM changes c, unnest(coalesce(c.parts, ARRAY['*'])) AS p (part)
    UNION
    SELECT r.key
      FROM changes c, jsonb_each(c.replaced) AS r
     WHERE ((r.value ->> 0)::xid8, (r.value ->> 1)::bigint) > (p_after_xact, p_after_id)
  )
  SELECT coalesce(array_agg(n.part ORDER BY n.part COLLATE "C"), '{}'::text[]) FROM named n;
$$;
REVOKE EXECUTE ON FUNCTION app.contact_changed_parts(uuid, uuid, xid8, bigint, xid8, bigint)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contact_changed_parts(uuid, uuid, xid8, bigint, xid8, bigint)
  TO w360_app;
