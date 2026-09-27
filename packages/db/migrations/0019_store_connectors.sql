-- 0019_store_connectors: a company's own Shopify or WooCommerce store (P4-06b). HyFib reads the
-- store's orders and products and keeps a copy in step with it (research
-- docs/research/store-connectors.md). Webhooks only say what to fetch; a scheduled incremental read
-- catches up with anything missed. HyFib writes nothing to a store except its own webhook
-- subscriptions. Money is integer minor units.

-- Stores ------------------------------------------------------------------------------------------
CREATE TABLE app.commerce_stores (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  platform text NOT NULL CHECK (platform IN ('shopify', 'woocommerce')),
  -- Shopify: the shop's myshopify.com name (SH-005). WooCommerce: null.
  shop_domain text CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$'),
  -- https://<shop> for Shopify; the WordPress site address for WooCommerce.
  store_url text NOT NULL CHECK (char_length(store_url) <= 300 AND store_url ~ '^https?://[^[:space:]]+$'),
  name text CHECK (char_length(name) <= 200),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  -- Shopify's numeric shop id (from shop.id), checked against app/uninstalled deliveries.
  shop_external_id text CHECK (shop_external_id ~ '^[0-9]{1,20}$'),
  state text NOT NULL DEFAULT 'authorizing' CHECK (state IN
    ('authorizing', 'connecting', 'connected', 'failed', 'uninstalled', 'removing')),
  status_error text CHECK (char_length(status_error) <= 500),
  -- Keyring ciphertext bound to the row (commerce-store:<company>:<store>:credentials): the
  -- authorization code while it waits to be exchanged, then the tokens (Shopify) or the keys
  -- (WooCommerce). Never returned to browsers. credentials_version increases whenever they change,
  -- so a result obtained with older credentials is never applied to newer ones.
  credentials_ciphertext text CHECK (char_length(credentials_ciphertext) <= 8000),
  credentials_version integer NOT NULL DEFAULT 1 CHECK (credentials_version >= 1),
  access_expires_at timestamptz,
  granted_scopes text CHECK (char_length(granted_scopes) <= 500),
  -- The connect handshake: sha256 of the single-use state (Shopify) or key-handover id
  -- (WooCommerce), the member who started it and until when it is valid.
  connect_token_hash text CHECK (connect_token_hash ~ '^[0-9a-f]{64}$'),
  connect_membership_id uuid,
  connect_expires_at timestamptz,
  -- WooCommerce: the webhook address id (/api/webhooks/woocommerce/<id>) and the secret HyFib gives
  -- the store for signing deliveries (keyring ciphertext, commerce-store:<company>:<store>:webhook).
  webhook_public_id text CHECK (webhook_public_id ~ '^[a-z2-7]{16}$'),
  webhook_secret_ciphertext text CHECK (char_length(webhook_secret_ciphertext) <= 2000),
  webhooks_checked_at timestamptz,
  webhook_error text CHECK (char_length(webhook_error) <= 500),
  -- Customer numbers without a country code are read as national numbers of this calling code.
  -- Without it they are not linked to contacts (a number is never guessed).
  phone_calling_code text CHECK (phone_calling_code ~ '^[1-9][0-9]{0,2}$'),
  -- Incremental reads: everything updated before the cursor has been read. The page token
  -- continues a read among items updated in the cursor's own second (a Shopify page cursor or a
  -- WooCommerce page number), so a burst of updates sharing one timestamp is never skipped.
  orders_cursor timestamptz,
  orders_page text CHECK (char_length(orders_page) <= 1000),
  products_cursor timestamptz,
  products_page text CHECK (char_length(products_page) <= 1000),
  products_truncated boolean NOT NULL DEFAULT false,
  -- Shopify withheld customers' details on the last read (protected customer data, SH-020).
  details_withheld boolean NOT NULL DEFAULT false,
  backfilled_at timestamptz,
  synced_at timestamptz,
  next_sync_at timestamptz,
  sync_error text CHECK (char_length(sync_error) <= 500),
  lease_until timestamptz,
  uninstalled_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_stores_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_stores_webhook_uq UNIQUE (webhook_public_id),
  CONSTRAINT commerce_stores_connect_uq UNIQUE (connect_token_hash),
  CONSTRAINT commerce_stores_platform_shape CHECK (
    (platform = 'shopify' AND shop_domain IS NOT NULL AND webhook_public_id IS NULL
      AND webhook_secret_ciphertext IS NULL)
    OR (platform = 'woocommerce' AND shop_domain IS NULL AND webhook_public_id IS NOT NULL
      AND webhook_secret_ciphertext IS NOT NULL)),
  CONSTRAINT commerce_stores_connect_shape CHECK (
    (connect_token_hash IS NULL) = (connect_membership_id IS NULL)),
  CONSTRAINT commerce_stores_member_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT commerce_stores_connect_member_fk FOREIGN KEY (tenant_id, connect_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
-- Shopify keeps one token per app and store (SH-007) and routes webhooks by shop, so a shop is
-- connected to one company at a time. A shop whose app was uninstalled no longer counts.
CREATE UNIQUE INDEX commerce_stores_shop_uq ON app.commerce_stores (shop_domain)
  WHERE platform = 'shopify'
    AND state IN ('authorizing', 'connecting', 'connected', 'failed', 'removing');
CREATE UNIQUE INDEX commerce_stores_shop_tenant_uq ON app.commerce_stores (tenant_id, shop_domain)
  WHERE platform = 'shopify';
CREATE UNIQUE INDEX commerce_stores_site_uq ON app.commerce_stores (tenant_id, store_url)
  WHERE platform = 'woocommerce';
CREATE INDEX commerce_stores_due_idx ON app.commerce_stores (next_sync_at)
  WHERE state = 'connected';
CREATE TRIGGER commerce_stores_touch BEFORE UPDATE ON app.commerce_stores
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Products as last read from the store: what members need to answer questions about them.
CREATE TABLE app.commerce_store_products (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  external_id text NOT NULL CHECK (external_id ~ '^[0-9]{1,20}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  status text NOT NULL CHECK (status ~ '^[a-z_-]{1,30}$'),
  sku text CHECK (char_length(sku) <= 100),
  url text CHECK (char_length(url) <= 1000 AND url ~ '^https?://'),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  price_min_minor bigint CHECK (price_min_minor >= 0),
  price_max_minor bigint CHECK (price_max_minor >= 0),
  inventory integer,
  variants integer CHECK (variants >= 0),
  remote_updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_store_products_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_store_products_external_uq UNIQUE (tenant_id, store_id, external_id),
  CONSTRAINT commerce_store_products_price CHECK (
    (price_min_minor IS NULL AND price_max_minor IS NULL)
    OR (currency IS NOT NULL AND price_min_minor <= price_max_minor)),
  CONSTRAINT commerce_store_products_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES app.commerce_stores (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX commerce_store_products_list_idx ON app.commerce_store_products (tenant_id, store_id, title, id)
  WHERE deleted_at IS NULL;
CREATE TRIGGER commerce_store_products_touch BEFORE UPDATE ON app.commerce_store_products
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Orders as last read from the store. The customer's details are what the store shares (Shopify
-- redacts fields an app is not approved for, SH-020); a redacted order keeps them empty for good.
CREATE TABLE app.commerce_store_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  external_id text NOT NULL CHECK (external_id ~ '^[0-9]{1,20}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  status text NOT NULL CHECK (status ~ '^[a-z_-]{1,40}$'),
  financial_status text CHECK (financial_status ~ '^[a-z_-]{1,40}$'),
  fulfillment_status text CHECK (fulfillment_status ~ '^[a-z_-]{1,40}$'),
  test boolean NOT NULL DEFAULT false,
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint CHECK (total_minor >= 0),
  items_truncated boolean NOT NULL DEFAULT false,
  placed_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  remote_updated_at timestamptz NOT NULL,
  customer_name text CHECK (char_length(customer_name) <= 200),
  customer_phone text CHECK (customer_phone ~ '^\+[1-9][0-9]{6,14}$'),
  customer_email text CHECK (char_length(customer_email) <= 320),
  -- Shopify's order status page for the customer (SH-013); WooCommerce has none.
  status_url text CHECK (char_length(status_url) <= 1000 AND status_url ~ '^https://'),
  redacted_at timestamptz,
  deleted_at timestamptz,
  synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_store_orders_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_store_orders_external_uq UNIQUE (tenant_id, store_id, external_id),
  CONSTRAINT commerce_store_orders_total CHECK (total_minor IS NULL OR currency IS NOT NULL),
  CONSTRAINT commerce_store_orders_redacted CHECK (redacted_at IS NULL OR (customer_name IS NULL
    AND customer_phone IS NULL AND customer_email IS NULL AND status_url IS NULL)),
  CONSTRAINT commerce_store_orders_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES app.commerce_stores (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX commerce_store_orders_list_idx ON app.commerce_store_orders (tenant_id, store_id, placed_at DESC, id DESC);
CREATE INDEX commerce_store_orders_phone_idx ON app.commerce_store_orders (tenant_id, customer_phone, placed_at DESC)
  WHERE customer_phone IS NOT NULL;
CREATE TRIGGER commerce_store_orders_touch BEFORE UPDATE ON app.commerce_store_orders
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- An order's lines as last read (replaced whenever the order is read again).
CREATE TABLE app.commerce_store_order_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 100),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  sku text CHECK (char_length(sku) <= 100),
  quantity integer NOT NULL CHECK (quantity BETWEEN 0 AND 1000000),
  total_minor bigint CHECK (total_minor >= 0),
  CONSTRAINT commerce_store_order_items_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_store_order_items_position_uq UNIQUE (tenant_id, order_id, position),
  CONSTRAINT commerce_store_order_items_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES app.commerce_store_orders (tenant_id, id) ON DELETE CASCADE
);

-- Orders and products a webhook said changed, waiting to be read from the store. One row per
-- resource, so repeated deliveries collapse into one read of its current state.
CREATE TABLE app.commerce_store_fetches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('order', 'product')),
  external_id text NOT NULL CHECK (external_id ~ '^[0-9]{1,20}$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_store_fetches_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_store_fetches_resource_uq UNIQUE (tenant_id, store_id, kind, external_id),
  CONSTRAINT commerce_store_fetches_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES app.commerce_stores (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX commerce_store_fetches_due_idx ON app.commerce_store_fetches (tenant_id, store_id, requested_at);

-- Webhook deliveries already seen (Shopify X-Shopify-Webhook-Id, WooCommerce
-- X-WC-Webhook-Delivery-ID), kept 30 days; only the topic is stored, never the body.
CREATE TABLE app.commerce_store_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  delivery_id text NOT NULL CHECK (delivery_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  topic text NOT NULL CHECK (topic ~ '^[a-z_./]{1,64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_store_events_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_store_events_delivery_uq UNIQUE (tenant_id, store_id, delivery_id),
  CONSTRAINT commerce_store_events_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES app.commerce_stores (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX commerce_store_events_time_idx ON app.commerce_store_events (tenant_id, store_id, received_at);

-- Shopify's privacy requests for a store's customers (SH-027): a data request keeps who asked
-- until the company marks it answered; a redaction keeps only what was redacted.
CREATE TABLE app.commerce_store_privacy_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('data_request', 'redact')),
  customer_email text CHECK (char_length(customer_email) <= 320),
  customer_phone text CHECK (char_length(customer_phone) <= 40),
  order_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(order_ids) <= 1000),
  orders_redacted integer CHECK (orders_redacted >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  answered_by_membership_id uuid,
  CONSTRAINT commerce_store_privacy_requests_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_store_privacy_requests_shape CHECK (
    (kind = 'redact' AND customer_email IS NULL AND customer_phone IS NULL)
    OR (kind = 'data_request' AND orders_redacted IS NULL)),
  CONSTRAINT commerce_store_privacy_requests_answered CHECK (
    answered_at IS NULL OR (customer_email IS NULL AND customer_phone IS NULL)),
  CONSTRAINT commerce_store_privacy_requests_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES app.commerce_stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT commerce_store_privacy_requests_member_fk FOREIGN KEY (tenant_id, answered_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE INDEX commerce_store_privacy_requests_store_idx
  ON app.commerce_store_privacy_requests (tenant_id, store_id, received_at DESC);

-- Lookups without company context -------------------------------------------------------------------
-- The Shopify webhook route: the stores connected (now or before) to a shop. The delivery's HMAC is
-- checked with HyFib's app secret before this runs.
CREATE FUNCTION ops.commerce_store_by_shop(p_shop_domain text)
  RETURNS TABLE (tenant_id uuid, store_id uuid, state text, shop_external_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, s.id, s.state, s.shop_external_id
    FROM app.commerce_stores s
    JOIN app.tenants t ON t.id = s.tenant_id
   WHERE p_shop_domain ~ '^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$'
     AND s.platform = 'shopify' AND s.shop_domain = p_shop_domain
     AND t.status IN ('active', 'suspended')
$$;

-- The WooCommerce webhook route: which store a delivery address belongs to. The delivery's
-- signature is then checked with that store's secret before anything else happens.
CREATE FUNCTION ops.commerce_store_by_webhook(p_public_id text)
  RETURNS TABLE (tenant_id uuid, store_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, s.id
    FROM app.commerce_stores s
    JOIN app.tenants t ON t.id = s.tenant_id
   WHERE p_public_id ~ '^[a-z2-7]{16}$' AND s.platform = 'woocommerce'
     AND s.webhook_public_id = p_public_id
     AND t.status IN ('active', 'suspended')
$$;

-- The connect callbacks: the store waiting for this handshake (by the hash of its single-use token).
-- The Shopify callback then requires the signed-in member who started it; the WooCommerce key
-- handover is trusted only once the keys work against the store's own address.
CREATE FUNCTION ops.commerce_store_by_connect(p_token_hash text)
  RETURNS TABLE (tenant_id uuid, tenant_slug text, store_id uuid, platform text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, t.slug, s.id, s.platform
    FROM app.commerce_stores s
    JOIN app.tenants t ON t.id = s.tenant_id
   WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND s.connect_token_hash = p_token_hash
     AND s.state = 'authorizing' AND s.connect_expires_at > now()
     AND t.status = 'active'
$$;

-- The minute sweep (active companies only): stores to finish connecting or removing, handshakes that
-- expired an hour ago, and connected stores with reads, token refreshes or webhook checks due.
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
       OR (s.state = 'connected' AND (s.next_sync_at <= now()
         OR s.webhooks_checked_at IS NULL OR s.webhooks_checked_at < now() - interval '6 hours'
         OR s.access_expires_at < now() + interval '10 minutes'
         OR EXISTS (SELECT 1 FROM app.commerce_store_fetches f
                     WHERE f.tenant_id = s.tenant_id AND f.store_id = s.id))))
   ORDER BY s.next_sync_at NULLS FIRST
   LIMIT p_limit
$$;

CREATE POLICY definer_read ON app.commerce_stores FOR SELECT TO w360_definer USING (true);
CREATE POLICY definer_read ON app.commerce_store_fetches FOR SELECT TO w360_definer USING (true);
CREATE POLICY definer_access ON app.commerce_store_orders TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, id, platform, shop_domain, shop_external_id, state, connect_token_hash,
  connect_expires_at, webhook_public_id, next_sync_at, webhooks_checked_at, access_expires_at,
  lease_until) ON app.commerce_stores TO w360_definer;
GRANT SELECT (tenant_id, store_id) ON app.commerce_store_fetches TO w360_definer;
GRANT SELECT (tenant_id, customer_phone, customer_email),
  UPDATE (customer_name, customer_phone, customer_email, status_url, redacted_at)
  ON app.commerce_store_orders TO w360_definer;
-- Erasure matches store orders by the contact's email too.
GRANT SELECT (email) ON app.contacts TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.commerce_store_by_shop(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.commerce_store_by_webhook(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.commerce_store_by_connect(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.commerce_store_work_due(integer) TO w360_app;
ALTER FUNCTION ops.commerce_store_by_shop(text) OWNER TO w360_definer;
ALTER FUNCTION ops.commerce_store_by_webhook(text) OWNER TO w360_definer;
ALTER FUNCTION ops.commerce_store_by_connect(text) OWNER TO w360_definer;
ALTER FUNCTION ops.commerce_store_work_due(integer) OWNER TO w360_definer;

-- Contact erasure: same body as 0018 plus the store statements (see the note on replacing definer
-- functions in 0011).
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
  -- email) lose the customer's details for good; later reads from the store keep them empty.
  IF v_contact.phone_e164 IS NOT NULL OR v_contact.email IS NOT NULL THEN
    UPDATE app.commerce_store_orders o
       SET customer_name = NULL, customer_phone = NULL, customer_email = NULL, status_url = NULL,
           redacted_at = now()
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
SELECT ops.apply_tenant_rls('app.commerce_stores');
SELECT ops.apply_tenant_rls('app.commerce_store_products');
SELECT ops.apply_tenant_rls('app.commerce_store_orders');
SELECT ops.apply_tenant_rls('app.commerce_store_order_items');
SELECT ops.apply_tenant_rls('app.commerce_store_fetches');
SELECT ops.apply_tenant_rls('app.commerce_store_events');
SELECT ops.apply_tenant_rls('app.commerce_store_privacy_requests');

GRANT SELECT, INSERT, DELETE ON app.commerce_stores TO w360_app;
GRANT UPDATE (store_url, name, currency, shop_external_id, state, status_error, credentials_ciphertext,
  credentials_version, access_expires_at, granted_scopes, connect_token_hash, connect_membership_id,
  connect_expires_at, webhooks_checked_at, webhook_error, phone_calling_code, orders_cursor,
  orders_page, products_cursor, products_page, products_truncated, details_withheld, backfilled_at,
  synced_at, next_sync_at, sync_error, lease_until, uninstalled_at, version, updated_at)
  ON app.commerce_stores TO w360_app;
GRANT SELECT, INSERT ON app.commerce_store_products TO w360_app;
GRANT UPDATE (title, status, sku, url, currency, price_min_minor, price_max_minor, inventory, variants,
  remote_updated_at, deleted_at, synced_at, updated_at) ON app.commerce_store_products TO w360_app;
GRANT SELECT, INSERT ON app.commerce_store_orders TO w360_app;
GRANT UPDATE (name, status, financial_status, fulfillment_status, test, currency, total_minor,
  items_truncated, placed_at, cancelled_at, remote_updated_at, customer_name, customer_phone,
  customer_email, status_url, redacted_at, deleted_at, synced_at, updated_at)
  ON app.commerce_store_orders TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.commerce_store_order_items TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.commerce_store_fetches TO w360_app;
GRANT UPDATE (requested_at) ON app.commerce_store_fetches TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.commerce_store_events TO w360_app;
GRANT SELECT, INSERT ON app.commerce_store_privacy_requests TO w360_app;
GRANT UPDATE (customer_email, customer_phone, answered_at, answered_by_membership_id)
  ON app.commerce_store_privacy_requests TO w360_app;
