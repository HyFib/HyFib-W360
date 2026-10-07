-- 0193_validate_webhook_deal_detail_event_type: validates the event type check 0192 replaced
-- NOT VALID (ADR-275). Validation reads the table without blocking its writes.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_type_check;
