-- Company export and deletion (P5-11, ADR-055), and three fixes found while building it.
--
-- Deletion: an owner's request puts the company in `pending_deletion` for 14 days (cancellable);
-- then the worker cleans up at providers and deletes the company's rows in a fixed order, a batch
-- per transaction, through the SECURITY DEFINER functions below. The company row stays as a
-- tombstone, and billing records, plan history and platform evidence are kept.

-- The deletion register: one row per request, kept after the company is deleted.
CREATE TABLE ops.tenant_deletions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  requested_by_user_id text NOT NULL REFERENCES auth.users (id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  previous_status text NOT NULL CHECK (previous_status IN ('active', 'suspended', 'restricted')),
  previous_status_reason text CHECK (char_length(previous_status_reason) <= 2000),
  company_name text NOT NULL CHECK (char_length(company_name) BETWEEN 1 AND 120),
  cancelled_at timestamptz,
  cancelled_by_user_id text REFERENCES auth.users (id),
  started_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Owners and administrators when the run started: they get the final email.
  notify_user_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(notify_user_ids) <= 500),
  -- What happened at each provider: [{kind, label, outcome, code}] (no secrets, no content).
  provider_cleanup jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(provider_cleanup) = 'array' AND pg_column_size(provider_cleanup) <= 32768),
  -- Set once the providers were visited, so a resumed run never calls them again.
  provider_cleanup_at timestamptz,
  rows_deleted bigint NOT NULL DEFAULT 0 CHECK (rows_deleted >= 0),
  completed_at timestamptz,
  CONSTRAINT tenant_deletions_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT tenant_deletions_ended_chk CHECK (cancelled_at IS NULL OR completed_at IS NULL),
  CONSTRAINT tenant_deletions_cancel_chk CHECK (cancelled_at IS NULL OR started_at IS NULL),
  CONSTRAINT tenant_deletions_complete_chk CHECK (completed_at IS NULL OR started_at IS NOT NULL)
);
CREATE UNIQUE INDEX tenant_deletions_open_uq ON ops.tenant_deletions (tenant_id)
  WHERE cancelled_at IS NULL AND completed_at IS NULL;
CREATE INDEX tenant_deletions_due_idx ON ops.tenant_deletions (due_at)
  WHERE cancelled_at IS NULL AND completed_at IS NULL;
SELECT ops.apply_tenant_rls('ops.tenant_deletions');
CREATE POLICY platform_read ON ops.tenant_deletions FOR SELECT TO w360_platform USING (true);
CREATE POLICY definer_all ON ops.tenant_deletions TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT (id, tenant_id, requested_by_user_id, requested_at, due_at, cancelled_at,
  cancelled_by_user_id, started_at, completed_at) ON ops.tenant_deletions TO w360_app;
GRANT SELECT ON ops.tenant_deletions TO w360_platform;
GRANT SELECT, INSERT, UPDATE ON ops.tenant_deletions TO w360_definer;

