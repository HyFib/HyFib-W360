-- 0185_webhook_deal_owner_events: an outgoing webhook event when a CRM deal's owner changes
-- (P5-09, P4-04, ADR-269). deal.owner_changed is captured when a deal is given to another member,
-- or left without an owner, by a member or an API key (ADR-255): automations set an owner only on
-- the deals they add (deal.created). It joins the deal events the pipeline, stage and owner filters
-- narrow (0179 to 0181), and reaches the endpoints of the owner it left as well as of the new one,
-- as conversation.assignment_changed reaches both members (0128).

-- Event types ------------------------------------------------------------------------------------

-- A company has at most 10 endpoints, so the endpoints' checks are validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check
    CHECK (cardinality(event_types) BETWEEN 1 AND 22
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'conversation.team_changed',
                             'contact.created', 'contact.updated', 'contact.erased',
                             'contact.merged', 'automation.run_started', 'automation.run_ended',
                             'order.received', 'order.status_changed',
                             'campaign.status_changed', 'deal.created', 'deal.stage_changed',
                             'deal.owner_changed', 'deal.status_changed', 'task.created',
                             'task.status_changed']::text[]);

-- NOT VALID: new rows are checked at once, and 0186 checks the rows already there without holding
-- the lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'conversation.team_changed', 'contact.created',
    'contact.updated', 'contact.erased', 'contact.merged', 'automation.run_started',
    'automation.run_ended', 'order.received', 'order.status_changed', 'campaign.status_changed',
    'deal.created', 'deal.stage_changed', 'deal.owner_changed', 'deal.status_changed',
    'task.created', 'task.status_changed', 'ping')) NOT VALID;

-- The pipeline, stage and owner lists (0179 to 0181) are kept while an endpoint takes any deal
-- event, the owner change included; the rest of each check is unchanged.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_pipeline_ids,
  ADD CONSTRAINT webhook_endpoints_pipeline_ids CHECK (
    pipeline_ids IS NULL
    OR (cardinality(pipeline_ids) BETWEEN 1 AND 50
        AND array_ndims(pipeline_ids) = 1
        AND array_position(pipeline_ids, NULL) IS NULL
        AND event_types && ARRAY['deal.created', 'deal.stage_changed', 'deal.owner_changed',
                                 'deal.status_changed']::text[])),
  DROP CONSTRAINT webhook_endpoints_stage_ids,
  ADD CONSTRAINT webhook_endpoints_stage_ids CHECK (
    stage_ids IS NULL
    OR (cardinality(stage_ids) BETWEEN 1 AND 50
        AND array_ndims(stage_ids) = 1
        AND array_position(stage_ids, NULL) IS NULL
        AND event_types && ARRAY['deal.created', 'deal.stage_changed', 'deal.owner_changed',
                                 'deal.status_changed']::text[])),
  DROP CONSTRAINT webhook_endpoints_owner_ids,
  ADD CONSTRAINT webhook_endpoints_owner_ids CHECK (
    owner_ids IS NULL
    OR (cardinality(owner_ids) BETWEEN 1 AND 50
        AND array_ndims(owner_ids) = 1
        AND array_position(owner_ids, NULL) IS NULL
        AND event_types && ARRAY['deal.created', 'deal.stage_changed', 'deal.owner_changed',
                                 'deal.status_changed']::text[]));

-- Deals ------------------------------------------------------------------------------------------

-- 0171's trigger with the owner change. The event keeps the deal, its stage and pipeline, its new
-- owner and the one before (null when it had none) in `detail`, with the contact and the status it
-- reports. One update that changes the owner with the stage or the status captures them in the
-- order members' and keys' changes are made (ADR-255): reopened, moved, given to another owner,
-- closed; each event gives the deal as its step left it, stamped with the time it is captured.
CREATE OR REPLACE FUNCTION app.webhook_capture_deal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_reopened boolean;
  v_closed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.created', NULL, NULL, NEW.contact_id,
      NULL, NEW.status,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id),
      clock_timestamp());
    RETURN NULL;
  END IF;
  v_reopened := NEW.status = 'open' AND OLD.status <> 'open';
  v_closed := NEW.status IS DISTINCT FROM OLD.status AND NOT v_reopened;
  IF v_reopened THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.status_changed', NULL, NULL,
      NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('dealId', NEW.id, 'stageId', OLD.stage_id, 'pipelineId', OLD.pipeline_id,
                         'previousStatus', OLD.status),
      clock_timestamp());
  END IF;
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.stage_changed', NULL, NULL,
      NEW.contact_id, NULL, CASE WHEN v_closed THEN OLD.status ELSE NEW.status END,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id,
                         'previousStageId', OLD.stage_id,
                         'previousPipelineId',
                         CASE WHEN NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id
                              THEN OLD.pipeline_id END),
      clock_timestamp());
  END IF;
  IF NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.owner_changed', NULL, NULL,
      NEW.contact_id, NULL, CASE WHEN v_closed THEN OLD.status ELSE NEW.status END,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id,
                         'ownerId', NEW.owner_membership_id,
                         'previousOwnerId', OLD.owner_membership_id),
      clock_timestamp());
  END IF;
  IF v_closed THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.status_changed', NULL, NULL,
      NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id,
                         'previousStatus', OLD.status),
      clock_timestamp());
  END IF;
  RETURN NULL;
