-- Template syncs asked for go first (ADR-178). The minute sweep lists the WhatsApp accounts whose
-- templates need a sync, at most 100 a minute: never synced first, then the oldest sync (0005). An
-- account asked for since its last sync (a member's "Refresh from Meta", or Meta's template webhook,
-- such as an approval) waited behind every account that never synced, so with many new accounts its
-- refresh could wait longer than "within a minute". It now comes first, oldest request first, and
-- the list says so (`requested`), so the worker queues its job ahead of routine syncs. Which
-- accounts are due is unchanged. The function is owned by w360_definer, which the migration role
-- cannot replace in place (0011's note), and its result gains a column: the owner drops it and the
-- migration role creates it again, granting before handing it back.
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
