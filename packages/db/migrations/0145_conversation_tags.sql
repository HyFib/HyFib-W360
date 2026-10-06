-- 0145_conversation_tags: conversation tags (P3-06, W-035, ADR-220). Members who can reply in a
-- conversation label it with short tags ("refund", "follow up"), and the inbox lists the
-- conversations that have a tag. Tags are free text written as contact tags are (0005): lower case,
-- trimmed, 1 to 40 characters, without commas or control characters. A conversation has at most 20
-- tags; the service counts them under the conversation's row lock.
CREATE TABLE app.conversation_tags (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  tag text NOT NULL
    CONSTRAINT conversation_tags_tag_check
    CHECK (char_length(tag) BETWEEN 1 AND 40 AND tag = lower(btrim(tag)) AND tag !~ '[[:cntrl:],]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_tags_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT conversation_tags_conversation_tag_uq UNIQUE (tenant_id, conversation_id, tag),
  CONSTRAINT conversation_tags_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES app.conversations (tenant_id, id)
);
-- The inbox's filter by tag, and the tags in use that it offers.
CREATE INDEX conversation_tags_tag_idx ON app.conversation_tags (tenant_id, tag);
SELECT ops.apply_tenant_rls('app.conversation_tags');
GRANT SELECT, INSERT, DELETE ON app.conversation_tags TO w360_app;

-- Deleted with the company (ADR-055), before its conversations.
INSERT INTO ops.tenant_deletion_steps (ordinal, tables, mode) VALUES
  (365, ARRAY['app.conversation_tags']::regclass[], 'batch');
GRANT SELECT (tenant_id, id, conversation_id), DELETE ON app.conversation_tags TO w360_definer;
CREATE POLICY tenant_deletion_read ON app.conversation_tags FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));
CREATE POLICY tenant_deletion_delete ON app.conversation_tags FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT ops.deleting_tenant_id()));

