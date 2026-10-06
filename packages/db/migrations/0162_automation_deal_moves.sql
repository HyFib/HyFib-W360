-- 0162_automation_deal_moves: automation steps that move the run's contact's deal (ADR-250).
--
-- The deal itself needs nothing new: the move updates its stage as a member's move does, and its
-- `stage_changed` activity names the automation and the run. Run steps get the outcome `moved`; a
-- step that moved nothing is logged as `skipped` with the reason, as task and deal steps are.
-- The replaced outcome check is added NOT VALID, so adding it does not read the table while holding
-- its lock; 0163 validates it. New rows are checked from now on.
ALTER TABLE app.automation_run_steps DROP CONSTRAINT automation_run_steps_outcome_check;
ALTER TABLE app.automation_run_steps ADD CONSTRAINT automation_run_steps_outcome_check
  CHECK (outcome IN ('started', 'sent', 'asked', 'answered', 'retried', 'timed_out', 'branched', 'updated',
    'waiting', 'resumed', 'handed_off', 'completed', 'failed', 'stopped', 'taken_over', 'requested',
    'responded', 'created', 'skipped', 'moved')) NOT VALID;
