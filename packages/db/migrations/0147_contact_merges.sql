-- 0147_contact_merges: merging two contacts (H-019, ADR-224). An owner or administrator keeps one
-- contact and merges another into it: app.merge_contacts moves the other contact's WhatsApp
-- identities, conversations, consent history, tags, field values, CRM records, orders, campaign
-- sends, automation runs and form answers to the kept contact, then deletes the other. Deleting it
-- rather than leaving an emptied row makes anything still naming it fail on its foreign key once the
-- merge commits (ingestion and jobs are retried, members' actions refused) instead of landing on a
-- contact nobody sees. Consent ends as the stricter of the two: an opt-out of the merged contact is
-- recorded on the kept contact as a 'merge' consent event, and an opt-in is never carried over.
-- Contacts that each have a phone number, or a conversation on the same WhatsApp number, or that
-- were both sent the same campaign, stay separate.

-- The record of each merge: who merged which contact into which, when, and how many records moved
-- (counts only). The merged contact is deleted, so its id is no foreign key; nothing else about it
-- is kept. A later merge of the kept contact re-points these rows to the contact kept then.
CREATE TABLE app.contact_merges (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  kept_contact_id uuid NOT NULL,
  merged_contact_id uuid NOT NULL,
  -- The member who merged; no foreign key, like the audit log's actor (a user can be deleted).
  merged_by_user_id text CHECK (char_length(merged_by_user_id) <= 64),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  merged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_merges_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT contact_merges_merged_uq UNIQUE (tenant_id, merged_contact_id),
  CONSTRAINT contact_merges_distinct CHECK (kept_contact_id <> merged_contact_id),
  CONSTRAINT contact_merges_kept_fk FOREIGN KEY (tenant_id, kept_contact_id)
    REFERENCES app.contacts (tenant_id, id)
);
CREATE INDEX contact_merges_kept_idx ON app.contact_merges (tenant_id, kept_contact_id);
SELECT ops.apply_tenant_rls('app.contact_merges');
-- Written only by app.merge_contacts.
GRANT SELECT ON app.contact_merges TO w360_app;

-- Deleted with the company (ADR-055), before its contacts.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (777, ARRAY['app.contact_merges']::regclass[], 'batch');
GRANT SELECT (tenant_id, id), DELETE ON app.contact_merges TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.contact_merges FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.contact_merges FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- A merged contact's opt-out carried to the contact it was merged into.
ALTER TABLE app.consent_events DROP CONSTRAINT consent_events_source_check;
ALTER TABLE app.consent_events ADD CONSTRAINT consent_events_source_check
  CHECK (source IN ('keyword', 'agent', 'import', 'provider', 'api', 'erasure', 'store', 'merge'));

-- Rows that never change, except that a merge moves them to the kept contact. Each exception holds
-- only while app.merge_contacts has set w360.contact_merge for its own statement, only for an
-- update that changes contact_id and nothing else, and only for a role holding UPDATE on contact_id,
-- which the definer role alone does (as w360.contact_erasure, 0005). Whole rows are compared as
-- jsonb without contact_id, so a column added later is covered too.

-- Consent history: app.reject_mutation's retention-purge exception, and a merge's move.
CREATE FUNCTION app.guard_consent_event_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND pg_catalog.current_setting('w360.contact_merge', true) = 'on'
     AND (pg_catalog.to_jsonb(NEW) - 'contact_id') = (pg_catalog.to_jsonb(OLD) - 'contact_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'W3403';
END
$$;
REVOKE EXECUTE ON FUNCTION app.guard_consent_event_mutation() FROM PUBLIC;
DROP TRIGGER consent_events_append_only ON app.consent_events;
CREATE TRIGGER consent_events_append_only BEFORE UPDATE OR DELETE ON app.consent_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_consent_event_mutation();

-- The CRM timeline: erasure's deletes (0013), and a merge's move. A deal, its tasks and its
-- timeline move together in one statement (their composite foreign keys tie each to one contact).
CREATE OR REPLACE FUNCTION app.guard_crm_activity() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.current_setting('w360.contact_erasure', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND pg_catalog.current_setting('w360.contact_merge', true) = 'on'
     AND (pg_catalog.to_jsonb(NEW) - 'contact_id') = (pg_catalog.to_jsonb(OLD) - 'contact_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the CRM timeline is append-only' USING ERRCODE = 'W3403';
END
$$;

-- Automation runs: what started a run stays fixed (0052), except the contact a merge moves it to;
-- the guard runs before the touch trigger, so updated_at is as the row had it.
CREATE OR REPLACE FUNCTION app.guard_automation_run() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'automation runs cannot be deleted' USING ERRCODE = 'W3403';
  END IF;
  IF pg_catalog.current_setting('w360.contact_merge', true) = 'on'
     AND (pg_catalog.to_jsonb(NEW) - 'contact_id') = (pg_catalog.to_jsonb(OLD) - 'contact_id') THEN
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.automation_id, NEW.version_id, NEW.conversation_id, NEW.contact_id,
      NEW.channel_account_id, NEW.mode, NEW.trigger_type, NEW.trigger_message_id,
      NEW.started_by_membership_id, NEW.started_by_user_id, NEW.started_at, NEW.store_event,
      NEW.api_key_id)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.automation_id, OLD.version_id, OLD.conversation_id, OLD.contact_id,
      OLD.channel_account_id, OLD.mode, OLD.trigger_type, OLD.trigger_message_id,
      OLD.started_by_membership_id, OLD.started_by_user_id, OLD.started_at, OLD.store_event,
      OLD.api_key_id)
     OR (NEW.store_order_id IS DISTINCT FROM OLD.store_order_id AND NEW.store_order_id IS NOT NULL) THEN
    RAISE EXCEPTION 'what started an automation run is fixed' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.status NOT IN ('running', 'waiting') THEN
    IF (NEW.status, NEW.current_node_id, NEW.node_visit, NEW.waiting_for, NEW.wait_until,
        NEW.input_message_id, NEW.pending_message_id, NEW.retries, NEW.failures, NEW.step_count,
        NEW.message_count, NEW.http_call_count, NEW.visits, NEW.next_step_at, NEW.ended_at,
        NEW.end_reason, NEW.end_detail, NEW.ended_by_membership_id)
       IS DISTINCT FROM
       (OLD.status, OLD.current_node_id, OLD.node_visit, OLD.waiting_for, OLD.wait_until,
        OLD.input_message_id, OLD.pending_message_id, OLD.retries, OLD.failures, OLD.step_count,
        OLD.message_count, OLD.http_call_count, OLD.visits, OLD.next_step_at, OLD.ended_at,
        OLD.end_reason, OLD.end_detail, OLD.ended_by_membership_id)
       OR (NEW.variables IS DISTINCT FROM OLD.variables AND NEW.variables <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'an ended automation run cannot change' USING ERRCODE = 'W3403';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- What app.merge_contacts reads and changes, as the definer role. Tables with a definer policy for
-- every command (0003-0020) need only the column grants; the others get policies limited to the
-- current company, which the function's scope sets.
GRANT SELECT (display_name, attributes) ON app.contacts TO w360_definer;
GRANT UPDATE (contact_id) ON app.contact_identities TO w360_definer;
GRANT SELECT (channel_account_id), UPDATE (contact_id) ON app.conversations TO w360_definer;
GRANT UPDATE (contact_id) ON app.consent_events TO w360_definer;
GRANT SELECT (tag), INSERT ON app.contact_tags TO w360_definer;
GRANT UPDATE (contact_id) ON app.automation_runs TO w360_definer;
GRANT UPDATE (contact_id) ON app.commerce_orders TO w360_definer;
GRANT UPDATE (contact_id) ON app.conversation_sources TO w360_definer;
GRANT UPDATE (contact_id) ON app.crm_deals TO w360_definer;
GRANT UPDATE (contact_id) ON app.crm_tasks TO w360_definer;
GRANT UPDATE (contact_id) ON app.crm_activities TO w360_definer;
GRANT UPDATE (contact_id) ON app.flow_sends TO w360_definer;
GRANT UPDATE (contact_id) ON app.flow_responses TO w360_definer;

GRANT SELECT (contact_id), UPDATE (contact_id) ON app.commerce_store_messages TO w360_definer;
CREATE POLICY contact_merge_update ON app.commerce_store_messages FOR UPDATE TO w360_definer
  USING (tenant_id = (SELECT app.current_tenant_id()));

GRANT SELECT (campaign_id, contact_id, state), UPDATE (contact_id) ON app.campaign_recipients
  TO w360_definer;
CREATE POLICY contact_merge_read ON app.campaign_recipients FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY contact_merge_update ON app.campaign_recipients FOR UPDATE TO w360_definer
  USING (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY contact_merge_delete ON app.campaign_recipients FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT app.current_tenant_id()));

-- The fields webhook (0096) runs as the role that changed the contact: a merge filling the kept
-- contact's field values reads the company's field keys.
GRANT SELECT (key) ON app.contact_fields TO w360_definer;
CREATE POLICY contact_merge_read ON app.contact_fields FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT app.current_tenant_id()));

