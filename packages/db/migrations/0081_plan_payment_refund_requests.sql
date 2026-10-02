-- Refunds of plan payments asked for by companies (P5-07, ADR-104), and every refund of a plan payment
-- in the platform-wide refunds list.
--
-- A company's billing managers ask for a refund of part or all of a plan payment, with a reason, and
-- can withdraw the request while it is open. A platform owner decides: approving starts the staff
-- refund of ADR-103 through ops.platform_request_plan_payment_refund, which checks everything again
-- under its lock (what Razorpay has not refunded of the payment, a refund already in progress, a
-- company being deleted), and declining needs a note the company reads. Money still leaves only when a
-- platform owner decides, and a refund never changes the plan. Platform owners hear of new requests,
-- and billing managers of a decline, from the minute billing sweep, marked in the transaction that
-- queues the email (as for refunds of service credit, 0046).

CREATE TABLE app.plan_payment_refund_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  plan_payment_id uuid NOT NULL,
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
  plan_payment_refund_id uuid,
  -- When platform owners were emailed about the request, and billing managers about a decline.
  announced_at timestamptz,
  decline_notified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_payment_refund_requests_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT plan_payment_refund_requests_payment_fk FOREIGN KEY (tenant_id, plan_payment_id)
    REFERENCES app.plan_payments (tenant_id, id),
  CONSTRAINT plan_payment_refund_requests_refund_fk FOREIGN KEY (tenant_id, plan_payment_refund_id)
    REFERENCES app.plan_payment_refunds (tenant_id, id),
  CONSTRAINT plan_payment_refund_requests_state_check CHECK (
    (status = 'open' AND withdrawn_at IS NULL AND decided_at IS NULL AND decided_by_user_id IS NULL
      AND decision_note IS NULL AND plan_payment_refund_id IS NULL)
    OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL AND decided_at IS NULL
      AND decided_by_user_id IS NULL AND decision_note IS NULL AND plan_payment_refund_id IS NULL)
    OR (status = 'approved' AND withdrawn_at IS NULL AND decided_at IS NOT NULL
      AND decided_by_user_id IS NOT NULL AND plan_payment_refund_id IS NOT NULL)
    OR (status = 'declined' AND withdrawn_at IS NULL AND decided_at IS NOT NULL
      AND decided_by_user_id IS NOT NULL AND decision_note IS NOT NULL
      AND plan_payment_refund_id IS NULL)),
  CONSTRAINT plan_payment_refund_requests_decline_notice_check CHECK (
    decline_notified_at IS NULL OR status = 'declined')
);
-- One open request per payment; a staff refund answers one request.
CREATE UNIQUE INDEX plan_payment_refund_requests_one_open_uq
  ON app.plan_payment_refund_requests (tenant_id, plan_payment_id) WHERE status = 'open';
CREATE UNIQUE INDEX plan_payment_refund_requests_refund_uq
  ON app.plan_payment_refund_requests (tenant_id, plan_payment_refund_id)
  WHERE plan_payment_refund_id IS NOT NULL;
CREATE INDEX plan_payment_refund_requests_tenant_idx ON app.plan_payment_refund_requests
  (tenant_id, requested_at DESC, id DESC);
CREATE INDEX plan_payment_refund_requests_payment_idx ON app.plan_payment_refund_requests
  (tenant_id, plan_payment_id, requested_at DESC);
CREATE INDEX plan_payment_refund_requests_platform_idx ON app.plan_payment_refund_requests
  (requested_at DESC, id DESC);
CREATE INDEX plan_payment_refund_requests_unannounced_idx ON app.plan_payment_refund_requests
  (requested_at) WHERE status = 'open' AND announced_at IS NULL;
CREATE INDEX plan_payment_refund_requests_decline_due_idx ON app.plan_payment_refund_requests
  (decided_at) WHERE status = 'declined' AND decline_notified_at IS NULL;
CREATE TRIGGER plan_payment_refund_requests_touch BEFORE UPDATE ON app.plan_payment_refund_requests
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
SELECT ops.apply_tenant_rls('app.plan_payment_refund_requests');

