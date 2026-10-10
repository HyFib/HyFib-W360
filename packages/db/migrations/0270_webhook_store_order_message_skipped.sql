-- An outgoing webhook event when a store's order message is skipped (P5-09, ADR-351).
--
-- A connected store's order messages (0020, ADR-048) go out when an order is placed, asked to
-- confirm cash on delivery, shipped, delivered or cancelled, each from the template or automation
-- its rule chose. A message HyFib does not send is kept as skipped with its reason: a test order,
-- an event seen too late or covered by the cash on delivery confirmation (recorded skipped), or a
-- check that failed when it was due (the store, the rule, the order, the template, the number, the
-- customer's number, consent, the frequency cap or the automation). The order system learned of it
-- only from Settings → Stores, so an unconfirmed cash on delivery order whose confirmation never
-- went out waited there for someone to look.
--
-- store_order.message_skipped is captured when an order message becomes skipped: recorded skipped,
-- or skipped by its send-time checks. A skipped message never leaves that state, so each is sent
-- once. Cart reminders are about checkouts, not orders, and send nothing. The store's read and the
-- message's job skip messages, as the runtime role in the company's scope. The event keeps the
-- store message, the event it was for, when that happened and the reason; the order and the store
-- are read when it is delivered. A skipped message was sent from no number, so the number filter
-- does not narrow it, and no contact: the customer's details stay in the store.

-- Event types ------------------------------------------------------------------------------------

-- A company has at most 10 endpoints, so the endpoints' checks are validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check
    CHECK (cardinality(event_types) BETWEEN 1 AND 31
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'conversation.team_changed',
                             'satisfaction_survey.answered', 'contact.created',
                             'contact.updated', 'contact.erased', 'contact.merged',
                             'automation.run_started', 'automation.run_ended',
                             'automation.run_step', 'order.received',
                             'order.status_changed', 'payment_link.status_changed',
                             'store_order.cod_answered', 'store_order.message_skipped',
                             'campaign.status_changed', 'deal.created', 'deal.updated',
                             'deal.stage_changed', 'deal.owner_changed', 'deal.status_changed',
                             'task.created', 'task.updated', 'task.assignee_changed',
                             'task.status_changed', 'note.created']::text[]);

-- NOT VALID: new rows are checked at once, and 0271 checks the rows already there without holding
-- the lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'conversation.team_changed', 'satisfaction_survey.answered',
    'contact.created', 'contact.updated', 'contact.erased', 'contact.merged',
    'automation.run_started', 'automation.run_ended', 'automation.run_step', 'order.received',
    'order.status_changed', 'payment_link.status_changed', 'store_order.cod_answered',
    'store_order.message_skipped', 'campaign.status_changed', 'deal.created', 'deal.updated',
    'deal.stage_changed', 'deal.owner_changed', 'deal.status_changed', 'task.created',
    'task.updated', 'task.assignee_changed', 'task.status_changed', 'note.created',
    'ping')) NOT VALID;

-- Skipped order messages -------------------------------------------------------------------------

-- The event's status is the event the message was for (one of 0021's seven, at most 20
-- characters); `detail` keeps the store message, the reason (0020 allows 40 characters, more than
-- a status holds) and when the order's event happened. A skipped message keeps them all, and the
-- event reports them as captured. The order and the store are read through the store message when
-- it is delivered. It is stamped with the time it is captured, when the message was skipped. The
-- capture (0268) narrows only the types it names, so it is unchanged.
CREATE FUNCTION app.webhook_capture_store_message_skipped() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM app.capture_webhook_event(NEW.tenant_id, 'store_order.message_skipped', NULL, NULL,
    NULL, NULL, NEW.event,
    jsonb_build_object('storeMessageId', NEW.id, 'skipReason', NEW.skip_reason,
                       'occurredAt', NEW.occurred_at),
    clock_timestamp());
  RETURN NULL;
END
$$;
-- Order messages have an order and cart reminders a checkout (0021's subject check). A message is
-- recorded skipped (a test order, too late, covered by the cash on delivery confirmation) or
-- becomes skipped from pending when its checks fail; 0020's state shape keeps a reason with it.
CREATE TRIGGER commerce_store_messages_webhook_skipped_insert
  AFTER INSERT ON app.commerce_store_messages
  FOR EACH ROW WHEN (NEW.state = 'skipped' AND NEW.order_id IS NOT NULL)
  EXECUTE FUNCTION app.webhook_capture_store_message_skipped();
CREATE TRIGGER commerce_store_messages_webhook_skipped_update
  AFTER UPDATE OF state ON app.commerce_store_messages
  FOR EACH ROW WHEN (NEW.state = 'skipped' AND OLD.state <> 'skipped'
                     AND NEW.order_id IS NOT NULL)
  EXECUTE FUNCTION app.webhook_capture_store_message_skipped();

-- Trigger functions run with the rights of whoever makes the change: the runtime role in the
-- company's scope (the store's read and the message's job), the only role that writes the state.
REVOKE EXECUTE ON FUNCTION app.webhook_capture_store_message_skipped() FROM PUBLIC;
