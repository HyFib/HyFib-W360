-- Company deletion started by HyFib staff (P5-11, ADR-090). A platform owner schedules it on the
-- company's platform page, typing the company address and a reason the company reads; the same 14
-- days of grace and the same resumable job follow (ADR-055). Whoever scheduled a deletion cancels
-- it: owners their own, platform owners HyFib's. The company's owners and administrators hear of a
-- staff deletion from the worker's minute sweep, as billing managers hear of a declined refund
-- request (ADR-073): the platform role cannot queue email.

-- Who scheduled the deletion and why; who cancelled it and why; when the company was told.
ALTER TABLE ops.tenant_deletions
  ADD COLUMN requested_by text NOT NULL DEFAULT 'owner' CHECK (requested_by IN ('owner', 'platform')),
  -- HyFib's reason, which the company reads (staff deletions only).
  ADD COLUMN reason text CHECK (char_length(reason) BETWEEN 10 AND 1000),
  -- Empty on deletions cancelled before this migration: only owners could cancel them.
  ADD COLUMN cancelled_by text CHECK (cancelled_by IN ('owner', 'platform')),
  ADD COLUMN cancel_reason text CHECK (char_length(cancel_reason) BETWEEN 10 AND 1000),
  -- When the owners and administrators were emailed that HyFib scheduled or cancelled it.
  ADD COLUMN scheduled_notified_at timestamptz,
  ADD COLUMN cancelled_notified_at timestamptz,
  ADD CONSTRAINT tenant_deletions_reason_chk CHECK ((requested_by = 'platform') = (reason IS NOT NULL)),
  ADD CONSTRAINT tenant_deletions_cancelled_by_chk
    CHECK (cancelled_by IS NULL OR (cancelled_at IS NOT NULL AND cancelled_by = requested_by)),
  ADD CONSTRAINT tenant_deletions_cancel_reason_chk
    CHECK (coalesce(cancelled_by = 'platform', false) = (cancel_reason IS NOT NULL)),
  ADD CONSTRAINT tenant_deletions_scheduled_notified_chk
    CHECK (scheduled_notified_at IS NULL OR requested_by = 'platform'),
  ADD CONSTRAINT tenant_deletions_cancelled_notified_chk
    CHECK (cancelled_notified_at IS NULL OR cancelled_by = 'platform');
-- The company reads who scheduled and cancelled its deletion, and HyFib's reasons; never staff names.
GRANT SELECT (requested_by, reason, cancelled_by, cancel_reason) ON ops.tenant_deletions TO w360_app;

-- The status a company returns to when its deletion is cancelled: the status recorded when it was
-- scheduled, with the plan applied again (a lapsed plan restricts, a current one lifts a
-- restriction; a suspension stays). Runs only inside the definer functions below.
CREATE FUNCTION ops.tenant_status_after_deletion(p_tenant_id uuid, p_previous_status text,
    p_previous_reason text)
  RETURNS TABLE (status text, status_reason text)
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_plan text;
BEGIN
  IF p_previous_status = 'suspended' THEN
    RETURN QUERY SELECT 'suspended'::text, p_previous_reason;
    RETURN;
  END IF;
  SELECT p.status INTO v_plan FROM app.tenant_plans p WHERE p.tenant_id = p_tenant_id;
  IF v_plan IN ('expired', 'canceled') THEN
    RETURN QUERY SELECT 'restricted'::text,
      CASE v_plan WHEN 'canceled' THEN 'The plan was canceled.' ELSE 'The plan ended.' END;
  ELSE
    RETURN QUERY SELECT 'active'::text, NULL::text;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.tenant_status_after_deletion(uuid, text, text) FROM PUBLIC;
ALTER FUNCTION ops.tenant_status_after_deletion(uuid, text, text) OWNER TO w360_definer;

