-- 0034_settlement_reconciliation: daily reconciliation of Razorpay settlements with HyFib's billing
-- records (P5-05, ADR-059). The worker reads each day's settlement report and records one item per
-- settled transaction with how it matched HyFib's records; platform staff read the runs and platform
-- owners resolve what needs a person. Items keep provider ids, amounts and HyFib's match, never
-- notes, descriptions, receipts or card fields.
--
-- Neither runtime role has privileges on these tables: the worker writes through the SECURITY
-- DEFINER functions below (each write checks the run's current attempt) and platform staff read and
-- act through functions that check who they are.

-- Runs: one per settlement day -----------------------------------------------------------------------
CREATE TABLE ops.settlement_recon_runs (
  id uuid PRIMARY KEY,
  settlement_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  -- Attempts since the run was created or last asked for again (a run fails after six).
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  -- Every attempt's number, never reset: an attempt's writes must name it, and the items an
  -- attempt saw carry it.
  attempt_seq integer NOT NULL DEFAULT 0 CHECK (attempt_seq >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text CHECK (char_length(last_error) BETWEEN 1 AND 500),
  -- Set when a platform owner asked for the day (first or again); null for the daily schedule.
  requested_by_user_id text REFERENCES auth.users (id),
  requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  -- Totals of the latest completed attempt.
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  matched_count integer NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  recorded_count integer NOT NULL DEFAULT 0 CHECK (recorded_count >= 0),
  attention_count integer NOT NULL DEFAULT 0 CHECK (attention_count >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  fee_minor bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  settlement_count integer NOT NULL DEFAULT 0 CHECK (settlement_count >= 0),
  removed_count integer NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_recon_runs_date_uq UNIQUE (settlement_date),
  CONSTRAINT settlement_recon_runs_lease_chk CHECK (status <> 'running' OR lease_until IS NOT NULL),
  CONSTRAINT settlement_recon_runs_requested_chk
    CHECK ((requested_by_user_id IS NULL) = (requested_at IS NULL))
);
CREATE INDEX settlement_recon_runs_due_idx ON ops.settlement_recon_runs (next_attempt_at)
  WHERE status IN ('pending', 'running');

-- Items: one per settled transaction of a run ------------------------------------------------------------
-- status says how the transaction matched HyFib's records and reason says why:
--   matched    HyFib's record agrees (reason null, mandate_authorization or uncredited_payment_refund);
--   recorded   HyFib had missed it and the run recorded it through the usual path (credited,
--              refund_recorded);
--   mismatch   HyFib's record disagrees or the transaction could not be recorded;
--   review     HyFib cannot judge it (adjustments, disputes, unknown types, other currencies,
--              unreadable items);
--   not_hyfib  no HyFib record (another integration on the account, or a Route transfer).
CREATE TABLE ops.settlement_recon_items (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES ops.settlement_recon_runs (id),
  item_type text NOT NULL CHECK (item_type IN ('payment', 'refund', 'transfer', 'adjustment', 'other')),
  entity_id text NOT NULL CHECK (entity_id ~ '^[A-Za-z0-9_:.-]{1,80}$'),
  -- Razorpay's type when it is not one of the four documented ones (item_type 'other').
  provider_type text CHECK (provider_type ~ '^[a-z_]{1,32}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  fee_minor bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  on_hold boolean,
  settled boolean,
  settlement_id text CHECK (settlement_id ~ '^[A-Za-z0-9_]{1,64}$'),
  settlement_utr text CHECK (settlement_utr ~ '^[A-Za-z0-9]{1,64}$'),
  provider_created_at timestamptz,
  settled_at timestamptz,
  payment_id text CHECK (payment_id ~ '^[A-Za-z0-9_]{1,64}$'),
  order_id text CHECK (order_id ~ '^[A-Za-z0-9_]{1,64}$'),
  dispute_id text CHECK (dispute_id ~ '^[A-Za-z0-9_]{1,64}$'),
  method text CHECK (method ~ '^[a-z_]{1,32}$'),
  status text NOT NULL CHECK (status IN ('matched', 'recorded', 'mismatch', 'review', 'not_hyfib')),
  reason text,
  tenant_id uuid REFERENCES app.tenants (id),
  topup_id uuid,
  hyfib_amount_minor bigint CHECK (hyfib_amount_minor >= 0),
  seen_attempt integer NOT NULL CHECK (seen_attempt > 0),
  resolved_at timestamptz,
  resolved_by_user_id text REFERENCES auth.users (id),
  resolution_note text CHECK (char_length(resolution_note) BETWEEN 10 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_recon_items_entity_uq UNIQUE (run_id, item_type, entity_id),
  CONSTRAINT settlement_recon_items_topup_fk FOREIGN KEY (tenant_id, topup_id)
    REFERENCES app.topups (tenant_id, id),
  CONSTRAINT settlement_recon_items_topup_chk CHECK (topup_id IS NULL OR tenant_id IS NOT NULL),
  CONSTRAINT settlement_recon_items_resolution_chk CHECK (
    (resolved_at IS NULL) = (resolved_by_user_id IS NULL)
    AND (resolved_at IS NULL) = (resolution_note IS NULL)),
  CONSTRAINT settlement_recon_items_reason_chk CHECK (
    (status = 'matched' AND (reason IS NULL OR reason IN ('mandate_authorization', 'uncredited_payment_refund')))
    OR (status = 'recorded' AND reason IN ('credited', 'refund_recorded'))
    OR (status = 'mismatch' AND reason IN ('amount_differs', 'second_payment', 'not_captured',
          'mandate_payment', 'refund_not_processed', 'refund_exceeds_payment', 'payment_unavailable',
          'refund_unavailable'))
    OR (status = 'review' AND reason IN ('adjustment', 'dispute', 'unknown_type', 'currency', 'unreadable'))
    OR (status = 'not_hyfib' AND reason IN ('unknown_payment', 'unknown_refund', 'transfer')))
);
CREATE INDEX settlement_recon_items_attention_idx ON ops.settlement_recon_items (run_id)
  WHERE status IN ('mismatch', 'review', 'not_hyfib') AND resolved_at IS NULL;
-- The unsettled-payments check looks payments up by id across runs.
CREATE INDEX settlement_recon_items_payment_idx ON ops.settlement_recon_items (entity_id)
  WHERE item_type = 'payment';
CREATE INDEX settlement_recon_items_tenant_idx ON ops.settlement_recon_items (tenant_id)
  WHERE tenant_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON ops.settlement_recon_runs TO w360_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.settlement_recon_items TO w360_definer;

-- Scheduling (worker) ---------------------------------------------------------------------------------------
-- Creates the runs the daily schedule owes up to p_through (the latest day that may be reconciled
-- now; the worker passes the previous day in India from 06:00 India time): p_through and any of the
-- 6 days before it without a run, but never a day before the first day ever reconciled. Runs whose
-- attempts are used up fail. Returns the runs due now, oldest day first.
CREATE FUNCTION ops.settlement_recon_due(p_through date, p_limit integer)
  RETURNS TABLE (run_id uuid, settlement_date date)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_first date;
BEGIN
  IF p_through IS NULL OR p_through >= (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
    RAISE EXCEPTION 'only a day that is over can be reconciled' USING ERRCODE = 'W3412';
  END IF;
  SELECT min(r.settlement_date) INTO v_first FROM ops.settlement_recon_runs r;
  INSERT INTO ops.settlement_recon_runs (id, settlement_date)
  SELECT gen_random_uuid(), d::date
    FROM generate_series(greatest(p_through - 6, coalesce(v_first, p_through))::timestamp,
                         p_through::timestamp, interval '1 day') AS d
  ON CONFLICT ON CONSTRAINT settlement_recon_runs_date_uq DO NOTHING;
  UPDATE ops.settlement_recon_runs r
     SET status = 'failed', lease_until = NULL, updated_at = now(),
         last_error = coalesce(r.last_error, 'The worker stopped before the attempt finished.')
   WHERE r.status = 'running' AND r.lease_until < now() AND r.attempts >= 6;
  RETURN QUERY
    SELECT r.id, r.settlement_date
      FROM ops.settlement_recon_runs r
     WHERE (r.status = 'pending' AND r.next_attempt_at <= now())
        OR (r.status = 'running' AND r.lease_until < now())
     ORDER BY r.settlement_date
     LIMIT greatest(least(p_limit, 50), 1);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_recon_due(date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_recon_due(date, integer) TO w360_app;
ALTER FUNCTION ops.settlement_recon_due(date, integer) OWNER TO w360_definer;

-- Starts an attempt: a due run gets a lease and the next attempt number (attempt_seq), which every
-- write of the attempt must name. Nothing is returned when the run is not due (another attempt holds
-- it, it is finished, or it used its six attempts).
CREATE FUNCTION ops.settlement_recon_claim(p_run_id uuid, p_lease_seconds integer)
  RETURNS TABLE (attempt integer, settlement_date date)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  UPDATE ops.settlement_recon_runs r
     SET status = 'running', attempts = r.attempts + 1, attempt_seq = r.attempt_seq + 1,
         started_at = now(), completed_at = NULL,
         lease_until = now() + make_interval(secs => greatest(least(p_lease_seconds, 3600), 60)),
         updated_at = now()
   WHERE r.id = p_run_id AND r.attempts < 6
     AND ((r.status = 'pending' AND r.next_attempt_at <= now())
          OR (r.status = 'running' AND r.lease_until < now()))
  RETURNING r.attempt_seq, r.settlement_date
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_recon_claim(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_recon_claim(uuid, integer) TO w360_app;
ALTER FUNCTION ops.settlement_recon_claim(uuid, integer) OWNER TO w360_definer;

-- HyFib's records for a page of settled transactions, across companies: top-ups by payment and by
-- order, card mandates by authorisation payment, order and refund, and recorded refunds (ledger key
-- refund:<id>) found through the refunded payment's top-up. Provider ids only select HyFib's rows;
-- the company comes from HyFib's own mapping.
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
     WHERE t.provider_payment_id = ANY (p_refund_payment_ids);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_recon_facts(text[], text[], text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_recon_facts(text[], text[], text[], text[]) TO w360_app;
ALTER FUNCTION ops.settlement_recon_facts(text[], text[], text[], text[]) OWNER TO w360_definer;

-- Writes up to 1000 items of the current attempt. An item seen before is updated in place, so a
-- resolution stays, and an item an earlier attempt recorded stays recorded when it now matches.
CREATE FUNCTION ops.settlement_recon_record_items(p_run_id uuid, p_attempt integer, p_items jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM 1 FROM ops.settlement_recon_runs r
   WHERE r.id = p_run_id AND r.status = 'running' AND r.attempt_seq = p_attempt
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this reconciliation attempt is no longer current' USING ERRCODE = 'W3409';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 1000 THEN
    RAISE EXCEPTION 'items must be an array of at most 1000' USING ERRCODE = 'W3412';
  END IF;
  INSERT INTO ops.settlement_recon_items AS i (id, run_id, item_type, entity_id, provider_type,
      amount_minor, debit_minor, credit_minor, fee_minor, tax_minor, currency, on_hold, settled,
      settlement_id, settlement_utr, provider_created_at, settled_at, payment_id, order_id, dispute_id,
      method, status, reason, tenant_id, topup_id, hyfib_amount_minor, seen_attempt)
  SELECT DISTINCT ON (x.item_type, x.entity_id)
         gen_random_uuid(), p_run_id, x.item_type, x.entity_id, x.provider_type, x.amount_minor,
         x.debit_minor, x.credit_minor, x.fee_minor, x.tax_minor, x.currency, x.on_hold, x.settled,
         x.settlement_id, x.settlement_utr, x.provider_created_at, x.settled_at, x.payment_id,
         x.order_id, x.dispute_id, x.method, x.status, x.reason, x.tenant_id, x.topup_id,
         x.hyfib_amount_minor, p_attempt
    FROM jsonb_to_recordset(p_items) AS x(item_type text, entity_id text, provider_type text,
         amount_minor bigint, debit_minor bigint, credit_minor bigint, fee_minor bigint,
         tax_minor bigint, currency text, on_hold boolean, settled boolean, settlement_id text,
         settlement_utr text, provider_created_at timestamptz, settled_at timestamptz,
         payment_id text, order_id text, dispute_id text, method text, status text, reason text,
         tenant_id uuid, topup_id uuid, hyfib_amount_minor bigint)
   ORDER BY x.item_type, x.entity_id
  ON CONFLICT ON CONSTRAINT settlement_recon_items_entity_uq DO UPDATE SET
    provider_type = EXCLUDED.provider_type, amount_minor = EXCLUDED.amount_minor,
    debit_minor = EXCLUDED.debit_minor, credit_minor = EXCLUDED.credit_minor,
    fee_minor = EXCLUDED.fee_minor, tax_minor = EXCLUDED.tax_minor, currency = EXCLUDED.currency,
    on_hold = EXCLUDED.on_hold, settled = EXCLUDED.settled, settlement_id = EXCLUDED.settlement_id,
    settlement_utr = EXCLUDED.settlement_utr, provider_created_at = EXCLUDED.provider_created_at,
    settled_at = EXCLUDED.settled_at, payment_id = EXCLUDED.payment_id, order_id = EXCLUDED.order_id,
    dispute_id = EXCLUDED.dispute_id, method = EXCLUDED.method,
    status = CASE WHEN i.status = 'recorded' AND EXCLUDED.status = 'matched' THEN i.status
                  ELSE EXCLUDED.status END,
    reason = CASE WHEN i.status = 'recorded' AND EXCLUDED.status = 'matched' THEN i.reason
                  ELSE EXCLUDED.reason END,
    tenant_id = EXCLUDED.tenant_id, topup_id = EXCLUDED.topup_id,
    hyfib_amount_minor = EXCLUDED.hyfib_amount_minor, seen_attempt = EXCLUDED.seen_attempt,
    updated_at = now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_recon_record_items(uuid, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_recon_record_items(uuid, integer, jsonb) TO w360_app;
ALTER FUNCTION ops.settlement_recon_record_items(uuid, integer, jsonb) OWNER TO w360_definer;

-- A failure that may pass (timeout, lost response, 429, 5xx): the run is due again after 5, 15, 60,
-- 180 or 360 minutes, and fails after its sixth attempt. Returns the run's new status, or null when
-- the attempt is no longer current.
CREATE FUNCTION ops.settlement_recon_defer(p_run_id uuid, p_attempt integer, p_error text)
  RETURNS text
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  UPDATE ops.settlement_recon_runs r
     SET status = CASE WHEN r.attempts >= 6 THEN 'failed' ELSE 'pending' END,
         next_attempt_at = now() + make_interval(mins => CASE r.attempts WHEN 1 THEN 5 WHEN 2 THEN 15
                                                   WHEN 3 THEN 60 WHEN 4 THEN 180 ELSE 360 END),
         lease_until = NULL, last_error = left(coalesce(nullif(btrim(p_error), ''), 'failed'), 500),
         updated_at = now()
   WHERE r.id = p_run_id AND r.status = 'running' AND r.attempt_seq = p_attempt
  RETURNING r.status
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_recon_defer(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_recon_defer(uuid, integer, text) TO w360_app;
ALTER FUNCTION ops.settlement_recon_defer(uuid, integer, text) OWNER TO w360_definer;

-- A failure that will not pass by retrying (Razorpay refused the keys or the request): the run fails
-- and waits for a platform owner to run the day again.
CREATE FUNCTION ops.settlement_recon_fail(p_run_id uuid, p_attempt integer, p_error text)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  WITH failed AS (
    UPDATE ops.settlement_recon_runs r
       SET status = 'failed', lease_until = NULL, updated_at = now(),
           last_error = left(coalesce(nullif(btrim(p_error), ''), 'failed'), 500)
     WHERE r.id = p_run_id AND r.status = 'running' AND r.attempt_seq = p_attempt
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM failed)
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_recon_fail(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_recon_fail(uuid, integer, text) TO w360_app;
ALTER FUNCTION ops.settlement_recon_fail(uuid, integer, text) OWNER TO w360_definer;

-- Finishes the attempt: items this attempt did not see (no longer in Razorpay's report for the day)
-- are removed, and the run's totals are computed from the rest.
CREATE FUNCTION ops.settlement_recon_complete(p_run_id uuid, p_attempt integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_removed integer;
  v_items integer;
BEGIN
  PERFORM 1 FROM ops.settlement_recon_runs r
   WHERE r.id = p_run_id AND r.status = 'running' AND r.attempt_seq = p_attempt
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this reconciliation attempt is no longer current' USING ERRCODE = 'W3409';
  END IF;
  DELETE FROM ops.settlement_recon_items i WHERE i.run_id = p_run_id AND i.seen_attempt <> p_attempt;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  UPDATE ops.settlement_recon_runs r
     SET status = 'completed', completed_at = now(), lease_until = NULL, last_error = NULL,
         removed_count = v_removed, updated_at = now(),
         item_count = s.items, matched_count = s.matched, recorded_count = s.recorded,
         attention_count = s.attention, credit_minor = s.credit, debit_minor = s.debit,
         fee_minor = s.fee, tax_minor = s.tax, settlement_count = s.settlements
    FROM (SELECT count(*)::integer AS items,
                 count(*) FILTER (WHERE i.status = 'matched')::integer AS matched,
                 count(*) FILTER (WHERE i.status = 'recorded')::integer AS recorded,
                 count(*) FILTER (WHERE i.status IN ('mismatch', 'review', 'not_hyfib'))::integer AS attention,
                 coalesce(sum(i.credit_minor), 0)::bigint AS credit,
                 coalesce(sum(i.debit_minor), 0)::bigint AS debit,
                 coalesce(sum(i.fee_minor), 0)::bigint AS fee,
                 coalesce(sum(i.tax_minor), 0)::bigint AS tax,
                 count(DISTINCT i.settlement_id)::integer AS settlements
            FROM ops.settlement_recon_items i WHERE i.run_id = p_run_id) s
   WHERE r.id = p_run_id
  RETURNING r.item_count INTO v_items;
  RETURN v_items;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_recon_complete(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_recon_complete(uuid, integer) TO w360_app;
ALTER FUNCTION ops.settlement_recon_complete(uuid, integer) OWNER TO w360_definer;

-- Platform staff: reading ------------------------------------------------------------------------------
-- The latest runs, newest day first, with each run's items still needing a person.
CREATE FUNCTION ops.platform_settlement_recon_runs(p_limit integer)
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
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.settlement_date DESC), '[]'::jsonb) INTO v_result
    FROM (SELECT r.id, r.settlement_date, r.status, r.attempts, r.next_attempt_at, r.last_error,
                 r.started_at, r.completed_at, r.requested_at, u.name AS requested_by_name,
                 r.item_count, r.matched_count, r.recorded_count, r.attention_count, r.credit_minor,
                 r.debit_minor, r.fee_minor, r.tax_minor, r.settlement_count, r.removed_count,
                 (SELECT count(*) FROM ops.settlement_recon_items i
                   WHERE i.run_id = r.id AND i.status IN ('mismatch', 'review', 'not_hyfib')
                     AND i.resolved_at IS NULL) AS open_count
            FROM ops.settlement_recon_runs r
            LEFT JOIN auth.users u ON u.id = r.requested_by_user_id
           ORDER BY r.settlement_date DESC
           LIMIT greatest(least(p_limit, 400), 1)) x;
  RETURN v_result;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_settlement_recon_runs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_settlement_recon_runs(integer) TO w360_platform;
ALTER FUNCTION ops.platform_settlement_recon_runs(integer) OWNER TO w360_definer;

-- One day's run and its items (at most 2000, those needing a person first), with company names.
CREATE FUNCTION ops.platform_settlement_recon_run(p_date date)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_run ops.settlement_recon_runs%ROWTYPE;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  SELECT * INTO v_run FROM ops.settlement_recon_runs r WHERE r.settlement_date = p_date;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT jsonb_build_object(
    'run', (SELECT to_jsonb(x) FROM (
              SELECT v_run.id, v_run.settlement_date, v_run.status, v_run.attempts,
                     v_run.next_attempt_at, v_run.last_error, v_run.started_at, v_run.completed_at,
                     v_run.requested_at, u.name AS requested_by_name, v_run.item_count,
                     v_run.matched_count, v_run.recorded_count, v_run.attention_count,
                     v_run.credit_minor, v_run.debit_minor, v_run.fee_minor, v_run.tax_minor,
                     v_run.settlement_count, v_run.removed_count,
                     (SELECT count(*) FROM ops.settlement_recon_items i
                       WHERE i.run_id = v_run.id AND i.status IN ('mismatch', 'review', 'not_hyfib')
                         AND i.resolved_at IS NULL) AS open_count
                FROM (SELECT 1) one LEFT JOIN auth.users u ON u.id = v_run.requested_by_user_id) x),
    'settlements', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', s.settlement_id, 'utr', s.settlement_utr)
                       ORDER BY s.settlement_id)
        FROM (SELECT DISTINCT i.settlement_id, i.settlement_utr FROM ops.settlement_recon_items i
               WHERE i.run_id = v_run.id AND i.settlement_id IS NOT NULL) s), '[]'::jsonb),
    'items', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.rank, x.item_type, x.entity_id)
        FROM (SELECT i.id, i.item_type, i.entity_id, i.provider_type, i.amount_minor, i.debit_minor,
                     i.credit_minor, i.fee_minor, i.tax_minor, i.currency, i.on_hold, i.settled,
                     i.settlement_id, i.settled_at, i.provider_created_at, i.payment_id, i.order_id,
                     i.dispute_id, i.method, i.status, i.reason, i.tenant_id, t.name AS company_name,
                     i.topup_id, tu.receipt AS topup_receipt, i.hyfib_amount_minor, i.resolved_at,
                     ru.name AS resolved_by_name, i.resolution_note,
                     CASE WHEN i.status IN ('mismatch', 'review', 'not_hyfib') AND i.resolved_at IS NULL THEN 0
                          WHEN i.status = 'recorded' THEN 1
                          WHEN i.resolved_at IS NOT NULL THEN 2
                          ELSE 3 END AS rank
                FROM ops.settlement_recon_items i
                LEFT JOIN app.tenants t ON t.id = i.tenant_id
                LEFT JOIN app.topups tu ON tu.tenant_id = i.tenant_id AND tu.id = i.topup_id
                LEFT JOIN auth.users ru ON ru.id = i.resolved_by_user_id
               WHERE i.run_id = v_run.id
               ORDER BY rank, i.item_type, i.entity_id
               LIMIT 2000) x), '[]'::jsonb))
    INTO v_result;
  RETURN v_result;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_settlement_recon_run(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_settlement_recon_run(date) TO w360_platform;
ALTER FUNCTION ops.platform_settlement_recon_run(date) OWNER TO w360_definer;

-- Paid top-ups whose payment no completed run has seen settled 7 days after the payment, counted only
-- when every day from the payment's day (India time) to 7 days later has a completed run. Also says
-- how many of the last 30 days before the latest completed run lack a completed run.
CREATE FUNCTION ops.platform_settlement_recon_unsettled(p_limit integer)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_latest date;
  v_first date;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  SELECT max(r.settlement_date), min(r.settlement_date) INTO v_latest, v_first
    FROM ops.settlement_recon_runs r WHERE r.status = 'completed';
  IF v_latest IS NULL THEN
    RETURN jsonb_build_object('topups', '[]'::jsonb, 'latestDay', NULL, 'daysWithoutRun', 0);
  END IF;
  SELECT jsonb_build_object(
    'latestDay', v_latest,
    'daysWithoutRun', (
      SELECT count(*) FROM generate_series(greatest(v_first, v_latest - 29)::timestamp,
                                           v_latest::timestamp, interval '1 day') AS d
       WHERE NOT EXISTS (SELECT 1 FROM ops.settlement_recon_runs r
                          WHERE r.settlement_date = d::date AND r.status = 'completed')),
    'topups', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.paid_at, x.id)
        FROM (SELECT tu.id, tu.tenant_id, t.name AS company_name, tu.receipt, tu.kind, tu.amount_minor,
                     tu.status, tu.provider_payment_id, tu.paid_at
                FROM app.topups tu
                JOIN app.tenants t ON t.id = tu.tenant_id
               WHERE tu.status IN ('paid', 'partially_refunded') AND tu.provider_payment_id IS NOT NULL
                 AND (tu.paid_at AT TIME ZONE 'Asia/Kolkata')::date >= v_first
                 AND (tu.paid_at AT TIME ZONE 'Asia/Kolkata')::date + 7 <= v_latest
                 AND NOT EXISTS (SELECT 1 FROM ops.settlement_recon_items i
                                  WHERE i.item_type = 'payment' AND i.entity_id = tu.provider_payment_id)
                 AND (SELECT count(*) FROM ops.settlement_recon_runs r
                       WHERE r.status = 'completed'
                         AND r.settlement_date BETWEEN (tu.paid_at AT TIME ZONE 'Asia/Kolkata')::date
                                                   AND (tu.paid_at AT TIME ZONE 'Asia/Kolkata')::date + 7) = 8
               ORDER BY tu.paid_at, tu.id
               LIMIT greatest(least(p_limit, 500), 1)) x), '[]'::jsonb))
    INTO v_result;
  RETURN v_result;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_settlement_recon_unsettled(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_settlement_recon_unsettled(integer) TO w360_platform;
ALTER FUNCTION ops.platform_settlement_recon_unsettled(integer) OWNER TO w360_definer;

-- Platform owners: acting ------------------------------------------------------------------------------
-- Reconciles a day (up to a year back), or runs it again: the run becomes due now with its attempts
-- reset. Refused while an attempt holds the run. Written to the platform audit log with the reason.
CREATE FUNCTION ops.platform_request_settlement_recon(p_date date, p_reason text,
    p_correlation_id text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_run ops.settlement_recon_runs%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can run a reconciliation.' USING ERRCODE = 'W3403';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters.' USING ERRCODE = 'W3412';
  END IF;
  IF p_date IS NULL OR p_date >= v_today THEN
    RAISE EXCEPTION 'Choose a day that is over (India time).' USING ERRCODE = 'W3412';
  END IF;
  IF p_date < v_today - 366 THEN
    RAISE EXCEPTION 'Choose a day within the last year.' USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO v_run FROM ops.settlement_recon_runs r WHERE r.settlement_date = p_date FOR UPDATE;
  IF FOUND THEN
    IF v_run.status = 'running' AND v_run.lease_until >= now() THEN
      RAISE EXCEPTION 'This day is being reconciled now; wait for it to finish.' USING ERRCODE = 'W3409';
    END IF;
    UPDATE ops.settlement_recon_runs
       SET status = 'pending', attempts = 0, next_attempt_at = now(), lease_until = NULL,
           last_error = NULL, requested_by_user_id = v_actor, requested_at = now(), updated_at = now()
     WHERE id = v_run.id;
    v_id := v_run.id;
  ELSE
    v_id := gen_random_uuid();
    INSERT INTO ops.settlement_recon_runs (id, settlement_date, requested_by_user_id, requested_at)
    VALUES (v_id, p_date, v_actor, now());
  END IF;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, reason, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.settlement_recon_requested', btrim(p_reason), 'success', p_correlation_id,
          jsonb_build_object('runId', v_id, 'settlementDate', p_date,
                             'previousStatus', CASE WHEN v_run.id IS NULL THEN NULL ELSE v_run.status END));
  RETURN v_id;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_request_settlement_recon(date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_request_settlement_recon(date, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_request_settlement_recon(date, text, text) OWNER TO w360_definer;

-- Marks an item that needed a person as resolved, with a note. Written to the platform audit log.
CREATE FUNCTION ops.platform_resolve_settlement_item(p_item_id uuid, p_note text,
    p_correlation_id text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_item ops.settlement_recon_items%ROWTYPE;
  v_date date;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor AND a.role = 'platform_owner') THEN
    RAISE EXCEPTION 'Only a platform owner can resolve a reconciliation item.' USING ERRCODE = 'W3403';
  END IF;
  IF p_note IS NULL OR char_length(btrim(p_note)) < 10 OR char_length(p_note) > 2000 THEN
    RAISE EXCEPTION 'Write a note of at least 10 characters.' USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO v_item FROM ops.settlement_recon_items i WHERE i.id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reconciliation item not found.' USING ERRCODE = 'W3404';
  END IF;
  IF v_item.status NOT IN ('mismatch', 'review', 'not_hyfib') THEN
    RAISE EXCEPTION 'Only an item that needs a person can be resolved.' USING ERRCODE = 'W3412';
  END IF;
  IF v_item.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'This item is already resolved.' USING ERRCODE = 'W3409';
  END IF;
  SELECT r.settlement_date INTO v_date FROM ops.settlement_recon_runs r WHERE r.id = v_item.run_id;
  UPDATE ops.settlement_recon_items
     SET resolved_at = now(), resolved_by_user_id = v_actor, resolution_note = btrim(p_note),
         updated_at = now()
   WHERE id = p_item_id;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, reason, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.settlement_item_resolved', btrim(p_note), 'success', p_correlation_id,
          jsonb_build_object('itemId', v_item.id, 'settlementDate', v_date, 'type', v_item.item_type,
                             'entityId', v_item.entity_id, 'status', v_item.status,
                             'reason', v_item.reason, 'amountMinor', v_item.amount_minor,
                             'tenantId', v_item.tenant_id));
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_resolve_settlement_item(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_resolve_settlement_item(uuid, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_resolve_settlement_item(uuid, text, text) OWNER TO w360_definer;
