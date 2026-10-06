-- Checks the events already stored against the check 0129 added as NOT VALID (ADR-182). They all
-- predate the columns, so none has tags; VALIDATE takes a lock that lets events keep being
-- captured while the table is read.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_tag_changes_check;
