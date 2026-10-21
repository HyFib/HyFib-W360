-- 0327_webhook_campaign_reply_trigger: webhook endpoints may choose runs started by replies to a
-- campaign (P4-01, P5-09, ADR-414).
--
-- A file of its own, apart from 0324: 0324 locks app.automation_runs, and a run event's delivery
-- reads app.webhook_endpoints before app.automation_runs, so taking both locks in one transaction
-- (runs, then endpoints) could deadlock with a delivery. This transaction locks only
-- app.webhook_endpoints.
--
-- The run trigger filters (0131, 0247) take the new trigger: a list holds 1 to 6 of the triggers
-- `run.trigger` names. A company has at most 10 endpoints, so the table is small and the check is
-- validated here, as 0131 and 0247 did. Endpoints with a list keep receiving exactly what they
-- chose (a run of the new trigger is in no stored list); those without one receive every run,
-- these included.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_run_triggers,
  ADD CONSTRAINT webhook_endpoints_run_triggers CHECK (
    run_triggers IS NULL
    OR (cardinality(run_triggers) BETWEEN 1 AND 6
        AND run_triggers <@ ARRAY['keyword', 'conversation_started', 'any_message', 'store_event',
                                  'api', 'campaign_reply']::text[]
        AND event_types && ARRAY['automation.run_started', 'automation.run_ended',
                                 'automation.run_step']::text[]));
