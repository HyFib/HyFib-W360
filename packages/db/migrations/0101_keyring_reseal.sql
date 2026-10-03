-- Re-encrypting stored secrets under the primary key (SEC-10, ADR-134). Every stored secret is sealed
-- with the keyring (packages/core/src/crypto.ts) as `v1:<key id>:<iv>:<body>:<tag>`. While more than
-- one key is configured, the minute sweep asks ops.sealed_values_to_reseal for values sealed with a
-- configured key other than the primary (ids only) and re-encrypts each one in its company's scope
-- (operations rows in the system scope), writing it only if it is unchanged. ops.sealed_value_counts
-- tells the operations console how many values each key sealed. Neither returns a sealed value; the
-- definer reads the sealed columns only to take the key id from their first characters.

-- A re-encryption changes no value, so the shared touch trigger keeps a row's time while
-- `w360.resealing` is on for the transaction. Only the sweep's re-encryption sets it, and the runtime
-- role may already write `updated_at` wherever this trigger runs, so the setting grants nothing.
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pg_catalog.current_setting('w360.resealing', true) = 'on' THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END
$$;

-- The sealed columns the definer did not read yet (it already reads the webhook endpoints' secrets
-- and headers, the automation requests and the provider receipts), and its read of HTTP secrets.
GRANT SELECT (credential_ciphertext) ON app.whatsapp_accounts TO w360_definer;
GRANT SELECT (registration_pin_ciphertext) ON app.channel_accounts TO w360_definer;
GRANT SELECT (value_ciphertext) ON app.http_secrets TO w360_definer;
GRANT SELECT (key_secret_ciphertext, webhook_secret_ciphertext)
  ON app.commerce_payment_accounts TO w360_definer;
GRANT SELECT (private_key_ciphertext) ON app.flow_keys TO w360_definer;
GRANT SELECT (credentials_ciphertext, webhook_secret_ciphertext, access_code_ciphertext)
  ON app.commerce_stores TO w360_definer;
GRANT SELECT (payload_ciphertext) ON ops.email_outbox TO w360_definer;
CREATE POLICY definer_read ON app.http_secrets FOR SELECT TO w360_definer USING (true);

-- Every stored sealed value with the key id that sealed it, NULL for a value in another format. Only
-- the first 40 characters are read (a key id has at most 32), so a provider's webhook body is not
-- loaded whole. An automation's request counts only while its call is queued or in flight: a
-- finished call clears it. For the two functions below; nothing else may run it.
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
      SELECT 'provider_receipt', NULL::uuid, b.id, substr(b.body_ciphertext, 1, 40)
        FROM ops.webhook_receipts b WHERE b.body_ciphertext IS NOT NULL
      UNION ALL
      SELECT 'queued_email', NULL::uuid, m.id, substr(m.payload_ciphertext, 1, 40)
        FROM ops.email_outbox m WHERE m.payload_ciphertext IS NOT NULL
    ) v (kind, tenant_id, id, head)
$$;
REVOKE EXECUTE ON FUNCTION ops.sealed_value_keys() FROM PUBLIC;
ALTER FUNCTION ops.sealed_value_keys() OWNER TO w360_definer;

-- The sweep's lookup: values sealed with one of the given keys (the configured keys other than the
-- primary), leaving out those this worker could not open (`kind:id`), at most p_limit (up to 1000).
-- A value's company comes from its row, so the sweep re-encrypts it in that company's scope.
CREATE FUNCTION ops.sealed_values_to_reseal(p_key_ids text[], p_skip text[], p_limit integer)
  RETURNS TABLE (kind text, tenant_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT v.kind, v.tenant_id, v.id
    FROM ops.sealed_value_keys() v
   WHERE v.key_id = ANY (p_key_ids)
     AND NOT ((v.kind || ':' || v.id::text) = ANY (coalesce(p_skip, '{}'::text[])))
   LIMIT greatest(least(p_limit, 1000), 0)
$$;
REVOKE EXECUTE ON FUNCTION ops.sealed_values_to_reseal(text[], text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.sealed_values_to_reseal(text[], text[], integer) TO w360_app;
ALTER FUNCTION ops.sealed_values_to_reseal(text[], text[], integer) OWNER TO w360_definer;

-- For the operations console: how many values of each kind each key sealed (counts only), for
-- platform administrators.
CREATE FUNCTION ops.sealed_value_counts()
  RETURNS TABLE (kind text, key_id text, sealed bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  RETURN QUERY
  SELECT v.kind, v.key_id, count(*) FROM ops.sealed_value_keys() v GROUP BY v.kind, v.key_id;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.sealed_value_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.sealed_value_counts() TO w360_platform;
ALTER FUNCTION ops.sealed_value_counts() OWNER TO w360_definer;

-- A WooCommerce store's webhook secret never changes, so the runtime role cannot write it; only its
-- re-encryption replaces it, in the company in scope and only while it is still the value the sweep
-- opened (compare and set). False when it changed or the store is gone.
CREATE FUNCTION app.reseal_store_webhook_secret(p_store_id uuid, p_old text, p_new text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no company in scope' USING ERRCODE = 'W3403';
  END IF;
  IF p_old IS NULL OR p_new IS NULL OR NOT starts_with(p_new, 'v1:') OR p_new = p_old THEN
    RAISE EXCEPTION 'a store''s webhook secret is only re-encrypted' USING ERRCODE = 'W3412';
  END IF;
  UPDATE app.commerce_stores s SET webhook_secret_ciphertext = p_new
   WHERE s.tenant_id = v_tenant AND s.id = p_store_id AND s.webhook_secret_ciphertext = p_old;
  RETURN FOUND;
END
$$;
GRANT UPDATE (webhook_secret_ciphertext) ON app.commerce_stores TO w360_definer;
CREATE POLICY definer_reseal ON app.commerce_stores FOR UPDATE TO w360_definer
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
REVOKE EXECUTE ON FUNCTION app.reseal_store_webhook_secret(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reseal_store_webhook_secret(uuid, text, text) TO w360_app;
ALTER FUNCTION app.reseal_store_webhook_secret(uuid, text, text) OWNER TO w360_definer;
