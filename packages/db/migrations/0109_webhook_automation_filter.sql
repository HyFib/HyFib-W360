-- Automation filters on webhook endpoints (P5-09, ADR-145).
--
-- An endpoint that takes automation run events (0055) receives every automation's runs. It can now
-- take them for chosen automations only: null keeps every automation, as before; a list holds 1 to
-- 20 automation ids, and only while the endpoint takes automation.run_started or
-- automation.run_ended, so a list never outlives its events. The services accept only automations
-- of the endpoint's company that have a published version, and such an automation cannot be
-- deleted (only archived), so a list never names one that is gone. A company has at most 10
-- endpoints, so the table is small and the check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN automation_ids uuid[],
  ADD CONSTRAINT webhook_endpoints_automation_ids CHECK (
    automation_ids IS NULL
    OR (cardinality(automation_ids) BETWEEN 1 AND 20
        AND array_position(automation_ids, NULL) IS NULL
        AND event_types && ARRAY['automation.run_started', 'automation.run_ended']::text[]));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (automation_ids) ON app.webhook_endpoints TO w360_app;

-- 0095's capture with the automation filter: an automation run event is delivered only to the
-- active endpoints that take it and whose list is null or holds the run's automation (the
-- automationId 0055's trigger puts in the event's detail), and no event is written when none
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
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.webhook_endpoints e
                  WHERE e.tenant_id = p_tenant AND e.state = 'active'
                    AND p_type = ANY (e.event_types)
                    AND (p_type <> 'message.status' OR e.message_statuses IS NULL
                         OR p_status = ANY (e.message_statuses))
                    AND (p_type NOT IN ('automation.run_started', 'automation.run_ended')
                         OR e.automation_ids IS NULL
                         OR (p_detail ->> 'automationId')::uuid = ANY (e.automation_ids))) THEN
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
          OR (p_detail ->> 'automationId')::uuid = ANY (e.automation_ids));
END
$$;