-- The company asks (an open request: status, the decision and the notice marks are not its columns),
-- withdraws an open request, and reads everything but who decided and the notice marks.
GRANT SELECT (id, tenant_id, plan_payment_id, amount_minor, reason, status, requested_by_user_id,
  requested_at, withdrawn_at, decided_at, decision_note, plan_payment_refund_id, updated_at)
  ON app.plan_payment_refund_requests TO w360_app;
GRANT INSERT (id, tenant_id, plan_payment_id, amount_minor, reason, requested_by_user_id)
  ON app.plan_payment_refund_requests TO w360_app;
GRANT UPDATE (status, withdrawn_at, updated_at) ON app.plan_payment_refund_requests TO w360_app;
CREATE POLICY app_withdraw_open ON app.plan_payment_refund_requests AS RESTRICTIVE FOR UPDATE
  TO w360_app
  USING (status = 'open')
  WITH CHECK (status IN ('open', 'withdrawn'));

-- What the definer functions below read and write: decisions and the two notice marks.
GRANT SELECT ON app.plan_payment_refund_requests TO w360_definer;
GRANT UPDATE (status, decided_by_user_id, decided_at, decision_note, plan_payment_refund_id,
  announced_at, decline_notified_at, updated_at) ON app.plan_payment_refund_requests TO w360_definer;
CREATE POLICY definer_read ON app.plan_payment_refund_requests FOR SELECT TO w360_definer
  USING (true);
CREATE POLICY definer_update ON app.plan_payment_refund_requests FOR UPDATE TO w360_definer
  USING (true) WITH CHECK (true);

