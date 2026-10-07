-- 0214_validate_webhook_satisfaction_survey_event_type: validates the event type check 0213 replaced
-- NOT VALID (ADR-293). Validation reads the table without blocking its writes.
ALTER TABLE app.webhook_events VALIDATE CONSTRAINT webhook_events_type_check;
