-- Alerts to platform staff for work that failed for good (P5-10, ADR-091): jobs the dead-letter
-- queue received, Meta and Razorpay webhook receipts that used all their processing attempts, and
-- provider events that could not be matched to a company. The operations console lists each of
-- them (ADR-054), but nobody heard of them unless they looked, and a receipt can be retried only
-- while its body is kept (7 days). The worker's minute sweep now emails every platform
-- administrator about each item once, at most every 15 minutes, with counts only.

-- When platform staff were emailed about each item.
ALTER TABLE ops.dead_letters ADD COLUMN alerted_at timestamptz;
ALTER TABLE ops.webhook_receipts ADD COLUMN exhausted_alerted_at timestamptz;
ALTER TABLE ops.webhook_quarantine ADD COLUMN alerted_at timestamptz;
CREATE INDEX dead_letters_unalerted_idx ON ops.dead_letters (failed_at) WHERE alerted_at IS NULL;
CREATE INDEX webhook_receipts_exhausted_idx ON ops.webhook_receipts (received_at)
  WHERE attempts >= 12 AND status IN ('failed', 'processing');
CREATE INDEX webhook_quarantine_unalerted_idx ON ops.webhook_quarantine (created_at)
  WHERE alerted_at IS NULL AND resolved_at IS NULL;
-- The console shows when staff were emailed about a receipt (the other two tables are readable
-- whole), and applies the rule below, which needs the lease.
GRANT SELECT (exhausted_alerted_at, lease_until) ON ops.webhook_receipts TO w360_platform;

-- Nobody was emailed about what the console already listed before this release. Dead letters and
-- receipts whose body was erased after 7 days are history: they are marked as told. Receipts that
-- can still be retried and quarantine entries not resolved are what staff must act on, so the first
-- sweep emails them.
UPDATE ops.dead_letters SET alerted_at = recorded_at;
UPDATE ops.webhook_receipts SET exhausted_alerted_at = now()
 WHERE attempts >= 12 AND status IN ('failed', 'processing') AND body_ciphertext IS NULL;

-- When the last alert went out: at most one email every 15 minutes, however many failures arrive.
CREATE TABLE ops.platform_alerts (
  kind text PRIMARY KEY CHECK (kind IN ('failures')),
  last_sent_at timestamptz
);
INSERT INTO ops.platform_alerts (kind) VALUES ('failures');
GRANT SELECT ON ops.platform_alerts TO w360_platform;

-- A receipt that used all its attempts, the one rule for the alerts and the retry below; the
-- console applies the same rule (MAX_RECEIPT_ATTEMPTS, tested against this one). The sweeper
-- re-signals a receipt at most 12 times. One that failed its last attempt stays failed; one whose
-- worker stopped during its last attempt stays processing after its lease ran out, and the sweeper
-- never signals it again.
CREATE FUNCTION ops.webhook_receipt_exhausted(p_status text, p_attempts integer,
    p_lease_until timestamptz)
  RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT coalesce(p_attempts >= 12
     AND (p_status = 'failed' OR (p_status = 'processing' AND p_lease_until < now())), false)
