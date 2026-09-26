-- 0004_billing: prepaid INR service-credit wallet on an append-only double-entry ledger, manual card
-- top-ups (Razorpay Orders), and the opt-in auto-recharge state machine (Razorpay card mandates).
--
-- Money is integer paise (bigint). Runtime code never writes ledger rows or balances: every posting
-- goes through a SECURITY DEFINER function that enforces the business rule for that posting
-- (credit only a verified captured payment, exactly once; holds only against available credit;
-- one active auto-recharge attempt per wallet within caps that count pending attempts). A deferred
-- constraint trigger rejects any unbalanced transaction at commit, and balances are maintained by
-- trigger from the entries. In the default direct-Meta billing mode the wallet never funds Meta
-- messaging (ADR-011).

-- Wallets and ledger ------------------------------------------------------------------------------
CREATE TABLE app.wallets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT wallets_tenant_uq UNIQUE (tenant_id)
);

-- Accounts per wallet. `balance_minor` is kept on the account's normal side:
--   wallet_available, wallet_held, service_revenue, refunds_payable: credit-normal (liability/income)
--   payment_clearing, dispute_losses: debit-normal (asset/expense)
CREATE TABLE app.ledger_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  code text NOT NULL CHECK (code IN ('wallet_available', 'wallet_held', 'payment_clearing',
    'service_revenue', 'dispute_losses')),
  normal_side text NOT NULL CHECK (normal_side IN ('debit', 'credit')),
  balance_minor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT ledger_accounts_wallet_code_uq UNIQUE (tenant_id, wallet_id, code),
  CONSTRAINT ledger_accounts_wallet_fk FOREIGN KEY (tenant_id, wallet_id) REFERENCES app.wallets (tenant_id, id),
  CONSTRAINT ledger_accounts_held_non_negative CHECK (code <> 'wallet_held' OR balance_minor >= 0)
);

CREATE TABLE app.ledger_transactions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('topup_credit', 'hold', 'hold_release', 'hold_settle', 'refund',
    'dispute_loss')),
  -- One posting per business event (e.g. "topup:<id>", "refund:<provider refund id>").
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  reference_type text CHECK (char_length(reference_type) <= 64),
  reference_id text CHECK (char_length(reference_id) <= 200),
  description text CHECK (char_length(description) <= 500),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system', 'provider')),
  actor_id text CHECK (char_length(actor_id) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_transactions_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT ledger_transactions_idempotency_uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT ledger_transactions_wallet_fk FOREIGN KEY (tenant_id, wallet_id) REFERENCES app.wallets (tenant_id, id)
);
CREATE INDEX ledger_transactions_wallet_time_idx ON app.ledger_transactions (tenant_id, wallet_id, created_at DESC, id);
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON app.ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

CREATE TABLE app.ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  account_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entries_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT ledger_entries_transaction_fk FOREIGN KEY (tenant_id, transaction_id)
    REFERENCES app.ledger_transactions (tenant_id, id),
  CONSTRAINT ledger_entries_account_fk FOREIGN KEY (tenant_id, account_id) REFERENCES app.ledger_accounts (tenant_id, id)
);
CREATE INDEX ledger_entries_transaction_idx ON app.ledger_entries (tenant_id, transaction_id);
CREATE INDEX ledger_entries_account_idx ON app.ledger_entries (tenant_id, account_id, id);
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON app.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Balance maintenance: every entry moves its account's balance on the normal side.
CREATE FUNCTION app.apply_ledger_entry() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  UPDATE app.ledger_accounts a
     SET balance_minor = a.balance_minor
       + CASE WHEN NEW.direction = a.normal_side THEN NEW.amount_minor ELSE -NEW.amount_minor END
   WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger account % not found', NEW.account_id USING ERRCODE = 'W3404';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER ledger_entries_apply AFTER INSERT ON app.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.apply_ledger_entry();

-- Balance invariant, checked at commit: at least two entries and debits equal credits.
CREATE FUNCTION app.assert_ledger_transaction_balanced() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_transaction uuid;
  v_debits bigint;
  v_credits bigint;
  v_count integer;
BEGIN
  -- Separate statements: PL/pgSQL prepares each lazily, so the other table's column is never parsed.
  IF TG_TABLE_NAME = 'ledger_entries' THEN
    v_transaction := NEW.transaction_id;
  ELSE
    v_transaction := NEW.id;
  END IF;
  SELECT coalesce(sum(e.amount_minor) FILTER (WHERE e.direction = 'debit'), 0),
         coalesce(sum(e.amount_minor) FILTER (WHERE e.direction = 'credit'), 0),
         count(*)
    INTO v_debits, v_credits, v_count
    FROM app.ledger_entries e
   WHERE e.tenant_id = NEW.tenant_id AND e.transaction_id = v_transaction;
  IF v_count < 2 OR v_debits <> v_credits THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (debits %, credits %, entries %)',
      v_transaction, v_debits, v_credits, v_count USING ERRCODE = 'W3412';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON app.ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assert_ledger_transaction_balanced();
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced AFTER INSERT ON app.ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assert_ledger_transaction_balanced();