GRANT SELECT (kept_contact_id, merged_contact_id), INSERT, UPDATE (kept_contact_id)
  ON app.contact_merges TO w360_definer;
CREATE POLICY contact_merge_read ON app.contact_merges FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY contact_merge_write ON app.contact_merges FOR INSERT TO w360_definer
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY contact_merge_update ON app.contact_merges FOR UPDATE TO w360_definer
  USING (tenant_id = (SELECT app.current_tenant_id()));

-- Merges p_merge into p_keep in the current company and deletes p_merge; returns how many records
-- moved. Refuses (W3404, W3409, W3412, with sentences members are shown) a contact of another
-- company or none, the same contact twice, an erased contact, two contacts with phone numbers,
-- conversations of both on the same WhatsApp number, more than 50 tags between them (the most a
-- contact can have), a campaign sent to both, and a send to the merged contact under way.
CREATE FUNCTION app.merge_contacts(p_keep uuid, p_merge uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_user text := app.current_user_id();
  v_keep record;
  v_merge record;
  v_state record;
  v_tags integer;
  v_carried text[] := '{}';
  v_identities integer;
  v_conversations integer;
  v_consent_events integer;
  v_new_tags integer;
  v_recipients integer;
  v_runs integer;
  v_orders integer;
  v_store_messages integer;
  v_sources integer;
  v_flow_sends integer;
  v_flow_answers integer;
  v_deals integer;
  v_tasks integer;
  v_notes integer;
  v_summary jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  IF p_keep IS NULL OR p_merge IS NULL THEN
    RAISE EXCEPTION 'Contact not found.' USING ERRCODE = 'W3404';
  END IF;
  IF p_keep = p_merge THEN
    RAISE EXCEPTION 'A contact cannot be merged into itself.' USING ERRCODE = 'W3409';
  END IF;
  -- Both contacts' conversations first, then both contacts, each in id order: every other writer
  -- (ingestion, replies, the automation runner, erasure) locks a conversation before its contact.
  -- Anything that read the merged contact before these locks either committed first, and is
  -- merged below, or meets the deleted contact's foreign key once this commits.
  PERFORM 1 FROM app.conversations cv
    WHERE cv.tenant_id = v_tenant AND cv.contact_id IN (p_keep, p_merge)
    ORDER BY cv.id FOR UPDATE;
  PERFORM 1 FROM app.contacts c
    WHERE c.tenant_id = v_tenant AND c.id IN (p_keep, p_merge)
    ORDER BY c.id FOR UPDATE;
  SELECT c.id, c.display_name, c.phone_e164, c.email, c.attributes, c.erased_at INTO v_keep
    FROM app.contacts c WHERE c.tenant_id = v_tenant AND c.id = p_keep;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contact not found.' USING ERRCODE = 'W3404';
  END IF;
  SELECT c.id, c.display_name, c.phone_e164, c.email, c.attributes, c.erased_at INTO v_merge
    FROM app.contacts c WHERE c.tenant_id = v_tenant AND c.id = p_merge;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contact not found.' USING ERRCODE = 'W3404';
  END IF;
  IF v_keep.erased_at IS NOT NULL OR v_merge.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'An erased contact cannot be merged.' USING ERRCODE = 'W3409';
  END IF;
  IF v_keep.phone_e164 IS NOT NULL AND v_merge.phone_e164 IS NOT NULL THEN
    RAISE EXCEPTION 'Both contacts have a phone number. A contact keeps one number, so they stay separate.'
      USING ERRCODE = 'W3412';
  END IF;

  -- A send records what Meta answered for the contact read when it was claimed. Queued sends to
  -- the merged contact are locked, so none is claimed before this commits (it then reads the kept
  -- contact); one already claimed has its answer still to come, so the merge waits for it.
  PERFORM 1 FROM app.send_intents s
    WHERE s.tenant_id = v_tenant AND s.state IN ('queued', 'deferred', 'sending')
      AND s.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                             ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                            WHERE m.tenant_id = v_tenant AND cv.contact_id = p_merge)
    ORDER BY s.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM app.send_intents s
              WHERE s.tenant_id = v_tenant AND s.state = 'sending'
                AND s.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                                       ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                                      WHERE m.tenant_id = v_tenant AND cv.contact_id = p_merge)) THEN
    RAISE EXCEPTION 'A message to the contact being merged is being sent. Try again in a minute.'
      USING ERRCODE = 'W3409';
  END IF;

  -- One conversation per company number and contact: conversations cannot be joined.
  IF EXISTS (SELECT 1 FROM app.conversations k JOIN app.conversations m
               ON m.tenant_id = k.tenant_id AND m.channel_account_id = k.channel_account_id
              WHERE k.tenant_id = v_tenant AND k.contact_id = p_keep AND m.contact_id = p_merge) THEN
    RAISE EXCEPTION 'Both contacts have a conversation on the same WhatsApp number. Conversations cannot be joined, so they stay separate.'
      USING ERRCODE = 'W3412';
  END IF;
  -- MAX_TAGS_PER_CONTACT (packages/domain/src/contacts/fields.ts).
  SELECT count(DISTINCT t.tag) INTO v_tags FROM app.contact_tags t
   WHERE t.tenant_id = v_tenant AND t.contact_id IN (p_keep, p_merge);
  IF v_tags > 50 THEN
    RAISE EXCEPTION 'Together these contacts have more than 50 tags, the most a contact can have. Remove some first.'
      USING ERRCODE = 'W3412';
  END IF;

  -- A campaign both contacts were in keeps one row for the person: the one its message was sent
  -- from, else one still waiting to be sent (so the person is not sent it twice), else the kept
  -- contact's. A row a message was sent from is never deleted: contacts both sent a campaign stay
  -- separate. The rows are locked first, so the campaign runner changes none meanwhile.
  PERFORM 1 FROM app.campaign_recipients r
    WHERE r.tenant_id = v_tenant AND r.contact_id IN (p_keep, p_merge)
    ORDER BY r.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM app.campaign_recipients k JOIN app.campaign_recipients m
               ON m.tenant_id = k.tenant_id AND m.campaign_id = k.campaign_id
              WHERE k.tenant_id = v_tenant AND k.contact_id = p_keep AND m.contact_id = p_merge
                AND k.state = 'queued' AND m.state = 'queued') THEN
    RAISE EXCEPTION 'Both contacts were sent the same campaign, so they stay separate.'
      USING ERRCODE = 'W3412';
  END IF;
  DELETE FROM app.campaign_recipients d
   USING app.campaign_recipients k, app.campaign_recipients m
   WHERE k.tenant_id = v_tenant AND k.contact_id = p_keep
     AND m.tenant_id = v_tenant AND m.contact_id = p_merge AND m.campaign_id = k.campaign_id
     AND d.tenant_id = v_tenant
     AND d.id = CASE
       WHEN (CASE m.state WHEN 'queued' THEN 3 WHEN 'pending' THEN 2 WHEN 'canceled' THEN 1 ELSE 0 END)
          > (CASE k.state WHEN 'queued' THEN 3 WHEN 'pending' THEN 2 WHEN 'canceled' THEN 1 ELSE 0 END)
       THEN k.id ELSE m.id END;
  UPDATE app.campaign_recipients r SET contact_id = p_keep
   WHERE r.tenant_id = v_tenant AND r.contact_id = p_merge;
  GET DIAGNOSTICS v_recipients = ROW_COUNT;

  UPDATE app.contact_identities i SET contact_id = p_keep
   WHERE i.tenant_id = v_tenant AND i.contact_id = p_merge;
  GET DIAGNOSTICS v_identities = ROW_COUNT;
  UPDATE app.conversations cv SET contact_id = p_keep
   WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_merge;
  GET DIAGNOSTICS v_conversations = ROW_COUNT;

  -- Consent: the history moves whole, with its times and sources; the kept contact's state stays,
  -- except that the merged contact's opt-out is recorded on it (at the latest of now and the state's
  -- own time, where an opt-out wins a tie). A merge never adds an opt-in.
  FOR v_state IN
    SELECT m.purpose, m.event_id, k.occurred_at AS kept_at
      FROM app.contact_consents m
      LEFT JOIN app.contact_consents k
        ON k.tenant_id = m.tenant_id AND k.contact_id = p_keep AND k.purpose = m.purpose
     WHERE m.tenant_id = v_tenant AND m.contact_id = p_merge AND m.status = 'opted_out'
       AND k.status IS DISTINCT FROM 'opted_out'
     ORDER BY m.purpose
  LOOP
    v_carried := v_carried || v_state.purpose;
    INSERT INTO app.consent_events (id, tenant_id, contact_id, purpose, action, source, evidence,
      actor_type, actor_id, occurred_at)
    VALUES (gen_random_uuid(), v_tenant, p_keep, v_state.purpose, 'opt_out', 'merge',
            jsonb_build_object('mergedContactId', p_merge, 'eventId', v_state.event_id),
            CASE WHEN v_user IS NULL THEN 'system' ELSE 'user' END, v_user,
            greatest(now(), coalesce(v_state.kept_at, now())));
  END LOOP;
  PERFORM pg_catalog.set_config('w360.contact_merge', 'on', true);
  UPDATE app.consent_events e SET contact_id = p_keep
   WHERE e.tenant_id = v_tenant AND e.contact_id = p_merge;
  GET DIAGNOSTICS v_consent_events = ROW_COUNT;
  PERFORM pg_catalog.set_config('w360.contact_merge', 'off', true);
  DELETE FROM app.contact_consents cc WHERE cc.tenant_id = v_tenant AND cc.contact_id = p_merge;

  INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag)
  SELECT gen_random_uuid(), v_tenant, p_keep, t.tag FROM app.contact_tags t
   WHERE t.tenant_id = v_tenant AND t.contact_id = p_merge
  ON CONFLICT (tenant_id, contact_id, tag) DO NOTHING;
  GET DIAGNOSTICS v_new_tags = ROW_COUNT;
  DELETE FROM app.contact_tags t WHERE t.tenant_id = v_tenant AND t.contact_id = p_merge;

  PERFORM pg_catalog.set_config('w360.contact_merge', 'on', true);
  UPDATE app.automation_runs r SET contact_id = p_keep
   WHERE r.tenant_id = v_tenant AND r.contact_id = p_merge;
  GET DIAGNOSTICS v_runs = ROW_COUNT;
  -- A deal, its tasks and its timeline name their contact together (composite foreign keys): one
  -- statement moves all three, and the keys are checked at its end.
  WITH deals AS (
    UPDATE app.crm_deals d SET contact_id = p_keep
     WHERE d.tenant_id = v_tenant AND d.contact_id = p_merge RETURNING 1
  ), tasks AS (
    UPDATE app.crm_tasks t SET contact_id = p_keep
     WHERE t.tenant_id = v_tenant AND t.contact_id = p_merge RETURNING 1
  ), notes AS (
    UPDATE app.crm_activities a SET contact_id = p_keep
     WHERE a.tenant_id = v_tenant AND a.contact_id = p_merge RETURNING 1
  )
  SELECT (SELECT count(*) FROM deals), (SELECT count(*) FROM tasks), (SELECT count(*) FROM notes)
    INTO v_deals, v_tasks, v_notes;
  PERFORM pg_catalog.set_config('w360.contact_merge', 'off', true);

  UPDATE app.commerce_orders o SET contact_id = p_keep
   WHERE o.tenant_id = v_tenant AND o.contact_id = p_merge;
  GET DIAGNOSTICS v_orders = ROW_COUNT;
  UPDATE app.commerce_store_messages s SET contact_id = p_keep
   WHERE s.tenant_id = v_tenant AND s.contact_id = p_merge;
  GET DIAGNOSTICS v_store_messages = ROW_COUNT;
  UPDATE app.conversation_sources s SET contact_id = p_keep
   WHERE s.tenant_id = v_tenant AND s.contact_id = p_merge;
  GET DIAGNOSTICS v_sources = ROW_COUNT;
  UPDATE app.flow_sends f SET contact_id = p_keep
   WHERE f.tenant_id = v_tenant AND f.contact_id = p_merge;
  GET DIAGNOSTICS v_flow_sends = ROW_COUNT;
  UPDATE app.flow_responses f SET contact_id = p_keep
   WHERE f.tenant_id = v_tenant AND f.contact_id = p_merge;
  GET DIAGNOSTICS v_flow_answers = ROW_COUNT;
  UPDATE app.contact_merges cm SET kept_contact_id = p_keep
   WHERE cm.tenant_id = v_tenant AND cm.kept_contact_id = p_merge;

  -- The kept contact keeps its name, number, email and field values, and takes the merged
  -- contact's where it has none (the number is freed from the merged contact first).
  IF v_keep.phone_e164 IS NULL AND v_merge.phone_e164 IS NOT NULL THEN
    UPDATE app.contacts c SET phone_e164 = NULL WHERE c.tenant_id = v_tenant AND c.id = p_merge;
  END IF;
  UPDATE app.contacts c
     SET display_name = coalesce(v_keep.display_name, v_merge.display_name),
         phone_e164 = coalesce(v_keep.phone_e164, v_merge.phone_e164),
         email = coalesce(v_keep.email, v_merge.email),
         attributes = v_merge.attributes || v_keep.attributes
   WHERE c.tenant_id = v_tenant AND c.id = p_keep;

  -- What this transaction captured about the merged contact goes with it: webhook events naming a
  -- contact that will not exist, and the API's change records of it.
  DELETE FROM app.webhook_events e
   WHERE e.tenant_id = v_tenant AND e.contact_id = p_merge
     AND e.captured_xact = pg_catalog.pg_current_xact_id();
  DELETE FROM app.contact_changes ch WHERE ch.tenant_id = v_tenant AND ch.contact_id = p_merge;
  DELETE FROM app.contacts c WHERE c.tenant_id = v_tenant AND c.id = p_merge;

  v_summary := jsonb_build_object(
    'identities', v_identities, 'conversations', v_conversations,
    'consentEvents', v_consent_events, 'tags', v_new_tags, 'deals', v_deals, 'tasks', v_tasks,
    'notes', v_notes, 'orders', v_orders, 'storeMessages', v_store_messages,
    'campaignSends', v_recipients, 'automationRuns', v_runs, 'flowSends', v_flow_sends,
    'flowAnswers', v_flow_answers, 'conversationSources', v_sources,
    'optOutsCarried', to_jsonb(v_carried));
  INSERT INTO app.contact_merges (id, tenant_id, kept_contact_id, merged_contact_id,
    merged_by_user_id, summary)
  VALUES (gen_random_uuid(), v_tenant, p_keep, p_merge, v_user, v_summary);
  RETURN v_summary;
END
$$;
REVOKE EXECUTE ON FUNCTION app.merge_contacts(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.merge_contacts(uuid, uuid) TO w360_app;
ALTER FUNCTION app.merge_contacts(uuid, uuid) OWNER TO w360_definer;
