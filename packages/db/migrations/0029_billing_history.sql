-- Billing history (P5-07, ADR-057): the payment method Razorpay reported for a credited top-up, shown
-- on its receipt. Statements and receipts are read from the existing ledger; nothing else is stored.

-- Razorpay's payment `method` (card, upi, netbanking, wallet, emi, ...) as reported in the fetched
-- payment. Not card data: card numbers are never stored.
ALTER TABLE app.topups
  ADD COLUMN payment_method text CHECK (payment_method ~ '^[a-z_]{1,32}$');

-- Records the method once, only on the top-up the same payment credited. Runtime code cannot update
-- a paid top-up (policy app_update_open), so this narrow definer function is the only way in.
CREATE FUNCTION app.billing_record_payment_method(p_topup_id uuid, p_payment_id text, p_method text)
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
  IF p_method IS NULL OR p_method !~ '^[a-z_]{1,32}$' THEN
    RAISE EXCEPTION 'invalid payment method' USING ERRCODE = 'W3412';
  END IF;
  UPDATE app.topups t
     SET payment_method = p_method
   WHERE t.tenant_id = v_tenant AND t.id = p_topup_id
     AND t.credited_transaction_id IS NOT NULL
     AND t.provider_payment_id = p_payment_id
     AND t.payment_method IS NULL;
  RETURN FOUND;
END
$$;
REVOKE EXECUTE ON FUNCTION app.billing_record_payment_method(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.billing_record_payment_method(uuid, text, text) TO w360_app;
ALTER FUNCTION app.billing_record_payment_method(uuid, text, text) OWNER TO w360_definer;
GRANT UPDATE (payment_method) ON app.topups TO w360_definer;

-- A new top-up carries no method: it comes only from the credited payment, through the function above.
ALTER POLICY app_insert_creating ON app.topups
  WITH CHECK (status = 'creating' AND provider_payment_id IS NULL AND paid_at IS NULL
              AND credited_transaction_id IS NULL AND refunded_minor = 0 AND payment_method IS NULL);