-- Erasing a contact deletes the tags of their conversations, as it deletes the conversations'
-- notes: a tag can say something about the person. Erasure runs as w360_definer in the company's
-- own scope, so these policies reach only the current company's rows.
CREATE POLICY contact_erasure_read ON app.conversation_tags FOR SELECT TO w360_definer
  USING (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY contact_erasure_delete ON app.conversation_tags FOR DELETE TO w360_definer
  USING (tenant_id = (SELECT app.current_tenant_id()));

-- app.erase_contact as 0028 left it, with the conversations' tags deleted after their notes. The
-- function belongs to w360_definer, so that role drops it; the migration role creates the new one
-- and grants before handing it over.
SET ROLE w360_definer;
DROP FUNCTION app.erase_contact(uuid, boolean);
RESET ROLE;
CREATE FUNCTION app.erase_contact(p_contact_id uuid, p_suppress boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_user text := app.current_user_id();
  v_contact record;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  -- Conversations first: every other writer (ingestion, replies, the automation runner) locks the
  -- conversation before its run and before the contact, so erasure takes the same order.
  PERFORM 1 FROM app.conversations cv
    WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id
    ORDER BY cv.id FOR UPDATE;
  SELECT c.id, c.phone_e164, c.email, c.erased_at INTO v_contact
    FROM app.contacts c WHERE c.tenant_id = v_tenant AND c.id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact not found' USING ERRCODE = 'W3404';
  END IF;
  IF v_contact.erased_at IS NOT NULL THEN
    RETURN false;
  END IF;
  IF p_suppress AND v_contact.phone_e164 IS NOT NULL THEN
    INSERT INTO app.suppressions (id, tenant_id, phone_e164, reason, created_by_user_id)
    VALUES (gen_random_uuid(), v_tenant, v_contact.phone_e164, 'erased', v_user)
    ON CONFLICT (tenant_id, phone_e164) DO NOTHING;
  END IF;
  INSERT INTO app.consent_events (id, tenant_id, contact_id, purpose, action, source, actor_type, actor_id, occurred_at)
  SELECT gen_random_uuid(), v_tenant, p_contact_id, p.purpose, 'opt_out', 'erasure',
         CASE WHEN v_user IS NULL THEN 'system' ELSE 'user' END, v_user, now()
    FROM (VALUES ('marketing'), ('utility')) AS p (purpose);

  -- Automation runs: captured answers are cleared and active runs stop (no further bot messages).
  UPDATE app.automation_runs r SET variables = '{}'::jsonb
   WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id;
  UPDATE app.automation_runs r
     SET status = 'stopped', end_reason = 'contact_erased', ended_at = now(), current_node_id = NULL,
         waiting_for = NULL, wait_until = NULL, input_message_id = NULL, next_step_at = NULL
   WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id AND r.status IN ('running', 'waiting');

  -- Automation HTTP calls: values saved from responses are cleared, calls not yet made are
  -- cancelled, and calls in flight become unknown (a call already sent cannot be recalled, and the
  -- result the worker records later is not kept).
  UPDATE app.automation_http_calls h SET saved_values = '{}'::jsonb, request_ciphertext = NULL
   WHERE h.tenant_id = v_tenant
     AND (h.saved_values <> '{}'::jsonb OR h.request_ciphertext IS NOT NULL)
     AND h.run_id IN (SELECT r.id FROM app.automation_runs r
                       WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id);
  UPDATE app.automation_http_calls h
     SET state = 'canceled', error_code = 'contact_erased', finished_at = now()
   WHERE h.tenant_id = v_tenant AND h.state = 'queued'
     AND h.run_id IN (SELECT r.id FROM app.automation_runs r
                       WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id);
  UPDATE app.automation_http_calls h
     SET state = 'unknown', error_code = 'contact_erased', finished_at = now(), lease_until = NULL
   WHERE h.tenant_id = v_tenant AND h.state = 'in_flight'
     AND h.run_id IN (SELECT r.id FROM app.automation_runs r
                       WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id);

  -- Growth: where the contact's conversations came from (ads, links) is about them, so it goes.
  DELETE FROM app.conversation_sources s WHERE s.tenant_id = v_tenant AND s.contact_id = p_contact_id;

  -- Flows: answers the contact gave are deleted, and forms already sent to them stop working (the
  -- data endpoint refuses their tokens).
  DELETE FROM app.flow_responses r WHERE r.tenant_id = v_tenant AND r.contact_id = p_contact_id;
  UPDATE app.flow_sends f SET expires_at = least(f.expires_at, now())
   WHERE f.tenant_id = v_tenant AND f.contact_id = p_contact_id AND f.expires_at > now();

  -- Commerce: orders stay as business records without the customer's note, and payment links of
  -- their orders that are still open are cancelled at Razorpay by the worker (it sees the request).
  UPDATE app.commerce_orders o SET customer_note = NULL
   WHERE o.tenant_id = v_tenant AND o.contact_id = p_contact_id AND o.customer_note IS NOT NULL;
  UPDATE app.commerce_payment_links l SET cancel_requested_at = now(), next_check_at = now()
   WHERE l.tenant_id = v_tenant AND l.cancel_requested_at IS NULL
     AND l.status IN ('creating', 'created', 'partially_paid')
     AND l.order_id IN (SELECT o.id FROM app.commerce_orders o
                         WHERE o.tenant_id = v_tenant AND o.contact_id = p_contact_id);

  -- Store orders: the copies of the contact's orders from the company's stores (matched by phone or
  -- email) lose the customer's details and their tracking for good; later reads from the store keep
  -- them empty, and messages about them that are still waiting are not sent.
  IF v_contact.phone_e164 IS NOT NULL OR v_contact.email IS NOT NULL THEN
    UPDATE app.commerce_store_orders o
       SET customer_name = NULL, customer_phone = NULL, customer_email = NULL, status_url = NULL,
           tracking_number = NULL, tracking_url = NULL, redacted_at = now()
     WHERE o.tenant_id = v_tenant
       AND ((v_contact.phone_e164 IS NOT NULL AND o.customer_phone = v_contact.phone_e164)
         OR (v_contact.email IS NOT NULL AND lower(o.customer_email) = lower(v_contact.email)));
  END IF;

  -- Store checkouts: the copies of checkouts left with the contact's number lose the customer's
  -- details, the recovery address and the consent Shopify recorded, for good; reminders about them
  -- that are still waiting are not sent.
  IF v_contact.phone_e164 IS NOT NULL THEN
    UPDATE app.commerce_store_checkouts k
       SET customer_external_id = NULL, customer_name = NULL, customer_phone = NULL,
           recovery_url = NULL, consent_state = NULL, consent_updated_at = NULL,
           consent_opt_in_level = NULL, consent_collected_from = NULL, redacted_at = now()
     WHERE k.tenant_id = v_tenant AND k.customer_phone = v_contact.phone_e164;
  END IF;

  -- CRM: the timeline (with notes) and tasks go; deals keep what reports need, without free text.
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'on', true);
  DELETE FROM app.crm_activities a WHERE a.tenant_id = v_tenant AND a.contact_id = p_contact_id;
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'off', true);
  DELETE FROM app.crm_tasks t WHERE t.tenant_id = v_tenant AND t.contact_id = p_contact_id;
  UPDATE app.crm_deals d SET title = 'Deal (contact erased)', lost_reason = NULL
   WHERE d.tenant_id = v_tenant AND d.contact_id = p_contact_id;

  UPDATE app.send_intents s
     SET state = 'canceled', lease_until = NULL, resolved_at = now(), last_error_code = 'contact_erased',
         last_error = 'Not sent: the contact was erased.'
   WHERE s.tenant_id = v_tenant AND s.state IN ('queued', 'deferred')
     AND s.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                            ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                           WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  -- The requests of past and cancelled sends carried the number and the text: redacted too.
  UPDATE app.send_intents s SET request = '{"redacted": true}'::jsonb
   WHERE s.tenant_id = v_tenant
     AND s.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                            ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                           WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  UPDATE app.messages m
     SET content = '{"redacted": true}'::jsonb,
         referral = NULL,
         status = CASE WHEN m.status IN ('queued', 'sending') THEN 'canceled' ELSE m.status END,
         status_rank = CASE WHEN m.status IN ('queued', 'sending') THEN 5 ELSE m.status_rank END,
         status_at = CASE WHEN m.status IN ('queued', 'sending') THEN now() ELSE m.status_at END,
         error_title = NULL
   WHERE m.tenant_id = v_tenant
     AND m.conversation_id IN (SELECT cv.id FROM app.conversations cv
                                WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'on', true);
  UPDATE app.message_status_events e
     SET recipient_wa_id = NULL, recipient_bsuid = NULL
   WHERE e.tenant_id = v_tenant AND (e.recipient_wa_id IS NOT NULL OR e.recipient_bsuid IS NOT NULL)
     AND e.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                            ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                           WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  PERFORM pg_catalog.set_config('w360.contact_erasure', 'off', true);
  DELETE FROM app.media_objects mo
   WHERE mo.tenant_id = v_tenant
     AND mo.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                             ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                            WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  DELETE FROM app.conversation_notes n
   WHERE n.tenant_id = v_tenant
     AND n.conversation_id IN (SELECT cv.id FROM app.conversations cv
                                WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  DELETE FROM app.conversation_tags ct
   WHERE ct.tenant_id = v_tenant
     AND ct.conversation_id IN (SELECT cv.id FROM app.conversations cv
                                 WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  UPDATE app.conversations cv SET last_message_preview = NULL
   WHERE cv.tenant_id = v_tenant AND cv.contact_id = p_contact_id;
  DELETE FROM app.contact_identities i WHERE i.tenant_id = v_tenant AND i.contact_id = p_contact_id;
  DELETE FROM app.contact_tags t WHERE t.tenant_id = v_tenant AND t.contact_id = p_contact_id;
  UPDATE app.contacts c
     SET display_name = NULL, phone_e164 = NULL, email = NULL, attributes = '{}'::jsonb, erased_at = now()
   WHERE c.tenant_id = v_tenant AND c.id = p_contact_id;
  RETURN true;
END
$$;

REVOKE EXECUTE ON FUNCTION app.erase_contact(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.erase_contact(uuid, boolean) TO w360_app;
ALTER FUNCTION app.erase_contact(uuid, boolean) OWNER TO w360_definer;
