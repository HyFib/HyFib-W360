-- 0170_validate_api_deal_writes: validates what 0169 added NOT VALID (ADR-254). Validation reads
-- the table without blocking its writes.
ALTER TABLE app.crm_deals VALIDATE CONSTRAINT crm_deals_created_by_api_key_fk;
ALTER TABLE app.crm_deals VALIDATE CONSTRAINT crm_deals_creator;
