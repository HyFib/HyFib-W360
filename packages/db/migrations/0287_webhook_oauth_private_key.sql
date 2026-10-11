-- A webhook endpoint's OAuth client can sign its client assertions with a key pair HyFib keeps
-- (P5-09, ADR-367).
--
-- Since 0286 a client proves it holds its secret with a JWT signed with that secret (HMAC SHA-256).
-- Some authorization servers, and companies' policies, want no shared secret at all: the client
-- signs its assertion with a private key and the server checks it with the public key registered
-- for the client (RFC 7523 sections 2.2 and 3), the method OpenID Connect Core 1.0 section 9 names
-- private_key_jwt. HyFib makes the key pair (RSA, 2048 bits) when a company chooses the method:
-- the private key never leaves HyFib and is sealed with the keyring (`webhook-oauth-key:<company>:
-- <endpoint>`), as the secret is; the public key, which the company registers with its server, is
-- kept as it is (SPKI PEM) and shown. Such a client has no secret, and a client with a secret has
-- no key: the check below names each column, since a check that comes out null passes. Workers of
-- this release, rolled out before web servers, sign the assertions. A company has at most 10
-- endpoints, so the checks are validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN oauth_private_key_ciphertext text,
  ADD COLUMN oauth_public_key text,
  DROP CONSTRAINT webhook_endpoints_oauth_client_auth,
  ADD CONSTRAINT webhook_endpoints_oauth_client_auth CHECK (
    oauth_client_auth IN ('client_secret_basic', 'client_secret_post', 'client_secret_jwt',
                          'private_key_jwt')),
  DROP CONSTRAINT webhook_endpoints_oauth,
  ADD CONSTRAINT webhook_endpoints_oauth CHECK (
    (oauth_token_url IS NULL AND oauth_client_id IS NULL AND oauth_client_secret_ciphertext IS NULL
     AND oauth_scope IS NULL AND oauth_private_key_ciphertext IS NULL AND oauth_public_key IS NULL)
    OR (oauth_token_url IS NOT NULL AND oauth_client_id IS NOT NULL
        AND char_length(oauth_token_url) BETWEEN 1 AND 2048
        AND char_length(oauth_client_id) BETWEEN 1 AND 200
        AND (oauth_scope IS NULL OR char_length(oauth_scope) BETWEEN 1 AND 500)
        AND ((oauth_client_auth = 'private_key_jwt'
              AND oauth_client_secret_ciphertext IS NULL
              AND oauth_private_key_ciphertext IS NOT NULL
              AND oauth_public_key IS NOT NULL
              AND char_length(oauth_public_key) BETWEEN 1 AND 4000)
             OR (oauth_client_auth <> 'private_key_jwt'
                 AND oauth_client_secret_ciphertext IS NOT NULL
                 AND oauth_private_key_ciphertext IS NULL
                 AND oauth_public_key IS NULL))));

-- The runtime role sets them when it adds an endpoint (its table grant) and changes them with the
-- client (0025 grants updates column by column). Both roles read them through their table grants:
-- the worker, as the runtime role, opens the private key to sign.
GRANT UPDATE (oauth_private_key_ciphertext, oauth_public_key) ON app.webhook_endpoints TO w360_app;

-- 0258's lookup of sealed values with the clients' private keys, so the keyring sweep re-encrypts
-- them under the primary key and the console counts them. Replaced as 0258 replaced it: dropped as
-- its owner, created again and handed back. The definer reads them through its table grant (0025).
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
      SELECT 'webhook_oauth_private_key', e.tenant_id, e.id,
             substr(e.oauth_private_key_ciphertext, 1, 40)
        FROM app.webhook_endpoints e WHERE e.oauth_private_key_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'provider_receipt', NULL::uuid, b.id, substr(b.body_ciphertext, 1, 40)
        FROM ops.webhook_receipts b WHERE b.body_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'queued_email', NULL::uuid, m.id, substr(m.payload_ciphertext, 1, 40)
        FROM ops.email_outbox m WHERE m.payload_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'alert_channel', NULL::uuid, a.id, substr(a.url_ciphertext, 1, 40)
        FROM ops.platform_alert_channel a
    ) v (kind, tenant_id, id, head)
$$;
REVOKE EXECUTE ON FUNCTION ops.sealed_value_keys() FROM PUBLIC;
ALTER FUNCTION ops.sealed_value_keys() OWNER TO w360_definer;
