-- 0021_cart_reminders: reminders about checkouts customers left in a connected Shopify store
-- (P4-06d, ADR-049, research docs/research/store-connectors.md §4). HyFib reads a store's checkouts
-- on a schedule while a cart reminder is on and sends the approved marketing templates a manager
-- chose, at most once per checkout and reminder, to customers with marketing opt-in. A store can
-- let HyFib read its customers (read_customers, asked for only then) and use the WhatsApp marketing
-- consent Shopify records for them.

-- Stores ---------------------------------------------------------------------------------------------
-- checkouts_*: the checkout read: the update time the next read starts from, Shopify's page cursor
-- while a read continues on the next run, when the next read is due (null while no cart reminder is
-- on) and why the last read failed.
-- customer_access_requested_at: a manager asked for read_customers; authorizations of this store
-- ask for it from then on.
-- access_code_ciphertext: an authorization code for more access on a connected store, sealed like
-- the store's credentials and bound to the row. The worker exchanges it and keeps the old token when
-- Shopify refuses; access_error says why the last request failed.
-- store_consent_*: the manager who chose to use the WhatsApp marketing consent Shopify records.
ALTER TABLE app.commerce_stores
  ADD COLUMN checkouts_cursor timestamptz,
  ADD COLUMN checkouts_page text CHECK (char_length(checkouts_page) <= 1000),
  ADD COLUMN checkouts_read_at timestamptz,
  ADD COLUMN checkouts_error text CHECK (char_length(checkouts_error) <= 500),
  ADD COLUMN customer_access_requested_at timestamptz,
  ADD COLUMN access_code_ciphertext text CHECK (char_length(access_code_ciphertext) <= 8000),
  ADD COLUMN access_error text CHECK (char_length(access_error) <= 500),
  ADD COLUMN store_consent_at timestamptz,
  ADD COLUMN store_consent_membership_id uuid,
  ADD CONSTRAINT commerce_stores_store_consent_shape CHECK (
    (store_consent_at IS NULL) = (store_consent_membership_id IS NULL)),
  ADD CONSTRAINT commerce_stores_store_consent_member_fk FOREIGN KEY (tenant_id, store_consent_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  -- Checkouts and customer access exist only for Shopify stores.
  ADD CONSTRAINT commerce_stores_checkouts_shopify CHECK (platform = 'shopify'
    OR (checkouts_read_at IS NULL AND checkouts_page IS NULL AND customer_access_requested_at IS NULL
      AND access_code_ciphertext IS NULL AND store_consent_at IS NULL));

-- Checkouts ------------------------------------------------------------------------------------------
-- A copy of the checkouts HyFib read (SH-039): the number (the customer's default phone when the
-- store allowed customer access, else the shipping or billing phone), the name, the total in minor
-- units, up to ten items, the address that recovers the checkout and when it was completed. The
-- consent_* columns are the WhatsApp marketing consent Shopify records for that number (SH-041),
-- when it was read. A redacted checkout keeps no customer details, for good. Copies are deleted 30
-- days after their last update.
CREATE TABLE app.commerce_store_checkouts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  external_id text NOT NULL CHECK (external_id ~ '^[0-9]{1,20}$'),
  name text CHECK (char_length(name) <= 100),
  remote_created_at timestamptz NOT NULL,
  remote_updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  customer_external_id text CHECK (customer_external_id ~ '^[0-9]{1,20}$'),
  customer_name text CHECK (char_length(customer_name) <= 200),
  customer_phone text CHECK (customer_phone ~ '^\+[1-9][0-9]{6,14}$'),
  consent_state text CHECK (consent_state IN
    ('NEVER_SUBSCRIBED', 'PENDING', 'REDACTED', 'SUBSCRIBED', 'UNSUBSCRIBED')),
  consent_updated_at timestamptz,
  consent_opt_in_level text CHECK (consent_opt_in_level IN
    ('SINGLE_OPT_IN', 'CONFIRMED_OPT_IN', 'UNKNOWN')),
  consent_collected_from text CHECK (consent_collected_from IN ('SHOPIFY', 'OTHER')),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint CHECK (total_minor BETWEEN 0 AND 50000000000000),
  items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'
    AND jsonb_array_length(items) <= 10 AND pg_column_size(items) <= 8192),
  item_count integer CHECK (item_count BETWEEN 0 AND 1000000),
  recovery_url text CHECK (char_length(recovery_url) <= 2000 AND recovery_url ~ '^https://'),
  redacted_at timestamptz,
  read_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_store_checkouts_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_store_checkouts_external_uq UNIQUE (tenant_id, store_id, external_id),
  CONSTRAINT commerce_store_checkouts_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES app.commerce_stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT commerce_store_checkouts_total_shape CHECK (total_minor IS NULL OR currency IS NOT NULL),
  CONSTRAINT commerce_store_checkouts_consent_shape CHECK (consent_state IS NULL
    OR customer_phone IS NOT NULL),
  CONSTRAINT commerce_store_checkouts_redacted CHECK (redacted_at IS NULL
    OR (customer_external_id IS NULL AND customer_name IS NULL AND customer_phone IS NULL
      AND recovery_url IS NULL AND consent_state IS NULL AND consent_updated_at IS NULL
      AND consent_opt_in_level IS NULL AND consent_collected_from IS NULL))
);
CREATE INDEX commerce_store_checkouts_updated_idx
  ON app.commerce_store_checkouts (tenant_id, store_id, remote_updated_at);
