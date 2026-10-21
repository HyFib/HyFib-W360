-- 0324_automation_campaign_replies: automations started by replies to a campaign (P4-01, ADR-414).
--
-- A new trigger, `campaign_reply`, starts an automation when a customer's message answers a
-- campaign message: a reply quoting it, or a tap on one of its template's quick-reply buttons (the
-- message's `context.id` names the campaign message's WAMID, research M-178 and M-186), within 72
-- hours of the recipient being queued. The dispatcher finds the campaign through two unique indexes
-- that already exist: `messages_external_uq` (tenant, number, WAMID; 0003) and
-- `campaign_recipients_message_uq` (tenant, message; 0006), so no index is added for the lookup.

-- Runs ---------------------------------------------------------------------------------------------
-- The run records what started it (0011). The check is replaced NOT VALID, so app.automation_runs is
-- not read under this migration's lock. Every stored row was validated (0054) against the check it
-- replaces, whose values are a subset of these, so every stored row satisfies it; rows written from
-- now on are checked when written. It is left unvalidated: nothing reads `convalidated`, and the
-- planner does not use the check.
ALTER TABLE app.automation_runs
  DROP CONSTRAINT automation_runs_trigger_type_check,
  ADD CONSTRAINT automation_runs_trigger_type_check CHECK (trigger_type IN
    ('keyword', 'conversation_started', 'any_message', 'test', 'store_event', 'api',
     'campaign_reply')) NOT VALID;

-- The campaign a run answers ------------------------------------------------------------------------
-- One row per run, written in the transaction that starts it and never changed (no UPDATE or DELETE
-- grant): a live run started by a reply to a campaign (its variant as the recipient row recorded it,
-- ADR-405 and ADR-410, and the quick-reply button's text as WhatsApp sent it, null for a quoting
-- reply), or a test run of an automation that names a campaign (no variant; the trigger's button).
-- A new table rather than columns on app.automation_runs, so that table's guard (0311) and its locks
-- are untouched. The button's text is the template's own text, clipped to 60 characters (Meta's
-- limit is 25 as far as HyFib knows, TEMPLATE_LIMITS), never what the customer typed. Deleted with
-- its run (retention, ADR-035, and company deletion). Campaigns are deleted only with their company
-- (step 710, after this table's step 688), so the campaign key needs no ON DELETE action.
CREATE TABLE app.automation_run_campaigns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  variant text CHECK (variant ~ '^[A-Z]$'),
  button_text text CHECK (char_length(button_text) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_run_campaigns_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT automation_run_campaigns_run_uq UNIQUE (tenant_id, run_id),
  CONSTRAINT automation_run_campaigns_run_fk FOREIGN KEY (tenant_id, run_id)
    REFERENCES app.automation_runs (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT automation_run_campaigns_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES app.campaigns (tenant_id, id)
);
-- The campaign key's lookups, and runs by campaign.
CREATE INDEX automation_run_campaigns_campaign_idx
  ON app.automation_run_campaigns (tenant_id, campaign_id);
SELECT ops.apply_tenant_rls('app.automation_run_campaigns');
GRANT SELECT, INSERT ON app.automation_run_campaigns TO w360_app;
CREATE TRIGGER automation_run_campaigns_append_only BEFORE UPDATE ON app.automation_run_campaigns
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Deleted with the company (ADR-055): before the runs it names (690) and the campaigns (710).
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (688, ARRAY['app.automation_run_campaigns']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.automation_run_campaigns TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.automation_run_campaigns FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.automation_run_campaigns FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- Webhook endpoints' run trigger filters (0131, 0247) take the new trigger: a list holds 1 to 6 of
-- the triggers `run.trigger` names. A company has at most 10 endpoints, so the table is small and
-- the check is validated here, as 0131 and 0247 did. Endpoints with a list keep receiving exactly
-- what they chose (a run of the new trigger is in no stored list); those without one receive every
-- run, these included.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_run_triggers,
  ADD CONSTRAINT webhook_endpoints_run_triggers CHECK (
    run_triggers IS NULL
    OR (cardinality(run_triggers) BETWEEN 1 AND 6
        AND run_triggers <@ ARRAY['keyword', 'conversation_started', 'any_message', 'store_event',
                                  'api', 'campaign_reply']::text[]
        AND event_types && ARRAY['automation.run_started', 'automation.run_ended',
                                 'automation.run_step']::text[]));
