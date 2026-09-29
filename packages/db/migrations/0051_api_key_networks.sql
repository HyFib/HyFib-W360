-- 0051_api_key_networks: the addresses an API key accepts requests from (P5-08, ADR-076). A key may
-- list up to 20 IPv4 or IPv6 networks; NULL accepts any address. The authentication function now
-- takes the request's address and says whether the key accepts it, and a refused request does not
-- mark the key used.

ALTER TABLE app.api_keys
  ADD COLUMN allowed_networks cidr[]
    CONSTRAINT api_keys_allowed_networks_check
    CHECK (allowed_networks IS NULL
      OR (cardinality(allowed_networks) BETWEEN 1 AND 20
          AND array_position(allowed_networks, NULL) IS NULL));

-- Set when a key is created (the table's insert grant), changed by members who manage keys. The
-- definer functions read it through their table-wide select.
GRANT SELECT (allowed_networks), UPDATE (allowed_networks) ON app.api_keys TO w360_app;

-- Finds the key a request presents by its token's SHA-256, as the one-argument function of 0024
-- did: nothing for an unknown, revoked or expired key, or for a company being deleted. A key that
-- lists networks accepts only an address inside one of them (an address that could not be
-- determined is refused); for any other address the key is returned with address_allowed false and
-- is not marked used.
CREATE FUNCTION ops.api_key_authenticate(p_token_hash text, p_client_ip inet)
  RETURNS TABLE (key_id uuid, tenant_id uuid, scopes text[], tenant_status text,
                 address_allowed boolean)
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
    RETURN QUERY SELECT v_id, v_tenant, v_scopes, v_status, false;
    RETURN;
  END IF;
  IF v_used IS NULL OR v_used < now() - interval '1 minute' THEN
    UPDATE app.api_keys SET last_used_at = now()
     WHERE id = (SELECT k.id FROM app.api_keys k
                  WHERE k.id = v_id AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute')
                  FOR UPDATE SKIP LOCKED);
  END IF;
  RETURN QUERY SELECT v_id, v_tenant, v_scopes, v_status, true;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.api_key_authenticate(text, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.api_key_authenticate(text, inet) TO w360_app;
ALTER FUNCTION ops.api_key_authenticate(text, inet) OWNER TO w360_definer;

-- The web app of the previous release calls the one-argument function while a deploy rolls out. It
-- cannot check an address, so it now refuses every key that lists networks; a later release drops
-- it.
DROP FUNCTION ops.api_key_authenticate(text);
CREATE FUNCTION ops.api_key_authenticate(p_token_hash text)
  RETURNS TABLE (key_id uuid, tenant_id uuid, scopes text[], tenant_status text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  RETURN QUERY SELECT a.key_id, a.tenant_id, a.scopes, a.tenant_status
    FROM ops.api_key_authenticate(p_token_hash, NULL::inet) a
   WHERE a.address_allowed;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.api_key_authenticate(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.api_key_authenticate(text) TO w360_app;
ALTER FUNCTION ops.api_key_authenticate(text) OWNER TO w360_definer;
