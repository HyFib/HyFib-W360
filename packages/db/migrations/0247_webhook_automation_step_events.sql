-- An outgoing webhook event for each step of an automation run (P5-09, ADR-326).
--
-- automation.run_started and automation.run_ended say when a run starts and how it ends, but not
-- what it did on the way: a reporting integration could not tell which messages a run sent, which
-- questions were answered, where it waited or which CRM change it made without reading the run
-- page. Every step a live run records in app.automation_run_steps (the run's log since 0011) now
-- sends automation.run_step: its number in the run, the kind of node it ran, its outcome and the
-- message it sent. Never the branch it took or the step's detail: an answered question's branch is
-- the title of the button the customer tapped, their answer, which the run events never send
-- (0055), and the detail is a note for the people reading the run's page (what started the run, a
-- web request's status, why a send was refused or a CRM step skipped), with no fixed vocabulary.
-- Members' test runs send nothing, as for the run events. The run events' filters narrow it alike:
-- the automations chosen (0109), what started the run (0131), the API keys whose runs are taken
-- (0241) and the numbers (0118).

-- Event types ------------------------------------------------------------------------------------

-- A company has at most 10 endpoints, so the endpoints' checks are validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check
    CHECK (cardinality(event_types) BETWEEN 1 AND 29
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'conversation.team_changed',
                             'satisfaction_survey.answered', 'contact.created',
                             'contact.updated', 'contact.erased', 'contact.merged',
                             'automation.run_started', 'automation.run_ended',
                             'automation.run_step', 'order.received',
                             'order.status_changed', 'payment_link.status_changed',
                             'campaign.status_changed', 'deal.created', 'deal.updated',
                             'deal.stage_changed', 'deal.owner_changed', 'deal.status_changed',
                             'task.created', 'task.updated', 'task.assignee_changed',
                             'task.status_changed', 'note.created']::text[]);

-- NOT VALID: new rows are checked at once, and 0248 checks the rows already there without holding
-- the lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'conversation.team_changed', 'satisfaction_survey.answered',
    'contact.created', 'contact.updated', 'contact.erased', 'contact.merged',
    'automation.run_started', 'automation.run_ended', 'automation.run_step', 'order.received',
    'order.status_changed', 'payment_link.status_changed', 'campaign.status_changed',
    'deal.created', 'deal.updated', 'deal.stage_changed', 'deal.owner_changed',
    'deal.status_changed', 'task.created', 'task.updated', 'task.assignee_changed',
    'task.status_changed', 'note.created', 'ping')) NOT VALID;

-- A step happens on its run's number, so the number list (0213) is kept while an endpoint takes it;
-- the rest of its check is unchanged.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_channel_account_ids,
  ADD CONSTRAINT webhook_endpoints_channel_account_ids CHECK (
    channel_account_ids IS NULL
    OR (cardinality(channel_account_ids) BETWEEN 1 AND 100
        AND array_position(channel_account_ids, NULL) IS NULL
        AND event_types && ARRAY['message.received', 'message.status',
                                 'conversation.status_changed', 'conversation.assignment_changed',
                                 'conversation.team_changed', 'satisfaction_survey.answered',
                                 'automation.run_started', 'automation.run_ended',
                                 'automation.run_step', 'order.received', 'order.status_changed',
                                 'payment_link.status_changed',
                                 'campaign.status_changed']::text[]));

