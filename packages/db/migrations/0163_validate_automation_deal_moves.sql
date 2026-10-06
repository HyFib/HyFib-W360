-- 0163_validate_automation_deal_moves: validates the outcome check 0162 added NOT VALID (ADR-250).
-- Validation reads the table without blocking its writes.
ALTER TABLE app.automation_run_steps VALIDATE CONSTRAINT automation_run_steps_outcome_check;
