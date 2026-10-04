-- Alerts to platform staff for companies' failing integrations (P5-10, ADR-139). The operations
-- console's Integrations page lists what fails now (ADR-054, ADR-137, ADR-138), but staff saw it
-- only when they looked. The worker's minute sweep now emails every platform administrator once
-- about each failure, at most every 15 minutes, with counts only; the console and the alert read
-- the same list.

-- Every integration failure of the companies not deleted, as the console lists them: the one rule
-- for the console and the alert. Only its owner may call it, so it is read through the definer
-- functions below.
CREATE FUNCTION ops.integration_failures()
  RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_slug text, source text, subject_id uuid,
    label text, state text, error text, since timestamptz)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
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
    -- Connected accounts whose webhooks HyFib's app is known to be no longer subscribed to, with the
    -- error of the last attempt to subscribe it again (ADR-138).
    SELECT w.tenant_id, 'whatsapp_webhooks', w.id, coalesce(w.name, 'WABA ' || w.waba_id),
           'not_subscribed', w.webhooks_check_error, w.webhooks_missing_since
      FROM app.whatsapp_accounts w
     WHERE w.status = 'connected' AND w.webhooks_missing_since IS NOT NULL
    UNION ALL
    -- Connected accounts whose subscription could not be checked for more than a day.
    SELECT w.tenant_id, 'whatsapp_webhooks', w.id, coalesce(w.name, 'WABA ' || w.waba_id),
           'not_checked', w.webhooks_check_error, coalesce(w.webhooks_checked_at, w.created_at)
      FROM app.whatsapp_accounts w
     WHERE w.status = 'connected'
       AND w.webhooks_missing_since IS NULL
       AND w.webhooks_check_error IS NOT NULL
       AND coalesce(w.webhooks_checked_at, w.created_at) < now() - interval '26 hours'
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
$$;
REVOKE EXECUTE ON FUNCTION ops.integration_failures() FROM PUBLIC;
ALTER FUNCTION ops.integration_failures() OWNER TO w360_definer;

-- The console's list as in 0105, read from the shared rule. The owner drops the function and the
-- migration role recreates it (see 0011).
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
  SELECT f.tenant_id, f.tenant_name, f.tenant_slug, f.source, f.subject_id, f.label, f.state,
         f.error, f.since
    FROM ops.integration_failures() f
   ORDER BY f.since DESC NULLS LAST, f.subject_id
   LIMIT least(greatest(p_limit, 1), 1000);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_integration_failures(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_integration_failures(integer) TO w360_platform;
ALTER FUNCTION ops.platform_ops_integration_failures(integer) OWNER TO w360_definer;

-- The failures staff were emailed about: one row per integration (source and subject) and state.
-- `listed_at` is when the alert check last found it listed; a row whose failure has not been listed
-- for an hour is forgotten, so a later failure of the same integration is told again, and one that
-- comes and goes within the hour is not told at every return.
CREATE TABLE ops.integration_alerts (
  source text NOT NULL CHECK (char_length(source) <= 40),
  subject_id uuid NOT NULL,
  state text NOT NULL CHECK (char_length(state) <= 40),
  alerted_at timestamptz NOT NULL,
  listed_at timestamptz NOT NULL,
  CONSTRAINT integration_alerts_pkey PRIMARY KEY (source, subject_id, state)
);
GRANT SELECT, INSERT, DELETE, UPDATE (listed_at) ON ops.integration_alerts TO w360_definer;

-- Integration failures have their own cadence beside the other two alerts.
ALTER TABLE ops.platform_alerts
  DROP CONSTRAINT platform_alerts_kind_check,
  ADD CONSTRAINT platform_alerts_kind_check
    CHECK (kind IN ('failures', 'queues', 'integrations'));
INSERT INTO ops.platform_alerts (kind) VALUES ('integrations');

-- The sweep's check: keeps the marks of failures still listed (refreshed at most every 10 minutes),
-- forgets the marks of failures not listed for an hour, and returns how many listed failures were
-- not told yet.
CREATE FUNCTION ops.integration_alerts_due()
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_due integer;
BEGIN
  UPDATE ops.integration_alerts a SET listed_at = now()
    FROM ops.integration_failures() f
   WHERE a.source = f.source AND a.subject_id = f.subject_id AND a.state = f.state
     AND a.listed_at < now() - interval '10 minutes';
  DELETE FROM ops.integration_alerts a WHERE a.listed_at < now() - interval '1 hour';
  SELECT count(*)::integer INTO v_due
    FROM ops.integration_failures() f
   WHERE NOT EXISTS (SELECT 1 FROM ops.integration_alerts a
                      WHERE a.source = f.source AND a.subject_id = f.subject_id
                        AND a.state = f.state);
  RETURN v_due;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.integration_alerts_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.integration_alerts_due() TO w360_app;
ALTER FUNCTION ops.integration_alerts_due() OWNER TO w360_definer;

-- Marks the listed failures not told yet (at most 1,000, the oldest first), in the transaction that
-- queues the alert's emails, and returns how many by source and state. Nothing while the last
-- integration alert went out less than 15 minutes ago: they wait for the next one. Two sweeps at
-- once queue at most one alert (the row lock on ops.platform_alerts), and a failure already marked
-- is skipped.
CREATE FUNCTION ops.mark_integration_alert()
  RETURNS TABLE (source text, state text, items integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_last timestamptz;
BEGIN
  SELECT a.last_sent_at INTO v_last
    FROM ops.platform_alerts a WHERE a.kind = 'integrations' FOR UPDATE;
  IF v_last > now() - interval '15 minutes' THEN
    RETURN;
  END IF;
  RETURN QUERY
    WITH due AS (
      SELECT DISTINCT f.source, f.subject_id, f.state, f.since
        FROM ops.integration_failures() f
       WHERE NOT EXISTS (SELECT 1 FROM ops.integration_alerts a
                          WHERE a.source = f.source AND a.subject_id = f.subject_id
                            AND a.state = f.state)
       ORDER BY f.since NULLS LAST, f.subject_id
       LIMIT 1000
    ), marked AS (
      INSERT INTO ops.integration_alerts AS a (source, subject_id, state, alerted_at, listed_at)
      SELECT d.source, d.subject_id, d.state, now(), now() FROM due d
      ON CONFLICT ON CONSTRAINT integration_alerts_pkey DO NOTHING
      RETURNING a.source, a.state
    )
    SELECT m.source, m.state, count(*)::integer FROM marked m
     GROUP BY m.source, m.state ORDER BY m.source, m.state;
  IF FOUND THEN
    UPDATE ops.platform_alerts SET last_sent_at = now() WHERE kind = 'integrations';
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.mark_integration_alert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.mark_integration_alert() TO w360_app;
ALTER FUNCTION ops.mark_integration_alert() OWNER TO w360_definer;
