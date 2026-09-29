-- 0042_api_text_replies: text replies through the public API (P5-08, ADR-070). A key with the new
-- `messages.reply` scope sends a free-form text message to a contact who wrote to the number in the
-- last 24 hours, as the inbox's reply does. Keys keep their scopes (the key guard), so existing keys
-- gain nothing: a key that should reply is created with the scope.

ALTER TABLE app.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE app.api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes) BETWEEN 1 AND 6
  AND scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write', 'messages.send',
                      'messages.send_marketing', 'messages.reply']::text[]);

-- A reply through the API takes the conversation over from an automation handling it, as a
-- member's reply does (queued bot messages are cancelled with the run). Unlike a member's reply it
-- is not an answer from a person: the run's end opens a hand-off turn (the conversation then waits
-- for a member), so the automation turn trigger needs no change.
ALTER TABLE app.automation_runs DROP CONSTRAINT automation_runs_end;
ALTER TABLE app.automation_runs ADD CONSTRAINT automation_runs_end CHECK (
  (status IN ('running', 'waiting') AND ended_at IS NULL AND end_reason IS NULL AND ended_by_membership_id IS NULL)
  OR (status = 'completed' AND ended_at IS NOT NULL AND end_reason IN ('end_node', 'no_next'))
  OR (status = 'handed_off' AND ended_at IS NOT NULL AND end_reason = 'handoff_node')
  OR (status = 'taken_over' AND ended_at IS NOT NULL
      AND end_reason IN ('agent_replied', 'assigned', 'take_over', 'api_replied'))
  OR (status = 'stopped' AND ended_at IS NOT NULL
      AND end_reason IN ('stopped_by_member', 'conversation_resolved', 'opted_out', 'contact_erased',
                         'automation_archived'))
  OR (status = 'failed' AND ended_at IS NOT NULL
      AND end_reason IN ('budget_steps', 'budget_loop', 'budget_messages', 'budget_http', 'expired',
                         'send_blocked', 'send_failed', 'error')));
