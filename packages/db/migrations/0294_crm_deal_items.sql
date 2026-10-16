-- Products on deals (P4-04, ADR-375).
--
-- A deal named what it was for only in its title. Members who change deals can now list products
-- from the company's WhatsApp catalogs on a deal, each with a quantity and a unit price in the
-- deal's currency as it was when the product was added. The product's name is kept as it was then,
-- so a deal still shows what was quoted after the catalog renames or removes the product. Deals and
-- catalog products are deleted only with the company, so an item references both without actions.
CREATE TABLE app.crm_deal_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  deal_id uuid NOT NULL,
  product_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 500),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  -- Exact, in the minor unit of `currency`, as deal values are (0013).
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor BETWEEN 0 AND 1000000000000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_deal_items_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT crm_deal_items_deal_fk FOREIGN KEY (tenant_id, deal_id)
    REFERENCES app.crm_deals (tenant_id, id),
  CONSTRAINT crm_deal_items_product_fk FOREIGN KEY (tenant_id, product_id)
    REFERENCES app.commerce_products (tenant_id, id),
  CONSTRAINT crm_deal_items_creator_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
-- A deal's items in the order they were added.
CREATE INDEX crm_deal_items_deal_idx ON app.crm_deal_items (tenant_id, deal_id, created_at, id);
-- The product key is checked when a product's row is deleted, which only company deletion does.
CREATE INDEX crm_deal_items_product_idx ON app.crm_deal_items (tenant_id, product_id);
SELECT ops.apply_tenant_rls('app.crm_deal_items');
-- Items are added and removed, never changed.
GRANT SELECT, INSERT, DELETE ON app.crm_deal_items TO w360_app;

-- Deleted with the company (ADR-055), a batch at a time, before its deals (300) and the catalog's
-- products (570) they reference.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (295, ARRAY['app.crm_deal_items']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.crm_deal_items TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.crm_deal_items FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.crm_deal_items FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