-- A platform owner schedules the deletion: the company address typed to confirm, a reason of 10 to
-- 1,000 characters the company reads. Written to both audit logs; due 14 days later.
CREATE FUNCTION ops.platform_request_tenant_deletion(p_tenant_id uuid, p_confirm_slug text,
    p_reason text, p_correlation_id text)
  RETURNS TABLE (deletion_id uuid, due_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_reason text := pg_catalog.btrim(p_reason);
  v_company record;
  v_id uuid := gen_random_uuid();
  v_due timestamptz := now() + interval '14 days';
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can schedule a company''s deletion.' USING ERRCODE = 'W3403';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 10 OR char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'Give a reason of 10 to 1,000 characters; the company reads it.'
      USING ERRCODE = 'W3412';
  END IF;
  SELECT t.slug, t.name, t.status, t.status_reason INTO v_company
    FROM app.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Company not found.' USING ERRCODE = 'W3404';
  END IF;
  IF v_company.status NOT IN ('active', 'suspended', 'restricted') THEN
    RAISE EXCEPTION 'The company is already being deleted.' USING ERRCODE = 'W3412';
  END IF;
  IF p_confirm_slug IS NULL OR pg_catalog.btrim(p_confirm_slug) <> v_company.slug THEN
    RAISE EXCEPTION 'Type the company address exactly to confirm.' USING ERRCODE = 'W3412';
  END IF;
  INSERT INTO ops.tenant_deletions (id, tenant_id, requested_by_user_id, due_at, previous_status,
                                    previous_status_reason, company_name, requested_by, reason)
  VALUES (v_id, p_tenant_id, v_actor, v_due, v_company.status, v_company.status_reason,
          v_company.name, 'platform', v_reason);
  UPDATE app.tenants
     SET status = 'pending_deletion', status_reason = 'HyFib scheduled the company for deletion.',
         status_changed_at = now(), updated_at = now()
   WHERE id = p_tenant_id;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, target_tenant_id, reason, result,
    correlation_id, metadata)
  VALUES (v_actor, 'platform.tenant_deletion_scheduled', p_tenant_id, v_reason, 'success',
    p_correlation_id, jsonb_build_object('deletionId', v_id, 'dueAt', v_due));
  INSERT INTO app.audit_events (tenant_id, actor_type, actor_id, action, subject_type, subject_id,
    result, correlation_id, metadata)
  VALUES (p_tenant_id, 'platform_admin', v_actor, 'platform.tenant_deletion_scheduled', 'tenant',
    p_tenant_id::text, 'success', p_correlation_id,
    jsonb_build_object('deletionId', v_id, 'dueAt', v_due, 'reason', v_reason));
  RETURN QUERY SELECT v_id, v_due;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_request_tenant_deletion(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_request_tenant_deletion(uuid, text, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_request_tenant_deletion(uuid, text, text, text) OWNER TO w360_definer;

-- A platform owner cancels a deletion HyFib scheduled, before it starts, with a reason the company
-- reads. A deletion an owner asked for is the company's decision: only its owners cancel it.
CREATE FUNCTION ops.platform_cancel_tenant_deletion(p_tenant_id uuid, p_reason text,
    p_correlation_id text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_reason text := pg_catalog.btrim(p_reason);
  v_deletion record;
  v_restored record;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can cancel a company''s deletion.' USING ERRCODE = 'W3403';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 10 OR char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'Give a reason of 10 to 1,000 characters; the company reads it.'
      USING ERRCODE = 'W3412';
  END IF;
  PERFORM 1 FROM app.tenants t
   WHERE t.id = p_tenant_id AND t.status = 'pending_deletion' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The company is not being deleted.' USING ERRCODE = 'W3412';
  END IF;
  SELECT d.id, d.previous_status, d.previous_status_reason, d.started_at, d.requested_by
    INTO v_deletion
    FROM ops.tenant_deletions d
   WHERE d.tenant_id = p_tenant_id AND d.cancelled_at IS NULL AND d.completed_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The company is not being deleted.' USING ERRCODE = 'W3412';
  END IF;
  IF v_deletion.requested_by <> 'platform' THEN
    RAISE EXCEPTION 'An owner asked for this deletion: only the company''s owners can cancel it.'
      USING ERRCODE = 'W3412';
  END IF;
  IF v_deletion.started_at IS NOT NULL THEN
    RAISE EXCEPTION 'The deletion has started and can no longer be cancelled.' USING ERRCODE = 'W3412';
  END IF;
  SELECT r.status, r.status_reason INTO v_restored
    FROM ops.tenant_status_after_deletion(p_tenant_id, v_deletion.previous_status,
                                          v_deletion.previous_status_reason) r;
  UPDATE ops.tenant_deletions
     SET cancelled_at = now(), cancelled_by_user_id = v_actor, cancelled_by = 'platform',
         cancel_reason = v_reason
   WHERE id = v_deletion.id;
  UPDATE app.tenants
     SET status = v_restored.status, status_reason = v_restored.status_reason,
         status_changed_at = now(), updated_at = now()
   WHERE id = p_tenant_id;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, target_tenant_id, reason, result,
    correlation_id, metadata)
  VALUES (v_actor, 'platform.tenant_deletion_cancelled', p_tenant_id, v_reason, 'success',
    p_correlation_id, jsonb_build_object('deletionId', v_deletion.id,
                                         'restoredStatus', v_restored.status));
  INSERT INTO app.audit_events (tenant_id, actor_type, actor_id, action, subject_type, subject_id,
    result, correlation_id, metadata)
  VALUES (p_tenant_id, 'platform_admin', v_actor, 'platform.tenant_deletion_cancelled', 'tenant',
    p_tenant_id::text, 'success', p_correlation_id,
    jsonb_build_object('deletionId', v_deletion.id, 'restoredStatus', v_restored.status,
                       'reason', v_reason));
  RETURN v_restored.status;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_cancel_tenant_deletion(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_cancel_tenant_deletion(uuid, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_cancel_tenant_deletion(uuid, text, text) OWNER TO w360_definer;

-- An owner cancels: as in 0028, now refusing a deletion HyFib scheduled and recording who cancelled.
-- The function is owned by w360_definer, which the migration role cannot replace in place (see the
-- note on replacing definer functions in 0011): the owner drops it and the migration role
-- recreates it, granting before handing it back.
SET ROLE w360_definer;
DROP FUNCTION app.cancel_tenant_deletion();
RESET ROLE;
CREATE FUNCTION app.cancel_tenant_deletion() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_user text := app.current_user_id();
  v_deletion record;
  v_restored record;
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
  SELECT d.id, d.previous_status, d.previous_status_reason, d.started_at, d.requested_by
    INTO v_deletion
    FROM ops.tenant_deletions d
   WHERE d.tenant_id = v_tenant AND d.cancelled_at IS NULL AND d.completed_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The company is not being deleted.' USING ERRCODE = 'W3412';
  END IF;
  IF v_deletion.requested_by <> 'owner' THEN
    RAISE EXCEPTION 'HyFib scheduled this deletion: only HyFib can cancel it.' USING ERRCODE = 'W3412';
  END IF;
  IF v_deletion.started_at IS NOT NULL THEN
    RAISE EXCEPTION 'The deletion has started and can no longer be cancelled.' USING ERRCODE = 'W3412';
  END IF;
  SELECT r.status, r.status_reason INTO v_restored
    FROM ops.tenant_status_after_deletion(v_tenant, v_deletion.previous_status,
                                          v_deletion.previous_status_reason) r;
  UPDATE ops.tenant_deletions
     SET cancelled_at = now(), cancelled_by_user_id = v_user, cancelled_by = 'owner'
   WHERE id = v_deletion.id;
  UPDATE app.tenants
     SET status = v_restored.status, status_reason = v_restored.status_reason,
         status_changed_at = now(), updated_at = now()
   WHERE id = v_tenant;
  RETURN v_restored.status;
END
$$;
REVOKE EXECUTE ON FUNCTION app.cancel_tenant_deletion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cancel_tenant_deletion() TO w360_app;
ALTER FUNCTION app.cancel_tenant_deletion() OWNER TO w360_definer;

-- Staff deletions and cancellations the company was not told of yet (for the minute sweep), oldest
-- first: a schedule before its cancellation. Not for deleted companies.
CREATE FUNCTION ops.tenant_deletion_notices_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, deletion_id uuid, notice text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT d.tenant_id, d.id, n.notice
    FROM ops.tenant_deletions d
    JOIN app.tenants t ON t.id = d.tenant_id
    CROSS JOIN LATERAL (VALUES
      ('scheduled', d.requested_at, d.requested_by = 'platform' AND d.scheduled_notified_at IS NULL),
      ('cancelled', d.cancelled_at, d.cancelled_by = 'platform' AND d.cancelled_notified_at IS NULL)
    ) AS n (notice, at, due)
   WHERE n.due AND t.status <> 'deleted'
   ORDER BY n.at, d.id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
REVOKE EXECUTE ON FUNCTION ops.tenant_deletion_notices_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.tenant_deletion_notices_due(integer) TO w360_app;
ALTER FUNCTION ops.tenant_deletion_notices_due(integer) OWNER TO w360_definer;

-- Marks a notice as sent, in the company's scope and in the transaction that queues its emails;
-- true only for the first call, so each is sent once.
CREATE FUNCTION app.tenant_deletion_mark_notified(p_deletion_id uuid, p_notice text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  IF p_notice = 'scheduled' THEN
    UPDATE ops.tenant_deletions d SET scheduled_notified_at = now()
     WHERE d.tenant_id = v_tenant AND d.id = p_deletion_id AND d.requested_by = 'platform'
       AND d.scheduled_notified_at IS NULL;
  ELSIF p_notice = 'cancelled' THEN
    UPDATE ops.tenant_deletions d SET cancelled_notified_at = now()
     WHERE d.tenant_id = v_tenant AND d.id = p_deletion_id AND d.cancelled_by = 'platform'
       AND d.cancelled_notified_at IS NULL;
  ELSE
    RAISE EXCEPTION 'Unknown deletion notice.' USING ERRCODE = 'W3412';
  END IF;
  RETURN FOUND;
END
$$;
REVOKE EXECUTE ON FUNCTION app.tenant_deletion_mark_notified(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_deletion_mark_notified(uuid, text) TO w360_app;
ALTER FUNCTION app.tenant_deletion_mark_notified(uuid, text) OWNER TO w360_definer;
