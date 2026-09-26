-- 0007_reports: persisted metric definitions, reply turns for inbox response-time reporting and the
-- company's first-response target.
--
-- Reports are computed on request from operational tables inside the company's RLS scope; nothing
-- here stores pre-aggregated numbers. `ops.metric_definitions` records what every reported number
-- means (numerator, denominator, window, time-zone rule, missing-data semantics, freshness). Rows
-- are immutable: a changed definition is a new version added by a later migration, and a test keeps
-- the rows identical to the registry in packages/domain/src/reports/definitions.ts.
-- The period index on app.messages is created concurrently by 0008.

-- Metric definitions (global reference data; read-only for runtime roles) ------------------------
CREATE TABLE ops.metric_definitions (
  key text NOT NULL CHECK (key ~ '^[a-z]+(\.[a-z_]+)+$'),
  version integer NOT NULL CHECK (version >= 1),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  unit text NOT NULL CHECK (unit IN ('count', 'rate', 'duration', 'money')),
  description text NOT NULL,
  numerator text NOT NULL,
  denominator text,
  window_rule text,
  timezone_rule text,
  missing_data text NOT NULL,
  freshness text NOT NULL,
  -- False when HyFib cannot measure the metric; reports show the reason instead of a number.
  available boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, version)
);
CREATE TRIGGER metric_definitions_immutable BEFORE UPDATE OR DELETE ON ops.metric_definitions
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
GRANT SELECT ON ops.metric_definitions TO w360_app, w360_platform;

