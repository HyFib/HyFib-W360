-- 0026_platform_ops: the platform operations console (P5-10, ADR-054). Dead letters recorded by the
-- worker, content-free read functions for platform staff and the audited retry of a webhook receipt.
-- The read functions return counts, states, error codes, labels and times; never message content,
-- contact details, payloads, email addresses, secrets or full URLs.

-- Dead letters -------------------------------------------------------------------------------------
-- One row per job the dead-letter queue received, written by the worker that consumes that queue.
-- The kind, reference and company are kept only when the job's envelope signature verified. Error
-- messages and stacks are not copied (they can quote data); only the error's name and code.
CREATE TABLE ops.dead_letters (
  id uuid PRIMARY KEY,
  source_queue text NOT NULL CHECK (source_queue ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  source_job_id uuid,
  kind text CHECK (char_length(kind) BETWEEN 1 AND 64),
  tenant_id uuid,
  ref text CHECK (char_length(ref) BETWEEN 1 AND 200),
  verified boolean NOT NULL,
  retries integer CHECK (retries >= 0),
  error_name text CHECK (error_name ~ '^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$'),
  error_code text CHECK (error_code ~ '^[A-Za-z0-9_]{1,64}$'),
  first_queued_at timestamptz,
  failed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (verified OR (kind IS NULL AND tenant_id IS NULL AND ref IS NULL))
);
CREATE INDEX dead_letters_failed_idx ON ops.dead_letters (failed_at DESC);
CREATE INDEX dead_letters_queue_idx ON ops.dead_letters (source_queue, failed_at DESC);
CREATE INDEX dead_letters_tenant_idx ON ops.dead_letters (tenant_id, failed_at DESC)
  WHERE tenant_id IS NOT NULL;
-- The worker inserts (a retried recording's duplicates are ignored) and cannot read; platform staff
-- read; only the purge function deletes.
GRANT INSERT ON ops.dead_letters TO w360_app;
GRANT SELECT ON ops.dead_letters TO w360_platform;
GRANT SELECT, DELETE ON ops.dead_letters TO w360_definer;

-- Deletes dead letters 30 days after the job failed (the retention sweep).
CREATE FUNCTION ops.purge_dead_letters(p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM ops.dead_letters
   WHERE id IN (SELECT d.id FROM ops.dead_letters d
                 WHERE d.failed_at < now() - interval '30 days'
                 ORDER BY d.failed_at LIMIT least(greatest(p_limit, 1), 5000));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.purge_dead_letters(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.purge_dead_letters(integer) TO w360_app;
ALTER FUNCTION ops.purge_dead_letters(integer) OWNER TO w360_definer;

-- What the read functions need, and nothing else ----------------------------------------------------
GRANT SELECT (phone_number_id, quality_rating, health_checked_at, onboarding_step, onboarding_error,
  created_at, updated_at) ON app.channel_accounts TO w360_definer;
GRANT SELECT (name, waba_id, updated_at) ON app.whatsapp_accounts TO w360_definer;
GRANT SELECT (direction, created_at, sender_type, error_code, template_id) ON app.messages TO w360_definer;
GRANT SELECT (id, category) ON app.message_templates TO w360_definer;
GRANT SELECT (store_url, status_error, sync_error, webhook_error, updated_at) ON app.commerce_stores
  TO w360_definer;
GRANT SELECT (status, status_error, checked_at, updated_at) ON app.commerce_payment_accounts TO w360_definer;
GRANT SELECT (id, error, updated_at) ON app.commerce_syncs TO w360_definer;
GRANT SELECT (sync_op, sync_error, updated_at, archived_at) ON app.flows TO w360_definer;
CREATE POLICY definer_read ON app.channel_onboarding_sessions FOR SELECT TO w360_definer USING (true);
GRANT SELECT (tenant_id, id, status, failure_reason, expires_at, created_at)
  ON app.channel_onboarding_sessions TO w360_definer;

-- The host of an http(s) URL, lower-cased; the path and query (which can carry tokens) are dropped.
CREATE FUNCTION ops.url_host(p_url text)
  RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT lower(substring(p_url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?(\[[^]/?#]*\]|[^:/?#]+)'));
$$;
REVOKE EXECUTE ON FUNCTION ops.url_host(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.url_host(text) TO w360_definer;

-- Health: one row per company (every company not deleted, or one) ---------------------------------
CREATE FUNCTION ops.platform_ops_health(p_tenant_id uuid)
  RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_slug text, tenant_status text,
    created_at timestamptz, plan_status text, numbers_total integer, numbers_active integer,
    numbers_reconnect integer, numbers_failed integer, quality_rating text,
    quality_checked_at timestamptz, accounts_reconnect integer, outbound_24h integer,
    failed_24h integer, inbound_24h integer, last_message_at timestamptz, endpoints_failing integer,
    endpoints_auto_disabled integer, stores_failed integer, payment_accounts_failed integer,
    catalog_syncs_failed integer, flow_syncs_failed integer, dead_letters_7d integer)
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
  SELECT t.id, t.name, t.slug, t.status, t.created_at, tp.status,
    coalesce(n.total, 0), coalesce(n.active, 0), coalesce(n.reconnect, 0), coalesce(n.failed, 0),
    q.quality_rating, q.health_checked_at,
    (SELECT count(*)::integer FROM app.whatsapp_accounts w
      WHERE w.tenant_id = t.id AND w.status = 'needs_reconnect'),
    coalesce(m.outbound, 0), coalesce(m.failed, 0), coalesce(m.inbound, 0),
    (SELECT max(lm.created_at) FROM app.messages lm WHERE lm.tenant_id = t.id),
    (SELECT count(*)::integer FROM app.webhook_endpoints e
      WHERE e.tenant_id = t.id AND e.state = 'active' AND e.failing_since IS NOT NULL),
    (SELECT count(*)::integer FROM app.webhook_endpoints e
      WHERE e.tenant_id = t.id AND e.state = 'disabled' AND e.disabled_reason = 'failing'
        AND e.disabled_at >= now() - interval '7 days'),
    (SELECT count(*)::integer FROM app.commerce_stores s
      WHERE s.tenant_id = t.id
        AND (s.state = 'failed'
             OR (s.state = 'connected' AND (s.sync_error IS NOT NULL OR s.webhook_error IS NOT NULL)))),
    (SELECT count(*)::integer FROM app.commerce_payment_accounts pa
      WHERE pa.tenant_id = t.id AND pa.status = 'failed'),
    (SELECT count(*)::integer FROM app.commerce_syncs cs
      WHERE cs.tenant_id = t.id AND cs.state = 'failed'),
    (SELECT count(*)::integer FROM app.flows f
      WHERE f.tenant_id = t.id AND f.sync_state = 'failed' AND f.archived_at IS NULL),
    (SELECT count(*)::integer FROM ops.dead_letters d
      WHERE d.tenant_id = t.id AND d.failed_at >= now() - interval '7 days')
  FROM app.tenants t
  LEFT JOIN app.tenant_plans tp ON tp.tenant_id = t.id
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE c.status <> 'disconnected')::integer AS total,
           count(*) FILTER (WHERE c.status = 'active')::integer AS active,
           count(*) FILTER (WHERE c.status = 'needs_reconnect')::integer AS reconnect,
           count(*) FILTER (WHERE c.status = 'failed')::integer AS failed
      FROM app.channel_accounts c WHERE c.tenant_id = t.id) n ON true
  LEFT JOIN LATERAL (
    SELECT c.quality_rating, c.health_checked_at
      FROM app.channel_accounts c
     WHERE c.tenant_id = t.id AND c.status = 'active' AND c.quality_rating IS NOT NULL
     ORDER BY CASE upper(c.quality_rating) WHEN 'RED' THEN 3 WHEN 'YELLOW' THEN 2
                                           WHEN 'GREEN' THEN 1 ELSE 0 END DESC,
              c.health_checked_at DESC NULLS LAST
     LIMIT 1) q ON true
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE mm.direction = 'outbound')::integer AS outbound,
           count(*) FILTER (WHERE mm.direction = 'outbound' AND mm.status = 'failed')::integer AS failed,
           count(*) FILTER (WHERE mm.direction = 'inbound')::integer AS inbound
      FROM app.messages mm
     WHERE mm.tenant_id = t.id AND mm.created_at >= now() - interval '24 hours') m ON true
  WHERE t.status <> 'deleted' AND (p_tenant_id IS NULL OR t.id = p_tenant_id)
  ORDER BY t.created_at DESC, t.id;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_health(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_health(uuid) TO w360_platform;
ALTER FUNCTION ops.platform_ops_health(uuid) OWNER TO w360_definer;

-- Activity since a time (every company not deleted, or one): usage and the facts behind the review
-- signals ------------------------------------------------------------------------------------------------
CREATE FUNCTION ops.platform_ops_activity(p_since timestamptz, p_tenant_id uuid)
  RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_slug text, tenant_status text,
    outbound integer, outbound_agent integer, outbound_bot integer, outbound_campaign integer,
    outbound_api integer, outbound_system integer, failed integer, inbound integer,
    marketing_sent integer, marketing_delivered integer, error_131049 integer, error_131050 integer,
    marketing_opt_outs integer, complaints integer, webhook_deliveries integer,
    automation_runs integer, runs_period_start timestamptz, members integer, numbers integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF p_since IS NULL OR p_since > now() OR p_since < now() - interval '93 days' THEN
    RAISE EXCEPTION 'the period must start within the last 93 days' USING ERRCODE = 'W3412';
  END IF;
  RETURN QUERY
  WITH deliveries AS (
    SELECT d.tenant_id, count(*)::integer AS n
      FROM app.webhook_deliveries d
     WHERE d.created_at >= p_since AND (p_tenant_id IS NULL OR d.tenant_id = p_tenant_id)
     GROUP BY d.tenant_id
  ), complaint_rows AS (
    SELECT s.tenant_id, count(*)::integer AS n
      FROM app.suppressions s
     WHERE s.reason = 'complaint' AND s.created_at >= p_since
       AND (p_tenant_id IS NULL OR s.tenant_id = p_tenant_id)
     GROUP BY s.tenant_id
  )
  SELECT t.id, t.name, t.slug, t.status,
    coalesce(m.outbound, 0), coalesce(m.agent, 0), coalesce(m.bot, 0), coalesce(m.campaign, 0),
    coalesce(m.api, 0), coalesce(m.system, 0), coalesce(m.failed, 0), coalesce(m.inbound, 0),
    coalesce(m.marketing_sent, 0), coalesce(m.marketing_delivered, 0),
    coalesce(m.e131049, 0), coalesce(m.e131050, 0),
    (SELECT count(*)::integer FROM app.consent_events ce
      WHERE ce.tenant_id = t.id AND ce.occurred_at >= p_since AND ce.purpose = 'marketing'
        AND ce.action = 'opt_out' AND ce.source IN ('keyword', 'provider', 'agent', 'api')),
    coalesce(cr.n, 0), coalesce(dl.n, 0), coalesce(u.used, 0), u.period_start,
    (SELECT count(*)::integer FROM app.memberships mb
      WHERE mb.tenant_id = t.id AND mb.status = 'active'),
    (SELECT count(*)::integer FROM app.channel_accounts c
      WHERE c.tenant_id = t.id AND c.status IN ('onboarding', 'active', 'needs_reconnect'))
  FROM app.tenants t
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE mm.direction = 'outbound')::integer AS outbound,
           count(*) FILTER (WHERE mm.direction = 'outbound' AND mm.sender_type = 'agent')::integer AS agent,
           count(*) FILTER (WHERE mm.direction = 'outbound' AND mm.sender_type = 'bot')::integer AS bot,
           count(*) FILTER (WHERE mm.direction = 'outbound' AND mm.sender_type = 'campaign')::integer AS campaign,
           count(*) FILTER (WHERE mm.direction = 'outbound' AND mm.sender_type = 'api')::integer AS api,
           count(*) FILTER (WHERE mm.direction = 'outbound' AND mm.sender_type = 'system')::integer AS system,
           count(*) FILTER (WHERE mm.direction = 'outbound' AND mm.status = 'failed')::integer AS failed,
           count(*) FILTER (WHERE mm.direction = 'inbound')::integer AS inbound,
           count(*) FILTER (WHERE mm.direction = 'outbound' AND tpl.category = 'MARKETING')::integer
             AS marketing_sent,
           count(*) FILTER (WHERE mm.direction = 'outbound' AND tpl.category = 'MARKETING'
                              AND mm.status IN ('delivered', 'read', 'played'))::integer
             AS marketing_delivered,
           count(*) FILTER (WHERE mm.error_code = '131049')::integer AS e131049,
           count(*) FILTER (WHERE mm.error_code = '131050')::integer AS e131050
      FROM app.messages mm
      LEFT JOIN app.message_templates tpl ON tpl.tenant_id = mm.tenant_id AND tpl.id = mm.template_id
     WHERE mm.tenant_id = t.id AND mm.created_at >= p_since) m ON true
  LEFT JOIN LATERAL (
    SELECT uc.used, uc.period_start
      FROM app.usage_counters uc
     WHERE uc.tenant_id = t.id AND uc.metric = 'automation_runs'
     ORDER BY uc.period_start DESC LIMIT 1) u ON true
  LEFT JOIN deliveries dl ON dl.tenant_id = t.id
  LEFT JOIN complaint_rows cr ON cr.tenant_id = t.id
  WHERE t.status <> 'deleted' AND (p_tenant_id IS NULL OR t.id = p_tenant_id)
  ORDER BY coalesce(m.outbound, 0) DESC, t.name, t.id;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_activity(timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_activity(timestamptz, uuid) TO w360_platform;
ALTER FUNCTION ops.platform_ops_activity(timestamptz, uuid) OWNER TO w360_definer;

-- Embedded Signup sessions that failed or were abandoned since a time --------------------------------
CREATE FUNCTION ops.platform_ops_signup_sessions(p_since timestamptz, p_limit integer)
  RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_slug text, session_id uuid, outcome text,
    failure_reason text, started_at timestamptz, has_active_number boolean)
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
  SELECT t.id, t.name, t.slug, s.id,
    CASE WHEN s.status = 'failed' THEN 'failed' ELSE 'abandoned' END,
    CASE WHEN s.status = 'failed' THEN s.failure_reason END,
    s.created_at,
    EXISTS (SELECT 1 FROM app.channel_accounts c WHERE c.tenant_id = s.tenant_id AND c.status = 'active')
  FROM app.channel_onboarding_sessions s
  JOIN app.tenants t ON t.id = s.tenant_id AND t.status <> 'deleted'
  WHERE s.created_at >= p_since
    AND (s.status IN ('failed', 'expired')
         OR (s.status IN ('started', 'exchanging') AND s.expires_at < now()))
  ORDER BY s.created_at DESC, s.id
  LIMIT least(greatest(p_limit, 1), 500);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_signup_sessions(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_signup_sessions(timestamptz, integer) TO w360_platform;
ALTER FUNCTION ops.platform_ops_signup_sessions(timestamptz, integer) OWNER TO w360_definer;

-- Current integration failures across companies -------------------------------------------------------
-- Labels are a display phone number, a business account name or the host of a URL; errors are the
-- text HyFib stored from the provider's answer.
CREATE FUNCTION ops.platform_ops_integration_failures(p_limit integer)
  RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_slug text, source text, subject_id uuid,
    label text, state text, error text, since timestamptz)
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
  SELECT t.id, t.name, t.slug, f.source, f.subject_id, f.label, f.state, f.error, f.since
  FROM (
    SELECT c.tenant_id, 'whatsapp_number'::text AS source, c.id AS subject_id,
           coalesce(c.display_phone_number, c.phone_number_id) AS label, c.status AS state,
           c.onboarding_error AS error, c.updated_at AS since
      FROM app.channel_accounts c WHERE c.status IN ('needs_reconnect', 'failed')
    UNION ALL
    SELECT w.tenant_id, 'whatsapp_account', w.id, coalesce(w.name, 'WABA ' || w.waba_id), w.status,
           NULL::text, w.updated_at
      FROM app.whatsapp_accounts w WHERE w.status = 'needs_reconnect'
    UNION ALL
    SELECT s.tenant_id, 'store', s.id, coalesce(s.shop_domain, ops.url_host(s.store_url)),
           CASE WHEN s.state = 'failed' THEN 'failed'
                WHEN s.sync_error IS NOT NULL THEN 'sync_error' ELSE 'webhook_error' END,
           CASE WHEN s.state = 'failed' THEN s.status_error
                ELSE coalesce(s.sync_error, s.webhook_error) END,
           s.updated_at
      FROM app.commerce_stores s
     WHERE s.state = 'failed'
        OR (s.state = 'connected' AND (s.sync_error IS NOT NULL OR s.webhook_error IS NOT NULL))
    UNION ALL
    SELECT pa.tenant_id, 'payment_account', pa.id, 'Razorpay'::text, pa.status, pa.status_error,
           coalesce(pa.checked_at, pa.updated_at)
      FROM app.commerce_payment_accounts pa WHERE pa.status = 'failed'
    UNION ALL
    SELECT cs.tenant_id, 'catalog_sync', cs.id, 'Catalog'::text, cs.state, cs.error,
           coalesce(cs.finished_at, cs.updated_at)
      FROM app.commerce_syncs cs WHERE cs.state = 'failed'
    UNION ALL
    SELECT fl.tenant_id, 'flow_sync', fl.id, 'Flow ' || coalesce(fl.sync_op, 'sync'), fl.sync_state,
           fl.sync_error, fl.updated_at
      FROM app.flows fl WHERE fl.sync_state = 'failed' AND fl.archived_at IS NULL
    UNION ALL
    SELECT e.tenant_id, 'webhook_endpoint', e.id, ops.url_host(e.url),
           CASE WHEN e.state = 'active' THEN 'failing' ELSE 'disabled' END, NULL::text,
           CASE WHEN e.state = 'active' THEN e.failing_since ELSE e.disabled_at END
      FROM app.webhook_endpoints e
     WHERE (e.state = 'active' AND e.failing_since IS NOT NULL)
        OR (e.state = 'disabled' AND e.disabled_reason = 'failing')
  ) f
  JOIN app.tenants t ON t.id = f.tenant_id AND t.status <> 'deleted'
  ORDER BY f.since DESC NULLS LAST, f.subject_id
  LIMIT least(greatest(p_limit, 1), 1000);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_integration_failures(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_integration_failures(integer) TO w360_platform;
ALTER FUNCTION ops.platform_ops_integration_failures(integer) OWNER TO w360_definer;

-- Retrying a webhook receipt ----------------------------------------------------------------------------
-- A receipt that failed or was quarantined goes back to pending with no attempts, if its body is still
-- kept; the sweep processes it again (processing is idempotent). Written to the platform audit log.
GRANT UPDATE (status, attempts, lease_until) ON ops.webhook_receipts TO w360_definer;
CREATE FUNCTION ops.platform_retry_webhook_receipt(p_receipt_id uuid, p_reason text,
    p_correlation_id text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_provider text;
  v_status text;
  v_attempts integer;
  v_has_body boolean;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters.' USING ERRCODE = 'W3412';
  END IF;
  SELECT r.provider, r.status, r.attempts, r.body_ciphertext IS NOT NULL
    INTO v_provider, v_status, v_attempts, v_has_body
    FROM ops.webhook_receipts r WHERE r.id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Webhook receipt not found.' USING ERRCODE = 'W3404';
  END IF;
  IF v_status NOT IN ('failed', 'quarantined') THEN
    RAISE EXCEPTION 'Only a failed or quarantined receipt can be retried.' USING ERRCODE = 'W3412';
  END IF;
  IF NOT v_has_body THEN
    RAISE EXCEPTION 'This receipt''s body was erased after 7 days, so it cannot be processed again.'
      USING ERRCODE = 'W3412';
  END IF;
  UPDATE ops.webhook_receipts SET status = 'pending', attempts = 0, lease_until = NULL
   WHERE id = p_receipt_id;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, reason, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.webhook_receipt_retried', btrim(p_reason), 'success', p_correlation_id,
          jsonb_build_object('receiptId', p_receipt_id, 'provider', v_provider,
                             'previousStatus', v_status, 'attempts', v_attempts));
  RETURN v_status;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_retry_webhook_receipt(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_retry_webhook_receipt(uuid, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_retry_webhook_receipt(uuid, text, text) OWNER TO w360_definer;
