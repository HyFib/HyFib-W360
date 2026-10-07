-- 0196_crm_changed_by: who changed a CRM deal or task, for their webhook events (P5-09, P4-04,
-- ADR-277). A member, an automation's run or an API key (named) records itself with each change of
-- what the deal and task events report, and the capture triggers (0192, 0194) put it in every event
-- an update captures, so an integration that changes deals and tasks through the API can tell its
-- own changes from members' and automations', as ADR-270 does for orders (0187).

-- Columns ----------------------------------------------------------------------------------------

-- `changed_xact` is the transaction that recorded who made the change: a change made without
-- recording it (code from before this migration, during a rollout, or erasure retitling a deal)
-- must not keep the previous changer, so the trigger below clears a changer an older transaction
-- recorded. The foreign keys and the checks are added NOT VALID, so neither table is read under
-- this migration's lock: no row has a changer yet. 0197 validates them. A key is deleted only with
-- its company, after its deals and tasks (their creators' keys, 0169 and 0175, already hold them to
-- that order), and each foreign key finds the company's keys through UNIQUE (tenant_id, id).
ALTER TABLE app.crm_deals
  ADD COLUMN changed_by text,
  ADD COLUMN changed_by_api_key_id uuid,
  ADD COLUMN changed_xact xid8,
  ADD CONSTRAINT crm_deals_changed_by_api_key_fk
    FOREIGN KEY (tenant_id, changed_by_api_key_id) REFERENCES app.api_keys (tenant_id, id)
    NOT VALID,
  ADD CONSTRAINT crm_deals_changed_by CHECK (
    CASE WHEN changed_by = 'api' THEN changed_by_api_key_id IS NOT NULL
         ELSE (changed_by IS NULL OR changed_by IN ('member', 'automation'))
              AND changed_by_api_key_id IS NULL
    END) NOT VALID;

ALTER TABLE app.crm_tasks
  ADD COLUMN changed_by text,
  ADD COLUMN changed_by_api_key_id uuid,
  ADD COLUMN changed_xact xid8,
  ADD CONSTRAINT crm_tasks_changed_by_api_key_fk
    FOREIGN KEY (tenant_id, changed_by_api_key_id) REFERENCES app.api_keys (tenant_id, id)
    NOT VALID,
  ADD CONSTRAINT crm_tasks_changed_by CHECK (
    CASE WHEN changed_by = 'api' THEN changed_by_api_key_id IS NOT NULL
         ELSE (changed_by IS NULL OR changed_by IN ('member', 'automation'))
              AND changed_by_api_key_id IS NULL
    END) NOT VALID;

-- The runtime role changes deals and tasks (0013, column by column) and now records who with
-- them; it reads every column already. The definer role's erasure and merges record nobody.
GRANT UPDATE (changed_by, changed_by_api_key_id, changed_xact) ON app.crm_deals TO w360_app;
GRANT UPDATE (changed_by, changed_by_api_key_id, changed_xact) ON app.crm_tasks TO w360_app;

-- A change the events report keeps its changer only when this transaction recorded it. Both
-- tables name the columns alike, so one function serves them.
CREATE FUNCTION app.crm_changer() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.changed_xact IS DISTINCT FROM pg_current_xact_id() THEN
    NEW.changed_by := NULL;
    NEW.changed_by_api_key_id := NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION app.crm_changer() FROM PUBLIC;

-- The columns each table's events report (0192, 0194): any other change keeps its changer, and
-- sends nothing.
CREATE TRIGGER crm_deals_changer
  BEFORE UPDATE OF stage_id, status, owner_membership_id, title, value_minor, expected_close_on
  ON app.crm_deals
  FOR EACH ROW WHEN (NEW.stage_id IS DISTINCT FROM OLD.stage_id
                     OR NEW.status IS DISTINCT FROM OLD.status
                     OR NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id
                     OR NEW.title IS DISTINCT FROM OLD.title
                     OR NEW.value_minor IS DISTINCT FROM OLD.value_minor
                     OR NEW.expected_close_on IS DISTINCT FROM OLD.expected_close_on)
  EXECUTE FUNCTION app.crm_changer();

CREATE TRIGGER crm_tasks_changer
  BEFORE UPDATE OF status, assignee_membership_id, title, notes, due_at, remind_at ON app.crm_tasks
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status
                     OR NEW.assignee_membership_id IS DISTINCT FROM OLD.assignee_membership_id
                     OR NEW.title IS DISTINCT FROM OLD.title
                     OR NEW.notes IS DISTINCT FROM OLD.notes
                     OR NEW.due_at IS DISTINCT FROM OLD.due_at
                     OR NEW.remind_at IS DISTINCT FROM OLD.remind_at)
  EXECUTE FUNCTION app.crm_changer();

-- Events -----------------------------------------------------------------------------------------