$$;
REVOKE EXECUTE ON FUNCTION ops.webhook_receipt_exhausted(text, integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.webhook_receipt_exhausted(text, integer, timestamptz)
  TO w360_app, w360_platform;
ALTER FUNCTION ops.webhook_receipt_exhausted(text, integer, timestamptz) OWNER TO w360_definer;

-- Who is emailed: every platform administrator. Both roles retry receipts and resolve quarantine
-- entries (ADR-054).
CREATE FUNCTION ops.platform_failure_alert_recipients()
  RETURNS TABLE (user_id text, email text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT u.id, u.email
    FROM ops.platform_admins a
    JOIN auth.users u ON u.id = a.user_id
   ORDER BY u.id
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_failure_alert_recipients() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_failure_alert_recipients() TO w360_app;
ALTER FUNCTION ops.platform_failure_alert_recipients() OWNER TO w360_definer;

-- How many items wait for an alert (the sweep's cheap check before it reads recipients).
CREATE FUNCTION ops.failure_alerts_due()
  RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT (SELECT count(*) FROM ops.dead_letters d WHERE d.alerted_at IS NULL)::integer
       + (SELECT count(*) FROM ops.webhook_receipts r
           WHERE r.attempts >= 12 AND r.status IN ('failed', 'processing')
             AND r.exhausted_alerted_at IS NULL
             AND ops.webhook_receipt_exhausted(r.status, r.attempts, r.lease_until))::integer
       + (SELECT count(*) FROM ops.webhook_quarantine q
           WHERE q.alerted_at IS NULL AND q.resolved_at IS NULL)::integer
$$;
REVOKE EXECUTE ON FUNCTION ops.failure_alerts_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.failure_alerts_due() TO w360_app;
ALTER FUNCTION ops.failure_alerts_due() OWNER TO w360_definer;

-- Marks what the alert tells, in the transaction that queues its emails, and returns counts by
-- source and label (the dead letter's queue, the receipt's provider, the quarantine's provider and
-- reason). Nothing while the last alert went out less than 15 minutes ago: the items wait for the
-- next one. Two sweeps at once queue at most one alert (the row lock on ops.platform_alerts); each
-- update checks its mark again, so a row is never told twice even without the lock.
CREATE FUNCTION ops.mark_failure_alert()
  RETURNS TABLE (source text, label text, items integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_last timestamptz;
  v_any boolean := false;
BEGIN
  SELECT a.last_sent_at INTO v_last FROM ops.platform_alerts a WHERE a.kind = 'failures' FOR UPDATE;
  IF v_last > now() - interval '15 minutes' THEN
    RETURN;
  END IF;
  RETURN QUERY
    WITH marked AS (
      UPDATE ops.dead_letters d SET alerted_at = now()
       WHERE d.alerted_at IS NULL
         AND d.id IN (SELECT x.id FROM ops.dead_letters x WHERE x.alerted_at IS NULL
                       ORDER BY x.failed_at, x.id LIMIT 1000)
      RETURNING d.source_queue
    )
    SELECT 'dead_letter'::text, m.source_queue, count(*)::integer FROM marked m
     GROUP BY m.source_queue;
  v_any := v_any OR FOUND;
  RETURN QUERY
    WITH marked AS (
      UPDATE ops.webhook_receipts r SET exhausted_alerted_at = now()
       WHERE r.exhausted_alerted_at IS NULL
         AND r.id IN (SELECT x.id FROM ops.webhook_receipts x
                       WHERE x.attempts >= 12 AND x.status IN ('failed', 'processing')
                         AND x.exhausted_alerted_at IS NULL
                         AND ops.webhook_receipt_exhausted(x.status, x.attempts, x.lease_until)
                       ORDER BY x.received_at, x.id LIMIT 1000)
      RETURNING r.provider
    )
    SELECT 'receipt'::text, m.provider, count(*)::integer FROM marked m GROUP BY m.provider;
  v_any := v_any OR FOUND;
  RETURN QUERY
    WITH marked AS (
      UPDATE ops.webhook_quarantine q SET alerted_at = now()
       WHERE q.alerted_at IS NULL
         AND q.id IN (SELECT x.id FROM ops.webhook_quarantine x
                       WHERE x.alerted_at IS NULL AND x.resolved_at IS NULL
                       ORDER BY x.created_at, x.id LIMIT 1000)
      RETURNING q.provider, q.reason
    )
    SELECT 'quarantine'::text, m.provider || ':' || m.reason, count(*)::integer FROM marked m
     GROUP BY m.provider, m.reason;
  v_any := v_any OR FOUND;
  IF v_any THEN
    UPDATE ops.platform_alerts SET last_sent_at = now() WHERE kind = 'failures';
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.mark_failure_alert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.mark_failure_alert() TO w360_app;
GRANT SELECT, UPDATE (last_sent_at) ON ops.platform_alerts TO w360_definer;
GRANT UPDATE (alerted_at) ON ops.dead_letters TO w360_definer;
GRANT UPDATE (exhausted_alerted_at) ON ops.webhook_receipts TO w360_definer;
GRANT UPDATE (alerted_at) ON ops.webhook_quarantine TO w360_definer;
ALTER FUNCTION ops.mark_failure_alert() OWNER TO w360_definer;

-- Retrying a receipt (ADR-054) now also takes one whose worker stopped during its last attempt (the
-- console could not offer it before: it listed neither state), and re-arms its alert: if it fails
-- all its attempts again, staff hear of it again. The function is owned by w360_definer, which the
-- migration role cannot replace in place (see 0011): the owner drops it and the migration role
-- recreates it, granting before handing it back.
SET ROLE w360_definer;
DROP FUNCTION ops.platform_retry_webhook_receipt(uuid, text, text);
RESET ROLE;
CREATE FUNCTION ops.platform_retry_webhook_receipt(p_receipt_id uuid, p_reason text,
    p_correlation_id text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_provider text;
  v_status text;
  v_attempts integer;
  v_lease_until timestamptz;
  v_has_body boolean;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 OR char_length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters.' USING ERRCODE = 'W3412';
  END IF;
  SELECT r.provider, r.status, r.attempts, r.lease_until, r.body_ciphertext IS NOT NULL
    INTO v_provider, v_status, v_attempts, v_lease_until, v_has_body
    FROM ops.webhook_receipts r WHERE r.id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Webhook receipt not found.' USING ERRCODE = 'W3404';
  END IF;
  IF v_status NOT IN ('failed', 'quarantined')
     AND NOT ops.webhook_receipt_exhausted(v_status, v_attempts, v_lease_until) THEN
    RAISE EXCEPTION 'Only a failed, stuck or quarantined receipt can be retried.'
      USING ERRCODE = 'W3412';
  END IF;
  IF NOT v_has_body THEN
    RAISE EXCEPTION 'This receipt''s body was erased after 7 days, so it cannot be processed again.'
      USING ERRCODE = 'W3412';
  END IF;
  UPDATE ops.webhook_receipts
     SET status = 'pending', attempts = 0, lease_until = NULL, exhausted_alerted_at = NULL
   WHERE id = p_receipt_id;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, reason, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.webhook_receipt_retried', btrim(p_reason), 'success', p_correlation_id,
          jsonb_build_object('receiptId', p_receipt_id, 'provider', v_provider,
                             'previousStatus', v_status, 'attempts', v_attempts));
  RETURN v_status;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_retry_webhook_receipt(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_retry_webhook_receipt(uuid, text, text) TO w360_platform;
ALTER FUNCTION ops.platform_retry_webhook_receipt(uuid, text, text) OWNER TO w360_definer;
