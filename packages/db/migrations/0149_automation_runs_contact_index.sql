-- migrate:no-transaction
-- A contact's automation runs (ADR-224): a merge moves them, and erasure stops and clears them,
-- without reading the company's whole run list. Built concurrently so runs keep being written. If
-- this migration fails, an INVALID index can remain: drop it with
-- `DROP INDEX CONCURRENTLY app.automation_runs_contact_idx;` and run the migrations again
-- (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY automation_runs_contact_idx
  ON app.automation_runs (tenant_id, contact_id);
