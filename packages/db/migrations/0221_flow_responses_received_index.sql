-- migrate:no-transaction
-- The company's flow responses newest first (ADR-298): GET /api/v1/flow-responses pages them by
-- when they were received, on exact keyset pages, from a time when asked (flow_responses_flow_idx
-- and flow_responses_contact_idx serve its flow and contact filters). Built concurrently so
-- completed forms keep being recorded. If this migration fails, an INVALID index can remain: drop
-- it with `DROP INDEX CONCURRENTLY app.flow_responses_received_idx;` and run the migrations again
-- (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY flow_responses_received_idx
  ON app.flow_responses (tenant_id, received_at DESC, id DESC);
