-- 0006_campaigns: saved segments, campaigns with audience snapshots and per-recipient outcomes,
-- campaign history, company campaign settings (approval, marketing frequency cap, estimate
-- currency), and platform-maintained provider rate cards used for cost estimates.
--
-- A campaign's audience is frozen when it is submitted (the snapshot), but every recipient is
-- checked again when the campaign runner queues them (consent, suppression, erasure, frequency cap,
-- variables, spending cap) and once more by the send worker right before dispatch (consent,
-- suppression, template approval, campaign still running). Campaign messages use the Phase 2 send
-- pipeline (messages + send_intents), so unknown outcomes are never resent automatically.

-- Company campaign settings -----------------------------------------------------------------------
ALTER TABLE app.messaging_settings
  -- When true, a campaign needs approval by a member other than the one who submitted it.
  ADD COLUMN campaign_approval_required boolean NOT NULL DEFAULT false,
  -- At most `marketing_cap_count` marketing templates per contact in `marketing_cap_days` days;
  -- campaigns skip contacts over the cap (inbox sends count towards it but are not blocked).
  ADD COLUMN marketing_cap_count smallint CHECK (marketing_cap_count BETWEEN 1 AND 50),
  ADD COLUMN marketing_cap_days smallint CHECK (marketing_cap_days BETWEEN 1 AND 30),
  -- The currency Meta bills the company in, used to pick rate cards for estimates.
  ADD COLUMN cost_currency text CHECK (cost_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT messaging_settings_cap_pair CHECK ((marketing_cap_count IS NULL) = (marketing_cap_days IS NULL));
GRANT UPDATE (campaign_approval_required, marketing_cap_count, marketing_cap_days, cost_currency)
  ON app.messaging_settings TO w360_app;

-- Saved segments ----------------------------------------------------------------------------------
-- Dynamic: the definition (validated by the service) is evaluated whenever the segment is used.
-- Segments are archived, not deleted, because campaigns reference them.
CREATE TABLE app.segments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND pg_column_size(definition) <= 8192),
  version integer NOT NULL DEFAULT 0,
  created_by_user_id text REFERENCES auth.users (id),
  updated_by_user_id text REFERENCES auth.users (id),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT segments_tenant_id_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX segments_name_uq ON app.segments (tenant_id, lower(name)) WHERE archived_at IS NULL;
