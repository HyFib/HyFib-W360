-- Task assignee filters on webhook endpoints (P5-09, P4-04, ADR-266).
--
-- An endpoint that takes task.created or task.status_changed receives the events of every task of
-- the company (0177). A receiver that serves some members (one member's own task list in another
-- tool, a team lead's) can now name the members whose tasks it takes: null keeps every task, as
-- before; a list holds 1 to 50 members of the company, and only while the endpoint takes a task
-- event, so a list never outlives its events. A task event then counts when the member the task is
-- assigned to when the event happens (the row the task trigger runs after) is listed; every task
-- has an assignee. Reassigning a task sends no event, so there is no assignee left to reach. Deal
-- and other events are not narrowed. The services accept only members who can be assigned tasks
-- (active, with access to the CRM) for the ones a list adds; members it already holds may have left
-- or lost the access since, and stay, matching the tasks they are still assigned. Memberships are
-- kept, so a list never names one that is gone. A company has at most 10 endpoints, so the table is
-- small and the check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN task_assignee_ids uuid[],
  ADD CONSTRAINT webhook_endpoints_task_assignee_ids CHECK (
    task_assignee_ids IS NULL
    OR (cardinality(task_assignee_ids) BETWEEN 1 AND 50
        AND array_ndims(task_assignee_ids) = 1
        AND array_position(task_assignee_ids, NULL) IS NULL
        AND event_types && ARRAY['task.created', 'task.status_changed']::text[]));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (task_assignee_ids) ON app.webhook_endpoints TO w360_app;

-- 0181's capture with the task assignee filter: a task event is delivered only to the active
-- endpoints that take it and whose list is null or holds the member the task is assigned to now,
-- read from the task only when an endpoint names task assignees, as the deal's owner is (0181). The
-- task trigger runs as whoever changes the task (the runtime role in the company's scope), which
-- reads the company's tasks. No event is written when no endpoint takes it. Other types are
-- captured as before. Same signature, so its owner and grants stay (0025); replays and test events
-- do not pass through here.
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
                                          'deal.status_changed')
                          THEN (p_detail ->> 'pipelineId')::uuid END;
  v_left_pipeline uuid := CASE WHEN p_type = 'deal.stage_changed'
                               THEN (p_detail ->> 'previousPipelineId')::uuid END;
  v_stage uuid := CASE WHEN p_type IN ('deal.created', 'deal.stage_changed', 'deal.status_changed')
                       THEN (p_detail ->> 'stageId')::uuid END;
  v_left_stage uuid := CASE WHEN p_type = 'deal.stage_changed'
                            THEN (p_detail ->> 'previousStageId')::uuid END;
  v_owner uuid;
  v_task_assignee uuid;
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
  -- The member who owns the deal now, read only when an active endpoint of the company that takes
  -- the event names owners (the row itself: the deal trigger runs after the change).
  IF p_type IN ('deal.created', 'deal.stage_changed', 'deal.status_changed')
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
                                           'deal.status_changed')
                         OR v_pipeline = ANY (e.pipeline_ids)
                         OR v_left_pipeline = ANY (e.pipeline_ids))
                    AND (e.stage_ids IS NULL
                         OR p_type NOT IN ('deal.created', 'deal.stage_changed',
                                           'deal.status_changed')
                         OR v_stage = ANY (e.stage_ids)
                         OR v_left_stage = ANY (e.stage_ids))
                    AND (e.owner_ids IS NULL
                         OR p_type NOT IN ('deal.created', 'deal.stage_changed',
                                           'deal.status_changed')
                         OR v_owner = ANY (e.owner_ids))
                    AND (e.task_assignee_ids IS NULL
                         OR p_type NOT IN ('task.created', 'task.status_changed')
                         OR v_task_assignee = ANY (e.task_assignee_ids))) THEN
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
          OR p_type NOT IN ('deal.created', 'deal.stage_changed', 'deal.status_changed')
          OR v_pipeline = ANY (e.pipeline_ids) OR v_left_pipeline = ANY (e.pipeline_ids))
     AND (e.stage_ids IS NULL
          OR p_type NOT IN ('deal.created', 'deal.stage_changed', 'deal.status_changed')
          OR v_stage = ANY (e.stage_ids) OR v_left_stage = ANY (e.stage_ids))
     AND (e.owner_ids IS NULL
          OR p_type NOT IN ('deal.created', 'deal.stage_changed', 'deal.status_changed')
          OR v_owner = ANY (e.owner_ids))
     AND (e.task_assignee_ids IS NULL
          OR p_type NOT IN ('task.created', 'task.status_changed')
          OR v_task_assignee = ANY (e.task_assignee_ids));
END
$$;
