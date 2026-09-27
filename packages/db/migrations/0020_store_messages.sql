-- 0020_store_messages: WhatsApp messages on store events (P4-06c). When an order in a connected
-- store is placed, paid for on delivery, shipped, delivered or cancelled, HyFib sends the approved
-- template a manager chose for that event (research docs/research/store-connectors.md §3 and
-- docs/research/meta-whatsapp.md §16, ADR-048). Events are found by comparing an order's copy
-- before and after a read from the store; each order gets at most one message per event, and a rule
-- never messages about anything that happened before it was switched on.

-- Order milestones read from the store -------------------------------------------------------------
-- Payment method names as the store gives them (Shopify gateway names, the WooCommerce method
-- title), whether the order is paid on delivery, when it shipped and was delivered, and the latest
-- shipment's tracking. tracked_at is when an order in transit was last read again for delivery.
ALTER TABLE app.commerce_store_orders
  ADD COLUMN payment_names text[] NOT NULL DEFAULT '{}' CHECK (cardinality(payment_names) <= 5
    AND char_length(array_to_string(payment_names, '|')) <= 600),
  ADD COLUMN cash_on_delivery boolean NOT NULL DEFAULT false,
  ADD COLUMN shipped_at timestamptz,
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN tracking_company text CHECK (char_length(tracking_company) <= 100),
  ADD COLUMN tracking_number text CHECK (char_length(tracking_number) <= 100),
  ADD COLUMN tracking_url text CHECK (char_length(tracking_url) <= 1000 AND tracking_url ~ '^https://'),
  ADD COLUMN tracked_at timestamptz,
  -- A tracking number (and its link) can show a stranger where a parcel goes, so it goes with the
  -- customer's details when an order is redacted.
  ADD CONSTRAINT commerce_store_orders_redacted_tracking CHECK (redacted_at IS NULL
    OR (tracking_number IS NULL AND tracking_url IS NULL));
-- Orders shipped but not yet delivered (read again for delivery while a delivered rule is on).
CREATE INDEX commerce_store_orders_transit_idx
  ON app.commerce_store_orders (tenant_id, store_id, tracked_at NULLS FIRST)
  WHERE shipped_at IS NOT NULL AND delivered_at IS NULL AND cancelled_at IS NULL
    AND deleted_at IS NULL;

