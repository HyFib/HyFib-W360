-- The algorithm a webhook OAuth client that signs with a key pair signs with (P5-09, ADR-371).
--
-- Since 0287 such a client signs RS256 with an RSA key pair HyFib makes. Some authorization servers
-- take other algorithms only: a FAPI profile, for one, refuses RS256 and takes PS256 or ES256 (as
-- recalled; the texts could not be opened from here). A key pair now carries the algorithm chosen
-- when it is made (RFC 7518 section 3): RS256 or PS256 with an RSA key of 2048 bits, or ES256 with
-- an elliptic-curve key on P-256. The pair in use and the next pair (0288) each name theirs, null
-- for a pair made before this migration, which signs RS256 as it did. Each goes only with its public
-- key; the key's kind is checked where the pair is made and where it is opened, since a check cannot
-- read a PEM. A company has at most 10 endpoints, so the check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN oauth_key_algorithm text,
  ADD COLUMN oauth_next_key_algorithm text,
  ADD CONSTRAINT webhook_endpoints_oauth_key_algorithm CHECK (
    (oauth_key_algorithm IS NULL
     OR (oauth_key_algorithm IN ('RS256', 'PS256', 'ES256') AND oauth_public_key IS NOT NULL))
    AND (oauth_next_key_algorithm IS NULL
         OR (oauth_next_key_algorithm IN ('RS256', 'PS256', 'ES256')
             AND oauth_next_public_key IS NOT NULL)));

-- The runtime role sets them when it changes the client (0025 grants updates column by column) and
-- when it adds an endpoint (its table grant).
GRANT UPDATE (oauth_key_algorithm, oauth_next_key_algorithm) ON app.webhook_endpoints TO w360_app;

-- 0290's lookup, replaced to name each public key's algorithm, so the JWK Set says how each key
-- signs: dropped as its owner, created again and handed back, as 0288 replaced 0287's function.
-- Still only the public keys and their algorithms, of a client that signs with a key pair, of a
-- company not deleted; the definer reads them through its table grant and policy (0025).
SET ROLE w360_definer;
DROP FUNCTION ops.webhook_oauth_jwks(text);
RESET ROLE;
CREATE FUNCTION ops.webhook_oauth_jwks(p_id text)
  RETURNS TABLE (public_key text, key_algorithm text, next_public_key text,
                 next_key_algorithm text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT e.oauth_public_key, e.oauth_key_algorithm, e.oauth_next_public_key,
         e.oauth_next_key_algorithm
    FROM app.webhook_endpoints e
    JOIN app.tenants t ON t.id = e.tenant_id
   WHERE p_id ~ '^[a-z2-7]{16}$' AND e.oauth_jwks_id = p_id
     AND e.oauth_client_auth = 'private_key_jwt' AND e.oauth_public_key IS NOT NULL
     AND t.status IN ('active', 'suspended', 'restricted')
$$;
REVOKE EXECUTE ON FUNCTION ops.webhook_oauth_jwks(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.webhook_oauth_jwks(text) TO w360_app;
ALTER FUNCTION ops.webhook_oauth_jwks(text) OWNER TO w360_definer;
