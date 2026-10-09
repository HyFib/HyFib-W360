-- A chat channel for the operations alerts (P5-10, ADR-338).
--
-- The operations alerts (failures 0068, late queues 0072, failing integrations 0106) email every
-- platform administrator, at most every 15 minutes, with counts only. Staff on call often watch a
-- chat room rather than a mailbox. A platform owner can now set one chat channel: an incoming
-- webhook address that takes a JSON POST with a `text` member, as Slack's incoming webhooks do.
-- Each alert queued for the emails is then also queued as a post with the same counts-only text,
-- which the worker sends through the egress guard (queue `ops.alert-posts`), up to 5 attempts. The
-- address holds the channel's secret, so the services seal it with the keyring (the keyring sweep
-- re-encrypts it, 0101) and the console shows its host only: no role reads it but the runtime
-- role, which sends the posts and may only re-encrypt it.

-- The channel: one row at most (its unique index on a constant). Its id is part of the associated
-- data the address is sealed with, so a new address is a new row. It keeps when a post was last
-- sent and last failed, the failure as an HTTP status or an error code, never both (as webhook
-- deliveries keep theirs).
CREATE TABLE ops.platform_alert_channel (
  id uuid PRIMARY KEY,
  url_ciphertext text NOT NULL CHECK (char_length(url_ciphertext) BETWEEN 1 AND 8192),
  host text NOT NULL CHECK (char_length(host) BETWEEN 1 AND 255 AND host = lower(host)),
  set_by text REFERENCES auth.users (id) ON DELETE SET NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  last_failed_at timestamptz,
  last_status integer CHECK (last_status BETWEEN 100 AND 599),
  last_error text CHECK (last_error ~ '^[a-z][a-z0-9_]{0,63}$'),
  CHECK (last_status IS NULL OR last_error IS NULL)
);
CREATE UNIQUE INDEX platform_alert_channel_one ON ops.platform_alert_channel ((true));
-- The runtime role reads the sealed address to send, and re-encrypts it under the primary key only
-- through ops.reseal_platform_alert_channel (the keyring sweep); the definer role's functions below
-- do the rest.
GRANT SELECT (id, url_ciphertext) ON ops.platform_alert_channel TO w360_app;
GRANT SELECT, INSERT, DELETE ON ops.platform_alert_channel TO w360_definer;
GRANT UPDATE (url_ciphertext, last_sent_at, last_failed_at, last_status, last_error)
  ON ops.platform_alert_channel TO w360_definer;

