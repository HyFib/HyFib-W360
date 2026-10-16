-- Per-team first-response targets (P3-06, ADR-377).
--
-- The first-response target was the company's only (0007, Settings → Inbox). A team can now have
-- its own: a waiting customer's reply in a conversation of the team is due against the team's
-- target, and in every other conversation against the company's, in the inbox's timers and notice,
-- the overdue-reply emails (0154) and reports. A team without a target uses the company's, and a
-- conversation counts against the target of the team it is in now.
ALTER TABLE app.teams ADD COLUMN first_response_target_minutes smallint
  CONSTRAINT teams_first_response_target_check
  CHECK (first_response_target_minutes BETWEEN 1 AND 1440);
GRANT UPDATE (first_response_target_minutes) ON app.teams TO w360_app;

-- The overdue-reply sweep (0154) with the target of the conversation's team when it has one, else
-- the company's: a company without a target of its own may have teams with one. Business hours
-- only move a due time later, so the target in absolute time stays a lower bound; the worker
-- computes the due time in the company's own scope. The function belongs to w360_definer, so that
-- role drops it; the migration role creates the new one and grants before handing it over.
SET ROLE w360_definer;
DROP FUNCTION ops.overdue_reply_turns(timestamptz, integer);
RESET ROLE;
CREATE FUNCTION ops.overdue_reply_turns(p_now timestamptz, p_limit integer)
  RETURNS TABLE (tenant_id uuid, turn_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT t.tenant_id, t.id
    FROM app.conversation_turns t
    JOIN app.tenants tn ON tn.id = t.tenant_id AND tn.status = 'active'
    JOIN app.conversations c
      ON c.tenant_id = t.tenant_id AND c.id = t.conversation_id AND c.status <> 'resolved'
    LEFT JOIN app.teams tm ON tm.tenant_id = c.tenant_id AND tm.id = c.team_id
    LEFT JOIN app.messaging_settings s ON s.tenant_id = t.tenant_id
    LEFT JOIN app.overdue_reply_notices n ON n.tenant_id = t.tenant_id AND n.turn_id = t.id
    CROSS JOIN LATERAL (
      SELECT coalesce(tm.first_response_target_minutes, s.first_response_target_minutes) AS minutes
    ) target
   WHERE t.ended_at IS NULL
     AND target.minutes IS NOT NULL
     AND t.started_at <= p_now - make_interval(mins => target.minutes)
     AND ((n.id IS NULL AND t.started_at > p_now - interval '30 days')
          OR (n.state = 'waiting' AND n.due_at <= p_now))
   ORDER BY coalesce(n.due_at, t.started_at), t.id
   LIMIT least(greatest(p_limit, 1), 500)
$$;
GRANT SELECT (first_response_target_minutes) ON app.teams TO w360_definer;
REVOKE EXECUTE ON FUNCTION ops.overdue_reply_turns(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.overdue_reply_turns(timestamptz, integer) TO w360_app;
ALTER FUNCTION ops.overdue_reply_turns(timestamptz, integer) OWNER TO w360_definer;

-- Metric definitions (reports/definitions.ts; a test keeps them equal): the overdue count and the
-- share answered within the target now measure each conversation against its team's target.
INSERT INTO ops.metric_definitions (key, version, label, unit, description, numerator, denominator, window_rule,
  timezone_rule, missing_data, freshness, available) VALUES
  ('inbox.overdue', 3, 'Overdue', 'count',
   'Waiting conversations whose customer has waited longer than the first-response target of the conversation’s team, or the company’s when the team has none or the conversation has no team. After an automation’s hand-off the wait counts from the hand-off.',
   'Open reply turns that have waited longer than their target.',
   NULL,
   'The target, counted in business hours when business hours are on (Settings → Messaging → Business hours), otherwise in absolute time.',
   NULL,
   'Shown only when the company or one of its teams has a target. A conversation counts against the target of the team it is in now. Reply turns are recorded from the release of reports onwards.',
   'The state when the page loads.', true),
  ('inbox.within_target', 4, 'Answered within target', 'rate',
   'Share of reply turns answered within their target: the first-response target of the conversation’s team (Settings → Teams), or the company’s (Settings → Inbox) when the team has none or the conversation has no team.',
   'Turns answered within their target.',
   'Turns that started in the period and were answered or have waited longer than their target. Turns resolved without a reply, turns still within their target, turns an automation took over and turns of conversations without any target are left out.',
   'The target, counted in business hours when business hours are on (Settings → Messaging → Business hours), otherwise in absolute time.',
   'A reply turn starts with the first customer message that has no reply from a member yet, or when an automation passes the conversation to people, and ends when a member replies or the conversation is resolved. No turn is open while an automation is handling the conversation, and a turn that was open when an automation took over is left out. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Shown only when the company or one of its teams has a target. Each turn is measured against the target of the team its conversation is in now, and with business hours on, the current schedule and closed days are applied to the whole period.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true);
