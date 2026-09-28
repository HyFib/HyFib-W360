-- Refunds of unused service credit started by platform owners (P5-05, ADR-058).
--
-- A platform owner asks for a refund of part or all of a paid top-up that the company has not spent.
-- The request holds that credit aside at once; the worker asks Razorpay for the refund with an
-- idempotency key; app.billing_record_refund (replaced below) records the refund Razorpay reports and
-- releases the hold in the same transaction, and a refusal or failed refund releases it instead.

CREATE TABLE app.credit_refunds (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  topup_id uuid NOT NULL,
  hold_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'submitted', 'processed', 'failed')),
  -- The platform owner's reason: platform-only (the company role has no grant on it).
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 2000),
  requested_by_user_id text NOT NULL REFERENCES auth.users (id),
  provider_refund_id text CHECK (provider_refund_id ~ '^rfnd_[A-Za-z0-9]{1,40}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (char_length(last_error) <= 500),
  requested_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  processed_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_refunds_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT credit_refunds_topup_fk FOREIGN KEY (tenant_id, topup_id) REFERENCES app.topups (tenant_id, id),
  CONSTRAINT credit_refunds_hold_fk FOREIGN KEY (tenant_id, hold_id) REFERENCES app.wallet_holds (tenant_id, id),
  CONSTRAINT credit_refunds_hold_uq UNIQUE (tenant_id, hold_id),
  CONSTRAINT credit_refunds_submitted_has_refund CHECK (
    status NOT IN ('submitted', 'processed') OR provider_refund_id IS NOT NULL)
);
-- One open refund per top-up; a Razorpay refund belongs to one request.
CREATE UNIQUE INDEX credit_refunds_one_open_uq ON app.credit_refunds (tenant_id, topup_id)
  WHERE status IN ('requested', 'submitted');
