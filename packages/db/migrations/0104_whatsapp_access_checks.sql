-- Checking each company's WhatsApp access before sends fail (P2-12, ADR-137). Every connected
-- account's token is checked daily with debug_token, and at once when Meta refuses it for a send or a
-- template sync. The account records when a check was last attempted and asked for, the error of a
-- check that could not be made, the expiry Meta reports and when its owners were reminded of it, and
-- why Meta no longer accepts the access (the account then needs reconnecting).
ALTER TABLE app.whatsapp_accounts
  ADD COLUMN token_check_attempted_at timestamptz,
  ADD COLUMN token_check_requested_at timestamptz,
  ADD COLUMN token_check_error text CHECK (char_length(token_check_error) <= 300),
  ADD COLUMN token_expires_at timestamptz,
  ADD COLUMN token_expiry_reminded_at timestamptz,
  ADD COLUMN token_problem text
    CHECK (token_problem IN ('invalid', 'other_app', 'missing_permission', 'account_not_shared')),
  ADD COLUMN token_problem_at timestamptz;

GRANT UPDATE (token_check_attempted_at, token_check_requested_at, token_check_error, token_expires_at,
  token_expiry_reminded_at, token_problem, token_problem_at) ON app.whatsapp_accounts TO w360_app;
-- The sweep's due list and the operations console read these through the definer functions below.
GRANT SELECT (token_checked_at, token_check_attempted_at, token_check_requested_at, token_check_error,
  token_expires_at, token_problem, token_problem_at, created_at)
  ON app.whatsapp_accounts TO w360_definer;

-- Connected accounts of active companies whose access is due a check (ids only, across companies):
-- never checked, last checked more than 24 hours ago, a check was asked since the last one, or the
-- expiry Meta reported has passed since the last one. After a check that could not be made, the next
-- attempt waits 30 minutes.
CREATE FUNCTION ops.whatsapp_access_checks_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, whatsapp_account_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.tenant_id, w.id
    FROM app.whatsapp_accounts w
    JOIN app.tenants t ON t.id = w.tenant_id AND t.status = 'active'
   WHERE w.status = 'connected'
     AND w.credential_ciphertext IS NOT NULL
     AND (w.token_checked_at IS NULL
          OR w.token_checked_at < now() - interval '24 hours'
          OR w.token_check_requested_at >= w.token_checked_at
          OR (w.token_expires_at <= now() AND w.token_checked_at < w.token_expires_at))
     AND (w.token_check_attempted_at IS NULL
          OR w.token_check_attempted_at < now() - interval '30 minutes'
          OR w.token_check_attempted_at <= w.token_checked_at)
   ORDER BY w.token_checked_at NULLS FIRST, w.id
   LIMIT least(greatest(coalesce(p_limit, 1), 1), 500)
$$;
REVOKE EXECUTE ON FUNCTION ops.whatsapp_access_checks_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.whatsapp_access_checks_due(integer) TO w360_app;
ALTER FUNCTION ops.whatsapp_access_checks_due(integer) OWNER TO w360_definer;

-- Integration failures on the operations console: as in 0026, with the reason Meta no longer accepts
-- an account's access, and the connected accounts whose access could not be checked for more than a
-- day. The owner drops the function and the migration role recreates it (see 0011).
SET ROLE w360_definer;
DROP FUNCTION ops.platform_ops_integration_failures(integer);
RESET ROLE;
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
           CASE w.token_problem
             WHEN 'invalid' THEN 'Meta: the access token is no longer valid'
             WHEN 'other_app' THEN 'Meta: the access token belongs to another app'
             WHEN 'missing_permission' THEN 'Meta: a WhatsApp permission was removed'
             WHEN 'account_not_shared' THEN 'Meta: the account is no longer shared with the app'
           END,
           coalesce(w.token_problem_at, w.updated_at)
      FROM app.whatsapp_accounts w WHERE w.status = 'needs_reconnect'
    UNION ALL
    -- Connected accounts whose access could not be checked for more than a day (ADR-137): the
    -- daily check and two hours of attempts every 30 minutes failed.
    SELECT w.tenant_id, 'whatsapp_access_check', w.id, coalesce(w.name, 'WABA ' || w.waba_id),
           'not_checked', w.token_check_error, coalesce(w.token_checked_at, w.created_at)
      FROM app.whatsapp_accounts w
     WHERE w.status = 'connected'
       AND w.token_check_attempted_at > coalesce(w.token_checked_at, '-infinity'::timestamptz)
       AND coalesce(w.token_checked_at, w.created_at) < now() - interval '26 hours'
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
