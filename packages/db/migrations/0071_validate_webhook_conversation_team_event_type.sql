-- Checks the events already stored against the type check 0070 added as NOT VALID (ADR-094).
-- VALIDATE takes a lock that lets events keep being captured while the table is read.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_type_check;
