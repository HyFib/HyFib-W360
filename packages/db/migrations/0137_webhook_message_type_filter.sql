-- Message type filters on webhook endpoints (P5-09, ADR-191).
--
-- An endpoint that takes message.received receives every message customers send, or those its
-- numbers, teams and members keep (0118 to 0128), whatever its type. A receiver that handles some
-- kinds only (a bot answering text and taps on its buttons, an order system taking carts, an archive
-- of documents) can now choose them: null keeps every type, as before; a list holds 1 to 14 of the
-- types a received message has (text, image, video, audio, document, sticker, location, contacts,
-- interactive, button, reaction, order, system, unsupported; the payload's message.type), and only
-- while the endpoint takes message.received, so a list never outlives its event. Other events are
-- not narrowed. A company has at most 10 endpoints, so the table is small and the check is
-- validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN message_types text[],
  ADD CONSTRAINT webhook_endpoints_message_types CHECK (
    message_types IS NULL
    OR (cardinality(message_types) BETWEEN 1 AND 14
        AND array_ndims(message_types) = 1
        AND array_position(message_types, NULL) IS NULL
        AND message_types <@ ARRAY['text', 'image', 'video', 'audio', 'document', 'sticker',
                                   'location', 'contacts', 'interactive', 'button', 'reaction',
                                   'order', 'system', 'unsupported']::text[]
        AND 'message.received' = ANY (event_types)));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (message_types) ON app.webhook_endpoints TO w360_app;

-- 0135's capture with the message type filter: a message.received event is delivered only to the
-- active endpoints that take it, pass its other filters (0118 to 0128) and whose list is null or
-- holds the message's type, as the message trigger has always stored it in the detail (0120); no
-- event is written when no endpoint takes it. Other types are captured as before. Same signature, so
-- its owner and grants stay (0025); replays and test events do not pass through here.
CREATE OR REPLACE FUNCTION app.capture_webhook_event(p_tenant uuid, p_type text, p_message uuid,
  p_conversation uuid, p_contact uuid, p_template uuid, p_status text, p_detail jsonb,
  p_occurred_at timestamptz) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_event uuid := gen_random_uuid();
  v_channel uuid := (p_detail ->> 'channelId')::uuid;
  v_sender text := p_detail ->> 'sentBy';
  v_run_trigger text := p_detail ->> 'runTrigger';
  v_campaign uuid := CASE WHEN p_type IN ('message.status', 'campaign.status_changed')
                           THEN (p_detail ->> 'campaignId')::uuid END;
  v_consent text := CASE WHEN p_type = 'consent.changed'
                          THEN (p_detail ->> 'purpose') || '_' || (p_detail ->> 'action') END;
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb) - 'channelId' - 'sentBy' - 'runTrigger';
  v_team uuid;
  v_left_team uuid := CASE WHEN p_type = 'conversation.team_changed'
                           THEN (p_detail ->> 'previousTeamId')::uuid END;
  v_assignee uuid;
  v_left_assignee uuid := CASE WHEN p_type = 'conversation.assignment_changed'
                               THEN (p_detail ->> 'previousAssigneeId')::uuid END;
