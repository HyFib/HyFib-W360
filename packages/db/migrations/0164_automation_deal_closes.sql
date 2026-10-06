-- 0164_automation_deal_closes: automation steps that close the run's contact's deal (ADR-251).
--
-- The deal needs nothing new: it is closed as a member closes it, with no member as its closer, and
-- its `deal_won` or `deal_lost` activity names the automation and the run. Run steps get the outcome
-- `closed`; a step that closed nothing is logged as `skipped` with the reason.
-- The replaced outcome check is added NOT VALID, as in 0162; 0165 validates it.
ALTER TABLE app.automation_run_steps DROP CONSTRAINT automation_run_steps_outcome_check;
ALTER TABLE app.automation_run_steps ADD CONSTRAINT automation_run_steps_outcome_check
  CHECK (outcome IN ('started', 'sent', 'asked', 'answered', 'retried', 'timed_out', 'branched', 'updated',
    'waiting', 'resumed', 'handed_off', 'completed', 'failed', 'stopped', 'taken_over', 'requested',
    'responded', 'created', 'skipped', 'moved', 'closed')) NOT VALID;
