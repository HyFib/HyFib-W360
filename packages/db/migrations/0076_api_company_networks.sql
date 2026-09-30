-- Networks for all of a company's API keys (P5-08, ADR-099). A key can list the networks it accepts
-- requests from (ADR-076, migration 0051), but a company that wants every key held to its own
-- servers had to set each key, and a key created without networks escaped. Owners and
-- administrators can now list up to 20 networks for the whole company: a request must come from
-- one of them, and from one of its key's own networks when the key lists any.

-- One row per company, made when networks are first set; NULL networks accept any address.
CREATE TABLE app.api_settings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  allowed_networks cidr[]
    CONSTRAINT api_settings_allowed_networks_check
    CHECK (allowed_networks IS NULL
      OR (cardinality(allowed_networks) BETWEEN 1 AND 20
          AND array_position(allowed_networks, NULL) IS NULL)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id)
);
SELECT ops.apply_tenant_rls('app.api_settings');
GRANT SELECT, INSERT ON app.api_settings TO w360_app;
GRANT UPDATE (allowed_networks, updated_at) ON app.api_settings TO w360_app;

-- Deleted with the company (ADR-055), with its keys.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (857, ARRAY['app.api_settings']::regclass[], 'whole');
GRANT SELECT (tenant_id, id, allowed_networks), DELETE ON app.api_settings TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.api_settings FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.api_settings FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
-- The authentication function reads any company's networks, for the key a request presents.
CREATE POLICY definer_read ON app.api_settings FOR SELECT TO w360_definer USING (true);

-- The lookup of 0051, which now also checks the company's networks, after the key's own and before
-- the key is marked used, and says which list refused the address (refused_by: 'key' or
-- 'company'). The migration role owns the schema, so it drops the function; it creates the new one
-- and grants before handing it to w360_definer. Web servers of the previous release select the
-- columns they know by name, so they keep working during a rolling deploy.
DROP FUNCTION ops.api_key_authenticate(text, inet);
CREATE FUNCTION ops.api_key_authenticate(p_token_hash text, p_client_ip inet)
  RETURNS TABLE (key_id uuid, tenant_id uuid, scopes text[], tenant_status text,
                 address_allowed boolean, refused_by text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_id uuid;
  v_tenant uuid;
  v_scopes text[];
  v_expires timestamptz;
  v_revoked timestamptz;
  v_used timestamptz;
  v_networks cidr[];
  v_company_networks cidr[];
  v_status text;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT k.id, k.tenant_id, k.scopes, k.expires_at, k.revoked_at, k.last_used_at, k.allowed_networks
    INTO v_id, v_tenant, v_scopes, v_expires, v_revoked, v_used, v_networks
    FROM app.api_keys k WHERE k.token_hash = p_token_hash;
  IF NOT FOUND OR v_revoked IS NOT NULL OR (v_expires IS NOT NULL AND v_expires <= now()) THEN
    RETURN;
  END IF;
  SELECT t.status INTO v_status FROM app.tenants t WHERE t.id = v_tenant;
  IF v_status IS NULL OR v_status IN ('pending_deletion', 'deleted') THEN
    RETURN;
  END IF;
  IF v_networks IS NOT NULL
     AND (p_client_ip IS NULL OR NOT p_client_ip <<= ANY (v_networks::inet[])) THEN
    RETURN QUERY SELECT v_id, v_tenant, v_scopes, v_status, false, 'key'::text;
    RETURN;
  END IF;
  SELECT s.allowed_networks INTO v_company_networks
    FROM app.api_settings s WHERE s.tenant_id = v_tenant;
  IF v_company_networks IS NOT NULL
     AND (p_client_ip IS NULL OR NOT p_client_ip <<= ANY (v_company_networks::inet[])) THEN
    RETURN QUERY SELECT v_id, v_tenant, v_scopes, v_status, false, 'company'::text;
    RETURN;
  END IF;
  IF v_used IS NULL OR v_used < now() - interval '1 minute' THEN
    UPDATE app.api_keys SET last_used_at = now()
     WHERE id = (SELECT k.id FROM app.api_keys k
                  WHERE k.id = v_id AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute')
                  FOR UPDATE SKIP LOCKED);
  END IF;
  RETURN QUERY SELECT v_id, v_tenant, v_scopes, v_status, true, NULL::text;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.api_key_authenticate(text, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.api_key_authenticate(text, inet) TO w360_app;
ALTER FUNCTION ops.api_key_authenticate(text, inet) OWNER TO w360_definer;