CREATE TRIGGER segments_touch BEFORE UPDATE ON app.segments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Campaigns ---------------------------------------------------------------------------------------
CREATE TABLE app.campaigns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'scheduled', 'running',
    'paused', 'completed', 'canceled')),
  channel_account_id uuid,
  template_id uuid,
  -- How each template variable is filled (static text, contact name or a custom field, with a
  -- fallback); validated by the service against the template.
  variables jsonb NOT NULL DEFAULT '{"header": [], "body": []}'::jsonb
    CHECK (jsonb_typeof(variables) = 'object' AND pg_column_size(variables) <= 8192),
  -- Audience: a saved segment or an inline definition (drafts may have neither yet).
  segment_id uuid,
  audience_definition jsonb CHECK (jsonb_typeof(audience_definition) = 'object'
    AND pg_column_size(audience_definition) <= 8192),
  -- The definition actually evaluated for the snapshot (copied from the segment at submission).
  audience_used jsonb CHECK (jsonb_typeof(audience_used) = 'object' AND pg_column_size(audience_used) <= 8192),
  -- Scheduling: a wall-clock time in an IANA time zone; `scheduled_at` is the resolved instant.
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 64),
  schedule_kind text NOT NULL DEFAULT 'now' CHECK (schedule_kind IN ('now', 'later')),
  scheduled_local timestamp,
  scheduled_at timestamptz,
  -- Set when the wall-clock time fell into a daylight-saving gap or overlap.
  schedule_adjustment text CHECK (schedule_adjustment IN ('gap_shifted', 'ambiguous_earlier')),
  -- Optional daily sending window in `timezone` (end before start wraps past midnight).
  window_start time,
  window_end time,
  -- Guardrails: pacing below the number's rate, a message cap and an estimated spending cap.
  rate_per_minute integer CHECK (rate_per_minute BETWEEN 1 AND 6000),
  max_messages integer CHECK (max_messages BETWEEN 1 AND 1000000),
  budget_micros bigint CHECK (budget_micros > 0),
  budget_currency text CHECK (budget_currency ~ '^[A-Z]{3}$'),
  -- Sending stops this many hours after the campaign starts; the rest is recorded as expired.
  stop_after_hours smallint NOT NULL DEFAULT 24 CHECK (stop_after_hours BETWEEN 1 AND 168),
  submitted_by_user_id text REFERENCES auth.users (id),
  submitted_at timestamptz,
  approved_by_user_id text REFERENCES auth.users (id),
  approved_at timestamptz,
  review_note text CHECK (char_length(review_note) <= 500),
  -- The member whose authority the sends run under (their removal pauses the campaign).
  launched_by_user_id text REFERENCES auth.users (id),
  started_at timestamptz,
  deadline_at timestamptz,
  next_run_at timestamptz,
  paused_at timestamptz,
  pause_reason text CHECK (pause_reason IN ('manual', 'budget_reached', 'message_cap_reached',
    'template_not_approved', 'channel_inactive', 'launcher_removed', 'launcher_not_permitted',
    'rate_card_missing')),
  completed_at timestamptz,
  completion_reason text CHECK (completion_reason IN ('all_processed', 'deadline_passed')),
  canceled_at timestamptz,
  canceled_by_user_id text REFERENCES auth.users (id),
  -- Progress counters, updated in the same transactions as the recipients they count.
  audience_count integer NOT NULL DEFAULT 0 CHECK (audience_count >= 0),
  queued_count integer NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  -- Sum of the estimated prices of queued messages (millionths of `budget_currency` or of the
  -- company's estimate currency); an estimate, never a charge.
  spent_estimate_micros bigint NOT NULL DEFAULT 0 CHECK (spent_estimate_micros >= 0),
  version integer NOT NULL DEFAULT 0,
  created_by_user_id text REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT campaigns_channel_fk FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES app.channel_accounts (tenant_id, id),
  CONSTRAINT campaigns_template_fk FOREIGN KEY (tenant_id, template_id)
    REFERENCES app.message_templates (tenant_id, id),
  CONSTRAINT campaigns_segment_fk FOREIGN KEY (tenant_id, segment_id) REFERENCES app.segments (tenant_id, id),
  CONSTRAINT campaigns_one_audience CHECK (segment_id IS NULL OR audience_definition IS NULL),
  CONSTRAINT campaigns_budget_pair CHECK ((budget_micros IS NULL) = (budget_currency IS NULL)),
  CONSTRAINT campaigns_window_pair CHECK ((window_start IS NULL) = (window_end IS NULL)
    AND (window_start IS NULL OR window_start <> window_end)),
  CONSTRAINT campaigns_schedule CHECK (schedule_kind = 'now' OR scheduled_local IS NOT NULL),
  CONSTRAINT campaigns_submitted_complete CHECK (status IN ('draft', 'canceled')
    OR (channel_account_id IS NOT NULL AND template_id IS NOT NULL AND audience_used IS NOT NULL))
);
CREATE INDEX campaigns_list_idx ON app.campaigns (tenant_id, created_at DESC, id DESC);
CREATE INDEX campaigns_due_idx ON app.campaigns (next_run_at) WHERE status IN ('scheduled', 'running');
CREATE TRIGGER campaigns_touch BEFORE UPDATE ON app.campaigns
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- One row per contact in the snapshot. `state` is the campaign's side (pending → queued, or
-- skipped with a reason, or canceled); delivery progress is read from the linked message. No
-- personal data is copied here: phone numbers and variable values are read live when queueing.
CREATE TABLE app.campaign_recipients (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'queued', 'skipped', 'canceled')),
  skip_reason text CHECK (skip_reason IN ('contact_erased', 'no_phone', 'suppressed', 'opted_out',
    'no_marketing_opt_in', 'missing_variable', 'frequency_capped', 'cost_unknown', 'expired')),
  message_id uuid,
  -- Rate-card market of the recipient's number and the estimated price when queued (null: no rate).
  market text CHECK (char_length(market) <= 80),
  estimated_cost_micros bigint CHECK (estimated_cost_micros >= 0),
  queued_at timestamptz,
  -- Attribution (last touch within 72 hours of queueing): first reply and first marketing opt-out.
  replied_at timestamptz,
  opted_out_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_recipients_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT campaign_recipients_contact_uq UNIQUE (tenant_id, campaign_id, contact_id),
  CONSTRAINT campaign_recipients_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES app.campaigns (tenant_id, id),
  CONSTRAINT campaign_recipients_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES app.contacts (tenant_id, id),
  CONSTRAINT campaign_recipients_message_fk FOREIGN KEY (tenant_id, message_id)
    REFERENCES app.messages (tenant_id, id),
  CONSTRAINT campaign_recipients_skip_reason CHECK ((state = 'skipped') = (skip_reason IS NOT NULL))
);
CREATE INDEX campaign_recipients_batch_idx ON app.campaign_recipients (tenant_id, campaign_id, state, id);
CREATE INDEX campaign_recipients_touch_idx ON app.campaign_recipients (tenant_id, contact_id, queued_at DESC)
  WHERE queued_at IS NOT NULL;