END
$$;

-- Erasure and merges change neither the owner, the stage nor the status, so they still send
-- nothing here. Replaced in place, so the trigger's name and table stay.
CREATE OR REPLACE TRIGGER crm_deals_webhook_changed
  AFTER UPDATE OF stage_id, status, owner_membership_id ON app.crm_deals
  FOR EACH ROW WHEN (NEW.stage_id IS DISTINCT FROM OLD.stage_id
                     OR NEW.status IS DISTINCT FROM OLD.status
                     OR NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id)
  EXECUTE FUNCTION app.webhook_capture_deal();

-- 0183's capture with the owner change among the deal events: the pipeline and stage filters read
-- the deal's as the change left them, and the owner filter matches the new owner or the one it
-- left. Same signature, so its owner and grants stay (0025); replays and test events do not pass
-- through here.
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
  v_end_reasons text[] := CASE WHEN p_type = 'automation.run_ended' THEN
    CASE p_status
      WHEN 'completed' THEN ARRAY['end_node', 'no_next']
      WHEN 'handed_off' THEN ARRAY['handoff_node']
      WHEN 'taken_over' THEN ARRAY['agent_replied', 'assigned', 'take_over', 'api_replied']
      WHEN 'stopped' THEN ARRAY['stopped_by_member', 'conversation_resolved', 'opted_out',
                                'contact_erased', 'automation_archived', 'stopped_by_api']
      WHEN 'failed' THEN ARRAY['budget_steps', 'budget_loop', 'budget_messages', 'budget_http',
                               'expired', 'send_blocked', 'send_failed', 'error']
    END END;
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb) - 'channelId' - 'sentBy' - 'runTrigger';
  v_team uuid;
  v_left_team uuid := CASE WHEN p_type = 'conversation.team_changed'
                           THEN (p_detail ->> 'previousTeamId')::uuid END;
  v_assignee uuid;
  v_left_assignee uuid := CASE WHEN p_type = 'conversation.assignment_changed'
                               THEN (p_detail ->> 'previousAssigneeId')::uuid END;
  v_pipeline uuid := CASE WHEN p_type IN ('deal.created', 'deal.stage_changed',
                                          'deal.owner_changed', 'deal.status_changed')
                          THEN (p_detail ->> 'pipelineId')::uuid END;
  v_left_pipeline uuid := CASE WHEN p_type = 'deal.stage_changed'
                               THEN (p_detail ->> 'previousPipelineId')::uuid END;
  v_stage uuid := CASE WHEN p_type IN ('deal.created', 'deal.stage_changed', 'deal.owner_changed',
                                       'deal.status_changed')
                       THEN (p_detail ->> 'stageId')::uuid END;
  v_left_stage uuid := CASE WHEN p_type = 'deal.stage_changed'
                            THEN (p_detail ->> 'previousStageId')::uuid END;
  v_owner uuid;
  v_left_owner uuid := CASE WHEN p_type = 'deal.owner_changed'
                            THEN (p_detail ->> 'previousOwnerId')::uuid END;
  v_task_assignee uuid;
  v_contact_tags text[];
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
  -- The tags the conversation's contact has now, read only when an active endpoint of the company
  -- that takes the event names contact tags (the contact's tag rows as this transaction sees them).
  IF p_conversation IS NOT NULL
     AND p_type IN ('message.received', 'message.status', 'conversation.status_changed',
                    'conversation.assignment_changed', 'conversation.team_changed')
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND e.contact_tags IS NOT NULL AND p_type = ANY (e.event_types)) THEN
    SELECT array_agg(t.tag) INTO v_contact_tags
      FROM app.conversations c
      JOIN app.contact_tags t ON t.tenant_id = c.tenant_id AND t.contact_id = c.contact_id
     WHERE c.tenant_id = p_tenant AND c.id = p_conversation;
  END IF;
  -- The member who owns the deal now, read only when an active endpoint of the company that takes
  -- the event names owners (the row itself: the deal trigger runs after the change).
  IF p_type IN ('deal.created', 'deal.stage_changed', 'deal.owner_changed', 'deal.status_changed')
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active' AND e.owner_ids IS NOT NULL
                    AND p_type = ANY (e.event_types)) THEN
    SELECT d.owner_membership_id INTO v_owner FROM app.crm_deals d
     WHERE d.tenant_id = p_tenant AND d.id = (p_detail ->> 'dealId')::uuid;
  END IF;
  -- The member the task is assigned to now, likewise read only when an active endpoint of the
  -- company that takes the event names task assignees (the task trigger runs after the change).
  IF p_type IN ('task.created', 'task.status_changed')
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND e.task_assignee_ids IS NOT NULL AND p_type = ANY (e.event_types)) THEN
    SELECT t.assignee_membership_id INTO v_task_assignee FROM app.crm_tasks t
     WHERE t.tenant_id = p_tenant AND t.id = (p_detail ->> 'taskId')::uuid;
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
                         OR (p_detail ->> 'messageType') = ANY (e.message_types))
                    AND (p_type <> 'automation.run_ended' OR e.run_end_reasons IS NULL
                         OR (p_detail ->> 'endReason') = ANY (e.run_end_reasons)
                         OR NOT (e.run_end_reasons && v_end_reasons))
                    AND (e.pipeline_ids IS NULL
                         OR p_type NOT IN ('deal.created', 'deal.stage_changed',
                                           'deal.owner_changed', 'deal.status_changed')
                         OR v_pipeline = ANY (e.pipeline_ids)
                         OR v_left_pipeline = ANY (e.pipeline_ids))
                    AND (e.stage_ids IS NULL
                         OR p_type NOT IN ('deal.created', 'deal.stage_changed',
                                           'deal.owner_changed', 'deal.status_changed')
                         OR v_stage = ANY (e.stage_ids)
                         OR v_left_stage = ANY (e.stage_ids))
                    AND (e.owner_ids IS NULL
                         OR p_type NOT IN ('deal.created', 'deal.stage_changed',
                                           'deal.owner_changed', 'deal.status_changed')
                         OR v_owner = ANY (e.owner_ids) OR v_left_owner = ANY (e.owner_ids))
                    AND (e.task_assignee_ids IS NULL
                         OR p_type NOT IN ('task.created', 'task.status_changed')
                         OR v_task_assignee = ANY (e.task_assignee_ids))
                    AND (e.contact_tags IS NULL
                         OR p_type NOT IN ('message.received', 'message.status',
                                           'conversation.status_changed',
                                           'conversation.assignment_changed',
                                           'conversation.team_changed')
                         OR v_contact_tags && e.contact_tags)) THEN
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
          OR (p_detail ->> 'messageType') = ANY (e.message_types))
     AND (p_type <> 'automation.run_ended' OR e.run_end_reasons IS NULL
          OR (p_detail ->> 'endReason') = ANY (e.run_end_reasons)
          OR NOT (e.run_end_reasons && v_end_reasons))
     AND (e.pipeline_ids IS NULL
          OR p_type NOT IN ('deal.created', 'deal.stage_changed', 'deal.owner_changed',
                            'deal.status_changed')
          OR v_pipeline = ANY (e.pipeline_ids) OR v_left_pipeline = ANY (e.pipeline_ids))
     AND (e.stage_ids IS NULL
          OR p_type NOT IN ('deal.created', 'deal.stage_changed', 'deal.owner_changed',
                            'deal.status_changed')
          OR v_stage = ANY (e.stage_ids) OR v_left_stage = ANY (e.stage_ids))
     AND (e.owner_ids IS NULL
          OR p_type NOT IN ('deal.created', 'deal.stage_changed', 'deal.owner_changed',
                            'deal.status_changed')
          OR v_owner = ANY (e.owner_ids) OR v_left_owner = ANY (e.owner_ids))
     AND (e.task_assignee_ids IS NULL
          OR p_type NOT IN ('task.created', 'task.status_changed')
          OR v_task_assignee = ANY (e.task_assignee_ids))
     AND (e.contact_tags IS NULL
          OR p_type NOT IN ('message.received', 'message.status', 'conversation.status_changed',
                            'conversation.assignment_changed', 'conversation.team_changed')
          OR v_contact_tags && e.contact_tags);
END
$$;
