-- 0003_messaging: WhatsApp accounts and numbers, provider asset bindings, contacts with
-- business-scoped identities, conversations, messages, status history, send intents, media,
-- durable tenant event log, webhook receipts and quarantine.
--
-- Every tenant table: tenant_id NOT NULL, UNIQUE (tenant_id, id), composite FKs to tenant parents
-- (referential checks bypass RLS, so the composite key is what keeps references inside a company),
-- FORCE RLS via ops.apply_tenant_rls, least-privilege grants.

-- WhatsApp Business Accounts (WABA) ---------------------------------------------------------------
CREATE TABLE app.whatsapp_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  waba_id text NOT NULL CHECK (waba_id ~ '^[0-9]{1,32}$'),
  business_id text CHECK (business_id ~ '^[0-9]{1,32}$'),
  name text CHECK (char_length(name) <= 200),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'needs_reconnect', 'disconnected')),
  -- Business integration system-user token, AES-256-GCM with AAD
  -- "tenant:<tenant_id>|whatsapp_account:<id>". Never returned to browsers.
  credential_ciphertext text,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  token_checked_at timestamptz,
  connected_by_user_id text REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_accounts_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT whatsapp_accounts_tenant_waba_uq UNIQUE (tenant_id, waba_id)
);
CREATE TRIGGER whatsapp_accounts_touch BEFORE UPDATE ON app.whatsapp_accounts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Phone numbers (channels) -------------------------------------------------------------------------
CREATE TABLE app.channel_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  whatsapp_account_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'meta_whatsapp' CHECK (provider IN ('meta_whatsapp')),
  phone_number_id text NOT NULL CHECK (phone_number_id ~ '^[0-9]{1,32}$'),
  display_phone_number text CHECK (char_length(display_phone_number) <= 32),
  verified_name text CHECK (char_length(verified_name) <= 200),
  status text NOT NULL DEFAULT 'onboarding'
    CHECK (status IN ('onboarding', 'active', 'needs_reconnect', 'disconnected', 'failed')),
  onboarding_step text CHECK (onboarding_step IN ('subscribe_app', 'register_number', 'health_check', 'done')),
  onboarding_error text CHECK (char_length(onboarding_error) <= 1000),
  quality_rating text CHECK (char_length(quality_rating) <= 32),
  name_status text CHECK (char_length(name_status) <= 64),
  code_verification_status text CHECK (char_length(code_verification_status) <= 64),
  -- Two-step verification PIN we generated for registration (encrypted).
  registration_pin_ciphertext text,
  health_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_accounts_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT channel_accounts_tenant_phone_uq UNIQUE (tenant_id, phone_number_id),
  CONSTRAINT channel_accounts_waba_fk FOREIGN KEY (tenant_id, whatsapp_account_id)
    REFERENCES app.whatsapp_accounts (tenant_id, id)
);
CREATE TRIGGER channel_accounts_touch BEFORE UPDATE ON app.channel_accounts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Embedded Signup sessions (CSRF state bound to user, auth session and company) --------------------
CREATE TABLE app.channel_onboarding_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id text NOT NULL REFERENCES auth.users (id),
  auth_session_id text NOT NULL CHECK (char_length(auth_session_id) <= 200),
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'exchanging', 'completed', 'failed', 'expired')),
  failure_reason text CHECK (char_length(failure_reason) <= 1000),
  result_whatsapp_account_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_onboarding_sessions_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT channel_onboarding_sessions_result_fk FOREIGN KEY (tenant_id, result_whatsapp_account_id)
    REFERENCES app.whatsapp_accounts (tenant_id, id)
);
CREATE UNIQUE INDEX channel_onboarding_sessions_state_uq ON app.channel_onboarding_sessions (state_hash);
CREATE TRIGGER channel_onboarding_sessions_touch BEFORE UPDATE ON app.channel_onboarding_sessions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Contacts ------------------------------------------------------------------------------------------
CREATE TABLE app.contacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  display_name text CHECK (char_length(display_name) <= 200),
  phone_e164 text CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contacts_tenant_id_id_uq UNIQUE (tenant_id, id)
);
CREATE INDEX contacts_tenant_phone_idx ON app.contacts (tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE TRIGGER contacts_touch BEFORE UPDATE ON app.contacts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Channel identities. WhatsApp business-scoped user ids (BSUID) are the primary key; the phone
-- number (wa_id) is optional and may be absent. Identities are scoped per WABA.
CREATE TABLE app.contact_identities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  whatsapp_account_id uuid NOT NULL,
  bsuid text CHECK (char_length(bsuid) BETWEEN 1 AND 128),
  parent_bsuid text CHECK (char_length(parent_bsuid) <= 128),
  wa_id text CHECK (wa_id ~ '^[0-9]{6,20}$'),
  profile_name text CHECK (char_length(profile_name) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_identities_has_key CHECK (bsuid IS NOT NULL OR wa_id IS NOT NULL),
  CONSTRAINT contact_identities_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT contact_identities_contact_fk FOREIGN KEY (tenant_id, contact_id) REFERENCES app.contacts (tenant_id, id),
  CONSTRAINT contact_identities_waba_fk FOREIGN KEY (tenant_id, whatsapp_account_id)
    REFERENCES app.whatsapp_accounts (tenant_id, id)
);
CREATE UNIQUE INDEX contact_identities_bsuid_uq ON app.contact_identities (tenant_id, whatsapp_account_id, bsuid)
  WHERE bsuid IS NOT NULL;
CREATE UNIQUE INDEX contact_identities_waid_uq ON app.contact_identities (tenant_id, whatsapp_account_id, wa_id)
  WHERE wa_id IS NOT NULL;
CREATE INDEX contact_identities_contact_idx ON app.contact_identities (tenant_id, contact_id);
CREATE TRIGGER contact_identities_touch BEFORE UPDATE ON app.contact_identities
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Conversations (one thread per company number and contact) ---------------------------------------
CREATE TABLE app.conversations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved')),
  assigned_membership_id uuid,
  last_message_at timestamptz,
  last_message_preview text CHECK (char_length(last_message_preview) <= 200),
  last_inbound_at timestamptz,
  unread_count integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  -- Incremented on every assignment/status change; optimistic concurrency for agents.
  version integer NOT NULL DEFAULT 0,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT conversations_thread_uq UNIQUE (tenant_id, channel_account_id, contact_id),
  CONSTRAINT conversations_channel_fk FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES app.channel_accounts (tenant_id, id),
  CONSTRAINT conversations_contact_fk FOREIGN KEY (tenant_id, contact_id) REFERENCES app.contacts (tenant_id, id),
  CONSTRAINT conversations_assignee_fk FOREIGN KEY (tenant_id, assigned_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE INDEX conversations_inbox_idx ON app.conversations (tenant_id, status, last_message_at DESC NULLS LAST, id DESC);
CREATE INDEX conversations_assignee_idx ON app.conversations
  (tenant_id, assigned_membership_id, status, last_message_at DESC NULLS LAST);
CREATE TRIGGER conversations_touch BEFORE UPDATE ON app.conversations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.conversation_notes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  author_membership_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_notes_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT conversation_notes_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES app.conversations (tenant_id, id),
  CONSTRAINT conversation_notes_author_fk FOREIGN KEY (tenant_id, author_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE INDEX conversation_notes_thread_idx ON app.conversation_notes (tenant_id, conversation_id, created_at);

-- Messages ----------------------------------------------------------------------------------------
CREATE TABLE app.messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  external_message_id text CHECK (char_length(external_message_id) <= 256),
  type text NOT NULL CHECK (type IN ('text', 'image', 'video', 'audio', 'document', 'sticker', 'location',
    'contacts', 'interactive', 'button', 'reaction', 'template', 'order', 'system', 'unsupported')),
  content jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(content) <= 65536),
  status text NOT NULL CHECK (status IN ('received', 'queued', 'sending', 'accepted', 'sent', 'delivered', 'read',
    'played', 'failed', 'canceled', 'unknown_outcome')),
  -- Monotonic ordering of delivery states (see packages/domain messaging/status.ts); stale or
  -- reordered status events can never move a message backwards.
  status_rank smallint NOT NULL DEFAULT 0,
  status_at timestamptz NOT NULL DEFAULT now(),
  error_code text CHECK (char_length(error_code) <= 32),
  error_title text CHECK (char_length(error_title) <= 500),
  sender_type text NOT NULL CHECK (sender_type IN ('contact', 'agent', 'bot', 'campaign', 'api', 'system')),
  sender_membership_id uuid,
  -- Client idempotency key for outbound messages (one per composer submit).
  client_key text CHECK (char_length(client_key) BETWEEN 8 AND 100),
  context_external_id text CHECK (char_length(context_external_id) <= 256),
  referral jsonb CHECK (pg_column_size(referral) <= 8192),
  pricing jsonb CHECK (pg_column_size(pricing) <= 2048),
  provider_timestamp timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT messages_conversation_fk FOREIGN KEY (tenant_id, conversation_id) REFERENCES app.conversations (tenant_id, id),
  CONSTRAINT messages_channel_fk FOREIGN KEY (tenant_id, channel_account_id) REFERENCES app.channel_accounts (tenant_id, id),
  CONSTRAINT messages_sender_fk FOREIGN KEY (tenant_id, sender_membership_id) REFERENCES app.memberships (tenant_id, id)
);
CREATE UNIQUE INDEX messages_external_uq ON app.messages (tenant_id, channel_account_id, external_message_id)
  WHERE external_message_id IS NOT NULL;
CREATE UNIQUE INDEX messages_client_key_uq ON app.messages (tenant_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX messages_thread_idx ON app.messages (tenant_id, conversation_id, created_at DESC, id DESC);

-- Immutable delivery status history (duplicates collapse on the unique key).
CREATE TABLE app.message_status_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  message_id uuid,
  external_message_id text NOT NULL CHECK (char_length(external_message_id) <= 256),
  status text NOT NULL CHECK (char_length(status) <= 32),
  provider_timestamp timestamptz NOT NULL,
  recipient_wa_id text CHECK (char_length(recipient_wa_id) <= 32),
  recipient_bsuid text CHECK (char_length(recipient_bsuid) <= 128),
  errors jsonb CHECK (pg_column_size(errors) <= 4096),
  pricing jsonb CHECK (pg_column_size(pricing) <= 2048),
  receipt_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_status_events_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT message_status_events_channel_fk FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES app.channel_accounts (tenant_id, id),
  CONSTRAINT message_status_events_message_fk FOREIGN KEY (tenant_id, message_id) REFERENCES app.messages (tenant_id, id)
);
CREATE UNIQUE INDEX message_status_events_dedupe_uq ON app.message_status_events
  (tenant_id, channel_account_id, external_message_id, status, provider_timestamp);
CREATE INDEX message_status_events_message_idx ON app.message_status_events (tenant_id, message_id, provider_timestamp);
CREATE TRIGGER message_status_events_append_only BEFORE UPDATE OR DELETE ON app.message_status_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Durable outbound send intents -------------------------------------------------------------------
CREATE TABLE app.send_intents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  message_id uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'sending', 'accepted', 'failed', 'canceled', 'unknown_outcome', 'deferred')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  -- Graph API request body (never contains credentials).
  request jsonb NOT NULL CHECK (pg_column_size(request) <= 65536),
  last_error_code text CHECK (char_length(last_error_code) <= 32),
  last_error text CHECK (char_length(last_error) <= 1000),
  actor_user_id text REFERENCES auth.users (id),
  sent_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT send_intents_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT send_intents_message_uq UNIQUE (tenant_id, message_id),
  CONSTRAINT send_intents_message_fk FOREIGN KEY (tenant_id, message_id) REFERENCES app.messages (tenant_id, id),
  CONSTRAINT send_intents_channel_fk FOREIGN KEY (tenant_id, channel_account_id) REFERENCES app.channel_accounts (tenant_id, id)
);
CREATE INDEX send_intents_due_idx ON app.send_intents (next_attempt_at) WHERE state IN ('queued', 'deferred');
CREATE INDEX send_intents_sending_idx ON app.send_intents (lease_until) WHERE state = 'sending';
CREATE TRIGGER send_intents_touch BEFORE UPDATE ON app.send_intents
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Media metadata (files live in private object storage under t/<tenant>/m/<id>) --------------------
CREATE TABLE app.media_objects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  message_id uuid,
  provider_media_id text CHECK (char_length(provider_media_id) <= 128),
  mime_type text CHECK (char_length(mime_type) <= 128),
  size_bytes bigint CHECK (size_bytes >= 0),
  sha256 text CHECK (char_length(sha256) <= 128),
  filename text CHECK (char_length(filename) <= 255),
  storage_key text CHECK (char_length(storage_key) <= 512),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'stored', 'failed', 'rejected', 'expired')),
  failure_reason text CHECK (char_length(failure_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_objects_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT media_objects_message_fk FOREIGN KEY (tenant_id, message_id) REFERENCES app.messages (tenant_id, id)
);
CREATE INDEX media_objects_message_idx ON app.media_objects (tenant_id, message_id);
CREATE TRIGGER media_objects_touch BEFORE UPDATE ON app.media_objects
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Durable tenant event log for live updates (SSE). Readers page by (txid, id) and only see
-- transactions older than the current snapshot's xmin, so a slow-committing writer can never be
-- skipped. NOTIFY is only a wake-up hint carrying the tenant id.
CREATE TABLE app.tenant_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_.]{2,63}$'),
  conversation_id uuid,
  assigned_membership_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 4096),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_events_cursor_idx ON app.tenant_events (tenant_id, txid, id);
