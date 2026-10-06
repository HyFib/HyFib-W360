-- Acknowledging quarantine entries on the operations console (P5-10, ADR-199).
-- Operations → Integrations lists the open quarantine entries, events HyFib could not attribute to
-- a company, and every platform administrator is emailed about each (0068). An entry closes only
-- when an administrator resolves it with a written resolution (0026); until then nothing said that
-- someone was already on it (waiting on the company to reconnect, say) or what they found. An
-- administrator now records it with a note, as dead letters (0117), late queues (0125) and receipts
-- (0127) are acknowledged.
--
-- The notes live in a table of their own: the runtime role writes quarantine entries (0003's
-- grants), and only the definer function below may write a note. An entry's note goes with the
-- entry: the retention sweep deletes entries with their receipts after 90 days (0003).
CREATE TABLE ops.quarantine_acknowledgements (
  quarantine_id uuid PRIMARY KEY REFERENCES ops.webhook_quarantine (id) ON DELETE CASCADE,
  acknowledged_by_user_id text NOT NULL REFERENCES auth.users (id),
  acknowledged_at timestamptz NOT NULL,
  note text NOT NULL CHECK (char_length(note) BETWEEN 10 AND 500)
);
-- Platform staff read the notes on the console; only the definer function writes them.
GRANT SELECT ON ops.quarantine_acknowledgements TO w360_platform;
GRANT SELECT, INSERT, UPDATE ON ops.quarantine_acknowledgements TO w360_definer;

-- Records an administrator's note on an open quarantine entry, replacing an earlier one, and
-- audits it in the same transaction. A resolved entry is closed and the console no longer lists
-- it, so it is refused. Platform administrators only.
CREATE FUNCTION ops.platform_acknowledge_quarantine_entry(p_quarantine_id uuid, p_note text,
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
  SELECT q.id, q.receipt_id, q.provider, q.reason, q.resolved_at INTO r
    FROM ops.webhook_quarantine q
   WHERE q.id = p_quarantine_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quarantine entry not found.' USING ERRCODE = 'W3404';
  END IF;
  IF r.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'This quarantine entry is already resolved.' USING ERRCODE = 'W3409';
  END IF;
  INSERT INTO ops.quarantine_acknowledgements AS k (quarantine_id, acknowledged_by_user_id,
                                                    acknowledged_at, note)
  VALUES (r.id, v_actor, now(), v_note)
  ON CONFLICT (quarantine_id) DO UPDATE
    SET acknowledged_by_user_id = EXCLUDED.acknowledged_by_user_id,
        acknowledged_at = EXCLUDED.acknowledged_at,
        note = EXCLUDED.note;
  INSERT INTO ops.platform_audit_events
    (actor_user_id, action, target_tenant_id, reason, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.webhook_quarantine_acknowledged', NULL, v_note, 'success',
          p_correlation_id,
          jsonb_build_object('quarantineId', r.id, 'receiptId', r.receipt_id,
                             'provider', r.provider, 'reason', r.reason));
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_acknowledge_quarantine_entry(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_acknowledge_quarantine_entry(uuid, text, text)
  TO w360_platform;
ALTER FUNCTION ops.platform_acknowledge_quarantine_entry(uuid, text, text) OWNER TO w360_definer;
