-- 0011_automations: automation builder (P4-01). Automations with an editable draft, immutable
-- published versions, runs pinned to a version with a durable position, an append-only step log,
-- the bot/human hand-off lock, reply turns that pause while an automation handles a conversation,
-- routing that waits for the automation, erasure of captured answers, a sweep for lost signals and
-- timers, and retention.

-- Automations -------------------------------------------------------------------------------------
-- The draft (trigger, graph, number) is edited freely; publishing copies it into an immutable
-- version and makes that version the one new runs use. Structure is validated by the application
-- (packages/domain/src/automations/graph.ts) before anything is stored.
CREATE TABLE app.automations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  description text CHECK (char_length(description) <= 300),
  -- draft: never published; active: new runs start on the trigger; paused: no new runs (runs in
  -- progress finish); archived: hidden, no new runs.
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  draft_trigger jsonb NOT NULL CHECK (jsonb_typeof(draft_trigger) = 'object'),
  draft_graph jsonb NOT NULL CHECK (jsonb_typeof(draft_graph) = 'object'),
  -- The number the automation listens on (NULL: every number of the company).
  draft_channel_account_id uuid,
  draft_updated_at timestamptz NOT NULL DEFAULT now(),
  draft_updated_by_membership_id uuid NOT NULL,
  active_version_id uuid,
  -- Optimistic concurrency for editors: every change increments it.
  version integer NOT NULL DEFAULT 0,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automations_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT automations_channel_fk FOREIGN KEY (tenant_id, draft_channel_account_id)
    REFERENCES app.channel_accounts (tenant_id, id),
  CONSTRAINT automations_created_by_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT automations_updated_by_fk FOREIGN KEY (tenant_id, draft_updated_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT automations_published CHECK (status NOT IN ('active', 'paused') OR active_version_id IS NOT NULL),
  CONSTRAINT automations_draft CHECK (status <> 'draft' OR active_version_id IS NULL)
);
CREATE UNIQUE INDEX automations_name_uq ON app.automations (tenant_id, lower(btrim(name)));
CREATE INDEX automations_active_idx ON app.automations (tenant_id) WHERE status = 'active';
CREATE TRIGGER automations_touch BEFORE UPDATE ON app.automations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- A version fixes when an automation starts (trigger, number) and what it does (graph). Published
-- versions are numbered; test versions are snapshots of a draft used by test runs only. Versions
-- never change and are never deleted, so every run can show exactly what it executed.
CREATE TABLE app.automation_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  automation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('published', 'test')),
  number integer CHECK (number >= 1),
  trigger jsonb NOT NULL CHECK (jsonb_typeof(trigger) = 'object'),
  graph jsonb NOT NULL CHECK (jsonb_typeof(graph) = 'object'),
  channel_account_id uuid,
  -- SHA-256 of the canonical definition (trigger, graph, number), to reuse identical test snapshots.
  definition_sha256 text NOT NULL CHECK (definition_sha256 ~ '^[0-9a-f]{64}$'),
  note text CHECK (char_length(note) <= 300),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_versions_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT automation_versions_number_uq UNIQUE (tenant_id, automation_id, number),
  CONSTRAINT automation_versions_automation_fk FOREIGN KEY (tenant_id, automation_id)
    REFERENCES app.automations (tenant_id, id),
  CONSTRAINT automation_versions_channel_fk FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES app.channel_accounts (tenant_id, id),
  CONSTRAINT automation_versions_created_by_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT automation_versions_number CHECK ((kind = 'published') = (number IS NOT NULL))
);
CREATE INDEX automation_versions_automation_idx
  ON app.automation_versions (tenant_id, automation_id, created_at DESC);
CREATE TRIGGER automation_versions_immutable BEFORE UPDATE OR DELETE ON app.automation_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

ALTER TABLE app.automations ADD CONSTRAINT automations_active_version_fk
  FOREIGN KEY (tenant_id, active_version_id) REFERENCES app.automation_versions (tenant_id, id);