INSERT INTO ops.metric_definitions (key, version, label, unit, description, numerator, denominator, window_rule,
  timezone_rule, missing_data, freshness, available) VALUES
  ('campaign.audience', 1, 'Audience', 'count',
   'Contacts in the audience snapshot taken when the campaign was submitted.',
   'Recipients in the snapshot.',
   NULL,
   NULL,
   NULL,
   'Contacts erased later stay counted, as skipped.',
   'Fixed at submission.', true),
  ('campaign.skipped', 1, 'Not sent', 'count',
   'Snapshot recipients HyFib did not send to, by reason: opted out, suppressed, no marketing opt-in, missing variable, frequency cap, unknown cost under a spending cap, erased, no number, or the sending period ended.',
   'Recipients with state skipped.',
   NULL,
   NULL,
   NULL,
   'None: every skip records its reason.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('campaign.queued', 1, 'Handed to WhatsApp', 'count',
   'Recipients whose message was queued for sending through the WhatsApp number.',
   'Recipients with state queued.',
   NULL,
   NULL,
   NULL,
   'None.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('campaign.sent_rate', 1, 'Sent', 'rate',
   'Share of queued messages that Meta reported as sent (or delivered or read).',
   'Queued recipients whose message status is sent, delivered or read.',
   'Queued recipients.',
   NULL,
   NULL,
   'Messages without a status webhook yet count as not sent; they appear as "in progress".',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('campaign.delivered_rate', 1, 'Delivered', 'rate',
   'Share of sent messages that reached the customer’s phone.',
   'Recipients whose message status is delivered or read.',
   'Recipients whose message status is sent, delivered or read.',
   NULL,
   NULL,
   'A delivered status can arrive late; the rate can rise after sending ends.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('campaign.read_rate', 1, 'Read', 'rate',
   'Share of delivered messages that Meta reported as read.',
   'Recipients whose message status is read.',
   'Recipients whose message status is delivered or read.',
   NULL,
   NULL,
   'Customers can turn read receipts off, so this is a lower bound of the true read rate.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('campaign.reply_rate', 1, 'Replied', 'rate',
   'Share of delivered messages followed by a reply from the customer on the same number within 72 hours (quick-reply taps count; reactions do not). A reply counts for the most recent campaign message only.',
   'Delivered recipients with a reply attributed to this campaign.',
   'Recipients whose message status is delivered or read.',
   '72 hours after the message was queued, last touch.',
   NULL,
   'Replies Meta has not delivered to HyFib yet are not counted, and a reply to a message whose delivered status has not arrived counts once it does; the window is measured in absolute time.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('campaign.opt_out_rate', 1, 'Opted out', 'rate',
   'Share of delivered messages followed within 72 hours by a marketing opt-out (keyword, Meta error 131050, or recorded by a member).',
   'Delivered recipients with a marketing opt-out attributed to this campaign.',
   'Recipients whose message status is delivered or read.',
   '72 hours after the message was queued, last touch.',
   NULL,
   'Opt-outs made outside WhatsApp and not recorded in HyFib are not counted; an opt-out is never attributed to a message that failed or was not sent.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('campaign.failure_rate', 1, 'Failed', 'rate',
   'Share of queued messages that failed or whose outcome is unknown (a dropped connection after the request left; never resent automatically).',
   'Queued recipients whose message status is failed or unknown outcome.',
   'Queued recipients.',
   NULL,
   NULL,
   'Failure codes are Meta’s; see the breakdown for each code.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('campaign.clicked', 1, 'Clicked', 'rate',
   'Taps on website buttons.',
   '—',
   NULL,
   NULL,
   NULL,
   'Not measured: Meta does not report website-button taps in webhooks, and HyFib does not rewrite links to track them.',
   'Not available.', false),
  ('campaign.converted', 1, 'Converted', 'rate',
   'Purchases or deals attributed to the campaign.',
   '—',
   NULL,
   NULL,
   NULL,
   'Not measured: no conversion source (orders or deals) is connected yet.',
   'Not available.', false),
  ('campaign.estimated_cost', 1, 'Estimated Meta cost', 'money',
   'Sum of the list price of each queued message from the published rate card for the company’s billing currency, by the recipient’s market and the template’s category. Meta bills the company directly; HyFib does not charge this.',
   'Sum of estimated prices of queued messages.',
   NULL,
   'Rate card in force when each message was queued.',
   NULL,
   'An upper bound: Meta charges delivered messages only, and free windows and volume tiers are not applied. Recipients in markets without a rate are listed as unpriced.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('messaging.inbound', 1, 'Customer messages', 'count',
   'Messages customers sent to the company’s WhatsApp numbers.',
   'Inbound messages from contacts, excluding reactions and system notices.',
   NULL,
   NULL,
   'Counted by the time HyFib recorded each item, in calendar days of the company’s time zone (Settings → Company). A period runs from midnight at the start of its first day to midnight after its last day, with daylight-saving changes applied.',
   'Messages Meta has not delivered to HyFib yet are not counted.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('messaging.outbound', 1, 'Messages sent', 'count',
   'Messages the company sent, by sender: members (replies and templates), campaigns, and other senders (API or system).',
   'Outbound messages recorded in the period.',
   NULL,
   NULL,
   'Counted by the time HyFib recorded each item, in calendar days of the company’s time zone (Settings → Company). A period runs from midnight at the start of its first day to midnight after its last day, with daylight-saving changes applied.',
   'Includes messages canceled before sending; they are shown separately.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('messaging.sent_rate', 1, 'Sent', 'rate',
   'Share of outbound messages that Meta reported as sent (or delivered or read).',
   'Outbound messages whose status is sent, delivered or read.',
   'Outbound messages, excluding those canceled before sending.',
   NULL,
   'Counted by the time HyFib recorded each item, in calendar days of the company’s time zone (Settings → Company). A period runs from midnight at the start of its first day to midnight after its last day, with daylight-saving changes applied.',
   'Messages without a status webhook yet count as not sent; they appear as "in progress".',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('messaging.delivered_rate', 1, 'Delivered', 'rate',
   'Share of sent messages that reached the customer’s phone.',
   'Outbound messages whose status is delivered or read.',
   'Outbound messages whose status is sent, delivered or read.',
   NULL,
   'Counted by the time HyFib recorded each item, in calendar days of the company’s time zone (Settings → Company). A period runs from midnight at the start of its first day to midnight after its last day, with daylight-saving changes applied.',
   'A delivered status can arrive late; the rate can rise for recent days.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('messaging.read_rate', 1, 'Read', 'rate',
   'Share of delivered messages that Meta reported as read.',
   'Outbound messages whose status is read.',
   'Outbound messages whose status is delivered or read.',
   NULL,
   'Counted by the time HyFib recorded each item, in calendar days of the company’s time zone (Settings → Company). A period runs from midnight at the start of its first day to midnight after its last day, with daylight-saving changes applied.',
   'Customers can turn read receipts off, so this is a lower bound of the true read rate.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('messaging.failure_rate', 1, 'Failed', 'rate',
   'Share of outbound messages that failed or whose outcome is unknown (a dropped connection after the request left; never resent automatically).',
   'Outbound messages whose status is failed or unknown outcome.',
   'Outbound messages, excluding those canceled before sending.',
   NULL,
   'Counted by the time HyFib recorded each item, in calendar days of the company’s time zone (Settings → Company). A period runs from midnight at the start of its first day to midnight after its last day, with daylight-saving changes applied.',
   'Failure codes are Meta’s; see the breakdown for each code.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('messaging.estimated_cost', 1, 'Estimated Meta charges', 'money',
   'Estimated charges for delivered messages that Meta marked billable, at the list price of the published rate card for the company’s billing currency (Settings → Messaging), by the recipient’s market and Meta’s pricing category. Meta bills the company directly; HyFib does not charge this.',
   'Sum of the list prices of delivered, billable messages.',
   NULL,
   'The rate card in force when each message was recorded.',
   'Counted by the time HyFib recorded each item, in calendar days of the company’s time zone (Settings → Company). A period runs from midnight at the start of its first day to midnight after its last day, with daylight-saving changes applied.',
   'An estimate: volume-tier discounts are not applied and Meta’s invoice is authoritative. Messages Meta has not priced yet, recipients whose market has no rate, and erased recipients are listed as unpriced, not guessed.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('inbox.open_conversations', 1, 'Open conversations', 'count',
   'Conversations that are open or pending.',
   'Conversations whose status is open or pending.',
   NULL,
   NULL,
   NULL,
   'None.',
   'The state when the page loads.', true),
  ('inbox.unassigned', 1, 'Unassigned', 'count',
   'Open or pending conversations that no member is assigned to.',
   'Open or pending conversations without an assignee.',
   NULL,
   NULL,
   NULL,
   'None.',
   'The state when the page loads.', true),
  ('inbox.waiting', 1, 'Waiting for a reply', 'count',
   'Conversations whose customer is waiting: their latest messages have no reply from a member and the conversation is not resolved.',
   'Open reply turns.',
   NULL,
   NULL,
   NULL,
   'Reply turns are recorded from the release of reports onwards.',
   'The state when the page loads.', true),
  ('inbox.oldest_wait', 1, 'Longest wait', 'duration',
   'How long the longest-waiting customer has been waiting for a reply.',
   'Time since the start of the oldest open reply turn.',
   NULL,
   NULL,
   NULL,
   'Measured in absolute time; there is no business-hours calendar yet.',
   'The state when the page loads.', true),
  ('inbox.windows_closing', 1, 'Reply windows closing', 'count',
   'Waiting conversations whose 24-hour customer service window closes within 2 hours. After it closes only approved templates can be sent.',
   'Open reply turns whose customer’s last message was 22 to 24 hours ago.',
   NULL,
   'The window closes 24 hours after the customer’s last message.',
   NULL,
   'None.',
   'The state when the page loads.', true),
  ('inbox.first_response_time', 1, 'First response time', 'duration',
   'Time from the start of a reply turn to the first reply by a member, reported as the median and the 90th percentile.',
   'Reply times of answered turns.',
   'Turns that started in the period and were answered.',
   'From when HyFib received the customer’s first waiting message to when the member sent the reply, in absolute time (no business-hours calendar yet).',
   'A reply turn starts with the first customer message that has no reply from a member yet and ends when a member replies or the conversation is resolved. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Turns still waiting are not in the median; see Waiting. A reply counts when the member sends it, even if WhatsApp later rejects it (see Failed). Reply turns are recorded from the release of reports onwards.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('inbox.within_target', 1, 'Answered within target', 'rate',
   'Share of reply turns answered within the company’s first-response target (Settings → Messaging).',
   'Turns answered within the target.',
   'Turns that started in the period and were answered or have waited longer than the target. Turns resolved without a reply and turns still within the target are left out.',
   'The target, in absolute time.',
   'A reply turn starts with the first customer message that has no reply from a member yet and ends when a member replies or the conversation is resolved. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'Shown only when a target is set.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('inbox.resolved_without_reply', 1, 'Resolved without a reply', 'count',
   'Reply turns closed by resolving the conversation without replying, for example after a customer’s thank-you.',
   'Turns that ended because the conversation was resolved.',
   NULL,
   NULL,
   'A reply turn starts with the first customer message that has no reply from a member yet and ends when a member replies or the conversation is resolved. Turns are counted by the time they started, in calendar days of the company’s time zone.',
   'None.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('agent.replies', 1, 'Replies sent', 'count',
   'Messages the member sent in conversations: text replies and templates.',
   'Outbound messages sent by the member.',
   NULL,
   NULL,
   'Counted by the time HyFib recorded each item, in calendar days of the company’s time zone (Settings → Company). A period runs from midnight at the start of its first day to midnight after its last day, with daylight-saving changes applied.',
   'Includes messages that failed or were canceled before sending.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('agent.turns_answered', 1, 'Turns answered', 'count',
   'Reply turns the member answered first.',
   'Turns that ended with the member’s reply.',
   NULL,
   NULL,
   'Counted by the time the turn was answered, in calendar days of the company’s time zone.',
   'Reply turns are recorded from the release of reports onwards.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('agent.first_response_time', 1, 'Median first response', 'duration',
   'Median reply time of the turns the member answered.',
   'Reply times of the turns the member answered.',
   'Turns the member answered in the period.',
   'Absolute time; no business-hours calendar yet.',
   'Counted by the time the turn was answered, in calendar days of the company’s time zone.',
   'Reply turns are recorded from the release of reports onwards.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('agent.resolved', 1, 'Resolved', 'count',
   'Times the member marked a conversation resolved.',
   'Resolve actions in the audit log by the member.',
   NULL,
   NULL,
   'Counted by the time HyFib recorded each item, in calendar days of the company’s time zone (Settings → Company). A period runs from midnight at the start of its first day to midnight after its last day, with daylight-saving changes applied.',
   'Counted from the release of reports; earlier resolutions were not recorded per member.',
   'Computed when the page loads from HyFib’s records. Delivery statuses come from Meta’s webhooks and can arrive minutes (occasionally days) later.', true),
  ('automation.outcomes', 1, 'Automation success and failure', 'rate',
   'Runs of automations that completed or failed.',
   '—',
   NULL,
   NULL,
   NULL,
   'Not measured: automations are not available yet (planned for Phase 4).',
   'Not available.', false),
  ('crm.deal_outcomes', 1, 'Deal outcomes', 'count',
   'Deals won and lost, and their value.',
   '—',
   NULL,
   NULL,
   NULL,
   'Not measured: CRM deals are not available yet (planned for Phase 4).',
   'Not available.', false),
  ('contacts.retention', 1, 'Retention cohorts', 'rate',
   'Share of customers from each starting month who are still active later.',
   '—',
   NULL,
   NULL,
   NULL,
   'Not computed: HyFib has no record yet of what makes a customer active (orders or deals), and message activity alone would overstate retention.',
   'Not available.', false);

-- Campaign estimate currency ----------------------------------------------------------------------
-- Fixed the first time a campaign prices a message (the budget currency, else the company's billing
-- currency then), so changing the company's currency later cannot mix currencies within one
-- campaign's estimates or relabel them.
ALTER TABLE app.campaigns ADD COLUMN estimate_currency text CHECK (estimate_currency ~ '^[A-Z]{3}$');
GRANT UPDATE (estimate_currency) ON app.campaigns TO w360_app;

-- First-response target ---------------------------------------------------------------------------
-- Minutes within which the company aims to answer a waiting customer; reports show the share of
-- reply turns answered within it. NULL means no target is set.
ALTER TABLE app.messaging_settings
  ADD COLUMN first_response_target_minutes smallint CHECK (first_response_target_minutes BETWEEN 1 AND 1440);
GRANT UPDATE (first_response_target_minutes) ON app.messaging_settings TO w360_app;

-- Reply turns -------------------------------------------------------------------------------------
-- A turn starts with the first customer message that has no reply from a member yet (reactions and
-- system notices do not count) and ends when a member replies (text or template) or the conversation
-- is resolved. Triggers on app.messages and app.conversations maintain turns for every write path,
-- so response times do not depend on each caller remembering to record them. Turns hold only
-- timestamps and ids (no message content), so contact erasure leaves them in place.
CREATE TABLE app.conversation_turns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  -- The customer message that started the turn and the member reply that ended it (set to NULL if
  -- a retention purge ever deletes the message).
  first_message_id uuid,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IN ('replied', 'resolved')),
  -- The member who replied or resolved (NULL for a resolve without a member, such as a future
  -- automation).
  ended_by_membership_id uuid,
  reply_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_turns_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT conversation_turns_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES app.conversations (tenant_id, id),
  CONSTRAINT conversation_turns_first_message_fk FOREIGN KEY (tenant_id, first_message_id)
    REFERENCES app.messages (tenant_id, id) ON DELETE SET NULL (first_message_id),
  CONSTRAINT conversation_turns_reply_message_fk FOREIGN KEY (tenant_id, reply_message_id)
    REFERENCES app.messages (tenant_id, id) ON DELETE SET NULL (reply_message_id),
  CONSTRAINT conversation_turns_member_fk FOREIGN KEY (tenant_id, ended_by_membership_id)
    REFERENCES app.memberships (tenant_id, id),
  CONSTRAINT conversation_turns_end CHECK (
    (ended_at IS NULL AND end_reason IS NULL AND ended_by_membership_id IS NULL AND reply_message_id IS NULL)
    OR (ended_at IS NOT NULL AND end_reason = 'replied')
    OR (ended_at IS NOT NULL AND end_reason = 'resolved' AND reply_message_id IS NULL)),
  CONSTRAINT conversation_turns_order CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- At most one open turn per conversation (also the conflict target that makes opening idempotent).
CREATE UNIQUE INDEX conversation_turns_open_uq ON app.conversation_turns (tenant_id, conversation_id)
  WHERE ended_at IS NULL;
CREATE INDEX conversation_turns_started_idx ON app.conversation_turns (tenant_id, started_at);
CREATE INDEX conversation_turns_ended_idx ON app.conversation_turns (tenant_id, ended_at)
  WHERE ended_at IS NOT NULL;

-- A closed turn never changes, an open turn can only be closed, and what started it is fixed. The
-- retention maintenance function (w360.allow_retention_purge, see app.reject_mutation) may delete
-- turns or clear their message references.
CREATE FUNCTION app.guard_conversation_turn() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reply turns cannot be deleted' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'a closed reply turn cannot change' USING ERRCODE = 'W3403';
  END IF;
  IF NEW.ended_at IS NULL
     OR (NEW.id, NEW.tenant_id, NEW.conversation_id, NEW.first_message_id, NEW.started_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.conversation_id, OLD.first_message_id, OLD.started_at, OLD.created_at) THEN
    RAISE EXCEPTION 'an open reply turn can only be closed' USING ERRCODE = 'W3403';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER conversation_turns_guard BEFORE UPDATE OR DELETE ON app.conversation_turns
  FOR EACH ROW EXECUTE FUNCTION app.guard_conversation_turn();

-- Opens a turn on a customer message and closes it on a member's reply. Runs with the privileges
-- of the writer (the tenant-scoped runtime role), so RLS applies to the turn rows as well.
CREATE FUNCTION app.track_conversation_turn() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.direction = 'inbound' AND NEW.sender_type = 'contact' AND NEW.type NOT IN ('reaction', 'system') THEN
    INSERT INTO app.conversation_turns (id, tenant_id, conversation_id, first_message_id, started_at)
    VALUES (gen_random_uuid(), NEW.tenant_id, NEW.conversation_id, NEW.id, NEW.created_at)
    ON CONFLICT (tenant_id, conversation_id) WHERE ended_at IS NULL DO NOTHING;
  ELSIF NEW.direction = 'outbound' AND NEW.sender_type = 'agent' THEN
    UPDATE app.conversation_turns t
       SET ended_at = greatest(NEW.created_at, t.started_at), end_reason = 'replied',
           ended_by_membership_id = NEW.sender_membership_id, reply_message_id = NEW.id
     WHERE t.tenant_id = NEW.tenant_id AND t.conversation_id = NEW.conversation_id AND t.ended_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER messages_track_turn AFTER INSERT ON app.messages
  FOR EACH ROW WHEN (NEW.sender_type IN ('contact', 'agent'))
  EXECUTE FUNCTION app.track_conversation_turn();

-- Closes the open turn when a conversation is resolved, crediting the acting member if any.
CREATE FUNCTION app.close_turn_on_resolve() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  UPDATE app.conversation_turns t
     SET ended_at = greatest(coalesce(NEW.resolved_at, now()), t.started_at), end_reason = 'resolved',
         ended_by_membership_id = (SELECT m.id FROM app.memberships m
                                    WHERE m.tenant_id = NEW.tenant_id AND m.user_id = app.current_user_id())
   WHERE t.tenant_id = NEW.tenant_id AND t.conversation_id = NEW.id AND t.ended_at IS NULL;
  RETURN NULL;
END
$$;
CREATE TRIGGER conversations_close_turn AFTER UPDATE OF status ON app.conversations
  FOR EACH ROW WHEN (NEW.status = 'resolved' AND OLD.status IS DISTINCT FROM 'resolved')
  EXECUTE FUNCTION app.close_turn_on_resolve();

SELECT ops.apply_tenant_rls('app.conversation_turns');
GRANT SELECT, INSERT ON app.conversation_turns TO w360_app;
GRANT UPDATE (ended_at, end_reason, ended_by_membership_id, reply_message_id) ON app.conversation_turns TO w360_app;
