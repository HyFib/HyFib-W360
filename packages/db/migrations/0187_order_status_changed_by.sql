-- 0187_order_status_changed_by: who changed a WhatsApp order's status, for order.status_changed
-- (P5-09, P5-08, ADR-270). A member on the order page, an API key (ADR-168, named) or HyFib
-- applying what Razorpay reports for the order's Payment Link records itself with the status, and
-- the order trigger (0063, 0118) captures it in the event, so an integration that moves orders
-- through the API can tell its own changes from members' and payments'.

-- Columns ----------------------------------------------------------------------------------------

-- `status_changed_xact` is the transaction that recorded who changed the status: a change made
-- without recording it (code from before this migration, during a rollout) must not keep the
-- previous changer, so the trigger below clears a changer an older transaction recorded. The
-- foreign key and the check are added NOT VALID, so app.commerce_orders is not read under this
-- migration's lock: no order has a changer yet. 0188 validates them. A key is deleted only with
-- its company, after its orders (ops.tenant_deletion_steps 560 before 860), and the foreign key's
-- check finds the company's keys through UNIQUE (tenant_id, id).
ALTER TABLE app.commerce_orders
  ADD COLUMN status_changed_by text,
  ADD COLUMN status_changed_by_api_key_id uuid,
  ADD COLUMN status_changed_xact xid8,
  ADD CONSTRAINT commerce_orders_status_changed_by_api_key_fk
    FOREIGN KEY (tenant_id, status_changed_by_api_key_id)
    REFERENCES app.api_keys (tenant_id, id) NOT VALID,
  ADD CONSTRAINT commerce_orders_status_changed_by CHECK (
    CASE WHEN status_changed_by = 'api' THEN status_changed_by_api_key_id IS NOT NULL
         ELSE (status_changed_by IS NULL OR status_changed_by IN ('member', 'payment_link'))
              AND status_changed_by_api_key_id IS NULL
    END) NOT VALID;

-- The runtime role changes order statuses (0018) and now records who with them; it reads every
-- column already.
GRANT UPDATE (status_changed_by, status_changed_by_api_key_id, status_changed_xact)
  ON app.commerce_orders TO w360_app;

-- A change of status keeps its changer only when this transaction recorded it.
CREATE FUNCTION app.commerce_order_status_changer() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.status_changed_xact IS DISTINCT FROM pg_current_xact_id() THEN
    NEW.status_changed_by := NULL;
    NEW.status_changed_by_api_key_id := NULL;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION app.commerce_order_status_changer() FROM PUBLIC;
CREATE TRIGGER commerce_orders_status_changer BEFORE UPDATE OF status ON app.commerce_orders
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION app.commerce_order_status_changer();

-- Events -----------------------------------------------------------------------------------------

-- 0118's capture with the changer of a status change in `detail` (null when the change did not
-- record one). The trigger runs after the one above, so it reads the changer that trigger left.
-- Same signature, so the triggers and grants stay.
CREATE OR REPLACE FUNCTION app.webhook_capture_order() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'order.received', NULL,
      NEW.conversation_id, NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('orderId', NEW.id, 'channelId', NEW.channel_account_id),
      NEW.received_at);
  ELSE
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'order.status_changed', NULL,
      NEW.conversation_id, NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('orderId', NEW.id, 'previousStatus', OLD.status,
        'channelId', NEW.channel_account_id, 'changedBy', NEW.status_changed_by,
        'apiKeyId', NEW.status_changed_by_api_key_id),
      NEW.status_changed_at);
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_order() FROM PUBLIC;
