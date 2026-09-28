-- 0024_public_api: company API keys, idempotency keys and messages sent through the API (P5-08,
-- ADR-052). A request acts for its company as its key: keys are found by the SHA-256 of their token
-- through a definer function, and API work runs in the company's scope without a user.

-- API keys ---------------------------------------------------------------------------------------------
-- Only the token's SHA-256 is stored, and the runtime role cannot read it (column grants). A key is
-- never deleted: it is revoked, or it expires (rotation shortens the old key's expiry).
CREATE TABLE app.api_keys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  -- The token's public part, shown in lists: w360_ and 12 base32 characters.
  key_prefix text NOT NULL UNIQUE CHECK (key_prefix ~ '^w360_[a-z2-7]{12}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 5
    AND scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write', 'messages.send',
                        'messages.send_marketing']::text[]),
  created_by_user_id text NOT NULL REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id text REFERENCES auth.users (id),
  -- The key that replaced this one when it was rotated.
  replaced_by_key_id uuid,
  UNIQUE (tenant_id, id),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL)),
  CHECK (replaced_by_key_id IS DISTINCT FROM id),
  CONSTRAINT api_keys_replaced_by_fk FOREIGN KEY (tenant_id, replaced_by_key_id)
    REFERENCES app.api_keys (tenant_id, id)
);
CREATE INDEX api_keys_tenant_idx ON app.api_keys (tenant_id, created_at DESC, id DESC);

-- What identifies a key never changes; a revocation is final; an expiry can only come sooner; a key
-- is replaced once.
CREATE FUNCTION app.guard_api_key() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.key_prefix, NEW.token_hash, NEW.scopes, NEW.created_by_user_id,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.key_prefix, OLD.token_hash, OLD.scopes, OLD.created_by_user_id,
      OLD.created_at) THEN
    RAISE EXCEPTION 'An API key keeps its token, scopes and author.' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at, NEW.revoked_by_user_id) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by_user_id) THEN
    RAISE EXCEPTION 'A revoked API key stays revoked.' USING ERRCODE = 'W3409';
  END IF;
  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
     AND (NEW.expires_at IS NULL OR (OLD.expires_at IS NOT NULL AND NEW.expires_at > OLD.expires_at)) THEN
    RAISE EXCEPTION 'An API key''s expiry can only come sooner.' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.replaced_by_key_id IS NOT NULL AND NEW.replaced_by_key_id IS DISTINCT FROM OLD.replaced_by_key_id THEN
    RAISE EXCEPTION 'An API key is replaced once.' USING ERRCODE = 'W3409';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER api_keys_guard BEFORE UPDATE ON app.api_keys
  FOR EACH ROW EXECUTE FUNCTION app.guard_api_key();
CREATE TRIGGER api_keys_no_delete BEFORE DELETE ON app.api_keys
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

SELECT ops.apply_tenant_rls('app.api_keys');
CREATE POLICY definer_all ON app.api_keys TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT (id, tenant_id, name, key_prefix, scopes, created_by_user_id, created_at, expires_at,
  last_used_at, revoked_at, revoked_by_user_id, replaced_by_key_id) ON app.api_keys TO w360_app;
GRANT INSERT ON app.api_keys TO w360_app;
GRANT UPDATE (name, expires_at, revoked_at, revoked_by_user_id, replaced_by_key_id)
  ON app.api_keys TO w360_app;
GRANT SELECT, UPDATE (last_used_at) ON app.api_keys TO w360_definer;

