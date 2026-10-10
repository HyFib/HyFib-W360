-- 0277_validate_webhook_store_checkout_reminder_types: validates the event type check 0276
-- replaced NOT VALID (ADR-355). Validation reads the table without blocking its writes.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_type_check;
