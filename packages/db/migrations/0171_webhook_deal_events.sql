-- 0171_webhook_deal_events: outgoing webhook events for CRM deals (P5-09, P4-04, ADR-256).
-- deal.created when a deal is added, deal.stage_changed when a deal moves to another stage (of its
-- pipeline or of another one), and deal.status_changed when a deal is won, lost or reopened: by a
-- member, an automation or an API key alike. Captured by triggers like the events of 0063;
-- payloads are built when delivered, so a deal whose contact was erased is sent as erasure left it.

-- Event types ------------------------------------------------------------------------------------
-- A company has at most 10 endpoints, so the endpoints' check is validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check
    CHECK (cardinality(event_types) BETWEEN 1 AND 19
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'conversation.team_changed',
                             'contact.created', 'contact.updated', 'contact.erased',
                             'contact.merged', 'automation.run_started', 'automation.run_ended',
                             'order.received', 'order.status_changed',
                             'campaign.status_changed', 'deal.created', 'deal.stage_changed',
                             'deal.status_changed']::text[]);

-- NOT VALID: new rows are checked at once, and 0172 checks the rows already there without holding
-- the lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'conversation.team_changed', 'contact.created',
    'contact.updated', 'contact.erased', 'contact.merged', 'automation.run_started',
    'automation.run_ended', 'order.received', 'order.status_changed', 'campaign.status_changed',
    'deal.created', 'deal.stage_changed', 'deal.status_changed', 'ping')) NOT VALID;

-- Deals ------------------------------------------------------------------------------------------
-- The event keeps the deal, its stage and pipeline, and for a change the stage, pipeline or status
-- before it, in `detail`, with the contact and the status it reports. The rest is read when the
-- event is delivered. No endpoint filter narrows these events, so app.capture_webhook_event (0138)
-- writes one only when an active endpoint of the company takes it. One change of both the stage and
-- the status captures both events in the order the rules allow, as a closed deal never moves: a
-- deal reopened in another stage (its own was removed while it was closed) is reopened, then moved;
-- a deal one API request moves and closes is moved, then closed. Each event gives the deal as its
-- step left it. Each is stamped with the time it is captured, as campaign and conversation events
-- are (0065, 0070): the deal's row is locked while this runs, so a later change is stamped later.
CREATE FUNCTION app.webhook_capture_deal() RETURNS trigger
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
CREATE TRIGGER crm_deals_webhook_created AFTER INSERT ON app.crm_deals
  FOR EACH ROW EXECUTE FUNCTION app.webhook_capture_deal();
-- Erasure renames a deal and clears its lost reason, and a merge moves it to another contact,
-- without touching its stage or status, so neither sends anything here.
CREATE TRIGGER crm_deals_webhook_changed AFTER UPDATE OF stage_id, status ON app.crm_deals
  FOR EACH ROW WHEN (NEW.stage_id IS DISTINCT FROM OLD.stage_id
                     OR NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION app.webhook_capture_deal();

-- Trigger functions run with the rights of whoever makes the change: the runtime role in the
-- company's scope (members, automation runs and API keys), the only role that adds deals or
-- changes their stage or status.
REVOKE EXECUTE ON FUNCTION app.webhook_capture_deal() FROM PUBLIC;
