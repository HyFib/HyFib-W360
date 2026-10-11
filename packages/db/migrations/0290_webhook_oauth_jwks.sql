-- A public JWKS URL for each webhook OAuth client that signs with a key pair (P5-09, ADR-370).
--
-- Since 0287 and 0288 a client set to private_key_jwt signs with a key pair HyFib keeps, and may
-- hold a next pair; the company copies each public key into its authorization server. A server can
-- instead fetch a client's keys from a URL (the JWK Set document of RFC 7517 at the client's
-- `jwks_uri`, RFC 7591 section 2, as known; the texts could not be opened from here), so HyFib
-- serves one per client: the public key in use and the next one, nothing else. The URL names the
-- client by a random public id of 16 base32 characters (80 bits, as widget and flow ids), never the
-- company or the endpoint, so it reveals neither and cannot be guessed; it goes only with a client
-- that signs with a key pair, made with its first pair and kept while it signs with one. A client
-- set to that way before this migration gets its id at its next change: there is no backfill, since
-- the role running migrations has no policy on the table and row security is forced, so its update
-- would change no row. A company has at most 10 endpoints, so the check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN oauth_jwks_id text,
  ADD CONSTRAINT webhook_endpoints_oauth_jwks_id CHECK (
    oauth_jwks_id IS NULL
    OR (oauth_jwks_id ~ '^[a-z2-7]{16}$'
        AND oauth_client_auth = 'private_key_jwt'
        AND oauth_public_key IS NOT NULL)),
  ADD CONSTRAINT webhook_endpoints_oauth_jwks_id_uq UNIQUE (oauth_jwks_id);

-- The runtime role sets it when it changes the client (0025 grants updates column by column) and
-- when it adds an endpoint (its table grant).
GRANT UPDATE (oauth_jwks_id) ON app.webhook_endpoints TO w360_app;

-- The public keys a JWKS id names, for the public route, which has no company to scope a read to:
-- only the public key in use and the next one, of a client that signs with a key pair, of a company
-- not deleted. The definer reads them through its table grant and policy (0025).
CREATE FUNCTION ops.webhook_oauth_jwks(p_id text)
  RETURNS TABLE (public_key text, next_public_key text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT e.oauth_public_key, e.oauth_next_public_key
    FROM app.webhook_endpoints e
    JOIN app.tenants t ON t.id = e.tenant_id
   WHERE p_id ~ '^[a-z2-7]{16}$' AND e.oauth_jwks_id = p_id
     AND e.oauth_client_auth = 'private_key_jwt' AND e.oauth_public_key IS NOT NULL
     AND t.status IN ('active', 'suspended', 'restricted')
$$;
REVOKE EXECUTE ON FUNCTION ops.webhook_oauth_jwks(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.webhook_oauth_jwks(text) TO w360_app;
ALTER FUNCTION ops.webhook_oauth_jwks(text) OWNER TO w360_definer;
