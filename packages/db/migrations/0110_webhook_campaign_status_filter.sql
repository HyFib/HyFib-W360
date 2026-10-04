-- Campaign status filters on webhook endpoints (P5-09, ADR-146).
--
-- An endpoint that takes campaign.status_changed (0065) receives every change of every campaign's
-- status. It can now take only some statuses (completions and pauses, say): null keeps every
-- status, as before; a list holds 1 to 7 of the statuses a campaign reaches, the status the event
-- reports, and only while the endpoint takes campaign.status_changed, so a list never outlives its
-- event. A company has at most 10 endpoints, so the table is small and the check is validated here.
-- Containment refuses a list holding a null.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN campaign_statuses text[],
  ADD CONSTRAINT webhook_endpoints_campaign_statuses CHECK (
    campaign_statuses IS NULL
    OR (cardinality(campaign_statuses) BETWEEN 1 AND 7
        AND campaign_statuses <@ ARRAY['draft', 'pending_approval', 'scheduled', 'running', 'paused',
                                       'completed', 'canceled']::text[]
        AND 'campaign.status_changed' = ANY (event_types)));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (campaign_statuses) ON app.webhook_endpoints TO w360_app;

-- 0109's capture with the campaign status filter: a campaign.status_changed event is delivered only
-- to the active endpoints that take it and whose list is null or holds the status the campaign
-- reached (0065's trigger passes it as the event's status), and no event is written when none takes
-- it. Other types are captured as before. Same signature, so its owner and grants stay (0025);
-- replays and test events do not pass through here.
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
                    AND (p_type <> 'campaign.status_changed' OR e.campaign_statuses IS NULL
                         OR p_status = ANY (e.campaign_statuses))) THEN
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
     AND (p_type <> 'campaign.status_changed' OR e.campaign_statuses IS NULL
          OR p_status = ANY (e.campaign_statuses));
END
$$;
