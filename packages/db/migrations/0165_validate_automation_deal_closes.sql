-- 0165_validate_automation_deal_closes: validates the outcome check 0164 added NOT VALID (ADR-251).
-- Validation reads the table without blocking its writes.
ALTER TABLE app.automation_run_steps VALIDATE CONSTRAINT automation_run_steps_outcome_check;
