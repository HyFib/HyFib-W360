-- Filters on how automation runs ended, on webhook endpoints (P5-09, ADR-151).
--
-- An endpoint that takes automation.run_ended (0055) receives the end of every run: each completed
-- run, each one handed to people, taken over, stopped or failed. It can now take only some (the
-- failures, say): null keeps every end, as before; a list holds 1 to 5 of the statuses a run ends
-- with, the status the event reports, and only while the endpoint takes automation.run_ended, so a
-- list never outlives its event. It narrows automation.run_ended alone: run starts are unchanged,
-- and the automations an endpoint names (0109) still apply to both events. A company has at most 10
-- endpoints, so the table is small and the check is validated here. Containment refuses a list
-- holding a null, and a run's active statuses (running, waiting), which no end reports.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN run_end_statuses text[],
  ADD CONSTRAINT webhook_endpoints_run_end_statuses CHECK (
    run_end_statuses IS NULL
    OR (cardinality(run_end_statuses) BETWEEN 1 AND 5
        AND run_end_statuses <@ ARRAY['completed', 'handed_off', 'taken_over', 'stopped',
                                      'failed']::text[]
        AND 'automation.run_ended' = ANY (event_types)));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (run_end_statuses) ON app.webhook_endpoints TO w360_app;

-- 0113's capture with the run end filter: an automation.run_ended event is delivered only to the
-- active endpoints that take it, whose automations (0109) include the run's, and whose list is null
-- or holds the status the run ended with (0055's trigger passes it as the event's status), and no
-- event is written when none takes it. Other types are captured as before. Same signature, so its
-- owner and grants stay (0025); replays and test events do not pass through here.
CREATE OR REPLACE FUNCTION app.capture_webhook_event(p_tenant uuid, p_type text, p_message uuid,
  p_conversation uuid, p_contact uuid, p_template uuid, p_status text, p_detail jsonb,
  p_occurred_at timestamptz) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_event uuid := gen_random_uuid();
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
                         OR p_status = ANY (e.conversation_statuses))) THEN
    RETURN;
  END IF;
  INSERT INTO app.webhook_events (id, tenant_id, type, message_id, conversation_id, contact_id,
    template_id, status, detail, occurred_at)
  VALUES (v_event, p_tenant, p_type, p_message, p_conversation, p_contact, p_template, p_status,
    coalesce(p_detail, '{}'::jsonb), coalesce(p_occurred_at, now()));
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
          OR p_status = ANY (e.conversation_statuses));
END
$$;
