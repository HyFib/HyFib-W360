-- migrate:no-transaction
-- The runs a key started (ADR-077): the index the foreign key of 0052 uses when a key's row is
-- deleted (company deletion). Built concurrently so runs keep being written; only runs started
-- through the API have a key, so the index is small. If this migration fails, an INVALID index can
-- remain: drop it with `DROP INDEX CONCURRENTLY app.automation_runs_api_key_idx;` and run the
-- migrations again (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY automation_runs_api_key_idx
  ON app.automation_runs (tenant_id, api_key_id) WHERE api_key_id IS NOT NULL;
