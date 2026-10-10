-- 0281_validate_webhook_campaign_recipient_skipped_types: validates the event type check 0280
-- replaced NOT VALID (ADR-358). Validation reads the table without blocking its writes.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_type_check;
