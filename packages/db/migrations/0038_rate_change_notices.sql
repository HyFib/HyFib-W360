-- A notice before Meta's rates change (ADR-065).

-- One row per company and published rate card the company's billing managers were told about,
-- written in the transaction that queues the email, so each card is announced to a company once.
CREATE TABLE app.rate_change_notices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  rate_card_id uuid NOT NULL REFERENCES ops.rate_cards (id),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_change_notices_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT rate_change_notices_card_uq UNIQUE (tenant_id, rate_card_id)
);
CREATE TRIGGER rate_change_notices_append_only BEFORE UPDATE ON app.rate_change_notices
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
SELECT ops.apply_tenant_rls('app.rate_change_notices');
GRANT SELECT, INSERT ON app.rate_change_notices TO w360_app;

-- Deleted with the company (ADR-055): after its usage counters.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (75, ARRAY['app.rate_change_notices']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.rate_change_notices TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.rate_change_notices FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.rate_change_notices FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- What the listing below reads as w360_definer: which card each company was told about, each
-- company's billing currency, and published cards.
GRANT SELECT (rate_card_id) ON app.rate_change_notices TO w360_definer;
CREATE POLICY definer_read ON app.rate_change_notices FOR SELECT TO w360_definer USING (true);
GRANT SELECT (tenant_id, cost_currency) ON app.messaging_settings TO w360_definer;
CREATE POLICY definer_read ON app.messaging_settings FOR SELECT TO w360_definer USING (true);
GRANT SELECT (id, currency, status, effective_from) ON ops.rate_cards TO w360_definer;
CREATE POLICY definer_read ON ops.rate_cards FOR SELECT TO w360_definer
  USING (status = 'published');

-- Companies to tell about a published card for their billing currency that takes effect within
-- `p_days` days (ids only, for the minute sweep): active companies only, each card once. A card
-- already in force is not announced.
CREATE FUNCTION ops.rate_change_notices_due(p_limit integer, p_days integer)
  RETURNS TABLE (tenant_id uuid, rate_card_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, c.id
    FROM ops.rate_cards c
    JOIN app.messaging_settings s ON s.cost_currency = c.currency
    JOIN app.tenants t ON t.id = s.tenant_id AND t.status = 'active'
   WHERE c.status = 'published'
     AND c.effective_from > now()
     AND c.effective_from <= now() + make_interval(days => least(greatest(coalesce(p_days, 7), 1), 31))
     AND NOT EXISTS (SELECT 1 FROM app.rate_change_notices n
                      WHERE n.tenant_id = s.tenant_id AND n.rate_card_id = c.id)
   ORDER BY c.effective_from, s.tenant_id
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000)
$$;
REVOKE EXECUTE ON FUNCTION ops.rate_change_notices_due(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.rate_change_notices_due(integer, integer) TO w360_app;
ALTER FUNCTION ops.rate_change_notices_due(integer, integer) OWNER TO w360_definer;
