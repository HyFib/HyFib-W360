-- 0305_webhook_deal_field_events: deal.updated when a CRM deal's custom field values change
-- (P5-09, P4-04, ADR-390). A change of a deal's custom field values (`crm_deals.attributes`, ADR-373)
-- sent no webhook event: an integration keeping deals in step never learnt of it. deal.updated now
-- names it as `fields` in its `changes`, after the fixed details (title, valueMinor,
-- expectedCloseOn), with the keys of the fields whose values were set, changed or removed in the
-- event's `changedFields`, never the values. It is captured whoever changes the values: a member on
-- the deal page, a key (`PATCH /deals/{id}` with `fields`), an automation's "Update deal fields"
-- step (ADR-386), a deal import (ADR-387) and erasure, which clears an erased contact's deals'
-- values beside retitling them (ADR-275).
--
-- Only the keys of fields the company still has are compared. Deleting a field deletes its row
-- first and then strips its key from every deal in the same transaction (ADR-373), so that strip
-- compares no key and sends no per-deal event: it changes the company's field definitions, not its
-- deals. Nothing a company or a request supplies decides this; it follows from the order of the
-- deletion's own statements and from row security (the fields read are the current company's).

-- Event details ----------------------------------------------------------------------------------

-- A deal.updated event's detail can now hold the keys of up to 50 fields (ADR-373's limit) of up to
-- 40 characters each, about 2,600 bytes with the rest of the detail, more than the 2,048 bytes the
-- check allowed (0025). Erasure clearing a deal with values in all 50 fields must not fail, so the
-- bound is 4,096 bytes. The check is only widened, so every row passes it; NOT VALID, so this
-- migration does not read the table under the lock it takes, and 0306 validates it while captures
-- go on.
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_detail_check,
  ADD CONSTRAINT webhook_events_detail_check
    CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 4096) NOT VALID;

-- Endpoints' deal details ------------------------------------------------------------------------

-- An endpoint taking deal.updated may list `fields` among the details whose changes it takes
-- (0233, ADR-310): a list of 1 to 4 of title, valueMinor, expectedCloseOn and fields. Lists saved
-- before keep their details, so they do not receive a change of values alone. A company has at most
-- 10 endpoints, so the table is small and the check is validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_deal_details,
  ADD CONSTRAINT webhook_endpoints_deal_details CHECK (
    deal_details IS NULL
    OR (cardinality(deal_details) BETWEEN 1 AND 4
        AND array_ndims(deal_details) = 1
        AND array_position(deal_details, NULL) IS NULL
        AND deal_details <@ ARRAY['title', 'valueMinor', 'expectedCloseOn', 'fields']::text[]
        AND 'deal.updated' = ANY (event_types)));

-- The definer role's read of field keys ----------------------------------------------------------

-- Erasure (`app.erase_contact`, SECURITY DEFINER) clears an erased contact's deals' values as the
-- definer role, so the capture below runs as that role and reads which fields the company has: the
-- key and the order they were added in, of the company erasure runs for (it refuses to run without
-- one), and nothing else of a field (not its label, type or options). Its other policies on the
-- table read only a company being deleted (0293). The capture's filter and order also read
-- `tenant_id` and `id`, which 0293 granted the role for company deletion: erasure needs that grant
-- too.
GRANT SELECT (key, created_at) ON app.crm_deal_fields TO w360_definer;
CREATE POLICY deal_capture_read ON app.crm_deal_fields FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT app.current_tenant_id()));

-- Deals ------------------------------------------------------------------------------------------