-- 0192's deal capture with the changer in the `detail` of every event an update captures (null
-- when the change did not record one). The capture runs after the trigger above, so it reads the
-- changer that trigger left; an addition's creator is the deal's own (`created_by_*`), which the
-- payload reads. Replaced in place, so the trigger, owner and grants stay.
CREATE OR REPLACE FUNCTION app.webhook_capture_deal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_reopened boolean;
  v_closed boolean;
  v_changes text[];
  v_by jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.created', NULL, NULL, NEW.contact_id,
      NULL, NEW.status,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id),
      clock_timestamp());
    RETURN NULL;
  END IF;
  v_by := jsonb_build_object('changedBy', NEW.changed_by, 'apiKeyId', NEW.changed_by_api_key_id);
  v_reopened := NEW.status = 'open' AND OLD.status <> 'open';
  v_closed := NEW.status IS DISTINCT FROM OLD.status AND NOT v_reopened;
  IF v_reopened THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.status_changed', NULL, NULL,
      NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('dealId', NEW.id, 'stageId', OLD.stage_id, 'pipelineId', OLD.pipeline_id,
                         'previousStatus', OLD.status) || v_by,
      clock_timestamp());
  END IF;
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.stage_changed', NULL, NULL,
      NEW.contact_id, NULL, CASE WHEN v_closed THEN OLD.status ELSE NEW.status END,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id,
                         'previousStageId', OLD.stage_id,
                         'previousPipelineId',
                         CASE WHEN NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id
                              THEN OLD.pipeline_id END) || v_by,
      clock_timestamp());
  END IF;
  v_changes := array_remove(ARRAY[
    CASE WHEN NEW.title IS DISTINCT FROM OLD.title THEN 'title' END,
    CASE WHEN NEW.value_minor IS DISTINCT FROM OLD.value_minor THEN 'valueMinor' END,
    CASE WHEN NEW.expected_close_on IS DISTINCT FROM OLD.expected_close_on
         THEN 'expectedCloseOn' END], NULL);
  IF cardinality(v_changes) > 0 THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.updated', NULL, NULL,
      NEW.contact_id, NULL, CASE WHEN v_closed THEN OLD.status ELSE NEW.status END,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id,
                         'changes', to_jsonb(v_changes)) || v_by,
      clock_timestamp());
  END IF;
  IF NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.owner_changed', NULL, NULL,
      NEW.contact_id, NULL, CASE WHEN v_closed THEN OLD.status ELSE NEW.status END,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id,
                         'ownerId', NEW.owner_membership_id,
                         'previousOwnerId', OLD.owner_membership_id) || v_by,
      clock_timestamp());
  END IF;
  IF v_closed THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.status_changed', NULL, NULL,
      NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id,
                         'previousStatus', OLD.status) || v_by,
      clock_timestamp());
  END IF;
  RETURN NULL;
END
$$;

-- 0194's task capture with the changer likewise.
CREATE OR REPLACE FUNCTION app.webhook_capture_task() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_reopened boolean;
  v_closed boolean;
  v_changes text[];
  v_by jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'task.created', NULL, NULL, NEW.contact_id,
      NULL, NEW.status, jsonb_build_object('taskId', NEW.id), clock_timestamp());
    RETURN NULL;
  END IF;
  v_by := jsonb_build_object('changedBy', NEW.changed_by, 'apiKeyId', NEW.changed_by_api_key_id);
  v_reopened := NEW.status = 'open' AND OLD.status <> 'open';
  v_closed := NEW.status IS DISTINCT FROM OLD.status AND NOT v_reopened;
  IF v_reopened THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'task.status_changed', NULL, NULL,
      NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('taskId', NEW.id, 'previousStatus', OLD.status) || v_by,
      clock_timestamp());
  END IF;
  v_changes := array_remove(ARRAY[
    CASE WHEN NEW.title IS DISTINCT FROM OLD.title THEN 'title' END,
    CASE WHEN NEW.notes IS DISTINCT FROM OLD.notes THEN 'notes' END,
    CASE WHEN NEW.due_at IS DISTINCT FROM OLD.due_at THEN 'dueAt' END,
    CASE WHEN NEW.remind_at IS DISTINCT FROM OLD.remind_at THEN 'remindAt' END], NULL);
  IF cardinality(v_changes) > 0 THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'task.updated', NULL, NULL,
      NEW.contact_id, NULL, CASE WHEN v_closed THEN OLD.status ELSE NEW.status END,
      jsonb_build_object('taskId', NEW.id, 'changes', to_jsonb(v_changes)) || v_by,
      clock_timestamp());
  END IF;
  IF NEW.assignee_membership_id IS DISTINCT FROM OLD.assignee_membership_id THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'task.assignee_changed', NULL, NULL,
      NEW.contact_id, NULL, CASE WHEN v_closed THEN OLD.status ELSE NEW.status END,
      jsonb_build_object('taskId', NEW.id, 'assigneeId', NEW.assignee_membership_id,
                         'previousAssigneeId', OLD.assignee_membership_id) || v_by,
      clock_timestamp());
  END IF;
  IF v_closed THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'task.status_changed', NULL, NULL,
      NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('taskId', NEW.id, 'previousStatus', OLD.status) || v_by,
      clock_timestamp());
  END IF;
  RETURN NULL;
END
$$;
