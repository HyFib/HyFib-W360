-- 0063_webhook_order_events: outgoing webhook events for WhatsApp orders (P5-09, ADR-085).
-- order.received when HyFib records a cart a customer sent from the company's WhatsApp catalog, and
-- order.status_changed whenever the order's status changes, whoever changes it: a member confirming,
-- fulfilling or cancelling it or asking for payment, or the worker applying what Razorpay reports for
-- its Payment Link (paid, or back to confirmed when the link ends unpaid). Store orders (Shopify,
-- WooCommerce) are not sent: they are copies of the store's own orders. Captured by triggers like the
-- events of 0025, 0047 and 0055; payloads are built when delivered.

-- Event types ------------------------------------------------------------------------------------------
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check CHECK (cardinality(event_types) BETWEEN 1 AND 13
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'contact.created', 'contact.updated',
                             'contact.erased', 'automation.run_started', 'automation.run_ended',
                             'order.received', 'order.status_changed']::text[]);

-- NOT VALID: new rows are checked at once, and 0064 checks the rows already there without holding the
-- lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'contact.created', 'contact.updated', 'contact.erased',
    'automation.run_started', 'automation.run_ended', 'order.received', 'order.status_changed',
    'ping')) NOT VALID;

-- Orders -----------------------------------------------------------------------------------------------
-- The event keeps the order in `detail` (with the status before it for a change), the conversation
-- and the contact, and the status it reports. The items, amounts and the customer's note are read
-- when the event is delivered, so a note erasure cleared is never sent.
CREATE FUNCTION app.webhook_capture_order() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'order.received', NULL,
      NEW.conversation_id, NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('orderId', NEW.id), NEW.received_at);
  ELSE
    PERFORM app.capture_webhook_event(NEW.tenant_id, 'order.status_changed', NULL,
      NEW.conversation_id, NEW.contact_id, NULL, NEW.status,
      jsonb_build_object('orderId', NEW.id, 'previousStatus', OLD.status), NEW.status_changed_at);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER commerce_orders_webhook_received AFTER INSERT ON app.commerce_orders
  FOR EACH ROW EXECUTE FUNCTION app.webhook_capture_order();
-- Erasure clears the customer's note without touching the status, so it sends nothing here.
CREATE TRIGGER commerce_orders_webhook_status AFTER UPDATE OF status ON app.commerce_orders
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION app.webhook_capture_order();

-- Trigger functions run with the rights of whoever makes the change: the runtime role in the
-- company's scope, the only role that adds orders or changes their status (w360_definer, inside
-- erasure, only clears the note).
REVOKE EXECUTE ON FUNCTION app.webhook_capture_order() FROM PUBLIC;
