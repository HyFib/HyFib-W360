-- 0317_campaign_variants: A/B template variants for campaigns (P3-04, ADR-405).
--
-- A campaign draft may add a variant B: a second template of the campaign's number's WhatsApp
-- account, with its own variable mapping, sent to a share of the recipients the member chooses
-- (10% to 90% in steps of 5). The campaign's own template and mapping are variant A, which gets the
-- rest. A campaign without a variant row behaves as before. The table holds the variants after A,
-- one row each, labelled B to Z, so more variants need no new table; HyFib builds two.
--
-- When the audience is taken, each recipient is given its variant from a stable hash of the
-- campaign and the contact (packages/domain/src/campaigns/variants.ts) and the variant is recorded
-- on its recipient row. The runtime role inserts recipients but holds no UPDATE on `variant`, so a
-- recorded variant never changes; a retry or restart of the runner reads it from the row.

-- The variant each recipient was given when the audience was taken: A for every recipient of a
-- campaign without variants, and for every row already there. Altered first, before the new
-- table's foreign key locks app.campaigns, so this migration takes the recipients' lock before the
-- campaigns' one, never after it (a runner tick updates recipients, then its campaign). A constant
-- default adds the column without rewriting the table; the check is added NOT VALID so
-- app.campaign_recipients is not read under this migration's lock, and 0318 validates it without
-- blocking writes. No UPDATE is granted on the column: it is written once, with the snapshot.
ALTER TABLE app.campaign_recipients
  ADD COLUMN variant text NOT NULL DEFAULT 'A',
  ADD CONSTRAINT campaign_recipients_variant CHECK (variant ~ '^[A-Z]$') NOT VALID;

CREATE TABLE app.campaign_variants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  -- B for the second template; A is the campaign's own template and mapping.
  label text NOT NULL CHECK (label ~ '^[B-Z]$'),
  -- NULL while the draft has no template for it yet (as app.campaigns.template_id).
  template_id uuid,
  -- How each of its template's variables is filled, as app.campaigns.variables (0006).
  variables jsonb NOT NULL DEFAULT '{"header": [], "body": []}'::jsonb
    CHECK (jsonb_typeof(variables) = 'object' AND pg_column_size(variables) <= 8192),
  -- Its share of the recipients, in percent.
  share_percent smallint NOT NULL CHECK (share_percent BETWEEN 10 AND 90 AND share_percent % 5 = 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_variants_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT campaign_variants_label_uq UNIQUE (tenant_id, campaign_id, label),
  CONSTRAINT campaign_variants_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES app.campaigns (tenant_id, id),
  -- The company's own template only: another company's template id matches no row.
  CONSTRAINT campaign_variants_template_fk FOREIGN KEY (tenant_id, template_id)
    REFERENCES app.message_templates (tenant_id, id)
);
-- The template foreign key's lookups (a new, empty table: built in this transaction).
CREATE INDEX campaign_variants_template_idx ON app.campaign_variants (tenant_id, template_id)
  WHERE template_id IS NOT NULL;
CREATE TRIGGER campaign_variants_touch BEFORE UPDATE ON app.campaign_variants
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
SELECT ops.apply_tenant_rls('app.campaign_variants');
-- Members and keys add, change and remove a draft's variant (the service allows it on drafts only).
GRANT SELECT, INSERT, DELETE ON app.campaign_variants TO w360_app;
GRANT UPDATE (template_id, variables, share_percent, updated_at) ON app.campaign_variants TO w360_app;

-- Deleted with the company (ADR-055): after the messages (700) and before the campaigns (710) and
-- templates (730) the variants name.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (705, ARRAY['app.campaign_variants']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.campaign_variants TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.campaign_variants FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.campaign_variants FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