CREATE INDEX commerce_store_checkouts_phone_idx ON app.commerce_store_checkouts (tenant_id, customer_phone)
  WHERE customer_phone IS NOT NULL;
CREATE TRIGGER commerce_store_checkouts_touch BEFORE UPDATE ON app.commerce_store_checkouts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Cart reminders as store messages ---------------------------------------------------------------------
-- A store message is about an order or, for the two cart reminders, about a checkout; still at most
-- one per subject and event.
ALTER TABLE app.commerce_store_messages
  ALTER COLUMN order_id DROP NOT NULL,
  ADD COLUMN checkout_id uuid,
  DROP CONSTRAINT commerce_store_messages_event_check,
  ADD CONSTRAINT commerce_store_messages_event_check CHECK (event IN ('order_placed',
    'cod_confirmation', 'order_shipped', 'order_delivered', 'order_cancelled', 'cart_reminder',
    'cart_second_reminder')),
  ADD CONSTRAINT commerce_store_messages_subject CHECK (
    (order_id IS NULL) <> (checkout_id IS NULL)
    AND (checkout_id IS NOT NULL) = (event IN ('cart_reminder', 'cart_second_reminder'))),
  ADD CONSTRAINT commerce_store_messages_checkout_event_uq UNIQUE (tenant_id, checkout_id, event),
  ADD CONSTRAINT commerce_store_messages_checkout_fk FOREIGN KEY (tenant_id, checkout_id)
    REFERENCES app.commerce_store_checkouts (tenant_id, id) ON DELETE CASCADE;

-- Cart reminder rules: the first 30 minutes to 24 hours after the checkout was left, the second one
-- hour to three days (the service keeps the second later than the first).
ALTER TABLE app.commerce_store_message_rules
  DROP CONSTRAINT commerce_store_message_rules_event_check,
  ADD CONSTRAINT commerce_store_message_rules_event_check CHECK (event IN ('order_placed',
    'cod_confirmation', 'order_shipped', 'order_delivered', 'order_cancelled', 'cart_reminder',
    'cart_second_reminder')),
  DROP CONSTRAINT commerce_store_message_rules_delay_minutes_check,
  ADD CONSTRAINT commerce_store_message_rules_delay_minutes_check CHECK (CASE event
    WHEN 'cart_reminder' THEN delay_minutes BETWEEN 30 AND 1440
    WHEN 'cart_second_reminder' THEN delay_minutes BETWEEN 60 AND 4320
    ELSE delay_minutes BETWEEN 0 AND 1440 END);

-- Consent a store records ------------------------------------------------------------------------------
-- Consent events from a store carry Shopify's update time; the same state read twice is one event.
ALTER TABLE app.consent_events DROP CONSTRAINT consent_events_source_check;
ALTER TABLE app.consent_events ADD CONSTRAINT consent_events_source_check
  CHECK (source IN ('keyword', 'agent', 'import', 'provider', 'api', 'erasure', 'store'));
