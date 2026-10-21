-- 0311_automation_enrollments: members enrol contacts or a segment in an automation (P4-01, ADR-401).
--
-- Automations "Started by a member or through the API" (trigger `api`) started only through the
-- public API (ADR-077, ADR-161). A member who may publish automations now chooses the contacts the
-- contacts page's filters match, or a saved segment, gives the trigger's inputs once, and confirms
-- the count. The enrolment snapshots those contacts (one row each, at most 10,000) and a signed
-- `automation.enroll` job starts the runs in batches of at most 50 per transaction, each contact
-- with the API's start steps in a savepoint of its own. Each contact's outcome is recorded with the
-- batch, so a retried or restarted job never starts a second run for a contact the enrolment
-- handled. Rows hold ids, counts, outcome codes and the inputs, which are cleared when the
-- enrolment ends (each run keeps its own copy with its answers, ADR-077).

CREATE TABLE app.automation_enrollments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  automation_id uuid NOT NULL,
  -- Whom: the contacts the contacts page's filters matched (the filters are not kept: a search
  -- text can name a person), or a saved segment's members when the enrolment started.
  source text NOT NULL CHECK (source IN ('contacts', 'segment')),
  segment_id uuid,
  -- The trigger's inputs, by name, given once for everyone enrolled; cleared when it ends.
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(inputs) = 'object'),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'stopped')),
  end_reason text,
  total integer NOT NULL CHECK (total BETWEEN 1 AND 10000),
  started_count integer NOT NULL DEFAULT 0 CHECK (started_count >= 0),
  refused_count integer NOT NULL DEFAULT 0 CHECK (refused_count >= 0),
  cancelled_count integer NOT NULL DEFAULT 0 CHECK (cancelled_count >= 0),
  -- The position of the last contact handled: the next batch takes the contacts after it.
  cursor_position integer NOT NULL DEFAULT 0,
  -- When the next batch is due (its job's start, paced by the number's send rate); NULL once ended.
  -- The minute sweep signals a running enrolment whose next batch is more than 10 minutes overdue.
  next_batch_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  created_by_user_id text NOT NULL,
  stopped_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT automation_enrollments_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT automation_enrollments_automation_fk FOREIGN KEY (tenant_id, automation_id)
    REFERENCES app.automations (tenant_id, id),
  CONSTRAINT automation_enrollments_segment_fk FOREIGN KEY (tenant_id, segment_id)
    REFERENCES app.segments (tenant_id, id),
  CONSTRAINT automation_enrollments_created_by_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT automation_enrollments_stopped_by_fk FOREIGN KEY (tenant_id, stopped_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT automation_enrollments_source CHECK ((source = 'segment') = (segment_id IS NOT NULL)),
  CONSTRAINT automation_enrollments_counts CHECK (
    started_count + refused_count + cancelled_count <= total
    AND cursor_position BETWEEN 0 AND total),
  CONSTRAINT automation_enrollments_end CHECK (
    (status = 'running' AND ended_at IS NULL AND end_reason IS NULL)
    OR (status = 'completed' AND ended_at IS NOT NULL AND end_reason IS NULL)
    OR (status = 'stopped' AND ended_at IS NOT NULL
        AND end_reason IN ('stopped_by_member', 'member_removed', 'automation_paused',
                           'automation_unavailable', 'channel_unavailable', 'not_in_plan',
                           'inputs_changed', 'marketing_not_allowed'))),
  CONSTRAINT automation_enrollments_stopped_by CHECK (
    (end_reason = 'stopped_by_member') = (stopped_by_membership_id IS NOT NULL)),
  CONSTRAINT automation_enrollments_inputs_cleared CHECK (status = 'running' OR inputs = '{}'::jsonb),
  CONSTRAINT automation_enrollments_next_batch CHECK ((status = 'running') = (next_batch_at IS NOT NULL))
);
-- At most one running enrolment per automation (ADR-401): a second waits until the first ends.
CREATE UNIQUE INDEX automation_enrollments_running_uq ON app.automation_enrollments (tenant_id, automation_id)
  WHERE status = 'running';
-- An automation's enrolments, newest first (its page).
CREATE INDEX automation_enrollments_list_idx
  ON app.automation_enrollments (tenant_id, automation_id, created_at DESC, id DESC);
