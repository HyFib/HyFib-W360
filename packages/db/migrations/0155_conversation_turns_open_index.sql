-- migrate:no-transaction
-- Open reply turns by start time (ADR-230): the overdue reply sweep reads them every minute across
-- companies, and few of all turns are open. Built concurrently so customer messages and replies
-- keep writing turns. If this migration fails, an INVALID index can remain: drop it with
-- `DROP INDEX CONCURRENTLY app.conversation_turns_open_started_idx;` and run the migrations again
-- (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY conversation_turns_open_started_idx
  ON app.conversation_turns (started_at) WHERE ended_at IS NULL;
