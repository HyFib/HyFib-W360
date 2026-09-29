-- migrate:no-transaction
-- The notes a key wrote (ADR-084): the index the foreign key of 0060 uses when a key's row is
-- deleted (company deletion). Built concurrently so notes keep being written; only notes written
-- through the API have a key, so the index is small. If this migration fails, an INVALID index can
-- remain: drop it with `DROP INDEX CONCURRENTLY app.conversation_notes_api_key_idx;` and run the
-- migrations again (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY conversation_notes_api_key_idx
  ON app.conversation_notes (tenant_id, author_api_key_id) WHERE author_api_key_id IS NOT NULL;