-- The posts waiting, sent or failed. A post's body is its alert's text, counts only, as its email.
-- Its attempts are counted as they are claimed; its last answer is kept as the channel's. Kept 7
-- days after it is sent or fails (the purge below). The database fails a post itself with the
-- codes `no_channel` (no channel is set) and `interrupted` (its last attempt's worker was lost).
CREATE TABLE ops.platform_alert_posts (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('failures', 'queues', 'integrations', 'test')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  last_status integer CHECK (last_status BETWEEN 100 AND 599),
  last_error text CHECK (last_error ~ '^[a-z][a-z0-9_]{0,63}$'),
  CHECK (last_status IS NULL OR last_error IS NULL),
  CHECK (sent_at IS NULL OR failed_at IS NULL)
);
CREATE INDEX platform_alert_posts_due_idx ON ops.platform_alert_posts (next_attempt_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.platform_alert_posts TO w360_definer;

-- Setting the channel (platform owners): the services seal the address with this row's id and give
-- its host. A channel set before is replaced; posts waiting go to the new one. Audited with the
-- hosts only, never the address.
CREATE FUNCTION ops.platform_set_alert_channel(p_id uuid, p_url_ciphertext text, p_host text,
    p_correlation_id text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_previous text;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can set the chat channel.' USING ERRCODE = 'W3403';
  END IF;
  IF p_id IS NULL OR p_url_ciphertext IS NULL OR p_host IS NULL THEN
    RAISE EXCEPTION 'Give the channel''s address.' USING ERRCODE = 'W3412';
  END IF;
  DELETE FROM ops.platform_alert_channel RETURNING host INTO v_previous;
  INSERT INTO ops.platform_alert_channel (id, url_ciphertext, host, set_by)
  VALUES (p_id, p_url_ciphertext, p_host, v_actor);
  INSERT INTO ops.platform_audit_events (actor_user_id, action, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.alert_channel_set', 'success', p_correlation_id,
          jsonb_strip_nulls(jsonb_build_object('host', p_host, 'previousHost', v_previous)));
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_set_alert_channel(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_set_alert_channel(uuid, text, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_set_alert_channel(uuid, text, text, text) OWNER TO w360_definer;

-- Removing it (platform owners): the posts waiting fail as having no channel. Audited with the
-- host. False when no channel was set.
CREATE FUNCTION ops.platform_remove_alert_channel(p_correlation_id text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_host text;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can remove the chat channel.' USING ERRCODE = 'W3403';
  END IF;
  DELETE FROM ops.platform_alert_channel RETURNING host INTO v_host;
  IF v_host IS NULL THEN
    RETURN false;
  END IF;
  UPDATE ops.platform_alert_posts p
     SET failed_at = now(), last_status = NULL, last_error = 'no_channel', lease_until = NULL
   WHERE p.sent_at IS NULL AND p.failed_at IS NULL;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.alert_channel_removed', 'success', p_correlation_id,
          jsonb_build_object('host', v_host));
  RETURN true;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_remove_alert_channel(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_remove_alert_channel(text) TO w360_platform;
ALTER FUNCTION ops.platform_remove_alert_channel(text) OWNER TO w360_definer;

-- A test post (platform owners): queued as the alerts' posts are, with the body the services give.
-- Audited with the host.
CREATE FUNCTION ops.platform_test_alert_channel(p_body text, p_correlation_id text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_host text;
  v_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can test the chat channel.' USING ERRCODE = 'W3403';
  END IF;
  SELECT c.host INTO v_host FROM ops.platform_alert_channel c;
  IF v_host IS NULL THEN
    RAISE EXCEPTION 'No chat channel is set.' USING ERRCODE = 'W3404';
  END IF;
  INSERT INTO ops.platform_alert_posts (id, kind, body) VALUES (v_id, 'test', p_body);
  INSERT INTO ops.platform_audit_events (actor_user_id, action, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.alert_channel_tested', 'success', p_correlation_id,
          jsonb_build_object('host', v_host));
  RETURN v_id;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_test_alert_channel(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_test_alert_channel(text, text) TO w360_platform;
ALTER FUNCTION ops.platform_test_alert_channel(text, text) OWNER TO w360_definer;

-- The channel as the console shows it (platform administrators): its host, who set it and when,
-- its last post sent and failed, and how many posts wait and failed. Never the address. No row
-- when no channel is set.
CREATE FUNCTION ops.platform_alert_channel_state()
  RETURNS TABLE (host text, set_by_name text, set_at timestamptz, last_sent_at timestamptz,
                 last_failed_at timestamptz, last_status integer, last_error text,
                 posts_waiting integer, posts_failed integer)
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
  SELECT c.host, u.name, c.set_at, c.last_sent_at, c.last_failed_at, c.last_status, c.last_error,
         (SELECT count(*) FROM ops.platform_alert_posts p
           WHERE p.sent_at IS NULL AND p.failed_at IS NULL)::integer,
         (SELECT count(*) FROM ops.platform_alert_posts p WHERE p.failed_at IS NOT NULL)::integer
    FROM ops.platform_alert_channel c
    LEFT JOIN auth.users u ON u.id = c.set_by;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_alert_channel_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_alert_channel_state() TO w360_platform;
ALTER FUNCTION ops.platform_alert_channel_state() OWNER TO w360_definer;

-- The 10 latest posts (platform administrators): their kind, times, attempts and last answer, never
-- their body.
CREATE FUNCTION ops.platform_alert_posts_recent()
  RETURNS TABLE (id uuid, kind text, created_at timestamptz, attempts smallint,
                 next_attempt_at timestamptz, sent_at timestamptz, failed_at timestamptz,
                 last_status integer, last_error text)
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
  SELECT p.id, p.kind, p.created_at, p.attempts, p.next_attempt_at, p.sent_at, p.failed_at,
         p.last_status, p.last_error
    FROM ops.platform_alert_posts p
   ORDER BY p.created_at DESC, p.id DESC
   LIMIT 10;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_alert_posts_recent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_alert_posts_recent() TO w360_platform;
ALTER FUNCTION ops.platform_alert_posts_recent() OWNER TO w360_definer;

-- An alert's post (the worker's alert sweeps, in the transaction that queues its emails): queued
-- only while a channel is set; whether it was.
CREATE FUNCTION ops.queue_platform_alert_post(p_kind text, p_body text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ops.platform_alert_channel) THEN
    RETURN false;
  END IF;
  INSERT INTO ops.platform_alert_posts (id, kind, body) VALUES (gen_random_uuid(), p_kind, p_body);
  RETURN true;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.queue_platform_alert_post(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.queue_platform_alert_post(text, text) TO w360_app;
ALTER FUNCTION ops.queue_platform_alert_post(text, text) OWNER TO w360_definer;

-- The posts due (the worker, every minute and when a post is queued), oldest first, at most 10,
-- each leased for 3 minutes and its attempt counted as it is claimed. A post whose last attempt
-- was interrupted (its lease ran out with no attempt left) fails; without a channel, every post
-- waiting fails and none is returned.
CREATE FUNCTION ops.claim_platform_alert_posts(p_limit integer)
  RETURNS TABLE (id uuid, kind text, body text, attempts smallint, created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  UPDATE ops.platform_alert_posts p
     SET failed_at = now(), last_status = NULL, last_error = 'interrupted', lease_until = NULL
   WHERE p.sent_at IS NULL AND p.failed_at IS NULL AND p.attempts >= 5 AND p.lease_until < now();
  IF NOT EXISTS (SELECT 1 FROM ops.platform_alert_channel) THEN
    UPDATE ops.platform_alert_posts p
       SET failed_at = now(), last_status = NULL, last_error = 'no_channel', lease_until = NULL
     WHERE p.sent_at IS NULL AND p.failed_at IS NULL;
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE ops.platform_alert_posts p
     SET attempts = p.attempts + 1, lease_until = now() + interval '3 minutes'
   WHERE p.id IN (SELECT d.id FROM ops.platform_alert_posts d
                   WHERE d.sent_at IS NULL AND d.failed_at IS NULL AND d.next_attempt_at <= now()
                     AND (d.lease_until IS NULL OR d.lease_until < now()) AND d.attempts < 5
                   ORDER BY d.next_attempt_at, d.id
                   LIMIT least(greatest(coalesce(p_limit, 0), 0), 10)
                   FOR UPDATE SKIP LOCKED)
  RETURNING p.id, p.kind, p.body, p.attempts, p.created_at;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.claim_platform_alert_posts(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.claim_platform_alert_posts(integer) TO w360_app;
ALTER FUNCTION ops.claim_platform_alert_posts(integer) OWNER TO w360_definer;

-- An attempt's outcome (the worker): its post and attempt as claimed, the channel it was sent to,
-- and the answer, an HTTP status or an error code. A 2xx status is sent, even when the channel's
-- removal failed the post while it was being sent. Otherwise the post is tried again after a wait
-- while attempts remain and the failure may pass (p_retry), else it fails for good. The channel
-- keeps its last of each. 'stale' when the attempt is no longer the post's latest claim, or the
-- post was sent or failed meanwhile (but for that removal); else 'sent', 'retrying' or 'failed'.
CREATE FUNCTION ops.finish_platform_alert_post(p_id uuid, p_attempt integer, p_channel_id uuid,
    p_status integer, p_error text, p_retry boolean)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_attempts smallint;
  v_retry boolean;
BEGIN
  IF (p_status IS NULL) = (p_error IS NULL) THEN
    RAISE EXCEPTION 'give an attempt''s HTTP status or its error code' USING ERRCODE = 'W3412';
  END IF;
  SELECT p.attempts INTO v_attempts FROM ops.platform_alert_posts p
   WHERE p.id = p_id AND p.attempts = p_attempt AND p.sent_at IS NULL
     AND (p.failed_at IS NULL OR (p_status BETWEEN 200 AND 299 AND p.last_error = 'no_channel'))
   FOR UPDATE;
  IF v_attempts IS NULL THEN
    RETURN 'stale';
  END IF;
  IF p_status BETWEEN 200 AND 299 THEN
    UPDATE ops.platform_alert_posts p
       SET sent_at = now(), failed_at = NULL, lease_until = NULL, last_status = p_status,
           last_error = NULL
     WHERE p.id = p_id;
    UPDATE ops.platform_alert_channel c SET last_sent_at = now() WHERE c.id = p_channel_id;
    RETURN 'sent';
  END IF;
  v_retry := coalesce(p_retry, false) AND v_attempts < 5;
  -- After the first four attempts, 1, 2, 4 and 8 minutes.
  UPDATE ops.platform_alert_posts p
     SET last_status = p_status, last_error = p_error, lease_until = NULL,
         next_attempt_at = CASE WHEN v_retry
           THEN now() + make_interval(mins => 1 << (greatest(v_attempts, 1) - 1))
           ELSE p.next_attempt_at END,
         failed_at = CASE WHEN v_retry THEN NULL ELSE now() END
   WHERE p.id = p_id;
  UPDATE ops.platform_alert_channel c
     SET last_failed_at = now(), last_status = p_status, last_error = p_error
   WHERE c.id = p_channel_id;
  RETURN CASE WHEN v_retry THEN 'retrying' ELSE 'failed' END;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.finish_platform_alert_post(uuid, integer, uuid, integer, text, boolean)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.finish_platform_alert_post(uuid, integer, uuid, integer, text, boolean)
  TO w360_app;
ALTER FUNCTION ops.finish_platform_alert_post(uuid, integer, uuid, integer, text, boolean)
  OWNER TO w360_definer;

-- The channel's address re-encrypted under the primary key (the keyring sweep, as the runtime
-- role): written only while it is still the value the sweep opened (compare and set), and only as
-- another sealed value; false when it changed or the channel is gone. As 0101 re-encrypts a store's
-- webhook secret, which the runtime role cannot write either.
CREATE FUNCTION ops.reseal_platform_alert_channel(p_id uuid, p_old text, p_new text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF p_old IS NULL OR p_new IS NULL OR NOT starts_with(p_new, 'v1:') OR p_new = p_old THEN
    RAISE EXCEPTION 'the chat channel''s address is only re-encrypted' USING ERRCODE = 'W3412';
  END IF;
  UPDATE ops.platform_alert_channel c SET url_ciphertext = p_new
   WHERE c.id = p_id AND c.url_ciphertext = p_old;
  RETURN FOUND;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.reseal_platform_alert_channel(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.reseal_platform_alert_channel(uuid, text, text) TO w360_app;
ALTER FUNCTION ops.reseal_platform_alert_channel(uuid, text, text) OWNER TO w360_definer;

-- Posts sent or failed more than 7 days ago (the worker, every minute); how many went.
CREATE FUNCTION ops.purge_platform_alert_posts()
  RETURNS integer
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  WITH gone AS (
    DELETE FROM ops.platform_alert_posts p
     WHERE coalesce(p.sent_at, p.failed_at) < now() - interval '7 days'
    RETURNING 1)
  SELECT count(*)::integer FROM gone
$$;
REVOKE EXECUTE ON FUNCTION ops.purge_platform_alert_posts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.purge_platform_alert_posts() TO w360_app;
ALTER FUNCTION ops.purge_platform_alert_posts() OWNER TO w360_definer;

-- 0121's lookup of sealed values with the channel's address, so the keyring sweep re-encrypts it
-- under the primary key and the console counts it. Replaced as 0121 replaced it: dropped as its
-- owner, created again and handed back. The definer reads the address through its grant above.
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
      UNION ALL
      SELECT 'alert_channel', NULL::uuid, a.id, substr(a.url_ciphertext, 1, 40)
        FROM ops.platform_alert_channel a
    ) v (kind, tenant_id, id, head)
$$;
REVOKE EXECUTE ON FUNCTION ops.sealed_value_keys() FROM PUBLIC;
ALTER FUNCTION ops.sealed_value_keys() OWNER TO w360_definer;
