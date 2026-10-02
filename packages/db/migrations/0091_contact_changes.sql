-- Contact changes through the public API (P5-08, ADR-114).
--
-- app.contact_changes holds a row for every transaction that changes how the API describes a
-- contact (ADR-052, ADR-112), one per contact and transaction: the contact added; its name,
-- number, email, custom field values or source changed; a tag added or removed; a consent state
-- set or changed; the contact erased. GET /contact-changes reads each contact once, at its latest
-- change, in the order of the transactions that made the changes, and never reads a change made by
-- a transaction id at or above the reading snapshot's xmin: every transaction below it has
-- finished, so a change committed after a reader passed a position always lies beyond that
-- position (as app.tenant_events are read, 0003).
--
-- Rows are only inserted, and no other row is updated. A row's key to its contact takes a key-share
-- lock on the contact, which adding a tag or recording consent takes already and changing the
-- contact exceeds; the automation runner takes it before it changes a tag, as members and keys take
-- the contact before its tags, so recording the removal of a tag deadlocks with nothing (ADR-114).
-- ops.compact_contact_changes deletes the rows a later change of the same contact makes unnecessary
-- (the feed reads only a contact's latest).

CREATE TABLE app.contact_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  -- The top-level transaction that made the change (the same inside savepoints).
  xact xid8 NOT NULL DEFAULT pg_catalog.pg_current_xact_id(),
  CONSTRAINT contact_changes_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT contact_changes_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES app.contacts (tenant_id, id)
);

SELECT ops.apply_tenant_rls('app.contact_changes');
-- Changes are recorded by the triggers below in the transaction that makes them, whoever makes it:
-- members and keys (w360_app), and the definer functions that change contacts, tags and consent
-- (erasure, consent state, ingestion). The compaction below reads and deletes across companies.
CREATE POLICY definer_read ON app.contact_changes FOR SELECT TO w360_definer USING (true);
CREATE POLICY definer_capture ON app.contact_changes FOR INSERT TO w360_definer WITH CHECK (true);
CREATE POLICY definer_compact ON app.contact_changes FOR DELETE TO w360_definer USING (true);
GRANT SELECT, INSERT (tenant_id, contact_id) ON app.contact_changes TO w360_app;
GRANT SELECT (id, tenant_id, contact_id, xact), INSERT (tenant_id, contact_id), DELETE
  ON app.contact_changes TO w360_definer;