-- Runs --------------------------------------------------------------------------------------------
-- One execution of one version in one conversation. The row is the durable position of the run:
-- each step is one transaction that applies the step's effects (queued messages, contact updates,
-- hand-off) and moves the position together, so a worker that stops between steps loses nothing
-- and a step is never applied twice. Jobs only signal the row; the sweep re-signals lost signals
-- and due timers (next_step_at).
--
-- The partial unique index on active runs is the hand-off lock: while a run is running or waiting,
-- the automation owns the conversation. Routing leaves the conversation alone and no reply turn
-- opens; a member's reply, an assignment or "Take over" ends the run in the same transaction (and
-- cancels bot messages not yet handed to the sender), so the bot and a person never answer the
-- customer at the same time.
CREATE TABLE app.automation_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  automation_id uuid NOT NULL,
  version_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  -- live: started by a customer message; test: started by a member on a conversation they can
  -- see, running a snapshot of the draft.
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test')),
  trigger_type text NOT NULL CHECK (trigger_type IN ('keyword', 'conversation_started', 'any_message', 'test')),
  trigger_message_id uuid,
  started_by_membership_id uuid,
  started_by_user_id text,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'waiting', 'completed', 'handed_off', 'taken_over', 'stopped', 'failed')),
  current_node_id text CHECK (current_node_id ~ '^[a-z0-9_-]{1,32}$'),
  -- How many times the current node has been entered (loop budget; part of button reply ids).
  node_visit integer NOT NULL DEFAULT 0 CHECK (node_visit >= 0),
  waiting_for text CHECK (waiting_for IN ('reply', 'timer')),
  wait_until timestamptz,
  -- A customer reply delivered to a run waiting for one, not yet processed (next_step_at is then
  -- the delivery time).
  input_message_id uuid,
  -- Unrecognised replies at the current question.
  retries smallint NOT NULL DEFAULT 0 CHECK (retries BETWEEN 0 AND 10),
  step_count integer NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  visits jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(visits) = 'object'),
  -- Answers captured by questions: personal data, cleared on erasure and 30 days after the run ends.
  variables jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(variables) = 'object'),
  -- When the runner must act next: now while running, the deadline while waiting.
  next_step_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text,
  end_detail text CHECK (char_length(end_detail) <= 300),
  ended_by_membership_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_runs_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT automation_runs_automation_fk FOREIGN KEY (tenant_id, automation_id)
    REFERENCES app.automations (tenant_id, id),
  CONSTRAINT automation_runs_version_fk FOREIGN KEY (tenant_id, version_id)
    REFERENCES app.automation_versions (tenant_id, id),
  CONSTRAINT automation_runs_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES app.conversations (tenant_id, id),
  CONSTRAINT automation_runs_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES app.contacts (tenant_id, id),
  CONSTRAINT automation_runs_channel_fk FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES app.channel_accounts (tenant_id, id),
  CONSTRAINT automation_runs_trigger_message_fk FOREIGN KEY (tenant_id, trigger_message_id)
    REFERENCES app.messages (tenant_id, id) ON DELETE SET NULL (trigger_message_id),
  CONSTRAINT automation_runs_input_message_fk FOREIGN KEY (tenant_id, input_message_id)
    REFERENCES app.messages (tenant_id, id) ON DELETE SET NULL (input_message_id),
  CONSTRAINT automation_runs_started_by_fk FOREIGN KEY (tenant_id, started_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT automation_runs_ended_by_fk FOREIGN KEY (tenant_id, ended_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT automation_runs_mode CHECK (
    (mode = 'test') = (trigger_type = 'test')
    AND (mode = 'test') = (started_by_membership_id IS NOT NULL)
    AND (started_by_membership_id IS NULL) = (started_by_user_id IS NULL)),
  CONSTRAINT automation_runs_wait CHECK (
    (status = 'waiting') = (waiting_for IS NOT NULL) AND (waiting_for IS NULL) = (wait_until IS NULL)),
  CONSTRAINT automation_runs_next CHECK ((status IN ('running', 'waiting')) = (next_step_at IS NOT NULL)),
  CONSTRAINT automation_runs_input CHECK (input_message_id IS NULL OR status = 'waiting'),
  CONSTRAINT automation_runs_end CHECK (
    (status IN ('running', 'waiting') AND ended_at IS NULL AND end_reason IS NULL AND ended_by_membership_id IS NULL)
    OR (status = 'completed' AND ended_at IS NOT NULL AND end_reason IN ('end_node', 'no_next'))
    OR (status = 'handed_off' AND ended_at IS NOT NULL AND end_reason = 'handoff_node')
    OR (status = 'taken_over' AND ended_at IS NOT NULL AND end_reason IN ('agent_replied', 'assigned', 'take_over'))
    OR (status = 'stopped' AND ended_at IS NOT NULL
        AND end_reason IN ('stopped_by_member', 'conversation_resolved', 'opted_out', 'contact_erased',
                           'automation_archived'))
    OR (status = 'failed' AND ended_at IS NOT NULL
        AND end_reason IN ('budget_steps', 'budget_loop', 'budget_messages', 'expired', 'send_blocked', 'error'))),
  CONSTRAINT automation_runs_order CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- The hand-off lock: at most one active run per conversation.
CREATE UNIQUE INDEX automation_runs_active_uq ON app.automation_runs (tenant_id, conversation_id)
  WHERE status IN ('running', 'waiting');
CREATE INDEX automation_runs_automation_idx
  ON app.automation_runs (tenant_id, automation_id, started_at DESC, id DESC);
CREATE INDEX automation_runs_conversation_idx
  ON app.automation_runs (tenant_id, conversation_id, started_at DESC);
CREATE INDEX automation_runs_list_idx ON app.automation_runs (tenant_id, started_at DESC, id DESC);
CREATE INDEX automation_runs_next_step_idx ON app.automation_runs (next_step_at)
  WHERE status IN ('running', 'waiting');
CREATE INDEX automation_runs_retention_idx ON app.automation_runs (ended_at)
  WHERE ended_at IS NOT NULL;

-- What started a run is fixed; an ended run never changes except that its captured answers are
-- cleared (erasure, retention). The retention maintenance setting may delete runs.
CREATE FUNCTION app.guard_automation_run() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'automation runs cannot be deleted' USING ERRCODE = 'W3403';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.automation_id, NEW.version_id, NEW.conversation_id, NEW.contact_id,
      NEW.channel_account_id, NEW.mode, NEW.trigger_type, NEW.trigger_message_id,
      NEW.started_by_membership_id, NEW.started_by_user_id, NEW.started_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.automation_id, OLD.version_id, OLD.conversation_id, OLD.contact_id,
      OLD.channel_account_id, OLD.mode, OLD.trigger_type, OLD.trigger_message_id,
      OLD.started_by_membership_id, OLD.started_by_user_id, OLD.started_at) THEN
    RAISE EXCEPTION 'what started an automation run is fixed' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.status NOT IN ('running', 'waiting') THEN
    IF (NEW.status, NEW.current_node_id, NEW.node_visit, NEW.waiting_for, NEW.wait_until,
        NEW.input_message_id, NEW.retries, NEW.step_count, NEW.message_count, NEW.visits,
        NEW.next_step_at, NEW.ended_at, NEW.end_reason, NEW.end_detail, NEW.ended_by_membership_id)
       IS DISTINCT FROM
       (OLD.status, OLD.current_node_id, OLD.node_visit, OLD.waiting_for, OLD.wait_until,
        OLD.input_message_id, OLD.retries, OLD.step_count, OLD.message_count, OLD.visits,
        OLD.next_step_at, OLD.ended_at, OLD.end_reason, OLD.end_detail, OLD.ended_by_membership_id)
       OR (NEW.variables IS DISTINCT FROM OLD.variables AND NEW.variables <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'an ended automation run cannot change' USING ERRCODE = 'W3403';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER automation_runs_guard BEFORE UPDATE OR DELETE ON app.automation_runs
  FOR EACH ROW EXECUTE FUNCTION app.guard_automation_run();
CREATE TRIGGER automation_runs_touch BEFORE UPDATE ON app.automation_runs
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- The execution log: one row per step, numbered per run (the unique number makes a replayed step
-- impossible to record twice). Rows hold node ids, outcomes and message ids only, never what the
-- customer wrote, so members who read automations do not see conversation content here.
CREATE TABLE app.automation_run_steps (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 0),
  node_id text CHECK (node_id ~ '^[a-z0-9_-]{1,32}$'),
  node_type text CHECK (char_length(node_type) <= 32),
  outcome text NOT NULL CHECK (outcome IN ('started', 'sent', 'asked', 'answered', 'retried', 'timed_out',
    'branched', 'updated', 'waiting', 'resumed', 'handed_off', 'completed', 'failed', 'stopped', 'taken_over')),
  -- The branch taken (for example a button title, "then", "else", "timeout"); authored text only.
  branch text CHECK (char_length(branch) <= 80),
  message_id uuid,
  detail text CHECK (char_length(detail) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_run_steps_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT automation_run_steps_seq_uq UNIQUE (tenant_id, run_id, seq),
  CONSTRAINT automation_run_steps_run_fk FOREIGN KEY (tenant_id, run_id)
    REFERENCES app.automation_runs (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT automation_run_steps_message_fk FOREIGN KEY (tenant_id, message_id)
    REFERENCES app.messages (tenant_id, id) ON DELETE SET NULL (message_id)
);
CREATE TRIGGER automation_run_steps_append_only BEFORE UPDATE OR DELETE ON app.automation_run_steps
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Reply turns while an automation handles a conversation ---------------------------------------------
-- Nobody waits for a member while an automation is answering: a customer message opens no turn
-- while a run is active, and a run that starts closes the open turn as `automated`. When the run
-- ends and passes the conversation to people (hand-off, stop, failure, a member taking it over
-- without replying), or the customer has the last word, a turn opens at that moment
-- (start_reason = 'handoff'). A run ended by a member's reply, a resolve or an erasure opens none.
ALTER TABLE app.conversation_turns
  ADD COLUMN start_reason text NOT NULL DEFAULT 'customer' CHECK (start_reason IN ('customer', 'handoff'));
ALTER TABLE app.conversation_turns DROP CONSTRAINT conversation_turns_end_reason_check;
ALTER TABLE app.conversation_turns DROP CONSTRAINT conversation_turns_end;
ALTER TABLE app.conversation_turns ADD CONSTRAINT conversation_turns_end_reason_check
  CHECK (end_reason IN ('replied', 'resolved', 'automated'));
ALTER TABLE app.conversation_turns ADD CONSTRAINT conversation_turns_end CHECK (
  (ended_at IS NULL AND end_reason IS NULL AND ended_by_membership_id IS NULL AND reply_message_id IS NULL)
  OR (ended_at IS NOT NULL AND end_reason = 'replied')
  OR (ended_at IS NOT NULL AND end_reason = 'resolved' AND reply_message_id IS NULL)
  OR (ended_at IS NOT NULL AND end_reason = 'automated' AND reply_message_id IS NULL
      AND ended_by_membership_id IS NULL));
ALTER TABLE app.conversation_turns ADD CONSTRAINT conversation_turns_start
  CHECK (start_reason = 'customer' OR first_message_id IS NULL);

CREATE OR REPLACE FUNCTION app.guard_conversation_turn() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reply turns cannot be deleted' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'a closed reply turn cannot change' USING ERRCODE = 'W3403';
  END IF;
  IF NEW.ended_at IS NULL
     OR (NEW.id, NEW.tenant_id, NEW.conversation_id, NEW.first_message_id, NEW.started_at, NEW.start_reason,
         NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.conversation_id, OLD.first_message_id, OLD.started_at, OLD.start_reason,
         OLD.created_at) THEN
    RAISE EXCEPTION 'an open reply turn can only be closed' USING ERRCODE = 'W3403';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.track_conversation_turn() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.direction = 'inbound' AND NEW.sender_type = 'contact' AND NEW.type NOT IN ('reaction', 'system')
     AND NOT (NEW.type = 'interactive' AND coalesce(NEW.content #>> '{reply,id}', '') LIKE 'w360csat:%')
     AND NOT EXISTS (SELECT 1 FROM app.automation_runs r
                      WHERE r.tenant_id = NEW.tenant_id AND r.conversation_id = NEW.conversation_id
                        AND r.status IN ('running', 'waiting')) THEN
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

-- Runs with the writer's privileges (tenant-scoped runtime role), so RLS applies to turn rows. The
-- end reasons that open no turn are checked first, before any table is read (erasure stops runs as
-- the definer role).
CREATE FUNCTION app.track_automation_turn() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE app.conversation_turns t
       SET ended_at = greatest(now(), t.started_at), end_reason = 'automated'
     WHERE t.tenant_id = NEW.tenant_id AND t.conversation_id = NEW.conversation_id AND t.ended_at IS NULL;
    RETURN NULL;
  END IF;
  IF NEW.end_reason IN ('agent_replied', 'conversation_resolved', 'contact_erased') THEN
    RETURN NULL;
  END IF;
  IF NEW.status = 'completed' AND NOT coalesce((
       SELECT m.direction = 'inbound' AND m.sender_type = 'contact'
         FROM app.messages m
        WHERE m.tenant_id = NEW.tenant_id AND m.conversation_id = NEW.conversation_id
          AND m.type NOT IN ('reaction', 'system')
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1), false) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM app.conversations c
              WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.conversation_id AND c.status <> 'resolved') THEN
    INSERT INTO app.conversation_turns (id, tenant_id, conversation_id, first_message_id, started_at, start_reason)
    VALUES (gen_random_uuid(), NEW.tenant_id, NEW.conversation_id, NULL, now(), 'handoff')
    ON CONFLICT (tenant_id, conversation_id) WHERE ended_at IS NULL DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER automation_runs_turn_start AFTER INSERT ON app.automation_runs
  FOR EACH ROW EXECUTE FUNCTION app.track_automation_turn();
CREATE TRIGGER automation_runs_turn_end AFTER UPDATE OF status ON app.automation_runs
  FOR EACH ROW WHEN (OLD.status IN ('running', 'waiting') AND NEW.status NOT IN ('running', 'waiting'))
  EXECUTE FUNCTION app.track_automation_turn();

-- Routing sweep: conversations an automation is handling are not routed ------------------------------
-- The function is owned by w360_definer, which the migration role cannot replace in place (it may
-- SET ROLE to it but lacks CREATE on the schema as that role): the owner drops it and the migration
-- role recreates it, granting before handing it back.
SET ROLE w360_definer;
DROP FUNCTION ops.conversations_to_route(integer);
RESET ROLE;
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
     AND NOT EXISTS (SELECT 1 FROM app.automation_runs r
                      WHERE r.tenant_id = c.tenant_id AND r.conversation_id = c.id
                        AND r.status IN ('running', 'waiting'))
   ORDER BY c.last_inbound_at NULLS LAST, c.id
   LIMIT least(greatest(p_limit, 1), 500)
$$;

-- The definer role reads run ids and states for the sweeps and ends runs on erasure.
CREATE POLICY definer_access ON app.automation_runs TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, id, conversation_id, contact_id, status, next_step_at, started_by_user_id, ended_at)
  ON app.automation_runs TO w360_definer;
GRANT UPDATE (variables, status, current_node_id, waiting_for, wait_until, input_message_id, next_step_at,
  ended_at, end_reason, updated_at) ON app.automation_runs TO w360_definer;
GRANT DELETE ON app.automation_runs TO w360_definer;

GRANT EXECUTE ON FUNCTION ops.conversations_to_route(integer) TO w360_app;
ALTER FUNCTION ops.conversations_to_route(integer) OWNER TO w360_definer;

-- Runs the sweep must signal: active runs of active companies whose next step (a lost signal while
-- running, a reply deadline or wait timer while waiting) is more than 30 seconds overdue.
CREATE FUNCTION ops.automation_runs_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, run_id uuid, actor_user_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT r.tenant_id, r.id, r.started_by_user_id
    FROM app.automation_runs r
    JOIN app.tenants t ON t.id = r.tenant_id AND t.status = 'active'
   WHERE r.status IN ('running', 'waiting') AND r.next_step_at <= now() - interval '30 seconds'
   ORDER BY r.next_step_at
   LIMIT least(greatest(p_limit, 1), 500)
$$;
GRANT EXECUTE ON FUNCTION ops.automation_runs_due(integer) TO w360_app;
ALTER FUNCTION ops.automation_runs_due(integer) OWNER TO w360_definer;

-- Retention (docs/DATA-RETENTION.md): captured answers are cleared 30 days after a run ends; ended
-- runs (with their step log) are deleted after 180 days. Versions are kept with their automation.
CREATE FUNCTION ops.apply_automation_retention(p_limit integer)
  RETURNS TABLE (cleared integer, deleted integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_limit integer := least(greatest(p_limit, 1), 5000);
  v_cleared integer;
  v_deleted integer;
BEGIN
  UPDATE app.automation_runs r SET variables = '{}'::jsonb
   WHERE r.id IN (
     SELECT x.id FROM app.automation_runs x
      WHERE x.ended_at < now() - interval '30 days' AND x.variables <> '{}'::jsonb
      ORDER BY x.ended_at
      LIMIT v_limit);
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  PERFORM pg_catalog.set_config('w360.allow_retention_purge', 'on', true);
  DELETE FROM app.automation_runs r
   WHERE r.id IN (
     SELECT x.id FROM app.automation_runs x
      WHERE x.ended_at < now() - interval '180 days'
      ORDER BY x.ended_at
      LIMIT v_limit);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  PERFORM pg_catalog.set_config('w360.allow_retention_purge', 'off', true);
  RETURN QUERY SELECT v_cleared, v_deleted;
END
$$;
GRANT SELECT (variables) ON app.automation_runs TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.apply_automation_retention(integer) TO w360_app;
ALTER FUNCTION ops.apply_automation_retention(integer) OWNER TO w360_definer;

-- Contact erasure: also clears captured answers and stops the contact's active runs ------------------
-- Same body as 0005 plus the automation block, and the contact's conversations are locked first
-- (see the note on replacing definer functions above).
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
-- Reply turns change meaning with automations (hand-offs start turns; automated time and turns an
-- automation took over are left out), so every turn-based metric gets a new version. Automation
-- runs become measurable.
INSERT INTO ops.metric_definitions (key, version, label, unit, description, numerator, denominator, window_rule,
  timezone_rule, missing_data, freshness, available) VALUES
  ('inbox.waiting', 2, 'Waiting for a reply', 'count',
   'Conversations whose customer is waiting for a member: their latest messages have no reply from a member, no automation is handling the conversation, and it is not resolved. A conversation an automation passed to people waits from that moment.',
   'Open reply turns.',
   NULL,
   NULL,
   NULL,
   'Reply turns are recorded from the release of reports onwards.',
   'The state when the page loads.', true),
  ('inbox.oldest_wait', 3, 'Longest wait', 'duration',
   'How long the longest-waiting customer has been waiting for a member. Time while an automation was handling the conversation does not count.',
   'Time since the start of the oldest open reply turn (the customer’s first waiting message, or an automation’s hand-off).',
   NULL,
   NULL,
   NULL,
   'Measured in absolute time, including hours outside business hours.',
   'The state when the page loads.', true),
  ('inbox.overdue', 2, 'Overdue', 'count',
   'Waiting conversations whose customer has waited longer than the company’s first-response target. After an automation’s hand-off the wait counts from the hand-off.',
   'Open reply turns that have waited longer than the target.',
   NULL,
   'The target, counted in business hours when business hours are on (Settings → Messaging → Business hours), otherwise in absolute time.',
   NULL,
   'Shown only when a target is set. Reply turns are recorded from the release of reports onwards.',
   'The state when the page loads.', true),
  ('inbox.windows_closing', 2, 'Reply windows closing', 'count',
   'Conversations waiting for a member whose 24-hour customer service window closes within 2 hours. After it closes only approved templates can be sent. Conversations an automation is handling are not counted.',
   'Open reply turns whose customer’s last message was 22 to 24 hours ago.',
   NULL,
   'The window closes 24 hours after the customer’s last message.',
   NULL,
   'None.',
   'The state when the page loads.', true),
  ('inbox.first_response_time', 3, 'First response time', 'duration',
   'Time from the start of a reply turn to the first reply by a member, reported as the median and the 90th percentile.',
   'Reply times of answered turns.',
   'Turns that started in the period and were answered.',
   'From when HyFib received the customer’s first waiting message, or from an automation’s hand-off, to when the member sent the reply, in absolute time, including hours outside business hours (see First response in business hours).',
   'A reply turn starts with the first customer message that has no reply from a member yet, or when an automation passes the conversation to people, and ends when a member replies or the conversation is resolved. No turn is open while an automation is handling the conversation, and a turn that was open when an automation took over is left out. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Turns still waiting are not in the median; see Waiting. A reply counts when the member sends it, even if WhatsApp later rejects it (see Failed). Reply turns are recorded from the release of reports onwards.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('inbox.first_response_business_time', 2, 'First response in business hours', 'duration',
   'Time from the start of a reply turn to the first reply by a member, counting business hours only, reported as the median and the 90th percentile.',
   'Business-hours reply times of answered turns.',
   'Turns that started in the period and were answered.',
   'Only time inside the company’s business hours counts (Settings → Messaging → Business hours); closed days and hours outside the weekly schedule are skipped, in the company’s time zone.',
   'A reply turn starts with the first customer message that has no reply from a member yet, or when an automation passes the conversation to people, and ends when a member replies or the conversation is resolved. No turn is open while an automation is handling the conversation, and a turn that was open when an automation took over is left out. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Shown only when business hours are on. The current schedule and closed days are applied to the whole period, including turns from before a change.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('inbox.within_target', 3, 'Answered within target', 'rate',
   'Share of reply turns answered within the company’s first-response target (Settings → Messaging).',
   'Turns answered within the target.',
   'Turns that started in the period and were answered or have waited longer than the target. Turns resolved without a reply, turns still within the target and turns an automation took over are left out.',
   'The target, counted in business hours when business hours are on (Settings → Messaging → Business hours), otherwise in absolute time.',
   'A reply turn starts with the first customer message that has no reply from a member yet, or when an automation passes the conversation to people, and ends when a member replies or the conversation is resolved. No turn is open while an automation is handling the conversation, and a turn that was open when an automation took over is left out. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Shown only when a target is set. With business hours on, the current schedule and closed days are applied to the whole period.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('inbox.resolved_without_reply', 2, 'Resolved without a reply', 'count',
   'Reply turns closed by resolving the conversation without replying, for example after a customer’s thank-you.',
   'Turns that ended because the conversation was resolved.',
   NULL,
   NULL,
   'A reply turn starts with the first customer message that has no reply from a member yet, or when an automation passes the conversation to people, and ends when a member replies or the conversation is resolved. No turn is open while an automation is handling the conversation, and a turn that was open when an automation took over is left out. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'None.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('agent.turns_answered', 2, 'Turns answered', 'count',
   'Reply turns the member answered first, including turns that started when an automation passed the conversation to people.',
   'Turns that ended with the member’s reply.',
   NULL,
   NULL,
   'Counted by the time the turn was answered, in calendar days of the company’s time zone.',
   'Reply turns are recorded from the release of reports onwards. Replies that took a conversation over from an automation answer no turn.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('agent.first_response_time', 3, 'Median first response', 'duration',
   'Median reply time of the turns the member answered.',
   'Reply times of the turns the member answered.',
   'Turns the member answered in the period.',
   'Absolute time from the start of the turn (the customer’s first waiting message, or an automation’s hand-off), including hours outside business hours.',
   'Counted by the time the turn was answered, in calendar days of the company’s time zone.',
   'Reply turns are recorded from the release of reports onwards.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('automation.runs', 1, 'Automation runs', 'count',
   'Runs of published automations started by customer messages, by how they ended: completed, handed off to people, taken over by a member, stopped, failed, or still running.',
   'Runs started in the period, by outcome.',
   NULL,
   NULL,
   'Counted by the time the run started, in calendar days of the company’s time zone. Test runs started by members are not counted.',
   'Runs older than 180 days are deleted (docs/DATA-RETENTION.md).',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('automation.outcomes', 2, 'Automation outcomes', 'rate',
   'Share of finished runs that completed without people, were handed off by the automation, were taken over by a member, were stopped, or failed (budget, closed window, errors).',
   'Finished runs with each outcome.',
   'Runs started in the period that have finished.',
   'Runs still running or waiting are not in the denominator until they finish.',
   'Counted by the time the run started, in calendar days of the company’s time zone. Test runs started by members are not counted.',
   'Runs older than 180 days are deleted (docs/DATA-RETENTION.md).',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true);

-- Row level security and privileges --------------------------------------------------------------
SELECT ops.apply_tenant_rls('app.automations');
SELECT ops.apply_tenant_rls('app.automation_versions');
SELECT ops.apply_tenant_rls('app.automation_runs');
SELECT ops.apply_tenant_rls('app.automation_run_steps');

GRANT SELECT, INSERT, DELETE ON app.automations TO w360_app;
GRANT UPDATE (name, description, status, draft_trigger, draft_graph, draft_channel_account_id, draft_updated_at,
  draft_updated_by_membership_id, active_version_id, version, updated_at) ON app.automations TO w360_app;
GRANT SELECT, INSERT ON app.automation_versions TO w360_app;
GRANT SELECT, INSERT ON app.automation_runs TO w360_app;
GRANT UPDATE (status, current_node_id, node_visit, waiting_for, wait_until, input_message_id, retries, step_count,
  message_count, visits, variables, next_step_at, ended_at, end_reason, end_detail, ended_by_membership_id,
  updated_at) ON app.automation_runs TO w360_app;
GRANT SELECT, INSERT ON app.automation_run_steps TO w360_app;
