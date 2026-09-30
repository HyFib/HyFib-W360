-- Checks the webhook events already stored against the type check 0047 added as NOT VALID (ADR-074).
-- VALIDATE takes a lock that lets captures keep writing while the table is read.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_type_check;