-- Store message settings ---------------------------------------------------------------------------
-- messages_opt_in_*: the manager who confirmed that the store's customers agreed to receive order
-- messages on WhatsApp (Meta requires opt-in before business-initiated messages, research M-175;
-- HyFib cannot see the store's checkout). No rule can be switched on without it.
-- send_window_*: minutes after midnight in the company's time zone between which messages may be
-- sent (an end before the start wraps past midnight); both empty means any time.
ALTER TABLE app.commerce_stores
  ADD COLUMN messages_opt_in_at timestamptz,
  ADD COLUMN messages_opt_in_membership_id uuid,
  ADD COLUMN send_window_start smallint CHECK (send_window_start BETWEEN 0 AND 1439),
  ADD COLUMN send_window_end smallint CHECK (send_window_end BETWEEN 0 AND 1439),
  ADD COLUMN message_test_orders boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT commerce_stores_opt_in_shape CHECK (
    (messages_opt_in_at IS NULL) = (messages_opt_in_membership_id IS NULL)),
  ADD CONSTRAINT commerce_stores_send_window CHECK (
    (send_window_start IS NULL) = (send_window_end IS NULL)
    AND (send_window_start IS NULL OR send_window_start <> send_window_end)),
  ADD CONSTRAINT commerce_stores_opt_in_member_fk FOREIGN KEY (tenant_id, messages_opt_in_membership_id)
    REFERENCES app.memberships (tenant_id, id);

-- Rules: one per store and event -------------------------------------------------------------------
CREATE TABLE app.commerce_store_message_rules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN
    ('order_placed', 'cod_confirmation', 'order_shipped', 'order_delivered', 'order_cancelled')),
  enabled boolean NOT NULL DEFAULT false,
  -- When the rule was last switched on: events that happened earlier send nothing.
  enabled_at timestamptz,
  channel_account_id uuid,
  template_id uuid,
  -- How each template variable is filled (validated by the service: fixed text or an order field,
  -- with an optional fallback).
  variables jsonb NOT NULL DEFAULT '{"header": [], "body": []}'::jsonb
    CHECK (jsonb_typeof(variables) = 'object' AND pg_column_size(variables) <= 16384),
  delay_minutes integer NOT NULL DEFAULT 0 CHECK (delay_minutes BETWEEN 0 AND 1440),
  -- Cash on delivery: which of the template's buttons (zero-based position) confirms the order and
  -- which cancels it.
  confirm_button smallint CHECK (confirm_button BETWEEN 0 AND 9),
  cancel_button smallint CHECK (cancel_button BETWEEN 0 AND 9),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_store_message_rules_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_store_message_rules_event_uq UNIQUE (tenant_id, store_id, event),
  CONSTRAINT commerce_store_message_rules_enabled CHECK (NOT enabled
    OR (enabled_at IS NOT NULL AND channel_account_id IS NOT NULL AND template_id IS NOT NULL)),
  CONSTRAINT commerce_store_message_rules_buttons CHECK (
    (event = 'cod_confirmation' OR (confirm_button IS NULL AND cancel_button IS NULL))
    AND (confirm_button IS NULL OR cancel_button IS NULL OR confirm_button <> cancel_button)
    AND (NOT enabled OR event <> 'cod_confirmation'
      OR (confirm_button IS NOT NULL AND cancel_button IS NOT NULL))),
  CONSTRAINT commerce_store_message_rules_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES app.commerce_stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT commerce_store_message_rules_channel_fk FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES app.channel_accounts (tenant_id, id),
  CONSTRAINT commerce_store_message_rules_template_fk FOREIGN KEY (tenant_id, template_id)
    REFERENCES app.message_templates (tenant_id, id),
  CONSTRAINT commerce_store_message_rules_member_fk FOREIGN KEY (tenant_id, updated_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE TRIGGER commerce_store_message_rules_touch BEFORE UPDATE ON app.commerce_store_message_rules
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Store messages: at most one per order and event ------------------------------------------------
-- pending: waiting for send_at (the rule's delay and the sending window); queued: the chat message
-- was created and handed to the send pipeline (its delivery status lives on the message); skipped:
-- not sent, with the reason. occurred_at is when the event happened at the store, or when HyFib
-- first saw it where the store gives no time.
CREATE TABLE app.commerce_store_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN
    ('order_placed', 'cod_confirmation', 'order_shipped', 'order_delivered', 'order_cancelled')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued', 'skipped')),
  skip_reason text CHECK (skip_reason ~ '^[a-z_]{1,40}$'),
  occurred_at timestamptz NOT NULL,
  send_at timestamptz NOT NULL,
  contact_id uuid,
  message_id uuid,
  -- Cash on delivery: the customer's latest answer from the message's buttons.
  answer text CHECK (answer IN ('confirmed', 'cancelled')),
  answered_at timestamptz,
  answer_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_store_messages_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_store_messages_order_event_uq UNIQUE (tenant_id, order_id, event),
  CONSTRAINT commerce_store_messages_state_shape CHECK (
    (state = 'skipped') = (skip_reason IS NOT NULL)
    AND (state = 'queued') = (message_id IS NOT NULL)
    AND (state <> 'queued' OR contact_id IS NOT NULL)),
  CONSTRAINT commerce_store_messages_answer_shape CHECK (
    (answer IS NULL) = (answered_at IS NULL) AND (answer IS NULL) = (answer_message_id IS NULL)
    AND (answer IS NULL OR (event = 'cod_confirmation' AND state = 'queued'))),
  CONSTRAINT commerce_store_messages_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES app.commerce_stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT commerce_store_messages_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES app.commerce_store_orders (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT commerce_store_messages_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES app.contacts (tenant_id, id),
  CONSTRAINT commerce_store_messages_message_fk FOREIGN KEY (tenant_id, message_id)
    REFERENCES app.messages (tenant_id, id),
  CONSTRAINT commerce_store_messages_answer_fk FOREIGN KEY (tenant_id, answer_message_id)
    REFERENCES app.messages (tenant_id, id)
);
CREATE INDEX commerce_store_messages_due_idx ON app.commerce_store_messages (send_at)
  WHERE state = 'pending';
CREATE INDEX commerce_store_messages_store_idx
  ON app.commerce_store_messages (tenant_id, store_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX commerce_store_messages_message_uq ON app.commerce_store_messages (tenant_id, message_id)
  WHERE message_id IS NOT NULL;
CREATE TRIGGER commerce_store_messages_touch BEFORE UPDATE ON app.commerce_store_messages
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Contacts created for a store's customers when HyFib first messages them.
ALTER TABLE app.contacts DROP CONSTRAINT contacts_source_check;
ALTER TABLE app.contacts ADD CONSTRAINT contacts_source_check
  CHECK (source IN ('whatsapp', 'manual', 'import', 'api', 'store'));

-- Lookup without company context --------------------------------------------------------------------
-- The minute sweep (active companies only): store messages whose send time has come.
CREATE FUNCTION ops.commerce_store_messages_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, message_id uuid, send_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT m.tenant_id, m.id, m.send_at
    FROM app.commerce_store_messages m
    JOIN app.tenants t ON t.id = m.tenant_id AND t.status = 'active'
   WHERE m.state = 'pending' AND m.send_at <= now()
   ORDER BY m.send_at
   LIMIT p_limit
$$;

CREATE POLICY definer_read ON app.commerce_store_messages FOR SELECT TO w360_definer USING (true);
GRANT SELECT (tenant_id, id, state, send_at) ON app.commerce_store_messages TO w360_definer;
-- Erasure also clears the tracking of the contact's store orders.
GRANT UPDATE (tracking_number, tracking_url) ON app.commerce_store_orders TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.commerce_store_messages_due(integer) TO w360_app;
ALTER FUNCTION ops.commerce_store_messages_due(integer) OWNER TO w360_definer;

-- Contact erasure: same body as 0019, with the store orders' tracking cleared too (see the note on
-- replacing definer functions in 0011).
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

GRANT EXECUTE ON FUNCTION app.erase_contact(uuid, boolean) TO w360_app;
ALTER FUNCTION app.erase_contact(uuid, boolean) OWNER TO w360_definer;

-- Company isolation and privileges ------------------------------------------------------------------
SELECT ops.apply_tenant_rls('app.commerce_store_message_rules');
SELECT ops.apply_tenant_rls('app.commerce_store_messages');

GRANT UPDATE (payment_names, cash_on_delivery, shipped_at, delivered_at, tracking_company,
  tracking_number, tracking_url, tracked_at) ON app.commerce_store_orders TO w360_app;
GRANT UPDATE (messages_opt_in_at, messages_opt_in_membership_id, send_window_start, send_window_end,
  message_test_orders) ON app.commerce_stores TO w360_app;
GRANT SELECT, INSERT ON app.commerce_store_message_rules TO w360_app;
GRANT UPDATE (enabled, enabled_at, channel_account_id, template_id, variables, delay_minutes,
  confirm_button, cancel_button, version, updated_by_membership_id, updated_at)
  ON app.commerce_store_message_rules TO w360_app;
GRANT SELECT, INSERT ON app.commerce_store_messages TO w360_app;
GRANT UPDATE (state, skip_reason, send_at, contact_id, message_id, answer, answered_at,
  answer_message_id, updated_at) ON app.commerce_store_messages TO w360_app;
