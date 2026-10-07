-- 0158_automation_tasks: CRM tasks that automations create (P4-01, P4-04, ADR-244).
--
-- A task is created either by a member or by a run of an automation: `created_by_automation_id`
-- names the automation (the task's activity names the run). Run steps get the outcomes `created`
-- and `skipped` (a task step that could not create its task: the step log says why).
-- The check that exactly one creator is set, the foreign key to the automation and the replaced
-- outcome check are added NOT VALID, so adding them does not read the tables while holding their
-- locks; 0159 validates them. New rows are checked from now on.
ALTER TABLE app.crm_tasks ADD COLUMN created_by_automation_id uuid;
ALTER TABLE app.crm_tasks ALTER COLUMN created_by_membership_id DROP NOT NULL;
ALTER TABLE app.crm_tasks
  ADD CONSTRAINT crm_tasks_created_by_automation_fk FOREIGN KEY (tenant_id, created_by_automation_id)
    REFERENCES app.automations (tenant_id, id) NOT VALID;
ALTER TABLE app.crm_tasks
  ADD CONSTRAINT crm_tasks_creator
    CHECK (num_nonnulls(created_by_membership_id, created_by_automation_id) = 1) NOT VALID;

-- Step log: a task step created its task, or skipped it.
ALTER TABLE app.automation_run_steps DROP CONSTRAINT automation_run_steps_outcome_check;
ALTER TABLE app.automation_run_steps ADD CONSTRAINT automation_run_steps_outcome_check
  CHECK (outcome IN ('started', 'sent', 'asked', 'answered', 'retried', 'timed_out', 'branched', 'updated',
    'waiting', 'resumed', 'handed_off', 'completed', 'failed', 'stopped', 'taken_over', 'requested',
    'responded', 'created', 'skipped')) NOT VALID;
