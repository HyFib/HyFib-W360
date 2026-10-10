-- 0271_validate_webhook_store_order_message_skipped_type: validates the event type check 0270
-- replaced NOT VALID (ADR-351). Validation reads the table without blocking its writes.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_type_check;