-- Holds (reservations) against available credit -------------------------------------------------
CREATE TABLE app.wallet_holds (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  settled_minor bigint CHECK (settled_minor >= 0),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'settled', 'released')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  reference_type text NOT NULL CHECK (char_length(reference_type) BETWEEN 1 AND 64),
  reference_id text NOT NULL CHECK (char_length(reference_id) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT wallet_holds_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT wallet_holds_idempotency_uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT wallet_holds_wallet_fk FOREIGN KEY (tenant_id, wallet_id) REFERENCES app.wallets (tenant_id, id),
  CONSTRAINT wallet_holds_settled_le_amount CHECK (settled_minor IS NULL OR settled_minor <= amount_minor)
);
CREATE INDEX wallet_holds_open_idx ON app.wallet_holds (expires_at) WHERE status = 'held';

-- Payment provider customers and card mandates ----------------------------------------------------
CREATE TABLE app.billing_customers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  provider text NOT NULL DEFAULT 'razorpay' CHECK (provider IN ('razorpay')),
  provider_customer_id text NOT NULL CHECK (provider_customer_id ~ '^cust_[A-Za-z0-9]{1,40}$'),
  -- Billing contact the provider requires for merchant-initiated charges (R-039).
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 64),
  contact text NOT NULL CHECK (contact ~ '^\+?[0-9]{8,15}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_customers_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT billing_customers_tenant_provider_uq UNIQUE (tenant_id, provider)
);

-- Only provider references and safe card metadata (network, issuer, last four digits, expiry) are
-- stored; never the card number or CVV.
CREATE TABLE app.payment_mandates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'razorpay' CHECK (provider IN ('razorpay')),
  billing_customer_id uuid NOT NULL,
  authorization_order_id text CHECK (authorization_order_id ~ '^order_[A-Za-z0-9]{1,40}$'),
  -- The card authorisation charge (R-035) is refunded once the mandate is confirmed; it never
  -- becomes service credit.
  authorization_payment_id text CHECK (authorization_payment_id ~ '^pay_[A-Za-z0-9]{1,40}$'),
  authorization_refund_id text CHECK (authorization_refund_id ~ '^rfnd_[A-Za-z0-9]{1,40}$'),
  provider_token_id text CHECK (provider_token_id ~ '^token_[A-Za-z0-9]{1,40}$'),
  status text NOT NULL DEFAULT 'pending_authorization'
    CHECK (status IN ('pending_authorization', 'active', 'rejected', 'cancelled', 'paused', 'expired')),
  max_amount_minor bigint NOT NULL CHECK (max_amount_minor BETWEEN 100 AND 1500000),
  card_network text CHECK (char_length(card_network) <= 32),
  card_issuer text CHECK (char_length(card_issuer) <= 64),
  card_last4 text CHECK (card_last4 ~ '^[0-9]{4}$'),
  card_expiry_month smallint CHECK (card_expiry_month BETWEEN 1 AND 12),
  card_expiry_year smallint CHECK (card_expiry_year BETWEEN 2000 AND 2100),
  created_by_user_id text REFERENCES auth.users (id),
  confirmed_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_mandates_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT payment_mandates_customer_fk FOREIGN KEY (tenant_id, billing_customer_id)
    REFERENCES app.billing_customers (tenant_id, id),
  CONSTRAINT payment_mandates_active_has_token CHECK (status <> 'active' OR provider_token_id IS NOT NULL)
);
CREATE UNIQUE INDEX payment_mandates_token_uq ON app.payment_mandates (tenant_id, provider_token_id)
  WHERE provider_token_id IS NOT NULL;
CREATE UNIQUE INDEX payment_mandates_auth_order_uq ON app.payment_mandates (authorization_order_id)
  WHERE authorization_order_id IS NOT NULL;