-- Records a change of the contact once per transaction.
CREATE FUNCTION app.capture_contact_change(p_tenant uuid, p_contact uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.contact_changes c
                  WHERE c.tenant_id = p_tenant AND c.contact_id = p_contact
                    AND c.xact = pg_catalog.pg_current_xact_id()) THEN
    INSERT INTO app.contact_changes (tenant_id, contact_id) VALUES (p_tenant, p_contact);
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION app.capture_contact_change(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.capture_contact_change(uuid, uuid) TO w360_app, w360_definer;

CREATE FUNCTION app.contact_changes_capture_contact() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM app.capture_contact_change(NEW.tenant_id, NEW.id);
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.contact_changes_capture_contact() FROM PUBLIC;

-- Tags and consent states belong to a contact.
CREATE FUNCTION app.contact_changes_capture_child() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app.capture_contact_change(OLD.tenant_id, OLD.contact_id);
  ELSE
    PERFORM app.capture_contact_change(NEW.tenant_id, NEW.contact_id);
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.contact_changes_capture_child() FROM PUBLIC;

-- The columns the API's contact is made of; `attributes` whole, so a field's deletion, which
-- removes its values after the field row (ADR-112), records a change of every contact that had one.
-- The created and updated times are not part of a change.
CREATE TRIGGER contacts_change_added AFTER INSERT ON app.contacts
  FOR EACH ROW EXECUTE FUNCTION app.contact_changes_capture_contact();
CREATE TRIGGER contacts_change_changed
  AFTER UPDATE OF display_name, phone_e164, email, attributes, source, erased_at ON app.contacts
  FOR EACH ROW WHEN (NEW.display_name IS DISTINCT FROM OLD.display_name
    OR NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164 OR NEW.email IS DISTINCT FROM OLD.email
    OR NEW.attributes IS DISTINCT FROM OLD.attributes OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.erased_at IS DISTINCT FROM OLD.erased_at)
  EXECUTE FUNCTION app.contact_changes_capture_contact();
CREATE TRIGGER contact_tags_change AFTER INSERT OR DELETE ON app.contact_tags
  FOR EACH ROW EXECUTE FUNCTION app.contact_changes_capture_child();
-- A consent state is set once per purpose, then changed by app.apply_consent_event (0005); an
-- event that leaves the state as it is changes nothing.
CREATE TRIGGER contact_consents_change_set AFTER INSERT ON app.contact_consents
  FOR EACH ROW EXECUTE FUNCTION app.contact_changes_capture_child();
CREATE TRIGGER contact_consents_change_changed AFTER UPDATE OF status ON app.contact_consents
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION app.contact_changes_capture_child();

-- Every contact once, so the feed read from its start lists every contact (erased ones as erased).
-- The triggers above already lock the three tables against writes until this migration commits, so
-- no contact is added unseen in between. Contacts are behind forced RLS, which applies to the
-- migration role too, so the definer role (which may read them) writes the rows; uuidv7 ids keep
-- each company's contacts in the order they were added.
SET ROLE w360_definer;
INSERT INTO app.contact_changes (tenant_id, contact_id)
SELECT c.tenant_id, c.id FROM app.contacts c ORDER BY c.tenant_id, c.id;
RESET ROLE;

-- The feed: a company's changes in order. Each contact's changes: one per transaction, and the
-- latest for the feed and the compaction.
CREATE INDEX contact_changes_feed_idx ON app.contact_changes (tenant_id, xact, id);
CREATE INDEX contact_changes_contact_idx ON app.contact_changes (tenant_id, contact_id, xact, id);

-- Compaction ---------------------------------------------------------------------------------------
-- Follows every company's changes in order, as the feed does, from the last change it read; each
-- change deletes the earlier changes of its contact. A change it reads is below the snapshot's
-- xmin, so it and everything earlier is final; a reader that has not passed a deleted change reads
-- its contact at the change that replaced it, now or once that change is below the reader's xmin.
CREATE INDEX contact_changes_order_idx ON app.contact_changes (xact, id);
CREATE TABLE ops.contact_change_compaction (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  xact xid8 NOT NULL,
  change_id bigint NOT NULL,
  compacted_at timestamptz
);
INSERT INTO ops.contact_change_compaction (xact, change_id) VALUES ('0', 0);
GRANT SELECT, UPDATE (xact, change_id, compacted_at) ON ops.contact_change_compaction TO w360_definer;

-- Reads at most p_limit changes (1 to 10,000); returns how many earlier changes it deleted. One
-- compaction at a time: another one running returns 0 at once.
CREATE FUNCTION ops.compact_contact_changes(p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_xact xid8;
  v_id bigint;
  v_change record;
  v_count integer;
  v_deleted integer := 0;
BEGIN
  SELECT s.xact, s.change_id INTO v_xact, v_id
    FROM ops.contact_change_compaction s FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  FOR v_change IN
    SELECT c.id, c.tenant_id, c.contact_id, c.xact
      FROM app.contact_changes c
     WHERE (c.xact, c.id) > (v_xact, v_id)
       AND c.xact < pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot())
     ORDER BY c.xact, c.id
     LIMIT least(greatest(p_limit, 1), 10000)
  LOOP
    DELETE FROM app.contact_changes o
     WHERE o.tenant_id = v_change.tenant_id AND o.contact_id = v_change.contact_id
       AND (o.xact, o.id) < (v_change.xact, v_change.id);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_deleted := v_deleted + v_count;
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

-- Deleted with the company (ADR-055): after its tags, whose deletion records changes, and before
-- its contacts.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (775, ARRAY['app.contact_changes']::regclass[], 'batch');
CREATE POLICY tenant_deletion_read ON app.contact_changes FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.contact_changes FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
