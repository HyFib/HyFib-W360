-- 0260_validate_idempotent_answers: validates the check on kept answers 0259 replaced NOT VALID
-- (ADR-339). Validation reads the table without blocking its writes.
ALTER TABLE app.api_idempotency_keys VALIDATE CONSTRAINT api_idempotency_keys_response_check;
