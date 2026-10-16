-- 0310_whatsapp_management_usage: pacing WhatsApp management calls by Meta's usage header (P2-02,
-- ADR-399).
--
-- Meta's responses carry `x-business-use-case-usage`: per WhatsApp Business Account, the share of
-- the rolling hour's management allowance used (calls, CPU time, total time) and the minutes until
-- management calls are no longer throttled (research M-027, M-200). Each WhatsApp account keeps the
-- latest reading for its own WABA id: when it was read, the highest of the three percentages, and
-- until when Meta throttles management calls (set only while Meta reports minutes to regain
-- access). While that time has not passed, background management work for the account (template
-- syncs, access checks, flow operations and key uploads, catalog reads) is not signalled by the
-- sweep, and members' management actions say Meta is limiting management requests until then.
-- The values are Meta's counters about the company's own account, no personal data; they are
-- exported with the account and deleted with it.
--
-- Work a pause defers must not age while it waits: a template submission or deletion, a flow
-- operation and a catalog read each record, on their own row, when their deferred job runs again
-- (`management_deferred_until`), and the windows that give up on such a request (the sync's
-- 10-minute confirmation window and 8-hour deletion keep, the sweep's 30-minute give-up) count from
-- the later of the request and that time. The request's own time, which members see, is unchanged.
ALTER TABLE app.whatsapp_accounts
  ADD COLUMN management_usage_read_at timestamptz,
  ADD COLUMN management_usage_percent smallint
    CHECK (management_usage_percent BETWEEN 0 AND 100),
  ADD COLUMN management_paused_until timestamptz;

-- The worker and the web app write readings in the company's scope (the table's RLS applies);
-- w360_app already reads every column of the table.
GRANT UPDATE (management_usage_read_at, management_usage_percent, management_paused_until)
  ON app.whatsapp_accounts TO w360_app;
-- The sweep's due lists below read the pause through their definer functions.
GRANT SELECT (management_paused_until) ON app.whatsapp_accounts TO w360_definer;
GRANT SELECT (whatsapp_account_id) ON app.flows TO w360_definer;

ALTER TABLE app.message_templates ADD COLUMN management_deferred_until timestamptz;
ALTER TABLE app.flows ADD COLUMN management_deferred_until timestamptz;
ALTER TABLE app.commerce_syncs ADD COLUMN management_deferred_until timestamptz;
GRANT UPDATE (management_deferred_until) ON app.message_templates TO w360_app;
GRANT UPDATE (management_deferred_until) ON app.flows TO w360_app;
GRANT UPDATE (management_deferred_until) ON app.commerce_syncs TO w360_app;
-- The sweep's due lists below leave out operations whose deferred job has not run yet.
GRANT SELECT (management_deferred_until) ON app.flows TO w360_definer;
GRANT SELECT (management_deferred_until) ON app.commerce_syncs TO w360_definer;

-- Template syncs: the due list of 0126, without accounts Meta is throttling. The owner drops the
-- function and the migration role creates it again, granting before handing it back (see 0011).
SET ROLE w360_definer;
DROP FUNCTION ops.template_sync_due(integer);
RESET ROLE;
CREATE FUNCTION ops.template_sync_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, whatsapp_account_id uuid, requested boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT d.tenant_id, d.id, d.requested
    FROM (
      SELECT w.tenant_id, w.id, w.templates_synced_at, w.templates_sync_requested_at,
             coalesce(w.templates_sync_requested_at >= w.templates_synced_at, false)
               OR (w.templates_synced_at IS NULL AND w.templates_sync_requested_at IS NOT NULL)
               AS requested
        FROM app.whatsapp_accounts w
        JOIN app.tenants t ON t.id = w.tenant_id AND t.status = 'active'
       WHERE w.status = 'connected'
         AND (w.management_paused_until IS NULL OR w.management_paused_until <= now())
         AND (w.templates_synced_at IS NULL
              OR w.templates_synced_at < now() - interval '6 hours'
              OR (w.templates_sync_requested_at IS NOT NULL
                  AND w.templates_sync_requested_at >= w.templates_synced_at)
              OR (w.templates_synced_at < now() - interval '5 minutes'
                  AND EXISTS (SELECT 1 FROM app.message_templates m
                               WHERE m.tenant_id = w.tenant_id AND m.whatsapp_account_id = w.id
                                 AND m.status IN ('submitting', 'pending', 'in_appeal'))))
    ) d
   ORDER BY d.requested DESC,
            CASE WHEN d.requested THEN d.templates_sync_requested_at END,
            d.templates_synced_at NULLS FIRST,
            d.id
   LIMIT least(greatest(p_limit, 1), 500)