CREATE TRIGGER automation_enrollments_touch BEFORE UPDATE ON app.automation_enrollments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
SELECT ops.apply_tenant_rls('app.automation_enrollments');
-- Members insert an enrolment whole; the job and a member's stop change only its progress and end.
GRANT SELECT, INSERT ON app.automation_enrollments TO w360_app;
GRANT UPDATE (status, end_reason, started_count, refused_count, cancelled_count, cursor_position,
  next_batch_at, inputs, stopped_by_membership_id, ended_at, updated_at)
  ON app.automation_enrollments TO w360_app;
-- The sweep's due list reads running enrolments by when their next batch is due.
CREATE INDEX automation_enrollments_due_idx ON app.automation_enrollments (next_batch_at)
  WHERE status = 'running';

CREATE TABLE app.automation_enrollment_contacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  -- The contact's place in the snapshot (1 to total, in contact id order).
  position integer NOT NULL CHECK (position >= 1),
  -- NULL once the contact was merged into another (the merge deletes it).
  contact_id uuid,
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'started', 'refused', 'cancelled')),
  -- Why a start was refused: a start step's code (ADR-077) or the enrolment's own.
  reason text CHECK (reason ~ '^[a-z_]{1,40}$'),
  -- The run started for the contact; NULL once retention deleted the run.
  run_id uuid,
  processed_at timestamptz,
  CONSTRAINT automation_enrollment_contacts_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT automation_enrollment_contacts_position_uq UNIQUE (tenant_id, enrollment_id, position),
  -- Each contact once per enrolment: a second run for it can never be started by the enrolment.
  CONSTRAINT automation_enrollment_contacts_contact_uq UNIQUE (tenant_id, enrollment_id, contact_id),
  CONSTRAINT automation_enrollment_contacts_enrollment_fk FOREIGN KEY (tenant_id, enrollment_id)
    REFERENCES app.automation_enrollments (tenant_id, id),
  CONSTRAINT automation_enrollment_contacts_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES app.contacts (tenant_id, id) ON DELETE SET NULL (contact_id),
  CONSTRAINT automation_enrollment_contacts_run_fk FOREIGN KEY (tenant_id, run_id)
    REFERENCES app.automation_runs (tenant_id, id) ON DELETE SET NULL (run_id),
  CONSTRAINT automation_enrollment_contacts_processed CHECK ((outcome = 'pending') = (processed_at IS NULL)),
  CONSTRAINT automation_enrollment_contacts_reason CHECK ((outcome = 'refused') = (reason IS NOT NULL)),
  CONSTRAINT automation_enrollment_contacts_run CHECK (run_id IS NULL OR outcome = 'started')
);
-- The foreign keys' lookups when a contact is merged away or retention deletes a run.
CREATE INDEX automation_enrollment_contacts_contact_idx
  ON app.automation_enrollment_contacts (tenant_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX automation_enrollment_contacts_run_idx
  ON app.automation_enrollment_contacts (tenant_id, run_id) WHERE run_id IS NOT NULL;
SELECT ops.apply_tenant_rls('app.automation_enrollment_contacts');
GRANT SELECT, INSERT ON app.automation_enrollment_contacts TO w360_app;
GRANT UPDATE (outcome, reason, run_id, processed_at) ON app.automation_enrollment_contacts TO w360_app;

-- A run an enrolment started records it, as a run started through the API records its key
-- (ADR-077): a run of an `api` automation names exactly one of the two, and no other run names
-- either. The new check replaces 0052's (validated by 0054) under the same name; rows already there
-- have no enrolment, so for them it is the check they were validated against. It and the foreign key
-- (a new column, NULL in every existing row) are added NOT VALID so app.automation_runs is not read
-- under this migration's lock; 0312 validates them without blocking writes. The partial index
-- serves the foreign key's check when an enrolment is deleted (company deletion step 692, after the
-- company's runs at 690): PostgreSQL proves `enrollment_id = $n` implies the index's predicate.
-- Building it reads the table once under the lock this migration already holds; every existing
-- row has no enrolment, so nothing is written to it, and runs are deleted 180 days after they end.
ALTER TABLE app.automation_runs
  ADD COLUMN enrollment_id uuid,
  DROP CONSTRAINT automation_runs_api_key,
  ADD CONSTRAINT automation_runs_api_key CHECK (
    num_nonnulls(api_key_id, enrollment_id) = CASE WHEN trigger_type = 'api' THEN 1 ELSE 0 END)
    NOT VALID,
  ADD CONSTRAINT automation_runs_enrollment_fk FOREIGN KEY (tenant_id, enrollment_id)
    REFERENCES app.automation_enrollments (tenant_id, id) NOT VALID;
CREATE INDEX automation_runs_enrollment_idx ON app.automation_runs (tenant_id, enrollment_id)
  WHERE enrollment_id IS NOT NULL;

-- What started a run stays fixed (0011, 0022, 0028, 0052, 0147), now including the enrolment.
CREATE OR REPLACE FUNCTION app.guard_automation_run() RETURNS trigger
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
  IF pg_catalog.current_setting('w360.contact_merge', true) = 'on'
     AND (pg_catalog.to_jsonb(NEW) - 'contact_id') = (pg_catalog.to_jsonb(OLD) - 'contact_id') THEN
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.automation_id, NEW.version_id, NEW.conversation_id, NEW.contact_id,
      NEW.channel_account_id, NEW.mode, NEW.trigger_type, NEW.trigger_message_id,
      NEW.started_by_membership_id, NEW.started_by_user_id, NEW.started_at, NEW.store_event,
      NEW.api_key_id, NEW.enrollment_id)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.automation_id, OLD.version_id, OLD.conversation_id, OLD.contact_id,
      OLD.channel_account_id, OLD.mode, OLD.trigger_type, OLD.trigger_message_id,
      OLD.started_by_membership_id, OLD.started_by_user_id, OLD.started_at, OLD.store_event,
      OLD.api_key_id, OLD.enrollment_id)
     OR (NEW.store_order_id IS DISTINCT FROM OLD.store_order_id AND NEW.store_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'what started an automation run is fixed' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.status NOT IN ('running', 'waiting') THEN
    IF (NEW.status, NEW.current_node_id, NEW.node_visit, NEW.waiting_for, NEW.wait_until,
        NEW.input_message_id, NEW.pending_message_id, NEW.retries, NEW.failures, NEW.step_count,
        NEW.message_count, NEW.http_call_count, NEW.visits, NEW.next_step_at, NEW.ended_at,
        NEW.end_reason, NEW.end_detail, NEW.ended_by_membership_id)
       IS DISTINCT FROM
       (OLD.status, OLD.current_node_id, OLD.node_visit, OLD.waiting_for, OLD.wait_until,
        OLD.input_message_id, OLD.pending_message_id, OLD.retries, OLD.failures, OLD.step_count,
        OLD.message_count, OLD.http_call_count, OLD.visits, OLD.next_step_at, OLD.ended_at,
        OLD.end_reason, OLD.end_detail, OLD.ended_by_membership_id)
       OR (NEW.variables IS DISTINCT FROM OLD.variables AND NEW.variables <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'an ended automation run cannot change' USING ERRCODE = 'W3403';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Deleted with the company (ADR-055): the contacts' outcomes before the runs they name (690), the
-- enrolments after the runs that name them and before the segments (720), automations (760) and
-- memberships (810) they name.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (685, ARRAY['app.automation_enrollment_contacts']::regclass[], 'batch'),
  (692, ARRAY['app.automation_enrollments']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.automation_enrollment_contacts TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.automation_enrollment_contacts FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.automation_enrollment_contacts FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
GRANT SELECT (tenant_id, id), DELETE ON app.automation_enrollments TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.automation_enrollments FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.automation_enrollments FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- Enrolments whose job was lost or ran out of retries (ADR-401): the minute sweep signals each
-- running enrolment of an active company whose next batch is more than 10 minutes overdue, with
-- what a signal needs (ids, the member who signs its job, the position its batch starts after).
-- Under the enrolment's row lock a batch only starts contacts after the stored position, so a
-- signal never starts a contact twice. Read through a policy for running rows only.
CREATE FUNCTION ops.automation_enrollments_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, enrollment_id uuid, actor_user_id text, cursor_position integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT e.tenant_id, e.id, e.created_by_user_id, e.cursor_position
    FROM app.automation_enrollments e
    JOIN app.tenants t ON t.id = e.tenant_id AND t.status = 'active'
   WHERE e.status = 'running' AND e.next_batch_at <= now() - interval '10 minutes'
   ORDER BY e.next_batch_at
   LIMIT least(greatest(p_limit, 1), 100)
$$;
GRANT SELECT (status, created_by_user_id, cursor_position, next_batch_at)
  ON app.automation_enrollments TO w360_definer;
CREATE POLICY enrollment_sweep_read ON app.automation_enrollments FOR SELECT TO w360_definer
  USING (status = 'running');
GRANT EXECUTE ON FUNCTION ops.automation_enrollments_due(integer) TO w360_app;
ALTER FUNCTION ops.automation_enrollments_due(integer) OWNER TO w360_definer;
