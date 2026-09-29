-- 0040_api_key_expiry_reminders: a company's owners and administrators are emailed once when one of
-- its API keys expires within 7 days (P5-08, ADR-067). The worker's minute sweep lists the keys due
-- (ids only) and marks each in the company's own scope, in the transaction that queues the emails.

-- When the company was reminded that the key expires. A key is reminded once: its expiry can only
-- come sooner, which happens only when it is rotated, and a rotated key is not reminded (the new key
-- is, before it expires).
ALTER TABLE app.api_keys ADD COLUMN expiry_reminded_at timestamptz;
GRANT SELECT (expiry_reminded_at), UPDATE (expiry_reminded_at) ON app.api_keys TO w360_app;

-- The guard of 0024 with one more rule: the reminder mark, once set, stays.
CREATE OR REPLACE FUNCTION app.guard_api_key() RETURNS trigger
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
  IF OLD.expiry_reminded_at IS NOT NULL
     AND NEW.expiry_reminded_at IS DISTINCT FROM OLD.expiry_reminded_at THEN
    RAISE EXCEPTION 'An API key''s expiry reminder is sent once.' USING ERRCODE = 'W3409';
  END IF;
  RETURN NEW;
END
$$;

-- The keys the sweep looks at: expiring, usable, not rotated and not reminded yet.
CREATE INDEX api_keys_expiry_reminder_idx ON app.api_keys (expires_at)
  WHERE expires_at IS NOT NULL AND revoked_at IS NULL AND replaced_by_key_id IS NULL
    AND expiry_reminded_at IS NULL;

-- Keys due a reminder (company and key ids, for the minute sweep): not revoked, rotated or reminded
-- yet, expiring within p_days days (1 to 30) and not expired yet, of companies whose keys still work
-- (not being deleted), soonest expiry first.
CREATE FUNCTION ops.api_key_expiry_reminders_due(p_limit integer, p_days integer)
  RETURNS TABLE (tenant_id uuid, key_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT k.tenant_id, k.id
    FROM app.api_keys k
    JOIN app.tenants t ON t.id = k.tenant_id
   WHERE k.expires_at IS NOT NULL AND k.revoked_at IS NULL AND k.replaced_by_key_id IS NULL
     AND k.expiry_reminded_at IS NULL
     AND k.expires_at > now()
     AND k.expires_at <= now() + make_interval(days => least(greatest(coalesce(p_days, 7), 1), 30))
     AND t.status NOT IN ('pending_deletion', 'deleted')
   ORDER BY k.expires_at, k.id
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000)
$$;
REVOKE EXECUTE ON FUNCTION ops.api_key_expiry_reminders_due(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.api_key_expiry_reminders_due(integer, integer) TO w360_app;
ALTER FUNCTION ops.api_key_expiry_reminders_due(integer, integer) OWNER TO w360_definer;
