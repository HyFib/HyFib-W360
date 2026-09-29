-- Paying for plans with Razorpay Subscriptions (P5-07, ADR-063).
--
-- A company pays for the plan version it is on, with its add-ons, through a Razorpay subscription.
-- HyFib records its subscription before calling Razorpay, follows the subscription as Razorpay
-- reports it (fetched, never taken from a browser or a webhook payload), records each paid invoice
-- once, and makes the company's plan state active for exactly the paid billing cycle through a
-- definer function.

-- Tax on plan prices ----------------------------------------------------------------------------------
-- Plan prices are entered before tax. Platform owners set the tax added to them, in basis points
-- (1800 = 18%); NULL: not set, and paying for plans is not offered.
ALTER TABLE ops.plan_settings
  ADD COLUMN plan_tax_bp integer CHECK (plan_tax_bp BETWEEN 0 AND 5000);
GRANT UPDATE (plan_tax_bp) ON ops.plan_settings TO w360_platform;
-- Companies read the rate to see what they would pay (nothing else of the settings).
GRANT SELECT (id, plan_tax_bp) ON ops.plan_settings TO w360_app;
CREATE POLICY app_read ON ops.plan_settings FOR SELECT TO w360_app USING (true);

-- Subscriptions -------------------------------------------------------------------------------------------
-- One row per subscription HyFib asked Razorpay for. `creating`: recorded before Razorpay answered;
-- `failed`: Razorpay refused or never answered (a subscription it created anyway can never be
-- authorised after `authorize_by`); the other states are Razorpay's (R-066). The amounts and add-ons
-- are fixed when the subscription starts, like the Razorpay plan made for them.
CREATE TABLE app.plan_subscriptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  plan_id uuid NOT NULL REFERENCES ops.plans (id),
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'created', 'authenticated',
    'active', 'pending', 'halted', 'paused', 'cancelled', 'completed', 'expired', 'failed')),
  interval_months smallint NOT NULL CHECK (interval_months IN (1, 3, 12)),
  extra_seats integer NOT NULL CHECK (extra_seats BETWEEN 0 AND 10000),
  extra_numbers integer NOT NULL CHECK (extra_numbers BETWEEN 0 AND 100),
  run_packs integer NOT NULL CHECK (run_packs BETWEEN 0 AND 10000),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor > 0),
  tax_bp integer NOT NULL CHECK (tax_bp BETWEEN 0 AND 5000),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  -- Razorpay's minimum payment is ₹1.
  amount_minor bigint NOT NULL CHECK (amount_minor >= 100),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  total_count smallint NOT NULL CHECK (total_count BETWEEN 1 AND 1200),
  provider_plan_id text CHECK (provider_plan_id ~ '^plan_[A-Za-z0-9]{1,40}$'),
  provider_subscription_id text CHECK (provider_subscription_id ~ '^sub_[A-Za-z0-9]{1,40}$'),
  -- `expire_by` sent to Razorpay: Checkout can authorise the subscription until then.
  authorize_by timestamptz NOT NULL,
  current_start timestamptz,
  current_end timestamptz,
  charge_at timestamptz,
  paid_count integer NOT NULL DEFAULT 0 CHECK (paid_count >= 0),
  ended_at timestamptz,
  -- Cancelled by the company at the end of the paid period (`cancel_at_cycle_end`).
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancel_requested_at timestamptz,
  cancelled_by_user_id text REFERENCES auth.users (id),
  failure_reason text CHECK (char_length(failure_reason) <= 500),
  created_by_user_id text NOT NULL REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_subscriptions_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT plan_subscriptions_amounts CHECK (amount_minor = subtotal_minor + tax_minor),
  CONSTRAINT plan_subscriptions_provider_ids CHECK (
    status IN ('creating', 'failed') OR (provider_plan_id IS NOT NULL AND provider_subscription_id IS NOT NULL)),
  CONSTRAINT plan_subscriptions_cycle CHECK (
    current_start IS NULL OR current_end IS NULL OR current_end > current_start),
  CONSTRAINT plan_subscriptions_cancel CHECK (NOT cancel_at_period_end OR cancel_requested_at IS NOT NULL)
);
-- At most one subscription per company that may still be authorised or charged.
CREATE UNIQUE INDEX plan_subscriptions_one_live_uq ON app.plan_subscriptions (tenant_id)
  WHERE status IN ('creating', 'created', 'authenticated', 'active', 'pending', 'halted', 'paused');
