-- 0298_validate_api_deal_items: validates what 0297 added NOT VALID (ADR-378). Validation reads the
-- table without blocking its writes.
ALTER TABLE app.crm_deal_items VALIDATE CONSTRAINT crm_deal_items_api_key_fk;
ALTER TABLE app.crm_deal_items VALIDATE CONSTRAINT crm_deal_items_creator;
