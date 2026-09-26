-- 0009_inbox_advanced: teams and routing, member availability, business hours, conversation cases
-- (resolution times), saved replies, note mentions and CSAT surveys (P3-06).

-- Teams -------------------------------------------------------------------------------------------
-- A team groups members for routing and inbox views. Visibility is unchanged: teams decide who
-- receives new conversations automatically, not who may read them (see docs/SECURITY.md).
CREATE TABLE app.teams (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  description text CHECK (char_length(description) <= 300),
  -- manual: conversations wait in the team's queue; round_robin: available members receive them
  -- in turn, skipping members at their limit of open conversations.
  assignment text NOT NULL DEFAULT 'manual' CHECK (assignment IN ('manual', 'round_robin')),
  max_open_per_member smallint CHECK (max_open_per_member BETWEEN 1 AND 500),
  -- Whole words that route a customer's first message of a new case to this team (lower case,
  -- validated by the application; at most 20).
  routing_keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(routing_keywords) <= 20),
  -- Round-robin position: the member who most recently received a conversation automatically.
  last_assigned_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teams_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT teams_last_assigned_fk FOREIGN KEY (tenant_id, last_assigned_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE UNIQUE INDEX teams_name_uq ON app.teams (tenant_id, lower(btrim(name)));
CREATE TRIGGER teams_touch BEFORE UPDATE ON app.teams
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.team_members (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  team_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_members_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT team_members_uq UNIQUE (tenant_id, team_id, membership_id),
  CONSTRAINT team_members_team_fk FOREIGN KEY (tenant_id, team_id)
    REFERENCES app.teams (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT team_members_membership_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE INDEX team_members_membership_idx ON app.team_members (tenant_id, membership_id);

-- Whether a member takes new conversations automatically. No row means not available, so nobody
-- receives conversations before saying they are working.
CREATE TABLE app.member_availability (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  available boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_availability_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT member_availability_member_uq UNIQUE (tenant_id, membership_id),
  CONSTRAINT member_availability_member_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES app.memberships (tenant_id, id)
);

-- The team a conversation belongs to, and the team new conversations on a number start in. The
-- columns are new and empty, so validating the foreign keys reads no existing values.
ALTER TABLE app.conversations ADD COLUMN team_id uuid;
ALTER TABLE app.conversations ADD CONSTRAINT conversations_team_fk FOREIGN KEY (tenant_id, team_id)
  REFERENCES app.teams (tenant_id, id) ON DELETE SET NULL (team_id);
ALTER TABLE app.channel_accounts ADD COLUMN default_team_id uuid;
ALTER TABLE app.channel_accounts ADD CONSTRAINT channel_accounts_default_team_fk
  FOREIGN KEY (tenant_id, default_team_id) REFERENCES app.teams (tenant_id, id) ON DELETE SET NULL (default_team_id);

-- Business hours ------------------------------------------------------------------------------------
-- Weekly opening intervals in the company's time zone (ISO weekdays, 1 = Monday; '24:00' closes at
-- midnight) and whole-day closures. The application replaces a company's schedule as a whole and
-- rejects overlapping intervals.
CREATE TABLE app.business_hours (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  opens_at time NOT NULL,
  closes_at time NOT NULL,
  CONSTRAINT business_hours_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT business_hours_order CHECK (closes_at > opens_at)
);
CREATE INDEX business_hours_tenant_idx ON app.business_hours (tenant_id, weekday, opens_at);

CREATE TABLE app.business_holidays (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  day date NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_holidays_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT business_holidays_day_uq UNIQUE (tenant_id, day)
);

-- When on, reply-due timers and the first-response target count business hours only. CSAT sends a
-- rating question with three reply buttons after a member resolves a conversation (labels in the
-- order best, middle, worst; NULL uses the defaults).
ALTER TABLE app.messaging_settings
  ADD COLUMN business_hours_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN csat_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN csat_question text CHECK (char_length(btrim(csat_question)) BETWEEN 1 AND 1024),
  ADD COLUMN csat_labels text[] CHECK (cardinality(csat_labels) = 3);

-- Conversation cases ---------------------------------------------------------------------------------
-- A case runs from when a conversation opens (created, or reopened after a resolve) to when it is
-- resolved; resolution times are measured on cases. Like reply turns, cases are maintained by
-- triggers so every write path records them, and hold only timestamps and ids. Conversations that
-- were already open when this migration ran have no case until they are next reopened.
CREATE TABLE app.conversation_cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz,
  -- The member who resolved (NULL when resolved without a member) and the assignee at that moment
  -- (the member CSAT answers are credited to).
  resolved_by_membership_id uuid,
  assigned_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_cases_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT conversation_cases_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES app.conversations (tenant_id, id),
  CONSTRAINT conversation_cases_resolver_fk FOREIGN KEY (tenant_id, resolved_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT conversation_cases_assignee_fk FOREIGN KEY (tenant_id, assigned_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT conversation_cases_order CHECK (resolved_at IS NULL OR resolved_at >= opened_at),
  CONSTRAINT conversation_cases_open CHECK (
    resolved_at IS NOT NULL
    OR (resolved_by_membership_id IS NULL AND assigned_membership_id IS NULL))
);
CREATE UNIQUE INDEX conversation_cases_open_uq ON app.conversation_cases (tenant_id, conversation_id)
  WHERE resolved_at IS NULL;
CREATE INDEX conversation_cases_resolved_idx ON app.conversation_cases (tenant_id, resolved_at)
  WHERE resolved_at IS NOT NULL;

-- A resolved case never changes and an open case can only be resolved. The retention maintenance
-- setting may delete cases.
CREATE FUNCTION app.guard_conversation_case() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'conversation cases cannot be deleted' USING ERRCODE = 'W3403';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.conversation_id, NEW.opened_at, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.conversation_id, OLD.opened_at, OLD.created_at) THEN
    RAISE EXCEPTION 'what opened a case is fixed' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'a resolved case cannot change' USING ERRCODE = 'W3403';
  END IF;
  IF NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'an open case can only be resolved' USING ERRCODE = 'W3403';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER conversation_cases_guard BEFORE UPDATE OR DELETE ON app.conversation_cases
  FOR EACH ROW EXECUTE FUNCTION app.guard_conversation_case();

-- Opens a case when a conversation is created open or reopened, and closes it when resolved.
-- Runs with the writer's privileges (tenant-scoped runtime role), so RLS applies to case rows.
CREATE FUNCTION app.track_conversation_case() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.status = 'resolved' THEN
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'resolved' THEN
      UPDATE app.conversation_cases c
         SET resolved_at = greatest(coalesce(NEW.resolved_at, now()), c.opened_at),
             resolved_by_membership_id = (SELECT m.id FROM app.memberships m
                                           WHERE m.tenant_id = NEW.tenant_id AND m.user_id = app.current_user_id()),
             assigned_membership_id = NEW.assigned_membership_id
       WHERE c.tenant_id = NEW.tenant_id AND c.conversation_id = NEW.id AND c.resolved_at IS NULL;
    END IF;
  ELSIF TG_OP = 'INSERT' OR OLD.status = 'resolved' THEN
    INSERT INTO app.conversation_cases (id, tenant_id, conversation_id, opened_at)
    VALUES (gen_random_uuid(), NEW.tenant_id, NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NEW.created_at ELSE now() END)
    ON CONFLICT (tenant_id, conversation_id) WHERE resolved_at IS NULL DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER conversations_track_case_insert AFTER INSERT ON app.conversations
  FOR EACH ROW EXECUTE FUNCTION app.track_conversation_case();
CREATE TRIGGER conversations_track_case AFTER UPDATE OF status ON app.conversations
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app.track_conversation_case();

-- Saved replies --------------------------------------------------------------------------------------
-- Shared answers members insert into the composer; {{name}} and {{agent}} are filled in for the
-- conversation before the member reviews and sends the text.
CREATE TABLE app.saved_replies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  shortcut text NOT NULL CHECK (shortcut ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4096),
  created_by_membership_id uuid NOT NULL,
  updated_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_replies_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT saved_replies_shortcut_uq UNIQUE (tenant_id, shortcut),
  CONSTRAINT saved_replies_created_by_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT saved_replies_updated_by_fk FOREIGN KEY (tenant_id, updated_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE TRIGGER saved_replies_touch BEFORE UPDATE ON app.saved_replies
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Note mentions -------------------------------------------------------------------------------------
-- Members named on an internal note. Deleted with the note (contact erasure deletes notes).
CREATE TABLE app.note_mentions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  note_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_mentions_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT note_mentions_uq UNIQUE (tenant_id, note_id, membership_id),
  CONSTRAINT note_mentions_note_fk FOREIGN KEY (tenant_id, note_id)
    REFERENCES app.conversation_notes (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT note_mentions_member_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE INDEX note_mentions_member_idx ON app.note_mentions (tenant_id, membership_id, created_at DESC);

-- CSAT surveys --------------------------------------------------------------------------------------
-- One row per resolve that asked (or was due to ask) for a rating. A sent survey links the
-- outbound interactive message; a skipped one records why nothing was sent. The answer is the
-- customer's first button tap on that message: 3 = best label, 1 = worst.
CREATE TABLE app.csat_surveys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  case_id uuid,
  message_id uuid,
  skip_reason text CHECK (skip_reason IN ('window_closed', 'opted_out', 'suppressed', 'contact_erased',
    'no_phone', 'channel_inactive', 'recently_surveyed')),
  assigned_membership_id uuid,
  resolved_by_membership_id uuid,
  score smallint CHECK (score BETWEEN 1 AND 3),
  answered_at timestamptz,
  response_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT csat_surveys_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT csat_surveys_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES app.conversations (tenant_id, id),
  CONSTRAINT csat_surveys_case_fk FOREIGN KEY (tenant_id, case_id)
    REFERENCES app.conversation_cases (tenant_id, id) ON DELETE SET NULL (case_id),
  CONSTRAINT csat_surveys_message_fk FOREIGN KEY (tenant_id, message_id)
    REFERENCES app.messages (tenant_id, id) ON DELETE SET NULL (message_id),
  CONSTRAINT csat_surveys_response_fk FOREIGN KEY (tenant_id, response_message_id)
    REFERENCES app.messages (tenant_id, id) ON DELETE SET NULL (response_message_id),
  CONSTRAINT csat_surveys_assignee_fk FOREIGN KEY (tenant_id, assigned_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT csat_surveys_resolver_fk FOREIGN KEY (tenant_id, resolved_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT csat_surveys_answer CHECK ((score IS NULL) = (answered_at IS NULL)),
  CONSTRAINT csat_surveys_skipped CHECK (skip_reason IS NULL OR (message_id IS NULL AND score IS NULL))
);
CREATE UNIQUE INDEX csat_surveys_message_uq ON app.csat_surveys (tenant_id, message_id)
  WHERE message_id IS NOT NULL;
CREATE INDEX csat_surveys_conversation_idx ON app.csat_surveys (tenant_id, conversation_id, created_at DESC);
CREATE INDEX csat_surveys_created_idx ON app.csat_surveys (tenant_id, created_at);

-- An answer is recorded once; nothing else about a survey changes.
CREATE FUNCTION app.guard_csat_survey() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CSAT surveys cannot be deleted' USING ERRCODE = 'W3403';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.conversation_id, NEW.case_id, NEW.skip_reason, NEW.assigned_membership_id,
      NEW.resolved_by_membership_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.conversation_id, OLD.case_id, OLD.skip_reason, OLD.assigned_membership_id,
      OLD.resolved_by_membership_id, OLD.created_at) THEN
    RAISE EXCEPTION 'a CSAT survey only records its first answer' USING ERRCODE = 'W3403';
  END IF;
  -- Clearing message references (ON DELETE SET NULL of a purged message) and nothing else.
  IF (NEW.score, NEW.answered_at) IS NOT DISTINCT FROM (OLD.score, OLD.answered_at)
     AND (NEW.message_id IS NULL OR NEW.message_id IS NOT DISTINCT FROM OLD.message_id)
     AND (NEW.response_message_id IS NULL OR NEW.response_message_id IS NOT DISTINCT FROM OLD.response_message_id) THEN
    RETURN NEW;
  END IF;
  -- Otherwise this must be the first answer to a sent survey.
  IF OLD.answered_at IS NOT NULL OR NEW.answered_at IS NULL OR OLD.message_id IS NULL
     OR NEW.message_id IS DISTINCT FROM OLD.message_id THEN
    RAISE EXCEPTION 'a CSAT survey only records its first answer' USING ERRCODE = 'W3403';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER csat_surveys_guard BEFORE UPDATE OR DELETE ON app.csat_surveys
  FOR EACH ROW EXECUTE FUNCTION app.guard_csat_survey();

-- A customer's tap on a CSAT button answers the survey; it is not a new question for the team, so it
-- does not open a reply turn. Otherwise unchanged from 0007.
CREATE OR REPLACE FUNCTION app.track_conversation_turn() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.direction = 'inbound' AND NEW.sender_type = 'contact' AND NEW.type NOT IN ('reaction', 'system')
     AND NOT (NEW.type = 'interactive' AND coalesce(NEW.content #>> '{reply,id}', '') LIKE 'w360csat:%') THEN
    INSERT INTO app.conversation_turns (id, tenant_id, conversation_id, first_message_id, started_at)
    VALUES (gen_random_uuid(), NEW.tenant_id, NEW.conversation_id, NEW.id, NEW.created_at)
    ON CONFLICT (tenant_id, conversation_id) WHERE ended_at IS NULL DO NOTHING;
  ELSIF NEW.direction = 'outbound' AND NEW.sender_type = 'agent' THEN
    UPDATE app.conversation_turns t
       SET ended_at = greatest(NEW.created_at, t.started_at), end_reason = 'replied',
           ended_by_membership_id = NEW.sender_membership_id, reply_message_id = NEW.id
     WHERE t.tenant_id = NEW.tenant_id AND t.conversation_id = NEW.conversation_id AND t.ended_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;

-- Routing sweep input (ids only, across companies) ---------------------------------------------------
-- Unassigned open conversations of active companies in round-robin teams that have at least one
-- available active member. The router re-checks everything under the company's routing lock.
CREATE FUNCTION ops.conversations_to_route(p_limit integer)
  RETURNS TABLE (tenant_id uuid, conversation_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT c.tenant_id, c.id
    FROM app.conversations c
    JOIN app.tenants t ON t.id = c.tenant_id AND t.status = 'active'
    JOIN app.teams tm ON tm.tenant_id = c.tenant_id AND tm.id = c.team_id AND tm.assignment = 'round_robin'
   WHERE c.status IN ('open', 'pending') AND c.assigned_membership_id IS NULL
     AND EXISTS (SELECT 1
                   FROM app.team_members x
                   JOIN app.member_availability a
                     ON a.tenant_id = x.tenant_id AND a.membership_id = x.membership_id AND a.available
                   JOIN app.memberships m
                     ON m.tenant_id = x.tenant_id AND m.id = x.membership_id AND m.status = 'active'
                  WHERE x.tenant_id = c.tenant_id AND x.team_id = c.team_id)
   ORDER BY c.last_inbound_at NULLS LAST, c.id
   LIMIT least(greatest(p_limit, 1), 500)
$$;

-- Row level security and privileges --------------------------------------------------------------
SELECT ops.apply_tenant_rls('app.teams');
SELECT ops.apply_tenant_rls('app.team_members');
SELECT ops.apply_tenant_rls('app.member_availability');
SELECT ops.apply_tenant_rls('app.business_hours');
SELECT ops.apply_tenant_rls('app.business_holidays');
SELECT ops.apply_tenant_rls('app.conversation_cases');
SELECT ops.apply_tenant_rls('app.saved_replies');
SELECT ops.apply_tenant_rls('app.note_mentions');
SELECT ops.apply_tenant_rls('app.csat_surveys');

GRANT SELECT, INSERT, DELETE ON app.teams TO w360_app;
GRANT UPDATE (name, description, assignment, max_open_per_member, routing_keywords, last_assigned_membership_id,
  updated_at) ON app.teams TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.team_members TO w360_app;
GRANT SELECT, INSERT ON app.member_availability TO w360_app;
GRANT UPDATE (available, changed_at) ON app.member_availability TO w360_app;
GRANT UPDATE (team_id) ON app.conversations TO w360_app;
GRANT UPDATE (default_team_id) ON app.channel_accounts TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.business_hours TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.business_holidays TO w360_app;
GRANT UPDATE (business_hours_enabled, csat_enabled, csat_question, csat_labels) ON app.messaging_settings TO w360_app;
GRANT SELECT, INSERT ON app.conversation_cases TO w360_app;
GRANT UPDATE (resolved_at, resolved_by_membership_id, assigned_membership_id) ON app.conversation_cases TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.saved_replies TO w360_app;
GRANT UPDATE (shortcut, title, body, updated_by_membership_id, updated_at) ON app.saved_replies TO w360_app;
GRANT SELECT, INSERT ON app.note_mentions TO w360_app;
GRANT UPDATE (read_at) ON app.note_mentions TO w360_app;
GRANT SELECT, INSERT ON app.csat_surveys TO w360_app;
GRANT UPDATE (score, answered_at, response_message_id) ON app.csat_surveys TO w360_app;

-- The routing sweep reads ids and routing facts only.
CREATE POLICY definer_read ON app.teams FOR SELECT TO w360_definer USING (true);
CREATE POLICY definer_read ON app.team_members FOR SELECT TO w360_definer USING (true);
CREATE POLICY definer_read ON app.member_availability FOR SELECT TO w360_definer USING (true);
GRANT SELECT (tenant_id, id, assignment) ON app.teams TO w360_definer;
GRANT SELECT (tenant_id, team_id, membership_id) ON app.team_members TO w360_definer;
GRANT SELECT (tenant_id, membership_id, available) ON app.member_availability TO w360_definer;
GRANT SELECT (tenant_id, id, status, assigned_membership_id, team_id, last_inbound_at) ON app.conversations TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.conversations_to_route(integer) TO w360_app;
ALTER FUNCTION ops.conversations_to_route(integer) OWNER TO w360_definer;

-- Metric definitions -------------------------------------------------------------------------------
-- New versions of inbox definitions that now distinguish absolute and business-hours time, and the
-- metrics added by this slice (registry: packages/domain/src/reports/definitions.ts).
INSERT INTO ops.metric_definitions (key, version, label, unit, description, numerator, denominator, window_rule,
  timezone_rule, missing_data, freshness, available) VALUES
  ('inbox.oldest_wait', 2, 'Longest wait', 'duration',
   'How long the longest-waiting customer has been waiting for a reply.',
   'Time since the start of the oldest open reply turn.',
   NULL,
   NULL,
   NULL,
   'Measured in absolute time, including hours outside business hours.',
   'The state when the page loads.', true),
  ('inbox.overdue', 1, 'Overdue', 'count',
   'Waiting conversations whose customer has waited longer than the company’s first-response target.',
   'Open reply turns that have waited longer than the target.',
   NULL,
   'The target, counted in business hours when business hours are on (Settings → Messaging → Business hours), otherwise in absolute time.',
   NULL,
   'Shown only when a target is set. Reply turns are recorded from the release of reports onwards.',
   'The state when the page loads.', true),
  ('inbox.first_response_time', 2, 'First response time', 'duration',
   'Time from the start of a reply turn to the first reply by a member, reported as the median and the 90th percentile.',
   'Reply times of answered turns.',
   'Turns that started in the period and were answered.',
   'From when HyFib received the customer’s first waiting message to when the member sent the reply, in absolute time, including hours outside business hours (see First response in business hours).',
   'A reply turn starts with the first customer message that has no reply from a member yet and ends when a member replies or the conversation is resolved. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Turns still waiting are not in the median; see Waiting. A reply counts when the member sends it, even if WhatsApp later rejects it (see Failed). Reply turns are recorded from the release of reports onwards.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('inbox.first_response_business_time', 1, 'First response in business hours', 'duration',
   'Time from the start of a reply turn to the first reply by a member, counting business hours only, reported as the median and the 90th percentile.',
   'Business-hours reply times of answered turns.',
   'Turns that started in the period and were answered.',
   'Only time inside the company’s business hours counts (Settings → Messaging → Business hours); closed days and hours outside the weekly schedule are skipped, in the company’s time zone.',
   'A reply turn starts with the first customer message that has no reply from a member yet and ends when a member replies or the conversation is resolved. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Shown only when business hours are on. The current schedule and closed days are applied to the whole period, including turns from before a change.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('inbox.within_target', 2, 'Answered within target', 'rate',
   'Share of reply turns answered within the company’s first-response target (Settings → Messaging).',
   'Turns answered within the target.',
   'Turns that started in the period and were answered or have waited longer than the target. Turns resolved without a reply and turns still within the target are left out.',
   'The target, counted in business hours when business hours are on (Settings → Messaging → Business hours), otherwise in absolute time.',
   'A reply turn starts with the first customer message that has no reply from a member yet and ends when a member replies or the conversation is resolved. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Shown only when a target is set. With business hours on, the current schedule and closed days are applied to the whole period.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('inbox.resolution_time', 1, 'Resolution time', 'duration',
   'Time from when a conversation opened, or reopened after being resolved, to when it was resolved, reported as the median and the 90th percentile.',
   'Durations of cases resolved in the period.',
   'Cases resolved in the period.',
   'Absolute time, including hours outside business hours.',
   'Counted by the time the case was resolved, in calendar days of the company’s time zone.',
   'Cases are recorded from the release of inbox teams onwards; a conversation that was already open then is counted from its next reopening.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('csat.surveys', 1, 'CSAT surveys', 'count',
   'Rating questions sent after a member resolved a conversation, and resolves that sent none, by reason: the 24-hour window had closed, the customer opted out, the number is suppressed, the contact was erased, the contact has no phone number, the WhatsApp number is inactive, or the customer was asked in the last 24 hours.',
   'Surveys created in the period, by outcome.',
   NULL,
   NULL,
   'Counted by the time the survey was created (when the conversation was resolved), in calendar days of the company’s time zone.',
   'None: every survey that was not sent records its reason.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('csat.response_rate', 1, 'CSAT response rate', 'rate',
   'Share of delivered rating questions that the customer answered.',
   'Surveys with an answer.',
   'Surveys created in the period whose message WhatsApp delivered (delivered, read or answered).',
   'Answers count whenever they arrive; only the first tap on the question counts.',
   'Counted by the time the survey was created (when the conversation was resolved), in calendar days of the company’s time zone.',
   'Delivery statuses come from Meta’s webhooks and can arrive late; a late status moves a survey into the denominator.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('csat.score', 1, 'CSAT', 'rate',
   'Share of answers that chose the best of the three ratings; the other answers are shown next to it.',
   'Answers with the best rating.',
   'Answered surveys created in the period.',
   NULL,
   'Counted by the time the survey was created (when the conversation was resolved), in calendar days of the company’s time zone.',
   'With few answers the share is unstable, so the number of answers is shown with it.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('agent.first_response_time', 2, 'Median first response', 'duration',
   'Median reply time of the turns the member answered.',
   'Reply times of the turns the member answered.',
   'Turns the member answered in the period.',
   'Absolute time, including hours outside business hours.',
   'Counted by the time the turn was answered, in calendar days of the company’s time zone.',
   'Reply turns are recorded from the release of reports onwards.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('agent.csat', 1, 'CSAT', 'rate',
   'Share of best ratings among the answers to rating questions sent after the member’s conversations were resolved.',
   'Best-rated answers credited to the member.',
   'Answered surveys credited to the member: the conversation was assigned to them when it was resolved.',
   NULL,
   'Counted by the time the survey was created (when the conversation was resolved), in calendar days of the company’s time zone.',
   'Surveys of conversations resolved while unassigned are credited to nobody.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true);