CREATE UNIQUE INDEX credit_refunds_provider_uq ON app.credit_refunds (provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE INDEX credit_refunds_due_idx ON app.credit_refunds (next_attempt_at)
  WHERE status IN ('requested', 'submitted');
CREATE INDEX credit_refunds_topup_idx ON app.credit_refunds (tenant_id, topup_id, requested_at DESC);
CREATE TRIGGER credit_refunds_touch BEFORE UPDATE ON app.credit_refunds
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
SELECT ops.apply_tenant_rls('app.credit_refunds');

-- The company reads its refunds (not the staff reason or who asked); the worker moves open requests
-- between requested and submitted only: processed and failed are reachable only through the definer
-- functions, which also settle the hold.
GRANT SELECT (id, tenant_id, topup_id, hold_id, amount_minor, status, provider_refund_id, attempts,
  next_attempt_at, last_error, requested_at, submitted_at, processed_at, failed_at, updated_at)
  ON app.credit_refunds TO w360_app;
GRANT UPDATE (status, provider_refund_id, attempts, next_attempt_at, last_error, submitted_at, updated_at)
  ON app.credit_refunds TO w360_app;
CREATE POLICY app_update_open ON app.credit_refunds AS RESTRICTIVE FOR UPDATE TO w360_app
  USING (status IN ('requested', 'submitted'))
  WITH CHECK (status IN ('requested', 'submitted'));

CREATE POLICY definer_all ON app.credit_refunds TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON app.credit_refunds TO w360_definer;
GRANT UPDATE (status, provider_refund_id, next_attempt_at, last_error, processed_at, failed_at, updated_at)
  ON app.credit_refunds TO w360_definer;

-- Asking for a refund (platform owners) -----------------------------------------------------------
CREATE FUNCTION ops.platform_request_credit_refund(p_tenant_id uuid, p_topup_id uuid,
    p_amount_minor bigint, p_reason text, p_correlation_id text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_status text;
  v_topup app.topups%ROWTYPE;
  v_available bigint;
  v_hold uuid := gen_random_uuid();
  v_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can refund service credit.' USING ERRCODE = 'W3403';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters.' USING ERRCODE = 'W3412';
  END IF;
  -- No new refund once the company asked for its deletion: the deletion waits for refunds in
  -- progress (the worker checks before it starts), and nothing runs for a deleted company. A refund
  -- there is made in the Razorpay Dashboard and recorded from its webhook, as before.
  SELECT t.status INTO v_status FROM app.tenants t WHERE t.id = p_tenant_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Company not found.' USING ERRCODE = 'W3404';
  END IF;
  IF v_status IN ('pending_deletion', 'deleted') THEN
    RAISE EXCEPTION 'The company is being deleted: refund the payment in the Razorpay Dashboard.'
      USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO v_topup FROM app.topups t
   WHERE t.tenant_id = p_tenant_id AND t.id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Top-up not found.' USING ERRCODE = 'W3404';
  END IF;
  IF v_topup.status NOT IN ('paid', 'partially_refunded') OR v_topup.provider_payment_id IS NULL THEN
    RAISE EXCEPTION 'Only a paid top-up that is not fully refunded can be refunded.' USING ERRCODE = 'W3412';
  END IF;
  IF EXISTS (SELECT 1 FROM app.credit_refunds r
              WHERE r.tenant_id = p_tenant_id AND r.topup_id = p_topup_id
                AND r.status IN ('requested', 'submitted')) THEN
    RAISE EXCEPTION 'A refund of this top-up is already in progress.' USING ERRCODE = 'W3409';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor < 1
     OR p_amount_minor > v_topup.amount_minor - v_topup.refunded_minor THEN
    RAISE EXCEPTION 'The amount must be at least 1 paisa and at most what is left of the payment.'
      USING ERRCODE = 'W3412';
  END IF;
  -- Only unspent credit: the wallet's available balance, under its row lock (as app.billing_hold).
  SELECT a.balance_minor INTO v_available FROM app.ledger_accounts a
   WHERE a.tenant_id = p_tenant_id AND a.wallet_id = v_topup.wallet_id AND a.code = 'wallet_available'
   FOR UPDATE;
  IF v_available IS NULL OR v_available < p_amount_minor THEN
    RAISE EXCEPTION 'The company has less unused credit than the refund.' USING ERRCODE = 'W3402';
  END IF;
  INSERT INTO app.wallet_holds (id, tenant_id, wallet_id, amount_minor, idempotency_key, reference_type,
    reference_id, expires_at)
  VALUES (v_hold, p_tenant_id, v_topup.wallet_id, p_amount_minor, 'credit_refund:' || v_id::text,
    'credit_refund', v_id::text, now() + interval '90 days');
  PERFORM app.ledger_post(p_tenant_id, v_topup.wallet_id, 'hold', 'hold:' || v_hold::text, 'credit_refund',
    v_id::text, 'Reserved for a refund', 'user', v_actor,
    jsonb_build_array(
      jsonb_build_object('account', 'wallet_available', 'direction', 'debit', 'amount', p_amount_minor),
      jsonb_build_object('account', 'wallet_held', 'direction', 'credit', 'amount', p_amount_minor)));
  INSERT INTO app.credit_refunds (id, tenant_id, topup_id, hold_id, amount_minor, reason, requested_by_user_id)
  VALUES (v_id, p_tenant_id, p_topup_id, v_hold, p_amount_minor, btrim(p_reason), v_actor);
  INSERT INTO ops.platform_audit_events (actor_user_id, action, target_tenant_id, reason, result,
    correlation_id, metadata)
  VALUES (v_actor, 'platform.credit_refund_requested', p_tenant_id, btrim(p_reason), 'success',
    p_correlation_id, jsonb_build_object('refundId', v_id, 'topupId', p_topup_id, 'amountMinor', p_amount_minor));
  RETURN v_id;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_request_credit_refund(uuid, uuid, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_request_credit_refund(uuid, uuid, bigint, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_request_credit_refund(uuid, uuid, bigint, text, text) OWNER TO w360_definer;

-- A company's top-ups, balances and refunds for platform staff (payments to the platform; no content)
CREATE FUNCTION ops.platform_company_billing(p_tenant_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  SELECT jsonb_build_object(
    'available', (SELECT a.balance_minor FROM app.ledger_accounts a
                   WHERE a.tenant_id = p_tenant_id AND a.code = 'wallet_available'),
    'reserved', (SELECT a.balance_minor FROM app.ledger_accounts a
                  WHERE a.tenant_id = p_tenant_id AND a.code = 'wallet_held'),
    'topups', coalesce((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC, t.id DESC)
        FROM (SELECT tu.id, tu.receipt, tu.kind, tu.amount_minor, tu.refunded_minor, tu.status,
                     tu.payment_method, tu.paid_at, tu.created_at
                FROM app.topups tu
               WHERE tu.tenant_id = p_tenant_id AND tu.status IN ('paid', 'partially_refunded', 'refunded')
               ORDER BY tu.created_at DESC, tu.id DESC
               LIMIT 50) t), '[]'::jsonb),
    'refunds', coalesce((
      SELECT jsonb_agg(to_jsonb(r) ORDER BY r.requested_at DESC, r.id DESC)
        FROM (SELECT cr.id, cr.topup_id, cr.amount_minor, cr.status, cr.provider_refund_id, cr.last_error,
                     cr.reason, u.name AS requested_by_name, cr.requested_at, cr.submitted_at,
                     cr.processed_at, cr.failed_at
                FROM app.credit_refunds cr
                LEFT JOIN auth.users u ON u.id = cr.requested_by_user_id
               WHERE cr.tenant_id = p_tenant_id
               ORDER BY cr.requested_at DESC, cr.id DESC
               LIMIT 50) r), '[]'::jsonb))
    INTO v_result;
  RETURN v_result;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_company_billing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_company_billing(uuid) TO w360_platform;
ALTER FUNCTION ops.platform_company_billing(uuid) OWNER TO w360_definer;

-- Requests the worker should act on now (the minute sweep queues one job each) ----------------------
CREATE FUNCTION ops.credit_refunds_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, refund_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT r.tenant_id, r.id
    FROM app.credit_refunds r
   WHERE r.status IN ('requested', 'submitted') AND r.next_attempt_at <= now()
   ORDER BY r.next_attempt_at
   LIMIT greatest(least(p_limit, 500), 1)
$$;
REVOKE EXECUTE ON FUNCTION ops.credit_refunds_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.credit_refunds_due(integer) TO w360_app;
ALTER FUNCTION ops.credit_refunds_due(integer) OWNER TO w360_definer;

-- A refusal or a failed refund: the request fails and its hold is released, together -------------
CREATE FUNCTION app.billing_fail_credit_refund(p_refund_id uuid, p_error text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_request app.credit_refunds%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  SELECT * INTO v_request FROM app.credit_refunds r
   WHERE r.tenant_id = v_tenant AND r.id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund request not found' USING ERRCODE = 'W3404';
  END IF;
  IF v_request.status = 'failed' THEN
    RETURN 'already_failed';
  END IF;
  IF v_request.status <> 'requested' AND v_request.status <> 'submitted' THEN
    RAISE EXCEPTION 'the refund was already processed' USING ERRCODE = 'W3409';
  END IF;
  PERFORM app.billing_release_hold(v_request.hold_id);
  UPDATE app.credit_refunds r
     SET status = 'failed', failed_at = now(), last_error = left(coalesce(p_error, 'failed'), 500)
   WHERE r.tenant_id = v_tenant AND r.id = p_refund_id;
  RETURN 'failed';
END
$$;
REVOKE EXECUTE ON FUNCTION app.billing_fail_credit_refund(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.billing_fail_credit_refund(uuid, text) TO w360_app;
ALTER FUNCTION app.billing_fail_credit_refund(uuid, text) OWNER TO w360_definer;

-- Recording a refund now also completes a staff request for it --------------------------------------
-- Same rules as 0004; in addition, a refund of a top-up with an open request (the same refund id, or no
-- refund id stored yet and the same amount) releases the request's hold first and marks it processed,
-- so the refund takes the credit the hold set aside, exactly once. The function is owned by
-- w360_definer, which the migration role cannot replace in place (see 0011): the owner drops it and
-- the migration role recreates it, granting before handing it back.
SET ROLE w360_definer;
DROP FUNCTION app.billing_record_refund(uuid, text, bigint);
RESET ROLE;
CREATE FUNCTION app.billing_record_refund(p_topup_id uuid, p_refund_id text, p_amount_minor bigint)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_topup app.topups%ROWTYPE;
  v_key text := 'refund:' || p_refund_id;
  v_request app.credit_refunds%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  IF p_refund_id IS NULL OR p_refund_id !~ '^rfnd_[A-Za-z0-9]{1,40}$' OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'invalid refund' USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO v_topup FROM app.topups t WHERE t.tenant_id = v_tenant AND t.id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'top-up not found' USING ERRCODE = 'W3404';
  END IF;
  IF EXISTS (SELECT 1 FROM app.ledger_transactions l WHERE l.tenant_id = v_tenant AND l.idempotency_key = v_key) THEN
    RETURN 'already_recorded';
  END IF;
  IF v_topup.status NOT IN ('paid', 'partially_refunded') THEN
    RAISE EXCEPTION 'only paid top-ups can be refunded' USING ERRCODE = 'W3412';
  END IF;
  IF v_topup.refunded_minor + p_amount_minor > v_topup.amount_minor THEN
    RAISE EXCEPTION 'refund exceeds the paid amount' USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO v_request FROM app.credit_refunds r
   WHERE r.tenant_id = v_tenant AND r.topup_id = p_topup_id AND r.status IN ('requested', 'submitted')
     AND (r.provider_refund_id = p_refund_id
          OR (r.provider_refund_id IS NULL AND r.amount_minor = p_amount_minor))
   FOR UPDATE;
  IF FOUND THEN
    PERFORM app.billing_release_hold(v_request.hold_id);
    UPDATE app.credit_refunds r
       SET status = 'processed', provider_refund_id = p_refund_id, processed_at = now()
     WHERE r.tenant_id = v_tenant AND r.id = v_request.id;
  END IF;
  PERFORM app.ledger_post(v_tenant, v_topup.wallet_id, 'refund', v_key, 'topup', v_topup.id::text,
    'Refund to card', 'provider', p_refund_id,
    jsonb_build_array(
      jsonb_build_object('account', 'wallet_available', 'direction', 'debit', 'amount', p_amount_minor),
      jsonb_build_object('account', 'payment_clearing', 'direction', 'credit', 'amount', p_amount_minor)));
  UPDATE app.topups t
     SET refunded_minor = t.refunded_minor + p_amount_minor,
         status = CASE WHEN t.refunded_minor + p_amount_minor = t.amount_minor THEN 'refunded' ELSE 'partially_refunded' END
   WHERE t.tenant_id = v_tenant AND t.id = p_topup_id;
  RETURN 'recorded';
END
$$;
REVOKE EXECUTE ON FUNCTION app.billing_record_refund(uuid, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.billing_record_refund(uuid, text, bigint) TO w360_app;
ALTER FUNCTION app.billing_record_refund(uuid, text, bigint) OWNER TO w360_definer;
