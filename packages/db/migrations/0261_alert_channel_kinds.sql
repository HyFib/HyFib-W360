-- The alerts a chat channel gets, the owners' financial alerts among them (P5-10, ADR-340).
--
-- Since 0258 the chat channel got every operations alert: failures, late queues and failing
-- integrations, emailed to every platform administrator. The owners' financial alerts, the
-- settlement reconciliation's findings (0039, ADR-066) and the payments no settlement showed (0043,
-- ADR-071), were emailed to platform owners only. The channel now names the alerts it gets: the
-- three operations alerts until an owner chooses otherwise, and the two financial ones only once an
-- owner adds them, since their posts reach whoever reads the channel. A financial post gives days
-- and counts only, as its email does, and never a failed check's error (the services leave it out).

-- The kinds the channel gets, in the console's order. A new address keeps the kinds of the one it
-- replaces (ops.platform_set_alert_channel below); the posts' kind check takes the new kinds too.
-- The channel is one row at most and posts are kept 7 days, so both checks are validated here.
ALTER TABLE ops.platform_alert_channel
  ADD COLUMN kinds text[] NOT NULL DEFAULT ARRAY['failures', 'queues', 'integrations']::text[]
    CHECK (cardinality(kinds) BETWEEN 1 AND 5 AND array_ndims(kinds) = 1
           AND kinds <@ ARRAY['failures', 'queues', 'integrations', 'reconciliation',
                              'unsettled']::text[]);
GRANT UPDATE (kinds) ON ops.platform_alert_channel TO w360_definer;

ALTER TABLE ops.platform_alert_posts
  DROP CONSTRAINT platform_alert_posts_kind_check,
  ADD CONSTRAINT platform_alert_posts_kind_check
    CHECK (kind IN ('failures', 'queues', 'integrations', 'reconciliation', 'unsettled', 'test'));

-- Definer-owned functions are replaced as 0258 replaced ops.sealed_value_keys: dropped as their
-- owner, created again, granted and handed back, all in this migration's transaction.
SET ROLE w360_definer;
DROP FUNCTION ops.queue_platform_alert_post(text, text);
DROP FUNCTION ops.platform_set_alert_channel(uuid, text, text, text);
DROP FUNCTION ops.platform_alert_channel_state();
DROP FUNCTION ops.finish_platform_alert_post(uuid, integer, uuid, integer, text, boolean);
DROP FUNCTION ops.claim_platform_alert_posts(integer);
RESET ROLE;