-- The run filters (0109, 0131, 0241) are kept while an endpoint takes any of the three run events;
-- the rest of their checks is unchanged.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_automation_ids,
  ADD CONSTRAINT webhook_endpoints_automation_ids CHECK (
    automation_ids IS NULL
    OR (cardinality(automation_ids) BETWEEN 1 AND 20
        AND array_position(automation_ids, NULL) IS NULL
        AND event_types && ARRAY['automation.run_started', 'automation.run_ended',
                                 'automation.run_step']::text[])),
  DROP CONSTRAINT webhook_endpoints_run_triggers,
  ADD CONSTRAINT webhook_endpoints_run_triggers CHECK (
    run_triggers IS NULL
    OR (cardinality(run_triggers) BETWEEN 1 AND 5
        AND run_triggers <@ ARRAY['keyword', 'conversation_started', 'any_message', 'store_event',
                                  'api']::text[]
        AND event_types && ARRAY['automation.run_started', 'automation.run_ended',
                                 'automation.run_step']::text[])),
  DROP CONSTRAINT webhook_endpoints_run_api_key_ids,
  ADD CONSTRAINT webhook_endpoints_run_api_key_ids CHECK (
    run_api_key_ids IS NULL
    OR (cardinality(run_api_key_ids) BETWEEN 1 AND 20
        AND array_ndims(run_api_key_ids) = 1
        AND array_position(run_api_key_ids, NULL) IS NULL
        AND event_types && ARRAY['automation.run_started', 'automation.run_ended',
                                 'automation.run_step']::text[]));

-- Steps ------------------------------------------------------------------------------------------

-- The event keeps the step and its run in `detail` with the run's automation and, for the filters
-- only, its number, what started it and its key (taken out before the event is stored); the rest is
-- read from the step and the run when the event is delivered. A step's outcome is its status. Only
-- the steps of live runs are captured: a test run's steps send nothing. It is stamped with the
-- step's time, so the steps a run records in one transaction share it and their number orders them.
-- The runtime role is the only writer of steps (0011 grants no other role an insert), in the
-- company's scope, and reads the runs through its table grant.
CREATE FUNCTION app.webhook_capture_automation_step() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_conversation uuid;
  v_contact uuid;
  v_automation uuid;
  v_channel uuid;
  v_trigger text;
  v_key uuid;
BEGIN
  SELECT r.conversation_id, r.contact_id, r.automation_id, r.channel_account_id, r.trigger_type,
         r.api_key_id
    INTO v_conversation, v_contact, v_automation, v_channel, v_trigger, v_key
    FROM app.automation_runs r
   WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.run_id AND r.mode = 'live';
  IF FOUND THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'automation.run_step', NULL, v_conversation,
      v_contact, NULL, NEW.outcome,
      jsonb_build_object('stepId', NEW.id, 'runId', NEW.run_id, 'automationId', v_automation,
        'channelId', v_channel, 'runTrigger', v_trigger, 'apiKeyId', v_key),
      NEW.created_at);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER automation_run_steps_webhook AFTER INSERT ON app.automation_run_steps
  FOR EACH ROW EXECUTE FUNCTION app.webhook_capture_automation_step();

-- Trigger functions run with the rights of whoever makes the change: the runtime role in the
-- company's scope, the only role that records steps.
REVOKE EXECUTE ON FUNCTION app.webhook_capture_automation_step() FROM PUBLIC;

