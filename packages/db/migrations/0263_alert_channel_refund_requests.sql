-- Refund requests in the chat channel, an owners' alert like the financial ones (P5-10, ADR-345).
--
-- The minute billing sweep emails platform owners about refund requests waiting for a decision,
-- of service credit (ADR-073) and of plan payments (ADR-104), with counts only. A channel can now
-- get the same notice: the kind `refund_requests`, which an owner adds as the financial alerts
-- (0261), since its posts reach whoever reads the channel. Its post is the email's text: how many
-- requests, of which kind, and where they are listed, never a company, an amount or a reason.

-- The kinds a channel can get and the posts' kinds take the new one; the channel is one row at most
-- and posts are kept 7 days, so both checks are validated here.
ALTER TABLE ops.platform_alert_channel
  DROP CONSTRAINT platform_alert_channel_kinds_check,
  ADD CONSTRAINT platform_alert_channel_kinds_check
    CHECK (cardinality(kinds) BETWEEN 1 AND 6 AND array_ndims(kinds) = 1
           AND kinds <@ ARRAY['failures', 'queues', 'integrations', 'reconciliation', 'unsettled',
                              'refund_requests']::text[]);
ALTER TABLE ops.platform_alert_posts
  DROP CONSTRAINT platform_alert_posts_kind_check,
  ADD CONSTRAINT platform_alert_posts_kind_check
    CHECK (kind IN ('failures', 'queues', 'integrations', 'reconciliation', 'unsettled',
                    'refund_requests', 'test'));

-- Choosing the kinds takes the new one, in the console's order after the financial alerts; the
-- rest is 0261's. Replaced as 0261 replaced its functions: dropped as their owner, created again,
-- granted and handed back, in this migration's transaction.
SET ROLE w360_definer;
DROP FUNCTION ops.platform_set_alert_channel_kinds(text[], text);
RESET ROLE;

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
                                   'unsettled', 'refund_requests'];
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
