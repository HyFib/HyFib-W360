-- 0070_webhook_conversation_members_teams: conversation events name the member and the team (P5-09,
-- ADR-094). The API names both since ADR-093; webhooks said only whether a member was assigned and
-- sent no move between members (0047). conversation.assignment_changed is now captured for every
-- change of the member (one assigned where none was, a move from one member to another, none any
-- more), and the new conversation.team_changed for every change of the team: a new conversation
-- placed in one by routing, a move by a member, an automation's hand-off or an API key, and the team
-- being deleted. Payloads are built when delivered, as for the events of 0025 and 0047.

-- Event types ------------------------------------------------------------------------------------------
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check CHECK (cardinality(event_types) BETWEEN 1 AND 15
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'conversation.team_changed',
                             'contact.created', 'contact.updated', 'contact.erased',
                             'automation.run_started', 'automation.run_ended', 'order.received',
                             'order.status_changed', 'campaign.status_changed']::text[]);

-- NOT VALID: new rows are checked at once, and 0071 checks the rows already there without holding the
-- lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'conversation.team_changed', 'contact.created',
    'contact.updated', 'contact.erased', 'automation.run_started', 'automation.run_ended',
    'order.received', 'order.status_changed', 'campaign.status_changed', 'ping')) NOT VALID;

-- Conversations ----------------------------------------------------------------------------------------
-- As in 0047, with the member before and after in the assignment event (membership ids, as GET
-- /members lists them) and the team event with the team before and after. One UPDATE that changes
-- several of these (routing places a conversation in a team and gives it a member) captures one event
-- for each. Each is stamped with the time it is captured, not the transaction's, as campaign events
-- are (0065): one transaction can change the member twice (a request unassigns the conversation and
-- moves it to a team whose routing gives it out again), and the changes must stay in order. The row
-- is locked while this runs, so a later change of the conversation is stamped later too.
CREATE OR REPLACE FUNCTION app.webhook_capture_conversation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'conversation.status_changed', NULL, NEW.id,
      NEW.contact_id, NULL, NEW.status, jsonb_build_object('previousStatus', OLD.status),
      clock_timestamp());
  END IF;
  IF NEW.assigned_membership_id IS DISTINCT FROM OLD.assigned_membership_id THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'conversation.assignment_changed', NULL, NEW.id,
      NEW.contact_id, NULL, NULL,
      jsonb_build_object('assigned', NEW.assigned_membership_id IS NOT NULL,
        'assigneeId', NEW.assigned_membership_id, 'previousAssigneeId', OLD.assigned_membership_id),
      clock_timestamp());
  END IF;
  IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'conversation.team_changed', NULL, NEW.id,
      NEW.contact_id, NULL, NULL,
      jsonb_build_object('teamId', NEW.team_id, 'previousTeamId', OLD.team_id), clock_timestamp());
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_conversation() FROM PUBLIC;

-- The team's deletion sets its conversations' team to none (0009), which fires this trigger too.
CREATE OR REPLACE TRIGGER conversations_webhook
  AFTER UPDATE OF status, assigned_membership_id, team_id ON app.conversations
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status
    OR NEW.assigned_membership_id IS DISTINCT FROM OLD.assigned_membership_id
    OR NEW.team_id IS DISTINCT FROM OLD.team_id)
  EXECUTE FUNCTION app.webhook_capture_conversation();
