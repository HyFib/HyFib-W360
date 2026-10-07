-- migrate:no-transaction
-- The company's CRM notes newest first (ADR-279): GET /api/v1/notes pages them by when they were
-- added, on exact keyset pages, without reading the rest of the company's timeline. Only notes are
-- indexed, so the index stays small. Built concurrently so members, keys and automations keep
-- writing the timeline. If this migration fails, an INVALID index can remain: drop it with
-- `DROP INDEX CONCURRENTLY app.crm_activities_notes_idx;` and run the migrations again
-- (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY crm_activities_notes_idx
  ON app.crm_activities (tenant_id, created_at DESC, id DESC)
  WHERE kind = 'note';