CREATE UNIQUE INDEX plan_subscriptions_provider_uq ON app.plan_subscriptions (provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;
CREATE INDEX plan_subscriptions_tenant_idx ON app.plan_subscriptions (tenant_id, created_at DESC);
CREATE TRIGGER plan_subscriptions_touch BEFORE UPDATE ON app.plan_subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER plan_subscriptions_no_delete BEFORE DELETE ON app.plan_subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
SELECT ops.apply_tenant_rls('app.plan_subscriptions');

-- The company's owners and billing managers start and cancel (the web, in the company's scope); the
-- worker follows Razorpay. Amounts, add-ons, the plan and who started it never change.
GRANT SELECT, INSERT ON app.plan_subscriptions TO w360_app;
GRANT UPDATE (status, provider_plan_id, provider_subscription_id, current_start, current_end,
  charge_at, paid_count, ended_at, cancel_at_period_end, cancel_requested_at, cancelled_by_user_id,
  failure_reason, synced_at, updated_at)
  ON app.plan_subscriptions TO w360_app;
-- Platform staff see subscriptions and cancel one at once (after Razorpay confirmed it).
CREATE POLICY platform_read ON app.plan_subscriptions FOR SELECT TO w360_platform USING (true);
CREATE POLICY platform_update ON app.plan_subscriptions FOR UPDATE TO w360_platform
  USING (true) WITH CHECK (status = 'cancelled');
GRANT SELECT ON app.plan_subscriptions TO w360_platform;
GRANT UPDATE (status, ended_at, cancel_requested_at, cancelled_by_user_id, updated_at)
  ON app.plan_subscriptions TO w360_platform;
CREATE POLICY definer_read ON app.plan_subscriptions FOR SELECT TO w360_definer USING (true);
GRANT SELECT ON app.plan_subscriptions TO w360_definer;

