-- 0307_team_closed_days: closed days per team (P3-06, ADR-392).
--
-- Closed days were the company's only (0009, Settings → Inbox): a public holiday closed every team,
-- even one that works on holidays, and a team could not close on a day of its own. A team now
-- either uses the company's closed days (the default; every existing team keeps them) or has its
-- own list, set with the team's other settings (Settings → Teams, POST/PATCH /teams), which
-- replaces the company's for it and may be empty (the team works every day its week opens). While
-- the company's business hours are on, a conversation of such a team counts business time without
-- the team's own closed days instead of the company's: in the inbox's reply timers and notice, the
-- overdue-reply emails (0154), reports and the automatic reply when members are slow (0300). The
-- time zone stays the company's, and dates are days of it, as the company's closed days are. Rows
-- hold dates only, no personal data.

-- "Its own list, possibly empty": a flag on the team, so an empty list is told apart from the
-- company's. Members and keys who manage teams set it (the team's row is inserted whole; updates
-- name the column).
ALTER TABLE app.teams ADD COLUMN own_closed_days boolean NOT NULL DEFAULT false;
GRANT UPDATE (own_closed_days) ON app.teams TO w360_app;

CREATE TABLE app.team_closed_days (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  team_id uuid NOT NULL,
  -- A day of the company's time zone.
  day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_closed_days_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- A day is in a team's list once. Its index serves the one read per request or sweep of every
  -- team's days (by team, in order).
  CONSTRAINT team_closed_days_day_uq UNIQUE (tenant_id, team_id, day),
  CONSTRAINT team_closed_days_team_fk FOREIGN KEY (tenant_id, team_id)
    REFERENCES app.teams (tenant_id, id) ON DELETE CASCADE
);
SELECT ops.apply_tenant_rls('app.team_closed_days');
-- The application replaces a team's list as a whole (delete, then insert).
GRANT SELECT, INSERT, DELETE ON app.team_closed_days TO w360_app;

-- Deleted with the company (ADR-055), before the teams they belong to (800), beside the teams'
-- weeks (655).
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (656, ARRAY['app.team_closed_days']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.team_closed_days TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.team_closed_days FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.team_closed_days FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- Metric definitions (reports/definitions.ts; a test keeps them equal): the measures that count
-- business time now skip the closed days of the conversation's team when it has its own.
INSERT INTO ops.metric_definitions (key, version, label, unit, description, numerator, denominator, window_rule,
  timezone_rule, missing_data, freshness, available) VALUES
  ('inbox.overdue', 5, 'Overdue', 'count',
   'Waiting conversations whose customer has waited longer than the first-response target of the conversation’s team, or the company’s when the team has none or the conversation has no team. After an automation’s hand-off the wait counts from the hand-off.',
   'Open reply turns that have waited longer than their target.',
   NULL,
   'The target, counted in business hours when business hours are on (Settings → Inbox): the weekly schedule and the closed days of the conversation’s team when it has its own (Settings → Teams), else the company’s; otherwise in absolute time. The time zone is the company’s.',
   NULL,
   'Shown only when the company or one of its teams has a target. A conversation counts against the target, business hours and closed days of the team it is in now. Reply turns are recorded from the release of reports onwards.',
   'The state when the page loads.', true),
  ('inbox.first_response_business_time', 4, 'First response in business hours', 'duration',
   'Time from the start of a reply turn to the first reply by a member, counting business hours only, reported as the median and the 90th percentile.',
   'Business-hours reply times of answered turns.',
   'Turns that started in the period and were answered.',
   'Only time inside business hours counts: the weekly schedule of the conversation’s team when it has its own (Settings → Teams), else the company’s (Settings → Inbox). Hours outside it and closed days are skipped: the team’s own closed days when it has them, else the company’s, in the company’s time zone.',
   'A reply turn starts with the first customer message that has no reply from a member yet, or when an automation passes the conversation to people, and ends when a member replies or the conversation is resolved. No turn is open while an automation is handling the conversation, and a turn that was open when an automation took over is left out. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Shown only when business hours are on. Each turn uses the business hours and closed days of the team its conversation is in now, and the current schedules and closed days are applied to the whole period, including turns from before a change.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('inbox.within_target', 6, 'Answered within target', 'rate',
   'Share of reply turns answered within their target: the first-response target of the conversation’s team (Settings → Teams), or the company’s (Settings → Inbox) when the team has none or the conversation has no team.',
   'Turns answered within their target.',
   'Turns that started in the period and were answered or have waited longer than their target. Turns resolved without a reply, turns still within their target, turns an automation took over and turns of conversations without any target are left out.',
   'The target, counted in business hours when business hours are on (Settings → Inbox): the weekly schedule and the closed days of the conversation’s team when it has its own (Settings → Teams), else the company’s; otherwise in absolute time. The time zone is the company’s.',
   'A reply turn starts with the first customer message that has no reply from a member yet, or when an automation passes the conversation to people, and ends when a member replies or the conversation is resolved. No turn is open while an automation is handling the conversation, and a turn that was open when an automation took over is left out. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Shown only when the company or one of its teams has a target. Each turn is measured against the target, business hours and closed days of the team its conversation is in now, and with business hours on, the current schedules and closed days are applied to the whole period.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true);
