-- Monthly request limits per API key (P5-08, ADR-097). A company's plan limits the API requests of
-- the whole company in a month (ADR-061), so one integration could use up what every other
-- integration needs, and nobody could see which key used what. Every request the API admits is now
-- also counted for the key that made it, in the company's usage period, and a key can be given a
-- monthly limit of its own: the key's count is checked before the company's, in the same
-- transaction, and a request refused by either counts for neither.

-- The key's own monthly limit; null when only the company's plan limits it. Owners and
-- administrators set it when creating the key and change it later; a rotated key's successor
-- keeps it.
ALTER TABLE app.api_keys
  ADD COLUMN monthly_request_limit integer
    CHECK (monthly_request_limit BETWEEN 1 AND 1000000000);
GRANT SELECT (monthly_request_limit), UPDATE (monthly_request_limit) ON app.api_keys TO w360_app;

-- One row per key and usage period (the company's, so a key's month is the plan's month),
-- incremented atomically below the key's limit, like app.usage_counters for the company.
CREATE TABLE app.api_key_usage (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  api_key_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  used integer NOT NULL CHECK (used >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, api_key_id, period_start),
  CONSTRAINT api_key_usage_key_fk FOREIGN KEY (tenant_id, api_key_id)
    REFERENCES app.api_keys (tenant_id, id)
);
SELECT ops.apply_tenant_rls('app.api_key_usage');
GRANT SELECT, INSERT ON app.api_key_usage TO w360_app;
GRANT UPDATE (used) ON app.api_key_usage TO w360_app;

-- Deleted with the company (ADR-055), before its keys.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (855, ARRAY['app.api_key_usage']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.api_key_usage TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.api_key_usage FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.api_key_usage FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
