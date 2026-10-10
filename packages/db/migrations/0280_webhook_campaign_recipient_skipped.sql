-- Outgoing webhook events when a campaign skips a recipient (P5-09, ADR-358).
--
-- A campaign's recipients are taken when it is submitted (0006): a contact HyFib cannot send to
-- then (no number, suppressed, opted out, without marketing opt-in, or missing a variable's value)
-- is kept as a skipped recipient, and the runner skips others as it sends (the same checks again,
-- an erased contact, the frequency cap, no price under a spending cap, or the sending period
-- ending first). Message statuses (message.status) report the recipients a message went to; the
-- skipped ones reached no receiver, so a system that reaches contacts another way could not tell
-- whom a campaign left out, or why.
--
-- campaign.recipient_skipped is captured once per skipped recipient: for those skipped when the
-- audience was taken, when the campaign starts (scheduled to running, which happens once: a
-- campaign paused before it started resumes to scheduled, one that started resumes to running),
-- so a campaign sent back to draft or cancelled before it starts reports none; for the others as
-- the runner skips them. The runner's job writes both changes, as the runtime role in the
-- company's scope. The event's status is the skip reason; the recipient, its campaign, the
-- contact and the number are read when the event is delivered. The campaigns (0133) and the
-- numbers (0118) an endpoint names narrow it, by the campaign the recipient belongs to and the
-- number that campaign sends from.
--
-- A start can find up to 50,000 recipients skipped when the audience was taken, and the end of a
-- campaign's sending period skips every recipient still waiting in one statement, all within the
-- runner's statement timeout. So these events do not pass through app.capture_webhook_event once
-- per recipient: app.capture_campaign_recipient_skips writes them set-based, one insert of the
-- events and one of their deliveries per campaign and statement. The capture function is
-- unchanged.

-- Event types ------------------------------------------------------------------------------------

-- A company has at most 10 endpoints, so the endpoints' checks are validated here.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_event_types_check,
  ADD CONSTRAINT webhook_endpoints_event_types_check
    CHECK (cardinality(event_types) BETWEEN 1 AND 35
    AND event_types <@ ARRAY['message.received', 'message.status', 'consent.changed',
                             'template.status_changed', 'conversation.status_changed',
                             'conversation.assignment_changed', 'conversation.team_changed',
                             'satisfaction_survey.answered', 'contact.created', 'contact.updated',
                             'contact.erased', 'contact.merged', 'automation.run_started',
                             'automation.run_ended', 'automation.run_step', 'order.received',
                             'order.status_changed', 'payment_link.status_changed',
                             'store_order.cod_answered', 'store_order.message_skipped',
                             'store_order.message_sent', 'store_checkout.reminder_skipped',
                             'store_checkout.reminder_sent', 'campaign.status_changed',
                             'campaign.recipient_skipped', 'deal.created', 'deal.updated',
                             'deal.stage_changed', 'deal.owner_changed', 'deal.status_changed',
                             'task.created', 'task.updated', 'task.assignee_changed',
                             'task.status_changed', 'note.created']::text[]);

-- NOT VALID: new rows are checked at once, and 0281 checks the rows already there without holding
-- the lock this change takes (every capture writes to this table).
ALTER TABLE app.webhook_events
  DROP CONSTRAINT webhook_events_type_check,
  ADD CONSTRAINT webhook_events_type_check CHECK (type IN ('message.received', 'message.status',
    'consent.changed', 'template.status_changed', 'conversation.status_changed',
    'conversation.assignment_changed', 'conversation.team_changed', 'satisfaction_survey.answered',
    'contact.created', 'contact.updated', 'contact.erased', 'contact.merged',
    'automation.run_started', 'automation.run_ended', 'automation.run_step', 'order.received',
    'order.status_changed', 'payment_link.status_changed', 'store_order.cod_answered',
    'store_order.message_skipped', 'store_order.message_sent', 'store_checkout.reminder_skipped',
    'store_checkout.reminder_sent', 'campaign.status_changed', 'campaign.recipient_skipped',
    'deal.created', 'deal.updated', 'deal.stage_changed', 'deal.owner_changed',
    'deal.status_changed', 'task.created', 'task.updated', 'task.assignee_changed',
    'task.status_changed', 'note.created', 'ping')) NOT VALID;

-- A skipped recipient belongs to its campaign, which sends from its number, so the number list
-- (0276) and the campaign list (0133) are kept while an endpoint takes it. The rest of each check
-- is unchanged.
ALTER TABLE app.webhook_endpoints
  DROP CONSTRAINT webhook_endpoints_channel_account_ids,
  ADD CONSTRAINT webhook_endpoints_channel_account_ids CHECK (
    channel_account_ids IS NULL
    OR (cardinality(channel_account_ids) BETWEEN 1 AND 100
        AND array_position(channel_account_ids, NULL) IS NULL
        AND event_types && ARRAY['message.received', 'message.status',
                                 'conversation.status_changed', 'conversation.assignment_changed',
                                 'conversation.team_changed', 'satisfaction_survey.answered',
                                 'automation.run_started', 'automation.run_ended',
                                 'automation.run_step', 'order.received', 'order.status_changed',
                                 'payment_link.status_changed', 'store_order.cod_answered',
                                 'store_order.message_sent', 'store_checkout.reminder_sent',
                                 'campaign.status_changed', 'campaign.recipient_skipped']::text[])),
  DROP CONSTRAINT webhook_endpoints_campaign_ids,
  ADD CONSTRAINT webhook_endpoints_campaign_ids CHECK (
    campaign_ids IS NULL
    OR (cardinality(campaign_ids) BETWEEN 1 AND 50
        AND array_ndims(campaign_ids) = 1
        AND array_position(campaign_ids, NULL) IS NULL
        AND event_types && ARRAY['message.status', 'campaign.status_changed',
                                 'campaign.recipient_skipped']::text[]));

-- Skipped recipients -----------------------------------------------------------------------------

-- The events of a campaign's skipped recipients, given as arrays in the order to capture them: one
-- per recipient, its status the skip reason (0006 allows nine, each within a status's 32
-- characters), its contact the recipient's, `detail` the recipient alone, stamped with the time it
-- is written; and one delivery per event for each active endpoint of the company that takes the
-- event and whose campaign and number lists are null or hold the campaign and the number it sends
-- from (a campaign without a number is on no number list). Nothing is written when no endpoint
-- takes them. It runs with the rights of whoever calls it, as app.capture_webhook_event does: the
-- triggers below, as the role making the change, so RLS keeps every event in the company.
CREATE FUNCTION app.capture_campaign_recipient_skips(p_tenant uuid, p_campaign uuid,
  p_channel uuid, p_recipients uuid[], p_contacts uuid[], p_reasons text[]) RETURNS void
  LANGUAGE sql
  SET search_path = pg_catalog, pg_temp
  AS $$
  WITH targets AS (
    SELECT e.id FROM app.webhook_endpoints e
     WHERE e.tenant_id = p_tenant AND e.state = 'active'
       AND 'campaign.recipient_skipped' = ANY (e.event_types)
       AND (e.campaign_ids IS NULL OR p_campaign = ANY (e.campaign_ids))
       AND (e.channel_account_ids IS NULL OR p_channel = ANY (e.channel_account_ids))
  ), events AS (
    INSERT INTO app.webhook_events (id, tenant_id, type, contact_id, status, detail, occurred_at)
    SELECT gen_random_uuid(), p_tenant, 'campaign.recipient_skipped', s.contact_id, s.reason,
           jsonb_build_object('recipientId', s.id), clock_timestamp()
      FROM unnest(p_recipients, p_contacts, p_reasons)
           WITH ORDINALITY AS s (id, contact_id, reason, n)
     WHERE EXISTS (SELECT 1 FROM targets)
     ORDER BY s.n
    RETURNING id
  )
  INSERT INTO app.webhook_deliveries (id, tenant_id, endpoint_id, event_id)
  SELECT gen_random_uuid(), p_tenant, t.id, ev.id FROM events ev CROSS JOIN targets t;
$$;
REVOKE EXECUTE ON FUNCTION app.capture_campaign_recipient_skips(uuid, uuid, uuid, uuid[], uuid[],
  text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.capture_campaign_recipient_skips(uuid, uuid, uuid, uuid[], uuid[],
  text[]) TO w360_app, w360_definer;

-- Those skipped when the audience was taken, when the campaign starts, in the order the runner
-- pages recipients (by id, the index it reads them by, 0006). Read only when an active endpoint of
-- the company takes the event, so a company without one adds one read of its endpoints to a start.
CREATE FUNCTION app.webhook_capture_campaign_start_skips() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_recipients uuid[];
  v_contacts uuid[];
  v_reasons text[];
BEGIN
  IF NOT app.webhook_subscribed(NEW.tenant_id, 'campaign.recipient_skipped') THEN
    RETURN NULL;
  END IF;
  SELECT array_agg(cr.id ORDER BY cr.id), array_agg(cr.contact_id ORDER BY cr.id),
         array_agg(cr.skip_reason ORDER BY cr.id)
    INTO v_recipients, v_contacts, v_reasons
    FROM app.campaign_recipients cr
   WHERE cr.tenant_id = NEW.tenant_id AND cr.campaign_id = NEW.id AND cr.state = 'skipped';
  IF v_recipients IS NOT NULL THEN
    PERFORM app.capture_campaign_recipient_skips(NEW.tenant_id, NEW.id, NEW.channel_account_id,
      v_recipients, v_contacts, v_reasons);
  END IF;
  RETURN NULL;
END
$$;
-- The runner starts a campaign once, from scheduled (it sets the start time with it). Named to run
-- after campaigns_webhook_status (0065), so the campaign's change to running is captured first.
CREATE TRIGGER campaigns_webhook_status_skips
  AFTER UPDATE OF status ON app.campaigns
  FOR EACH ROW WHEN (OLD.status = 'scheduled' AND NEW.status = 'running')
  EXECUTE FUNCTION app.webhook_capture_campaign_start_skips();

-- The others as the runner skips them, once per statement: the recipients a statement moved to
-- skipped (from pending: a skipped recipient never changes state again), per campaign, in id
-- order. A statement trigger, so the end of a sending period that skips every recipient still
-- waiting captures them together; it runs after every update of recipients (a trigger with
-- transition tables takes no column list), and one that skips none, such as the runner's queueing,
-- a reply or a contact merge, finds no row and writes nothing. Recipients inserted skipped when the
-- audience is taken are captured when the campaign starts, above.
CREATE FUNCTION app.webhook_capture_campaign_recipient_skips() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  r record;
  v_channel uuid;
BEGIN
  FOR r IN
    SELECT n.tenant_id, n.campaign_id, array_agg(n.id ORDER BY n.id) AS recipients,
           array_agg(n.contact_id ORDER BY n.id) AS contacts,
           array_agg(n.skip_reason ORDER BY n.id) AS reasons
      FROM recipients_after n
      JOIN recipients_before o ON o.tenant_id = n.tenant_id AND o.id = n.id
     WHERE n.state = 'skipped' AND o.state <> 'skipped'
     GROUP BY n.tenant_id, n.campaign_id
  LOOP
    IF app.webhook_subscribed(r.tenant_id, 'campaign.recipient_skipped') THEN
      SELECT c.channel_account_id INTO v_channel FROM app.campaigns c
       WHERE c.tenant_id = r.tenant_id AND c.id = r.campaign_id;
      PERFORM app.capture_campaign_recipient_skips(r.tenant_id, r.campaign_id, v_channel,
        r.recipients, r.contacts, r.reasons);
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
CREATE TRIGGER campaign_recipients_webhook_skipped
  AFTER UPDATE ON app.campaign_recipients
  REFERENCING OLD TABLE AS recipients_before NEW TABLE AS recipients_after
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.webhook_capture_campaign_recipient_skips();

-- Trigger functions run with the rights of whoever makes the change: the runtime role in the
-- company's scope (the runner's job), the only role that starts a campaign or skips a recipient
-- (a contact merge, as the definer role, updates recipients without skipping any).
REVOKE EXECUTE ON FUNCTION app.webhook_capture_campaign_start_skips() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.webhook_capture_campaign_recipient_skips() FROM PUBLIC;
