-- migrate:no-transaction
-- Team views of the inbox (open conversations of one team, newest first). Built concurrently so a
-- large app.conversations table keeps accepting writes. If this migration fails, an INVALID index
-- can remain: drop it with `DROP INDEX CONCURRENTLY app.conversations_team_idx;` and run the
-- migrations again (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY conversations_team_idx
  ON app.conversations (tenant_id, team_id, status, last_message_at DESC NULLS LAST)
  WHERE team_id IS NOT NULL;