CREATE TRIGGER payment_mandates_touch BEFORE UPDATE ON app.payment_mandates
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Auto-recharge settings (one row per company; disabled by default) ------------------------------
CREATE TABLE app.auto_recharge_settings (
  tenant_id uuid PRIMARY KEY REFERENCES app.tenants (id),
  enabled boolean NOT NULL DEFAULT false,
  mandate_id uuid,
  threshold_minor bigint NOT NULL CHECK (threshold_minor BETWEEN 0 AND 100000000),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 10000 AND 1500000),
  daily_cap_minor bigint NOT NULL,
  monthly_cap_minor bigint NOT NULL,
  updated_by_user_id text REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auto_recharge_settings_mandate_fk FOREIGN KEY (tenant_id, mandate_id)
    REFERENCES app.payment_mandates (tenant_id, id),
  CONSTRAINT auto_recharge_settings_enabled_needs_mandate CHECK (NOT enabled OR mandate_id IS NOT NULL),
  CONSTRAINT auto_recharge_settings_caps CHECK (daily_cap_minor >= amount_minor AND monthly_cap_minor >= daily_cap_minor)
);
CREATE TRIGGER auto_recharge_settings_touch BEFORE UPDATE ON app.auto_recharge_settings
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Top-ups (manual checkout or auto-recharge charge) -----------------------------------------------
-- creating → awaiting_payment → paid → partially_refunded / refunded
-- creating / awaiting_payment → failed / expired (a late capture still moves them to paid)
CREATE TABLE app.topups (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('manual', 'auto_recharge')),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 100 AND 10000000),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status text NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'awaiting_payment', 'paid', 'partially_refunded', 'refunded', 'failed', 'expired')),
  receipt text NOT NULL CHECK (receipt ~ '^[A-Za-z0-9_-]{1,40}$'),
  provider_order_id text CHECK (provider_order_id ~ '^order_[A-Za-z0-9]{1,40}$'),
  provider_payment_id text CHECK (provider_payment_id ~ '^pay_[A-Za-z0-9]{1,40}$'),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  failure_reason text CHECK (char_length(failure_reason) <= 500),
  credited_transaction_id uuid,
  created_by_user_id text REFERENCES auth.users (id),
  -- Next provider check for an open manual top-up (missed-webhook backstop, backing off with age).
  next_check_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topups_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT topups_wallet_fk FOREIGN KEY (tenant_id, wallet_id) REFERENCES app.wallets (tenant_id, id),
  CONSTRAINT topups_credit_fk FOREIGN KEY (tenant_id, credited_transaction_id)
    REFERENCES app.ledger_transactions (tenant_id, id),
  CONSTRAINT topups_paid_is_credited CHECK (
    (status IN ('paid', 'partially_refunded', 'refunded')) = (credited_transaction_id IS NOT NULL)),
  CONSTRAINT topups_refund_le_amount CHECK (refunded_minor <= amount_minor)
);
CREATE UNIQUE INDEX topups_receipt_uq ON app.topups (receipt);
CREATE UNIQUE INDEX topups_order_uq ON app.topups (provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX topups_payment_uq ON app.topups (provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX topups_wallet_time_idx ON app.topups (tenant_id, created_at DESC);
CREATE INDEX topups_open_idx ON app.topups (next_check_at) WHERE status IN ('creating', 'awaiting_payment');
CREATE TRIGGER topups_touch BEFORE UPDATE ON app.topups FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Auto-recharge attempts ------------------------------------------------------------------------
-- scheduled → order_created → payment_requested → succeeded (credited) / failed
-- any provider call whose outcome is unknown → unknown (reconciled by receipt before any retry)
-- scheduled / order_created → canceled (settings disabled or mandate ended before a debit request)
CREATE TABLE app.auto_recharge_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  mandate_id uuid NOT NULL,
  topup_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 100 AND 1500000),
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'order_created', 'payment_requested', 'unknown', 'succeeded', 'failed', 'canceled')),
  unknown_step text CHECK (unknown_step IN ('create_order', 'request_payment')),
  last_error text CHECK (char_length(last_error) <= 500),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  payment_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT auto_recharge_attempts_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT auto_recharge_attempts_wallet_fk FOREIGN KEY (tenant_id, wallet_id) REFERENCES app.wallets (tenant_id, id),
  CONSTRAINT auto_recharge_attempts_mandate_fk FOREIGN KEY (tenant_id, mandate_id)
    REFERENCES app.payment_mandates (tenant_id, id),
  CONSTRAINT auto_recharge_attempts_topup_fk FOREIGN KEY (tenant_id, topup_id) REFERENCES app.topups (tenant_id, id),
  CONSTRAINT auto_recharge_attempts_topup_uq UNIQUE (tenant_id, topup_id),
  CONSTRAINT auto_recharge_attempts_unknown_step CHECK ((status = 'unknown') = (unknown_step IS NOT NULL))
);
-- At most one attempt in flight per wallet, enforced by the database.
CREATE UNIQUE INDEX auto_recharge_attempts_one_active_uq ON app.auto_recharge_attempts (tenant_id, wallet_id)
  WHERE status IN ('scheduled', 'order_created', 'payment_requested', 'unknown');
CREATE INDEX auto_recharge_attempts_due_idx ON app.auto_recharge_attempts (next_check_at)
  WHERE status IN ('scheduled', 'order_created', 'payment_requested', 'unknown');
CREATE TRIGGER auto_recharge_attempts_touch BEFORE UPDATE ON app.auto_recharge_attempts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Row level security ----------------------------------------------------------------------------
SELECT ops.apply_tenant_rls('app.wallets');
SELECT ops.apply_tenant_rls('app.ledger_accounts');
SELECT ops.apply_tenant_rls('app.ledger_transactions');
SELECT ops.apply_tenant_rls('app.ledger_entries');
SELECT ops.apply_tenant_rls('app.wallet_holds');
SELECT ops.apply_tenant_rls('app.billing_customers');
SELECT ops.apply_tenant_rls('app.payment_mandates');
SELECT ops.apply_tenant_rls('app.auto_recharge_settings');
SELECT ops.apply_tenant_rls('app.topups');
SELECT ops.apply_tenant_rls('app.auto_recharge_attempts');

-- Runtime code may create a top-up only in `creating`, and may only move open top-ups between
-- non-credited states; `paid` and refunds are reachable only through the definer functions below.
CREATE POLICY app_insert_creating ON app.topups AS RESTRICTIVE FOR INSERT TO w360_app
  WITH CHECK (status = 'creating' AND provider_payment_id IS NULL AND paid_at IS NULL
              AND credited_transaction_id IS NULL AND refunded_minor = 0);
CREATE POLICY app_update_open ON app.topups AS RESTRICTIVE FOR UPDATE TO w360_app
  USING (status IN ('creating', 'awaiting_payment', 'failed', 'expired'))
  WITH CHECK (status IN ('awaiting_payment', 'failed', 'expired'));
-- Attempts are created only by app.billing_begin_auto_recharge; runtime code may advance them but
-- never mark them succeeded (that happens with the credit).
CREATE POLICY app_update_in_flight ON app.auto_recharge_attempts AS RESTRICTIVE FOR UPDATE TO w360_app
  USING (status IN ('scheduled', 'order_created', 'payment_requested', 'unknown'))
  WITH CHECK (status IN ('scheduled', 'order_created', 'payment_requested', 'unknown', 'failed', 'canceled'));

