-- Number filters on webhook endpoints (P5-09, ADR-170).
--
-- An endpoint receives the events of every WhatsApp number its company has. A company with a number
-- per shop, brand or team can now give an endpoint the events of chosen numbers only: null keeps
-- every number, as before; a list holds 1 to 100 of the company's numbers (channel accounts), and
-- only while the endpoint takes an event that happens on a number, so a list never outlives its
-- events. Those are the message, conversation, automation run, order and campaign events; consent,
-- contact and template events belong to no number, and an endpoint that names numbers still receives
-- every one of them it takes. The services accept only numbers of the endpoint's company, which are
-- never deleted (a number is disconnected, not removed), so a list never names one that is gone. A
-- company has at most 10 endpoints, so the table is small and the check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN channel_account_ids uuid[],
  ADD CONSTRAINT webhook_endpoints_channel_account_ids CHECK (
    channel_account_ids IS NULL
    OR (cardinality(channel_account_ids) BETWEEN 1 AND 100
        AND array_position(channel_account_ids, NULL) IS NULL
        AND event_types && ARRAY['message.received', 'message.status',
                                 'conversation.status_changed', 'conversation.assignment_changed',
                                 'conversation.team_changed', 'automation.run_started',
                                 'automation.run_ended', 'order.received', 'order.status_changed',
                                 'campaign.status_changed']::text[]));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (channel_account_ids) ON app.webhook_endpoints TO w360_app;

-- 0114's capture with the number filter. The triggers of number events now pass the number the
-- event happened on as `channelId` in the detail (below); it is taken out before the event is
-- stored, so stored events stay as they were (the payload reads the number from the message,
-- conversation, run, order or campaign when it is delivered). A number event is delivered only to
-- the active endpoints that take it, pass its other filters and whose list is null or holds the
-- number, and no event is written when none takes it; a campaign without a number yet is on no
-- endpoint's list. Other types are captured as before. Same signature, so its owner and grants stay
-- (0025); replays and test events do not pass through here.
CREATE OR REPLACE FUNCTION app.capture_webhook_event(p_tenant uuid, p_type text, p_message uuid,
  p_conversation uuid, p_contact uuid, p_template uuid, p_status text, p_detail jsonb,
  p_occurred_at timestamptz) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_event uuid := gen_random_uuid();
  v_channel uuid := (p_detail ->> 'channelId')::uuid;
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb) - 'channelId';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND p_type = ANY (e.event_types)
                    AND (p_type <> 'message.status' OR e.message_statuses IS NULL
                         OR p_status = ANY (e.message_statuses))
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

-- The triggers of number events, as 0025, 0070, 0055, 0063 and 0065 left them, each also passing
-- the number of the row that changed. They keep their names, owners and triggers, and run with the
-- rights of whoever makes the change, as before.

-- message.received and message.status (0025).
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
        'errorTitle', left(NEW.error_title, 200), 'channelId', NEW.channel_account_id)),
      NEW.status_at);
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_message() FROM PUBLIC;

-- The conversation's status, member and team (0070).
CREATE OR REPLACE FUNCTION app.webhook_capture_conversation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'conversation.status_changed', NULL, NEW.id,
      NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('previousStatus', OLD.status, 'channelId', NEW.channel_account_id),
      clock_timestamp());
  END IF;
  IF NEW.assigned_membership_id IS DISTINCT FROM OLD.assigned_membership_id THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'conversation.assignment_changed', NULL, NEW.id,
      NEW.contact_id, NULL, NULL,
      jsonb_build_object('assigned', NEW.assigned_membership_id IS NOT NULL,
        'assigneeId', NEW.assigned_membership_id, 'previousAssigneeId', OLD.assigned_membership_id,
        'channelId', NEW.channel_account_id),
      clock_timestamp());
  END IF;
  IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'conversation.team_changed', NULL, NEW.id,
      NEW.contact_id, NULL, NULL,
      jsonb_build_object('teamId', NEW.team_id, 'previousTeamId', OLD.team_id,
        'channelId', NEW.channel_account_id),
      clock_timestamp());
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_conversation() FROM PUBLIC;

-- automation.run_started and automation.run_ended (0055).
CREATE OR REPLACE FUNCTION app.webhook_capture_automation_run() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'automation.run_started', NULL,
      NEW.conversation_id, NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('runId', NEW.id, 'automationId', NEW.automation_id,
        'channelId', NEW.channel_account_id),
      NEW.started_at);
  ELSE
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'automation.run_ended', NULL,
      NEW.conversation_id, NEW.contact_id, NULL, NEW.status,
      jsonb_strip_nulls(jsonb_build_object('runId', NEW.id, 'automationId', NEW.automation_id,
        'endReason', NEW.end_reason, 'channelId', NEW.channel_account_id)),
      NEW.ended_at);
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_automation_run() FROM PUBLIC;

-- order.received and order.status_changed (0063).
CREATE OR REPLACE FUNCTION app.webhook_capture_order() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'order.received', NULL,
      NEW.conversation_id, NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('orderId', NEW.id, 'channelId', NEW.channel_account_id),
      NEW.received_at);
  ELSE
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'order.status_changed', NULL,
      NEW.conversation_id, NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('orderId', NEW.id, 'previousStatus', OLD.status,
        'channelId', NEW.channel_account_id),
      NEW.status_changed_at);
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_order() FROM PUBLIC;

-- campaign.status_changed (0065). A campaign has no number until one is chosen for it; its
-- `channelId` is then null.
CREATE OR REPLACE FUNCTION app.webhook_capture_campaign() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM app.capture_webhook_event(NEW.tenant_id, 'campaign.status_changed', NULL, NULL, NULL,
    NULL, NEW.status,
    jsonb_build_object('campaignId', NEW.id, 'previousStatus', OLD.status,
      'pauseReason', CASE WHEN NEW.status = 'paused' THEN NEW.pause_reason END,
      'completionReason', CASE WHEN NEW.status = 'completed' THEN NEW.completion_reason END,
      'channelId', NEW.channel_account_id),
    clock_timestamp());
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_campaign() FROM PUBLIC;
