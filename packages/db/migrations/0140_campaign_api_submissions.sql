-- 0140_campaign_api_submissions: submitting campaign drafts through the public API (P5-08,
-- ADR-202). A key with `campaigns.write` submits a draft with members' checks, and its submission
-- always waits for a member's approval: a key never starts a campaign. A submission now records the
-- key that made it, or the member as before: never both (a draft has neither). The runtime role sets
-- the new column through a column grant, as it sets `submitted_by_user_id` (0006).

-- The check and the foreign key are added NOT VALID, so app.campaigns is not read under this
-- migration's lock: no campaign has a key yet. 0141 validates them. A key is deleted only with its
-- company, after its campaigns (ops.tenant_deletion_steps 710 before 860), and the foreign key's
-- check finds the company's campaigns through UNIQUE (tenant_id, id).
ALTER TABLE app.campaigns
  ADD COLUMN submitted_by_api_key_id uuid,
  ADD CONSTRAINT campaigns_one_submitter
    CHECK (submitted_by_user_id IS NULL OR submitted_by_api_key_id IS NULL) NOT VALID,
  ADD CONSTRAINT campaigns_submitted_by_api_key_fk FOREIGN KEY (tenant_id, submitted_by_api_key_id)
    REFERENCES app.api_keys (tenant_id, id) NOT VALID;

GRANT UPDATE (submitted_by_api_key_id) ON app.campaigns TO w360_app;