CREATE UNIQUE INDEX consent_events_store_uq
  ON app.consent_events (tenant_id, contact_id, purpose, action, occurred_at) WHERE source = 'store';

-- Lookups without company context ------------------------------------------------------------------------
-- Same as 0019, and a connected Shopify store with a waiting handshake for more access is found too
-- (see the note on replacing definer functions in 0011).
SET ROLE w360_definer;
DROP FUNCTION ops.commerce_store_by_connect(text);
DROP FUNCTION ops.commerce_store_work_due(integer);
RESET ROLE;
CREATE FUNCTION ops.commerce_store_by_connect(p_token_hash text)
  RETURNS TABLE (tenant_id uuid, tenant_slug text, store_id uuid, platform text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, t.slug, s.id, s.platform
    FROM app.commerce_stores s
    JOIN app.tenants t ON t.id = s.tenant_id
   WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND s.connect_token_hash = p_token_hash
     AND (s.state = 'authorizing' OR (s.state = 'connected' AND s.platform = 'shopify'))
     AND s.connect_expires_at > now()
     AND t.status = 'active'
$$;

-- Same as 0019, and connected stores whose checkout read is due.
CREATE FUNCTION ops.commerce_store_work_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, store_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, s.id
    FROM app.commerce_stores s
    JOIN app.tenants t ON t.id = s.tenant_id AND t.status = 'active'
   WHERE (s.lease_until IS NULL OR s.lease_until < now())
     AND (s.state IN ('connecting', 'removing')
       OR (s.state = 'authorizing' AND s.connect_expires_at < now() - interval '1 hour')
       OR (s.state = 'connected' AND (s.next_sync_at <= now() OR s.checkouts_read_at <= now()
         OR s.webhooks_checked_at IS NULL OR s.webhooks_checked_at < now() - interval '6 hours'
         OR s.access_expires_at < now() + interval '10 minutes'
         OR EXISTS (SELECT 1 FROM app.commerce_store_fetches f
                     WHERE f.tenant_id = s.tenant_id AND f.store_id = s.id))))
   ORDER BY s.next_sync_at NULLS FIRST
   LIMIT p_limit
$$;

GRANT SELECT (checkouts_read_at) ON app.commerce_stores TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.commerce_store_by_connect(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.commerce_store_work_due(integer) TO w360_app;
ALTER FUNCTION ops.commerce_store_by_connect(text) OWNER TO w360_definer;
ALTER FUNCTION ops.commerce_store_work_due(integer) OWNER TO w360_definer;

-- Contact erasure: same body as 0020, with the contact's store checkouts redacted too (see the note on
-- replacing definer functions in 0011).
CREATE POLICY definer_access ON app.commerce_store_checkouts TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, customer_phone),
  UPDATE (customer_external_id, customer_name, customer_phone, recovery_url, consent_state,
    consent_updated_at, consent_opt_in_level, consent_collected_from, redacted_at)
  ON app.commerce_store_checkouts TO w360_definer;
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

-- Company isolation and privileges ---------------------------------------------------------------------
SELECT ops.apply_tenant_rls('app.commerce_store_checkouts');

GRANT UPDATE (checkouts_cursor, checkouts_page, checkouts_read_at, checkouts_error,
  customer_access_requested_at,
  access_code_ciphertext, access_error, store_consent_at, store_consent_membership_id)
  ON app.commerce_stores TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.commerce_store_checkouts TO w360_app;
GRANT UPDATE (name, remote_created_at, remote_updated_at, completed_at, customer_external_id,
  customer_name, customer_phone, consent_state, consent_updated_at, consent_opt_in_level,
  consent_collected_from, currency, total_minor, items, item_count, recovery_url, redacted_at, read_at,
  updated_at)
  ON app.commerce_store_checkouts TO w360_app;
-- A pending cart reminder moves when the customer comes back to the checkout.
GRANT UPDATE (occurred_at) ON app.commerce_store_messages TO w360_app;