-- 0215's capture with the change of custom field values among the details changed. `changes` lists
-- `fields` after the fixed details, so one update changing a title and a value sends one
-- deal.updated naming both, in its place among the update's steps (reopened, moved, details
-- changed, given to another owner, closed), stamped with clock_timestamp(). `changedFields` holds
-- the keys of the company's fields whose values differ, in the order the fields were added (as
-- Settings and GET /deal-fields list them); a key no field has (a field being deleted) is never
-- compared, and an update whose values compare equal (the same values written again) changes
-- nothing. The fields are read only when the values changed. Replaced in place: the function keeps
-- its owner and grants (it is not SECURITY DEFINER; it runs as the role making the change).
CREATE OR REPLACE FUNCTION app.webhook_capture_deal() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_reopened boolean;
  v_closed boolean;
  v_changes text[];
  v_fields text[] := '{}';
  v_by jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.created', NULL, NULL, NEW.contact_id,
      NULL, NEW.status,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id,
                         'stepOwnerId', NEW.owner_membership_id),
      clock_timestamp());
    RETURN NULL;
  END IF;
  v_by := jsonb_build_object('changedBy', NEW.changed_by, 'apiKeyId', NEW.changed_by_api_key_id);
  v_reopened := NEW.status = 'open' AND OLD.status <> 'open';
  v_closed := NEW.status IS DISTINCT FROM OLD.status AND NOT v_reopened;
  IF v_reopened THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.status_changed', NULL, NULL,
      NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('dealId', NEW.id, 'stageId', OLD.stage_id, 'pipelineId', OLD.pipeline_id,
                         'previousStatus', OLD.status,
                         'stepOwnerId', OLD.owner_membership_id) || v_by,
      clock_timestamp());
  END IF;
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.stage_changed', NULL, NULL,
      NEW.contact_id, NULL, CASE WHEN v_closed THEN OLD.status ELSE NEW.status END,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id,
                         'previousStageId', OLD.stage_id,
                         'previousPipelineId',
                         CASE WHEN NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id
                              THEN OLD.pipeline_id END,
                         'stepOwnerId', OLD.owner_membership_id) || v_by,
      clock_timestamp());
  END IF;
  IF NEW.attributes IS DISTINCT FROM OLD.attributes THEN
    SELECT coalesce(array_agg(f.key ORDER BY f.created_at, f.id), '{}') INTO v_fields
      FROM app.crm_deal_fields f
     WHERE f.tenant_id = NEW.tenant_id
       AND (OLD.attributes -> f.key) IS DISTINCT FROM (NEW.attributes -> f.key);
  END IF;
  v_changes := array_remove(ARRAY[
    CASE WHEN NEW.title IS DISTINCT FROM OLD.title THEN 'title' END,
    CASE WHEN NEW.value_minor IS DISTINCT FROM OLD.value_minor THEN 'valueMinor' END,
    CASE WHEN NEW.expected_close_on IS DISTINCT FROM OLD.expected_close_on
         THEN 'expectedCloseOn' END,
    CASE WHEN cardinality(v_fields) > 0 THEN 'fields' END], NULL);
  IF cardinality(v_changes) > 0 THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.updated', NULL, NULL,
      NEW.contact_id, NULL, CASE WHEN v_closed THEN OLD.status ELSE NEW.status END,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id,
                         'changes', to_jsonb(v_changes),
                         'changedFields', to_jsonb(v_fields),
                         'stepOwnerId', OLD.owner_membership_id) || v_by,
      clock_timestamp());
  END IF;
  IF NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.owner_changed', NULL, NULL,
      NEW.contact_id, NULL, CASE WHEN v_closed THEN OLD.status ELSE NEW.status END,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id,
                         'ownerId', NEW.owner_membership_id,
                         'previousOwnerId', OLD.owner_membership_id,
                         'stepOwnerId', NEW.owner_membership_id) || v_by,
      clock_timestamp());
  END IF;
  IF v_closed THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'deal.status_changed', NULL, NULL,
      NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('dealId', NEW.id, 'stageId', NEW.stage_id, 'pipelineId', NEW.pipeline_id,
                         'previousStatus', OLD.status,
                         'stepOwnerId', NEW.owner_membership_id) || v_by,
      clock_timestamp());
  END IF;
  RETURN NULL;
END
$$;

-- The capture fires on the values too. Merges change none of these columns, so they still send
-- nothing; a field's deletion fires it for every deal with a value of the field and captures
-- nothing (above). Replaced in place, so the trigger's name and table stay.
CREATE OR REPLACE TRIGGER crm_deals_webhook_changed
  AFTER UPDATE OF stage_id, status, owner_membership_id, title, value_minor, expected_close_on,
    attributes
  ON app.crm_deals
  FOR EACH ROW WHEN (NEW.stage_id IS DISTINCT FROM OLD.stage_id
                     OR NEW.status IS DISTINCT FROM OLD.status
                     OR NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id
                     OR NEW.title IS DISTINCT FROM OLD.title
                     OR NEW.value_minor IS DISTINCT FROM OLD.value_minor
                     OR NEW.expected_close_on IS DISTINCT FROM OLD.expected_close_on
                     OR NEW.attributes IS DISTINCT FROM OLD.attributes)
  EXECUTE FUNCTION app.webhook_capture_deal();

-- Who made the change (0196, ADR-277) is now what a change of values reports too: a change of
-- values written without recording its maker (erasure, a field's deletion, code from before this
-- migration) must not keep a maker an earlier transaction recorded. Members, keys, automations and
-- imports already record themselves with every change of values. Replaced in place.
CREATE OR REPLACE TRIGGER crm_deals_changer
  BEFORE UPDATE OF stage_id, status, owner_membership_id, title, value_minor, expected_close_on,
    attributes
  ON app.crm_deals
  FOR EACH ROW WHEN (NEW.stage_id IS DISTINCT FROM OLD.stage_id
                     OR NEW.status IS DISTINCT FROM OLD.status
                     OR NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id
                     OR NEW.title IS DISTINCT FROM OLD.title
                     OR NEW.value_minor IS DISTINCT FROM OLD.value_minor
                     OR NEW.expected_close_on IS DISTINCT FROM OLD.expected_close_on
                     OR NEW.attributes IS DISTINCT FROM OLD.attributes)
  EXECUTE FUNCTION app.crm_changer();