$$;
REVOKE EXECUTE ON FUNCTION ops.template_sync_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.template_sync_due(integer) TO w360_app;
ALTER FUNCTION ops.template_sync_due(integer) OWNER TO w360_definer;

-- Access checks: the due list of 0105, without accounts Meta is throttling (the check lists and
-- restores the webhook subscription, a management call).
SET ROLE w360_definer;
DROP FUNCTION ops.whatsapp_access_checks_due(integer);
RESET ROLE;
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
     AND (w.management_paused_until IS NULL OR w.management_paused_until <= now())
     AND (w.token_checked_at IS NULL
          OR w.token_checked_at < now() - interval '24 hours'
          OR w.token_check_requested_at >= w.token_checked_at
          OR (w.token_expires_at <= now() AND w.token_checked_at < w.token_expires_at)
          OR (w.webhooks_check_error IS NOT NULL
              AND w.token_check_attempted_at < now() - interval '30 minutes'))
     AND (w.token_check_attempted_at IS NULL
          OR w.token_check_attempted_at < now() - interval '30 minutes'
          OR w.token_check_attempted_at <= w.token_checked_at)
   ORDER BY w.token_checked_at NULLS FIRST, w.id
   LIMIT least(greatest(coalesce(p_limit, 1), 1), 500)
$$;
REVOKE EXECUTE ON FUNCTION ops.whatsapp_access_checks_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.whatsapp_access_checks_due(integer) TO w360_app;
ALTER FUNCTION ops.whatsapp_access_checks_due(integer) OWNER TO w360_definer;

-- Flow work: the list of 0017, without flow operations and key work of accounts Meta is
-- throttling, nor flow operations whose deferred job has not run yet (that job runs them just after
-- the pause; the sweep re-signals them, and gives up on them, only after it).
SET ROLE w360_definer;
DROP FUNCTION ops.flow_work_due(integer);
RESET ROLE;
CREATE FUNCTION ops.flow_work_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, kind text, ref uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  (SELECT f.tenant_id, 'sync'::text, f.id
     FROM app.flows f JOIN app.tenants t ON t.id = f.tenant_id AND t.status = 'active'
    WHERE f.sync_state IN ('queued', 'running') AND f.sync_requested_at < now() - interval '2 minutes'
      AND (f.management_deferred_until IS NULL OR f.management_deferred_until <= now())
      AND NOT EXISTS (SELECT 1 FROM app.whatsapp_accounts w
                       WHERE w.tenant_id = f.tenant_id AND w.id = f.whatsapp_account_id
                         AND w.management_paused_until > now())
    ORDER BY f.sync_requested_at
    LIMIT p_limit)
  UNION ALL
  (SELECT k.tenant_id, 'keys'::text, k.whatsapp_account_id
     FROM app.flow_keys k JOIN app.tenants t ON t.id = k.tenant_id AND t.status = 'active'
    WHERE ((k.state = 'previous' AND k.replaced_at < now() - interval '24 hours')
       OR (k.state = 'active' AND (
            EXISTS (SELECT 1 FROM app.flow_key_uploads u
                     WHERE u.tenant_id = k.tenant_id AND u.key_id = k.id AND u.state = 'pending'
                       AND u.updated_at < now() - interval '2 minutes')
            OR EXISTS (SELECT 1 FROM app.channel_accounts c
                        WHERE c.tenant_id = k.tenant_id AND c.whatsapp_account_id = k.whatsapp_account_id
                          AND c.status = 'active'
                          AND NOT EXISTS (SELECT 1 FROM app.flow_key_uploads u
                                           WHERE u.tenant_id = k.tenant_id AND u.key_id = k.id
                                             AND u.channel_account_id = c.id)))))
      AND NOT EXISTS (SELECT 1 FROM app.whatsapp_accounts w
                       WHERE w.tenant_id = k.tenant_id AND w.id = k.whatsapp_account_id
                         AND w.management_paused_until > now())
    LIMIT p_limit)
