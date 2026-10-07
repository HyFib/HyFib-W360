-- 0159_validate_automation_tasks: validates what 0158 added NOT VALID (ADR-244). Validation reads
-- the tables without blocking their writes.
ALTER TABLE app.crm_tasks VALIDATE CONSTRAINT crm_tasks_created_by_automation_fk;
ALTER TABLE app.crm_tasks VALIDATE CONSTRAINT crm_tasks_creator;
ALTER TABLE app.automation_run_steps VALIDATE CONSTRAINT automation_run_steps_outcome_check;
