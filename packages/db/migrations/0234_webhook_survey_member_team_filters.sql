-- Satisfaction survey answer filters by member and team on webhook endpoints (P5-09, ADR-311).
--
-- An endpoint that takes satisfaction_survey.answered (0213) received every answer, or those of the
-- scores it names (0230), whoever the answer was credited to and whichever team its conversation
-- was in: the team and member lists of conversations' events (0122, 0128) do not narrow answers.
-- One that reports to a team's lead can now name the members whose answers it takes
-- (survey_assignee_ids: the member an answer is credited to, the conversation's assignee when it
-- was resolved, as the survey keeps it) and the teams whose conversations' answers it takes
-- (survey_team_ids: the team the conversation is in when the customer answers). Null keeps every
-- answer, as before; a list holds 1 to 50 ids, and only while the endpoint takes the event, so a
-- list never outlives it. An answer credited to no member, or of a conversation in no team, matches
-- no list. The services check the ids (members who take conversations, the company's teams; those a
-- list already holds stay). A company has at most 10 endpoints, so the table is small and the
-- checks are validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN survey_assignee_ids uuid[],
  ADD COLUMN survey_team_ids uuid[],
  ADD CONSTRAINT webhook_endpoints_survey_assignee_ids CHECK (
    survey_assignee_ids IS NULL
    OR (cardinality(survey_assignee_ids) BETWEEN 1 AND 50
        AND array_ndims(survey_assignee_ids) = 1
        AND array_position(survey_assignee_ids, NULL) IS NULL
        AND 'satisfaction_survey.answered' = ANY (event_types))),
  ADD CONSTRAINT webhook_endpoints_survey_team_ids CHECK (
    survey_team_ids IS NULL
    OR (cardinality(survey_team_ids) BETWEEN 1 AND 50
        AND array_ndims(survey_team_ids) = 1
        AND array_position(survey_team_ids, NULL) IS NULL
        AND 'satisfaction_survey.answered' = ANY (event_types)));

-- The runtime role sets them when it adds an endpoint (its table grant) and changes them with the
-- events (0025 grants updates column by column). Both roles read them through their table grants.
GRANT UPDATE (survey_assignee_ids, survey_team_ids) ON app.webhook_endpoints TO w360_app;