-- An alert's post (the worker's alert sweeps, in the transaction that queues its emails): queued
-- only while a channel is set that gets the alert's kind; whether it was.
CREATE FUNCTION ops.queue_platform_alert_post(p_kind text, p_body text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ops.platform_alert_channel c WHERE p_kind = ANY (c.kinds)) THEN
    RETURN false;
  END IF;
  INSERT INTO ops.platform_alert_posts (id, kind, body) VALUES (gen_random_uuid(), p_kind, p_body);
  RETURN true;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.queue_platform_alert_post(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.queue_platform_alert_post(text, text) TO w360_app;
ALTER FUNCTION ops.queue_platform_alert_post(text, text) OWNER TO w360_definer;

-- Setting the channel (platform owners), as in 0258: the services seal the address with this row's
-- id and give its host. A channel set before is replaced, and its kinds kept; posts waiting go to
-- the new one. Audited with the hosts, never the address, and the kinds the channel gets, so a
-- replacement that carries the owners' alerts to another address shows.
CREATE FUNCTION ops.platform_set_alert_channel(p_id uuid, p_url_ciphertext text, p_host text,
    p_correlation_id text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_previous text;
  v_kinds text[];
  v_now_kinds text[];
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can set the chat channel.' USING ERRCODE = 'W3403';
  END IF;
  IF p_id IS NULL OR p_url_ciphertext IS NULL OR p_host IS NULL THEN
    RAISE EXCEPTION 'Give the channel''s address.' USING ERRCODE = 'W3412';
  END IF;
  DELETE FROM ops.platform_alert_channel RETURNING host, kinds INTO v_previous, v_kinds;
  INSERT INTO ops.platform_alert_channel (id, url_ciphertext, host, set_by)
  VALUES (p_id, p_url_ciphertext, p_host, v_actor);
  IF v_kinds IS NOT NULL THEN
    UPDATE ops.platform_alert_channel c SET kinds = v_kinds WHERE c.id = p_id;
  END IF;
  SELECT c.kinds INTO v_now_kinds FROM ops.platform_alert_channel c WHERE c.id = p_id;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.alert_channel_set', 'success', p_correlation_id,
          jsonb_strip_nulls(jsonb_build_object('host', p_host, 'previousHost', v_previous,
                                               'kinds', to_jsonb(v_now_kinds))));
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_set_alert_channel(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_set_alert_channel(uuid, text, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_set_alert_channel(uuid, text, text, text) OWNER TO w360_definer;

-- The kinds the channel gets (platform owners): given once each, in any order, and kept in the
-- console's order. The same kinds change nothing and are not audited; a change is audited with the
-- kinds before and after. The posts waiting of a kind no longer ticked, a post on its way among
-- them, fail as unticked, as removing the channel fails them: the console advises unticking an
-- alert before replacing the address, and a new address takes the posts waiting. The kinds the
-- channel now gets.
CREATE FUNCTION ops.platform_set_alert_channel_kinds(p_kinds text[], p_correlation_id text)
  RETURNS text[]
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_order constant text[] := ARRAY['failures', 'queues', 'integrations', 'reconciliation',
                                   'unsettled'];
  v_kinds text[];
  v_id uuid;
  v_previous text[];
  v_host text;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can choose the chat channel''s alerts.'
      USING ERRCODE = 'W3403';
  END IF;
  IF p_kinds IS NULL OR cardinality(p_kinds) = 0 OR array_ndims(p_kinds) <> 1
     OR NOT p_kinds <@ v_order THEN
    RAISE EXCEPTION 'Choose at least one of the alerts listed.' USING ERRCODE = 'W3412';
  END IF;
  SELECT array_agg(k ORDER BY array_position(v_order, k)) INTO v_kinds
    FROM (SELECT DISTINCT unnest(p_kinds) AS k) d;
  SELECT c.id, c.kinds, c.host INTO v_id, v_previous, v_host
    FROM ops.platform_alert_channel c FOR UPDATE;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'No chat channel is set.' USING ERRCODE = 'W3404';
  END IF;
  IF v_kinds = v_previous THEN
    RETURN v_kinds;
  END IF;
  UPDATE ops.platform_alert_channel c SET kinds = v_kinds WHERE c.id = v_id;
  UPDATE ops.platform_alert_posts p
     SET failed_at = now(), last_status = NULL, last_error = 'unticked', lease_until = NULL
   WHERE p.sent_at IS NULL AND p.failed_at IS NULL AND p.kind <> 'test'
     AND NOT (p.kind = ANY (v_kinds));
  INSERT INTO ops.platform_audit_events (actor_user_id, action, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.alert_channel_kinds_set', 'success', p_correlation_id,
          jsonb_build_object('host', v_host, 'kinds', to_jsonb(v_kinds),
                             'previousKinds', to_jsonb(v_previous)));
  RETURN v_kinds;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_set_alert_channel_kinds(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_set_alert_channel_kinds(text[], text) TO w360_platform;
ALTER FUNCTION ops.platform_set_alert_channel_kinds(text[], text) OWNER TO w360_definer;

-- The channel as the console shows it (platform administrators), as in 0258, with the kinds it
-- gets. Never the address. No row when no channel is set.
CREATE FUNCTION ops.platform_alert_channel_state()
  RETURNS TABLE (host text, set_by_name text, set_at timestamptz, last_sent_at timestamptz,
                 last_failed_at timestamptz, last_status integer, last_error text,
                 posts_waiting integer, posts_failed integer, kinds text[])
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
         (SELECT count(*) FROM ops.platform_alert_posts p WHERE p.failed_at IS NOT NULL)::integer,
         c.kinds
    FROM ops.platform_alert_channel c
    LEFT JOIN auth.users u ON u.id = c.set_by;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_alert_channel_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_alert_channel_state() TO w360_platform;
ALTER FUNCTION ops.platform_alert_channel_state() OWNER TO w360_definer;

-- An attempt's outcome (the worker), as 0258 records it, but for two things: a 2xx status is sent
-- also when the post failed while it was on its way because its kind was unticked, as when the
-- channel was removed, and any other answer leaves such a post failed; and the channel's row is
-- locked before the post's, as choosing the alerts and removing the channel lock it before the
-- posts, so neither waits on the other in a deadlock.
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
  PERFORM 1 FROM ops.platform_alert_channel c WHERE c.id = p_channel_id FOR NO KEY UPDATE;
  SELECT p.attempts INTO v_attempts FROM ops.platform_alert_posts p
   WHERE p.id = p_id AND p.attempts = p_attempt AND p.sent_at IS NULL
     AND (p.failed_at IS NULL
          OR (p_status BETWEEN 200 AND 299 AND p.last_error IN ('no_channel', 'unticked')))
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

-- The posts due (the worker, every minute and when a post is queued), as 0258 claims them, but for
-- two things. The channel's row is locked first, as choosing the alerts, replacing the address and
-- removing the channel lock it before the posts, and held until the worker has read the address in
-- this transaction: the posts claimed go to the address of this moment, never to one that replaced
-- it since (a finish's lock does not wait for it). And a post waiting of an alert the channel no
-- longer gets fails as unticked: one queued while its alert was being unticked, which choosing the
-- alerts could not see yet, is never sent.
CREATE FUNCTION ops.claim_platform_alert_posts(p_limit integer)
  RETURNS TABLE (id uuid, kind text, body text, attempts smallint, created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_kinds text[];
BEGIN
  SELECT c.kinds INTO v_kinds FROM ops.platform_alert_channel c FOR KEY SHARE;
  UPDATE ops.platform_alert_posts p
     SET failed_at = now(), last_status = NULL, last_error = 'interrupted', lease_until = NULL
   WHERE p.sent_at IS NULL AND p.failed_at IS NULL AND p.attempts >= 5 AND p.lease_until < now();
  IF v_kinds IS NULL THEN
    -- No channel, or one replaced or removed while this waited for its row: the posts waiting fail
    -- only when none is set, and the next run claims those of a new address.
    IF NOT EXISTS (SELECT 1 FROM ops.platform_alert_channel) THEN
      UPDATE ops.platform_alert_posts p
         SET failed_at = now(), last_status = NULL, last_error = 'no_channel', lease_until = NULL
       WHERE p.sent_at IS NULL AND p.failed_at IS NULL;
    END IF;
    RETURN;
  END IF;
  UPDATE ops.platform_alert_posts p
     SET failed_at = now(), last_status = NULL, last_error = 'unticked', lease_until = NULL
   WHERE p.sent_at IS NULL AND p.failed_at IS NULL AND p.kind <> 'test'
     AND NOT (p.kind = ANY (v_kinds));
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