-- Platform metadata for billing support (no card data beyond what is stored).
SELECT ops.apply_support_read('app.wallets', 'billing.read');
SELECT ops.apply_support_read('app.ledger_accounts', 'billing.read');
SELECT ops.apply_support_read('app.ledger_transactions', 'billing.read');
SELECT ops.apply_support_read('app.topups', 'billing.read');
SELECT ops.apply_support_read('app.auto_recharge_attempts', 'billing.read');

-- Privileges --------------------------------------------------------------------------------------
GRANT SELECT ON app.wallets, app.ledger_accounts, app.ledger_transactions, app.ledger_entries,
  app.wallet_holds, app.billing_customers, app.payment_mandates, app.auto_recharge_settings,
  app.topups, app.auto_recharge_attempts TO w360_app;
GRANT INSERT ON app.billing_customers TO w360_app;
GRANT UPDATE (email, contact) ON app.billing_customers TO w360_app;
GRANT INSERT ON app.payment_mandates TO w360_app;
GRANT UPDATE (authorization_order_id, authorization_payment_id, authorization_refund_id, provider_token_id,
  status, card_network, card_issuer, card_last4, card_expiry_month, card_expiry_year, confirmed_at, ended_at,
  updated_at) ON app.payment_mandates TO w360_app;
GRANT INSERT ON app.auto_recharge_settings TO w360_app;
GRANT UPDATE (enabled, mandate_id, threshold_minor, amount_minor, daily_cap_minor, monthly_cap_minor,
  updated_by_user_id, updated_at) ON app.auto_recharge_settings TO w360_app;
GRANT INSERT ON app.topups TO w360_app;
GRANT UPDATE (provider_order_id, status, failure_reason, next_check_at, updated_at) ON app.topups TO w360_app;
GRANT UPDATE (status, unknown_step, last_error, next_check_at, payment_requested_at, updated_at, resolved_at)
  ON app.auto_recharge_attempts TO w360_app;
GRANT SELECT ON app.wallets, app.ledger_accounts, app.ledger_transactions, app.topups,
  app.auto_recharge_attempts TO w360_platform;

-- The definer role maintains the ledger.
CREATE POLICY definer_all ON app.wallets TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.ledger_accounts TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.ledger_transactions TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.ledger_entries TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.wallet_holds TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.topups TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.auto_recharge_attempts TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read ON app.auto_recharge_settings FOR SELECT TO w360_definer USING (true);
CREATE POLICY definer_read ON app.payment_mandates FOR SELECT TO w360_definer USING (true);
GRANT SELECT, INSERT ON app.wallets, app.ledger_accounts, app.ledger_transactions, app.ledger_entries TO w360_definer;
GRANT UPDATE (balance_minor) ON app.ledger_accounts TO w360_definer;
GRANT SELECT, INSERT ON app.wallet_holds TO w360_definer;
GRANT UPDATE (status, settled_minor, resolved_at) ON app.wallet_holds TO w360_definer;
GRANT SELECT, INSERT ON app.topups TO w360_definer;
GRANT UPDATE (status, provider_payment_id, refunded_minor, credited_transaction_id, paid_at, failure_reason, updated_at)
  ON app.topups TO w360_definer;
GRANT SELECT, INSERT ON app.auto_recharge_attempts TO w360_definer;
GRANT UPDATE (status, unknown_step, resolved_at, updated_at) ON app.auto_recharge_attempts TO w360_definer;
GRANT SELECT ON app.auto_recharge_settings, app.payment_mandates TO w360_definer;

-- Posting primitive (internal to the definer functions; not granted to any runtime role) ---------
-- p_lines: [{"account": "<code>", "direction": "debit"|"credit", "amount": <paise>}, ...]
CREATE FUNCTION app.ledger_post(
  p_tenant uuid, p_wallet uuid, p_kind text, p_key text, p_reference_type text, p_reference_id text,
  p_description text, p_actor_type text, p_actor_id text, p_lines jsonb
) RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_existing uuid;
  v_id uuid := gen_random_uuid();
  v_line jsonb;
  v_account uuid;
BEGIN
  SELECT t.id INTO v_existing FROM app.ledger_transactions t
   WHERE t.tenant_id = p_tenant AND t.idempotency_key = p_key;
  IF FOUND THEN
    RETURN v_existing;
  END IF;
  INSERT INTO app.ledger_transactions (id, tenant_id, wallet_id, kind, idempotency_key, reference_type,
    reference_id, description, actor_type, actor_id)
  VALUES (v_id, p_tenant, p_wallet, p_kind, p_key, p_reference_type, p_reference_id, p_description,
    p_actor_type, p_actor_id);
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    SELECT a.id INTO v_account FROM app.ledger_accounts a
     WHERE a.tenant_id = p_tenant AND a.wallet_id = p_wallet AND a.code = v_line->>'account';
    IF v_account IS NULL THEN
      RAISE EXCEPTION 'unknown ledger account %', v_line->>'account' USING ERRCODE = 'W3404';
    END IF;
    INSERT INTO app.ledger_entries (tenant_id, transaction_id, account_id, direction, amount_minor)
    VALUES (p_tenant, v_id, v_account, v_line->>'direction', (v_line->>'amount')::bigint);
  END LOOP;
  RETURN v_id;
END
$$;
ALTER FUNCTION app.ledger_post(uuid, uuid, text, text, text, text, text, text, text, jsonb) OWNER TO w360_definer;

