-- migrate:no-transaction
-- A contact's rows in every campaign (ADR-224): a merge locks and moves them, and resolves the
-- campaigns both contacts were in, without reading the company's whole recipient list. Built
-- concurrently so campaigns keep writing recipients. If this migration fails, an INVALID index can
-- remain: drop it with `DROP INDEX CONCURRENTLY app.campaign_recipients_contact_idx;` and run the
-- migrations again (docs/RUNBOOKS.md).
CREATE INDEX CONCURRENTLY campaign_recipients_contact_idx
  ON app.campaign_recipients (tenant_id, contact_id);