-- Finds the key a request presents by its token's SHA-256: nothing for an unknown, revoked or
-- expired key, or for a company being deleted. Records when the key was last used, at most once a
-- minute and without waiting for another request doing the same.
CREATE FUNCTION ops.api_key_authenticate(p_token_hash text)
  RETURNS TABLE (key_id uuid, tenant_id uuid, scopes text[], tenant_status text)
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
  v_status text;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT k.id, k.tenant_id, k.scopes, k.expires_at, k.revoked_at, k.last_used_at
    INTO v_id, v_tenant, v_scopes, v_expires, v_revoked, v_used
    FROM app.api_keys k WHERE k.token_hash = p_token_hash;
  IF NOT FOUND OR v_revoked IS NOT NULL OR (v_expires IS NOT NULL AND v_expires <= now()) THEN
    RETURN;
  END IF;
  SELECT t.status INTO v_status FROM app.tenants t WHERE t.id = v_tenant;
  IF v_status IS NULL OR v_status IN ('pending_deletion', 'deleted') THEN
    RETURN;
  END IF;
  IF v_used IS NULL OR v_used < now() - interval '1 minute' THEN
    UPDATE app.api_keys SET last_used_at = now()
     WHERE id = (SELECT k.id FROM app.api_keys k
                  WHERE k.id = v_id AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute')
                  FOR UPDATE SKIP LOCKED);
  END IF;
  RETURN QUERY SELECT v_id, v_tenant, v_scopes, v_status;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.api_key_authenticate(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.api_key_authenticate(text) TO w360_app;
ALTER FUNCTION ops.api_key_authenticate(text) OWNER TO w360_definer;

-- Idempotency keys ---------------------------------------------------------------------------------------
-- Written in the same transaction as the request's work: a concurrent retry waits on the unique
-- index and then finds the stored response. Only successful responses are stored; they expire after
-- 24 hours, and an expired row is reused by a new request with its key until the sweep deletes it.
CREATE TABLE app.api_idempotency_keys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  api_key_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[\x21-\x7e]{1,255}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status_code smallint CHECK (status_code BETWEEN 200 AND 299),
  response jsonb CHECK (pg_column_size(response) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  CONSTRAINT api_idempotency_keys_key_uq UNIQUE (tenant_id, api_key_id, idempotency_key),
  CHECK ((status_code IS NULL) = (response IS NULL)),
  CHECK (expires_at > created_at),
  CONSTRAINT api_idempotency_keys_api_key_fk FOREIGN KEY (tenant_id, api_key_id)
    REFERENCES app.api_keys (tenant_id, id)
);
CREATE INDEX api_idempotency_keys_expiry_idx ON app.api_idempotency_keys (expires_at);
SELECT ops.apply_tenant_rls('app.api_idempotency_keys');
GRANT SELECT, INSERT ON app.api_idempotency_keys TO w360_app;
GRANT UPDATE (request_hash, status_code, response, expires_at) ON app.api_idempotency_keys TO w360_app;
CREATE POLICY definer_all ON app.api_idempotency_keys TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT, DELETE ON app.api_idempotency_keys TO w360_definer;

-- Deletes expired idempotency keys (the retention sweep, across companies).
CREATE FUNCTION ops.purge_api_idempotency_keys(p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM app.api_idempotency_keys
   WHERE id IN (SELECT i.id FROM app.api_idempotency_keys i
                 WHERE i.expires_at <= now() ORDER BY i.expires_at LIMIT p_limit);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.purge_api_idempotency_keys(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.purge_api_idempotency_keys(integer) TO w360_app;
ALTER FUNCTION ops.purge_api_idempotency_keys(integer) OWNER TO w360_definer;

-- Messages sent through the API ----------------------------------------------------------------------------
-- The key that sent a message (sender_type 'api'); existing rows have none.
ALTER TABLE app.messages
  ADD COLUMN api_key_id uuid,
  ADD CONSTRAINT messages_api_key_fk FOREIGN KEY (tenant_id, api_key_id)
    REFERENCES app.api_keys (tenant_id, id),
  ADD CONSTRAINT messages_api_key_sender_check CHECK (api_key_id IS NULL OR sender_type = 'api');

-- Consent recorded through the API names the key as its actor.
ALTER TABLE app.consent_events
  DROP CONSTRAINT consent_events_actor_type_check,
  ADD CONSTRAINT consent_events_actor_type_check
    CHECK (actor_type IN ('user', 'contact', 'system', 'provider', 'api_key'));
