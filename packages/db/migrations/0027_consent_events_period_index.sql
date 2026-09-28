-- migrate:no-transaction
-- Period index for consent events (opt-outs recorded in a date range for one company), used by the
-- platform operations console (ADR-054). Built concurrently so a large app.consent_events table keeps
-- accepting writes. If this migration fails, an INVALID index can remain: drop it with
-- `DROP INDEX CONCURRENTLY app.consent_events_tenant_occurred_idx;` and run the migrations again
-- (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY consent_events_tenant_occurred_idx ON app.consent_events (tenant_id, occurred_at);