CREATE UNIQUE INDEX campaign_recipients_message_uq ON app.campaign_recipients (tenant_id, message_id)
  WHERE message_id IS NOT NULL;

CREATE TABLE app.campaign_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('created', 'edited', 'submitted', 'withdrawn', 'approved', 'rejected',
    'scheduled', 'started', 'paused', 'resumed', 'canceled', 'completed', 'test_sent')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 2048),
  actor_user_id text REFERENCES auth.users (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_events_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT campaign_events_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES app.campaigns (tenant_id, id)
);
CREATE INDEX campaign_events_campaign_idx ON app.campaign_events (tenant_id, campaign_id, occurred_at DESC, id DESC);
CREATE TRIGGER campaign_events_append_only BEFORE UPDATE OR DELETE ON app.campaign_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Campaign messages are ordinary outbound messages tagged with their campaign.
ALTER TABLE app.messages ADD COLUMN campaign_id uuid;
ALTER TABLE app.messages ADD CONSTRAINT messages_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
  REFERENCES app.campaigns (tenant_id, id);
CREATE INDEX messages_campaign_idx ON app.messages (tenant_id, campaign_id) WHERE campaign_id IS NOT NULL;
-- Frequency caps and reply attribution look up a contact's threads across numbers.
CREATE INDEX conversations_contact_idx ON app.conversations (tenant_id, contact_id);
-- Per-contact lookups (snapshots, segment conditions) must use per-contact indexes even while
-- statistics are stale after a bulk import. With stale statistics the planner used the
-- (tenant_id, purpose, status) consent index and the (tenant_id, whatsapp_account_id, wa_id)
-- identity index, filtering on contact_id, which made a 10,000-contact snapshot quadratic
-- (found by the 10,000-recipient integration test).
DROP INDEX app.contact_consents_status_idx;
CREATE INDEX contact_identities_contact_waba_idx
  ON app.contact_identities (tenant_id, contact_id, whatsapp_account_id);
DROP INDEX app.contact_identities_contact_idx;

-- Row level security and runtime privileges -----------------------------------------------------------
SELECT ops.apply_tenant_rls('app.segments');
SELECT ops.apply_tenant_rls('app.campaigns');
SELECT ops.apply_tenant_rls('app.campaign_recipients');
SELECT ops.apply_tenant_rls('app.campaign_events');

GRANT SELECT, INSERT ON app.segments TO w360_app;
GRANT UPDATE (name, definition, version, updated_by_user_id, archived_at, updated_at) ON app.segments TO w360_app;
GRANT SELECT, INSERT ON app.campaigns TO w360_app;
GRANT UPDATE (name, status, channel_account_id, template_id, variables, segment_id, audience_definition,
  audience_used, timezone, schedule_kind, scheduled_local, scheduled_at, schedule_adjustment, window_start,
  window_end, rate_per_minute, max_messages, budget_micros, budget_currency, stop_after_hours,
  submitted_by_user_id, submitted_at, approved_by_user_id, approved_at, review_note, launched_by_user_id,
  started_at, deadline_at, next_run_at, paused_at, pause_reason, completed_at, completion_reason, canceled_at,
  canceled_by_user_id, audience_count, queued_count, skipped_count, spent_estimate_micros, version, updated_at)
  ON app.campaigns TO w360_app;
-- Pending snapshot rows are deleted when a submission is withdrawn or rejected (nothing was sent).
GRANT SELECT, INSERT, DELETE ON app.campaign_recipients TO w360_app;
GRANT UPDATE (state, skip_reason, message_id, market, estimated_cost_micros, queued_at, replied_at, opted_out_at)
  ON app.campaign_recipients TO w360_app;
