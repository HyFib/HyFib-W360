-- 0186_validate_webhook_deal_owner_event_type: validates the event type check 0185 replaced
-- NOT VALID (ADR-269). Validation reads the table without blocking its writes.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_type_check;
