-- 0013_crm: CRM (P4-04). Pipelines with ordered stages and one currency each, deals linked to a
-- contact (and optionally the conversation they came from), tasks with reminders delivered by email
-- through durable jobs, an append-only activity timeline per contact and deal, erasure of the CRM
-- free text, and deal outcome metrics.

-- Pipelines and stages ----------------------------------------------------------------------------
-- A pipeline's currency never changes (runtime roles cannot update it), so every value in it, and
-- every total on its board, is in one currency. Stages are open stages in order; won and lost are
-- deal statuses, not stages. Stages and pipelines are archived, never deleted, so closed deals
-- keep pointing at the stage they ended in.
CREATE TABLE app.crm_pipelines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  archived_at timestamptz,
  -- Optimistic concurrency for settings editors: every change increments it.
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_pipelines_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT crm_pipelines_created_by_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE UNIQUE INDEX crm_pipelines_name_uq ON app.crm_pipelines (tenant_id, lower(btrim(name)))
  WHERE archived_at IS NULL;
CREATE TRIGGER crm_pipelines_touch BEFORE UPDATE ON app.crm_pipelines
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.crm_stages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  position integer NOT NULL CHECK (position >= 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_stages_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- Lets deals reference a stage together with its pipeline (a deal's stage is in its pipeline).
  CONSTRAINT crm_stages_pipeline_id_uq UNIQUE (tenant_id, pipeline_id, id),
  CONSTRAINT crm_stages_pipeline_fk FOREIGN KEY (tenant_id, pipeline_id)
    REFERENCES app.crm_pipelines (tenant_id, id)
);
CREATE INDEX crm_stages_pipeline_idx ON app.crm_stages (tenant_id, pipeline_id, position);
CREATE TRIGGER crm_stages_touch BEFORE UPDATE ON app.crm_stages
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Deals -------------------------------------------------------------------------------------------
-- Money is an integer in the pipeline currency's minor unit. A deal belongs to one contact for
-- life (runtime roles cannot change contact_id), which keeps its tasks and timeline consistent.
CREATE TABLE app.crm_deals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  -- The conversation the deal was created from, if any (a conversation of the same contact).
  conversation_id uuid,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  value_minor bigint CHECK (value_minor BETWEEN 0 AND 1000000000000000),
  owner_membership_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  lost_reason text CHECK (char_length(lost_reason) <= 200),
  expected_close_on date,
  stage_entered_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by_membership_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_deals_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT crm_deals_contact_uq UNIQUE (tenant_id, id, contact_id),
  CONSTRAINT crm_deals_stage_fk FOREIGN KEY (tenant_id, pipeline_id, stage_id)
    REFERENCES app.crm_stages (tenant_id, pipeline_id, id),
  CONSTRAINT crm_deals_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES app.contacts (tenant_id, id),
  CONSTRAINT crm_deals_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES app.conversations (tenant_id, id),
  CONSTRAINT crm_deals_owner_fk FOREIGN KEY (tenant_id, owner_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT crm_deals_closed_by_fk FOREIGN KEY (tenant_id, closed_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT crm_deals_created_by_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT crm_deals_closed CHECK (
    (status = 'open' AND closed_at IS NULL AND closed_by_membership_id IS NULL)
    OR (status IN ('won', 'lost') AND closed_at IS NOT NULL)),
  CONSTRAINT crm_deals_lost_reason CHECK (status = 'lost' OR lost_reason IS NULL)
);
CREATE INDEX crm_deals_board_idx ON app.crm_deals (tenant_id, pipeline_id, status, stage_id);
CREATE INDEX crm_deals_contact_idx ON app.crm_deals (tenant_id, contact_id, created_at DESC);
CREATE INDEX crm_deals_owner_idx ON app.crm_deals (tenant_id, owner_membership_id, status);
CREATE INDEX crm_deals_closed_idx ON app.crm_deals (tenant_id, closed_at) WHERE closed_at IS NOT NULL;
CREATE TRIGGER crm_deals_touch BEFORE UPDATE ON app.crm_deals
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Tasks -------------------------------------------------------------------------------------------
-- A task is assigned to one member and may be about a contact or one of its deals (a deal's task
-- is always about the deal's contact; the links never change). A reminder is emailed once to the
-- assignee at remind_at: reminder_state moves from pending to sent (or skipped, with the reason)
-- in the same transaction that queues the email.
CREATE TABLE app.crm_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  notes text CHECK (char_length(notes) <= 2000),
  contact_id uuid,
  deal_id uuid,
  assignee_membership_id uuid NOT NULL,
  due_at timestamptz,
  remind_at timestamptz,
  reminder_state text NOT NULL DEFAULT 'none'
    CHECK (reminder_state IN ('none', 'pending', 'sent', 'skipped')),
  reminder_detail text CHECK (char_length(reminder_detail) <= 60),
  reminded_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  completed_at timestamptz,
  completed_by_membership_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_tasks_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT crm_tasks_contact_uq UNIQUE (tenant_id, id, contact_id),
  CONSTRAINT crm_tasks_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES app.contacts (tenant_id, id),
  CONSTRAINT crm_tasks_deal_fk FOREIGN KEY (tenant_id, deal_id, contact_id)
    REFERENCES app.crm_deals (tenant_id, id, contact_id),
  CONSTRAINT crm_tasks_assignee_fk FOREIGN KEY (tenant_id, assignee_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT crm_tasks_completed_by_fk FOREIGN KEY (tenant_id, completed_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT crm_tasks_created_by_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT crm_tasks_deal_contact CHECK (deal_id IS NULL OR contact_id IS NOT NULL),
  CONSTRAINT crm_tasks_done CHECK (
    (status = 'open' AND completed_at IS NULL AND completed_by_membership_id IS NULL)
    OR (status IN ('done', 'cancelled') AND completed_at IS NOT NULL)),
  CONSTRAINT crm_tasks_reminder CHECK (
    (remind_at IS NULL) = (reminder_state = 'none')
    AND (reminder_state IN ('sent', 'skipped')) = (reminded_at IS NOT NULL)
    AND (reminder_state = 'skipped' OR reminder_detail IS NULL))
);
CREATE INDEX crm_tasks_assignee_idx ON app.crm_tasks (tenant_id, assignee_membership_id, status, due_at);
CREATE INDEX crm_tasks_contact_idx ON app.crm_tasks (tenant_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX crm_tasks_deal_idx ON app.crm_tasks (tenant_id, deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX crm_tasks_reminder_idx ON app.crm_tasks (remind_at)
  WHERE reminder_state = 'pending' AND status = 'open';
CREATE TRIGGER crm_tasks_touch BEFORE UPDATE ON app.crm_tasks
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Activity timeline -------------------------------------------------------------------------------
-- What happened to a contact's deals and tasks, and notes about the contact or a deal. Every entry
-- belongs to a contact's timeline (and to a deal's, when about a deal). Entries hold ids and codes;
-- the only free text is a note's body. The timeline is append-only: rows are deleted only by
-- contact erasure.
CREATE TABLE app.crm_activities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  deal_id uuid,
  task_id uuid,
  actor_membership_id uuid,
  kind text NOT NULL CHECK (kind IN ('deal_created', 'deal_updated', 'stage_changed', 'owner_changed',
    'deal_won', 'deal_lost', 'deal_reopened', 'task_created', 'task_completed', 'task_reopened',
    'task_cancelled', 'note')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  body text CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_activities_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT crm_activities_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES app.contacts (tenant_id, id),
  CONSTRAINT crm_activities_deal_fk FOREIGN KEY (tenant_id, deal_id, contact_id)
    REFERENCES app.crm_deals (tenant_id, id, contact_id),
  CONSTRAINT crm_activities_task_fk FOREIGN KEY (tenant_id, task_id, contact_id)
    REFERENCES app.crm_tasks (tenant_id, id, contact_id),
  CONSTRAINT crm_activities_actor_fk FOREIGN KEY (tenant_id, actor_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT crm_activities_note CHECK ((kind = 'note') = (body IS NOT NULL)),
  -- Deal events name the deal; task events name the task (and its deal, if any); notes no task.
  CONSTRAINT crm_activities_subject CHECK (CASE
    WHEN kind IN ('deal_created', 'deal_updated', 'stage_changed', 'owner_changed', 'deal_won', 'deal_lost',
                  'deal_reopened') THEN deal_id IS NOT NULL AND task_id IS NULL
    WHEN kind IN ('task_created', 'task_completed', 'task_reopened', 'task_cancelled') THEN task_id IS NOT NULL
    ELSE task_id IS NULL
  END)
);
CREATE INDEX crm_activities_contact_idx ON app.crm_activities (tenant_id, contact_id, created_at DESC);
CREATE INDEX crm_activities_deal_idx ON app.crm_activities (tenant_id, deal_id, created_at DESC)
  WHERE deal_id IS NOT NULL;

CREATE FUNCTION app.guard_crm_activity() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.current_setting('w360.contact_erasure', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'the CRM timeline is append-only' USING ERRCODE = 'W3403';
END
$$;
CREATE TRIGGER crm_activities_guard BEFORE UPDATE OR DELETE ON app.crm_activities
  FOR EACH ROW EXECUTE FUNCTION app.guard_crm_activity();

-- Reminders ---------------------------------------------------------------------------------------
-- The worker's minute sweep signals reminders that are more than 30 seconds overdue (a lost or
-- late job); the job itself re-checks everything under the company's scope. Ids only.
CREATE FUNCTION ops.crm_reminders_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, task_id uuid, remind_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT t.tenant_id, t.id, t.remind_at
    FROM app.crm_tasks t
    JOIN app.tenants tn ON tn.id = t.tenant_id AND tn.status = 'active'
   WHERE t.reminder_state = 'pending' AND t.status = 'open'
     AND t.remind_at <= now() - interval '30 seconds'
   ORDER BY t.remind_at
   LIMIT least(greatest(p_limit, 1), 500)
$$;
CREATE POLICY definer_access ON app.crm_tasks TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, id, contact_id, reminder_state, status, remind_at) ON app.crm_tasks TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.crm_reminders_due(integer) TO w360_app;
ALTER FUNCTION ops.crm_reminders_due(integer) OWNER TO w360_definer;

-- Contact erasure: also removes the contact's CRM timeline, notes and tasks, and blanks the free
-- text of its deals (stage, value, owner, status and dates stay for reports). Same body as 0011
-- plus the CRM block (see the note on replacing definer functions in 0011, ADR-039).
CREATE POLICY definer_access ON app.crm_deals TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_access ON app.crm_activities TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, contact_id) ON app.crm_deals TO w360_definer;
GRANT UPDATE (title, lost_reason, updated_at) ON app.crm_deals TO w360_definer;
GRANT SELECT (tenant_id, contact_id) ON app.crm_activities TO w360_definer;
GRANT DELETE ON app.crm_activities TO w360_definer;
GRANT DELETE ON app.crm_tasks TO w360_definer;

SET ROLE w360_definer;
DROP FUNCTION app.erase_contact(uuid, boolean);
RESET ROLE;
CREATE FUNCTION app.erase_contact(p_contact_id uuid, p_suppress boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_user text := app.current_user_id();
  v_contact record;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  -- Conversations first: every other writer (ingestion, replies, the automation runner) locks the
  -- conversation before its run and before the contact, so erasure takes the same order.
  PERFORM 1 FROM app.conversations cv
    WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id
    ORDER BY cv.id FOR UPDATE;
  SELECT c.id, c.phone_e164, c.erased_at INTO v_contact
    FROM app.contacts c WHERE c.tenant_id = v_tenant AND c.id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact not found' USING ERRCODE = 'W3404';
  END IF;
  IF v_contact.erased_at IS NOT NULL THEN
    RETURN false;
  END IF;
  IF p_suppress AND v_contact.phone_e164 IS NOT NULL THEN
    INSERT INTO app.suppressions (id, tenant_id, phone_e164, reason, created_by_user_id)
    VALUES (gen_random_uuid(), v_tenant, v_contact.phone_e164, 'erased', v_user)
    ON CONFLICT (tenant_id, phone_e164) DO NOTHING;
  END IF;
  INSERT INTO app.consent_events (id, tenant_id, contact_id, purpose, action, source, actor_type, actor_id, occurred_at)
  SELECT gen_random_uuid(), v_tenant, p_contact_id, p.purpose, 'opt_out', 'erasure',
         CASE WHEN v_user IS NULL THEN 'system' ELSE 'user' END, v_user, now()
    FROM (VALUES ('marketing'), ('utility')) AS p (purpose);

  -- Automation runs: captured answers are cleared and active runs stop (no further bot messages).
  UPDATE app.automation_runs r SET variables = '{}'::jsonb
   WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id;
  UPDATE app.automation_runs r
     SET status = 'stopped', end_reason = 'contact_erased', ended_at = now(), current_node_id = NULL,
         waiting_for = NULL, wait_until = NULL, input_message_id = NULL, next_step_at = NULL
   WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id AND r.status IN ('running', 'waiting');

  -- CRM: the timeline (with notes) and tasks go; deals keep what reports need, without free text.
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'on', true);
  DELETE FROM app.crm_activities a WHERE a.tenant_id = v_tenant AND a.contact_id = p_contact_id;
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'off', true);
  DELETE FROM app.crm_tasks t WHERE t.tenant_id = v_tenant AND t.contact_id = p_contact_id;
  UPDATE app.crm_deals d SET title = 'Deal (contact erased)', lost_reason = NULL
   WHERE d.tenant_id = v_tenant AND d.contact_id = p_contact_id;

  UPDATE app.send_intents s
     SET state = 'canceled', lease_until = NULL, resolved_at = now(), last_error_code = 'contact_erased',
         last_error = 'Not sent: the contact was erased.'
   WHERE s.tenant_id = v_tenant AND s.state IN ('queued', 'deferred')
     AND s.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                            ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                           WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  UPDATE app.messages m
     SET content = '{"redacted": true}'::jsonb,
         status = CASE WHEN m.status IN ('queued', 'sending') THEN 'canceled' ELSE m.status END,
         status_rank = CASE WHEN m.status IN ('queued', 'sending') THEN 5 ELSE m.status_rank END,
         status_at = CASE WHEN m.status IN ('queued', 'sending') THEN now() ELSE m.status_at END,
         error_title = NULL
   WHERE m.tenant_id = v_tenant
     AND m.conversation_id IN (SELECT cv.id FROM app.conversations cv
                                WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'on', true);
  UPDATE app.message_status_events e
     SET recipient_wa_id = NULL, recipient_bsuid = NULL
   WHERE e.tenant_id = v_tenant AND (e.recipient_wa_id IS NOT NULL OR e.recipient_bsuid IS NOT NULL)
     AND e.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                            ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                           WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'off', true);
  DELETE FROM app.media_objects mo
   WHERE mo.tenant_id = v_tenant
     AND mo.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                             ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                            WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  DELETE FROM app.conversation_notes n
   WHERE n.tenant_id = v_tenant
     AND n.conversation_id IN (SELECT cv.id FROM app.conversations cv
                                WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  UPDATE app.conversations cv SET last_message_preview = NULL
   WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id;
  DELETE FROM app.contact_identities i WHERE i.tenant_id = v_tenant AND i.contact_id = p_contact_id;
  DELETE FROM app.contact_tags t WHERE t.tenant_id = v_tenant AND t.contact_id = p_contact_id;
  UPDATE app.contacts c
     SET display_name = NULL, phone_e164 = NULL, email = NULL, attributes = '{}'::jsonb, erased_at = now()
   WHERE c.tenant_id = v_tenant AND c.id = p_contact_id;
  RETURN true;
END
$$;
GRANT EXECUTE ON FUNCTION app.erase_contact(uuid, boolean) TO w360_app;
ALTER FUNCTION app.erase_contact(uuid, boolean) OWNER TO w360_definer;

-- Metric definitions (reports/definitions.ts; a test keeps them equal) -------------------------------
INSERT INTO ops.metric_definitions (key, version, label, unit, description, numerator, denominator, window_rule,
  timezone_rule, missing_data, freshness, available) VALUES
  ('crm.deal_outcomes', 2, 'Deal outcomes', 'count',
   'Deals won and lost in the period, with their value in each pipeline currency.',
   'Deals whose status became won or lost in the period (a deal reopened and closed again counts once, at its latest close).',
   NULL,
   NULL,
   'Counted by the time the deal was closed, in calendar days of the company’s time zone.',
   'Values are the deals’ current values. Values in different currencies are never added together. Deals of erased contacts keep their value and outcome.',
   'Computed when the page loads from HyFib’s records.', true),
  ('crm.win_rate', 1, 'Win rate', 'rate',
   'Share of deals closed in the period that were won.',
   'Deals won in the period.',
   'Deals won or lost in the period.',
   NULL,
   'Counted by the time the deal was closed, in calendar days of the company’s time zone.',
   'Not shown when no deal was closed in the period.',
   'Computed when the page loads from HyFib’s records.', true),
  ('crm.time_to_win', 1, 'Time to win', 'duration',
   'How long won deals took from creation to being won, reported as the median.',
   'Time from creation to close of deals won in the period.',
   'Deals won in the period.',
   'From when the deal was created in HyFib to when it was marked won, in absolute time.',
   'Counted by the time the deal was closed, in calendar days of the company’s time zone.',
   'Not shown when no deal was won in the period.',
   'Computed when the page loads from HyFib’s records.', true),
  ('crm.open_pipeline', 1, 'Open pipeline', 'count',
   'Open deals and their total value in each stage of each pipeline, now.',
   'Open deals, by pipeline and stage.',
   NULL,
   NULL,
   NULL,
   'Deals without a value count in the number of deals but add nothing to the value.',
   'The state when the page loads.', true);

-- Row level security and privileges --------------------------------------------------------------
SELECT ops.apply_tenant_rls('app.crm_pipelines');
SELECT ops.apply_tenant_rls('app.crm_stages');
SELECT ops.apply_tenant_rls('app.crm_deals');
SELECT ops.apply_tenant_rls('app.crm_tasks');
SELECT ops.apply_tenant_rls('app.crm_activities');

GRANT SELECT, INSERT ON app.crm_pipelines TO w360_app;
GRANT UPDATE (name, position, archived_at, version, updated_at) ON app.crm_pipelines TO w360_app;
GRANT SELECT, INSERT ON app.crm_stages TO w360_app;
GRANT UPDATE (name, position, archived_at, updated_at) ON app.crm_stages TO w360_app;
GRANT SELECT, INSERT ON app.crm_deals TO w360_app;
GRANT UPDATE (pipeline_id, stage_id, title, value_minor, owner_membership_id, status, lost_reason,
  expected_close_on, stage_entered_at, closed_at, closed_by_membership_id, version, updated_at)
  ON app.crm_deals TO w360_app;
GRANT SELECT, INSERT ON app.crm_tasks TO w360_app;
GRANT UPDATE (title, notes, assignee_membership_id, due_at, remind_at, reminder_state, reminder_detail,
  reminded_at, status, completed_at, completed_by_membership_id, version, updated_at)
  ON app.crm_tasks TO w360_app;
GRANT SELECT, INSERT ON app.crm_activities TO w360_app;
