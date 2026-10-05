-- Message changes through the public API (P5-08, ADR-116).
--
-- app.message_changes holds one row per message, naming the last transaction that changed how the
-- API describes it (ADR-072, ADR-088): the message received or created; its status, status time or
-- error changed; its content redacted when its contact is erased. GET /message-changes reads the
-- company's messages in the order of those transactions and never reads a change made by a
-- transaction id at or above the reading snapshot's xmin, as contact changes are read (0091,
-- ADR-114): every transaction below it has finished, so a change committed after a reader passed a
-- position always lies beyond that position.
--
-- Contact changes come from three tables and are only inserted, so that changes of one contact never
-- wait for each other on a shared row. Every change of a message updates the message's own row,
-- which the changing transaction then holds locked until it ends; the trigger below moves the
-- message's change row right after, so a message's changes wait for nothing they did not wait for
-- already, and a message has one row however often it changes: there is nothing to compact. The
-- trigger function is the definer role's, and no runtime role can write a row.

-- The keys, the foreign key and the feed's index are added after the existing messages are recorded
-- (below), which builds each once instead of row by row.
CREATE TABLE app.message_changes (
  id bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,
  message_id uuid NOT NULL,
  -- The top-level transaction that last changed the message (the same inside savepoints).
  xact xid8 NOT NULL DEFAULT pg_catalog.pg_current_xact_id()
);

SELECT ops.apply_tenant_rls('app.message_changes');
-- Keys read the rows (w360_app, in the company's scope); only the trigger below writes them.
CREATE POLICY definer_read ON app.message_changes FOR SELECT TO w360_definer USING (true);
CREATE POLICY definer_capture ON app.message_changes FOR INSERT TO w360_definer WITH CHECK (true);
CREATE POLICY definer_move ON app.message_changes FOR UPDATE TO w360_definer
  USING (true) WITH CHECK (true);
GRANT SELECT ON app.message_changes TO w360_app;
GRANT SELECT (id, tenant_id, message_id, xact), INSERT (tenant_id, message_id), UPDATE (xact), DELETE
  ON app.message_changes TO w360_definer;

-- Moves the message to the current transaction, once per transaction.
CREATE FUNCTION app.message_changes_capture() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO app.message_changes AS c (tenant_id, message_id) VALUES (NEW.tenant_id, NEW.id)
  ON CONFLICT (tenant_id, message_id) DO UPDATE SET xact = EXCLUDED.xact
   WHERE c.xact <> EXCLUDED.xact;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.message_changes_capture() FROM PUBLIC;

-- What a message's description is made of after it is saved: its status and status time, its error,
-- and its content (which only erasure changes). Not the provider's message id, the pricing or the
-- status rank, which change with a status or are not described. The triggers are created before
-- the owner changes: creating them needs EXECUTE, which the migration role loses with ownership
-- (firing them does not check it).
CREATE TRIGGER messages_change_added AFTER INSERT ON app.messages
  FOR EACH ROW EXECUTE FUNCTION app.message_changes_capture();
CREATE TRIGGER messages_change_changed
  AFTER UPDATE OF status, status_at, error_code, error_title, content ON app.messages
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status
    OR NEW.status_at IS DISTINCT FROM OLD.status_at
    OR NEW.error_code IS DISTINCT FROM OLD.error_code
    OR NEW.error_title IS DISTINCT FROM OLD.error_title
    OR NEW.content IS DISTINCT FROM OLD.content)
  EXECUTE FUNCTION app.message_changes_capture();
ALTER FUNCTION app.message_changes_capture() OWNER TO w360_definer;

-- Every message once, so the feed read from its start lists every message, each company's in the
-- order they were saved. The triggers above lock app.messages against writes until this migration
-- commits, so no message is saved or changed unseen in between, and nothing fires the trigger
-- before the keys below exist. Messages are behind forced RLS, which applies to the migration role
-- too, so the definer role (which may read them) writes the rows.
SET ROLE w360_definer;
INSERT INTO app.message_changes (tenant_id, message_id)
SELECT m.tenant_id, m.id FROM app.messages m ORDER BY m.tenant_id, m.created_at, m.id;
RESET ROLE;

ALTER TABLE app.message_changes
  ADD CONSTRAINT message_changes_pkey PRIMARY KEY (tenant_id, id),
  ADD CONSTRAINT message_changes_message_uq UNIQUE (tenant_id, message_id),
  -- Messages are deleted only with their company (ADR-055), after these rows (step 695). A status
  -- recorded while that deletion runs adds a row back after the step; it goes with its message.
  ADD CONSTRAINT message_changes_message_fk FOREIGN KEY (tenant_id, message_id)
    REFERENCES app.messages (tenant_id, id) ON DELETE CASCADE;
-- The feed: a company's messages in the order of their latest changes.
CREATE INDEX message_changes_feed_idx ON app.message_changes (tenant_id, xact, id);

-- Deleted with the company (ADR-055): before its messages.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (695, ARRAY['app.message_changes']::regclass[], 'batch');
CREATE POLICY tenant_deletion_read ON app.message_changes FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.message_changes FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
