-- 0205_validate_webhook_payment_link_event_type: validates the event type check 0204 replaced NOT
-- VALID (ADR-285). Validation reads the table without blocking its writes.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_type_check;
