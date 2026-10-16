-- A Microsoft Teams format for the operations alert channel (P5-10, ADR-388).
--
-- Since 0258 the chat channel got each post as a JSON object with a `text` member, the text
-- escaped as Slack's formatting reads it (`&`, `<` and `>`). A channel now has a format: `text`,
-- as before and the format every channel set before keeps, or `teams_card`, the Adaptive Card
-- message a Microsoft Teams webhook (a Workflows "When a Teams webhook request is received" flow)
-- posts. The worker renders a post's body when it sends it, from the channel's format of that
-- moment and the post's text unescaped, so a change of format applies to the posts waiting.
--
-- Expand and contract: a post keeps its escaped `body`, which the workers of the release before
-- this one send, and new posts also carry `plain_body`, the same text unescaped, which this
-- release's workers render from. A post queued before this migration, or by an older worker during
-- the rollout, has no `plain_body`: it is sent as before in the `text` format, and unescaped (the
-- three escapes reversed exactly) for a card. An older worker claims posts through the one-argument
-- claim, which now hands out posts only while the channel's format is `text`, so it is never given
-- a card channel it cannot render; this release's workers name the formats they render. The
-- functions of the release before keep their signatures and behaviour for old web servers: setting
-- a channel through them sets the `text` format, which is what their form says it takes.

-- The channel's format: one row at most, so the check is validated here. Only definer functions
-- write it; the worker learns it from the claim (below), so the runtime role gets no new column.
ALTER TABLE ops.platform_alert_channel
  ADD COLUMN format text NOT NULL DEFAULT 'text'
    CONSTRAINT platform_alert_channel_format_check CHECK (format IN ('text', 'teams_card'));
GRANT UPDATE (format) ON ops.platform_alert_channel TO w360_definer;

-- A post's text unescaped: its subject, lines and link one a line, at most 4,000 characters (as
-- `body`); null on a post queued without it. Posts are kept 7 days and every existing row is null,
-- so the check is validated here at once.
ALTER TABLE ops.platform_alert_posts
  ADD COLUMN plain_body text
    CONSTRAINT platform_alert_posts_plain_body_check
      CHECK (plain_body IS NULL OR char_length(plain_body) BETWEEN 1 AND 4000);

-- Definer-owned functions are replaced as 0261 replaced them: dropped as their owner, created
-- again, granted and handed back, all in this migration's transaction.
SET ROLE w360_definer;
DROP FUNCTION ops.platform_set_alert_channel(uuid, text, text, text);
DROP FUNCTION ops.platform_test_alert_channel(text, text);
DROP FUNCTION ops.platform_alert_channel_state();
DROP FUNCTION ops.queue_platform_alert_post(text, text);
DROP FUNCTION ops.claim_platform_alert_posts(integer);
RESET ROLE;