CREATE INDEX tenant_events_created_idx ON app.tenant_events (created_at);

CREATE FUNCTION app.notify_tenant_event() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM pg_catalog.pg_notify('w360_tenant_events', NEW.tenant_id::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER tenant_events_notify AFTER INSERT ON app.tenant_events
  FOR EACH ROW EXECUTE FUNCTION app.notify_tenant_event();

-- Row level security ----------------------------------------------------------------------------
SELECT ops.apply_tenant_rls('app.whatsapp_accounts');
SELECT ops.apply_tenant_rls('app.channel_accounts');
SELECT ops.apply_tenant_rls('app.channel_onboarding_sessions');
SELECT ops.apply_tenant_rls('app.contacts');
SELECT ops.apply_tenant_rls('app.contact_identities');
SELECT ops.apply_tenant_rls('app.conversations');
SELECT ops.apply_tenant_rls('app.conversation_notes');
SELECT ops.apply_tenant_rls('app.messages');
SELECT ops.apply_tenant_rls('app.message_status_events');
SELECT ops.apply_tenant_rls('app.send_intents');
SELECT ops.apply_tenant_rls('app.media_objects');
SELECT ops.apply_tenant_rls('app.tenant_events');

-- Operational metadata for platform health screens (no credentials, no content).
CREATE POLICY platform_read ON app.whatsapp_accounts FOR SELECT TO w360_platform USING (true);
CREATE POLICY platform_read ON app.channel_accounts FOR SELECT TO w360_platform USING (true);
-- Message metadata only with an active support grant; the content column is not granted at all.
SELECT ops.apply_support_read('app.messages', 'messages.metadata.read');
SELECT ops.apply_support_read('app.send_intents', 'messages.metadata.read');

-- Privileges --------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON app.whatsapp_accounts TO w360_app;
GRANT UPDATE (business_id, name, status, credential_ciphertext, granted_scopes, token_checked_at, updated_at)
  ON app.whatsapp_accounts TO w360_app;
GRANT SELECT (id, tenant_id, waba_id, business_id, name, status, granted_scopes, token_checked_at, created_at, updated_at)
  ON app.whatsapp_accounts TO w360_platform;

GRANT SELECT, INSERT ON app.channel_accounts TO w360_app;
GRANT UPDATE (display_phone_number, verified_name, status, onboarding_step, onboarding_error, quality_rating,
  name_status, code_verification_status, registration_pin_ciphertext, health_checked_at, updated_at)
  ON app.channel_accounts TO w360_app;
GRANT SELECT (id, tenant_id, whatsapp_account_id, provider, phone_number_id, display_phone_number, verified_name,
  status, onboarding_step, onboarding_error, quality_rating, name_status, code_verification_status,
  health_checked_at, created_at, updated_at)
  ON app.channel_accounts TO w360_platform;

GRANT SELECT, INSERT ON app.channel_onboarding_sessions TO w360_app;
GRANT UPDATE (status, failure_reason, result_whatsapp_account_id, updated_at) ON app.channel_onboarding_sessions TO w360_app;

GRANT SELECT, INSERT ON app.contacts TO w360_app;
GRANT UPDATE (display_name, phone_e164, updated_at) ON app.contacts TO w360_app;

GRANT SELECT, INSERT ON app.contact_identities TO w360_app;
GRANT UPDATE (bsuid, parent_bsuid, wa_id, profile_name, updated_at) ON app.contact_identities TO w360_app;

GRANT SELECT, INSERT ON app.conversations TO w360_app;
GRANT UPDATE (status, assigned_membership_id, last_message_at, last_message_preview, last_inbound_at, unread_count,
  version, resolved_at, updated_at) ON app.conversations TO w360_app;

GRANT SELECT, INSERT ON app.conversation_notes TO w360_app;

GRANT SELECT, INSERT ON app.messages TO w360_app;
GRANT UPDATE (external_message_id, status, status_rank, status_at, error_code, error_title, pricing)
  ON app.messages TO w360_app;
GRANT SELECT (id, tenant_id, conversation_id, channel_account_id, direction, external_message_id, type, status,
  status_rank, status_at, error_code, error_title, sender_type, created_at)
  ON app.messages TO w360_platform;

GRANT SELECT, INSERT ON app.message_status_events TO w360_app;

GRANT SELECT, INSERT ON app.send_intents TO w360_app;
GRANT UPDATE (state, attempts, next_attempt_at, lease_until, last_error_code, last_error, sent_at, resolved_at, updated_at)
  ON app.send_intents TO w360_app;
GRANT SELECT (id, tenant_id, message_id, channel_account_id, state, attempts, next_attempt_at, last_error_code,
  sent_at, resolved_at, created_at)
  ON app.send_intents TO w360_platform;

GRANT SELECT, INSERT ON app.media_objects TO w360_app;
GRANT UPDATE (provider_media_id, mime_type, size_bytes, sha256, filename, storage_key, status, failure_reason, updated_at)
  ON app.media_objects TO w360_app;

GRANT SELECT, INSERT ON app.tenant_events TO w360_app;

-- Provider asset bindings: the verified mapping from an external WhatsApp asset to exactly one
-- company. Runtime code never reads this table directly: routing uses a SECURITY DEFINER resolver.
CREATE TABLE ops.provider_asset_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('meta_whatsapp')),
  asset_type text NOT NULL CHECK (asset_type IN ('waba', 'phone_number')),
  external_id text NOT NULL CHECK (external_id ~ '^[0-9]{1,32}$'),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  internal_id uuid NOT NULL,
  parent_external_id text CHECK (parent_external_id ~ '^[0-9]{1,32}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE UNIQUE INDEX provider_asset_bindings_active_uq ON ops.provider_asset_bindings (provider, asset_type, external_id)
  WHERE status = 'active';
CREATE INDEX provider_asset_bindings_tenant_idx ON ops.provider_asset_bindings (tenant_id);
ALTER TABLE ops.provider_asset_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY definer_all ON ops.provider_asset_bindings TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY platform_read ON ops.provider_asset_bindings FOR SELECT TO w360_platform USING (true);
GRANT SELECT, INSERT, UPDATE ON ops.provider_asset_bindings TO w360_definer;
GRANT SELECT ON ops.provider_asset_bindings TO w360_platform;

-- Durable webhook receipts (stored before acknowledging the provider). The raw body is encrypted
-- (AAD = receipt id) and erased after the retention window; `summary` holds counts only.
CREATE TABLE ops.webhook_receipts (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('meta_whatsapp', 'razorpay')),
  received_at timestamptz NOT NULL DEFAULT now(),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  body_ciphertext text,
  body_size integer NOT NULL CHECK (body_size >= 0),
  event_id text CHECK (char_length(event_id) <= 200),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'quarantined', 'ignored')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz,
  last_error text CHECK (char_length(last_error) <= 1000),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(summary) <= 4096),
  processed_at timestamptz
);
CREATE UNIQUE INDEX webhook_receipts_dedupe_uq ON ops.webhook_receipts (provider, body_sha256);
CREATE UNIQUE INDEX webhook_receipts_event_uq ON ops.webhook_receipts (provider, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX webhook_receipts_open_idx ON ops.webhook_receipts (received_at) WHERE status IN ('pending', 'processing', 'failed');
GRANT SELECT, INSERT, UPDATE ON ops.webhook_receipts TO w360_app;
GRANT SELECT (id, provider, received_at, body_size, event_id, status, attempts, last_error, summary, processed_at)
  ON ops.webhook_receipts TO w360_platform;

-- Events that could not be attributed to a company. Visible to platform staff only.
CREATE TABLE ops.webhook_quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES ops.webhook_receipts (id),
  provider text NOT NULL CHECK (provider IN ('meta_whatsapp', 'razorpay')),
  reason text NOT NULL CHECK (reason IN ('unknown_asset', 'asset_mismatch', 'malformed', 'unsupported_object')),
  external_ids jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(external_ids) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution text CHECK (char_length(resolution) <= 1000)
);
CREATE INDEX webhook_quarantine_open_idx ON ops.webhook_quarantine (created_at) WHERE resolved_at IS NULL;
-- Reprocessing a receipt must not duplicate its quarantine entries.
CREATE UNIQUE INDEX webhook_quarantine_dedupe_uq ON ops.webhook_quarantine (receipt_id, reason, external_ids);
GRANT INSERT ON ops.webhook_quarantine TO w360_app;
GRANT SELECT ON ops.webhook_quarantine TO w360_platform;
GRANT UPDATE (resolved_at, resolution) ON ops.webhook_quarantine TO w360_platform;

