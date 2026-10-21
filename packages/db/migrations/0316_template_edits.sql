-- 0316_template_edits: editing a template Meta already has (P3-03, ADR-404).
--
-- Meta's OpenAPI description defines `POST /{TEMPLATE_ID}` (operationId `editTemplate`), whose
-- body takes the same components as creation and whose answer is `{ "success": true }` (research
-- M-086, M-201). An edit is written ahead, as a submission is: the template records the content
-- sent (`edit_components`), when and by whom it was asked (`edit_requested_at`,
-- `edit_requested_by_user_id`: the member, or null for an API key, which the audit log names) and
-- `edit_state = 'sending'` before Meta hears of it, and a `template.edit` job sends it. One edit
-- at a time per template: another is refused while one is sending. Meta's answer settles it: on
-- success the template is read again from Meta and the edit columns are cleared; on a refusal
-- `edit_state` becomes `failed` with Meta's code and message in `edit_error`, and the content
-- stays so the member can change it and send again. A lost answer is settled by the template sync:
-- Meta's components showing the content sent confirm the edit; 10 minutes after the request (or
-- after a deferral for Meta's pause, `management_deferred_until`, ADR-399) without them it becomes
-- `failed`. The template's `status`, `category` and `components` keep mirroring what Meta reports;
-- nothing is assumed about the status an edit gives.
--
-- Template content written by the company and operational metadata: exported with the template,
-- deleted with it (deletion step 730, batch).
--
-- Expand only: nullable columns without defaults, so the table is not rewritten; the checks hold
-- trivially for existing rows (all null). A web server or worker of the release before never names
-- the columns, and never sees `edit` events (it reads them as text).
ALTER TABLE app.message_templates
  ADD COLUMN edit_state text CHECK (edit_state IN ('sending', 'failed')),
  ADD COLUMN edit_components jsonb
    CHECK (jsonb_typeof(edit_components) = 'array' AND pg_column_size(edit_components) <= 32768),
  ADD COLUMN edit_error text CHECK (char_length(edit_error) <= 1000),
  ADD COLUMN edit_requested_at timestamptz,
  ADD COLUMN edit_requested_by_user_id text REFERENCES auth.users (id),
  ADD CONSTRAINT message_templates_edit_shape
    CHECK (edit_state IS NULL OR (edit_components IS NOT NULL AND edit_requested_at IS NOT NULL));

-- The web app and the worker write the edit in the company's scope (the table's RLS applies); the
-- runtime role already selects every column of the table (0005).
GRANT UPDATE (edit_state, edit_components, edit_error, edit_requested_at, edit_requested_by_user_id)
  ON app.message_templates TO w360_app;
-- The sweep's due list below reads whether an edit is sending, and nothing else of it.
GRANT SELECT (edit_state) ON app.message_templates TO w360_definer;

-- Status history records the edit (asked, refused, made) under its own source. The check is
-- replaced and validated at once: the table is append-only and holds a few rows per template, and
-- the ACCESS EXCLUSIVE lock DROP CONSTRAINT takes covers the short scan.
ALTER TABLE app.template_status_events DROP CONSTRAINT template_status_events_source_check;
ALTER TABLE app.template_status_events ADD CONSTRAINT template_status_events_source_check
  CHECK (source IN ('submit', 'sync', 'send', 'delete', 'edit'));

-- Template syncs: the due list of 0310, which also syncs every 5 minutes an account with an edit
-- still sending, so a lost answer is settled within its window. The owner drops the function and
-- the migration role creates it again, granting before handing it back (see 0011).
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
                                 AND (m.status IN ('submitting', 'pending', 'in_appeal')
                                      OR m.edit_state = 'sending'))))
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
