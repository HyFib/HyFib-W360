-- 0005_contacts_consent_templates: contact profiles (email, custom fields, tags), CSV import runs,
-- consent with provenance (append-only events, current state maintained by trigger), suppression
-- list, company messaging consent settings, WhatsApp message templates with status history, and
-- contact erasure.
--
-- Consent is enforced at send time by the worker (not only when a message is queued): an opt-out
-- or suppression recorded before dispatch stops a queued template. Service-window replies to a
-- customer who wrote to the company are not business-initiated and are not blocked by marketing
-- or utility consent.

-- Contacts ------------------------------------------------------------------------------------------
ALTER TABLE app.contacts
  ADD COLUMN email text CHECK (char_length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  -- Values of the company's custom fields (validated against app.contact_fields by the service).
  ADD COLUMN attributes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(attributes) = 'object' AND pg_column_size(attributes) <= 16384),
  ADD COLUMN source text NOT NULL DEFAULT 'whatsapp' CHECK (source IN ('whatsapp', 'manual', 'import', 'api')),
  -- Set when the contact was erased: personal data is removed and messages are redacted.
  ADD COLUMN erased_at timestamptz;

-- One contact per phone number per company: imports, manual entry and inbound WhatsApp messages all
-- resolve to the same person. No release has stored contacts yet; if duplicate numbers existed, the
-- index build would fail and stop the migration (nothing is merged or dropped silently).
DROP INDEX app.contacts_tenant_phone_idx;
CREATE UNIQUE INDEX contacts_tenant_phone_uq ON app.contacts (tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX contacts_tenant_created_idx ON app.contacts (tenant_id, created_at DESC, id DESC);
CREATE INDEX contacts_tenant_email_idx ON app.contacts (tenant_id, lower(email)) WHERE email IS NOT NULL;

GRANT UPDATE (email, attributes) ON app.contacts TO w360_app;

CREATE TABLE app.contact_tags (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  tag text NOT NULL CHECK (char_length(tag) BETWEEN 1 AND 40 AND tag = lower(btrim(tag)) AND tag !~ '[[:cntrl:],]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_tags_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT contact_tags_contact_tag_uq UNIQUE (tenant_id, contact_id, tag),
  CONSTRAINT contact_tags_contact_fk FOREIGN KEY (tenant_id, contact_id) REFERENCES app.contacts (tenant_id, id)
);
CREATE INDEX contact_tags_tag_idx ON app.contact_tags (tenant_id, tag);

CREATE TABLE app.contact_fields (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  type text NOT NULL CHECK (type IN ('text', 'number', 'date', 'boolean')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_fields_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT contact_fields_key_uq UNIQUE (tenant_id, key)
);

-- CSV import runs (the file itself is not stored; row messages keep row numbers, not row contents).
CREATE TABLE app.contact_imports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  total_rows integer NOT NULL CHECK (total_rows >= 0),
  created_count integer NOT NULL CHECK (created_count >= 0),
  updated_count integer NOT NULL CHECK (updated_count >= 0),
  -- Rows whose number already belonged to a contact while updating existing contacts was off.
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  error_count integer NOT NULL CHECK (error_count >= 0),
  consent_recorded_count integer NOT NULL DEFAULT 0 CHECK (consent_recorded_count >= 0),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array' AND pg_column_size(errors) <= 32768),
  -- Statement by the importing member about how opt-in was collected; required to record consent.
  consent_attestation text CHECK (char_length(consent_attestation) BETWEEN 10 AND 1000),
  created_by_user_id text REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_imports_tenant_id_id_uq UNIQUE (tenant_id, id)
);
CREATE INDEX contact_imports_tenant_time_idx ON app.contact_imports (tenant_id, created_at DESC);

-- Consent ---------------------------------------------------------------------------------------------
-- Purposes: `marketing` (marketing templates) and `utility` (utility and authentication templates).
-- Every change is an append-only event with its provenance; the current state per purpose is kept
-- in app.contact_consents by a trigger, so it can never drift from the events.
CREATE TABLE app.consent_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('marketing', 'utility')),
  action text NOT NULL CHECK (action IN ('opt_in', 'opt_out')),
  source text NOT NULL CHECK (source IN ('keyword', 'agent', 'import', 'provider', 'api', 'erasure')),
  -- The number the customer used, when the event came from a WhatsApp message.
  channel_account_id uuid,
  -- Provenance: message id and keyword, import id and row, provider error code, member note.
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object' AND pg_column_size(evidence) <= 4096),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'contact', 'system', 'provider')),
  actor_id text CHECK (char_length(actor_id) <= 200),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consent_events_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT consent_events_contact_fk FOREIGN KEY (tenant_id, contact_id) REFERENCES app.contacts (tenant_id, id),
  CONSTRAINT consent_events_channel_fk FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES app.channel_accounts (tenant_id, id)
);
CREATE INDEX consent_events_contact_idx ON app.consent_events (tenant_id, contact_id, occurred_at DESC, id DESC);
CREATE TRIGGER consent_events_append_only BEFORE UPDATE OR DELETE ON app.consent_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

