-- 0154_overdue_reply_notices: emailing members when a waiting customer's reply is overdue (P3-06,
-- ADR-230). The inbox shows when each reply is due (the company's first-response target, counted in
-- business hours when they are on, 0007 and 0009). The worker's minute sweep now emails the members
-- responsible once a reply is overdue: the member it is assigned to, else the members of its team,
-- else the members who assign conversations. Each reply turn is noticed at most once, recorded
-- here: `waiting` while business hours put the due time later than the sweep first looked (it looks
-- again at `due_at`), then `sent` or `skipped` for good. Rows hold ids, times and counts, never
-- message content, and go with their turn.
CREATE TABLE app.overdue_reply_notices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  state text NOT NULL
    CONSTRAINT overdue_reply_notices_state_check CHECK (state IN ('waiting', 'sent', 'skipped')),
  -- When the reply is due, as last computed (while waiting, when the sweep looks again).
  due_at timestamptz NOT NULL,
  -- The members emailed when sent.
  emailed integer NOT NULL DEFAULT 0
    CONSTRAINT overdue_reply_notices_emailed_check CHECK (emailed >= 0),
  skip_reason text
    CONSTRAINT overdue_reply_notices_skip_reason_check
    CHECK (skip_reason IN ('too_late', 'no_one', 'opted_out')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT overdue_reply_notices_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT overdue_reply_notices_turn_uq UNIQUE (tenant_id, turn_id),
  CONSTRAINT overdue_reply_notices_turn_fk FOREIGN KEY (tenant_id, turn_id)
    REFERENCES app.conversation_turns (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT overdue_reply_notices_outcome CHECK (
    (state = 'waiting' AND emailed = 0 AND skip_reason IS NULL)
    OR (state = 'sent' AND emailed > 0 AND skip_reason IS NULL)
    OR (state = 'skipped' AND emailed = 0 AND skip_reason IS NOT NULL))
);
-- The sweep's second look at the replies whose due time it put off.
CREATE INDEX overdue_reply_notices_waiting_idx ON app.overdue_reply_notices (due_at)
  WHERE state = 'waiting';
SELECT ops.apply_tenant_rls('app.overdue_reply_notices');
GRANT SELECT, INSERT ON app.overdue_reply_notices TO w360_app;
GRANT UPDATE (state, due_at, emailed, skip_reason, updated_at) ON app.overdue_reply_notices TO w360_app;

-- A notice that was sent or skipped never changes; a waiting one moves its due time or ends.
CREATE FUNCTION app.guard_overdue_reply_notice() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.state <> 'waiting' THEN
    RAISE EXCEPTION 'a sent or skipped overdue reply notice cannot change' USING ERRCODE = 'W3403';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER overdue_reply_notices_guard BEFORE UPDATE ON app.overdue_reply_notices
  FOR EACH ROW EXECUTE FUNCTION app.guard_overdue_reply_notice();

-- Deleted with the company (ADR-055), before the reply turns they belong to.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (325, ARRAY['app.overdue_reply_notices']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.overdue_reply_notices TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.overdue_reply_notices FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.overdue_reply_notices FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- The sweep: open reply turns of active companies with a first-response target that may be overdue
-- at p_now, either never looked at (started at least the target ago, within the last 30 days) or
-- waiting and due. Business hours only move a due time later, so the target in absolute time is a
-- lower bound; the worker computes the due time with the company's calendar in the company's own
-- scope. A turn is open only while the customer waits for a member (an automation answering
-- closes it, 0011), and a resolve closes it. Ids only.
CREATE FUNCTION ops.overdue_reply_turns(p_now timestamptz, p_limit integer)
  RETURNS TABLE (tenant_id uuid, turn_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT t.tenant_id, t.id
    FROM app.conversation_turns t
    JOIN app.tenants tn ON tn.id = t.tenant_id AND tn.status = 'active'
    JOIN app.messaging_settings s
      ON s.tenant_id = t.tenant_id AND s.first_response_target_minutes IS NOT NULL
    JOIN app.conversations c
      ON c.tenant_id = t.tenant_id AND c.id = t.conversation_id AND c.status <> 'resolved'
    LEFT JOIN app.overdue_reply_notices n ON n.tenant_id = t.tenant_id AND n.turn_id = t.id
   WHERE t.ended_at IS NULL
     AND t.started_at <= p_now - make_interval(mins => s.first_response_target_minutes)
     AND ((n.id IS NULL AND t.started_at > p_now - interval '30 days')
          OR (n.state = 'waiting' AND n.due_at <= p_now))
   ORDER BY coalesce(n.due_at, t.started_at), t.id
   LIMIT least(greatest(p_limit, 1), 500)
$$;
CREATE POLICY definer_read ON app.conversation_turns FOR SELECT TO w360_definer USING (true);
GRANT SELECT (tenant_id, id, conversation_id, started_at, ended_at) ON app.conversation_turns
  TO w360_definer;
GRANT SELECT (first_response_target_minutes) ON app.messaging_settings TO w360_definer;
CREATE POLICY sweep_read ON app.overdue_reply_notices FOR SELECT TO w360_definer USING (true);
GRANT SELECT (turn_id, state, due_at) ON app.overdue_reply_notices TO w360_definer;
REVOKE EXECUTE ON FUNCTION ops.overdue_reply_turns(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.overdue_reply_turns(timestamptz, integer) TO w360_app;
ALTER FUNCTION ops.overdue_reply_turns(timestamptz, integer) OWNER TO w360_definer;

-- Members turn these emails off like the other notices (0142, ADR-215). The table holds one row per
-- membership, so the check is replaced and validated here.
ALTER TABLE app.memberships DROP CONSTRAINT memberships_email_opt_outs_check;
ALTER TABLE app.memberships ADD CONSTRAINT memberships_email_opt_outs_check
  CHECK (email_opt_outs <@ ARRAY['mentions', 'reply_overdue', 'campaign_approvals',
    'campaign_reviews', 'campaign_pauses', 'campaign_completions']::text[]);
