-- migrate:no-transaction
-- Conversations by company, newest first, for the public API's pages (ADR-072). Built concurrently
-- so a large app.conversations table keeps accepting writes. If this migration fails, an INVALID
-- index can remain: drop it with `DROP INDEX CONCURRENTLY app.conversations_created_idx;` and run
-- the migrations again (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY conversations_created_idx
  ON app.conversations (tenant_id, created_at DESC, id DESC);