-- The order in which a company's rows are deleted: children before parents. A step holds one
-- table deleted a batch at a time, or tables deleted whole in one statement (the automations and
-- versions cycle, the two self-referencing tables, and the two one-row settings tables). Every
-- table with tenant_id is either here or kept on purpose; tests check both, and the order against
-- the foreign keys.
CREATE TABLE ops.tenant_deletion_steps (
  ordinal integer PRIMARY KEY CHECK (ordinal > 0),
  tables regclass[] NOT NULL CHECK (cardinality(tables) BETWEEN 1 AND 4),
  mode text NOT NULL CHECK (mode IN ('batch', 'whole')),
  CHECK (mode = 'whole' OR cardinality(tables) = 1)
);
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (10, ARRAY['ops.provider_asset_bindings']::regclass[], 'batch'),
  (20, ARRAY['ops.email_outbox']::regclass[], 'batch'),
  (30, ARRAY['ops.dead_letters']::regclass[], 'batch'),
  (40, ARRAY['app.webhook_deliveries']::regclass[], 'batch'),
  (50, ARRAY['app.webhook_events']::regclass[], 'batch'),
  (60, ARRAY['app.webhook_endpoints']::regclass[], 'batch'),
  (70, ARRAY['app.usage_counters']::regclass[], 'batch'),
  (80, ARRAY['app.tenant_events']::regclass[], 'batch'),
  (90, ARRAY['app.template_status_events']::regclass[], 'batch'),
  (100, ARRAY['app.team_members']::regclass[], 'batch'),
  (110, ARRAY['app.suppressions']::regclass[], 'batch'),
  (120, ARRAY['app.send_intents']::regclass[], 'batch'),
  (130, ARRAY['app.saved_replies']::regclass[], 'batch'),
  (140, ARRAY['app.note_mentions']::regclass[], 'batch'),
  (150, ARRAY['app.messaging_settings']::regclass[], 'whole'),
  (160, ARRAY['app.message_status_events']::regclass[], 'batch'),
  (170, ARRAY['app.member_availability']::regclass[], 'batch'),
  (180, ARRAY['app.media_objects']::regclass[], 'batch'),
  (190, ARRAY['app.invitations']::regclass[], 'batch'),
  (200, ARRAY['app.http_secrets']::regclass[], 'batch'),
  (210, ARRAY['app.http_allowed_domains']::regclass[], 'batch'),
  (220, ARRAY['app.flow_responses']::regclass[], 'batch'),
  (230, ARRAY['app.flow_sends']::regclass[], 'batch'),
  (240, ARRAY['app.flows']::regclass[], 'whole'),
  (250, ARRAY['app.flow_key_uploads']::regclass[], 'batch'),
  (260, ARRAY['app.flow_keys']::regclass[], 'batch'),
  (270, ARRAY['app.csat_surveys']::regclass[], 'batch'),
  (280, ARRAY['app.crm_activities']::regclass[], 'batch'),
  (290, ARRAY['app.crm_tasks']::regclass[], 'batch'),
  (300, ARRAY['app.crm_deals']::regclass[], 'batch'),
  (310, ARRAY['app.crm_stages']::regclass[], 'batch'),
  (320, ARRAY['app.crm_pipelines']::regclass[], 'batch'),
  (330, ARRAY['app.conversation_turns']::regclass[], 'batch'),
  (340, ARRAY['app.conversation_sources']::regclass[], 'batch'),
  (350, ARRAY['app.conversation_notes']::regclass[], 'batch'),
  (360, ARRAY['app.conversation_cases']::regclass[], 'batch'),
  (370, ARRAY['app.contact_tags']::regclass[], 'batch'),
  (380, ARRAY['app.contact_imports']::regclass[], 'batch'),
  (390, ARRAY['app.contact_identities']::regclass[], 'batch'),
  (400, ARRAY['app.contact_fields']::regclass[], 'batch'),
  (410, ARRAY['app.contact_consents']::regclass[], 'batch'),
  (420, ARRAY['app.consent_events']::regclass[], 'batch'),
  (430, ARRAY['app.commerce_syncs']::regclass[], 'batch'),
  (440, ARRAY['app.commerce_store_products']::regclass[], 'batch'),
  (450, ARRAY['app.commerce_store_privacy_requests']::regclass[], 'batch'),
  (460, ARRAY['app.commerce_store_order_items']::regclass[], 'batch'),
  (470, ARRAY['app.commerce_store_messages']::regclass[], 'batch'),
  (480, ARRAY['app.commerce_store_message_rules']::regclass[], 'batch'),
  (490, ARRAY['app.commerce_store_fetches']::regclass[], 'batch'),
  (500, ARRAY['app.commerce_store_events']::regclass[], 'batch'),
  (510, ARRAY['app.commerce_store_checkouts']::regclass[], 'batch'),
  (520, ARRAY['app.commerce_payment_links']::regclass[], 'batch'),
  (530, ARRAY['app.commerce_payment_events']::regclass[], 'batch'),
  (540, ARRAY['app.commerce_payment_accounts']::regclass[], 'batch'),
  (550, ARRAY['app.commerce_order_items']::regclass[], 'batch'),
  (560, ARRAY['app.commerce_orders']::regclass[], 'batch'),
  (570, ARRAY['app.commerce_products']::regclass[], 'batch'),
  (580, ARRAY['app.commerce_catalogs']::regclass[], 'batch'),
  (590, ARRAY['app.chat_widgets']::regclass[], 'batch'),
  (600, ARRAY['app.chat_link_clicks']::regclass[], 'batch'),
  (610, ARRAY['app.chat_links']::regclass[], 'batch'),
  (620, ARRAY['app.channel_onboarding_sessions']::regclass[], 'batch'),
  (630, ARRAY['app.campaign_recipients']::regclass[], 'batch'),
  (640, ARRAY['app.campaign_events']::regclass[], 'batch'),
  (650, ARRAY['app.business_hours']::regclass[], 'batch'),
  (660, ARRAY['app.business_holidays']::regclass[], 'batch'),
  (670, ARRAY['app.automation_run_steps']::regclass[], 'batch'),
  (680, ARRAY['app.automation_http_calls']::regclass[], 'batch'),
  (690, ARRAY['app.automation_runs']::regclass[], 'batch'),
  (700, ARRAY['app.messages']::regclass[], 'batch'),
  (710, ARRAY['app.campaigns']::regclass[], 'batch'),
  (720, ARRAY['app.segments']::regclass[], 'batch'),
  (730, ARRAY['app.message_templates']::regclass[], 'batch'),
  (740, ARRAY['app.commerce_store_orders']::regclass[], 'batch'),
  (750, ARRAY['app.commerce_stores']::regclass[], 'batch'),
  (760, ARRAY['app.automation_versions', 'app.automations']::regclass[], 'whole'),
  (770, ARRAY['app.conversations']::regclass[], 'batch'),
  (780, ARRAY['app.contacts']::regclass[], 'batch'),
  (790, ARRAY['app.channel_accounts']::regclass[], 'batch'),
  (800, ARRAY['app.teams']::regclass[], 'batch'),
  (810, ARRAY['app.memberships']::regclass[], 'batch'),
  (820, ARRAY['app.whatsapp_accounts']::regclass[], 'batch'),
  (830, ARRAY['app.auto_recharge_settings']::regclass[], 'whole'),
  (840, ARRAY['app.audit_events']::regclass[], 'batch'),
  (850, ARRAY['app.api_idempotency_keys']::regclass[], 'batch'),
  (860, ARRAY['app.api_keys']::regclass[], 'whole');
GRANT SELECT ON ops.tenant_deletion_steps TO w360_definer;

-- The company whose rows the deletion functions may read and delete (set only inside them).
CREATE FUNCTION ops.deleting_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT nullif(pg_catalog.current_setting('w360.deleting_tenant', true), '')::uuid $$;
REVOKE EXECUTE ON FUNCTION ops.deleting_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.deleting_tenant_id() TO w360_definer;

-- w360_definer may read the key columns of, and delete, only the rows of the company being deleted.
DO $$
DECLARE
  v_tables regclass[];
  v_table regclass;
