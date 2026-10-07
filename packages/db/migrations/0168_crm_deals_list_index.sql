-- migrate:no-transaction
-- The company's deals newest first (ADR-253): GET /api/v1/deals pages them by when they were
-- created, on exact keyset pages, without reading the company's whole deal list. Built concurrently
-- so members and automations keep writing deals. If this migration fails, an INVALID index can
-- remain: drop it with `DROP INDEX CONCURRENTLY app.crm_deals_list_idx;` and run the migrations
-- again (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY crm_deals_list_idx
  ON app.crm_deals (tenant_id, created_at DESC, id DESC);
