-- migrate:no-transaction
-- Time index for ledger entries (billing history, ADR-057): a statement's opening balances sum an
-- account's entries before the month starts, as an index-only scan. Built concurrently so the ledger
-- keeps accepting postings; one statement per file, because the runner sends a file as one query. If
-- this migration fails, an INVALID index can remain: drop it with
-- `DROP INDEX CONCURRENTLY app.ledger_entries_account_time_idx;` and run the migrations again
-- (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY ledger_entries_account_time_idx
  ON app.ledger_entries (tenant_id, account_id, created_at) INCLUDE (direction, amount_minor);
