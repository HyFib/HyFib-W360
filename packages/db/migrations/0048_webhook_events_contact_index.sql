-- migrate:no-transaction
-- Finds the contact events a transaction already captured (ADR-074). Built concurrently so captures
-- keep writing to app.webhook_events. Only contact events have captured_xact, so the index is small.
-- If this migration fails, an INVALID index can remain: drop it with
-- `DROP INDEX CONCURRENTLY app.webhook_events_contact_xact_idx;` and run the migrations again
-- (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY webhook_events_contact_xact_idx
  ON app.webhook_events (tenant_id, contact_id, captured_xact) WHERE captured_xact IS NOT NULL;
