-- Filters on who sent a message, for message statuses on webhook endpoints (P5-09, ADR-172).
--
-- An endpoint that takes message.status (0025) receives the statuses of every message the company
-- sends: members' replies, automations' messages, campaigns, the API's sends and HyFib's own (store
-- order updates, satisfaction surveys). It can now take only the statuses of messages some of them
-- sent (the API's, say): null keeps every sender, as before; a list holds 1 to 5 of `agent`, `bot`,
-- `campaign`, `api` and `system`, the sender the event reports as `message.sentBy`, and only while
-- the endpoint takes message.status, so a list never outlives its event. It narrows message.status
-- alone, with the statuses an endpoint names (0095). A company has at most 10 endpoints, so the
-- table is small and the check is validated here. Containment refuses a list holding a null, and
-- `contact`, which sends no status.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN message_senders text[],
  ADD CONSTRAINT webhook_endpoints_message_senders CHECK (
    message_senders IS NULL
    OR (cardinality(message_senders) BETWEEN 1 AND 5
        AND message_senders <@ ARRAY['agent', 'bot', 'campaign', 'api', 'system']::text[]
        AND 'message.status' = ANY (event_types)));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (message_senders) ON app.webhook_endpoints TO w360_app;

-- 0118's capture with the sender filter: message.status's trigger (below) passes who sent the
-- message as `sentBy` in the detail, as the payload names it, and the capture takes it out with the
-- number before the event is stored, so stored events stay as they were. A message.status event is
-- delivered only to the active endpoints that take it, whose statuses (0095) and numbers (0118)
-- match and whose list is null or holds the sender, and no event is written when none takes it.
-- Other types are captured as before. Same signature, so its owner and grants stay (0025); replays
-- and test events do not pass through here.
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
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb) - 'channelId' - 'sentBy';
BEGIN
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
                         OR v_channel = ANY (e.channel_account_ids))) THEN
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
          OR v_channel = ANY (e.channel_account_ids));
END
$$;

-- message.received and message.status as 0118 left them, message.status also passing who sent the
-- message: a member (`agent`), an automation (`bot`), a campaign, the API, or HyFib itself
-- (`system`), as `message.sentBy` names it when the event is delivered. Same name, owner and
-- triggers.
CREATE OR REPLACE FUNCTION app.webhook_capture_message() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'message.received', NEW.id,
      NEW.conversation_id, NULL, NULL, NULL,
      jsonb_build_object('messageType', NEW.type, 'channelId', NEW.channel_account_id),
      coalesce(NEW.provider_timestamp, NEW.created_at));
  ELSE
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'message.status', NEW.id,
      NEW.conversation_id, NULL, NEW.template_id, NEW.status,
      jsonb_strip_nulls(jsonb_build_object('errorCode', NEW.error_code,
        'errorTitle', left(NEW.error_title, 200), 'channelId', NEW.channel_account_id,
        'sentBy', CASE WHEN NEW.sender_type IN ('agent', 'bot', 'campaign', 'api')
                       THEN NEW.sender_type ELSE 'system' END)),
      NEW.status_at);
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_message() FROM PUBLIC;
