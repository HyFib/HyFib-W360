-- A webhook OAuth client that signs JWTs can address them to another audience than its token URL
-- (P5-09, ADR-369).
--
-- Since 0286 and 0287 a client assertion names the token URL as its audience, which RFC 7523
-- section 3 allows: the token endpoint's URL may identify the authorization server. A server may
-- want another value that identifies it, such as its issuer identifier (a 2025 draft revising RFC
-- 7523 moves to it, as recalled here and not confirmed). The audience is an https URL HyFib never
-- fetches, kept only with a way that signs JWTs; null addresses the token URL, as before. The check
-- names each column, since a check that comes out null passes. A company has at most 10 endpoints,
-- so the check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN oauth_assertion_audience text,
  ADD CONSTRAINT webhook_endpoints_oauth_assertion_audience CHECK (
    oauth_assertion_audience IS NULL
    OR (char_length(oauth_assertion_audience) BETWEEN 9 AND 2048
        AND starts_with(oauth_assertion_audience, 'https://')
        AND oauth_token_url IS NOT NULL
        AND oauth_client_auth IN ('client_secret_jwt', 'private_key_jwt')));

-- The runtime role sets it when it changes the client (0025 grants updates column by column) and
-- when it adds an endpoint (its table grant); both roles read it through their table grants.
GRANT UPDATE (oauth_assertion_audience) ON app.webhook_endpoints TO w360_app;
