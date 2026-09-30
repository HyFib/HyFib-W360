-- Refunds of unused service credit asked for by companies (P5-05, ADR-073).
--
-- A company's billing managers ask for a refund of part or all of a paid top-up's unused credit,
-- with a reason, and can withdraw the request while it is open. A platform owner decides: approving
-- starts the staff refund of ADR-058 through ops.platform_request_credit_refund, which checks
-- everything again under its locks (the top-up, the amount left of it, the unused credit, a refund
-- already in progress, a company being deleted), and declining needs a note the company reads.
-- Money still leaves only when a platform owner decides. Platform owners hear of new requests, and
-- billing managers of a decline, from the minute billing sweep, marked in the transaction that queues
-- the email.

CREATE TABLE app.credit_refund_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  topup_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'declined', 'withdrawn')),
  requested_by_user_id text NOT NULL REFERENCES auth.users (id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  -- The platform owner who decided: platform-only (the company role has no grant on it).
  decided_by_user_id text REFERENCES auth.users (id),
  decided_at timestamptz,
  -- Required to decline; the company reads it.
  decision_note text CHECK (char_length(btrim(decision_note)) BETWEEN 10 AND 1000),
  credit_refund_id uuid,
  -- When platform owners were emailed about the request, and billing managers about a decline.
  announced_at timestamptz,
  decline_notified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_refund_requests_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT credit_refund_requests_topup_fk FOREIGN KEY (tenant_id, topup_id)
    REFERENCES app.topups (tenant_id, id),
  CONSTRAINT credit_refund_requests_refund_fk FOREIGN KEY (tenant_id, credit_refund_id)
    REFERENCES app.credit_refunds (tenant_id, id),
  CONSTRAINT credit_refund_requests_state_check CHECK (
    (status = 'open' AND withdrawn_at IS NULL AND decided_at IS NULL AND decided_by_user_id IS NULL
      AND decision_note IS NULL AND credit_refund_id IS NULL)
    OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL AND decided_at IS NULL
      AND decided_by_user_id IS NULL AND decision_note IS NULL AND credit_refund_id IS NULL)
    OR (status = 'approved' AND withdrawn_at IS NULL AND decided_at IS NOT NULL
      AND decided_by_user_id IS NOT NULL AND credit_refund_id IS NOT NULL)
    OR (status = 'declined' AND withdrawn_at IS NULL AND decided_at IS NOT NULL
      AND decided_by_user_id IS NOT NULL AND decision_note IS NOT NULL AND credit_refund_id IS NULL)),
  CONSTRAINT credit_refund_requests_decline_notice_check CHECK (
    decline_notified_at IS NULL OR status = 'declined')
);
-- One open request per top-up; a staff refund answers one request.
CREATE UNIQUE INDEX credit_refund_requests_one_open_uq ON app.credit_refund_requests (tenant_id, topup_id)
  WHERE status = 'open';
CREATE UNIQUE INDEX credit_refund_requests_refund_uq ON app.credit_refund_requests (tenant_id, credit_refund_id)
  WHERE credit_refund_id IS NOT NULL;
CREATE INDEX credit_refund_requests_tenant_idx ON app.credit_refund_requests
  (tenant_id, requested_at DESC, id DESC);
CREATE INDEX credit_refund_requests_platform_idx ON app.credit_refund_requests (requested_at DESC, id DESC);
CREATE INDEX credit_refund_requests_unannounced_idx ON app.credit_refund_requests (requested_at)
  WHERE status = 'open' AND announced_at IS NULL;
CREATE INDEX credit_refund_requests_decline_due_idx ON app.credit_refund_requests (decided_at)
  WHERE status = 'declined' AND decline_notified_at IS NULL;
CREATE TRIGGER credit_refund_requests_touch BEFORE UPDATE ON app.credit_refund_requests
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
SELECT ops.apply_tenant_rls('app.credit_refund_requests');

-- The company asks (an open request: status, the decision and the notice marks are not its columns),
-- withdraws an open request, and reads everything but who decided.
GRANT SELECT (id, tenant_id, topup_id, amount_minor, reason, status, requested_by_user_id, requested_at,
  withdrawn_at, decided_at, decision_note, credit_refund_id, updated_at)
  ON app.credit_refund_requests TO w360_app;