-- Deleted with the company (ADR-055): the company's own text. The refunds they led to are kept with
-- the payments they refund (app.plan_payment_refunds, ADR-103), and nothing kept points at a request.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (77, ARRAY['app.plan_payment_refund_requests']::regclass[], 'batch');
GRANT DELETE ON app.plan_payment_refund_requests TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.plan_payment_refund_requests FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.plan_payment_refund_requests FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- Open requests platform owners have not been told about (ids only, for the minute sweep).
CREATE FUNCTION ops.plan_payment_refund_requests_to_announce(p_limit integer)
  RETURNS TABLE (request_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT r.id
    FROM app.plan_payment_refund_requests r
   WHERE r.status = 'open' AND r.announced_at IS NULL
   ORDER BY r.requested_at
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
REVOKE EXECUTE ON FUNCTION ops.plan_payment_refund_requests_to_announce(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.plan_payment_refund_requests_to_announce(integer) TO w360_app;
ALTER FUNCTION ops.plan_payment_refund_requests_to_announce(integer) OWNER TO w360_definer;

-- Marks them as told, in the transaction that queues the emails: each request is checked again (still
-- open, not told), and after a wait on another sweep's lock the check sees that sweep's mark, so a
-- request is announced once. Returns the requests marked here.
CREATE FUNCTION ops.plan_payment_refund_requests_mark_announced(p_request_ids uuid[])
  RETURNS TABLE (request_id uuid)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  UPDATE app.plan_payment_refund_requests r
     SET announced_at = now()
   WHERE r.id = ANY (p_request_ids) AND r.status = 'open' AND r.announced_at IS NULL
  RETURNING r.id
$$;
REVOKE EXECUTE ON FUNCTION ops.plan_payment_refund_requests_mark_announced(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.plan_payment_refund_requests_mark_announced(uuid[]) TO w360_app;
ALTER FUNCTION ops.plan_payment_refund_requests_mark_announced(uuid[]) OWNER TO w360_definer;

-- Declined requests whose billing managers have not been told (ids only, for the minute sweep, which
-- tells each company in its own scope). A deleted company is left out.
CREATE FUNCTION ops.plan_payment_refund_request_declines_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, request_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT r.tenant_id, r.id
    FROM app.plan_payment_refund_requests r
    JOIN app.tenants t ON t.id = r.tenant_id
   WHERE r.status = 'declined' AND r.decline_notified_at IS NULL AND t.status <> 'deleted'
   ORDER BY r.decided_at
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
REVOKE EXECUTE ON FUNCTION ops.plan_payment_refund_request_declines_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.plan_payment_refund_request_declines_due(integer) TO w360_app;
ALTER FUNCTION ops.plan_payment_refund_request_declines_due(integer) OWNER TO w360_definer;

-- Marks a decline as told, in the company's scope and in the transaction that queues the email;
-- true only for the first call, so a decline is told once.
CREATE FUNCTION app.plan_payment_refund_request_mark_decline_notified(p_request_id uuid)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  WITH marked AS (
    UPDATE app.plan_payment_refund_requests r
       SET decline_notified_at = now()
     WHERE r.tenant_id = app.current_tenant_id()::uuid AND r.id = p_request_id
       AND r.status = 'declined' AND r.decline_notified_at IS NULL
    RETURNING r.id)
  SELECT EXISTS (SELECT 1 FROM marked)
$$;
REVOKE EXECUTE ON FUNCTION app.plan_payment_refund_request_mark_decline_notified(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.plan_payment_refund_request_mark_decline_notified(uuid) TO w360_app;
ALTER FUNCTION app.plan_payment_refund_request_mark_decline_notified(uuid) OWNER TO w360_definer;

-- Requests for platform staff, newest first (keyset pages on the exact request time and id):
-- `open`, `decided` (approved or declined) or every request. With each: the company, the payment,
-- what Razorpay has not refunded of it and whether a refund of it is already running.
CREATE FUNCTION ops.platform_plan_payment_refund_requests(p_status text, p_before_at timestamptz,
    p_before_id uuid, p_limit integer)
  RETURNS TABLE (id uuid, tenant_id uuid, company_name text, company_slug text, company_status text,
    plan_payment_id uuid, payment_receipt text, payment_amount_minor bigint,
    payment_refunded_minor bigint, payment_paid_at timestamptz, refund_in_progress boolean,
    amount_minor bigint, reason text, status text, requested_by_name text, requested_at timestamptz,
    cursor_at text, decided_at timestamptz, decided_by_name text, decision_note text,
    plan_payment_refund_id uuid, plan_payment_refund_status text)
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
  SELECT r.id, r.tenant_id, tn.name, tn.slug, tn.status, r.plan_payment_id, p.provider_invoice_id,
         p.amount_minor,
         (SELECT coalesce(sum(x.amount_minor), 0)::bigint FROM app.plan_payment_refunds x
           WHERE x.tenant_id = r.tenant_id AND x.plan_payment_id = r.plan_payment_id
             AND x.status = 'processed'),
         p.paid_at,
         EXISTS (SELECT 1 FROM app.plan_payment_refunds o
                  WHERE o.tenant_id = r.tenant_id AND o.plan_payment_id = r.plan_payment_id
                    AND o.status IN ('requested', 'submitted')),
         r.amount_minor, r.reason, r.status, ru.name, r.requested_at,
         to_char(r.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         r.decided_at, du.name, r.decision_note, r.plan_payment_refund_id, pr.status
    FROM app.plan_payment_refund_requests r
    JOIN app.tenants tn ON tn.id = r.tenant_id
    JOIN app.plan_payments p ON p.tenant_id = r.tenant_id AND p.id = r.plan_payment_id
    LEFT JOIN auth.users ru ON ru.id = r.requested_by_user_id
    LEFT JOIN auth.users du ON du.id = r.decided_by_user_id
    LEFT JOIN app.plan_payment_refunds pr
      ON pr.tenant_id = r.tenant_id AND pr.id = r.plan_payment_refund_id
   WHERE (p_status IS NULL
          OR (p_status = 'open' AND r.status = 'open')
          OR (p_status = 'decided' AND r.status IN ('approved', 'declined')))
     AND (p_before_at IS NULL OR (r.requested_at, r.id) < (p_before_at, p_before_id))
   ORDER BY r.requested_at DESC, r.id DESC
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_plan_payment_refund_requests(text, timestamptz, uuid, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_plan_payment_refund_requests(text, timestamptz, uuid, integer)
  TO w360_platform;
ALTER FUNCTION ops.platform_plan_payment_refund_requests(text, timestamptz, uuid, integer)
  OWNER TO w360_definer;

-- Every refund of a plan payment across companies for platform staff, newest first (keyset pages on
-- the exact request time and id): started by HyFib (with the reason and who asked), answering a
-- company's request, or made at Razorpay; kept after a company's deletion.
CREATE FUNCTION ops.platform_plan_payment_refunds(p_before_at timestamptz, p_before_id uuid,
    p_limit integer)
  RETURNS TABLE (id uuid, tenant_id uuid, company_name text, company_slug text,
    plan_payment_id uuid, payment_receipt text, origin text, amount_minor bigint, status text,
    reason text, requested_by_name text, requested_at timestamptz, cursor_at text,
    submitted_at timestamptz, processed_at timestamptz, failed_at timestamptz, last_error text,
    request_id uuid)
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
  SELECT pr.id, pr.tenant_id, tn.name, tn.slug, pr.plan_payment_id, p.provider_invoice_id, pr.origin,
         pr.amount_minor, pr.status, pr.reason, u.name, pr.requested_at,
         to_char(pr.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         pr.submitted_at, pr.processed_at, pr.failed_at, pr.last_error, q.id
    FROM app.plan_payment_refunds pr
    JOIN app.tenants tn ON tn.id = pr.tenant_id
    JOIN app.plan_payments p ON p.tenant_id = pr.tenant_id AND p.id = pr.plan_payment_id
    LEFT JOIN auth.users u ON u.id = pr.requested_by_user_id
    LEFT JOIN app.plan_payment_refund_requests q
      ON q.tenant_id = pr.tenant_id AND q.plan_payment_refund_id = pr.id
   WHERE p_before_at IS NULL OR (pr.requested_at, pr.id) < (p_before_at, p_before_id)
   ORDER BY pr.requested_at DESC, pr.id DESC
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_plan_payment_refunds(timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_plan_payment_refunds(timestamptz, uuid, integer)
  TO w360_platform;
ALTER FUNCTION ops.platform_plan_payment_refunds(timestamptz, uuid, integer) OWNER TO w360_definer;

-- A platform owner decides an open request. Approving starts the staff refund of ADR-103 for the
-- request's amount (every check again, under its lock) and links it; declining records the note the
-- company reads. Both are in the platform audit log. Returns the refund's id when approved.
CREATE FUNCTION ops.platform_decide_plan_payment_refund_request(p_request_id uuid, p_approve boolean,
    p_note text, p_correlation_id text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_request app.plan_payment_refund_requests%ROWTYPE;
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
  SELECT * INTO v_request FROM app.plan_payment_refund_requests r WHERE r.id = p_request_id FOR UPDATE;
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
    v_refund := ops.platform_request_plan_payment_refund(v_request.tenant_id,
      v_request.plan_payment_id, v_request.amount_minor,
      left('Asked for by the company: ' || btrim(v_request.reason), 2000), p_correlation_id);
    UPDATE app.plan_payment_refund_requests
       SET status = 'approved', decided_at = now(), decided_by_user_id = v_actor,
           decision_note = v_note, plan_payment_refund_id = v_refund
     WHERE id = v_request.id;
  ELSE
    IF v_note IS NULL THEN
      RAISE EXCEPTION 'Write a note of 10 to 1,000 characters: the company reads it.'
        USING ERRCODE = 'W3412';
    END IF;
    UPDATE app.plan_payment_refund_requests
       SET status = 'declined', decided_at = now(), decided_by_user_id = v_actor, decision_note = v_note
     WHERE id = v_request.id;
  END IF;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, target_tenant_id, reason, result,
    correlation_id, metadata)
  VALUES (v_actor,
    CASE WHEN p_approve THEN 'platform.plan_payment_refund_request_approved'
         ELSE 'platform.plan_payment_refund_request_declined' END,
    v_request.tenant_id, v_note, 'success', p_correlation_id,
    jsonb_build_object('requestId', v_request.id, 'planPaymentId', v_request.plan_payment_id,
      'amountMinor', v_request.amount_minor, 'refundId', v_refund));
  RETURN v_refund;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_decide_plan_payment_refund_request(uuid, boolean, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_decide_plan_payment_refund_request(uuid, boolean, text, text)
  TO w360_platform;
ALTER FUNCTION ops.platform_decide_plan_payment_refund_request(uuid, boolean, text, text)
  OWNER TO w360_definer;
