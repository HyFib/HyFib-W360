-- 0161_validate_automation_deals: validates what 0160 added NOT VALID (ADR-245). Validation reads
-- the table without blocking its writes.
ALTER TABLE app.crm_deals VALIDATE CONSTRAINT crm_deals_created_by_automation_fk;
ALTER TABLE app.crm_deals VALIDATE CONSTRAINT crm_deals_creator;
