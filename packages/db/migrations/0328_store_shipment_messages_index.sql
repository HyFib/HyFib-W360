-- migrate:no-transaction
-- At most one store message per shipment, event and key (ADR-413, migration 0323): the unique index
-- the order read's `ON CONFLICT (tenant_id, shipment_id, event, dedupe_key) DO NOTHING` infers. Built
-- concurrently so order messages keep being written and read while it builds (a plain unique
-- constraint would hold ACCESS EXCLUSIVE on the table, reads included, for the whole build). Rows
-- of other messages have no shipment, and NULLs never conflict. No shipment message can exist
-- before this runs: the release that writes them starts only after every migration has applied.
-- If this migration fails, an INVALID index can remain: drop it with
-- `DROP INDEX CONCURRENTLY app.commerce_store_messages_shipment_uq;` and run the migrations again
-- (docs/RUNBOOKS.md).
CREATE UNIQUE INDEX CONCURRENTLY commerce_store_messages_shipment_uq
  ON app.commerce_store_messages (tenant_id, shipment_id, event, dedupe_key);