CREATE TABLE app.contact_consents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('marketing', 'utility')),
  status text NOT NULL CHECK (status IN ('opted_in', 'opted_out')),
  event_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_consents_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT contact_consents_purpose_uq UNIQUE (tenant_id, contact_id, purpose),
  CONSTRAINT contact_consents_contact_fk FOREIGN KEY (tenant_id, contact_id) REFERENCES app.contacts (tenant_id, id),
  CONSTRAINT contact_consents_event_fk FOREIGN KEY (tenant_id, event_id) REFERENCES app.consent_events (tenant_id, id)
);
CREATE INDEX contact_consents_status_idx ON app.contact_consents (tenant_id, purpose, status);

-- Numbers the company must not message (manual entries, complaints, erased contacts). Only the
-- number and the reason are kept.
CREATE TABLE app.suppressions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  reason text NOT NULL CHECK (reason IN ('manual', 'complaint', 'legal', 'erased')),
  note text CHECK (char_length(note) <= 500),
  created_by_user_id text REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppressions_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT suppressions_phone_uq UNIQUE (tenant_id, phone_e164)
);

-- Company consent settings (defaults apply while no row exists). Keywords match a whole inbound
-- message, case-insensitively, ignoring surrounding spaces and punctuation.
CREATE TABLE app.messaging_settings (
  tenant_id uuid PRIMARY KEY REFERENCES app.tenants (id),
  opt_out_keywords text[] NOT NULL CHECK (cardinality(opt_out_keywords) <= 20),
  marketing_opt_out_keywords text[] NOT NULL CHECK (cardinality(marketing_opt_out_keywords) <= 20),
  opt_in_keywords text[] NOT NULL CHECK (cardinality(opt_in_keywords) <= 20),
  require_marketing_opt_in boolean NOT NULL DEFAULT true,
  updated_by_user_id text REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER messaging_settings_touch BEFORE UPDATE ON app.messaging_settings
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Templates ---------------------------------------------------------------------------------------
-- Templates belong to a WhatsApp Business Account; Meta identifies them by name and language.
-- `status` mirrors Meta's review state (sync is authoritative); `draft`, `submitting` and
-- `submit_failed` are local states before Meta has a template.
CREATE TABLE app.message_templates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  whatsapp_account_id uuid NOT NULL,
  -- PostgreSQL regular expressions allow repetition counts up to 255, so length is checked apart.
  name text NOT NULL CHECK (name ~ '^[a-z0-9_]+$' AND char_length(name) <= 512),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}(_[A-Z]{2,4})?$'),
  category text NOT NULL CHECK (category IN ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  components jsonb NOT NULL CHECK (jsonb_typeof(components) = 'array' AND pg_column_size(components) <= 32768),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitting', 'submit_failed', 'pending',
    'approved', 'rejected', 'paused', 'disabled', 'in_appeal', 'flagged', 'archived', 'pending_deletion',
    'deleted', 'limit_exceeded', 'locked', 'unknown')),
  provider_template_id text CHECK (provider_template_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  provider_status text CHECK (char_length(provider_status) <= 32),
  rejection_reason text CHECK (char_length(rejection_reason) <= 200),
  quality_score text CHECK (char_length(quality_score) <= 16),
  submit_error text CHECK (char_length(submit_error) <= 1000),
  -- `synced`: created outside HyFib (for example in WhatsApp Manager) and discovered by sync.
  origin text NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'synced')),
  version integer NOT NULL DEFAULT 0,
  created_by_user_id text REFERENCES auth.users (id),
  submitted_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_templates_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT message_templates_name_language_uq UNIQUE (tenant_id, whatsapp_account_id, name, language),
  CONSTRAINT message_templates_waba_fk FOREIGN KEY (tenant_id, whatsapp_account_id)
    REFERENCES app.whatsapp_accounts (tenant_id, id)
);
CREATE UNIQUE INDEX message_templates_provider_uq ON app.message_templates (tenant_id, provider_template_id)
  WHERE provider_template_id IS NOT NULL;
