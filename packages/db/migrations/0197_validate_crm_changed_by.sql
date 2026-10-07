-- 0197_validate_crm_changed_by: validates the foreign keys and checks 0196 added NOT VALID
-- (ADR-277). Validation reads each table without blocking its writes.
ALTER TABLE app.crm_deals VALIDATE CONSTRAINT crm_deals_changed_by_api_key_fk;
ALTER TABLE app.crm_deals VALIDATE CONSTRAINT crm_deals_changed_by;
ALTER TABLE app.crm_tasks VALIDATE CONSTRAINT crm_tasks_changed_by_api_key_fk;
ALTER TABLE app.crm_tasks VALIDATE CONSTRAINT crm_tasks_changed_by;