-- Company wallet (created on first use with its accounts) ---------------------------------------
CREATE FUNCTION app.billing_ensure_wallet() RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_wallet uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  SELECT w.id INTO v_wallet FROM app.wallets w WHERE w.tenant_id = v_tenant;
  IF FOUND THEN
    RETURN v_wallet;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('w360:wallet:' || v_tenant::text, 0));
  SELECT w.id INTO v_wallet FROM app.wallets w WHERE w.tenant_id = v_tenant;
  IF FOUND THEN
    RETURN v_wallet;
  END IF;
  v_wallet := gen_random_uuid();
  INSERT INTO app.wallets (id, tenant_id) VALUES (v_wallet, v_tenant);
  INSERT INTO app.ledger_accounts (id, tenant_id, wallet_id, code, normal_side)
  VALUES (gen_random_uuid(), v_tenant, v_wallet, 'wallet_available', 'credit'),
         (gen_random_uuid(), v_tenant, v_wallet, 'wallet_held', 'credit'),
         (gen_random_uuid(), v_tenant, v_wallet, 'payment_clearing', 'debit'),
         (gen_random_uuid(), v_tenant, v_wallet, 'service_revenue', 'credit'),
         (gen_random_uuid(), v_tenant, v_wallet, 'dispute_losses', 'debit');
  RETURN v_wallet;
END
$$;
GRANT EXECUTE ON FUNCTION app.billing_ensure_wallet() TO w360_app;
ALTER FUNCTION app.billing_ensure_wallet() OWNER TO w360_definer;

-- Credit a verified captured payment to the wallet, exactly once ------------------------------------
-- The caller must have verified the capture with the provider (webhook signature plus an
-- authoritative payment fetch). Amount and currency must equal the top-up; a top-up already paid
-- with this payment returns 'already_credited'; a different payment for the same top-up is refused.
CREATE FUNCTION app.billing_credit_topup(
  p_topup_id uuid, p_order_id text, p_payment_id text, p_amount_minor bigint, p_currency text, p_actor text
) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_topup app.topups%ROWTYPE;
  v_tx uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  SELECT * INTO v_topup FROM app.topups t WHERE t.tenant_id = v_tenant AND t.id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'top-up not found' USING ERRCODE = 'W3404';
  END IF;
  IF v_topup.status IN ('paid', 'partially_refunded', 'refunded') THEN
    IF v_topup.provider_payment_id = p_payment_id THEN
      RETURN 'already_credited';
    END IF;
    RAISE EXCEPTION 'top-up already paid by another payment' USING ERRCODE = 'W3409';
  END IF;
  IF v_topup.provider_order_id IS NULL OR v_topup.provider_order_id IS DISTINCT FROM p_order_id THEN
    RAISE EXCEPTION 'payment does not belong to this top-up''s order' USING ERRCODE = 'W3412';
  END IF;
  IF p_amount_minor <> v_topup.amount_minor OR p_currency <> v_topup.currency THEN
    RAISE EXCEPTION 'captured amount does not match the top-up' USING ERRCODE = 'W3412';
  END IF;
  IF p_payment_id IS NULL OR p_payment_id !~ '^pay_[A-Za-z0-9]{1,40}$' THEN
    RAISE EXCEPTION 'invalid payment id' USING ERRCODE = 'W3412';
  END IF;
  v_tx := app.ledger_post(v_tenant, v_topup.wallet_id, 'topup_credit', 'topup:' || v_topup.id::text,
    'topup', v_topup.id::text, 'Card top-up', 'provider', p_actor,
    jsonb_build_array(
      jsonb_build_object('account', 'payment_clearing', 'direction', 'debit', 'amount', v_topup.amount_minor),
      jsonb_build_object('account', 'wallet_available', 'direction', 'credit', 'amount', v_topup.amount_minor)));
  UPDATE app.topups t
     SET status = 'paid', provider_payment_id = p_payment_id, paid_at = now(), credited_transaction_id = v_tx,
         failure_reason = NULL
   WHERE t.tenant_id = v_tenant AND t.id = p_topup_id;
  UPDATE app.auto_recharge_attempts a
     SET status = 'succeeded', unknown_step = NULL, resolved_at = now()
   WHERE a.tenant_id = v_tenant AND a.topup_id = p_topup_id
     AND a.status IN ('scheduled', 'order_created', 'payment_requested', 'unknown', 'failed');
  RETURN 'credited';
END
$$;
GRANT EXECUTE ON FUNCTION app.billing_credit_topup(uuid, text, text, bigint, text, text) TO w360_app;
ALTER FUNCTION app.billing_credit_topup(uuid, text, text, bigint, text, text) OWNER TO w360_definer;

-- Refunds and lost disputes reduce available credit (which may go negative) ----------------------
CREATE FUNCTION app.billing_record_refund(p_topup_id uuid, p_refund_id text, p_amount_minor bigint)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_topup app.topups%ROWTYPE;
  v_key text := 'refund:' || p_refund_id;
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
GRANT EXECUTE ON FUNCTION app.billing_record_refund(uuid, text, bigint) TO w360_app;
ALTER FUNCTION app.billing_record_refund(uuid, text, bigint) OWNER TO w360_definer;

