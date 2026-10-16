-- 0308_webhook_deal_item_events: deal.updated when a CRM deal's products change (P5-09, P4-04,
-- ADR-397). Adding or removing a product on a deal (`app.crm_deal_items`: members on the deal page,
-- ADR-375; keys through POST and DELETE /deals/{id}/items, ADR-378) sent no webhook event: a
-- receiver keeping quotes or orders in step with deals learnt of it only from the deal's next event,
-- whose deal gives the products as they are when it is delivered (ADR-395). deal.updated now names
-- it as `items` in its `changes`, alone: each product added or removed is one row, captured by a
-- trigger on the item in the transaction that adds or removes it, so one product change sends one
-- event. The deal's own capture (0305) sends nothing for it: a change of products moves only the
-- deal's version and changer, columns its trigger does not watch. The event names no product, price
-- or quantity, as the other details are named without their values (ADR-275, ADR-390).
--
-- No table is added, so row security is unchanged, and no role gains a privilege: the runtime role
-- already reads deals (0013) and runs the capture functions (0025), and the definer role, which
-- deletes items only with their company, reads nothing here (below).
--
-- This is ADR-397's part two. The release before it (part one, no migration) renders `items` in
-- its workers and has its web servers record the member or key on the deal before a product is
-- added or removed, so this migration is backward compatible with that release. Applied while a
-- worker or web server from before part one runs, an event naming `items` alone would be sent
-- with `changes` empty and a removal would name nobody (docs/DEPLOYMENT.md).

-- Endpoints' deal details ------------------------------------------------------------------------

-- An endpoint taking deal.updated may list `items` among the details whose changes it takes (0233,
-- ADR-310; `fields` since 0305): a list of 1 to 5 of title, valueMinor, expectedCloseOn, fields and
-- items. Lists saved before keep their details, so they do not receive a change of products until
-- `items` is added; null still takes every change. app.capture_webhook_event is unchanged: its
-- detail filter already matches `changes`. A company has at most 10 endpoints, so the table is small
-- and the check is validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_deal_details,
  ADD CONSTRAINT webhook_endpoints_deal_details CHECK (
    deal_details IS NULL
    OR (cardinality(deal_details) BETWEEN 1 AND 5
        AND array_ndims(deal_details) = 1
        AND array_position(deal_details, NULL) IS NULL
        AND deal_details <@ ARRAY['title', 'valueMinor', 'expectedCloseOn', 'fields',
                                  'items']::text[]
        AND 'deal.updated' = ANY (event_types)));

-- Deal items -------------------------------------------------------------------------------------

-- A product added to or removed from a deal: one deal.updated naming `items` alone, with the deal's
-- stage, pipeline and status as they are (a change of products moves none of them), its owner as the
-- step's owner (0215) and an empty `changedFields`, stamped with clock_timestamp(). Who made it: an
-- addition's maker is the item's own creator (the member, or the key that added it, 0297), as
-- deal.created's is the deal's (0229); a removal's is the maker this transaction recorded on the
-- deal (0196; members and keys record themselves on the deal before they remove the item since
-- ADR-397's part one), and nobody when it recorded none, never one an earlier transaction recorded.
--
-- Nothing is read when no active endpoint of the company takes deal.updated: most companies, and a
-- company being deleted, whose endpoints are deleted (step 60) before its deals' items (step 295),
-- so the deletion's batches, run as the definer role, read no deal and capture nothing; the definer
-- role may not read most of a deal's columns. No other definer function adds or removes items
-- (erasure keeps them, ADR-375). Not SECURITY DEFINER: it runs as the role making the change (the
-- runtime role in the company's scope), so row security keeps the deal read and the event in the
-- item's company. Items are never changed in place (0294 grants no UPDATE), so only additions and
-- removals fire it.
CREATE FUNCTION app.webhook_capture_deal_item() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid;
  v_deal uuid;
  v_contact uuid;
  v_stage uuid;
  v_pipeline uuid;
  v_status text;
  v_owner uuid;
  v_changed_by text;
  v_changed_key uuid;
  v_changed_xact xid8;
  v_by jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant := OLD.tenant_id;
    v_deal := OLD.deal_id;
  ELSE
    v_tenant := NEW.tenant_id;
    v_deal := NEW.deal_id;
  END IF;
  IF NOT app.webhook_subscribed(v_tenant, 'deal.updated') THEN
    RETURN NULL;
  END IF;
  SELECT d.contact_id, d.stage_id, d.pipeline_id, d.status, d.owner_membership_id,
         d.changed_by, d.changed_by_api_key_id, d.changed_xact
    INTO v_contact, v_stage, v_pipeline, v_status, v_owner, v_changed_by, v_changed_key,
         v_changed_xact
    FROM app.crm_deals d
   WHERE d.tenant_id = v_tenant AND d.id = v_deal;
  -- The item's foreign key keeps its deal, which is in the item's company, as the role sees it.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the deal of a deal item cannot be read';
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_by := jsonb_build_object(
      'changedBy', CASE WHEN NEW.created_by_api_key_id IS NOT NULL THEN 'api' ELSE 'member' END,
      'apiKeyId', NEW.created_by_api_key_id);
  ELSIF v_changed_xact = pg_catalog.pg_current_xact_id() THEN
    v_by := jsonb_build_object('changedBy', v_changed_by, 'apiKeyId', v_changed_key);
  ELSE
    v_by := jsonb_build_object('changedBy', NULL::text, 'apiKeyId', NULL::uuid);
  END IF;
  PERFORM app.capture_webhook_event(v_tenant, 'deal.updated', NULL, NULL, v_contact, NULL,
    v_status,
    jsonb_build_object('dealId', v_deal, 'stageId', v_stage, 'pipelineId', v_pipeline,
                       'changes', jsonb_build_array('items'),
                       'changedFields', '[]'::jsonb,
                       'stepOwnerId', v_owner) || v_by,
    clock_timestamp());
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_deal_item() FROM PUBLIC;

CREATE TRIGGER crm_deal_items_webhook AFTER INSERT OR DELETE ON app.crm_deal_items
  FOR EACH ROW EXECUTE FUNCTION app.webhook_capture_deal_item();
