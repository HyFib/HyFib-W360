-- 0312_validate_automation_run_enrollment: validates what 0311 added NOT VALID (ADR-401), as 0054
-- validated 0052's. Validation reads app.automation_runs without blocking its writes; every row
-- written since 0311 was checked when written.
ALTER TABLE app.automation_runs VALIDATE CONSTRAINT automation_runs_api_key;
ALTER TABLE app.automation_runs VALIDATE CONSTRAINT automation_runs_enrollment_fk;