BEGIN
  FOR v_tables IN SELECT s.tables FROM ops.tenant_deletion_steps s ORDER BY s.ordinal LOOP
    FOREACH v_table IN ARRAY v_tables LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = v_table AND a.attname = 'id' AND NOT a.attisdropped) THEN
        EXECUTE pg_catalog.format('GRANT SELECT (tenant_id, id), DELETE ON %s TO w360_definer', v_table);
      ELSE
        EXECUTE pg_catalog.format('GRANT SELECT (tenant_id), DELETE ON %s TO w360_definer', v_table);
      END IF;
      EXECUTE pg_catalog.format(
        'CREATE POLICY tenant_deletion_read ON %s FOR SELECT TO w360_definer '
        'USING (tenant_id = (SELECT ops.deleting_tenant_id()))', v_table);
      EXECUTE pg_catalog.format(
        'CREATE POLICY tenant_deletion_delete ON %s FOR DELETE TO w360_definer '
        'USING (tenant_id = (SELECT ops.deleting_tenant_id()))', v_table);
    END LOOP;
  END LOOP;
END
$$;

-- An owner asks for the company to be deleted; it is due 14 days later. The caller writes the
-- audit entry and the emails in the same transaction.
CREATE FUNCTION app.request_tenant_deletion(p_confirm_slug text)
  RETURNS TABLE (deletion_id uuid, due_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_user text := app.current_user_id();
  v_company record;
  v_id uuid := gen_random_uuid();
  v_due timestamptz := now() + interval '14 days';
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.memberships m
                  WHERE m.tenant_id = v_tenant AND m.user_id = v_user AND m.status = 'active'
                    AND 'owner' = ANY (m.roles)) THEN
    RAISE EXCEPTION 'Only an owner can delete the company.' USING ERRCODE = 'W3403';
  END IF;
  SELECT t.slug, t.name, t.status, t.status_reason INTO v_company
    FROM app.tenants t WHERE t.id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'company not found' USING ERRCODE = 'W3404';
  END IF;
  IF v_company.status NOT IN ('active', 'suspended', 'restricted') THEN
    RAISE EXCEPTION 'The company is already being deleted.' USING ERRCODE = 'W3412';
  END IF;
  IF p_confirm_slug IS NULL OR pg_catalog.btrim(p_confirm_slug) <> v_company.slug THEN
    RAISE EXCEPTION 'Type the company address exactly to confirm.' USING ERRCODE = 'W3412';
  END IF;
  INSERT INTO ops.tenant_deletions (id, tenant_id, requested_by_user_id, due_at, previous_status,
                                    previous_status_reason, company_name)
  VALUES (v_id, v_tenant, v_user, v_due, v_company.status, v_company.status_reason, v_company.name);
  UPDATE app.tenants
     SET status = 'pending_deletion', status_reason = 'An owner asked for the company to be deleted.',
         status_changed_at = now(), updated_at = now()
   WHERE id = v_tenant;
  RETURN QUERY SELECT v_id, v_due;
END
$$;
REVOKE EXECUTE ON FUNCTION app.request_tenant_deletion(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_tenant_deletion(text) TO w360_app;
ALTER FUNCTION app.request_tenant_deletion(text) OWNER TO w360_definer;

-- An owner cancels before the run starts: the recorded status comes back, with the plan applied
-- again (a lapsed plan restricts, a current one lifts a restriction; a suspension stays).
CREATE FUNCTION app.cancel_tenant_deletion() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_user text := app.current_user_id();
  v_deletion record;
  v_plan text;
  v_status text;
  v_reason text;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.memberships m
                  WHERE m.tenant_id = v_tenant AND m.user_id = v_user AND m.status = 'active'
                    AND 'owner' = ANY (m.roles)) THEN
    RAISE EXCEPTION 'Only an owner can cancel the deletion.' USING ERRCODE = 'W3403';
  END IF;
  PERFORM 1 FROM app.tenants t WHERE t.id = v_tenant AND t.status = 'pending_deletion' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The company is not being deleted.' USING ERRCODE = 'W3412';
  END IF;
  SELECT d.id, d.previous_status, d.previous_status_reason, d.started_at INTO v_deletion
    FROM ops.tenant_deletions d
   WHERE d.tenant_id = v_tenant AND d.cancelled_at IS NULL AND d.completed_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The company is not being deleted.' USING ERRCODE = 'W3412';
  END IF;
  IF v_deletion.started_at IS NOT NULL THEN
    RAISE EXCEPTION 'The deletion has started and can no longer be cancelled.' USING ERRCODE = 'W3412';
  END IF;
  SELECT p.status INTO v_plan FROM app.tenant_plans p WHERE p.tenant_id = v_tenant;
  IF v_deletion.previous_status = 'suspended' THEN
    v_status := 'suspended';
    v_reason := v_deletion.previous_status_reason;
  ELSIF v_plan IN ('expired', 'canceled') THEN
    v_status := 'restricted';
    v_reason := CASE v_plan WHEN 'canceled' THEN 'The plan was canceled.' ELSE 'The plan ended.' END;
  ELSE
    v_status := 'active';
    v_reason := NULL;
  END IF;
  UPDATE ops.tenant_deletions
     SET cancelled_at = now(), cancelled_by_user_id = v_user
   WHERE id = v_deletion.id;
  UPDATE app.tenants
     SET status = v_status, status_reason = v_reason, status_changed_at = now(), updated_at = now()
   WHERE id = v_tenant;
  RETURN v_status;
END
$$;
REVOKE EXECUTE ON FUNCTION app.cancel_tenant_deletion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cancel_tenant_deletion() TO w360_app;
ALTER FUNCTION app.cancel_tenant_deletion() OWNER TO w360_definer;