GRANT SELECT, INSERT ON app.campaign_events TO w360_app;

-- Campaign runner sweep input (ids only, across companies) --------------------------------------------
CREATE POLICY definer_read ON app.campaigns FOR SELECT TO w360_definer USING (true);
GRANT SELECT (tenant_id, id, status, scheduled_at, next_run_at, launched_by_user_id) ON app.campaigns TO w360_definer;

-- Campaigns of active companies whose runner should tick: scheduled ones that are due, and running
-- ones whose next tick is more than 30 seconds late (a lost signal). The runner itself re-checks
-- everything under the campaign's row lock.
CREATE FUNCTION ops.campaigns_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, campaign_id uuid, launched_by_user_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT c.tenant_id, c.id, c.launched_by_user_id
    FROM app.campaigns c
    JOIN app.tenants t ON t.id = c.tenant_id AND t.status = 'active'
   WHERE (c.status = 'scheduled' AND c.scheduled_at <= now())
      OR (c.status = 'running' AND (c.next_run_at IS NULL OR c.next_run_at <= now() - interval '30 seconds'))
   ORDER BY c.next_run_at NULLS FIRST
   LIMIT least(greatest(p_limit, 1), 500)
$$;
GRANT EXECUTE ON FUNCTION ops.campaigns_due(integer) TO w360_app;
ALTER FUNCTION ops.campaigns_due(integer) OWNER TO w360_definer;

-- Provider rate cards (platform data, not tenant data) ---------------------------------------------------
-- Entered by platform administrators from the provider's published rate cards (source URL
-- required); nothing is seeded. Prices are millionths of the currency's major unit, because
-- per-message prices are fractions of a minor unit. A published card is immutable: corrections are
-- a withdrawal plus a new card, so earlier versions stay visible.
CREATE TABLE ops.rate_cards (
  id uuid PRIMARY KEY,
  provider text NOT NULL DEFAULT 'meta_whatsapp' CHECK (provider = 'meta_whatsapp'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from timestamptz NOT NULL,
  source_url text NOT NULL CHECK (source_url ~ '^https://[^[:space:]]+$' AND char_length(source_url) <= 500),
  notes text CHECK (char_length(notes) <= 1000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'withdrawn')),
  created_by_user_id text NOT NULL REFERENCES auth.users (id),
  published_by_user_id text REFERENCES auth.users (id),
  published_at timestamptz,
  withdrawn_by_user_id text REFERENCES auth.users (id),
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rate_cards_published_uq ON ops.rate_cards (provider, currency, effective_from)
  WHERE status = 'published';

-- Calling-code prefixes (E.164 digits without '+') of each market; the longest matching prefix wins.
CREATE TABLE ops.rate_card_prefixes (
  rate_card_id uuid NOT NULL REFERENCES ops.rate_cards (id),
  prefix text NOT NULL CHECK (prefix ~ '^[1-9][0-9]{0,5}$'),
  market text NOT NULL CHECK (char_length(btrim(market)) BETWEEN 1 AND 80),
  PRIMARY KEY (rate_card_id, prefix)
);

-- `tier_from`: first monthly volume the price applies to (0 for the list price).
CREATE TABLE ops.rate_card_prices (
  rate_card_id uuid NOT NULL REFERENCES ops.rate_cards (id),
  market text NOT NULL CHECK (char_length(btrim(market)) BETWEEN 1 AND 80),
  category text NOT NULL CHECK (category IN ('marketing', 'utility', 'authentication',
    'authentication_international', 'service')),
  tier_from bigint NOT NULL DEFAULT 0 CHECK (tier_from >= 0),
  price_micros bigint NOT NULL CHECK (price_micros BETWEEN 0 AND 1000000000),
  PRIMARY KEY (rate_card_id, market, category, tier_from)
);

-- Only the status moves (draft → published → withdrawn, or draft → withdrawn); publishing needs
-- prices, and a prefix for every priced market.
CREATE FUNCTION ops.guard_rate_card() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF (NEW.id, NEW.provider, NEW.currency, NEW.effective_from, NEW.source_url, NEW.notes, NEW.created_by_user_id,
      NEW.created_at) IS DISTINCT FROM
     (OLD.id, OLD.provider, OLD.currency, OLD.effective_from, OLD.source_url, OLD.notes, OLD.created_by_user_id,
      OLD.created_at) THEN
    RAISE EXCEPTION 'rate cards are immutable' USING ERRCODE = 'W3403';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('published', 'withdrawn'))
            OR (OLD.status = 'published' AND NEW.status = 'withdrawn')) THEN
      RAISE EXCEPTION 'invalid rate card status change' USING ERRCODE = 'W3403';
    END IF;
    IF NEW.status = 'published' THEN
      IF NOT EXISTS (SELECT 1 FROM ops.rate_card_prices p WHERE p.rate_card_id = NEW.id) THEN
        RAISE EXCEPTION 'a rate card needs prices before it is published' USING ERRCODE = 'W3403';
      END IF;
      IF EXISTS (SELECT 1 FROM ops.rate_card_prices p
                  WHERE p.rate_card_id = NEW.id
                    AND NOT EXISTS (SELECT 1 FROM ops.rate_card_prefixes x
                                     WHERE x.rate_card_id = NEW.id AND x.market = p.market)) THEN
        RAISE EXCEPTION 'every priced market needs a calling-code prefix' USING ERRCODE = 'W3403';
      END IF;
    END IF;
  ELSIF (NEW.published_by_user_id, NEW.published_at, NEW.withdrawn_by_user_id, NEW.withdrawn_at) IS DISTINCT FROM
        (OLD.published_by_user_id, OLD.published_at, OLD.withdrawn_by_user_id, OLD.withdrawn_at) THEN
    RAISE EXCEPTION 'rate cards are immutable' USING ERRCODE = 'W3403';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rate_cards_guard BEFORE UPDATE ON ops.rate_cards
  FOR EACH ROW EXECUTE FUNCTION ops.guard_rate_card();