-- Token buckets for provider rate limits (keys are ids, never personal data).
CREATE TABLE ops.rate_limit_buckets (
  key text PRIMARY KEY CHECK (char_length(key) <= 200),
  tokens double precision NOT NULL,
  capacity double precision NOT NULL CHECK (capacity > 0),
  refill_per_second double precision NOT NULL CHECK (refill_per_second > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON ops.rate_limit_buckets TO w360_app;

-- SECURITY DEFINER entry points ------------------------------------------------------------------
CREATE FUNCTION ops.resolve_provider_asset(p_provider text, p_asset_type text, p_external_id text)
  RETURNS TABLE (tenant_id uuid, internal_id uuid, parent_external_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT b.tenant_id, b.internal_id, b.parent_external_id
    FROM ops.provider_asset_bindings b
   WHERE b.provider = p_provider AND b.asset_type = p_asset_type AND b.external_id = p_external_id
     AND b.status = 'active'
$$;
GRANT EXECUTE ON FUNCTION ops.resolve_provider_asset(text, text, text) TO w360_app;
ALTER FUNCTION ops.resolve_provider_asset(text, text, text) OWNER TO w360_definer;

-- Binds an external asset to the current company. Idempotent for the same binding; refuses an
-- asset already bound to any other company or record (confused-deputy protection).
CREATE FUNCTION app.bind_provider_asset(
  p_provider text, p_asset_type text, p_external_id text, p_internal_id uuid, p_parent_external_id text
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_existing ops.provider_asset_bindings%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_provider || ':' || p_asset_type || ':' || p_external_id, 7360));
  SELECT * INTO v_existing FROM ops.provider_asset_bindings b
   WHERE b.provider = p_provider AND b.asset_type = p_asset_type AND b.external_id = p_external_id
     AND b.status = 'active';
  IF FOUND THEN
    IF v_existing.tenant_id = v_tenant AND v_existing.internal_id = p_internal_id THEN
      RETURN;
    ELSIF v_existing.tenant_id = v_tenant THEN
      RAISE EXCEPTION 'this WhatsApp asset is already connected in this company' USING ERRCODE = 'W3409';
    ELSE
      RAISE EXCEPTION 'this WhatsApp asset is already connected to another company' USING ERRCODE = 'W3409';
    END IF;
  END IF;
  INSERT INTO ops.provider_asset_bindings (provider, asset_type, external_id, tenant_id, internal_id, parent_external_id)
  VALUES (p_provider, p_asset_type, p_external_id, v_tenant, p_internal_id, p_parent_external_id);
END
$$;
GRANT EXECUTE ON FUNCTION app.bind_provider_asset(text, text, text, uuid, text) TO w360_app;
ALTER FUNCTION app.bind_provider_asset(text, text, text, uuid, text) OWNER TO w360_definer;

CREATE FUNCTION app.release_provider_asset(p_provider text, p_asset_type text, p_external_id text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'company context required' USING ERRCODE = 'W3403';
  END IF;
  UPDATE ops.provider_asset_bindings b
     SET status = 'released', released_at = now()
   WHERE b.provider = p_provider AND b.asset_type = p_asset_type AND b.external_id = p_external_id
     AND b.status = 'active' AND b.tenant_id = v_tenant;
  RETURN FOUND;
END
$$;
GRANT EXECUTE ON FUNCTION app.release_provider_asset(text, text, text) TO w360_app;
ALTER FUNCTION app.release_provider_asset(text, text, text) OWNER TO w360_definer;

-- Sweeper input: ids of send intents whose job signal was lost or whose lease expired.
CREATE FUNCTION ops.stale_send_intents(p_limit integer)
  RETURNS TABLE (tenant_id uuid, id uuid, actor_user_id text, channel_account_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, s.id, s.actor_user_id, s.channel_account_id FROM app.send_intents s
   WHERE (s.state IN ('queued', 'deferred') AND s.next_attempt_at < now() - interval '2 minutes')
      OR (s.state = 'sending' AND s.lease_until < now())
   ORDER BY s.next_attempt_at
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
CREATE POLICY definer_read ON app.send_intents FOR SELECT TO w360_definer USING (true);
GRANT SELECT (tenant_id, id, actor_user_id, channel_account_id, state, next_attempt_at, lease_until) ON app.send_intents TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.stale_send_intents(integer) TO w360_app;
ALTER FUNCTION ops.stale_send_intents(integer) OWNER TO w360_definer;

-- Retention (docs/DATA-RETENTION.md) -------------------------------------------------------------
-- Raw webhook bodies are erased after 7 days (rows keep counts only); receipt rows are deleted after
-- 90 days together with their quarantine entries. Live-update events are kept for 7 days.
CREATE INDEX webhook_receipts_retention_idx ON ops.webhook_receipts (received_at)
  WHERE body_ciphertext IS NOT NULL;

CREATE FUNCTION ops.apply_webhook_retention(p_limit integer)
  RETURNS TABLE (erased integer, deleted integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_limit integer := least(greatest(p_limit, 1), 5000);
  v_erased integer;
  v_deleted integer;
BEGIN
  UPDATE ops.webhook_receipts r SET body_ciphertext = NULL
   WHERE r.id IN (
     SELECT x.id FROM ops.webhook_receipts x
      WHERE x.body_ciphertext IS NOT NULL
        AND x.received_at < now() - interval '7 days'
        AND x.status NOT IN ('pending', 'processing')
      ORDER BY x.received_at
      LIMIT v_limit);
  GET DIAGNOSTICS v_erased = ROW_COUNT;
  DELETE FROM ops.webhook_quarantine q
   WHERE q.id IN (
     SELECT y.id FROM ops.webhook_quarantine y
       JOIN ops.webhook_receipts r ON r.id = y.receipt_id
      WHERE r.received_at < now() - interval '90 days'
      LIMIT v_limit);
  DELETE FROM ops.webhook_receipts r
   WHERE r.id IN (
     SELECT x.id FROM ops.webhook_receipts x
      WHERE x.received_at < now() - interval '90 days'
        AND NOT EXISTS (SELECT 1 FROM ops.webhook_quarantine y WHERE y.receipt_id = x.id)
      ORDER BY x.received_at
      LIMIT v_limit);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN QUERY SELECT v_erased, v_deleted;
END
$$;
GRANT SELECT, DELETE ON ops.webhook_receipts TO w360_definer;
GRANT UPDATE (body_ciphertext) ON ops.webhook_receipts TO w360_definer;
GRANT SELECT, DELETE ON ops.webhook_quarantine TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.apply_webhook_retention(integer) TO w360_app;
ALTER FUNCTION ops.apply_webhook_retention(integer) OWNER TO w360_definer;

CREATE FUNCTION ops.prune_tenant_events(p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM app.tenant_events e
   WHERE e.id IN (
     SELECT x.id FROM app.tenant_events x
      WHERE x.created_at < now() - interval '7 days'
      ORDER BY x.id
      LIMIT least(greatest(p_limit, 1), 10000));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;
CREATE POLICY definer_read ON app.tenant_events FOR SELECT TO w360_definer USING (true);
CREATE POLICY definer_prune ON app.tenant_events FOR DELETE TO w360_definer USING (true);
GRANT SELECT (id, created_at), DELETE ON app.tenant_events TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.prune_tenant_events(integer) TO w360_app;
ALTER FUNCTION ops.prune_tenant_events(integer) OWNER TO w360_definer;