CREATE INDEX message_templates_status_idx ON app.message_templates (tenant_id, whatsapp_account_id, status);
CREATE TRIGGER message_templates_touch BEFORE UPDATE ON app.message_templates
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.template_status_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL,
  status text NOT NULL CHECK (char_length(status) <= 32),
  reason text CHECK (char_length(reason) <= 1000),
  source text NOT NULL CHECK (source IN ('submit', 'sync', 'send', 'delete')),
  actor_user_id text REFERENCES auth.users (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT template_status_events_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT template_status_events_template_fk FOREIGN KEY (tenant_id, template_id)
    REFERENCES app.message_templates (tenant_id, id)
);
CREATE INDEX template_status_events_template_idx ON app.template_status_events (tenant_id, template_id, occurred_at DESC);
CREATE TRIGGER template_status_events_append_only BEFORE UPDATE OR DELETE ON app.template_status_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Template sync bookkeeping per WABA: webhooks request a sync; the sweep performs it.
ALTER TABLE app.whatsapp_accounts
  ADD COLUMN templates_sync_requested_at timestamptz,
  ADD COLUMN templates_synced_at timestamptz;
GRANT UPDATE (templates_sync_requested_at, templates_synced_at) ON app.whatsapp_accounts TO w360_app;

ALTER TABLE app.messages ADD COLUMN template_id uuid;
ALTER TABLE app.messages ADD CONSTRAINT messages_template_fk FOREIGN KEY (tenant_id, template_id)
  REFERENCES app.message_templates (tenant_id, id);
CREATE INDEX messages_template_idx ON app.messages (tenant_id, template_id) WHERE template_id IS NOT NULL;

-- Row level security --------------------------------------------------------------------------------
SELECT ops.apply_tenant_rls('app.contact_tags');
SELECT ops.apply_tenant_rls('app.contact_fields');
SELECT ops.apply_tenant_rls('app.contact_imports');
SELECT ops.apply_tenant_rls('app.consent_events');
SELECT ops.apply_tenant_rls('app.contact_consents');
SELECT ops.apply_tenant_rls('app.suppressions');
SELECT ops.apply_tenant_rls('app.messaging_settings');
SELECT ops.apply_tenant_rls('app.message_templates');
SELECT ops.apply_tenant_rls('app.template_status_events');

-- Runtime privileges ------------------------------------------------------------------------------------
GRANT SELECT, INSERT, DELETE ON app.contact_tags TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.contact_fields TO w360_app;
GRANT UPDATE (label) ON app.contact_fields TO w360_app;
GRANT SELECT, INSERT ON app.contact_imports TO w360_app;
-- Consent events are append-only; the current state is written only by the trigger below.
GRANT SELECT, INSERT ON app.consent_events TO w360_app;
GRANT SELECT ON app.contact_consents TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.suppressions TO w360_app;
GRANT SELECT, INSERT ON app.messaging_settings TO w360_app;
GRANT UPDATE (opt_out_keywords, marketing_opt_out_keywords, opt_in_keywords, require_marketing_opt_in,
  updated_by_user_id, updated_at) ON app.messaging_settings TO w360_app;
