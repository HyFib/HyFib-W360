-- 0160_automation_deals: CRM deals that automations create (P4-01, P4-04, ADR-245).
--
-- As for tasks (0158), a deal is created either by a member or by a run of an automation:
-- `created_by_automation_id` names the automation (the deal's activity names the run). The check
-- that exactly one creator is set and the foreign key to the automation are added NOT VALID, so
-- adding them does not read the table while holding its lock; 0161 validates them. New rows are
-- checked from now on.
ALTER TABLE app.crm_deals ADD COLUMN created_by_automation_id uuid;
ALTER TABLE app.crm_deals ALTER COLUMN created_by_membership_id DROP NOT NULL;
ALTER TABLE app.crm_deals
  ADD CONSTRAINT crm_deals_created_by_automation_fk FOREIGN KEY (tenant_id, created_by_automation_id)
    REFERENCES app.automations (tenant_id, id) NOT VALID;
ALTER TABLE app.crm_deals
  ADD CONSTRAINT crm_deals_creator
    CHECK (num_nonnulls(created_by_membership_id, created_by_automation_id) = 1) NOT VALID;
