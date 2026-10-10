-- 0274_validate_webhook_store_order_message_sent_type: validates the event type check 0273
-- replaced NOT VALID (ADR-353). Validation reads the table without blocking its writes.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_type_check;
