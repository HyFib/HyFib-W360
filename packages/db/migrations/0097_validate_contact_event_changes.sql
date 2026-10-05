-- Checks the events already stored against the check 0096 added as NOT VALID (ADR-121). They all
-- predate the column, so none has changes; VALIDATE takes a lock that lets events keep being
-- captured while the table is read.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_contact_changes_check;