$$;
REVOKE EXECUTE ON FUNCTION ops.flow_work_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.flow_work_due(integer) TO w360_app;
ALTER FUNCTION ops.flow_work_due(integer) OWNER TO w360_definer;

-- Commerce work: the list of 0018, without catalog reads of accounts Meta is throttling, nor
-- catalog reads whose deferred job has not run yet (that job runs them just after the pause). Payment Links go to Razorpay and are
-- listed as before.
SET ROLE w360_definer;
DROP FUNCTION ops.commerce_work_due(integer);
RESET ROLE;
CREATE FUNCTION ops.commerce_work_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, kind text, ref uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  (SELECT s.tenant_id, 'sync'::text, s.whatsapp_account_id
     FROM app.commerce_syncs s JOIN app.tenants t ON t.id = s.tenant_id AND t.status = 'active'
    WHERE ((s.state IN ('queued', 'running') AND s.requested_at < now() - interval '5 minutes')
       OR (s.state = 'idle' AND s.finished_at < now() - interval '24 hours'))
      AND (s.management_deferred_until IS NULL OR s.management_deferred_until <= now())
      AND NOT EXISTS (SELECT 1 FROM app.whatsapp_accounts w
                       WHERE w.tenant_id = s.tenant_id AND w.id = s.whatsapp_account_id
                         AND w.management_paused_until > now())
    ORDER BY s.requested_at NULLS FIRST
    LIMIT p_limit)
  UNION ALL
  (SELECT l.tenant_id, 'link'::text, l.id
     FROM app.commerce_payment_links l JOIN app.tenants t ON t.id = l.tenant_id AND t.status = 'active'
    WHERE l.status IN ('creating', 'created', 'partially_paid') AND l.next_check_at <= now()
      AND (l.lease_until IS NULL OR l.lease_until < now())
    ORDER BY l.next_check_at
    LIMIT p_limit)
$$;
REVOKE EXECUTE ON FUNCTION ops.commerce_work_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.commerce_work_due(integer) TO w360_app;
ALTER FUNCTION ops.commerce_work_due(integer) OWNER TO w360_definer;

-- Dead letters (0089): a setup or a deletion whose job died is settled only when no live job is
-- doing the work again. A job deferred for a pause waits under the key `paused:<id of the job that
-- deferred>`, which names no work, so the work is read from its envelope's `ref` (the definer reads
-- `data`, granted by the migration runner). Otherwise as in 0089: not SECURITY DEFINER (only the
-- definer functions of 0089 call it), search path pinned, not executable by PUBLIC. The owner drops
-- it and the migration role creates it again (see 0011); 0089's SQL functions that call it resolve
-- it when they run.
SET ROLE w360_definer;
DROP FUNCTION ops.dead_letter_work_live(text, text);
RESET ROLE;
CREATE FUNCTION ops.dead_letter_work_live(p_queue text, p_ref text)
  RETURNS boolean
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM pgboss.job j
     WHERE j.name = p_queue
       AND j.state IN ('created', 'retry', 'active')
       AND CASE p_queue
             WHEN 'channel.onboard' THEN j.singleton_key = p_ref
               OR (starts_with(j.singleton_key, 'paused:') AND j.data->>'ref' = p_ref)
             WHEN 'template.delete' THEN j.singleton_key = p_ref || ':delete'
               OR (starts_with(j.singleton_key, 'paused:') AND j.data->>'ref' = p_ref)
             WHEN 'commerce.account' THEN starts_with(j.singleton_key, p_ref || ':')
             ELSE false
           END);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.dead_letter_work_live(text, text) FROM PUBLIC;
ALTER FUNCTION ops.dead_letter_work_live(text, text) OWNER TO w360_definer;
