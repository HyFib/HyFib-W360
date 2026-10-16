-- 0300_inbox_slow_reply: an automatic reply when members are slow to answer (W-081, ADR-384).
--
-- A company can turn on, in Settings → Inbox, a plain WhatsApp text that HyFib sends a waiting
-- customer once their reply turn (0007, 0009, 0011) has waited a chosen number of minutes without a
-- member's reply, counted in business hours when they are on, as reply targets are. It is sent once
-- per turn, as a system message through the ordinary send pipeline, only inside the 24-hour customer
-- service window, never while an automation is handling the conversation, never for a resolved
-- conversation and never to customers who opted out of non-marketing messages or are suppressed.
-- The message does not end the turn: only a member's reply does, so reply timers, overdue notices
-- (0154) and reports are unchanged.

-- The setting. `slow_reply_since` is when it was last turned on: only waits that start afterwards
-- get the text, so turning it on never messages customers who were already waiting. Constant
-- defaults add the columns without rewriting the table; existing companies keep it off.
ALTER TABLE app.messaging_settings
  ADD COLUMN slow_reply_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN slow_reply_text text
    CONSTRAINT messaging_settings_slow_reply_text_check
    CHECK (char_length(slow_reply_text) BETWEEN 1 AND 1024),
  ADD COLUMN slow_reply_delay_minutes smallint
    CONSTRAINT messaging_settings_slow_reply_delay_check
    CHECK (slow_reply_delay_minutes BETWEEN 1 AND 1440),
  ADD COLUMN slow_reply_since timestamptz,
  ADD CONSTRAINT messaging_settings_slow_reply_on_check CHECK (
    NOT slow_reply_enabled
    OR (slow_reply_text IS NOT NULL AND slow_reply_delay_minutes IS NOT NULL
        AND slow_reply_since IS NOT NULL));
GRANT UPDATE (slow_reply_enabled, slow_reply_text, slow_reply_delay_minutes, slow_reply_since)
  ON app.messaging_settings TO w360_app;

-- One row per reply turn that the sweep looked at: `waiting` while business hours put the due time
-- later than the sweep first looked (it looks again at `due_at`), then `sent` (with the message) or
-- `skipped` (with the reason) for good. The unique turn and the guard below make the text go at
-- most once per turn, across worker restarts and concurrent sweeps. Ids, times and reasons only:
-- the text itself is the message's.
CREATE TABLE app.slow_reply_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  state text NOT NULL
    CONSTRAINT slow_reply_messages_state_check CHECK (state IN ('waiting', 'sent', 'skipped')),
  -- When the text is due, as last computed (while waiting, when the sweep looks again).
  due_at timestamptz NOT NULL,
  message_id uuid,
  skip_reason text
    CONSTRAINT slow_reply_messages_skip_reason_check
    CHECK (skip_reason IN ('too_late', 'channel_inactive', 'window_closed', 'no_phone',
      'opted_out', 'suppressed', 'contact_erased')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slow_reply_messages_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT slow_reply_messages_turn_uq UNIQUE (tenant_id, turn_id),
  CONSTRAINT slow_reply_messages_turn_fk FOREIGN KEY (tenant_id, turn_id)
    REFERENCES app.conversation_turns (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT slow_reply_messages_message_fk FOREIGN KEY (tenant_id, message_id)
    REFERENCES app.messages (tenant_id, id),
  CONSTRAINT slow_reply_messages_outcome CHECK (
    (state = 'waiting' AND message_id IS NULL AND skip_reason IS NULL)
    OR (state = 'sent' AND message_id IS NOT NULL AND skip_reason IS NULL)
    OR (state = 'skipped' AND message_id IS NULL AND skip_reason IS NOT NULL))
);
-- The send worker's check of a queued text (consent at send time) finds its row by message.
CREATE UNIQUE INDEX slow_reply_messages_message_uq ON app.slow_reply_messages (tenant_id, message_id)
  WHERE message_id IS NOT NULL;
-- The sweep's second look at the turns whose due time it put off.
CREATE INDEX slow_reply_messages_waiting_idx ON app.slow_reply_messages (due_at)
  WHERE state = 'waiting';
SELECT ops.apply_tenant_rls('app.slow_reply_messages');
GRANT SELECT, INSERT ON app.slow_reply_messages TO w360_app;
GRANT UPDATE (state, due_at, message_id, skip_reason, updated_at) ON app.slow_reply_messages
  TO w360_app;

-- A row that was sent or skipped never changes; a waiting one moves its due time or ends.
CREATE FUNCTION app.guard_slow_reply_message() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.state <> 'waiting' THEN
    RAISE EXCEPTION 'a sent or skipped automatic reply cannot change' USING ERRCODE = 'W3403';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_slow_reply_message() FROM PUBLIC;
CREATE TRIGGER slow_reply_messages_guard BEFORE UPDATE ON app.slow_reply_messages
  FOR EACH ROW EXECUTE FUNCTION app.guard_slow_reply_message();

-- Deleted with the company (ADR-055), before the reply turns (330) and messages (700) they name.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (326, ARRAY['app.slow_reply_messages']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.slow_reply_messages TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.slow_reply_messages FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.slow_reply_messages FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- The sweep: open reply turns of active companies with the automatic reply on that may be due at
-- p_now: started after it was turned on and at least the delay ago in absolute time (business
-- hours only move a due time later, so this is a lower bound), never looked at (within the last 30
-- days) or waiting and due, in conversations that are not resolved and that no automation run is
-- handling. The worker computes the due time with the company's calendar and checks everything
-- again in the company's own scope under row locks. Ids only.
CREATE FUNCTION ops.slow_reply_turns(p_now timestamptz, p_limit integer)
  RETURNS TABLE (tenant_id uuid, turn_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT t.tenant_id, t.id
    FROM app.conversation_turns t
    JOIN app.tenants tn ON tn.id = t.tenant_id AND tn.status = 'active'
    JOIN app.messaging_settings s ON s.tenant_id = t.tenant_id AND s.slow_reply_enabled
    JOIN app.conversations c
      ON c.tenant_id = t.tenant_id AND c.id = t.conversation_id AND c.status <> 'resolved'
    LEFT JOIN app.slow_reply_messages r ON r.tenant_id = t.tenant_id AND r.turn_id = t.id
   WHERE t.ended_at IS NULL
     AND t.started_at >= s.slow_reply_since
     AND t.started_at <= p_now - make_interval(mins => s.slow_reply_delay_minutes)
     AND ((r.id IS NULL AND t.started_at > p_now - interval '30 days')
          OR (r.state = 'waiting' AND r.due_at <= p_now))
     AND NOT EXISTS (SELECT 1 FROM app.automation_runs ar
                      WHERE ar.tenant_id = t.tenant_id AND ar.conversation_id = t.conversation_id
                        AND ar.status IN ('running', 'waiting'))
   ORDER BY coalesce(r.due_at, t.started_at), t.id
   LIMIT least(greatest(p_limit, 1), 500)
$$;
GRANT SELECT (slow_reply_enabled, slow_reply_delay_minutes, slow_reply_since)
  ON app.messaging_settings TO w360_definer;
CREATE POLICY sweep_read ON app.slow_reply_messages FOR SELECT TO w360_definer USING (true);
GRANT SELECT (turn_id, state, due_at) ON app.slow_reply_messages TO w360_definer;
REVOKE EXECUTE ON FUNCTION ops.slow_reply_turns(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.slow_reply_turns(timestamptz, integer) TO w360_app;
ALTER FUNCTION ops.slow_reply_turns(timestamptz, integer) OWNER TO w360_definer;
