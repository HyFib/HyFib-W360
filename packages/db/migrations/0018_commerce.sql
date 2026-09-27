-- 0018_commerce: commerce on WhatsApp (P4-06). Companies read the catalogs connected to their
-- WhatsApp accounts from Meta, send products in chats, receive the orders customers place in
-- WhatsApp (research M-169 to M-172), and ask for payment with Payment Links created in the
-- company's own Razorpay account (research R-016, R-106 to R-109). Money is integer minor units.
-- A payment is recorded only from the link as fetched from Razorpay with the company's keys; HyFib
-- never holds or credits the money, which goes straight to the company's Razorpay account.

-- Catalog reads ------------------------------------------------------------------------------------
-- The written-ahead request to read a WhatsApp account's catalogs and products from Meta (the worker
-- performs it; reads only, nothing is changed at Meta).
CREATE TABLE app.commerce_syncs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  whatsapp_account_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'queued', 'running', 'failed')),
  error text CHECK (char_length(error) <= 1000),
  requested_at timestamptz,
  finished_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_syncs_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_syncs_account_uq UNIQUE (tenant_id, whatsapp_account_id),
  CONSTRAINT commerce_syncs_account_fk FOREIGN KEY (tenant_id, whatsapp_account_id)
    REFERENCES app.whatsapp_accounts (tenant_id, id)
);
CREATE INDEX commerce_syncs_due_idx ON app.commerce_syncs (requested_at)
  WHERE state IN ('queued', 'running');
CREATE TRIGGER commerce_syncs_touch BEFORE UPDATE ON app.commerce_syncs
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Catalogs connected to a WhatsApp account at Meta (its product_catalogs edge, M-172).
CREATE TABLE app.commerce_catalogs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  whatsapp_account_id uuid NOT NULL,
  meta_catalog_id text NOT NULL CHECK (meta_catalog_id ~ '^[0-9]{1,32}$'),
  name text CHECK (char_length(name) <= 200),
  product_count integer CHECK (product_count >= 0),
  -- More products than HyFib reads (the rest are not listed; product messages still work at Meta).
  truncated boolean NOT NULL DEFAULT false,
  disconnected_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_catalogs_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_catalogs_meta_uq UNIQUE (tenant_id, whatsapp_account_id, meta_catalog_id),
  CONSTRAINT commerce_catalogs_account_fk FOREIGN KEY (tenant_id, whatsapp_account_id)
    REFERENCES app.whatsapp_accounts (tenant_id, id)
);
CREATE TRIGGER commerce_catalogs_touch BEFORE UPDATE ON app.commerce_catalogs
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Products as last read from Meta: what members need to pick them for a message. Prices stay Meta's
-- display text (its format is not documented, M-172); order amounts come from the order itself.
CREATE TABLE app.commerce_products (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  catalog_id uuid NOT NULL,
  retailer_id text NOT NULL CHECK (char_length(retailer_id) BETWEEN 1 AND 100),
  meta_product_id text CHECK (meta_product_id ~ '^[0-9]{1,32}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description text CHECK (char_length(description) <= 1000),
  price_text text CHECK (char_length(price_text) <= 64),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  availability text CHECK (char_length(availability) <= 40),
  review_status text CHECK (char_length(review_status) <= 40),
  removed_at timestamptz,
  synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_products_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_products_retailer_uq UNIQUE (tenant_id, catalog_id, retailer_id),
  CONSTRAINT commerce_products_catalog_fk FOREIGN KEY (tenant_id, catalog_id)
    REFERENCES app.commerce_catalogs (tenant_id, id)
);
CREATE INDEX commerce_products_list_idx ON app.commerce_products (tenant_id, catalog_id, name)
  WHERE removed_at IS NULL;
CREATE TRIGGER commerce_products_touch BEFORE UPDATE ON app.commerce_products
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Orders ---------------------------------------------------------------------------------------------
-- A cart a customer sent in WhatsApp (an inbound message of type order, M-170). Unit prices arrive
-- in major units and are stored in the currency's minor units; the subtotal is null when it cannot
-- be computed (an unreadable price or items in different currencies).
CREATE TABLE app.commerce_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  -- A short reference members and customers can quote ("Order K7M2QX9P").
  reference text NOT NULL CHECK (reference ~ '^[A-HJ-NP-Z2-9]{8}$'),
  conversation_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  message_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  meta_catalog_id text NOT NULL CHECK (meta_catalog_id ~ '^[0-9]{1,32}$'),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint CHECK (subtotal_minor >= 0),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 100),
  customer_note text CHECK (char_length(customer_note) <= 1000),
  status text NOT NULL DEFAULT 'received' CHECK (status IN
    ('received', 'confirmed', 'awaiting_payment', 'paid', 'fulfilled', 'cancelled')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  received_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_orders_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_orders_message_uq UNIQUE (tenant_id, message_id),
  CONSTRAINT commerce_orders_reference_uq UNIQUE (tenant_id, reference),
  CONSTRAINT commerce_orders_total CHECK (subtotal_minor IS NULL OR currency IS NOT NULL),
  CONSTRAINT commerce_orders_paid CHECK (paid_at IS NULL OR status IN ('paid', 'fulfilled', 'cancelled')),
  CONSTRAINT commerce_orders_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES app.conversations (tenant_id, id),
  CONSTRAINT commerce_orders_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES app.contacts (tenant_id, id),
  CONSTRAINT commerce_orders_message_fk FOREIGN KEY (tenant_id, message_id)
    REFERENCES app.messages (tenant_id, id),
  CONSTRAINT commerce_orders_channel_fk FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES app.channel_accounts (tenant_id, id)
);
CREATE INDEX commerce_orders_list_idx ON app.commerce_orders (tenant_id, received_at DESC, id DESC);
CREATE INDEX commerce_orders_status_idx ON app.commerce_orders (tenant_id, status, received_at DESC);
CREATE INDEX commerce_orders_conversation_idx ON app.commerce_orders (tenant_id, conversation_id);
CREATE INDEX commerce_orders_contact_idx ON app.commerce_orders (tenant_id, contact_id);
CREATE TRIGGER commerce_orders_touch BEFORE UPDATE ON app.commerce_orders
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.commerce_order_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 100),
  retailer_id text NOT NULL CHECK (char_length(retailer_id) BETWEEN 1 AND 100),
  -- The product as read from the catalog when the order arrived (null when HyFib did not know it).
  product_id uuid,
  name text CHECK (char_length(name) <= 200),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  unit_price_minor bigint CHECK (unit_price_minor >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT commerce_order_items_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_order_items_position_uq UNIQUE (tenant_id, order_id, position),
  CONSTRAINT commerce_order_items_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES app.commerce_orders (tenant_id, id),
  CONSTRAINT commerce_order_items_product_fk FOREIGN KEY (tenant_id, product_id)
    REFERENCES app.commerce_products (tenant_id, id)
);

