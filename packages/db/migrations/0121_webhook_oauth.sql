-- OAuth 2.0 client credentials for webhook endpoints (P5-09, ADR-173).
--
-- An endpoint's receiver may want an access token from its authorization server with every
-- delivery instead of a fixed header. An endpoint can now name the token endpoint, a client
-- identifier and secret and, if wanted, a scope: the worker asks for a token (RFC 6749 section 4.4,
-- through the egress client) and sends it as a bearer token. Tokens are kept in the worker's memory
-- only, never stored. The secret is sealed with the keyring (`webhook-oauth-secret:<company>:
-- <endpoint>`), like the endpoint's own headers, and only the services write these columns. They
-- are set together or not at all (each named as not null, since a check that comes out null
-- passes); the scope is optional. A company has at most 10 endpoints, so the table is small and the
-- check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN oauth_token_url text,
  ADD COLUMN oauth_client_id text,
  ADD COLUMN oauth_client_secret_ciphertext text,
  ADD COLUMN oauth_scope text,
  ADD CONSTRAINT webhook_endpoints_oauth CHECK (
    (oauth_token_url IS NULL AND oauth_client_id IS NULL AND oauth_client_secret_ciphertext IS NULL
     AND oauth_scope IS NULL)
    OR (oauth_token_url IS NOT NULL AND oauth_client_id IS NOT NULL
        AND oauth_client_secret_ciphertext IS NOT NULL
        AND char_length(oauth_token_url) BETWEEN 1 AND 2048
        AND char_length(oauth_client_id) BETWEEN 1 AND 200
        AND (oauth_scope IS NULL OR char_length(oauth_scope) BETWEEN 1 AND 500)));

-- The runtime role sets them when it adds an endpoint (its table grant) and changes them (0025
-- grants updates column by column). Both roles read them through their table grants: the worker,
-- as the runtime role, opens the secret for its token requests.
GRANT UPDATE (oauth_token_url, oauth_client_id, oauth_client_secret_ciphertext, oauth_scope)
  ON app.webhook_endpoints TO w360_app;

-- 0101's lookup of sealed values with the OAuth client secrets, so the keyring sweep re-encrypts
-- them under the primary key and the operations console counts them. The definer reads them
-- through its table grant (0025). Replaced as 0104 replaces definer functions: dropped as its
-- owner, created again and handed back.
SET ROLE w360_definer;
DROP FUNCTION ops.sealed_value_keys();
RESET ROLE;
CREATE FUNCTION ops.sealed_value_keys()
  RETURNS TABLE (kind text, tenant_id uuid, id uuid, key_id text)
  LANGUAGE sql STABLE
  AS $$
  SELECT v.kind, v.tenant_id, v.id,
         CASE WHEN starts_with(v.head, 'v1:') THEN split_part(v.head, ':', 2) END
    FROM (
      SELECT 'whatsapp_token'::text, w.tenant_id, w.id, substr(w.credential_ciphertext, 1, 40)
        FROM app.whatsapp_accounts w WHERE w.credential_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'registration_pin', c.tenant_id, c.id, substr(c.registration_pin_ciphertext, 1, 40)
        FROM app.channel_accounts c WHERE c.registration_pin_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'http_secret', h.tenant_id, h.id, substr(h.value_ciphertext, 1, 40)
        FROM app.http_secrets h
      UNION ALL
      SELECT 'http_request', r.tenant_id, r.id, substr(r.request_ciphertext, 1, 40)
        FROM app.automation_http_calls r
       WHERE r.request_ciphertext IS NOT NULL AND r.state IN ('queued', 'in_flight')
      UNION ALL
      SELECT 'payment_key_secret', p.tenant_id, p.id, substr(p.key_secret_ciphertext, 1, 40)
        FROM app.commerce_payment_accounts p
      UNION ALL
      SELECT 'payment_webhook_secret', p.tenant_id, p.id, substr(p.webhook_secret_ciphertext, 1, 40)
        FROM app.commerce_payment_accounts p
      UNION ALL
      SELECT 'flow_private_key', f.tenant_id, f.id, substr(f.private_key_ciphertext, 1, 40)
        FROM app.flow_keys f WHERE f.private_key_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'store_credentials', s.tenant_id, s.id, substr(s.credentials_ciphertext, 1, 40)
        FROM app.commerce_stores s WHERE s.credentials_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'store_webhook_secret', s.tenant_id, s.id, substr(s.webhook_secret_ciphertext, 1, 40)
        FROM app.commerce_stores s WHERE s.webhook_secret_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'store_access_code', s.tenant_id, s.id, substr(s.access_code_ciphertext, 1, 40)
        FROM app.commerce_stores s WHERE s.access_code_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'webhook_secret', e.tenant_id, e.id, substr(e.secret_ciphertext, 1, 40)
        FROM app.webhook_endpoints e
      UNION ALL
      SELECT 'webhook_previous_secret', e.tenant_id, e.id,
             substr(e.previous_secret_ciphertext, 1, 40)
        FROM app.webhook_endpoints e WHERE e.previous_secret_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'webhook_headers', e.tenant_id, e.id, substr(e.headers_ciphertext, 1, 40)
        FROM app.webhook_endpoints e WHERE e.headers_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'webhook_oauth_secret', e.tenant_id, e.id,
             substr(e.oauth_client_secret_ciphertext, 1, 40)
        FROM app.webhook_endpoints e WHERE e.oauth_client_secret_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'provider_receipt', NULL::uuid, b.id, substr(b.body_ciphertext, 1, 40)
        FROM ops.webhook_receipts b WHERE b.body_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'queued_email', NULL::uuid, m.id, substr(m.payload_ciphertext, 1, 40)
        FROM ops.email_outbox m WHERE m.payload_ciphertext IS NOT NULL
    ) v (kind, tenant_id, id, head)
$$;
REVOKE EXECUTE ON FUNCTION ops.sealed_value_keys() FROM PUBLIC;
ALTER FUNCTION ops.sealed_value_keys() OWNER TO w360_definer;
