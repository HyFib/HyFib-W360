-- Message status filters on webhook endpoints (P5-09, ADR-119).
--
-- message.status is the busiest event: every message a company sends is accepted, sent, delivered
-- and often read. An endpoint can now take only some statuses (failures alone, say): null keeps
-- every status, as before; a list holds 1 to 8 of the statuses the message trigger captures, and
-- only while the endpoint takes message.status, so a list never outlives its event. A company has
-- at most 10 endpoints, so the table is small and the check is validated here.
ALTER TABLE app.webhook_endpoints
  ADD COLUMN message_statuses text[],
  ADD CONSTRAINT webhook_endpoints_message_statuses CHECK (
    message_statuses IS NULL
    OR (cardinality(message_statuses) BETWEEN 1 AND 8
        AND message_statuses <@ ARRAY['accepted', 'sent', 'delivered', 'read', 'played', 'failed',
                                      'canceled', 'unknown_outcome']::text[]
        AND 'message.status' = ANY (event_types)));

-- The runtime role sets it when it adds an endpoint (its table grant) and changes it with the
-- events (0025 grants updates column by column). Both roles read it through their table grants.
GRANT UPDATE (message_statuses) ON app.webhook_endpoints TO w360_app;

-- The filter applies when an event is captured: a message.status delivery is created only for the
-- endpoints whose list is null or holds the status, and no event is written when no active
-- endpoint takes it. Other types are captured as before. Same signature, so its owner and grants
-- stay (0025); replays and test events do not pass through here.
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
                         OR p_status = ANY (e.message_statuses))) THEN
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
          OR p_status = ANY (e.message_statuses));
END
$$;
