-- Refunds of plan payments (P5-07, ADR-103). A platform owner refunds part or all of a plan payment
-- Razorpay charged for a company's subscription (ADR-063), and a refund made at Razorpay (for example
-- in its Dashboard) is recorded too; until now neither was possible. Plan payments never touch the
-- wallet, so nothing is held: the worker asks Razorpay for the refund with an idempotency key, and
-- app.record_plan_payment_refund records what Razorpay reports. A refund never changes the plan
-- state or the subscription.

CREATE TABLE app.plan_payment_refunds (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  plan_payment_id uuid NOT NULL,
  -- 'staff': asked for by a platform owner in HyFib; 'razorpay': made at Razorpay and recorded from
  -- what Razorpay reports.
  origin text NOT NULL CHECK (origin IN ('staff', 'razorpay')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'submitted', 'processed', 'failed')),
  -- The platform owner's reason and who asked: platform-only (the company role has no grant on them).
  reason text CHECK (char_length(reason) BETWEEN 10 AND 2000),
  requested_by_user_id text REFERENCES auth.users (id),
  provider_refund_id text CHECK (provider_refund_id ~ '^rfnd_[A-Za-z0-9]{1,40}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (char_length(last_error) <= 500),
  requested_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  processed_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_payment_refunds_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT plan_payment_refunds_payment_fk FOREIGN KEY (tenant_id, plan_payment_id)
    REFERENCES app.plan_payments (tenant_id, id),
  CONSTRAINT plan_payment_refunds_origin_fields CHECK (
    (origin = 'staff' AND reason IS NOT NULL AND requested_by_user_id IS NOT NULL)
    OR (origin = 'razorpay' AND reason IS NULL AND requested_by_user_id IS NULL
        AND status = 'processed')),
  CONSTRAINT plan_payment_refunds_has_refund CHECK (
    status NOT IN ('submitted', 'processed') OR provider_refund_id IS NOT NULL),
  CONSTRAINT plan_payment_refunds_processed_at CHECK ((status = 'processed') = (processed_at IS NOT NULL))
);
-- One open refund per payment; a Razorpay refund is recorded once.
CREATE UNIQUE INDEX plan_payment_refunds_one_open_uq ON app.plan_payment_refunds (tenant_id, plan_payment_id)
  WHERE status IN ('requested', 'submitted');