-- Companies whose deletion is due (for the minute sweep).
CREATE FUNCTION ops.tenant_deletions_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, deletion_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT d.tenant_id, d.id
    FROM ops.tenant_deletions d
    JOIN app.tenants t ON t.id = d.tenant_id
   WHERE d.cancelled_at IS NULL AND d.completed_at IS NULL AND d.due_at <= now()
     AND t.status = 'pending_deletion'
   ORDER BY d.due_at
   LIMIT least(greatest(coalesce(p_limit, 1), 1), 100)
$$;
REVOKE EXECUTE ON FUNCTION ops.tenant_deletions_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.tenant_deletions_due(integer) TO w360_app;
ALTER FUNCTION ops.tenant_deletions_due(integer) OWNER TO w360_definer;

-- Starts (or resumes) a due deletion: from here it cannot be cancelled. The first start records
-- who gets the final email and releases the company's WhatsApp bindings, so Meta events are no
-- longer routed to it.
CREATE FUNCTION ops.start_tenant_deletion(p_tenant_id uuid)
  RETURNS TABLE (deletion_id uuid, company_name text, notify_user_ids text[], first_start boolean,
                 provider_cleanup_done boolean, provider_cleanup jsonb)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_deletion record;
  v_first boolean;
BEGIN
  PERFORM 1 FROM app.tenants t WHERE t.id = p_tenant_id AND t.status = 'pending_deletion' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The company is not being deleted.' USING ERRCODE = 'W3412';
  END IF;
  SELECT d.id, d.due_at, d.started_at INTO v_deletion
    FROM ops.tenant_deletions d
   WHERE d.tenant_id = p_tenant_id AND d.cancelled_at IS NULL AND d.completed_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No deletion is open for this company.' USING ERRCODE = 'W3404';
  END IF;
  IF v_deletion.due_at > now() THEN
    RAISE EXCEPTION 'The deletion is not due yet.' USING ERRCODE = 'W3412';
  END IF;
  v_first := v_deletion.started_at IS NULL;
  IF v_first THEN
    UPDATE ops.tenant_deletions d
       SET started_at = now(), attempts = d.attempts + 1,
           notify_user_ids = ARRAY(
             SELECT m.user_id FROM app.memberships m
              WHERE m.tenant_id = p_tenant_id AND m.status = 'active'
                AND m.roles && ARRAY['owner', 'admin']::text[]
              ORDER BY m.user_id LIMIT 500)
     WHERE d.id = v_deletion.id;
    UPDATE ops.provider_asset_bindings b
       SET status = 'released', released_at = now()
     WHERE b.tenant_id = p_tenant_id AND b.status = 'active';
  ELSE
    UPDATE ops.tenant_deletions d SET attempts = d.attempts + 1 WHERE d.id = v_deletion.id;
  END IF;
  RETURN QUERY
    SELECT d.id, d.company_name, d.notify_user_ids, v_first, d.provider_cleanup_at IS NOT NULL,
           d.provider_cleanup
      FROM ops.tenant_deletions d WHERE d.id = v_deletion.id;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.start_tenant_deletion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.start_tenant_deletion(uuid) TO w360_app;
ALTER FUNCTION ops.start_tenant_deletion(uuid) OWNER TO w360_definer;

