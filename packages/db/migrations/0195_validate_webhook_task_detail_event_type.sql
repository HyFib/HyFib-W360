-- 0195_validate_webhook_task_detail_event_type: validates the event type check 0194 replaced
-- NOT VALID (ADR-276). Validation reads the table without blocking its writes.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_type_check;