-- Setting the channel with its format (platform owners), as 0261 sets it: the services seal the
-- address with this row's id and give its host and format. A channel set before is replaced, its
-- kinds kept; the format is the new address's own, since another address may be another service.
-- Audited with the hosts, never the address, the kinds and the formats.
CREATE FUNCTION ops.platform_set_alert_channel(p_id uuid, p_url_ciphertext text, p_host text,
    p_format text, p_correlation_id text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_previous text;
  v_previous_format text;
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
  IF p_format IS NULL OR p_format NOT IN ('text', 'teams_card') THEN
    RAISE EXCEPTION 'Choose one of the formats listed.' USING ERRCODE = 'W3412';
  END IF;
  DELETE FROM ops.platform_alert_channel RETURNING host, kinds, format
    INTO v_previous, v_kinds, v_previous_format;
  INSERT INTO ops.platform_alert_channel (id, url_ciphertext, host, set_by, format)
  VALUES (p_id, p_url_ciphertext, p_host, v_actor, p_format);
  IF v_kinds IS NOT NULL THEN
    UPDATE ops.platform_alert_channel c SET kinds = v_kinds WHERE c.id = p_id;
  END IF;
  SELECT c.kinds INTO v_now_kinds FROM ops.platform_alert_channel c WHERE c.id = p_id;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.alert_channel_set', 'success', p_correlation_id,
          jsonb_strip_nulls(jsonb_build_object('host', p_host, 'previousHost', v_previous,
                                               'kinds', to_jsonb(v_now_kinds),
                                               'format', p_format,
                                               'previousFormat', v_previous_format)));
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_set_alert_channel(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_set_alert_channel(uuid, text, text, text, text)
  TO w360_platform;
ALTER FUNCTION ops.platform_set_alert_channel(uuid, text, text, text, text) OWNER TO w360_definer;

-- Setting the channel as the web servers of the release before do (their form takes an address
-- that takes a JSON `text` member): the `text` format.
CREATE FUNCTION ops.platform_set_alert_channel(p_id uuid, p_url_ciphertext text, p_host text,
    p_correlation_id text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM ops.platform_set_alert_channel(p_id, p_url_ciphertext, p_host, 'text', p_correlation_id);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_set_alert_channel(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_set_alert_channel(uuid, text, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_set_alert_channel(uuid, text, text, text) OWNER TO w360_definer;

-- The channel's format alone (platform owners), without its address, which is never shown back:
-- the format says how the service at the same address reads a post, and changing it reveals
-- nothing of the address. The channel's row is locked first, as the claim holds it, so posts
-- claimed before the change are sent in the format they were claimed with and those claimed after
-- in the new one; the posts waiting are rendered in the new one when they are sent. The same
-- format changes nothing and is not audited; a change is audited with the host and the formats
-- before and after. The format the channel now has.
CREATE FUNCTION ops.platform_set_alert_channel_format(p_format text, p_correlation_id text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_id uuid;
  v_previous text;
  v_host text;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can choose the chat channel''s format.'
      USING ERRCODE = 'W3403';
  END IF;
  IF p_format IS NULL OR p_format NOT IN ('text', 'teams_card') THEN
    RAISE EXCEPTION 'Choose one of the formats listed.' USING ERRCODE = 'W3412';
  END IF;
  SELECT c.id, c.format, c.host INTO v_id, v_previous, v_host
    FROM ops.platform_alert_channel c FOR UPDATE;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'No chat channel is set.' USING ERRCODE = 'W3404';
  END IF;
  IF p_format = v_previous THEN
    RETURN p_format;
  END IF;
  UPDATE ops.platform_alert_channel c SET format = p_format WHERE c.id = v_id;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.alert_channel_format_set', 'success', p_correlation_id,
          jsonb_build_object('host', v_host, 'format', p_format, 'previousFormat', v_previous));
  RETURN p_format;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_set_alert_channel_format(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_set_alert_channel_format(text, text) TO w360_platform;
ALTER FUNCTION ops.platform_set_alert_channel_format(text, text) OWNER TO w360_definer;

-- A test post (platform owners), as 0258 queues it, with its text both escaped and unescaped (null
-- from the web servers of the release before). Audited with the host and the format.
CREATE FUNCTION ops.platform_test_alert_channel(p_body text, p_plain_body text,
    p_correlation_id text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_host text;
  v_format text;
  v_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can test the chat channel.' USING ERRCODE = 'W3403';
  END IF;
  SELECT c.host, c.format INTO v_host, v_format FROM ops.platform_alert_channel c;
  IF v_host IS NULL THEN
    RAISE EXCEPTION 'No chat channel is set.' USING ERRCODE = 'W3404';
  END IF;
  INSERT INTO ops.platform_alert_posts (id, kind, body, plain_body)
  VALUES (v_id, 'test', p_body, p_plain_body);
  INSERT INTO ops.platform_audit_events (actor_user_id, action, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.alert_channel_tested', 'success', p_correlation_id,
          jsonb_build_object('host', v_host, 'format', v_format));
  RETURN v_id;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_test_alert_channel(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_test_alert_channel(text, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_test_alert_channel(text, text, text) OWNER TO w360_definer;

-- A test post from the web servers of the release before: the escaped text only.
CREATE FUNCTION ops.platform_test_alert_channel(p_body text, p_correlation_id text)
  RETURNS uuid
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT ops.platform_test_alert_channel(p_body, NULL::text, p_correlation_id)
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_test_alert_channel(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_test_alert_channel(text, text) TO w360_platform;
ALTER FUNCTION ops.platform_test_alert_channel(text, text) OWNER TO w360_definer;

-- The channel as the console shows it (platform administrators), as in 0261, with its format as
-- one more column, which old web servers do not read. Never the address. No row when no channel
-- is set.
CREATE FUNCTION ops.platform_alert_channel_state()
  RETURNS TABLE (host text, set_by_name text, set_at timestamptz, last_sent_at timestamptz,
                 last_failed_at timestamptz, last_status integer, last_error text,
                 posts_waiting integer, posts_failed integer, kinds text[], format text)
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
         c.kinds, c.format
    FROM ops.platform_alert_channel c
    LEFT JOIN auth.users u ON u.id = c.set_by;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_alert_channel_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_alert_channel_state() TO w360_platform;
ALTER FUNCTION ops.platform_alert_channel_state() OWNER TO w360_definer;

-- An alert's post (the worker's alert sweeps, in the transaction that queues its emails), as 0261
-- queues it, with its text both escaped (for the workers of the release before, should one claim
-- it) and unescaped (null from those workers).
CREATE FUNCTION ops.queue_platform_alert_post(p_kind text, p_body text, p_plain_body text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ops.platform_alert_channel c WHERE p_kind = ANY (c.kinds)) THEN
    RETURN false;
  END IF;
  INSERT INTO ops.platform_alert_posts (id, kind, body, plain_body)
  VALUES (gen_random_uuid(), p_kind, p_body, p_plain_body);
  RETURN true;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.queue_platform_alert_post(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.queue_platform_alert_post(text, text, text) TO w360_app;
ALTER FUNCTION ops.queue_platform_alert_post(text, text, text) OWNER TO w360_definer;

-- An alert's post from the workers of the release before: the escaped text only.
CREATE FUNCTION ops.queue_platform_alert_post(p_kind text, p_body text)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT ops.queue_platform_alert_post(p_kind, p_body, NULL::text)
$$;
REVOKE EXECUTE ON FUNCTION ops.queue_platform_alert_post(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.queue_platform_alert_post(text, text) TO w360_app;
ALTER FUNCTION ops.queue_platform_alert_post(text, text) OWNER TO w360_definer;

-- The posts due (the worker), as 0261 claims them, for a worker that renders the formats given:
-- while the channel's format is not among them, the posts waiting are left waiting, unclaimed and
-- their attempts untouched, for a worker that renders it (the channel's row is held, as in 0261,
-- so its format cannot change until the worker has read the address in this transaction). Each
-- post with its text escaped and unescaped (null when it was queued without), and the channel's
-- format, which the worker renders it in.
CREATE FUNCTION ops.claim_platform_alert_posts(p_limit integer, p_formats text[])
  RETURNS TABLE (id uuid, kind text, body text, plain_body text, attempts smallint,
                 created_at timestamptz, format text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_kinds text[];
  v_format text;
BEGIN
  SELECT c.kinds, c.format INTO v_kinds, v_format FROM ops.platform_alert_channel c FOR KEY SHARE;
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
  IF p_formats IS NULL OR NOT (v_format = ANY (p_formats)) THEN
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE ops.platform_alert_posts p
     SET attempts = p.attempts + 1, lease_until = now() + interval '3 minutes'
   WHERE p.id IN (SELECT d.id FROM ops.platform_alert_posts d
                   WHERE d.sent_at IS NULL AND d.failed_at IS NULL AND d.next_attempt_at <= now()
                     AND (d.lease_until IS NULL OR d.lease_until < now()) AND d.attempts < 5
                     AND (d.kind = 'test' OR d.kind = ANY (v_kinds))
                   ORDER BY d.next_attempt_at, d.id
                   LIMIT least(greatest(coalesce(p_limit, 0), 0), 10)
                   FOR UPDATE SKIP LOCKED)
  RETURNING p.id, p.kind, p.body, p.plain_body, p.attempts, p.created_at, v_format;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.claim_platform_alert_posts(integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.claim_platform_alert_posts(integer, text[]) TO w360_app;
ALTER FUNCTION ops.claim_platform_alert_posts(integer, text[]) OWNER TO w360_definer;

-- The posts due for the workers of the release before, which send a post's escaped text as a JSON
-- `text` member: claimed only while the channel's format is `text`, so such a worker is never
-- handed a card channel; otherwise the posts wait for a worker of this release.
CREATE FUNCTION ops.claim_platform_alert_posts(p_limit integer)
  RETURNS TABLE (id uuid, kind text, body text, attempts smallint, created_at timestamptz)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT c.id, c.kind, c.body, c.attempts, c.created_at
    FROM ops.claim_platform_alert_posts(p_limit, ARRAY['text']::text[]) c
$$;
REVOKE EXECUTE ON FUNCTION ops.claim_platform_alert_posts(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.claim_platform_alert_posts(integer) TO w360_app;
ALTER FUNCTION ops.claim_platform_alert_posts(integer) OWNER TO w360_definer;
