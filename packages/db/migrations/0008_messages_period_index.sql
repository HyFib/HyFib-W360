-- migrate:no-transaction
-- Period index for reports (messages recorded in a date range for one company). Built
-- concurrently so a large app.messages table keeps accepting writes. If this migration fails, an
-- INVALID index can remain: drop it with `DROP INDEX CONCURRENTLY app.messages_tenant_created_idx;`
-- and run the migrations again (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY messages_tenant_created_idx ON app.messages (tenant_id, created_at);
