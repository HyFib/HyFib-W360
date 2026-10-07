-- 0176_validate_api_task_writes: validates what 0175 added NOT VALID (ADR-259). Validation reads
-- the table without blocking its writes.
ALTER TABLE app.crm_tasks VALIDATE CONSTRAINT crm_tasks_created_by_api_key_fk;
ALTER TABLE app.crm_tasks VALIDATE CONSTRAINT crm_tasks_creator;