-- Plan payments -------------------------------------------------------------------------------------------
-- One row per paid Razorpay invoice of a subscription: the charge and the billing cycle it paid for,
-- as Razorpay reported them. Append-only billing records, kept when a company is deleted.
CREATE TABLE app.plan_payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  subscription_id uuid NOT NULL,
  provider_payment_id text NOT NULL CHECK (provider_payment_id ~ '^pay_[A-Za-z0-9]{1,40}$'),
  provider_invoice_id text NOT NULL CHECK (provider_invoice_id ~ '^inv_[A-Za-z0-9]{1,40}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency = 'INR'),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  paid_at timestamptz NOT NULL,
  method text CHECK (method ~ '^[a-z_]{1,32}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_payments_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT plan_payments_subscription_fk FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES app.plan_subscriptions (tenant_id, id),
  CONSTRAINT plan_payments_period CHECK (period_end > period_start)
);
CREATE UNIQUE INDEX plan_payments_payment_uq ON app.plan_payments (provider_payment_id);
CREATE UNIQUE INDEX plan_payments_invoice_uq ON app.plan_payments (provider_invoice_id);
CREATE INDEX plan_payments_subscription_idx ON app.plan_payments (tenant_id, subscription_id, period_start);
CREATE INDEX plan_payments_tenant_idx ON app.plan_payments (tenant_id, paid_at DESC);
CREATE TRIGGER plan_payments_append_only BEFORE UPDATE OR DELETE ON app.plan_payments
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
SELECT ops.apply_tenant_rls('app.plan_payments');
GRANT SELECT, INSERT ON app.plan_payments TO w360_app;
CREATE POLICY platform_read ON app.plan_payments FOR SELECT TO w360_platform USING (true);
GRANT SELECT ON app.plan_payments TO w360_platform;
CREATE POLICY definer_read ON app.plan_payments FOR SELECT TO w360_definer USING (true);
GRANT SELECT ON app.plan_payments TO w360_definer;

-- The plan state names the subscription that paid its current period (NULL for periods staff set).
ALTER TABLE app.tenant_plans ADD COLUMN subscription_id uuid;
ALTER TABLE app.tenant_plans ADD CONSTRAINT tenant_plans_subscription_fk
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES app.plan_subscriptions (tenant_id, id);
GRANT UPDATE (subscription_id) ON app.tenant_plans TO w360_platform;

-- Finding a subscription's company ---------------------------------------------------------------------
-- A Razorpay subscription id resolves to the company that asked for it (ids only), like
-- ops.billing_resolve_order for orders.
CREATE FUNCTION ops.billing_resolve_subscription(p_provider_subscription_id text)
  RETURNS TABLE (tenant_id uuid, subscription_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, s.id FROM app.plan_subscriptions s
   WHERE s.provider_subscription_id = p_provider_subscription_id
$$;
REVOKE EXECUTE ON FUNCTION ops.billing_resolve_subscription(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.billing_resolve_subscription(text) TO w360_app;
ALTER FUNCTION ops.billing_resolve_subscription(text) OWNER TO w360_definer;

-- A Razorpay payment id resolves to the plan payment that recorded it (for the settlement check).
CREATE FUNCTION ops.billing_resolve_plan_payment(p_provider_payment_id text)
  RETURNS TABLE (tenant_id uuid, plan_payment_id uuid, subscription_id uuid, amount_minor bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT p.tenant_id, p.id, p.subscription_id, p.amount_minor FROM app.plan_payments p
   WHERE p.provider_payment_id = p_provider_payment_id
$$;
REVOKE EXECUTE ON FUNCTION ops.billing_resolve_plan_payment(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.billing_resolve_plan_payment(text) TO w360_app;
ALTER FUNCTION ops.billing_resolve_plan_payment(text) OWNER TO w360_definer;

-- A paid billing cycle makes the plan active ---------------------------------------------------------------
-- In the company's own scope: when the subscription is active and a recorded payment paid its
-- current cycle, the plan state becomes active for exactly that cycle and names the subscription.
-- A payment paid the cycle when the middle of the invoice's billing period falls within it: invoice
-- periods may be aligned to days while cycles are exact times, and the middle of the previous
-- cycle's invoice is far outside the current cycle.
-- Refused when the subscription is for another plan version or other add-ons than the plan state
-- (staff changed the plan), and unchanged when the plan state already has that period. A new paid
-- period restarts the monthly usage period, as when staff set one (ADR-051). Recorded in the
-- company's audit log. Returns 'applied', 'unchanged', 'not_paid' or 'mismatch'.
CREATE FUNCTION app.apply_plan_subscription_period(p_tenant_id uuid, p_subscription_id uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v app.tenant_plans%ROWTYPE;
  s app.plan_subscriptions%ROWTYPE;
BEGIN
  IF app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'plan periods are applied in the company''s own scope' USING ERRCODE = 'W3403';
  END IF;
  -- The company row first, then its plan state: the order the sweep and staff changes lock them in.
  PERFORM 1 FROM app.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
  SELECT * INTO v FROM app.tenant_plans tp WHERE tp.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The company has no plan state.' USING ERRCODE = 'W3404';
  END IF;
  SELECT * INTO s FROM app.plan_subscriptions ps
   WHERE ps.tenant_id = p_tenant_id AND ps.id = p_subscription_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Subscription not found.' USING ERRCODE = 'W3404';
  END IF;
  IF s.status <> 'active' OR s.current_start IS NULL OR s.current_end IS NULL OR NOT EXISTS (
       SELECT 1 FROM app.plan_payments p
        WHERE p.tenant_id = p_tenant_id AND p.subscription_id = s.id
          AND p.period_start + (p.period_end - p.period_start) / 2
              BETWEEN s.current_start AND s.current_end) THEN
    RETURN 'not_paid';
  END IF;
  IF v.plan_id IS DISTINCT FROM s.plan_id OR v.extra_seats <> s.extra_seats
     OR v.extra_numbers <> s.extra_numbers OR v.run_packs <> s.run_packs THEN
    RETURN 'mismatch';
  END IF;
  IF v.status = 'active' AND v.subscription_id IS NOT DISTINCT FROM s.id
     AND v.period_start = s.current_start AND v.period_end = s.current_end THEN
    RETURN 'unchanged';
  END IF;
  UPDATE app.tenant_plans
     SET status = 'active',
         trial_ends_at = NULL,
         period_start = s.current_start,
         period_end = s.current_end,
         grace_ends_at = NULL,
         subscription_id = s.id,
         usage_anchor = CASE WHEN v.status IN ('active', 'past_due')
                              AND v.period_start = s.current_start
                             THEN v.usage_anchor ELSE s.current_start END,
         note = 'Paid by subscription through Razorpay.',
         changed_by_user_id = NULL, changed_at = now(), version = v.version + 1
   WHERE id = v.id;
  INSERT INTO app.audit_events (tenant_id, actor_type, actor_id, action, subject_type, subject_id, result,
                                metadata)
  VALUES (p_tenant_id, 'system', NULL, 'plan.subscription_period', 'tenant_plan', v.id::text, 'success',
          jsonb_build_object('previous_status', v.status, 'plan_id', s.plan_id,
                             'subscription_id', s.id, 'period_start', s.current_start,
                             'period_end', s.current_end));
  RETURN 'applied';
END
$$;
REVOKE EXECUTE ON FUNCTION app.apply_plan_subscription_period(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_plan_subscription_period(uuid, uuid) TO w360_app;
ALTER FUNCTION app.apply_plan_subscription_period(uuid, uuid) OWNER TO w360_definer;

-- Time moves plan states on: a cancelled subscription ends the plan --------------------------------------
-- As in 0023, except that a paid period paid by a subscription the company cancelled (at the end of
-- the period) or that ended ends as canceled, without grace days: no payment is coming. The owner
-- drops the function and the migration role recreates it (see the note in 0011).
SET ROLE w360_definer;
DROP FUNCTION app.apply_plan_transition(uuid);
RESET ROLE;
CREATE FUNCTION app.apply_plan_transition(p_tenant_id uuid)
  RETURNS TABLE (previous_status text, new_status text, plan_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v app.tenant_plans%ROWTYPE;
  v_grace smallint;
  v_new text;
  v_note text;
  v_sub_status text;
  v_sub_cancel boolean := false;
BEGIN
  IF app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'plan transitions run in the company''s own scope' USING ERRCODE = 'W3403';
  END IF;
  -- The company row first, then its plan state: the order platform changes lock them in.
  PERFORM 1 FROM app.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
  SELECT * INTO v FROM app.tenant_plans tp WHERE tp.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v.status = 'trialing' AND v.trial_ends_at <= now() THEN
    v_new := 'expired';
    v_note := 'The trial ended.';
  ELSIF v.status = 'active' AND v.period_end <= now() THEN
    IF v.subscription_id IS NOT NULL THEN
      SELECT s.status, s.cancel_at_period_end INTO v_sub_status, v_sub_cancel
        FROM app.plan_subscriptions s
       WHERE s.tenant_id = p_tenant_id AND s.id = v.subscription_id;
    END IF;
    IF coalesce(v_sub_cancel, false) OR v_sub_status IN ('cancelled', 'completed', 'expired') THEN
      v_new := 'canceled';
      v_note := CASE WHEN v_sub_status = 'completed' THEN 'The subscription ended.'
                     ELSE 'The subscription was cancelled.' END;
    ELSE
      SELECT p.grace_days INTO v_grace FROM ops.plans p WHERE p.id = v.plan_id;
      v_new := CASE WHEN v.period_end + make_interval(days => coalesce(v_grace, 0)) > now()
                    THEN 'past_due' ELSE 'expired' END;
      v_note := 'The paid period ended.';
    END IF;
  ELSIF v.status = 'past_due' AND v.grace_ends_at <= now() THEN
    v_new := 'expired';
    v_note := 'The grace period ended.';
  ELSE
    RETURN;
  END IF;
  UPDATE app.tenant_plans
     SET status = v_new,
         grace_ends_at = CASE WHEN v_new = 'past_due'
                              THEN v.period_end + make_interval(days => coalesce(v_grace, 0)) END,
         note = v_note,
         changed_by_user_id = NULL, changed_at = now(), version = v.version + 1
   WHERE id = v.id;
  INSERT INTO app.audit_events (tenant_id, actor_type, actor_id, action, subject_type, subject_id, result,
                                metadata)
  VALUES (p_tenant_id, 'system', NULL, 'plan.' || v_new, 'tenant_plan', v.id::text, 'success',
          jsonb_build_object('previous_status', v.status, 'plan_id', v.plan_id,
                             'subscription_id', v.subscription_id));
  RETURN QUERY SELECT v.status, v_new, v.plan_id;
END
$$;
REVOKE EXECUTE ON FUNCTION app.apply_plan_transition(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_plan_transition(uuid) TO w360_app;
ALTER FUNCTION app.apply_plan_transition(uuid) OWNER TO w360_definer;

-- Subscriptions to check with Razorpay (minute sweep) -------------------------------------------------------
-- Ids only, for the worker: subscriptions recorded but never created at Razorpay (after 10 minutes),
-- unpaid ones whose authorisation window closed, and those that may still be charged: at least
-- daily, and after their billing cycle ended until a new one starts (hourly; daily once Razorpay
-- stopped retrying). A backstop for missed webhooks. Deleted companies are left out.
CREATE FUNCTION ops.plan_subscriptions_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, subscription_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, s.id FROM app.plan_subscriptions s
    JOIN app.tenants t ON t.id = s.tenant_id
   WHERE t.status <> 'deleted'
     AND ((s.status = 'creating' AND s.created_at < now() - interval '10 minutes')
       OR (s.status = 'created' AND s.authorize_by < now())
       OR (s.status IN ('authenticated', 'active', 'pending', 'halted', 'paused')
           AND (s.synced_at IS NULL OR s.synced_at < now() - interval '1 day'
                OR (s.current_end < now() AND s.status <> 'halted'
                    AND s.synced_at < greatest(s.current_end, now() - interval '1 hour')))))
   ORDER BY coalesce(s.synced_at, s.created_at)
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000)
$$;
REVOKE EXECUTE ON FUNCTION ops.plan_subscriptions_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.plan_subscriptions_due(integer) TO w360_app;
ALTER FUNCTION ops.plan_subscriptions_due(integer) OWNER TO w360_definer;

-- The daily settlement reconciliation knows plan payments (ADR-059) ------------------------------------------
-- A settled payment HyFib recorded as a plan payment matches it; a settled subscription payment it
-- had not recorded is recorded by syncing the subscription (or waits for a person when the sync
-- does not record it); a refund of a plan payment waits for a person (HyFib does not refund them).
ALTER TABLE ops.settlement_recon_items DROP CONSTRAINT settlement_recon_items_reason_chk;
ALTER TABLE ops.settlement_recon_items ADD CONSTRAINT settlement_recon_items_reason_chk CHECK (
    (status = 'matched' AND (reason IS NULL OR reason IN ('mandate_authorization', 'uncredited_payment_refund',
      'plan_payment')))
    OR (status = 'recorded' AND reason IN ('credited', 'refund_recorded', 'plan_payment_recorded'))
    OR (status = 'mismatch' AND reason IN ('amount_differs', 'second_payment', 'not_captured',
          'mandate_payment', 'refund_not_processed', 'refund_exceeds_payment', 'payment_unavailable',
          'refund_unavailable', 'plan_payment_unrecorded'))
    OR (status = 'review' AND reason IN ('adjustment', 'dispute', 'unknown_type', 'currency', 'unreadable',
          'plan_payment_refund'))
    OR (status = 'not_hyfib' AND reason IN ('unknown_payment', 'unknown_refund', 'transfer')));

-- As in 0034, with plan payments (by payment id, also for refunds of them).
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
      FROM app.plan_payments p WHERE p.provider_payment_id = ANY (p_payment_ids || p_refund_payment_ids);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_recon_facts(text[], text[], text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_recon_facts(text[], text[], text[], text[]) TO w360_app;
ALTER FUNCTION ops.settlement_recon_facts(text[], text[], text[], text[]) OWNER TO w360_definer;

-- Deleting a company cancels its subscription at Razorpay (ADR-055) ------------------------------------------
-- As in 0028, with the outcome of cancelling the plan subscription.
SET ROLE w360_definer;
DROP FUNCTION ops.record_tenant_deletion_cleanup(uuid, jsonb);
RESET ROLE;
CREATE FUNCTION ops.record_tenant_deletion_cleanup(p_tenant_id uuid, p_items jsonb) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 200
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) e
        WHERE jsonb_typeof(e) <> 'object'
           OR NOT (e->>'kind' IN ('whatsapp_account', 'shopify_store', 'woocommerce_store', 'card_mandate',
                                  'plan_subscription'))
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