-- Payments -------------------------------------------------------------------------------------------
-- The company's own Razorpay account, used only to create and read Payment Links for its orders.
-- The key secret and the webhook secret are keyring ciphertexts bound to the row; the webhook
-- address carries a random public id (/api/webhooks/razorpay-links/<public id>).
CREATE TABLE app.commerce_payment_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  provider text NOT NULL DEFAULT 'razorpay' CHECK (provider = 'razorpay'),
  key_id text NOT NULL CHECK (key_id ~ '^rzp_(test|live)_[A-Za-z0-9]{8,32}$'),
  key_secret_ciphertext text NOT NULL CHECK (char_length(key_secret_ciphertext) <= 2000),
  webhook_secret_ciphertext text NOT NULL CHECK (char_length(webhook_secret_ciphertext) <= 2000),
  webhook_public_id text NOT NULL CHECK (webhook_public_id ~ '^[a-z2-7]{16}$'),
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'checking', 'verified', 'failed')),
  status_error text CHECK (char_length(status_error) <= 500),
  checked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_payment_accounts_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_payment_accounts_tenant_uq UNIQUE (tenant_id),
  CONSTRAINT commerce_payment_accounts_webhook_uq UNIQUE (webhook_public_id),
  CONSTRAINT commerce_payment_accounts_member_fk FOREIGN KEY (tenant_id, updated_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE TRIGGER commerce_payment_accounts_touch BEFORE UPDATE ON app.commerce_payment_accounts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- A Payment Link for an order's subtotal, written ahead and created once by the worker: the
-- reference is sent as Razorpay's single-use reference_id (R-106), so a lost response is found
-- again by it (R-107) instead of creating a second link. Status comes only from the link as
-- fetched from Razorpay; webhooks only say when to fetch it.
CREATE TABLE app.commerce_payment_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  reference text NOT NULL CHECK (reference ~ '^w360_[a-z2-7]{20}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 100 AND 50000000000),
  currency text NOT NULL CHECK (currency = 'INR'),
  status text NOT NULL DEFAULT 'creating' CHECK (status IN
    ('creating', 'created', 'partially_paid', 'paid', 'expired', 'cancelled', 'failed')),
  provider_link_id text CHECK (provider_link_id ~ '^plink_[A-Za-z0-9]{6,32}$'),
  short_url text CHECK (char_length(short_url) <= 300 AND short_url ~ '^https://'),
  amount_paid_minor bigint NOT NULL DEFAULT 0 CHECK (amount_paid_minor >= 0),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz,
  cancel_requested_at timestamptz,
  error text CHECK (char_length(error) <= 500),
  message_id uuid,
  next_check_at timestamptz,
  checked_at timestamptz,
  paid_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_payment_links_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_payment_links_reference_uq UNIQUE (reference),
  CONSTRAINT commerce_payment_links_provider_uq UNIQUE (tenant_id, provider_link_id),
  CONSTRAINT commerce_payment_links_created CHECK (status IN ('creating', 'failed') OR provider_link_id IS NOT NULL),
  CONSTRAINT commerce_payment_links_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES app.commerce_orders (tenant_id, id),
  CONSTRAINT commerce_payment_links_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES app.conversations (tenant_id, id),
  CONSTRAINT commerce_payment_links_message_fk FOREIGN KEY (tenant_id, message_id)
    REFERENCES app.messages (tenant_id, id),
  CONSTRAINT commerce_payment_links_member_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
-- One open link per order at a time.
CREATE UNIQUE INDEX commerce_payment_links_open_uq ON app.commerce_payment_links (tenant_id, order_id)
  WHERE status IN ('creating', 'created', 'partially_paid');
CREATE INDEX commerce_payment_links_due_idx ON app.commerce_payment_links (next_check_at)
  WHERE status IN ('creating', 'created', 'partially_paid');
CREATE INDEX commerce_payment_links_order_idx ON app.commerce_payment_links (tenant_id, order_id, created_at DESC);
CREATE TRIGGER commerce_payment_links_touch BEFORE UPDATE ON app.commerce_payment_links
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Razorpay webhook deliveries already seen (x-razorpay-event-id), so a redelivery does nothing twice.
-- Only the event name and link id are kept; the body (customer and payment details) is not stored.
CREATE TABLE app.commerce_payment_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  event_id text NOT NULL CHECK (event_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  event text NOT NULL CHECK (char_length(event) <= 64),
  provider_link_id text CHECK (char_length(provider_link_id) <= 64),
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_payment_events_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_payment_events_event_uq UNIQUE (tenant_id, event_id)
);
CREATE INDEX commerce_payment_events_time_idx ON app.commerce_payment_events (received_at);

-- Lookups without company context -------------------------------------------------------------------
-- The merchant webhook route: which company a webhook address belongs to. The request's signature is
-- then checked with that company's webhook secret before anything else happens.
CREATE FUNCTION ops.commerce_payment_webhook_target(p_public_id text)
  RETURNS TABLE (tenant_id uuid, account_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT a.tenant_id, a.id
    FROM app.commerce_payment_accounts a
    JOIN app.tenants t ON t.id = a.tenant_id
   WHERE p_public_id ~ '^[a-z2-7]{16}$' AND a.webhook_public_id = p_public_id
     AND t.status IN ('active', 'suspended')
$$;

-- The minute sweep (active companies only): catalog reads whose job was lost (the worker fails those
-- older than 30 minutes) or that are a day old; payment links to create, check or cancel.
CREATE FUNCTION ops.commerce_work_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, kind text, ref uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  (SELECT s.tenant_id, 'sync'::text, s.whatsapp_account_id
     FROM app.commerce_syncs s JOIN app.tenants t ON t.id = s.tenant_id AND t.status = 'active'
    WHERE (s.state IN ('queued', 'running') AND s.requested_at < now() - interval '5 minutes')
       OR (s.state = 'idle' AND s.finished_at < now() - interval '24 hours')
    ORDER BY s.requested_at NULLS FIRST
    LIMIT p_limit)
  UNION ALL
  (SELECT l.tenant_id, 'link'::text, l.id
     FROM app.commerce_payment_links l JOIN app.tenants t ON t.id = l.tenant_id AND t.status = 'active'
    WHERE l.status IN ('creating', 'created', 'partially_paid') AND l.next_check_at <= now()
      AND (l.lease_until IS NULL OR l.lease_until < now())
    ORDER BY l.next_check_at
    LIMIT p_limit)
$$;

CREATE POLICY definer_read ON app.commerce_syncs FOR SELECT TO w360_definer USING (true);
CREATE POLICY definer_read ON app.commerce_payment_accounts FOR SELECT TO w360_definer USING (true);
CREATE POLICY definer_access ON app.commerce_orders TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_access ON app.commerce_payment_links TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, whatsapp_account_id, state, requested_at, finished_at) ON app.commerce_syncs
  TO w360_definer;
GRANT SELECT (tenant_id, id, webhook_public_id) ON app.commerce_payment_accounts TO w360_definer;
GRANT SELECT (tenant_id, id, contact_id, customer_note), UPDATE (customer_note) ON app.commerce_orders
  TO w360_definer;
GRANT SELECT (tenant_id, id, order_id, status, lease_until, cancel_requested_at, next_check_at),
  UPDATE (cancel_requested_at, next_check_at) ON app.commerce_payment_links TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.commerce_payment_webhook_target(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.commerce_work_due(integer) TO w360_app;
ALTER FUNCTION ops.commerce_payment_webhook_target(text) OWNER TO w360_definer;
ALTER FUNCTION ops.commerce_work_due(integer) OWNER TO w360_definer;

-- Contact erasure: same body as 0017 plus the commerce statements (see the note on replacing
-- definer functions in 0011).
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
  SELECT c.id, c.phone_e164, c.erased_at INTO v_contact
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

-- Row level security and privileges ----------------------------------------------------------------
SELECT ops.apply_tenant_rls('app.commerce_syncs');
SELECT ops.apply_tenant_rls('app.commerce_catalogs');
SELECT ops.apply_tenant_rls('app.commerce_products');
SELECT ops.apply_tenant_rls('app.commerce_orders');
SELECT ops.apply_tenant_rls('app.commerce_order_items');
SELECT ops.apply_tenant_rls('app.commerce_payment_accounts');
SELECT ops.apply_tenant_rls('app.commerce_payment_links');
SELECT ops.apply_tenant_rls('app.commerce_payment_events');

GRANT SELECT, INSERT ON app.commerce_syncs TO w360_app;
GRANT UPDATE (state, error, requested_at, finished_at, version, updated_at) ON app.commerce_syncs
  TO w360_app;
GRANT SELECT, INSERT ON app.commerce_catalogs TO w360_app;
GRANT UPDATE (name, product_count, truncated, disconnected_at, synced_at, updated_at)
  ON app.commerce_catalogs TO w360_app;
GRANT SELECT, INSERT ON app.commerce_products TO w360_app;
GRANT UPDATE (meta_product_id, name, description, price_text, currency, availability, review_status,
  removed_at, synced_at, updated_at) ON app.commerce_products TO w360_app;
GRANT SELECT, INSERT ON app.commerce_orders TO w360_app;
GRANT UPDATE (status, status_changed_at, paid_at, version, updated_at) ON app.commerce_orders TO w360_app;
GRANT SELECT, INSERT ON app.commerce_order_items TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.commerce_payment_accounts TO w360_app;
GRANT UPDATE (key_id, key_secret_ciphertext, webhook_secret_ciphertext, status, status_error,
  checked_at, version, updated_by_membership_id, updated_at) ON app.commerce_payment_accounts TO w360_app;
GRANT SELECT, INSERT ON app.commerce_payment_links TO w360_app;
GRANT UPDATE (status, provider_link_id, short_url, amount_paid_minor, attempts, lease_until,
  cancel_requested_at, error, message_id, next_check_at, checked_at, paid_at, version, updated_at)
  ON app.commerce_payment_links TO w360_app;
GRANT SELECT, INSERT ON app.commerce_payment_events TO w360_app;