-- 0246's capture with the step event: automation.run_step passes the run filters the run events
-- pass (the automations, what started the run, its key and its number), and its run's key is taken
-- out of the stored detail. Other types are captured as before. Same signature, so its owner and
-- grants stay (0025); replays and test events do not pass through here.
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
  v_keys uuid[];
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
  v_crm_key uuid;
  v_crm_keys uuid[];
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
  -- A run's, a message's or a Payment Link's key travels in the detail for the filter only: the
  -- payload reads it from the run, the message or the link (0246). A step's run's too (0247).
  IF p_type IN ('automation.run_started', 'automation.run_ended', 'automation.run_step',
                'message.status', 'payment_link.status_changed') THEN
    v_detail := v_detail - 'apiKeyId';
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
  -- maker its trigger recorded in the detail (0196), null when the change recorded none; with the
  -- key that made it when the maker is a key (0243). Read only when an active endpoint of the
  -- company that takes the event names makers or leaves out keys. The rows are read as this
  -- transaction sees them, after the insert.
  IF p_type IN ('deal.created', 'deal.updated', 'deal.stage_changed', 'deal.owner_changed',
                'deal.status_changed', 'task.created', 'task.updated', 'task.assignee_changed',
                'task.status_changed', 'note.created')
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND (e.crm_change_makers IS NOT NULL OR e.crm_excluded_api_key_ids IS NOT NULL)
                    AND p_type = ANY (e.event_types)) THEN
    IF p_type = 'deal.created' THEN
      SELECT CASE WHEN d.created_by_api_key_id IS NOT NULL THEN 'api'
                  WHEN d.created_by_automation_id IS NOT NULL THEN 'automation'
                  ELSE 'member' END,
             d.created_by_api_key_id
        INTO v_crm_maker, v_crm_key
        FROM app.crm_deals d
       WHERE d.tenant_id = p_tenant AND d.id = (p_detail ->> 'dealId')::uuid;
    ELSIF p_type = 'task.created' THEN
      SELECT CASE WHEN t.created_by_api_key_id IS NOT NULL THEN 'api'
                  WHEN t.created_by_automation_id IS NOT NULL THEN 'automation'
                  ELSE 'member' END,
             t.created_by_api_key_id
        INTO v_crm_maker, v_crm_key
        FROM app.crm_tasks t
       WHERE t.tenant_id = p_tenant AND t.id = (p_detail ->> 'taskId')::uuid;
    ELSIF p_type = 'note.created' THEN
      SELECT CASE WHEN a.actor_membership_id IS NOT NULL THEN 'member'
                  WHEN a.data ? 'apiKeyId' THEN 'api' END,
             CASE WHEN a.actor_membership_id IS NULL THEN (a.data ->> 'apiKeyId')::uuid END
        INTO v_crm_maker, v_crm_key
        FROM app.crm_activities a
       WHERE a.tenant_id = p_tenant AND a.id = (p_detail ->> 'noteId')::uuid AND a.kind = 'note';
    ELSE
      v_crm_maker := p_detail ->> 'changedBy';
      v_crm_key := CASE WHEN p_detail ->> 'changedBy' = 'api'
                        THEN (p_detail ->> 'apiKeyId')::uuid END;
    END IF;
  END IF;
  -- The key that made a deal, task or note change, with the keys it was rotated from and into
  -- (0243), read only when an active endpoint of the company that takes the event leaves out keys.
  -- A change a member, an automation's run or no recorded maker made has no key, and no list leaves
  -- it out.
  IF v_crm_key IS NOT NULL
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND e.crm_excluded_api_key_ids IS NOT NULL
                    AND p_type = ANY (e.event_types)) THEN
    v_crm_keys := app.webhook_api_key_family(p_tenant, v_crm_key);
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
  -- The tags the answering contact and the answered conversation have now (0235), read only when an
  -- active endpoint of the company that takes the event names contact or conversation tags for
  -- answers (the tag rows as this transaction sees them).
  IF p_type = 'satisfaction_survey.answered'
     AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND (e.survey_contact_tags IS NOT NULL
                         OR e.survey_conversation_tags IS NOT NULL)
                    AND p_type = ANY (e.event_types)) THEN
    SELECT array_agg(t.tag) INTO v_contact_tags FROM app.contact_tags t
     WHERE t.tenant_id = p_tenant AND t.contact_id = p_contact;
    SELECT array_agg(t.tag) INTO v_conversation_tags FROM app.conversation_tags t
     WHERE t.tenant_id = p_tenant AND t.conversation_id = p_conversation;
  END IF;
  -- The key that started a run (0241; a step's run, 0247), sent a message (0242), changed an
  -- order's status (0245) or asked for a Payment Link (0246) through the API, with the keys it was
  -- rotated from and into, read only when an active endpoint of the company that takes the event
  -- names keys for it: a key named before or after a rotation still matches. A run started, a
  -- message sent, an order changed or a link asked for otherwise has no key: it matches no list of
  -- keys to take, and no list of keys to leave out leaves it out.
  IF p_detail ->> 'apiKeyId' IS NOT NULL
     AND ((p_type IN ('automation.run_started', 'automation.run_ended', 'automation.run_step')
           AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                        WHERE e.tenant_id = p_tenant AND e.state = 'active'
                          AND e.run_api_key_ids IS NOT NULL AND p_type = ANY (e.event_types)))
          OR (p_type = 'message.status'
              AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                           WHERE e.tenant_id = p_tenant AND e.state = 'active'
                             AND e.message_api_key_ids IS NOT NULL
                             AND p_type = ANY (e.event_types)))
          OR (p_type = 'order.status_changed'
              AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                           WHERE e.tenant_id = p_tenant AND e.state = 'active'
                             AND e.order_excluded_api_key_ids IS NOT NULL
                             AND p_type = ANY (e.event_types)))
          OR (p_type = 'payment_link.status_changed'
              AND EXISTS (SELECT 1 FROM app.webhook_endpoints e
                           WHERE e.tenant_id = p_tenant AND e.state = 'active'
                             AND e.payment_link_api_key_ids IS NOT NULL
                             AND p_type = ANY (e.event_types)))) THEN
    v_keys := app.webhook_api_key_family(p_tenant, (p_detail ->> 'apiKeyId')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND p_type = ANY (e.event_types)
                    AND (p_type <> 'message.status' OR e.message_statuses IS NULL
                         OR p_status = ANY (e.message_statuses))
                    AND (p_type <> 'message.status' OR e.message_senders IS NULL
                         OR v_sender = ANY (e.message_senders))
                    AND (p_type <> 'message.status' OR e.message_api_key_ids IS NULL
                         OR v_keys && e.message_api_key_ids)
                    AND (p_type NOT IN ('automation.run_started', 'automation.run_ended',
                                        'automation.run_step')
                         OR e.automation_ids IS NULL
                         OR (p_detail ->> 'automationId')::uuid = ANY (e.automation_ids))
                    AND (p_type <> 'automation.run_ended' OR e.run_end_statuses IS NULL
                         OR p_status = ANY (e.run_end_statuses))
                    AND (p_type NOT IN ('automation.run_started', 'automation.run_ended',
                                        'automation.run_step')
                         OR e.run_triggers IS NULL OR v_run_trigger = ANY (e.run_triggers))
                    AND (p_type NOT IN ('automation.run_started', 'automation.run_ended',
                                        'automation.run_step')
                         OR e.run_api_key_ids IS NULL OR v_keys && e.run_api_key_ids)
                    AND (p_type <> 'campaign.status_changed' OR e.campaign_statuses IS NULL
                         OR p_status = ANY (e.campaign_statuses))
                    AND (p_type <> 'order.status_changed' OR e.order_statuses IS NULL
                         OR p_status = ANY (e.order_statuses))
                    AND (p_type <> 'order.status_changed' OR e.order_change_makers IS NULL
                         OR p_detail ->> 'changedBy' IS NULL
                         OR p_detail ->> 'changedBy' = ANY (e.order_change_makers))
                    AND (p_type <> 'order.status_changed' OR e.order_excluded_api_key_ids IS NULL
                         OR v_keys IS NULL OR NOT (v_keys && e.order_excluded_api_key_ids))
                    AND (p_type <> 'payment_link.status_changed' OR e.payment_link_statuses IS NULL
                         OR p_status = ANY (e.payment_link_statuses))
                    AND (p_type <> 'payment_link.status_changed'
                         OR e.payment_link_api_key_ids IS NULL
                         OR v_keys && e.payment_link_api_key_ids)
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
                                           'automation.run_ended', 'automation.run_step',
                                           'order.received',
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
                    AND (e.crm_excluded_api_key_ids IS NULL OR v_crm_keys IS NULL
                         OR NOT (v_crm_keys && e.crm_excluded_api_key_ids))
                    AND (p_type <> 'satisfaction_survey.answered' OR e.survey_scores IS NULL
                         OR v_survey_score = ANY (e.survey_scores))
                    AND (p_type <> 'satisfaction_survey.answered' OR e.survey_assignee_ids IS NULL
                         OR v_survey_assignee = ANY (e.survey_assignee_ids))
                    AND (p_type <> 'satisfaction_survey.answered' OR e.survey_team_ids IS NULL
                         OR v_survey_team = ANY (e.survey_team_ids))
                    AND (p_type <> 'satisfaction_survey.answered' OR e.survey_contact_tags IS NULL
                         OR v_contact_tags && e.survey_contact_tags)
                    AND (p_type <> 'satisfaction_survey.answered'
                         OR e.survey_conversation_tags IS NULL
                         OR v_conversation_tags && e.survey_conversation_tags)
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
     AND (p_type <> 'message.status' OR e.message_api_key_ids IS NULL
          OR v_keys && e.message_api_key_ids)
     AND (p_type NOT IN ('automation.run_started', 'automation.run_ended', 'automation.run_step')
          OR e.automation_ids IS NULL
          OR (p_detail ->> 'automationId')::uuid = ANY (e.automation_ids))
     AND (p_type <> 'automation.run_ended' OR e.run_end_statuses IS NULL
          OR p_status = ANY (e.run_end_statuses))
     AND (p_type NOT IN ('automation.run_started', 'automation.run_ended', 'automation.run_step')
          OR e.run_triggers IS NULL OR v_run_trigger = ANY (e.run_triggers))
     AND (p_type NOT IN ('automation.run_started', 'automation.run_ended', 'automation.run_step')
          OR e.run_api_key_ids IS NULL OR v_keys && e.run_api_key_ids)
     AND (p_type <> 'campaign.status_changed' OR e.campaign_statuses IS NULL
          OR p_status = ANY (e.campaign_statuses))
     AND (p_type <> 'order.status_changed' OR e.order_statuses IS NULL
          OR p_status = ANY (e.order_statuses))
     AND (p_type <> 'order.status_changed' OR e.order_change_makers IS NULL
          OR p_detail ->> 'changedBy' IS NULL
          OR p_detail ->> 'changedBy' = ANY (e.order_change_makers))
     AND (p_type <> 'order.status_changed' OR e.order_excluded_api_key_ids IS NULL
          OR v_keys IS NULL OR NOT (v_keys && e.order_excluded_api_key_ids))
     AND (p_type <> 'payment_link.status_changed' OR e.payment_link_statuses IS NULL
          OR p_status = ANY (e.payment_link_statuses))
     AND (p_type <> 'payment_link.status_changed' OR e.payment_link_api_key_ids IS NULL
          OR v_keys && e.payment_link_api_key_ids)
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
                            'automation.run_started', 'automation.run_ended',
                            'automation.run_step', 'order.received',
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
     AND (e.crm_excluded_api_key_ids IS NULL OR v_crm_keys IS NULL
          OR NOT (v_crm_keys && e.crm_excluded_api_key_ids))
     AND (p_type <> 'satisfaction_survey.answered' OR e.survey_scores IS NULL
          OR v_survey_score = ANY (e.survey_scores))
     AND (p_type <> 'satisfaction_survey.answered' OR e.survey_assignee_ids IS NULL
          OR v_survey_assignee = ANY (e.survey_assignee_ids))
     AND (p_type <> 'satisfaction_survey.answered' OR e.survey_team_ids IS NULL
          OR v_survey_team = ANY (e.survey_team_ids))
     AND (p_type <> 'satisfaction_survey.answered' OR e.survey_contact_tags IS NULL
          OR v_contact_tags && e.survey_contact_tags)
     AND (p_type <> 'satisfaction_survey.answered' OR e.survey_conversation_tags IS NULL
          OR v_conversation_tags && e.survey_conversation_tags)
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