GRANT SELECT, INSERT ON app.message_templates TO w360_app;
GRANT UPDATE (components, category, status, provider_template_id, provider_status, rejection_reason, quality_score,
  submit_error, version, submitted_at, last_synced_at, updated_at) ON app.message_templates TO w360_app;
GRANT SELECT, INSERT ON app.template_status_events TO w360_app;

-- Consent state maintenance (trigger) ------------------------------------------------------------------
-- Later events win; on an equal timestamp an opt-out wins over an opt-in (the safe choice).
CREATE POLICY definer_all ON app.contact_consents TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON app.contact_consents TO w360_definer;

CREATE FUNCTION app.apply_consent_event() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO app.contact_consents AS c (id, tenant_id, contact_id, purpose, status, event_id, occurred_at)
  VALUES (gen_random_uuid(), NEW.tenant_id, NEW.contact_id, NEW.purpose,
          CASE WHEN NEW.action = 'opt_in' THEN 'opted_in' ELSE 'opted_out' END, NEW.id, NEW.occurred_at)
  ON CONFLICT (tenant_id, contact_id, purpose) DO UPDATE
     SET status = EXCLUDED.status, event_id = EXCLUDED.event_id, occurred_at = EXCLUDED.occurred_at,
         updated_at = now()
   WHERE c.occurred_at < EXCLUDED.occurred_at
      OR (c.occurred_at = EXCLUDED.occurred_at AND EXCLUDED.status = 'opted_out');
  RETURN NULL;
END
$$;
-- The trigger is created before the owner changes: creating it needs EXECUTE, which the migration
-- role loses with ownership (firing it does not check EXECUTE).
CREATE TRIGGER consent_events_apply AFTER INSERT ON app.consent_events
  FOR EACH ROW EXECUTE FUNCTION app.apply_consent_event();
ALTER FUNCTION app.apply_consent_event() OWNER TO w360_definer;

-- Contact erasure ------------------------------------------------------------------------------------------
-- Status history is append-only except for the recipient identifiers, which erasure removes. The
-- exception is available only inside app.erase_contact (it sets w360.contact_erasure for its own
-- transaction) and to a role holding UPDATE on those two columns (the definer role only). The
-- retention-purge exception of app.reject_mutation is kept.
CREATE FUNCTION app.guard_status_event_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND pg_catalog.current_setting('w360.contact_erasure', true) = 'on'
     AND NEW.recipient_wa_id IS NULL AND NEW.recipient_bsuid IS NULL
     AND (NEW.id, NEW.tenant_id, NEW.channel_account_id, NEW.message_id, NEW.external_message_id, NEW.status,
          NEW.provider_timestamp, NEW.errors, NEW.pricing, NEW.receipt_id, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.tenant_id, OLD.channel_account_id, OLD.message_id, OLD.external_message_id, OLD.status,
          OLD.provider_timestamp, OLD.errors, OLD.pricing, OLD.receipt_id, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'W3403';
END
$$;
DROP TRIGGER message_status_events_append_only ON app.message_status_events;
CREATE TRIGGER message_status_events_append_only BEFORE UPDATE OR DELETE ON app.message_status_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_status_event_mutation();

CREATE POLICY definer_all ON app.contacts TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.contact_identities TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.contact_tags TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.conversations TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.conversation_notes TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.messages TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.message_status_events TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.media_objects TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_update ON app.send_intents FOR UPDATE TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.suppressions TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_all ON app.consent_events TO w360_definer USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, id, phone_e164, erased_at) ON app.contacts TO w360_definer;
GRANT UPDATE (display_name, phone_e164, email, attributes, erased_at, updated_at) ON app.contacts TO w360_definer;
GRANT SELECT (tenant_id, id, contact_id), DELETE ON app.contact_identities TO w360_definer;
GRANT SELECT (tenant_id, id, contact_id), DELETE ON app.contact_tags TO w360_definer;
GRANT SELECT (tenant_id, id, contact_id) ON app.conversations TO w360_definer;
GRANT UPDATE (last_message_preview, updated_at) ON app.conversations TO w360_definer;
GRANT SELECT (tenant_id, id, conversation_id), DELETE ON app.conversation_notes TO w360_definer;
GRANT SELECT (tenant_id, id, conversation_id, status, status_rank, status_at) ON app.messages TO w360_definer;
GRANT UPDATE (content, status, status_rank, status_at, error_code, error_title) ON app.messages TO w360_definer;
GRANT SELECT (tenant_id, id, message_id, recipient_wa_id, recipient_bsuid) ON app.message_status_events TO w360_definer;
GRANT UPDATE (recipient_wa_id, recipient_bsuid) ON app.message_status_events TO w360_definer;
GRANT SELECT (tenant_id, id, message_id), DELETE ON app.media_objects TO w360_definer;
GRANT SELECT (message_id, resolved_at, last_error_code, last_error) ON app.send_intents TO w360_definer;
GRANT UPDATE (state, lease_until, resolved_at, last_error_code, last_error, updated_at) ON app.send_intents TO w360_definer;
GRANT SELECT, INSERT ON app.suppressions TO w360_definer;
GRANT SELECT, INSERT ON app.consent_events TO w360_definer;

