-- 0057_api_stop_automation_runs: stopping automation runs through the public API (P5-08, ADR-079).
-- A key with the `automations.start` scope stops a run started through the API: the run ends as
-- stopped with the reason `stopped_by_api`. Its queued messages are cancelled and the conversation
-- is not routed, as after a reply through the API (0042): the automation turn trigger opens a
-- hand-off turn when the conversation is open, so it needs no change.

-- NOT VALID: new and changed rows are checked at once, and 0058 checks the rows already there
-- without holding the lock this change takes (every run step updates this table).
ALTER TABLE app.automation_runs
  DROP CONSTRAINT automation_runs_end,
  ADD CONSTRAINT automation_runs_end CHECK (
    (status IN ('running', 'waiting') AND ended_at IS NULL AND end_reason IS NULL AND ended_by_membership_id IS NULL)
    OR (status = 'completed' AND ended_at IS NOT NULL AND end_reason IN ('end_node', 'no_next'))
    OR (status = 'handed_off' AND ended_at IS NOT NULL AND end_reason = 'handoff_node')
    OR (status = 'taken_over' AND ended_at IS NOT NULL
        AND end_reason IN ('agent_replied', 'assigned', 'take_over', 'api_replied'))
    OR (status = 'stopped' AND ended_at IS NOT NULL
        AND end_reason IN ('stopped_by_member', 'conversation_resolved', 'opted_out', 'contact_erased',
                           'automation_archived', 'stopped_by_api'))
    OR (status = 'failed' AND ended_at IS NOT NULL
        AND end_reason IN ('budget_steps', 'budget_loop', 'budget_messages', 'budget_http', 'expired',
                           'send_blocked', 'send_failed', 'error'))) NOT VALID;
