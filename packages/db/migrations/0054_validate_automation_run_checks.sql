-- Checks the runs already stored against the trigger type check, the key check and the foreign key
-- 0052 added as NOT VALID (ADR-077). VALIDATE takes a lock that lets runs keep being written while
-- the table is read.
ALTER TABLE app.automation_runs VALIDATE CONSTRAINT automation_runs_trigger_type_check;
ALTER TABLE app.automation_runs VALIDATE CONSTRAINT automation_runs_api_key;
ALTER TABLE app.automation_runs VALIDATE CONSTRAINT automation_runs_api_key_fk;