CREATE FUNCTION app.billing_record_dispute_loss(p_topup_id uuid, p_dispute_id text, p_amount_minor bigint)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_topup app.topups%ROWTYPE;
  v_key text := 'dispute:' || p_dispute_id;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  IF p_dispute_id IS NULL OR p_dispute_id !~ '^disp_[A-Za-z0-9]{1,40}$' OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'invalid dispute' USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO v_topup FROM app.topups t WHERE t.tenant_id = v_tenant AND t.id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'top-up not found' USING ERRCODE = 'W3404';
  END IF;
  IF EXISTS (SELECT 1 FROM app.ledger_transactions l WHERE l.tenant_id = v_tenant AND l.idempotency_key = v_key) THEN
    RETURN 'already_recorded';
  END IF;
  IF v_topup.credited_transaction_id IS NULL OR p_amount_minor > v_topup.amount_minor THEN
    RAISE EXCEPTION 'dispute does not match a credited top-up' USING ERRCODE = 'W3412';
  END IF;
  -- The money left through the dispute; the credit it bought is withdrawn.
  PERFORM app.ledger_post(v_tenant, v_topup.wallet_id, 'dispute_loss', v_key, 'topup', v_topup.id::text,
    'Chargeback lost', 'provider', p_dispute_id,
    jsonb_build_array(
      jsonb_build_object('account', 'wallet_available', 'direction', 'debit', 'amount', p_amount_minor),
      jsonb_build_object('account', 'payment_clearing', 'direction', 'credit', 'amount', p_amount_minor)));
  RETURN 'recorded';
END
$$;
GRANT EXECUTE ON FUNCTION app.billing_record_dispute_loss(uuid, text, bigint) TO w360_app;
ALTER FUNCTION app.billing_record_dispute_loss(uuid, text, bigint) OWNER TO w360_definer;

