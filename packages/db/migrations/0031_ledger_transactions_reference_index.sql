-- migrate:no-transaction
-- Reference index for ledger transactions (billing history, ADR-057): a receipt lists the refunds and
-- chargebacks recorded against one top-up. Built concurrently so the ledger keeps accepting postings.
-- If this migration fails, an INVALID index can remain: drop it with
-- `DROP INDEX CONCURRENTLY app.ledger_transactions_reference_idx;` and run the migrations again
-- (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY ledger_transactions_reference_idx
  ON app.ledger_transactions (tenant_id, reference_type, reference_id);