CREATE UNIQUE INDEX plan_payment_refunds_provider_uq ON app.plan_payment_refunds (provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE INDEX plan_payment_refunds_due_idx ON app.plan_payment_refunds (next_attempt_at)
  WHERE status IN ('requested', 'submitted');
CREATE INDEX plan_payment_refunds_payment_idx
  ON app.plan_payment_refunds (tenant_id, plan_payment_id, requested_at);
CREATE TRIGGER plan_payment_refunds_touch BEFORE UPDATE ON app.plan_payment_refunds
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
-- A billing record, kept after the company's deletion like the payment it refunds (ADR-055).
CREATE TRIGGER plan_payment_refunds_no_delete BEFORE DELETE ON app.plan_payment_refunds
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
SELECT ops.apply_tenant_rls('app.plan_payment_refunds');

-- The company reads its refunds (not the staff reason or who asked). The worker moves a staff request
-- from requested to submitted, or fails an open one; only app.record_plan_payment_refund marks a
-- refund processed, and nobody else inserts one.
GRANT SELECT (id, tenant_id, plan_payment_id, origin, amount_minor, status, provider_refund_id, attempts,
  next_attempt_at, last_error, requested_at, submitted_at, processed_at, failed_at, updated_at)
  ON app.plan_payment_refunds TO w360_app;
GRANT UPDATE (status, provider_refund_id, attempts, next_attempt_at, last_error, submitted_at, failed_at,
  updated_at) ON app.plan_payment_refunds TO w360_app;
CREATE POLICY app_update_open ON app.plan_payment_refunds AS RESTRICTIVE FOR UPDATE TO w360_app
  USING (status IN ('requested', 'submitted'))
  WITH CHECK (status IN ('requested', 'submitted', 'failed'));
-- Platform staff read every company's refunds, with the reason and who asked (payments to HyFib).
CREATE POLICY platform_read ON app.plan_payment_refunds FOR SELECT TO w360_platform USING (true);
GRANT SELECT ON app.plan_payment_refunds TO w360_platform;
CREATE POLICY definer_all ON app.plan_payment_refunds TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON app.plan_payment_refunds TO w360_definer;
GRANT UPDATE (status, provider_refund_id, processed_at, updated_at) ON app.plan_payment_refunds TO w360_definer;

-- Asking for a refund (platform owners) -----------------------------------------------------------------
-- Requests and recordings of one payment's refunds take the same transaction lock, so the processed
-- refunds and an open request never exceed what was paid.
CREATE FUNCTION ops.platform_request_plan_payment_refund(p_tenant_id uuid, p_plan_payment_id uuid,
    p_amount_minor bigint, p_reason text, p_correlation_id text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_status text;
  v_payment app.plan_payments%ROWTYPE;
  v_refunded bigint;
  v_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can refund a plan payment.' USING ERRCODE = 'W3403';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters.' USING ERRCODE = 'W3412';
  END IF;
  -- As for refunds of service credit (0032): the deletion waits for refunds in progress, and nothing
  -- runs for a deleted company. A refund there is made in the Razorpay Dashboard and recorded from
  -- its webhook.
  SELECT t.status INTO v_status FROM app.tenants t WHERE t.id = p_tenant_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Company not found.' USING ERRCODE = 'W3404';
  END IF;
  IF v_status IN ('pending_deletion', 'deleted') THEN
    RAISE EXCEPTION 'The company is being deleted: refund the payment in the Razorpay Dashboard.'
      USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO v_payment FROM app.plan_payments p
   WHERE p.tenant_id = p_tenant_id AND p.id = p_plan_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan payment not found.' USING ERRCODE = 'W3404';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('w360:plan-payment-refunds:' || v_payment.id::text, 0));
  IF EXISTS (SELECT 1 FROM app.plan_payment_refunds r
              WHERE r.tenant_id = p_tenant_id AND r.plan_payment_id = p_plan_payment_id
                AND r.status IN ('requested', 'submitted')) THEN
    RAISE EXCEPTION 'A refund of this payment is already in progress.' USING ERRCODE = 'W3409';
  END IF;
  SELECT coalesce(sum(r.amount_minor), 0) INTO v_refunded FROM app.plan_payment_refunds r
   WHERE r.tenant_id = p_tenant_id AND r.plan_payment_id = p_plan_payment_id AND r.status = 'processed';
  IF p_amount_minor IS NULL OR p_amount_minor < 1 OR p_amount_minor > v_payment.amount_minor - v_refunded THEN
    RAISE EXCEPTION 'The amount must be at least 1 paisa and at most what is left of the payment.'
      USING ERRCODE = 'W3412';
  END IF;
  INSERT INTO app.plan_payment_refunds (id, tenant_id, plan_payment_id, origin, amount_minor, reason,
    requested_by_user_id)
  VALUES (v_id, p_tenant_id, p_plan_payment_id, 'staff', p_amount_minor, btrim(p_reason), v_actor);
  INSERT INTO ops.platform_audit_events (actor_user_id, action, target_tenant_id, reason, result,
    correlation_id, metadata)
  VALUES (v_actor, 'platform.plan_payment_refund_requested', p_tenant_id, btrim(p_reason), 'success',
    p_correlation_id, jsonb_build_object('refundId', v_id, 'planPaymentId', p_plan_payment_id,
      'amountMinor', p_amount_minor));
  RETURN v_id;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_request_plan_payment_refund(uuid, uuid, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_request_plan_payment_refund(uuid, uuid, bigint, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_request_plan_payment_refund(uuid, uuid, bigint, text, text) OWNER TO w360_definer;

-- Requests the worker should act on now (the minute billing sweep queues one job each) --------------------
CREATE FUNCTION ops.plan_payment_refunds_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, refund_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT r.tenant_id, r.id
    FROM app.plan_payment_refunds r
   WHERE r.status IN ('requested', 'submitted') AND r.next_attempt_at <= now()
   ORDER BY r.next_attempt_at
   LIMIT greatest(least(p_limit, 500), 1)
$$;
REVOKE EXECUTE ON FUNCTION ops.plan_payment_refunds_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.plan_payment_refunds_due(integer) TO w360_app;
ALTER FUNCTION ops.plan_payment_refunds_due(integer) OWNER TO w360_definer;

-- Recording a refund Razorpay processed ------------------------------------------------------------------
-- In the company's own scope, with the refund fetched from Razorpay: the refund with this id (a staff
-- request already submitted) becomes processed; otherwise the staff request its notes name, when
-- its refund id was never stored (a lost response) and the amount is the same, even one marked
-- failed meanwhile, since Razorpay processed it; otherwise it is a refund made at Razorpay. The
-- processed refunds of a payment never exceed what was paid.
CREATE FUNCTION app.record_plan_payment_refund(p_payment_id text, p_refund_id text,
    p_amount_minor bigint, p_request_id uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_payment app.plan_payments%ROWTYPE;
  v_refund app.plan_payment_refunds%ROWTYPE;
  v_refunded bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  IF p_refund_id IS NULL OR p_refund_id !~ '^rfnd_[A-Za-z0-9]{1,40}$' OR p_amount_minor IS NULL
     OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'invalid refund' USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO v_payment FROM app.plan_payments p
   WHERE p.tenant_id = v_tenant AND p.provider_payment_id = p_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan payment not found' USING ERRCODE = 'W3404';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('w360:plan-payment-refunds:' || v_payment.id::text, 0));
  SELECT * INTO v_refund FROM app.plan_payment_refunds r WHERE r.provider_refund_id = p_refund_id;
  IF FOUND THEN
    IF v_refund.tenant_id <> v_tenant OR v_refund.plan_payment_id <> v_payment.id
       OR v_refund.amount_minor <> p_amount_minor THEN
      RAISE EXCEPTION 'the refund does not match the one recorded with its id' USING ERRCODE = 'W3412';
    END IF;
    IF v_refund.status = 'processed' THEN
      RETURN 'already_recorded';
    END IF;
  ELSIF p_request_id IS NOT NULL THEN
    SELECT * INTO v_refund FROM app.plan_payment_refunds r
     WHERE r.tenant_id = v_tenant AND r.id = p_request_id AND r.plan_payment_id = v_payment.id
       AND r.origin = 'staff' AND r.provider_refund_id IS NULL AND r.amount_minor = p_amount_minor
       AND r.status IN ('requested', 'failed');
  END IF;
  IF v_refund.id IS NOT NULL THEN
    UPDATE app.plan_payment_refunds r
       SET status = 'processed', provider_refund_id = p_refund_id, processed_at = now()
     WHERE r.tenant_id = v_tenant AND r.id = v_refund.id;
  ELSE
    INSERT INTO app.plan_payment_refunds (id, tenant_id, plan_payment_id, origin, amount_minor, status,
      provider_refund_id, processed_at)
    VALUES (gen_random_uuid(), v_tenant, v_payment.id, 'razorpay', p_amount_minor, 'processed',
      p_refund_id, now());
  END IF;
  SELECT coalesce(sum(r.amount_minor), 0) INTO v_refunded FROM app.plan_payment_refunds r
   WHERE r.tenant_id = v_tenant AND r.plan_payment_id = v_payment.id AND r.status = 'processed';
  IF v_refunded > v_payment.amount_minor THEN
    RAISE EXCEPTION 'refunds exceed the paid amount' USING ERRCODE = 'W3412';
  END IF;
  RETURN 'recorded';
END
$$;
REVOKE EXECUTE ON FUNCTION app.record_plan_payment_refund(text, text, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_plan_payment_refund(text, text, bigint, uuid) TO w360_app;
ALTER FUNCTION app.record_plan_payment_refund(text, text, bigint, uuid) OWNER TO w360_definer;

-- The daily reconciliation matches refunds of plan payments ----------------------------------------------
-- As in 0037, with the refunds of plan payments HyFib recorded as processed (by refund id). A refund of
-- a plan payment it has not recorded is now fetched and recorded (ADR-103) rather than left to a
-- person; the 'plan_payment_refund' reason stays for items classified before.
SET ROLE w360_definer;
DROP FUNCTION ops.settlement_recon_facts(text[], text[], text[], text[]);
RESET ROLE;
CREATE FUNCTION ops.settlement_recon_facts(p_payment_ids text[], p_order_ids text[],
    p_refund_ids text[], p_refund_payment_ids text[])
  RETURNS TABLE (kind text, provider_id text, tenant_id uuid, subject_id uuid, amount_minor bigint,
                 currency text, status text, payment_id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF coalesce(cardinality(p_payment_ids), 0) > 1000 OR coalesce(cardinality(p_order_ids), 0) > 1000
     OR coalesce(cardinality(p_refund_ids), 0) > 1000
     OR coalesce(cardinality(p_refund_payment_ids), 0) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 ids of each kind at a time' USING ERRCODE = 'W3412';
  END IF;
  RETURN QUERY
    SELECT 'topup_payment'::text, t.provider_payment_id, t.tenant_id, t.id, t.amount_minor, t.currency,
           t.status, t.provider_payment_id
      FROM app.topups t WHERE t.provider_payment_id = ANY (p_payment_ids || p_refund_payment_ids)
    UNION ALL
    SELECT 'topup_order'::text, t.provider_order_id, t.tenant_id, t.id, t.amount_minor, t.currency,
           t.status, t.provider_payment_id
      FROM app.topups t WHERE t.provider_order_id = ANY (p_order_ids)
    UNION ALL
    SELECT 'mandate_payment'::text, m.authorization_payment_id, m.tenant_id, m.id, NULL::bigint,
           NULL::text, m.status, m.authorization_payment_id
      FROM app.payment_mandates m
     WHERE m.authorization_payment_id = ANY (p_payment_ids || p_refund_payment_ids)
    UNION ALL
    SELECT 'mandate_order'::text, m.authorization_order_id, m.tenant_id, m.id, NULL::bigint, NULL::text,
           m.status, m.authorization_payment_id
      FROM app.payment_mandates m WHERE m.authorization_order_id = ANY (p_order_ids)
    UNION ALL
    SELECT 'mandate_refund'::text, m.authorization_refund_id, m.tenant_id, m.id, NULL::bigint, NULL::text,
           m.status, m.authorization_payment_id
      FROM app.payment_mandates m WHERE m.authorization_refund_id = ANY (p_refund_ids)
    UNION ALL
    SELECT 'refund'::text, substr(l.idempotency_key, 8), l.tenant_id, t.id,
           (SELECT sum(e.amount_minor)::bigint FROM app.ledger_entries e
             WHERE e.tenant_id = l.tenant_id AND e.transaction_id = l.id AND e.direction = 'debit'),
           t.currency, t.status, t.provider_payment_id
      FROM app.topups t
      JOIN app.ledger_transactions l
        ON l.tenant_id = t.tenant_id
       AND l.idempotency_key = ANY (ARRAY(SELECT 'refund:' || x FROM unnest(p_refund_ids) AS x))
       AND l.reference_type = 'topup' AND l.reference_id = t.id::text
     WHERE t.provider_payment_id = ANY (p_refund_payment_ids)
    UNION ALL
    SELECT 'plan_payment'::text, p.provider_payment_id, p.tenant_id, p.subscription_id, p.amount_minor,
           p.currency, 'paid'::text, p.provider_payment_id
      FROM app.plan_payments p WHERE p.provider_payment_id = ANY (p_payment_ids || p_refund_payment_ids)
    UNION ALL
    SELECT 'plan_refund'::text, r.provider_refund_id, r.tenant_id, r.plan_payment_id, r.amount_minor,
           p.currency, r.status, p.provider_payment_id
      FROM app.plan_payment_refunds r
      JOIN app.plan_payments p ON p.tenant_id = r.tenant_id AND p.id = r.plan_payment_id
     WHERE r.provider_refund_id = ANY (p_refund_ids) AND r.status = 'processed';
END
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_recon_facts(text[], text[], text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_recon_facts(text[], text[], text[], text[]) TO w360_app;
ALTER FUNCTION ops.settlement_recon_facts(text[], text[], text[], text[]) OWNER TO w360_definer;
