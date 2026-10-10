-- 0267_validate_webhook_store_order_cod_event_type: validates the event type check 0266 replaced
-- NOT VALID (ADR-348). Validation reads the table without blocking its writes.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_type_check;