-- Removes a contact's personal data: identities, tags, custom values, name, phone and email are
-- deleted; message contents and previews are redacted; notes and media records are deleted;
-- recipient ids in status history are cleared; queued sends are cancelled. Consent history stays
-- (it proves what the company was allowed to do) and ends with opt-outs. The number is added to the
-- suppression list when p_suppress is true. Returns false when the contact was already erased.
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

  UPDATE app.send_intents s
     SET state = 'canceled', lease_until = NULL, resolved_at = now(), last_error_code = 'contact_erased',
         last_error = 'Not sent: the contact was erased.'
   WHERE s.tenant_id = v_tenant AND s.state IN ('queued', 'deferred')
     AND s.message_id IN (SELECT m.id FROM app.messages m JOIN app.conversations cv
                            ON cv.tenant_id = m.tenant_id AND cv.id = m.conversation_id
                           WHERE m.tenant_id = v_tenant AND cv.contact_id = p_contact_id);
  UPDATE app.messages m
     SET content = '{"redacted": true}'::jsonb,
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

-- Template sync sweep input (ids only, across companies) ---------------------------------------------
CREATE POLICY definer_read ON app.whatsapp_accounts FOR SELECT TO w360_definer USING (true);
CREATE POLICY definer_read ON app.message_templates FOR SELECT TO w360_definer USING (true);
GRANT SELECT (tenant_id, id, status, templates_sync_requested_at, templates_synced_at) ON app.whatsapp_accounts TO w360_definer;
GRANT SELECT (tenant_id, whatsapp_account_id, status) ON app.message_templates TO w360_definer;

-- Connected WABAs whose templates need a sync: a webhook asked for one, templates are waiting for
-- review (every 5 minutes), or the last full sync is older than 6 hours.
CREATE FUNCTION ops.template_sync_due(p_limit integer)
  RETURNS TABLE (tenant_id uuid, whatsapp_account_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.tenant_id, w.id
    FROM app.whatsapp_accounts w
   WHERE w.status = 'connected'
     AND (w.templates_synced_at IS NULL
          OR w.templates_synced_at < now() - interval '6 hours'
          OR (w.templates_sync_requested_at IS NOT NULL AND w.templates_sync_requested_at >= w.templates_synced_at)
          OR (w.templates_synced_at < now() - interval '5 minutes'
              AND EXISTS (SELECT 1 FROM app.message_templates t
                           WHERE t.tenant_id = w.tenant_id AND t.whatsapp_account_id = w.id
                             AND t.status IN ('submitting', 'pending', 'in_appeal'))))
   ORDER BY w.templates_synced_at NULLS FIRST
   LIMIT least(greatest(p_limit, 1), 500)
$$;
GRANT EXECUTE ON FUNCTION ops.template_sync_due(integer) TO w360_app;
ALTER FUNCTION ops.template_sync_due(integer) OWNER TO w360_definer;
