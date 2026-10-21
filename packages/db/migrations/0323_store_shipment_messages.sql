-- 0323_store_shipment_messages: store follow-ups per shipment (P4-06f, ADR-413).
--
-- A connected Shopify store's order messages (0020, ADR-048) fire at most once per order and event:
-- an order with three shipments got one "shipped" message, at the first. Two new events are about
-- one shipment (a Shopify fulfillment, research SH-045) instead: `shipment_created`, once per
-- shipment, and `tracking_updated`, once per shipment and distinct tracking (its tracking number or
-- tracking link; ADR-413 defines the change). HyFib reads shipments with the order, as before
-- (`Order.fulfillments`, `read_orders`); the order read now also keeps each shipment's copy.
--
-- Expand only. Every value the old checks allowed is still allowed, the new columns are null for
-- every existing row, and the old unique key of order messages (one per order and event) stays:
-- shipment messages name their shipment, not the order (the shipment names the order), so an old
-- server never meets a second message per order and event, and the outgoing webhook triggers
-- (0270, 0273, 0276), which watch messages with an order or a checkout, do not capture them.

-- Shipments --------------------------------------------------------------------------------------
-- One row per Shopify fulfillment HyFib read with its order: the id, the statuses Shopify gives
-- (SH-030, as status words), whether it was cancelled or failed, its times, and the first of its
-- tracking entries (carrier, number, https link). tracking_keys holds digests (sha-256, hex) of the
-- distinct tracking number and link pairs seen for it, at most ten: what tells a new tracking from
-- one already seen. A tracking number and its link can show a stranger where a parcel goes, so they
-- and their digests go when the order is redacted (the trigger below).
CREATE TABLE app.commerce_store_shipments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  external_id text NOT NULL CHECK (external_id ~ '^[0-9]{1,20}$'),
  status text CHECK (status ~ '^[a-z_-]{1,30}$'),
  display_status text CHECK (display_status ~ '^[a-z_-]{1,30}$'),
  failed boolean NOT NULL DEFAULT false,
  remote_created_at timestamptz NOT NULL,
  remote_updated_at timestamptz NOT NULL,
  tracking_company text CHECK (char_length(tracking_company) <= 100),
  tracking_number text CHECK (char_length(tracking_number) <= 100),
  tracking_url text CHECK (char_length(tracking_url) <= 1000 AND tracking_url ~ '^https://'),
  tracking_keys text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tracking_keys) <= 10
    AND array_position(tracking_keys, NULL) IS NULL
    AND array_to_string(tracking_keys, ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'),
  synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_store_shipments_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT commerce_store_shipments_external_uq UNIQUE (tenant_id, store_id, external_id),
  CONSTRAINT commerce_store_shipments_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES app.commerce_stores (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT commerce_store_shipments_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES app.commerce_store_orders (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX commerce_store_shipments_order_idx
  ON app.commerce_store_shipments (tenant_id, order_id);
CREATE TRIGGER commerce_store_shipments_touch BEFORE UPDATE ON app.commerce_store_shipments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Redaction: whenever an order is written as redacted (contact erasure, Shopify's customers/redact,
-- or a read of an order whose number was erased), its shipments lose their tracking and its
-- digests, at once and for good (later reads keep them empty while the order stays redacted). The
-- trigger runs with the rights of whoever redacts: the runtime role (the store's read and its
-- webhooks) or w360_definer (erase_contact), which gets the columns and a policy for it below.
CREATE FUNCTION app.commerce_store_shipments_redact() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  UPDATE app.commerce_store_shipments s
     SET tracking_number = NULL, tracking_url = NULL, tracking_keys = '{}'
   WHERE s.tenant_id = NEW.tenant_id AND s.order_id = NEW.id
     AND (s.tracking_number IS NOT NULL OR s.tracking_url IS NOT NULL
       OR cardinality(s.tracking_keys) > 0);
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.commerce_store_shipments_redact() FROM PUBLIC;
CREATE TRIGGER commerce_store_orders_redact_shipments
  AFTER UPDATE OF redacted_at ON app.commerce_store_orders
  FOR EACH ROW WHEN (NEW.redacted_at IS NOT NULL)
  EXECUTE FUNCTION app.commerce_store_shipments_redact();

-- Shipment messages ------------------------------------------------------------------------------
-- shipment_id: the shipment a shipment message is about (its order is the shipment's);
-- dedupe_key: which of the shipment's messages it is, `created` or `tracking:<n>` for the n-th
-- distinct tracking seen for it. At most one message per shipment, event and key.
--
-- The checks are replaced NOT VALID: new and changed rows are checked at once, and every row
-- already there passed the narrower checks they replace (no row has a shipment yet). Validating
-- them here would scan this table under the lock this change takes; it is left to a later reviewed
-- migration. The unique key builds an index on the table (a write lock while it builds; see
-- docs/DEPLOYMENT.md).
ALTER TABLE app.commerce_store_messages
  ADD COLUMN shipment_id uuid,
  ADD COLUMN dedupe_key text,
  DROP CONSTRAINT commerce_store_messages_event_check,
  ADD CONSTRAINT commerce_store_messages_event_check CHECK (event IN ('order_placed',
    'cod_confirmation', 'order_shipped', 'order_delivered', 'order_cancelled', 'shipment_created',
    'tracking_updated', 'cart_reminder', 'cart_second_reminder')) NOT VALID,
  DROP CONSTRAINT commerce_store_messages_subject,
  ADD CONSTRAINT commerce_store_messages_subject CHECK (
    num_nonnulls(order_id, checkout_id, shipment_id) = 1
    AND (checkout_id IS NOT NULL) = (event IN ('cart_reminder', 'cart_second_reminder'))
    AND (shipment_id IS NOT NULL) = (event IN ('shipment_created', 'tracking_updated'))
    AND (dedupe_key IS NOT NULL) = (shipment_id IS NOT NULL)
    AND (dedupe_key IS NULL OR dedupe_key ~ '^(created|tracking:[1-9][0-9]?)$')
    AND (dedupe_key IS NULL OR (dedupe_key = 'created') = (event = 'shipment_created'))) NOT VALID,
  ADD CONSTRAINT commerce_store_messages_shipment_fk FOREIGN KEY (tenant_id, shipment_id)
    REFERENCES app.commerce_store_shipments (tenant_id, id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT commerce_store_messages_shipment_uq UNIQUE (tenant_id, shipment_id, event, dedupe_key);

-- Rules: one per store and event, as before. Shipment rules may start an automation (ADR-050's
-- generic path); their delay is the default 0 to 24 hours. A store has at most nine rules, so these
-- checks are validated here.
ALTER TABLE app.commerce_store_message_rules
  DROP CONSTRAINT commerce_store_message_rules_event_check,
  ADD CONSTRAINT commerce_store_message_rules_event_check CHECK (event IN ('order_placed',
    'cod_confirmation', 'order_shipped', 'order_delivered', 'order_cancelled', 'shipment_created',
    'tracking_updated', 'cart_reminder', 'cart_second_reminder')),
  DROP CONSTRAINT commerce_store_message_rules_action,
  ADD CONSTRAINT commerce_store_message_rules_action CHECK (action = 'template'
    OR event IN ('order_placed', 'order_shipped', 'order_delivered', 'order_cancelled',
      'shipment_created', 'tracking_updated'));

-- Runs a shipment rule starts keep the shipment's order and the event (0022). NOT VALID for the
-- reason given above for store messages.
ALTER TABLE app.automation_runs
  DROP CONSTRAINT automation_runs_store_event_check,
  ADD CONSTRAINT automation_runs_store_event_check CHECK (store_event IN ('order_placed',
    'order_shipped', 'order_delivered', 'order_cancelled', 'shipment_created',
    'tracking_updated')) NOT VALID;

-- Company isolation and privileges ---------------------------------------------------------------
SELECT ops.apply_tenant_rls('app.commerce_store_shipments');

-- The store's read keeps the copy; shipments go with their order or store.
GRANT SELECT, INSERT ON app.commerce_store_shipments TO w360_app;
GRANT UPDATE (status, display_status, failed, remote_created_at, remote_updated_at,
  tracking_company, tracking_number, tracking_url, tracking_keys, synced_at, updated_at)
  ON app.commerce_store_shipments TO w360_app;

-- Erasure (erase_contact, SECURITY DEFINER) redacts store orders, and the trigger above then
-- clears their shipments' tracking as w360_definer: only these columns, only from the trigger's
-- query (which names the company and the order).
CREATE POLICY definer_redact ON app.commerce_store_shipments TO w360_definer
  USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, order_id, tracking_number, tracking_url, tracking_keys),
  UPDATE (tracking_number, tracking_url, tracking_keys)
  ON app.commerce_store_shipments TO w360_definer;
