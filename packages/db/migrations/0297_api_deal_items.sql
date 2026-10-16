-- Products on deals through the public API (P4-04, P5-08, ADR-378).
--
-- Items were added only by members (0294). A key with `deals.write` and `orders.read` can now add
-- them too: `created_by_api_key_id` names the key, as deals name theirs (0169), and an item is added
-- by a member or by a key, never both. The runtime role inserts items with every column (0294), so
-- it needs no new grant. The foreign key and the creator check are added NOT VALID, so
-- app.crm_deal_items is not read under this migration's lock: no item has a key yet. 0298 validates
-- them. A key is deleted only with its company, after its deals' items (ops.tenant_deletion_steps
-- 295 before 860), and the foreign key's check finds the company's keys through
-- UNIQUE (tenant_id, id).
ALTER TABLE app.crm_deal_items
  ALTER COLUMN created_by_membership_id DROP NOT NULL,
  ADD COLUMN created_by_api_key_id uuid,
  ADD CONSTRAINT crm_deal_items_api_key_fk FOREIGN KEY (tenant_id, created_by_api_key_id)
    REFERENCES app.api_keys (tenant_id, id) NOT VALID,
  ADD CONSTRAINT crm_deal_items_creator
    CHECK (num_nonnulls(created_by_membership_id, created_by_api_key_id) = 1) NOT VALID;
