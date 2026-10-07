-- migrate:no-transaction
-- The company's tasks newest first (ADR-258): GET /api/v1/tasks pages them by when they were
-- created, on exact keyset pages, without reading the company's whole task list. Built concurrently
-- so members and automations keep writing tasks. If this migration fails, an INVALID index can
-- remain: drop it with `DROP INDEX CONCURRENTLY app.crm_tasks_list_idx;` and run the migrations
-- again (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY crm_tasks_list_idx
  ON app.crm_tasks (tenant_id, created_at DESC, id DESC);
