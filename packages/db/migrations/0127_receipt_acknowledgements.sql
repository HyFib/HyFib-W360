-- Acknowledging webhook receipts that need attention on the operations console (P5-10, ADR-179).
-- Operations → Integrations lists the Meta and Razorpay receipts that used all their attempts or
-- have waited too long, and every platform administrator is emailed about the first kind (0068);
-- nothing there said that someone had already looked at one, or what they found. An administrator
-- now records it with a note, as dead letters (0117) and late queues (0125) are acknowledged.
--
-- The notes live in a table of their own: the runtime role writes receipts (0003's table grants),
-- and only the definer function below may write a note. A receipt's note goes with the receipt:
-- the retention sweep deletes receipts after 90 days (0003), and their notes with them.
CREATE TABLE ops.receipt_acknowledgements (
  receipt_id uuid PRIMARY KEY REFERENCES ops.webhook_receipts (id) ON DELETE CASCADE,
  acknowledged_by_user_id text NOT NULL REFERENCES auth.users (id),
  acknowledged_at timestamptz NOT NULL,
  note text NOT NULL CHECK (char_length(note) BETWEEN 10 AND 500)
);
-- Platform staff read the notes on the console; only the definer function writes them.
GRANT SELECT ON ops.receipt_acknowledgements TO w360_platform;
GRANT SELECT, INSERT, UPDATE ON ops.receipt_acknowledgements TO w360_definer;

-- Records an administrator's note on a receipt still kept, replacing an earlier one, and audits it
-- in the same transaction. Any receipt can be acknowledged, retried or not; the console offers it
-- for those it lists. Platform administrators only.
CREATE FUNCTION ops.platform_acknowledge_webhook_receipt(p_receipt_id uuid, p_note text,
    p_correlation_id text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_note text := btrim(p_note);
  r record;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF v_note IS NULL OR char_length(v_note) < 10 OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'Write a note of 10 to 500 characters.' USING ERRCODE = 'W3412';
  END IF;
  SELECT w.id, w.provider, w.status INTO r FROM ops.webhook_receipts w WHERE w.id = p_receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt not found.' USING ERRCODE = 'W3404';
  END IF;
  INSERT INTO ops.receipt_acknowledgements AS k (receipt_id, acknowledged_by_user_id,
                                                 acknowledged_at, note)
  VALUES (r.id, v_actor, now(), v_note)
  ON CONFLICT (receipt_id) DO UPDATE
    SET acknowledged_by_user_id = EXCLUDED.acknowledged_by_user_id,
        acknowledged_at = EXCLUDED.acknowledged_at,
        note = EXCLUDED.note;
  INSERT INTO ops.platform_audit_events
    (actor_user_id, action, target_tenant_id, reason, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.webhook_receipt_acknowledged', NULL, v_note, 'success',
          p_correlation_id,
          jsonb_build_object('receiptId', r.id, 'provider', r.provider, 'status', r.status));
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_acknowledge_webhook_receipt(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_acknowledge_webhook_receipt(uuid, text, text)
  TO w360_platform;
ALTER FUNCTION ops.platform_acknowledge_webhook_receipt(uuid, text, text) OWNER TO w360_definer;
