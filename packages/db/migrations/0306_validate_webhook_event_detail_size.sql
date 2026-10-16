-- 0306_validate_webhook_event_detail_size: validates the event detail check 0305 widened NOT VALID
-- (ADR-390). Validation reads the table without blocking its writes.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_detail_check;
