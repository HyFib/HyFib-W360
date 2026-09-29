-- 0043_unsettled_payment_alerts: platform owners are emailed once about each paid top-up whose
-- payment no settlement showed 7 days after it was paid (P5-05, ADR-071). Platform → Reconciliation
-- listed these payments (0034), but nobody heard of them unless they looked. The worker's minute
-- sweep lists the payments not emailed yet and records each in the transaction that queues the
-- emails, so a payment is emailed once. Only counts and payment days go into the email; companies,
-- amounts and payment ids stay on the page.

-- One row per payment platform owners were emailed about. No runtime role has privileges on it; the
-- definer functions below read and write it. It holds HyFib's own payment ids, kept with the top-ups
-- they belong to (company deletion keeps billing records).
CREATE TABLE ops.settlement_unsettled_alerts (
  payment_id text PRIMARY KEY CHECK (payment_id ~ '^pay_[A-Za-z0-9]{1,40}$'),
  alerted_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON ops.settlement_unsettled_alerts TO w360_definer;

-- The paid top-ups whose payment no completed run has seen settled 7 days after the payment,
-- counted only when every day from the payment's day (India time) to 7 days later has a completed
-- run: the one definition behind the page's list and the owners' alerts. It runs as its caller and
-- is called only by the definer functions below; nobody may execute it directly.
CREATE FUNCTION ops.settlement_unsettled_topups()
  RETURNS TABLE (topup_id uuid, payment_id text, paid_at timestamptz)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  WITH bounds AS (
    SELECT min(r.settlement_date) AS first_day, max(r.settlement_date) AS latest_day
      FROM ops.settlement_recon_runs r WHERE r.status = 'completed')
  SELECT tu.id, tu.provider_payment_id, tu.paid_at
    FROM app.topups tu CROSS JOIN bounds b
   WHERE b.latest_day IS NOT NULL
     AND tu.status IN ('paid', 'partially_refunded') AND tu.provider_payment_id IS NOT NULL
     AND (tu.paid_at AT TIME ZONE 'Asia/Kolkata')::date >= b.first_day
     AND (tu.paid_at AT TIME ZONE 'Asia/Kolkata')::date + 7 <= b.latest_day
     AND NOT EXISTS (SELECT 1 FROM ops.settlement_recon_items i
                      WHERE i.item_type = 'payment' AND i.entity_id = tu.provider_payment_id)
     AND (SELECT count(*) FROM ops.settlement_recon_runs r
           WHERE r.status = 'completed'
             AND r.settlement_date BETWEEN (tu.paid_at AT TIME ZONE 'Asia/Kolkata')::date
                                       AND (tu.paid_at AT TIME ZONE 'Asia/Kolkata')::date + 7) = 8
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_unsettled_topups() FROM PUBLIC;
ALTER FUNCTION ops.settlement_unsettled_topups() OWNER TO w360_definer;

-- The page's list (0034) now comes from the shared definition, with when owners were emailed about
-- each payment. Same checks, arguments and result otherwise. The owner drops the function and the
-- migration role recreates it (see the note in 0011).
SET ROLE w360_definer;
DROP FUNCTION ops.platform_settlement_recon_unsettled(integer);
RESET ROLE;
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
                     tu.status, tu.provider_payment_id, tu.paid_at, a.alerted_at
                FROM ops.settlement_unsettled_topups() u
                JOIN app.topups tu ON tu.id = u.topup_id
                JOIN app.tenants t ON t.id = tu.tenant_id
                LEFT JOIN ops.settlement_unsettled_alerts a ON a.payment_id = u.payment_id
               ORDER BY tu.paid_at, tu.id
               LIMIT greatest(least(p_limit, 500), 1)) x), '[]'::jsonb))
    INTO v_result;
  RETURN v_result;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_settlement_recon_unsettled(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_settlement_recon_unsettled(integer) TO w360_platform;
ALTER FUNCTION ops.platform_settlement_recon_unsettled(integer) OWNER TO w360_definer;

-- Payments on the list not emailed yet (ids only, for the minute sweep), oldest payment first.
CREATE FUNCTION ops.settlement_unsettled_alerts_due(p_limit integer)
  RETURNS TABLE (payment_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT u.payment_id
    FROM ops.settlement_unsettled_topups() u
   WHERE NOT EXISTS (SELECT 1 FROM ops.settlement_unsettled_alerts a
                      WHERE a.payment_id = u.payment_id)
   ORDER BY u.paid_at, u.topup_id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_unsettled_alerts_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_unsettled_alerts_due(integer) TO w360_app;
ALTER FUNCTION ops.settlement_unsettled_alerts_due(integer) OWNER TO w360_definer;

-- Records the given payments as emailed when they are still on the list, and returns those it
-- recorded with their payment time. A payment settled or refunded in between is left out, and so
-- is one another sweep recorded first (its insert makes this one wait, then skip).
CREATE FUNCTION ops.settlement_mark_unsettled_alerted(p_payment_ids text[])
  RETURNS TABLE (payment_id text, paid_at timestamptz)
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  WITH due AS (
    SELECT u.payment_id, u.paid_at
      FROM ops.settlement_unsettled_topups() u
     WHERE u.payment_id = ANY (p_payment_ids)),
  recorded AS (
    INSERT INTO ops.settlement_unsettled_alerts (payment_id)
    SELECT due.payment_id FROM due
    ON CONFLICT (payment_id) DO NOTHING
    RETURNING payment_id)
  SELECT due.payment_id, due.paid_at FROM due JOIN recorded USING (payment_id)
$$;
REVOKE EXECUTE ON FUNCTION ops.settlement_mark_unsettled_alerted(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.settlement_mark_unsettled_alerted(text[]) TO w360_app;
ALTER FUNCTION ops.settlement_mark_unsettled_alerted(text[]) OWNER TO w360_definer;