GRANT INSERT (id, tenant_id, topup_id, amount_minor, reason, requested_by_user_id)
  ON app.credit_refund_requests TO w360_app;
GRANT UPDATE (status, withdrawn_at, updated_at) ON app.credit_refund_requests TO w360_app;
CREATE POLICY app_withdraw_open ON app.credit_refund_requests AS RESTRICTIVE FOR UPDATE TO w360_app
  USING (status = 'open')
  WITH CHECK (status IN ('open', 'withdrawn'));

-- What the definer functions below read and write: decisions and the two notice marks.
GRANT SELECT ON app.credit_refund_requests TO w360_definer;
GRANT UPDATE (status, decided_by_user_id, decided_at, decision_note, credit_refund_id, announced_at,
  decline_notified_at, updated_at) ON app.credit_refund_requests TO w360_definer;
CREATE POLICY definer_read ON app.credit_refund_requests FOR SELECT TO w360_definer USING (true);
CREATE POLICY definer_update ON app.credit_refund_requests FOR UPDATE TO w360_definer
  USING (true) WITH CHECK (true);

-- Deleted with the company (ADR-055): the company's own text. The refunds they led to are kept
-- (app.credit_refunds is a billing record), and nothing kept points at a request.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (76, ARRAY['app.credit_refund_requests']::regclass[], 'batch');
GRANT DELETE ON app.credit_refund_requests TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.credit_refund_requests FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.credit_refund_requests FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- Who is emailed about requests: platform owners, who decide them (operators only read).
CREATE FUNCTION ops.platform_owner_recipients()
  RETURNS TABLE (user_id text, email text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT u.id, u.email
    FROM ops.platform_admins a
    JOIN auth.users u ON u.id = a.user_id
   WHERE a.role = 'platform_owner'
   ORDER BY u.id
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_owner_recipients() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_owner_recipients() TO w360_app;
ALTER FUNCTION ops.platform_owner_recipients() OWNER TO w360_definer;

-- Open requests platform owners have not been told about (ids only, for the minute sweep).
CREATE FUNCTION ops.credit_refund_requests_to_announce(p_limit integer)
  RETURNS TABLE (request_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT r.id
    FROM app.credit_refund_requests r
   WHERE r.status = 'open' AND r.announced_at IS NULL
   ORDER BY r.requested_at
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
REVOKE EXECUTE ON FUNCTION ops.credit_refund_requests_to_announce(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.credit_refund_requests_to_announce(integer) TO w360_app;
ALTER FUNCTION ops.credit_refund_requests_to_announce(integer) OWNER TO w360_definer;

-- Marks them as told, in the transaction that queues the emails: each request is checked again (still
-- open, not told), and after a wait on another sweep's lock the check sees that sweep's mark, so a
-- request is announced once. Returns the requests marked here.
CREATE FUNCTION ops.credit_refund_requests_mark_announced(p_request_ids uuid[])
  RETURNS TABLE (request_id uuid)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  UPDATE app.credit_refund_requests r
     SET announced_at = now()
   WHERE r.id = ANY (p_request_ids) AND r.status = 'open' AND r.announced_at IS NULL
  RETURNING r.id
$$;
REVOKE EXECUTE ON FUNCTION ops.credit_refund_requests_mark_announced(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.credit_refund_requests_mark_announced(uuid[]) TO w360_app;
ALTER FUNCTION ops.credit_refund_requests_mark_announced(uuid[]) OWNER TO w360_definer;

-- Declined requests whose billing managers have not been told (ids only, for the minute sweep, which
-- tells each company in its own scope). A deleted company is left out.
CREATE FUNCTION ops.credit_refund_request_declines_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, request_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT r.tenant_id, r.id
    FROM app.credit_refund_requests r
    JOIN app.tenants t ON t.id = r.tenant_id
   WHERE r.status = 'declined' AND r.decline_notified_at IS NULL AND t.status <> 'deleted'
   ORDER BY r.decided_at
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
REVOKE EXECUTE ON FUNCTION ops.credit_refund_request_declines_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.credit_refund_request_declines_due(integer) TO w360_app;
ALTER FUNCTION ops.credit_refund_request_declines_due(integer) OWNER TO w360_definer;

-- Marks a decline as told, in the company's scope and in the transaction that queues the email;
-- true only for the first call, so a decline is told once.
CREATE FUNCTION app.credit_refund_request_mark_decline_notified(p_request_id uuid)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  WITH marked AS (
    UPDATE app.credit_refund_requests r
       SET decline_notified_at = now()
     WHERE r.tenant_id = app.current_tenant_id()::uuid AND r.id = p_request_id
       AND r.status = 'declined' AND r.decline_notified_at IS NULL
    RETURNING r.id)
  SELECT EXISTS (SELECT 1 FROM marked)
$$;
REVOKE EXECUTE ON FUNCTION app.credit_refund_request_mark_decline_notified(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.credit_refund_request_mark_decline_notified(uuid) TO w360_app;
ALTER FUNCTION app.credit_refund_request_mark_decline_notified(uuid) OWNER TO w360_definer;

-- Requests for platform staff, newest first (keyset pages on the exact request time and id):
-- `open`, `decided` (approved or declined) or every request. With each: the company, the top-up,
-- what is left of it, the company's unused credit and whether a refund of it is already running.
CREATE FUNCTION ops.platform_credit_refund_requests(p_status text, p_before_at timestamptz,
    p_before_id uuid, p_limit integer)
  RETURNS TABLE (id uuid, tenant_id uuid, company_name text, company_slug text, company_status text,
    topup_id uuid, topup_receipt text, topup_amount_minor bigint, topup_refunded_minor bigint,
    topup_paid_at timestamptz, available_minor bigint, refund_in_progress boolean, amount_minor bigint,
    reason text, status text, requested_by_name text, requested_at timestamptz, cursor_at text,
    decided_at timestamptz, decided_by_name text, decision_note text, credit_refund_id uuid,
    credit_refund_status text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'decided') THEN
    RAISE EXCEPTION 'Unknown request status filter.' USING ERRCODE = 'W3412';
  END IF;
  RETURN QUERY
  SELECT r.id, r.tenant_id, tn.name, tn.slug, tn.status, r.topup_id, tu.receipt, tu.amount_minor,
         tu.refunded_minor, tu.paid_at,
         (SELECT a.balance_minor FROM app.ledger_accounts a
           WHERE a.tenant_id = r.tenant_id AND a.wallet_id = tu.wallet_id AND a.code = 'wallet_available'),
         EXISTS (SELECT 1 FROM app.credit_refunds o
                  WHERE o.tenant_id = r.tenant_id AND o.topup_id = r.topup_id
                    AND o.status IN ('requested', 'submitted')),
         r.amount_minor, r.reason, r.status, ru.name, r.requested_at,
         to_char(r.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         r.decided_at, du.name, r.decision_note, r.credit_refund_id, cr.status
    FROM app.credit_refund_requests r
    JOIN app.tenants tn ON tn.id = r.tenant_id
    JOIN app.topups tu ON tu.tenant_id = r.tenant_id AND tu.id = r.topup_id
    LEFT JOIN auth.users ru ON ru.id = r.requested_by_user_id
    LEFT JOIN auth.users du ON du.id = r.decided_by_user_id
    LEFT JOIN app.credit_refunds cr ON cr.tenant_id = r.tenant_id AND cr.id = r.credit_refund_id
   WHERE (p_status IS NULL
          OR (p_status = 'open' AND r.status = 'open')
          OR (p_status = 'decided' AND r.status IN ('approved', 'declined')))
     AND (p_before_at IS NULL OR (r.requested_at, r.id) < (p_before_at, p_before_id))
   ORDER BY r.requested_at DESC, r.id DESC
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_credit_refund_requests(text, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_credit_refund_requests(text, timestamptz, uuid, integer) TO w360_platform;
ALTER FUNCTION ops.platform_credit_refund_requests(text, timestamptz, uuid, integer) OWNER TO w360_definer;

-- Every refund of service credit across companies for platform staff, newest first (keyset pages on
-- the exact request time and id), with the company request it answers, if any.
CREATE FUNCTION ops.platform_credit_refunds(p_before_at timestamptz, p_before_id uuid, p_limit integer)
  RETURNS TABLE (id uuid, tenant_id uuid, company_name text, company_slug text, topup_id uuid,
    topup_receipt text, amount_minor bigint, status text, reason text, requested_by_name text,
    requested_at timestamptz, cursor_at text, submitted_at timestamptz, processed_at timestamptz,
    failed_at timestamptz, last_error text, request_id uuid)
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
  SELECT cr.id, cr.tenant_id, tn.name, tn.slug, cr.topup_id, tu.receipt, cr.amount_minor, cr.status,
         cr.reason, u.name, cr.requested_at,
         to_char(cr.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         cr.submitted_at, cr.processed_at, cr.failed_at, cr.last_error, q.id
    FROM app.credit_refunds cr
    JOIN app.tenants tn ON tn.id = cr.tenant_id
    JOIN app.topups tu ON tu.tenant_id = cr.tenant_id AND tu.id = cr.topup_id
    LEFT JOIN auth.users u ON u.id = cr.requested_by_user_id
    LEFT JOIN app.credit_refund_requests q ON q.tenant_id = cr.tenant_id AND q.credit_refund_id = cr.id
   WHERE p_before_at IS NULL OR (cr.requested_at, cr.id) < (p_before_at, p_before_id)
   ORDER BY cr.requested_at DESC, cr.id DESC
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_credit_refunds(timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_credit_refunds(timestamptz, uuid, integer) TO w360_platform;
ALTER FUNCTION ops.platform_credit_refunds(timestamptz, uuid, integer) OWNER TO w360_definer;

-- A platform owner decides an open request. Approving starts the staff refund of ADR-058 for the
-- request's amount (every check again, under its locks) and links it; declining records the note the
-- company reads. Both are in the platform audit log. Returns the refund's id when approved.
CREATE FUNCTION ops.platform_decide_credit_refund_request(p_request_id uuid, p_approve boolean,
    p_note text, p_correlation_id text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_request app.credit_refund_requests%ROWTYPE;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_refund uuid;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can decide a refund request.' USING ERRCODE = 'W3403';
  END IF;
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'Approve or decline the request.' USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO v_request FROM app.credit_refund_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Refund request not found.' USING ERRCODE = 'W3404';
  END IF;
  IF v_request.status <> 'open' THEN
    RAISE EXCEPTION 'This request was already decided or withdrawn.' USING ERRCODE = 'W3409';
  END IF;
  IF v_note IS NOT NULL AND (char_length(v_note) < 10 OR char_length(v_note) > 1000) THEN
    RAISE EXCEPTION 'Write a note of 10 to 1,000 characters.' USING ERRCODE = 'W3412';
  END IF;
  IF p_approve THEN
    v_refund := ops.platform_request_credit_refund(v_request.tenant_id, v_request.topup_id,
      v_request.amount_minor, left('Asked for by the company: ' || btrim(v_request.reason), 2000),
      p_correlation_id);
    UPDATE app.credit_refund_requests
       SET status = 'approved', decided_at = now(), decided_by_user_id = v_actor,
           decision_note = v_note, credit_refund_id = v_refund
     WHERE id = v_request.id;
  ELSE
    IF v_note IS NULL THEN
      RAISE EXCEPTION 'Write a note of 10 to 1,000 characters: the company reads it.'
        USING ERRCODE = 'W3412';
    END IF;
    UPDATE app.credit_refund_requests
       SET status = 'declined', decided_at = now(), decided_by_user_id = v_actor, decision_note = v_note
     WHERE id = v_request.id;
  END IF;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, target_tenant_id, reason, result,
    correlation_id, metadata)
  VALUES (v_actor,
    CASE WHEN p_approve THEN 'platform.credit_refund_request_approved'
         ELSE 'platform.credit_refund_request_declined' END,
    v_request.tenant_id, v_note, 'success', p_correlation_id,
    jsonb_build_object('requestId', v_request.id, 'topupId', v_request.topup_id,
      'amountMinor', v_request.amount_minor, 'refundId', v_refund));
  RETURN v_refund;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_decide_credit_refund_request(uuid, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_decide_credit_refund_request(uuid, boolean, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_decide_credit_refund_request(uuid, boolean, text, text) OWNER TO w360_definer;
