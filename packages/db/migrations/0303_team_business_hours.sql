-- 0303_team_business_hours: business hours per team (P3-06, ADR-389).
--
-- Business hours were the company's only (0009, Settings → Inbox): one weekly schedule for every
-- conversation. A team can now have its own weekly schedule, set with the team's other settings
-- (Settings → Teams, POST/PATCH /teams). While the company's business hours are on, a conversation
-- of such a team counts business time by the team's schedule, and every other conversation by the
-- company's: in the inbox's reply timers and notice, the overdue-reply emails (0154), reports and
-- the automatic reply when members are slow (0300). Closed days and the time zone stay the
-- company's and apply to every team. A team without rows here uses the company's schedule, so
-- existing teams keep it. Rows hold weekdays and times only, no personal data.
CREATE TABLE app.team_business_hours (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  team_id uuid NOT NULL,
  weekday smallint NOT NULL
    CONSTRAINT team_business_hours_weekday_check CHECK (weekday BETWEEN 1 AND 7),
  opens_at time NOT NULL
    CONSTRAINT team_business_hours_opens_check CHECK (opens_at < '24:00'),
  -- '24:00' closes at midnight at the end of the day.
  closes_at time NOT NULL,
  CONSTRAINT team_business_hours_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- Ranges never overlap (checked when a week is saved); two rows opening at once never exist.
  CONSTRAINT team_business_hours_range_uq UNIQUE (tenant_id, team_id, weekday, opens_at),
  CONSTRAINT team_business_hours_team_fk FOREIGN KEY (tenant_id, team_id)
    REFERENCES app.teams (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT team_business_hours_order CHECK (closes_at > opens_at)
);
-- One read per request or sweep loads every team's schedule of the company, in order: the range
-- constraint's index serves it.
SELECT ops.apply_tenant_rls('app.team_business_hours');
-- The application replaces a team's schedule as a whole (delete, then insert).
GRANT SELECT, INSERT, DELETE ON app.team_business_hours TO w360_app;

-- Deleted with the company (ADR-055), before the teams they belong to (800).
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (655, ARRAY['app.team_business_hours']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.team_business_hours TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.team_business_hours FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.team_business_hours FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- A conversation that changes team may change calendar (and target, ADR-377): the automatic reply
-- (0300) and the overdue-reply notice (0154) its open reply turn waits for are planned again by
-- the next sweep, from the calendar of the team it is in now, instead of at the time the old one
-- put them off to. A trigger covers every way a conversation changes team (the inbox, the API, a
-- team's deletion, automations, routing). It runs as the caller (w360_app), which may update
-- these columns of waiting rows; the guard triggers keep sent and skipped rows as they are.
CREATE FUNCTION app.replan_waiting_turn_on_team_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  UPDATE app.slow_reply_messages r
     SET due_at = now(), updated_at = now()
    FROM app.conversation_turns t
   WHERE t.tenant_id = NEW.tenant_id AND t.conversation_id = NEW.id AND t.ended_at IS NULL
     AND r.tenant_id = t.tenant_id AND r.turn_id = t.id AND r.state = 'waiting';
  UPDATE app.overdue_reply_notices n
     SET due_at = now(), updated_at = now()
    FROM app.conversation_turns t
   WHERE t.tenant_id = NEW.tenant_id AND t.conversation_id = NEW.id AND t.ended_at IS NULL
     AND n.tenant_id = t.tenant_id AND n.turn_id = t.id AND n.state = 'waiting';
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.replan_waiting_turn_on_team_change() FROM PUBLIC;
CREATE TRIGGER conversations_replan_waiting_turn AFTER UPDATE OF team_id ON app.conversations
  FOR EACH ROW WHEN (OLD.team_id IS DISTINCT FROM NEW.team_id)
  EXECUTE FUNCTION app.replan_waiting_turn_on_team_change();

-- Metric definitions (reports/definitions.ts; a test keeps them equal): the measures that count
-- business time now use the business hours of the conversation's team when it has its own.
INSERT INTO ops.metric_definitions (key, version, label, unit, description, numerator, denominator, window_rule,
  timezone_rule, missing_data, freshness, available) VALUES
  ('inbox.overdue', 4, 'Overdue', 'count',
   'Waiting conversations whose customer has waited longer than the first-response target of the conversation’s team, or the company’s when the team has none or the conversation has no team. After an automation’s hand-off the wait counts from the hand-off.',
   'Open reply turns that have waited longer than their target.',
   NULL,
   'The target, counted in business hours when business hours are on (Settings → Inbox): those of the conversation’s team when it has its own (Settings → Teams), else the company’s; otherwise in absolute time. Closed days and the time zone are the company’s.',
   NULL,
   'Shown only when the company or one of its teams has a target. A conversation counts against the target and business hours of the team it is in now. Reply turns are recorded from the release of reports onwards.',
   'The state when the page loads.', true),
  ('inbox.first_response_business_time', 3, 'First response in business hours', 'duration',
   'Time from the start of a reply turn to the first reply by a member, counting business hours only, reported as the median and the 90th percentile.',
   'Business-hours reply times of answered turns.',
   'Turns that started in the period and were answered.',
   'Only time inside business hours counts: those of the conversation’s team when it has its own (Settings → Teams), else the company’s (Settings → Inbox). The company’s closed days and hours outside the weekly schedule are skipped, in the company’s time zone.',
   'A reply turn starts with the first customer message that has no reply from a member yet, or when an automation passes the conversation to people, and ends when a member replies or the conversation is resolved. No turn is open while an automation is handling the conversation, and a turn that was open when an automation took over is left out. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Shown only when business hours are on. Each turn uses the business hours of the team its conversation is in now, and the current schedules and closed days are applied to the whole period, including turns from before a change.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('inbox.within_target', 5, 'Answered within target', 'rate',
   'Share of reply turns answered within their target: the first-response target of the conversation’s team (Settings → Teams), or the company’s (Settings → Inbox) when the team has none or the conversation has no team.',
   'Turns answered within their target.',
   'Turns that started in the period and were answered or have waited longer than their target. Turns resolved without a reply, turns still within their target, turns an automation took over and turns of conversations without any target are left out.',
   'The target, counted in business hours when business hours are on (Settings → Inbox): those of the conversation’s team when it has its own (Settings → Teams), else the company’s; otherwise in absolute time. Closed days and the time zone are the company’s.',
   'A reply turn starts with the first customer message that has no reply from a member yet, or when an automation passes the conversation to people, and ends when a member replies or the conversation is resolved. No turn is open while an automation is handling the conversation, and a turn that was open when an automation took over is left out. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Shown only when the company or one of its teams has a target. Each turn is measured against the target and business hours of the team its conversation is in now, and with business hours on, the current schedules and closed days are applied to the whole period.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true);