-- Holds for billable HyFib services ------------------------------------------------------------
CREATE FUNCTION app.billing_hold(
  p_key text, p_amount_minor bigint, p_reference_type text, p_reference_id text, p_expires_at timestamptz
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_wallet uuid;
  v_available bigint;
  v_hold uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'invalid hold' USING ERRCODE = 'W3412';
  END IF;
  SELECT h.id INTO v_hold FROM app.wallet_holds h WHERE h.tenant_id = v_tenant AND h.idempotency_key = p_key;
  IF FOUND THEN
    RETURN v_hold;
  END IF;
  IF (SELECT t.status FROM app.tenants t WHERE t.id = v_tenant) <> 'active' THEN
    RAISE EXCEPTION 'company is not active' USING ERRCODE = 'W3403';
  END IF;
  SELECT w.id INTO v_wallet FROM app.wallets w WHERE w.tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient service credit' USING ERRCODE = 'W3402';
  END IF;
  SELECT a.balance_minor INTO v_available FROM app.ledger_accounts a
   WHERE a.tenant_id = v_tenant AND a.wallet_id = v_wallet AND a.code = 'wallet_available' FOR UPDATE;
  IF v_available < p_amount_minor THEN
    RAISE EXCEPTION 'insufficient service credit' USING ERRCODE = 'W3402';
  END IF;
  v_hold := gen_random_uuid();
  INSERT INTO app.wallet_holds (id, tenant_id, wallet_id, amount_minor, idempotency_key, reference_type,
    reference_id, expires_at)
  VALUES (v_hold, v_tenant, v_wallet, p_amount_minor, p_key, p_reference_type, p_reference_id, p_expires_at);
  PERFORM app.ledger_post(v_tenant, v_wallet, 'hold', 'hold:' || v_hold::text, p_reference_type, p_reference_id,
    'Reserved for ' || p_reference_type, 'system', NULL,
    jsonb_build_array(
      jsonb_build_object('account', 'wallet_available', 'direction', 'debit', 'amount', p_amount_minor),
      jsonb_build_object('account', 'wallet_held', 'direction', 'credit', 'amount', p_amount_minor)));
  RETURN v_hold;
END
$$;
GRANT EXECUTE ON FUNCTION app.billing_hold(text, bigint, text, text, timestamptz) TO w360_app;
ALTER FUNCTION app.billing_hold(text, bigint, text, text, timestamptz) OWNER TO w360_definer;

-- Settle a hold at the verified charge (<= held); the remainder returns to available credit.
CREATE FUNCTION app.billing_settle_hold(p_hold_id uuid, p_amount_minor bigint) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_hold app.wallet_holds%ROWTYPE;
  v_lines jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  SELECT * INTO v_hold FROM app.wallet_holds h WHERE h.tenant_id = v_tenant AND h.id = p_hold_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hold not found' USING ERRCODE = 'W3404';
  END IF;
  IF v_hold.status = 'settled' AND v_hold.settled_minor = p_amount_minor THEN
    RETURN;
  END IF;
  IF v_hold.status <> 'held' THEN
    RAISE EXCEPTION 'hold is no longer open' USING ERRCODE = 'W3409';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor < 0 OR p_amount_minor > v_hold.amount_minor THEN
    RAISE EXCEPTION 'settlement must be between 0 and the held amount' USING ERRCODE = 'W3412';
  END IF;
  v_lines := jsonb_build_array(
    jsonb_build_object('account', 'wallet_held', 'direction', 'debit', 'amount', v_hold.amount_minor));
  IF p_amount_minor > 0 THEN
    v_lines := v_lines || jsonb_build_object('account', 'service_revenue', 'direction', 'credit', 'amount', p_amount_minor);
  END IF;
  IF v_hold.amount_minor - p_amount_minor > 0 THEN
    v_lines := v_lines || jsonb_build_object('account', 'wallet_available', 'direction', 'credit',
      'amount', v_hold.amount_minor - p_amount_minor);
  END IF;
  PERFORM app.ledger_post(v_tenant, v_hold.wallet_id, 'hold_settle', 'settle:' || v_hold.id::text,
    v_hold.reference_type, v_hold.reference_id, 'Charged for ' || v_hold.reference_type, 'system', NULL, v_lines);
  UPDATE app.wallet_holds h SET status = 'settled', settled_minor = p_amount_minor, resolved_at = now()
   WHERE h.tenant_id = v_tenant AND h.id = p_hold_id;
END
$$;
GRANT EXECUTE ON FUNCTION app.billing_settle_hold(uuid, bigint) TO w360_app;
ALTER FUNCTION app.billing_settle_hold(uuid, bigint) OWNER TO w360_definer;

CREATE FUNCTION app.billing_release_hold(p_hold_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_hold app.wallet_holds%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  SELECT * INTO v_hold FROM app.wallet_holds h WHERE h.tenant_id = v_tenant AND h.id = p_hold_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hold not found' USING ERRCODE = 'W3404';
  END IF;
  IF v_hold.status = 'released' THEN
    RETURN;
  END IF;
  IF v_hold.status <> 'held' THEN
    RAISE EXCEPTION 'hold is no longer open' USING ERRCODE = 'W3409';
  END IF;
  PERFORM app.ledger_post(v_tenant, v_hold.wallet_id, 'hold_release', 'release:' || v_hold.id::text,
    v_hold.reference_type, v_hold.reference_id, 'Released reservation', 'system', NULL,
    jsonb_build_array(
      jsonb_build_object('account', 'wallet_held', 'direction', 'debit', 'amount', v_hold.amount_minor),
      jsonb_build_object('account', 'wallet_available', 'direction', 'credit', 'amount', v_hold.amount_minor)));
  UPDATE app.wallet_holds h SET status = 'released', resolved_at = now()
   WHERE h.tenant_id = v_tenant AND h.id = p_hold_id;
END
$$;
GRANT EXECUTE ON FUNCTION app.billing_release_hold(uuid) TO w360_app;
ALTER FUNCTION app.billing_release_hold(uuid) OWNER TO w360_definer;

-- Auto-recharge: decide and record one attempt atomically -----------------------------------------
-- Serialised per company (advisory lock). Refuses unless enabled, the mandate is active, the
-- available balance is below the threshold, no attempt is in flight or failed in the last day, and
-- the new amount fits the daily and monthly caps counting succeeded AND in-flight attempts. Returns
-- 'scheduled' or the reason for skipping.
CREATE FUNCTION app.billing_begin_auto_recharge(p_attempt_id uuid, p_topup_id uuid, p_receipt text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_settings app.auto_recharge_settings%ROWTYPE;
  v_mandate app.payment_mandates%ROWTYPE;
  v_wallet uuid;
  v_available bigint;
  v_day bigint;
  v_month bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  -- One decision at a time per company (row locks would need UPDATE rights on the settings).
  PERFORM pg_advisory_xact_lock(hashtextextended('w360:auto-recharge:' || v_tenant::text, 0));
  SELECT * INTO v_settings FROM app.auto_recharge_settings s WHERE s.tenant_id = v_tenant;
  IF NOT FOUND OR NOT v_settings.enabled THEN
    RETURN 'disabled';
  END IF;
  IF (SELECT t.status FROM app.tenants t WHERE t.id = v_tenant) <> 'active' THEN
    RETURN 'company_not_active';
  END IF;
  SELECT * INTO v_mandate FROM app.payment_mandates m WHERE m.tenant_id = v_tenant AND m.id = v_settings.mandate_id;
  IF NOT FOUND OR v_mandate.status <> 'active' THEN
    RETURN 'mandate_not_active';
  END IF;
  IF v_settings.amount_minor > v_mandate.max_amount_minor THEN
    RETURN 'amount_above_mandate';
  END IF;
  SELECT w.id INTO v_wallet FROM app.wallets w WHERE w.tenant_id = v_tenant;
  IF NOT FOUND THEN
    RETURN 'no_wallet';
  END IF;
  SELECT a.balance_minor INTO v_available FROM app.ledger_accounts a
   WHERE a.tenant_id = v_tenant AND a.wallet_id = v_wallet AND a.code = 'wallet_available';
  IF v_available >= v_settings.threshold_minor THEN
    RETURN 'above_threshold';
  END IF;
  IF EXISTS (SELECT 1 FROM app.auto_recharge_attempts x WHERE x.tenant_id = v_tenant AND x.wallet_id = v_wallet
               AND x.status IN ('scheduled', 'order_created', 'payment_requested', 'unknown')) THEN
    RETURN 'attempt_in_flight';
  END IF;
  -- Card debits are not retried automatically (R-041); after a failure wait a day before trying again.
  IF EXISTS (SELECT 1 FROM app.auto_recharge_attempts x WHERE x.tenant_id = v_tenant AND x.wallet_id = v_wallet
               AND x.status = 'failed' AND x.resolved_at > now() - interval '24 hours') THEN
    RETURN 'recent_failure';
  END IF;
  SELECT coalesce(sum(x.amount_minor) FILTER (WHERE x.created_at > now() - interval '24 hours'), 0),
         coalesce(sum(x.amount_minor) FILTER (WHERE x.created_at > now() - interval '30 days'), 0)
    INTO v_day, v_month
    FROM app.auto_recharge_attempts x
   WHERE x.tenant_id = v_tenant AND x.wallet_id = v_wallet
     AND x.status IN ('scheduled', 'order_created', 'payment_requested', 'unknown', 'succeeded');
  IF v_day + v_settings.amount_minor > v_settings.daily_cap_minor THEN
    RETURN 'daily_cap_reached';
  END IF;
  IF v_month + v_settings.amount_minor > v_settings.monthly_cap_minor THEN
    RETURN 'monthly_cap_reached';
  END IF;
  INSERT INTO app.topups (id, tenant_id, wallet_id, kind, amount_minor, receipt)
  VALUES (p_topup_id, v_tenant, v_wallet, 'auto_recharge', v_settings.amount_minor, p_receipt);
  INSERT INTO app.auto_recharge_attempts (id, tenant_id, wallet_id, mandate_id, topup_id, amount_minor)
  VALUES (p_attempt_id, v_tenant, v_wallet, v_mandate.id, p_topup_id, v_settings.amount_minor);
  RETURN 'scheduled';
END
$$;
GRANT EXECUTE ON FUNCTION app.billing_begin_auto_recharge(uuid, uuid, text) TO w360_app;
ALTER FUNCTION app.billing_begin_auto_recharge(uuid, uuid, text) OWNER TO w360_definer;

-- Sweeper inputs (ids only, across companies) --------------------------------------------------
-- Companies whose auto-recharge may be due (enabled, below threshold, nothing in flight).
CREATE FUNCTION ops.billing_auto_recharge_candidates(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id
    FROM app.auto_recharge_settings s
    JOIN app.tenants t ON t.id = s.tenant_id AND t.status = 'active'
    JOIN app.payment_mandates m ON m.tenant_id = s.tenant_id AND m.id = s.mandate_id AND m.status = 'active'
    JOIN app.wallets w ON w.tenant_id = s.tenant_id
    JOIN app.ledger_accounts a ON a.tenant_id = w.tenant_id AND a.wallet_id = w.id AND a.code = 'wallet_available'
   WHERE s.enabled AND a.balance_minor < s.threshold_minor
     AND NOT EXISTS (SELECT 1 FROM app.auto_recharge_attempts x WHERE x.tenant_id = s.tenant_id
                       AND (x.status IN ('scheduled', 'order_created', 'payment_requested', 'unknown')
                            OR (x.status = 'failed' AND x.resolved_at > now() - interval '24 hours')))
   ORDER BY s.tenant_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
GRANT EXECUTE ON FUNCTION ops.billing_auto_recharge_candidates(integer) TO w360_app;
ALTER FUNCTION ops.billing_auto_recharge_candidates(integer) OWNER TO w360_definer;

-- Open top-ups and in-flight attempts that need reconciliation with the provider.
CREATE FUNCTION ops.billing_reconciliation_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, kind text, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  (SELECT t.tenant_id, 'topup'::text, t.id
     FROM app.topups t
    WHERE t.kind = 'manual' AND t.status IN ('creating', 'awaiting_payment')
      AND t.next_check_at <= now()
    ORDER BY t.next_check_at
    LIMIT least(greatest(p_limit, 1), 1000))
  UNION ALL
  (SELECT x.tenant_id, 'attempt'::text, x.id
     FROM app.auto_recharge_attempts x
    WHERE x.status IN ('scheduled', 'order_created', 'payment_requested', 'unknown')
      AND x.next_check_at <= now()
    ORDER BY x.next_check_at
    LIMIT least(greatest(p_limit, 1), 1000))
$$;
GRANT EXECUTE ON FUNCTION ops.billing_reconciliation_due(integer) TO w360_app;
ALTER FUNCTION ops.billing_reconciliation_due(integer) OWNER TO w360_definer;

-- Provider id → company resolution for webhook processing (never trust ids inside payloads) -----
CREATE FUNCTION ops.billing_resolve_order(p_order_id text)
  RETURNS TABLE (tenant_id uuid, subject text, subject_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT t.tenant_id, 'topup'::text, t.id FROM app.topups t WHERE t.provider_order_id = p_order_id
  UNION ALL
  SELECT m.tenant_id, 'mandate'::text, m.id FROM app.payment_mandates m WHERE m.authorization_order_id = p_order_id
$$;
GRANT EXECUTE ON FUNCTION ops.billing_resolve_order(text) TO w360_app;
ALTER FUNCTION ops.billing_resolve_order(text) OWNER TO w360_definer;

CREATE FUNCTION ops.billing_resolve_token(p_token_id text)
  RETURNS TABLE (tenant_id uuid, mandate_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT m.tenant_id, m.id FROM app.payment_mandates m WHERE m.provider_token_id = p_token_id
$$;
GRANT EXECUTE ON FUNCTION ops.billing_resolve_token(text) TO w360_app;
ALTER FUNCTION ops.billing_resolve_token(text) OWNER TO w360_definer;

-- Holds that expired without being settled, across companies (ids only; released by the sweeper).
CREATE FUNCTION ops.billing_expired_holds(p_limit integer)
  RETURNS TABLE (tenant_id uuid, hold_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT h.tenant_id, h.id
    FROM app.wallet_holds h
   WHERE h.status = 'held' AND h.expires_at <= now()
   ORDER BY h.expires_at
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
GRANT EXECUTE ON FUNCTION ops.billing_expired_holds(integer) TO w360_app;
ALTER FUNCTION ops.billing_expired_holds(integer) OWNER TO w360_definer;