-- 0233's capture with the survey member and team filters: satisfaction_survey.answered is
-- delivered only to the active endpoints that take it and whose lists are null or hold the member
-- the answer is credited to and the team of its conversation, and no event is written when none
-- takes it. Other types are captured as before. Same signature, so its owner and grants stay
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
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb) - 'channelId' - 'sentBy' - 'runTrigger'
                    - 'stepOwnerId' - 'stepAssigneeId';
  v_team uuid;
  v_left_team uuid := CASE WHEN p_type = 'conversation.team_changed'
                           THEN (p_detail ->> 'previousTeamId')::uuid END;
  v_assignee uuid;
  v_left_assignee uuid := CASE WHEN p_type = 'conversation.assignment_changed'
                               THEN (p_detail ->> 'previousAssigneeId')::uuid END;
  v_pipeline uuid := CASE WHEN p_type IN ('deal.created', 'deal.updated', 'deal.stage_changed',
                                          'deal.owner_changed', 'deal.status_changed')
                          THEN (p_detail ->> 'pipelineId')::uuid END;
  v_left_pipeline uuid := CASE WHEN p_type = 'deal.stage_changed'
                               THEN (p_detail ->> 'previousPipelineId')::uuid END;
  v_stage uuid := CASE WHEN p_type IN ('deal.created', 'deal.updated', 'deal.stage_changed',
                                       'deal.owner_changed', 'deal.status_changed')
                       THEN (p_detail ->> 'stageId')::uuid END;
  v_left_stage uuid := CASE WHEN p_type = 'deal.stage_changed'
                            THEN (p_detail ->> 'previousStageId')::uuid END;
  v_owner uuid;
  v_left_owner uuid := CASE WHEN p_type = 'deal.owner_changed'
                            THEN (p_detail ->> 'previousOwnerId')::uuid END;
  v_task_assignee uuid;
  v_left_task_assignee uuid := CASE WHEN p_type = 'task.assignee_changed'
                                    THEN (p_detail ->> 'previousAssigneeId')::uuid END;
  v_task_pipeline uuid;
  v_task_stage uuid;
  v_task_deal_owner uuid;
  v_note_pipeline uuid;
  v_note_stage uuid;
  v_note_deal_owner uuid;
  v_crm_maker text;
  v_survey_score smallint;
  v_survey_assignee uuid;
  v_survey_team uuid;
  v_contact_tags text[];
  v_conversation_tags text[];
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
  -- The conversation's own tags now (0145), read only when an active endpoint of the company that
  -- takes the event names conversation tags (the conversation's tag rows as this transaction sees
  -- them).
  IF p_conversation IS NOT NULL
     AND p_type IN ('message.received', 'message.status', 'conversation.status_changed',
                    'conversation.assignment_changed', 'conversation.team_changed')
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND e.conversation_tags IS NOT NULL AND p_type = ANY (e.event_types)) THEN
    SELECT array_agg(t.tag) INTO v_conversation_tags FROM app.conversation_tags t
     WHERE t.tenant_id = p_tenant AND t.conversation_id = p_conversation;
  END IF;
  -- The member who owned the deal at the event's step: the deal trigger gives it (0215), since one
  -- update's steps run before and after its change of owner (reopened, moved, details changed,
  -- given to another owner, closed). An event without it is matched against the deal's owner now,
  -- read only when an active endpoint of the company that takes the event names owners.
  IF p_detail ? 'stepOwnerId' THEN
    v_owner := (p_detail ->> 'stepOwnerId')::uuid;
  ELSIF p_type IN ('deal.created', 'deal.updated', 'deal.stage_changed', 'deal.owner_changed',
                   'deal.status_changed')
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active' AND e.owner_ids IS NOT NULL
                    AND p_type = ANY (e.event_types)) THEN
    SELECT d.owner_membership_id INTO v_owner FROM app.crm_deals d
     WHERE d.tenant_id = p_tenant AND d.id = (p_detail ->> 'dealId')::uuid;
  END IF;
  -- The member the task was assigned to at the event's step, likewise given by the task trigger
  -- (reopened, details changed, given to another member, closed); without it, the task's assignee
  -- now, read only when an active endpoint of the company that takes the event names assignees.
  IF p_detail ? 'stepAssigneeId' THEN
    v_task_assignee := (p_detail ->> 'stepAssigneeId')::uuid;
  ELSIF p_type IN ('task.created', 'task.updated', 'task.assignee_changed', 'task.status_changed')
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND e.task_assignee_ids IS NOT NULL AND p_type = ANY (e.event_types)) THEN
    SELECT t.assignee_membership_id INTO v_task_assignee FROM app.crm_tasks t
     WHERE t.tenant_id = p_tenant AND t.id = (p_detail ->> 'taskId')::uuid;
  END IF;
  -- The pipeline, stage and owner of the task's deal when the event happens (0226, 0227), read
  -- only when an active endpoint of the company that takes the event names pipelines, stages or
  -- owners of tasks' deals. A task's deal never changes, and the deal is read as this transaction
  -- sees it, so a move or a change of owner earlier in the transaction counts. A task without a
  -- deal is in no pipeline or stage and has no owner, as has a deal without one.
  IF p_type IN ('task.created', 'task.updated', 'task.assignee_changed', 'task.status_changed')
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND (e.task_pipeline_ids IS NOT NULL OR e.task_stage_ids IS NOT NULL
                         OR e.task_deal_owner_ids IS NOT NULL)
                    AND p_type = ANY (e.event_types)) THEN
    SELECT d.pipeline_id, d.stage_id, d.owner_membership_id
      INTO v_task_pipeline, v_task_stage, v_task_deal_owner
      FROM app.crm_tasks t
      JOIN app.crm_deals d ON d.tenant_id = t.tenant_id AND d.id = t.deal_id
     WHERE t.tenant_id = p_tenant AND t.id = (p_detail ->> 'taskId')::uuid;
  END IF;
  -- The pipeline, stage and owner of the note's deal when the note is added (0228), read only when
  -- an active endpoint of the company that takes note.created names pipelines, stages or owners of
  -- notes' deals. The note trigger runs after the insert, so the note is read as this transaction
  -- sees it, and its deal likewise. A note about a contact alone is in no pipeline or stage and has
  -- no owner, as has a deal without one.
  IF p_type = 'note.created'
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND (e.note_pipeline_ids IS NOT NULL OR e.note_stage_ids IS NOT NULL
                         OR e.note_deal_owner_ids IS NOT NULL)
                    AND p_type = ANY (e.event_types)) THEN
    SELECT d.pipeline_id, d.stage_id, d.owner_membership_id
      INTO v_note_pipeline, v_note_stage, v_note_deal_owner
      FROM app.crm_activities a
      JOIN app.crm_deals d ON d.tenant_id = a.tenant_id AND d.id = a.deal_id
     WHERE a.tenant_id = p_tenant AND a.id = (p_detail ->> 'noteId')::uuid AND a.kind = 'note';
  END IF;
  -- Who made the change a deal, task or note event reports (0229), read only when an active
  -- endpoint of the company that takes the event names makers: an addition's maker is whoever added
  -- the deal or task, as its creator columns say (a key, else an automation's run, else a member),
  -- a note's whoever wrote it (a member, else the key its data names), and any other change's the
  -- maker its trigger recorded in the detail (0196), null when the change recorded none. The rows
  -- are read as this transaction sees them, after the insert.
  IF p_type IN ('deal.created', 'deal.updated', 'deal.stage_changed', 'deal.owner_changed',
                'deal.status_changed', 'task.created', 'task.updated', 'task.assignee_changed',
                'task.status_changed', 'note.created')
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND e.crm_change_makers IS NOT NULL AND p_type = ANY (e.event_types)) THEN
    IF p_type = 'deal.created' THEN
      SELECT CASE WHEN d.created_by_api_key_id IS NOT NULL THEN 'api'
                  WHEN d.created_by_automation_id IS NOT NULL THEN 'automation'
                  ELSE 'member' END
        INTO v_crm_maker
        FROM app.crm_deals d
       WHERE d.tenant_id = p_tenant AND d.id = (p_detail ->> 'dealId')::uuid;
    ELSIF p_type = 'task.created' THEN
      SELECT CASE WHEN t.created_by_api_key_id IS NOT NULL THEN 'api'
                  WHEN t.created_by_automation_id IS NOT NULL THEN 'automation'
                  ELSE 'member' END
        INTO v_crm_maker
        FROM app.crm_tasks t
       WHERE t.tenant_id = p_tenant AND t.id = (p_detail ->> 'taskId')::uuid;
    ELSIF p_type = 'note.created' THEN
      SELECT CASE WHEN a.actor_membership_id IS NOT NULL THEN 'member'
                  WHEN a.data ? 'apiKeyId' THEN 'api' END
        INTO v_crm_maker
        FROM app.crm_activities a
       WHERE a.tenant_id = p_tenant AND a.id = (p_detail ->> 'noteId')::uuid AND a.kind = 'note';
    ELSE
      v_crm_maker := p_detail ->> 'changedBy';
    END IF;
  END IF;
  -- The score a satisfaction survey's answer recorded (0230), the member it is credited to (the
  -- conversation's assignee when it was resolved, as the survey keeps it) and the team the
  -- conversation is in now (0234), read in one query only when an active endpoint of the company
  -- that takes the event names scores, members or teams. The survey trigger runs after the answer
  -- is written, so the survey and its conversation are read as this transaction sees them; the tap
  -- that answers neither reopens nor moves the conversation.
  IF p_type = 'satisfaction_survey.answered'
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND (e.survey_scores IS NOT NULL OR e.survey_assignee_ids IS NOT NULL
                         OR e.survey_team_ids IS NOT NULL)
                    AND p_type = ANY (e.event_types)) THEN
    SELECT s.score, s.assigned_membership_id, c.team_id
      INTO v_survey_score, v_survey_assignee, v_survey_team
      FROM app.csat_surveys s
      LEFT JOIN app.conversations c ON c.tenant_id = s.tenant_id AND c.id = s.conversation_id
     WHERE s.tenant_id = p_tenant AND s.id = (p_detail ->> 'surveyId')::uuid;
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
                    AND (p_type <> 'payment_link.status_changed' OR e.payment_link_statuses IS NULL
                         OR p_status = ANY (e.payment_link_statuses))
                    AND (p_type <> 'deal.status_changed' OR e.deal_statuses IS NULL
                         OR p_status = ANY (e.deal_statuses))
                    AND (p_type <> 'task.status_changed' OR e.task_statuses IS NULL
                         OR p_status = ANY (e.task_statuses))
                    AND (p_type <> 'deal.updated' OR e.deal_details IS NULL
                         OR (p_detail -> 'changes') ?| e.deal_details)
                    AND (p_type <> 'task.updated' OR e.task_details IS NULL
                         OR (p_detail -> 'changes') ?| e.task_details)
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
                                           'order.status_changed',
                                           'payment_link.status_changed',
                                           'satisfaction_survey.answered',
                                           'campaign.status_changed')
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
                         OR p_type NOT IN ('deal.created', 'deal.updated', 'deal.stage_changed',
                                           'deal.owner_changed', 'deal.status_changed')
                         OR v_pipeline = ANY (e.pipeline_ids)
                         OR v_left_pipeline = ANY (e.pipeline_ids))
                    AND (e.stage_ids IS NULL
                         OR p_type NOT IN ('deal.created', 'deal.updated', 'deal.stage_changed',
                                           'deal.owner_changed', 'deal.status_changed')
                         OR v_stage = ANY (e.stage_ids)
                         OR v_left_stage = ANY (e.stage_ids))
                    AND (e.owner_ids IS NULL
                         OR p_type NOT IN ('deal.created', 'deal.updated', 'deal.stage_changed',
                                           'deal.owner_changed', 'deal.status_changed')
                         OR v_owner = ANY (e.owner_ids) OR v_left_owner = ANY (e.owner_ids))
                    AND (e.task_assignee_ids IS NULL
                         OR p_type NOT IN ('task.created', 'task.updated',
                                           'task.assignee_changed', 'task.status_changed')
                         OR v_task_assignee = ANY (e.task_assignee_ids)
                         OR v_left_task_assignee = ANY (e.task_assignee_ids))
                    AND (e.task_pipeline_ids IS NULL
                         OR p_type NOT IN ('task.created', 'task.updated',
                                           'task.assignee_changed', 'task.status_changed')
                         OR v_task_pipeline = ANY (e.task_pipeline_ids))
                    AND (e.task_stage_ids IS NULL
                         OR p_type NOT IN ('task.created', 'task.updated',
                                           'task.assignee_changed', 'task.status_changed')
                         OR v_task_stage = ANY (e.task_stage_ids))
                    AND (e.task_deal_owner_ids IS NULL
                         OR p_type NOT IN ('task.created', 'task.updated',
                                           'task.assignee_changed', 'task.status_changed')
                         OR v_task_deal_owner = ANY (e.task_deal_owner_ids))
                    AND (e.note_pipeline_ids IS NULL OR p_type <> 'note.created'
                         OR v_note_pipeline = ANY (e.note_pipeline_ids))
                    AND (e.note_stage_ids IS NULL OR p_type <> 'note.created'
                         OR v_note_stage = ANY (e.note_stage_ids))
                    AND (e.note_deal_owner_ids IS NULL OR p_type <> 'note.created'
                         OR v_note_deal_owner = ANY (e.note_deal_owner_ids))
                    AND (e.crm_change_makers IS NULL OR v_crm_maker IS NULL
                         OR p_type NOT IN ('deal.created', 'deal.updated', 'deal.stage_changed',
                                           'deal.owner_changed', 'deal.status_changed',
                                           'task.created', 'task.updated', 'task.assignee_changed',
                                           'task.status_changed', 'note.created')
                         OR v_crm_maker = ANY (e.crm_change_makers))
                    AND (p_type <> 'satisfaction_survey.answered' OR e.survey_scores IS NULL
                         OR v_survey_score = ANY (e.survey_scores))
                    AND (p_type <> 'satisfaction_survey.answered' OR e.survey_assignee_ids IS NULL
                         OR v_survey_assignee = ANY (e.survey_assignee_ids))
                    AND (p_type <> 'satisfaction_survey.answered' OR e.survey_team_ids IS NULL
                         OR v_survey_team = ANY (e.survey_team_ids))
                    AND (e.contact_tags IS NULL
                         OR p_type NOT IN ('message.received', 'message.status',
                                           'conversation.status_changed',
                                           'conversation.assignment_changed',
                                           'conversation.team_changed')
                         OR v_contact_tags && e.contact_tags)
                    AND (e.conversation_tags IS NULL
                         OR p_type NOT IN ('message.received', 'message.status',
                                           'conversation.status_changed',
                                           'conversation.assignment_changed',
                                           'conversation.team_changed')
                         OR v_conversation_tags && e.conversation_tags)) THEN
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
     AND (p_type <> 'payment_link.status_changed' OR e.payment_link_statuses IS NULL
          OR p_status = ANY (e.payment_link_statuses))
     AND (p_type <> 'deal.status_changed' OR e.deal_statuses IS NULL
          OR p_status = ANY (e.deal_statuses))
     AND (p_type <> 'task.status_changed' OR e.task_statuses IS NULL
          OR p_status = ANY (e.task_statuses))
     AND (p_type <> 'deal.updated' OR e.deal_details IS NULL
          OR (p_detail -> 'changes') ?| e.deal_details)
     AND (p_type <> 'task.updated' OR e.task_details IS NULL
          OR (p_detail -> 'changes') ?| e.task_details)
     AND (p_type <> 'template.status_changed' OR e.template_statuses IS NULL
          OR p_status = ANY (e.template_statuses))
     AND (p_type <> 'conversation.status_changed' OR e.conversation_statuses IS NULL
          OR p_status = ANY (e.conversation_statuses))
     AND (e.channel_account_ids IS NULL
          OR p_type NOT IN ('message.received', 'message.status', 'conversation.status_changed',
                            'conversation.assignment_changed', 'conversation.team_changed',
                            'automation.run_started', 'automation.run_ended', 'order.received',
                            'order.status_changed', 'payment_link.status_changed',
                            'satisfaction_survey.answered',
                            'campaign.status_changed')
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
          OR p_type NOT IN ('deal.created', 'deal.updated', 'deal.stage_changed',
                            'deal.owner_changed', 'deal.status_changed')
          OR v_pipeline = ANY (e.pipeline_ids) OR v_left_pipeline = ANY (e.pipeline_ids))
     AND (e.stage_ids IS NULL
          OR p_type NOT IN ('deal.created', 'deal.updated', 'deal.stage_changed',
                            'deal.owner_changed', 'deal.status_changed')
          OR v_stage = ANY (e.stage_ids) OR v_left_stage = ANY (e.stage_ids))
     AND (e.owner_ids IS NULL
          OR p_type NOT IN ('deal.created', 'deal.updated', 'deal.stage_changed',
                            'deal.owner_changed', 'deal.status_changed')
          OR v_owner = ANY (e.owner_ids) OR v_left_owner = ANY (e.owner_ids))
     AND (e.task_assignee_ids IS NULL
          OR p_type NOT IN ('task.created', 'task.updated', 'task.assignee_changed',
                            'task.status_changed')
          OR v_task_assignee = ANY (e.task_assignee_ids)
          OR v_left_task_assignee = ANY (e.task_assignee_ids))
     AND (e.task_pipeline_ids IS NULL
          OR p_type NOT IN ('task.created', 'task.updated', 'task.assignee_changed',
                            'task.status_changed')
          OR v_task_pipeline = ANY (e.task_pipeline_ids))
     AND (e.task_stage_ids IS NULL
          OR p_type NOT IN ('task.created', 'task.updated', 'task.assignee_changed',
                            'task.status_changed')
          OR v_task_stage = ANY (e.task_stage_ids))
     AND (e.task_deal_owner_ids IS NULL
          OR p_type NOT IN ('task.created', 'task.updated', 'task.assignee_changed',
                            'task.status_changed')
          OR v_task_deal_owner = ANY (e.task_deal_owner_ids))
     AND (e.note_pipeline_ids IS NULL OR p_type <> 'note.created'
          OR v_note_pipeline = ANY (e.note_pipeline_ids))
     AND (e.note_stage_ids IS NULL OR p_type <> 'note.created'
          OR v_note_stage = ANY (e.note_stage_ids))
     AND (e.note_deal_owner_ids IS NULL OR p_type <> 'note.created'
          OR v_note_deal_owner = ANY (e.note_deal_owner_ids))
     AND (e.crm_change_makers IS NULL OR v_crm_maker IS NULL
          OR p_type NOT IN ('deal.created', 'deal.updated', 'deal.stage_changed',
                            'deal.owner_changed', 'deal.status_changed', 'task.created',
                            'task.updated', 'task.assignee_changed', 'task.status_changed',
                            'note.created')
          OR v_crm_maker = ANY (e.crm_change_makers))
     AND (p_type <> 'satisfaction_survey.answered' OR e.survey_scores IS NULL
          OR v_survey_score = ANY (e.survey_scores))
     AND (p_type <> 'satisfaction_survey.answered' OR e.survey_assignee_ids IS NULL
          OR v_survey_assignee = ANY (e.survey_assignee_ids))
     AND (p_type <> 'satisfaction_survey.answered' OR e.survey_team_ids IS NULL
          OR v_survey_team = ANY (e.survey_team_ids))
     AND (e.contact_tags IS NULL
          OR p_type NOT IN ('message.received', 'message.status', 'conversation.status_changed',
                            'conversation.assignment_changed', 'conversation.team_changed')
          OR v_contact_tags && e.contact_tags)
     AND (e.conversation_tags IS NULL
          OR p_type NOT IN ('message.received', 'message.status', 'conversation.status_changed',
                            'conversation.assignment_changed', 'conversation.team_changed')
          OR v_conversation_tags && e.conversation_tags);
END
$$;