-- Records what happened at each provider, once per deletion.
CREATE FUNCTION ops.record_tenant_deletion_cleanup(p_tenant_id uuid, p_items jsonb) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 200
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) e
        WHERE jsonb_typeof(e) <> 'object'
           OR NOT (e->>'kind' IN ('whatsapp_account', 'shopify_store', 'woocommerce_store', 'card_mandate'))
           OR NOT (e->>'outcome' IN ('done', 'failed', 'skipped'))
           OR e->>'label' IS NULL OR char_length(e->>'label') NOT BETWEEN 1 AND 160
           OR (e ? 'code' AND e->>'code' !~ '^[a-z0-9_]{1,64}$')
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('kind', 'label', 'outcome', 'code'))) THEN
    RAISE EXCEPTION 'invalid provider cleanup outcomes' USING ERRCODE = 'W3412';
  END IF;
  UPDATE ops.tenant_deletions d SET provider_cleanup = p_items, provider_cleanup_at = now()
   WHERE d.tenant_id = p_tenant_id AND d.started_at IS NOT NULL AND d.provider_cleanup_at IS NULL
     AND d.cancelled_at IS NULL AND d.completed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No started deletion waiting for its provider clean-up.' USING ERRCODE = 'W3412';
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.record_tenant_deletion_cleanup(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.record_tenant_deletion_cleanup(uuid, jsonb) TO w360_app;
ALTER FUNCTION ops.record_tenant_deletion_cleanup(uuid, jsonb) OWNER TO w360_definer;

-- Deletes the next batch of the company's rows, following ops.tenant_deletion_steps, and returns
-- how many rows went and from which step (0 and null when nothing is left). One call per
-- transaction; a crash loses at most the batch in progress.
CREATE FUNCTION ops.delete_tenant_data(p_tenant_id uuid, p_limit integer)
  RETURNS TABLE (deleted integer, step integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 10000);
  v_step record;
  v_table regclass;
  v_found boolean;
  v_count integer := 0;
  v_sql text;
  v_parts text[];
  i integer;
BEGIN
  PERFORM 1 FROM ops.tenant_deletions d JOIN app.tenants t ON t.id = d.tenant_id
   WHERE d.tenant_id = p_tenant_id AND d.started_at IS NOT NULL AND d.cancelled_at IS NULL
     AND d.completed_at IS NULL AND d.due_at <= now() AND t.status = 'pending_deletion';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No started deletion for this company.' USING ERRCODE = 'W3412';
  END IF;
  PERFORM pg_catalog.set_config('w360.deleting_tenant', p_tenant_id::text, true);
  PERFORM pg_catalog.set_config('w360.allow_retention_purge', 'on', true);
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'on', true);
  FOR v_step IN SELECT s.ordinal, s.tables, s.mode FROM ops.tenant_deletion_steps s ORDER BY s.ordinal LOOP
    v_found := false;
    FOREACH v_table IN ARRAY v_step.tables LOOP
      EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s x WHERE x.tenant_id = $1)', v_table)
        INTO v_found USING p_tenant_id;
      EXIT WHEN v_found;
    END LOOP;
    CONTINUE WHEN NOT v_found;
    IF v_step.mode = 'batch' THEN
      EXECUTE pg_catalog.format(
        'DELETE FROM %1$s d WHERE d.tenant_id = $1 AND d.id IN '
        '(SELECT s.id FROM %1$s s WHERE s.tenant_id = $1 LIMIT $2)', v_step.tables[1])
        USING p_tenant_id, v_limit;
      GET DIAGNOSTICS v_count = ROW_COUNT;
    ELSE
      -- All rows of the step's tables in one statement: foreign keys are checked at its end.
      v_parts := ARRAY[]::text[];
      FOR i IN 1 .. cardinality(v_step.tables) LOOP
        v_parts := v_parts || pg_catalog.format(
          'd%s AS (DELETE FROM %s x WHERE x.tenant_id = $1 RETURNING 1)', i, v_step.tables[i]);
      END LOOP;
      v_sql := 'WITH ' || array_to_string(v_parts, ', ') || ' SELECT (0';
      FOR i IN 1 .. cardinality(v_step.tables) LOOP
        v_sql := v_sql || pg_catalog.format(' + (SELECT count(*) FROM d%s)', i);
      END LOOP;
      v_sql := v_sql || ')::integer';
      EXECUTE v_sql INTO v_count USING p_tenant_id;
    END IF;
    UPDATE ops.tenant_deletions d SET rows_deleted = d.rows_deleted + v_count
     WHERE d.tenant_id = p_tenant_id AND d.cancelled_at IS NULL AND d.completed_at IS NULL;
    PERFORM pg_catalog.set_config('w360.contact_erasure', 'off', true);
    PERFORM pg_catalog.set_config('w360.allow_retention_purge', 'off', true);
    PERFORM pg_catalog.set_config('w360.deleting_tenant', '', true);
    RETURN QUERY SELECT v_count, v_step.ordinal;
    RETURN;
  END LOOP;
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'off', true);
  PERFORM pg_catalog.set_config('w360.allow_retention_purge', 'off', true);
  PERFORM pg_catalog.set_config('w360.deleting_tenant', '', true);
  RETURN QUERY SELECT 0, NULL::integer;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.delete_tenant_data(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.delete_tenant_data(uuid, integer) TO w360_app;
ALTER FUNCTION ops.delete_tenant_data(uuid, integer) OWNER TO w360_definer;

-- Finishes a deletion when no deletable row is left: the company row becomes a tombstone (its
-- address free again) and the register is completed. Returns false while rows remain (a row
-- written during the run), so the caller deletes again.
CREATE FUNCTION ops.finish_tenant_deletion(p_tenant_id uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_deletion uuid;
  v_table regclass;
  v_found boolean;
BEGIN
  PERFORM 1 FROM app.tenants t WHERE t.id = p_tenant_id AND t.status = 'pending_deletion' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The company is not being deleted.' USING ERRCODE = 'W3412';
  END IF;
  SELECT d.id INTO v_deletion FROM ops.tenant_deletions d
   WHERE d.tenant_id = p_tenant_id AND d.started_at IS NOT NULL AND d.cancelled_at IS NULL
     AND d.completed_at IS NULL AND d.due_at <= now()
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No started deletion for this company.' USING ERRCODE = 'W3412';
  END IF;
  PERFORM pg_catalog.set_config('w360.deleting_tenant', p_tenant_id::text, true);
  FOR v_table IN SELECT unnest(s.tables) FROM ops.tenant_deletion_steps s ORDER BY s.ordinal LOOP
    EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %s x WHERE x.tenant_id = $1)', v_table)
      INTO v_found USING p_tenant_id;
    IF v_found THEN
      PERFORM pg_catalog.set_config('w360.deleting_tenant', '', true);
      RETURN false;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('w360.deleting_tenant', '', true);
  UPDATE app.tenants
     SET status = 'deleted', name = 'Deleted company',
         slug = 'deleted-' || pg_catalog.replace(p_tenant_id::text, '-', ''),
         status_reason = 'Deleted at the request of its owners.', status_changed_at = now(),
         updated_at = now()
   WHERE id = p_tenant_id;
  UPDATE ops.tenant_deletions SET completed_at = now() WHERE id = v_deletion;
  RETURN true;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.finish_tenant_deletion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.finish_tenant_deletion(uuid) TO w360_app;
ALTER FUNCTION ops.finish_tenant_deletion(uuid) OWNER TO w360_definer;

-- Fix: public entry points treated a company pending deletion as unknown, so a Shopify redaction
-- (or a payment) received during the grace period was dropped. They now treat it like a
-- suspended company.
SET ROLE w360_definer;
DROP FUNCTION ops.follow_chat_link(text);
DROP FUNCTION ops.chat_widget_config(text);
DROP FUNCTION ops.flow_endpoint_target(text);
DROP FUNCTION ops.commerce_payment_webhook_target(text);
DROP FUNCTION ops.commerce_store_by_shop(text);
DROP FUNCTION ops.commerce_store_by_webhook(text);
RESET ROLE;
CREATE FUNCTION ops.follow_chat_link(p_slug text)
  RETURNS TABLE (phone text, message text, ref_code text, include_ref boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v record;
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z2-7]{12}$' THEN
    RETURN;
  END IF;
  SELECT l.id, l.tenant_id, l.message, l.ref_code, l.include_ref, c.display_phone_number, t.timezone
    INTO v
    FROM app.chat_links l
    JOIN app.channel_accounts c ON c.tenant_id = l.tenant_id AND c.id = l.channel_account_id
    JOIN app.tenants t ON t.id = l.tenant_id
   WHERE l.slug = p_slug AND l.archived_at IS NULL AND c.status = 'active'
     AND t.status IN ('active', 'suspended', 'restricted', 'pending_deletion')
     AND pg_catalog.regexp_replace(c.display_phone_number, '[^0-9]', '', 'g') ~ '^[0-9]{6,15}$';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO app.chat_link_clicks AS k (id, tenant_id, link_id, day, clicks)
  VALUES (gen_random_uuid(), v.tenant_id, v.id, (now() AT TIME ZONE v.timezone)::date, 1)
  ON CONFLICT (tenant_id, link_id, day) DO UPDATE SET clicks = k.clicks + 1;
  RETURN QUERY SELECT pg_catalog.regexp_replace(v.display_phone_number, '[^0-9]', '', 'g'),
                      v.message, v.ref_code, v.include_ref;
END
$$;

CREATE FUNCTION ops.chat_widget_config(p_public_id text)
  RETURNS TABLE (label text, greeting text, side text, color text, slug text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.label, w.greeting, w.side, w.color, l.slug
    FROM app.chat_widgets w
    JOIN app.chat_links l ON l.tenant_id = w.tenant_id AND l.id = w.link_id
    JOIN app.channel_accounts c ON c.tenant_id = l.tenant_id AND c.id = l.channel_account_id
    JOIN app.tenants t ON t.id = w.tenant_id
   WHERE p_public_id ~ '^[a-z2-7]{16}$' AND w.public_id = p_public_id AND w.enabled
     AND l.archived_at IS NULL AND c.status = 'active'
     AND t.status IN ('active', 'suspended', 'restricted', 'pending_deletion')
     AND pg_catalog.regexp_replace(c.display_phone_number, '[^0-9]', '', 'g') ~ '^[0-9]{6,15}$'
$$;

CREATE FUNCTION ops.flow_endpoint_target(p_public_id text)
  RETURNS TABLE (tenant_id uuid, flow_id uuid, tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT f.tenant_id, f.id, t.status
    FROM app.flows f
    JOIN app.tenants t ON t.id = f.tenant_id
   WHERE p_public_id ~ '^[a-z2-7]{16}$' AND f.public_id = p_public_id
     AND t.status IN ('active', 'suspended', 'restricted', 'pending_deletion')
$$;

CREATE FUNCTION ops.commerce_payment_webhook_target(p_public_id text)
  RETURNS TABLE (tenant_id uuid, account_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT a.tenant_id, a.id
    FROM app.commerce_payment_accounts a
    JOIN app.tenants t ON t.id = a.tenant_id
   WHERE p_public_id ~ '^[a-z2-7]{16}$' AND a.webhook_public_id = p_public_id
     AND t.status IN ('active', 'suspended', 'restricted', 'pending_deletion')
$$;

CREATE FUNCTION ops.commerce_store_by_shop(p_shop_domain text)
  RETURNS TABLE (tenant_id uuid, store_id uuid, state text, shop_external_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, s.id, s.state, s.shop_external_id
    FROM app.commerce_stores s
    JOIN app.tenants t ON t.id = s.tenant_id
   WHERE p_shop_domain ~ '^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$'
     AND s.platform = 'shopify' AND s.shop_domain = p_shop_domain
     AND t.status IN ('active', 'suspended', 'restricted', 'pending_deletion')
$$;

CREATE FUNCTION ops.commerce_store_by_webhook(p_public_id text)
  RETURNS TABLE (tenant_id uuid, store_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, s.id
    FROM app.commerce_stores s
    JOIN app.tenants t ON t.id = s.tenant_id
   WHERE p_public_id ~ '^[a-z2-7]{16}$' AND s.platform = 'woocommerce'
     AND s.webhook_public_id = p_public_id
     AND t.status IN ('active', 'suspended', 'restricted', 'pending_deletion')
$$;

REVOKE EXECUTE ON FUNCTION ops.follow_chat_link(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ops.chat_widget_config(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ops.flow_endpoint_target(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ops.commerce_payment_webhook_target(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ops.commerce_store_by_shop(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ops.commerce_store_by_webhook(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.follow_chat_link(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.chat_widget_config(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.flow_endpoint_target(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.commerce_payment_webhook_target(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.commerce_store_by_shop(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.commerce_store_by_webhook(text) TO w360_app;
ALTER FUNCTION ops.follow_chat_link(text) OWNER TO w360_definer;
ALTER FUNCTION ops.chat_widget_config(text) OWNER TO w360_definer;
ALTER FUNCTION ops.flow_endpoint_target(text) OWNER TO w360_definer;
ALTER FUNCTION ops.commerce_payment_webhook_target(text) OWNER TO w360_definer;
ALTER FUNCTION ops.commerce_store_by_shop(text) OWNER TO w360_definer;
ALTER FUNCTION ops.commerce_store_by_webhook(text) OWNER TO w360_definer;

-- Fix: contact erasure left the number and the text in the requests of past sends.
GRANT UPDATE (request) ON app.send_intents TO w360_definer;
SET ROLE w360_definer;
DROP FUNCTION app.erase_contact(uuid, boolean);
RESET ROLE;
CREATE FUNCTION app.erase_contact(p_contact_id uuid, p_suppress boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_user text := app.current_user_id();
  v_contact record;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  -- Conversations first: every other writer (ingestion, replies, the automation runner) locks the
  -- conversation before its run and before the contact, so erasure takes the same order.
  PERFORM 1 FROM app.conversations cv
    WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id
    ORDER BY cv.id FOR UPDATE;
  SELECT c.id, c.phone_e164, c.email, c.erased_at INTO v_contact
    FROM app.contacts c WHERE c.tenant_id = v_tenant AND c.id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact not found' USING ERRCODE = 'W3404';
  END IF;
  IF v_contact.erased_at IS NOT NULL THEN
    RETURN false;
  END IF;
  IF p_suppress AND v_contact.phone_e164 IS NOT NULL THEN
    INSERT INTO app.suppressions (id, tenant_id, phone_e164, reason, created_by_user_id)
    VALUES (gen_random_uuid(), v_tenant, v_contact.phone_e164, 'erased', v_user)
    ON CONFLICT (tenant_id, phone_e164) DO NOTHING;
  END IF;
  INSERT INTO app.consent_events (id, tenant_id, contact_id, purpose, action, source, actor_type, actor_id, occurred_at)
  SELECT gen_random_uuid(), v_tenant, p_contact_id, p.purpose, 'opt_out', 'erasure',
         CASE WHEN v_user IS NULL THEN 'system' ELSE 'user' END, v_user, now()
    FROM (VALUES ('marketing'), ('utility')) AS p (purpose);

  -- Automation runs: captured answers are cleared and active runs stop (no further bot messages).
  UPDATE app.automation_runs r SET variables = '{}'::jsonb
   WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id;
  UPDATE app.automation_runs r
     SET status = 'stopped', end_reason = 'contact_erased', ended_at = now(), current_node_id = NULL,
         waiting_for = NULL, wait_until = NULL, input_message_id = NULL, next_step_at = NULL
   WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id AND r.status IN ('running', 'waiting');

  -- Automation HTTP calls: values saved from responses are cleared, calls not yet made are
  -- cancelled, and calls in flight become unknown (a call already sent cannot be recalled, and the
  -- result the worker records later is not kept).
  UPDATE app.automation_http_calls h SET saved_values = '{}'::jsonb, request_ciphertext = NULL
   WHERE h.tenant_id = v_tenant
     AND (h.saved_values <> '{}'::jsonb OR h.request_ciphertext IS NOT NULL)
     AND h.run_id IN (SELECT r.id FROM app.automation_runs r
                       WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id);
  UPDATE app.automation_http_calls h
     SET state = 'canceled', error_code = 'contact_erased', finished_at = now()
   WHERE h.tenant_id = v_tenant AND h.state = 'queued'
     AND h.run_id IN (SELECT r.id FROM app.automation_runs r
                       WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id);
  UPDATE app.automation_http_calls h
     SET state = 'unknown', error_code = 'contact_erased', finished_at = now(), lease_until = NULL
   WHERE h.tenant_id = v_tenant AND h.state = 'in_flight'
     AND h.run_id IN (SELECT r.id FROM app.automation_runs r
                       WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id);

  -- Growth: where the contact's conversations came from (ads, links) is about them, so it goes.
  DELETE FROM app.conversation_sources s WHERE s.tenant_id = v_tenant AND s.contact_id = p_contact_id;

  -- Flows: answers the contact gave are deleted, and forms already sent to them stop working (the
  -- data endpoint refuses their tokens).
  DELETE FROM app.flow_responses r WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id;
  UPDATE app.flow_sends f SET expires_at = least(f.expires_at, now())
   WHERE f.tenant_id = v_tenant AND f.contact_id = p_contact_id AND f.expires_at > now();

  -- Commerce: orders stay as business records without the customer's note, and payment links of
  -- their orders that are still open are cancelled at Razorpay by the worker (it sees the request).
  UPDATE app.commerce_orders o SET customer_note = NULL
   WHERE o.tenant_id = v_tenant AND o.contact_id = p_contact_id AND o.customer_note IS NOT NULL;
  UPDATE app.commerce_payment_links l SET cancel_requested_at = now(), next_check_at = now()
   WHERE l.tenant_id = v_tenant AND l.cancel_requested_at IS NULL
     AND l.status IN ('creating', 'created', 'partially_paid')
     AND l.order_id IN (SELECT o.id FROM app.commerce_orders o
                         WHERE o.tenant_id = v_tenant AND o.contact_id = p_contact_id);

  -- Store orders: the copies of the contact's orders from the company's stores (matched by phone or
  -- email) lose the customer's details and their tracking for good; later reads from the store keep
  -- them empty, and messages about them that are still waiting are not sent.
  IF v_contact.phone_e164 IS NOT NULL OR v_contact.email IS NOT NULL THEN
    UPDATE app.commerce_store_orders o
       SET customer_name = NULL, customer_phone = NULL, customer_email = NULL, status_url = NULL,
           tracking_number = NULL, tracking_url = NULL, redacted_at = now()
     WHERE o.tenant_id = v_tenant
       AND ((v_contact.phone_e164 IS NOT NULL AND o.customer_phone = v_contact.phone_e164)
         OR (v_contact.email IS NOT NULL AND lower(o.customer_email) = lower(v_contact.email)));
  END IF;

  -- Store checkouts: the copies of checkouts left with the contact's number lose the customer's
  -- details, the recovery address and the consent Shopify recorded, for good; reminders about them
  -- that are still waiting are not sent.
  IF v_contact.phone_e164 IS NOT NULL THEN
    UPDATE app.commerce_store_checkouts k
       SET customer_external_id = NULL, customer_name = NULL, customer_phone = NULL,
           recovery_url = NULL, consent_state = NULL, consent_updated_at = NULL,
           consent_opt_in_level = NULL, consent_collected_from = NULL, redacted_at = now()
     WHERE k.tenant_id = v_tenant AND k.customer_phone = v_contact.phone_e164;
  END IF;

  -- CRM: the timeline (with notes) and tasks go; deals keep what reports need, without free text.
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'on', true);
  DELETE FROM app.crm_activities a WHERE a.tenant_id = v_tenant AND a.contact_id = p_contact_id;
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'off', true);
  DELETE FROM app.crm_tasks t WHERE t.tenant_id = v_tenant AND t.contact_id = p_contact_id;
  UPDATE app.crm_deals d SET title = 'Deal (contact erased)', lost_reason = NULL
   WHERE d.tenant_id = v_tenant AND d.contact_id = p_contact_id;

  UPDATE app.send_intents s
     SET state = 'canceled', lease_until = NULL, resolved_at = now(), last_error_code = 'contact_erased',
         last_error = 'Not sent: the contact was erased.'
   WHERE s.tenant_id = v_tenant AND s.state IN ('queued', 'deferred')
     AND s.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                            ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                           WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  -- The requests of past and cancelled sends carried the number and the text: redacted too.
  UPDATE app.send_intents s SET request = '{"redacted": true}'::jsonb
   WHERE s.tenant_id = v_tenant
     AND s.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                            ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                           WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  UPDATE app.messages m
     SET content = '{"redacted": true}'::jsonb,
         referral = NULL,
         status = CASE WHEN m.status IN ('queued', 'sending') THEN 'canceled' ELSE m.status END,
         status_rank = CASE WHEN m.status IN ('queued', 'sending') THEN 5 ELSE m.status_rank END,
         status_at = CASE WHEN m.status IN ('queued', 'sending') THEN now() ELSE m.status_at END,
         error_title = NULL
   WHERE m.tenant_id = v_tenant
     AND m.conversation_id IN (SELECT cv.id FROM app.conversations cv
                                WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'on', true);
  UPDATE app.message_status_events e
     SET recipient_wa_id = NULL, recipient_bsuid = NULL
   WHERE e.tenant_id = v_tenant AND (e.recipient_wa_id IS NOT NULL OR e.recipient_bsuid IS NOT NULL)
     AND e.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                            ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                           WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'off', true);
  DELETE FROM app.media_objects mo
   WHERE mo.tenant_id = v_tenant
     AND mo.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                             ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                            WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  DELETE FROM app.conversation_notes n
   WHERE n.tenant_id = v_tenant
     AND n.conversation_id IN (SELECT cv.id FROM app.conversations cv
                                WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  UPDATE app.conversations cv SET last_message_preview = NULL
   WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id;
  DELETE FROM app.contact_identities i WHERE i.tenant_id = v_tenant AND i.contact_id = p_contact_id;
  DELETE FROM app.contact_tags t WHERE t.tenant_id = v_tenant AND t.contact_id = p_contact_id;
  UPDATE app.contacts c
     SET display_name = NULL, phone_e164 = NULL, email = NULL, attributes = '{}'::jsonb, erased_at = now()
   WHERE c.tenant_id = v_tenant AND c.id = p_contact_id;
  RETURN true;
END
$$;

REVOKE EXECUTE ON FUNCTION app.erase_contact(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.erase_contact(uuid, boolean) TO w360_app;
ALTER FUNCTION app.erase_contact(uuid, boolean) OWNER TO w360_definer;

-- Fix: an ended run's pending message and HTTP call count were no longer frozen (lost in 0022).
CREATE OR REPLACE FUNCTION app.guard_automation_run() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'automation runs cannot be deleted' USING ERRCODE = 'W3403';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.automation_id, NEW.version_id, NEW.conversation_id, NEW.contact_id,
      NEW.channel_account_id, NEW.mode, NEW.trigger_type, NEW.trigger_message_id,
      NEW.started_by_membership_id, NEW.started_by_user_id, NEW.started_at, NEW.store_event)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.automation_id, OLD.version_id, OLD.conversation_id, OLD.contact_id,
      OLD.channel_account_id, OLD.mode, OLD.trigger_type, OLD.trigger_message_id,
      OLD.started_by_membership_id, OLD.started_by_user_id, OLD.started_at, OLD.store_event)
     OR (NEW.store_order_id IS DISTINCT FROM OLD.store_order_id AND NEW.store_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'what started an automation run is fixed' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.status NOT IN ('running', 'waiting') THEN
    IF (NEW.status, NEW.current_node_id, NEW.node_visit, NEW.waiting_for, NEW.wait_until,
        NEW.input_message_id, NEW.pending_message_id, NEW.retries, NEW.failures, NEW.step_count,
        NEW.message_count, NEW.http_call_count, NEW.visits, NEW.next_step_at, NEW.ended_at,
        NEW.end_reason, NEW.end_detail, NEW.ended_by_membership_id)
       IS DISTINCT FROM
       (OLD.status, OLD.current_node_id, OLD.node_visit, OLD.waiting_for, OLD.wait_until,
        OLD.input_message_id, OLD.pending_message_id, OLD.retries, OLD.failures, OLD.step_count,
        OLD.message_count, OLD.http_call_count, OLD.visits, OLD.next_step_at, OLD.ended_at,
        OLD.end_reason, OLD.end_detail, OLD.ended_by_membership_id)
       OR (NEW.variables IS DISTINCT FROM OLD.variables AND NEW.variables <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'an ended automation run cannot change' USING ERRCODE = 'W3403';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