BEGIN
  -- A message's campaign travels in the detail for the filter only: the payload reads it from the
  -- message. A campaign's own event keeps it (0065).
  IF p_type = 'message.status' THEN
    v_detail := v_detail - 'campaignId';
  END IF;
  -- The team the conversation is in now and the member it is assigned to, read only when an active
  -- endpoint of the company that takes the event names teams or members (the row itself for a
  -- conversation's events: the trigger runs after the change).
  IF p_conversation IS NOT NULL
     AND p_type IN ('message.received', 'message.status', 'conversation.status_changed',
                    'conversation.assignment_changed', 'conversation.team_changed')
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND (e.team_ids IS NOT NULL OR e.assignee_ids IS NOT NULL)
                    AND p_type = ANY (e.event_types)) THEN
    SELECT c.team_id, c.assigned_membership_id INTO v_team, v_assignee FROM app.conversations c
     WHERE c.tenant_id = p_tenant AND c.id = p_conversation;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND p_type = ANY (e.event_types)
                    AND (p_type <> 'message.status' OR e.message_statuses IS NULL
                         OR p_status = ANY (e.message_statuses))
                    AND (p_type <> 'message.status' OR e.message_senders IS NULL
                         OR v_sender = ANY (e.message_senders))
                    AND (p_type NOT IN ('automation.run_started', 'automation.run_ended')
                         OR e.automation_ids IS NULL
                         OR (p_detail ->> 'automationId')::uuid = ANY (e.automation_ids))
                    AND (p_type <> 'automation.run_ended' OR e.run_end_statuses IS NULL
                         OR p_status = ANY (e.run_end_statuses))
                    AND (p_type NOT IN ('automation.run_started', 'automation.run_ended')
                         OR e.run_triggers IS NULL OR v_run_trigger = ANY (e.run_triggers))
                    AND (p_type <> 'campaign.status_changed' OR e.campaign_statuses IS NULL
                         OR p_status = ANY (e.campaign_statuses))
                    AND (p_type <> 'order.status_changed' OR e.order_statuses IS NULL
                         OR p_status = ANY (e.order_statuses))
                    AND (p_type <> 'template.status_changed' OR e.template_statuses IS NULL
                         OR p_status = ANY (e.template_statuses))
                    AND (p_type <> 'conversation.status_changed' OR e.conversation_statuses IS NULL
                         OR p_status = ANY (e.conversation_statuses))
                    AND (e.channel_account_ids IS NULL
                         OR p_type NOT IN ('message.received', 'message.status',
                                           'conversation.status_changed',
                                           'conversation.assignment_changed',
                                           'conversation.team_changed', 'automation.run_started',
                                           'automation.run_ended', 'order.received',
                                           'order.status_changed', 'campaign.status_changed')
                         OR v_channel = ANY (e.channel_account_ids))
                    AND (e.team_ids IS NULL
                         OR p_type NOT IN ('message.received', 'message.status',
                                           'conversation.status_changed',
                                           'conversation.assignment_changed',
                                           'conversation.team_changed')
                         OR v_team = ANY (e.team_ids) OR v_left_team = ANY (e.team_ids))
                    AND (e.template_ids IS NULL
                         OR p_type NOT IN ('message.status', 'template.status_changed')
                         OR p_template = ANY (e.template_ids))
                    AND (e.assignee_ids IS NULL
                         OR p_type NOT IN ('message.received', 'message.status',
                                           'conversation.status_changed',
                                           'conversation.assignment_changed',
                                           'conversation.team_changed')
                         OR v_assignee = ANY (e.assignee_ids)
                         OR v_left_assignee = ANY (e.assignee_ids))
                    AND (e.campaign_ids IS NULL
                         OR p_type NOT IN ('message.status', 'campaign.status_changed')
                         OR v_campaign = ANY (e.campaign_ids))
                    AND (p_type <> 'consent.changed' OR e.consent_changes IS NULL
                         OR v_consent = ANY (e.consent_changes))
                    AND (p_type <> 'message.received' OR e.message_types IS NULL
                         OR (p_detail ->> 'messageType') = ANY (e.message_types))) THEN
    RETURN;
  END IF;
  INSERT INTO app.webhook_events (id, tenant_id, type, message_id, conversation_id, contact_id,
    template_id, status, detail, occurred_at)
  VALUES (v_event, p_tenant, p_type, p_message, p_conversation, p_contact, p_template, p_status,
    v_detail, coalesce(p_occurred_at, now()));
  INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id)
  SELECT gen_random_uuid(), p_tenant, e.id, v_event
    FROM app.webhook_endpoints e
   WHERE e.tenant_id = p_tenant AND e.state = 'active' AND p_type = ANY (e.event_types)
     AND (p_type <> 'message.status' OR e.message_statuses IS NULL
          OR p_status = ANY (e.message_statuses))
     AND (p_type <> 'message.status' OR e.message_senders IS NULL
          OR v_sender = ANY (e.message_senders))
     AND (p_type NOT IN ('automation.run_started', 'automation.run_ended')
          OR e.automation_ids IS NULL
          OR (p_detail ->> 'automationId')::uuid = ANY (e.automation_ids))
     AND (p_type <> 'automation.run_ended' OR e.run_end_statuses IS NULL
          OR p_status = ANY (e.run_end_statuses))
     AND (p_type NOT IN ('automation.run_started', 'automation.run_ended')
          OR e.run_triggers IS NULL OR v_run_trigger = ANY (e.run_triggers))
     AND (p_type <> 'campaign.status_changed' OR e.campaign_statuses IS NULL
          OR p_status = ANY (e.campaign_statuses))
     AND (p_type <> 'order.status_changed' OR e.order_statuses IS NULL
          OR p_status = ANY (e.order_statuses))
     AND (p_type <> 'template.status_changed' OR e.template_statuses IS NULL
          OR p_status = ANY (e.template_statuses))
     AND (p_type <> 'conversation.status_changed' OR e.conversation_statuses IS NULL
          OR p_status = ANY (e.conversation_statuses))
     AND (e.channel_account_ids IS NULL
          OR p_type NOT IN ('message.received', 'message.status', 'conversation.status_changed',
                            'conversation.assignment_changed', 'conversation.team_changed',
                            'automation.run_started', 'automation.run_ended', 'order.received',
                            'order.status_changed', 'campaign.status_changed')
          OR v_channel = ANY (e.channel_account_ids))
     AND (e.team_ids IS NULL
          OR p_type NOT IN ('message.received', 'message.status', 'conversation.status_changed',
                            'conversation.assignment_changed', 'conversation.team_changed')
          OR v_team = ANY (e.team_ids) OR v_left_team = ANY (e.team_ids))
     AND (e.template_ids IS NULL OR p_type NOT IN ('message.status', 'template.status_changed')
          OR p_template = ANY (e.template_ids))
     AND (e.assignee_ids IS NULL
          OR p_type NOT IN ('message.received', 'message.status', 'conversation.status_changed',
                            'conversation.assignment_changed', 'conversation.team_changed')
          OR v_assignee = ANY (e.assignee_ids) OR v_left_assignee = ANY (e.assignee_ids))
     AND (e.campaign_ids IS NULL OR p_type NOT IN ('message.status', 'campaign.status_changed')
          OR v_campaign = ANY (e.campaign_ids))
     AND (p_type <> 'consent.changed' OR e.consent_changes IS NULL
          OR v_consent = ANY (e.consent_changes))
     AND (p_type <> 'message.received' OR e.message_types IS NULL
          OR (p_detail ->> 'messageType') = ANY (e.message_types));
END
$$;
