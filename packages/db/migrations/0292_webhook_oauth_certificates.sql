-- A certificate for each key pair a webhook OAuth client signs with, when one is asked for (P5-09,
-- ADR-372).
--
-- Some authorization servers register a client's X.509 certificate rather than its bare public key
-- and find it by the thumbprint each assertion names: Microsoft Entra ID takes a certificate file
-- and reads the `x5t#S256` header (its certificate-credentials page). When a key pair is made, HyFib
-- can now make a self-signed certificate for it, signed with the pair's own private key. The pair
-- in use and the next pair (0288) each keep theirs as PEM, null for a pair made without one, and so
-- for every pair made before this migration. Each goes only with its public key, which it holds;
-- that it holds that key, and is a certificate at all, is checked where it is made and wherever it
-- is read, since a check cannot read a PEM. A certificate is public, like the key in it: it holds
-- the key and validity dates, never the private key. A company has at most 10 endpoints, so the
-- check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN oauth_certificate text,
  ADD COLUMN oauth_next_certificate text,
  ADD CONSTRAINT webhook_endpoints_oauth_certificate CHECK (
    (oauth_certificate IS NULL
     OR (oauth_public_key IS NOT NULL AND char_length(oauth_certificate) BETWEEN 1 AND 4000))
    AND (oauth_next_certificate IS NULL
         OR (oauth_next_public_key IS NOT NULL
             AND char_length(oauth_next_certificate) BETWEEN 1 AND 4000)));

-- The runtime role sets them when it changes the client (0025 grants updates column by column) and
-- when it adds an endpoint (its table grant).
GRANT UPDATE (oauth_certificate, oauth_next_certificate) ON app.webhook_endpoints TO w360_app;

-- 0291's lookup, replaced to return each key's certificate too, so the JWK Set names it (`x5c`,
-- `x5t`, `x5t#S256`): dropped as its owner, created again and handed back, as 0291 replaced 0290's.
-- Still only the public parts of a client that signs with a key pair, of a company not deleted; the
-- definer reads them through its table grant and policy (0025).
SET ROLE w360_definer;
DROP FUNCTION ops.webhook_oauth_jwks(text);
RESET ROLE;
CREATE FUNCTION ops.webhook_oauth_jwks(p_id text)
  RETURNS TABLE (public_key text, key_algorithm text, certificate text, next_public_key text,
                 next_key_algorithm text, next_certificate text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT e.oauth_public_key, e.oauth_key_algorithm, e.oauth_certificate, e.oauth_next_public_key,
         e.oauth_next_key_algorithm, e.oauth_next_certificate
    FROM app.webhook_endpoints e
    JOIN app.tenants t ON t.id = e.tenant_id
   WHERE p_id ~ '^[a-z2-7]{16}$' AND e.oauth_jwks_id = p_id
     AND e.oauth_client_auth = 'private_key_jwt' AND e.oauth_public_key IS NOT NULL
     AND t.status IN ('active', 'suspended', 'restricted')
$$;
REVOKE EXECUTE ON FUNCTION ops.webhook_oauth_jwks(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.webhook_oauth_jwks(text) TO w360_app;
ALTER FUNCTION ops.webhook_oauth_jwks(text) OWNER TO w360_definer;