CREATE TRIGGER rate_cards_no_delete BEFORE DELETE ON ops.rate_cards
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Prices and prefixes can only be added while their card is a draft.
CREATE FUNCTION ops.guard_rate_card_rows() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_card uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.rate_card_id ELSE NEW.rate_card_id END;
BEGIN
  IF TG_OP <> 'INSERT' OR NOT EXISTS (SELECT 1 FROM ops.rate_cards c WHERE c.id = v_card AND c.status = 'draft') THEN
    RAISE EXCEPTION 'rate card rows can only be added to a draft' USING ERRCODE = 'W3403';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rate_card_prefixes_guard BEFORE INSERT OR UPDATE OR DELETE ON ops.rate_card_prefixes
  FOR EACH ROW EXECUTE FUNCTION ops.guard_rate_card_rows();
CREATE TRIGGER rate_card_prices_guard BEFORE INSERT OR UPDATE OR DELETE ON ops.rate_card_prices
  FOR EACH ROW EXECUTE FUNCTION ops.guard_rate_card_rows();

ALTER TABLE ops.rate_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.rate_cards FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.rate_card_prefixes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.rate_card_prefixes FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.rate_card_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.rate_card_prices FORCE ROW LEVEL SECURITY;
-- Companies read published cards (and withdrawn ones, so history stays explainable).
CREATE POLICY app_read ON ops.rate_cards FOR SELECT TO w360_app USING (status IN ('published', 'withdrawn'));
CREATE POLICY app_read ON ops.rate_card_prefixes FOR SELECT TO w360_app
  USING (EXISTS (SELECT 1 FROM ops.rate_cards c WHERE c.id = rate_card_id));
CREATE POLICY app_read ON ops.rate_card_prices FOR SELECT TO w360_app
  USING (EXISTS (SELECT 1 FROM ops.rate_cards c WHERE c.id = rate_card_id));
CREATE POLICY platform_all ON ops.rate_cards TO w360_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_all ON ops.rate_card_prefixes TO w360_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_all ON ops.rate_card_prices TO w360_platform USING (true) WITH CHECK (true);
GRANT SELECT ON ops.rate_cards, ops.rate_card_prefixes, ops.rate_card_prices TO w360_app;
GRANT SELECT, INSERT ON ops.rate_cards, ops.rate_card_prefixes, ops.rate_card_prices TO w360_platform;
GRANT UPDATE (status, published_by_user_id, published_at, withdrawn_by_user_id, withdrawn_at)
  ON ops.rate_cards TO w360_platform;
