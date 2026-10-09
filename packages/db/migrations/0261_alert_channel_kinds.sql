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
-- the new one. Audited with the hosts only, never the address.
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
  INSERT INTO ops.platform_audit_events (actor_user_id, action, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.alert_channel_set', 'success', p_correlation_id,
          jsonb_strip_nulls(jsonb_build_object('host', p_host, 'previousHost', v_previous)));
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_set_alert_channel(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_set_alert_channel(uuid, text, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_set_alert_channel(uuid, text, text, text) OWNER TO w360_definer;

-- The kinds the channel gets (platform owners): given once each, in any order, and kept in the
-- console's order. The same kinds change nothing and are not audited; a change is audited with the
-- kinds before and after. The kinds the channel now gets.
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
