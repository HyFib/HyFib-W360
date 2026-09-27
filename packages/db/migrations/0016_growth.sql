-- 0016_growth: growth tools (P4-05). Click-to-chat links (wa.me, research M-160) with a short link
-- that counts clicks, QR codes (drawn by the web app) and a website widget, and where conversations
-- come from: click-to-WhatsApp ads (the webhook's referral object, M-130) and links (a reference
-- code in the pre-filled message). Visitors are not tracked: clicks are counted per link and day,
-- with no address, cookie or device detail stored.

-- Chat links ---------------------------------------------------------------------------------------
-- A link opens a chat with one of the company's numbers, with a pre-filled message the customer
-- still sends themselves. "(ref ABC123)" is appended when include_ref is set, so the conversation it
-- starts can be attributed. The slug is the public short link (/l/<slug>): random and unique across
-- companies, since the redirect has no company context.
CREATE TABLE app.chat_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  channel_account_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  message text NOT NULL DEFAULT '' CHECK (char_length(message) <= 500),
  ref_code text NOT NULL CHECK (ref_code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  include_ref boolean NOT NULL DEFAULT true,
  slug text NOT NULL CHECK (slug ~ '^[a-z2-7]{12}$'),
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_links_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT chat_links_slug_uq UNIQUE (slug),
  CONSTRAINT chat_links_ref_uq UNIQUE (tenant_id, ref_code),
  CONSTRAINT chat_links_channel_fk FOREIGN KEY (tenant_id, channel_account_id)
    REFERENCES app.channel_accounts (tenant_id, id),
  CONSTRAINT chat_links_created_by_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE INDEX chat_links_list_idx ON app.chat_links (tenant_id, archived_at, created_at DESC);
CREATE TRIGGER chat_links_touch BEFORE UPDATE ON app.chat_links
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Clicks per link and day (the company's time zone); written only by ops.follow_chat_link.
CREATE TABLE app.chat_link_clicks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  link_id uuid NOT NULL,
  day date NOT NULL,
  clicks integer NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  CONSTRAINT chat_link_clicks_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT chat_link_clicks_day_uq UNIQUE (tenant_id, link_id, day),
  CONSTRAINT chat_link_clicks_link_fk FOREIGN KEY (tenant_id, link_id)
    REFERENCES app.chat_links (tenant_id, id)
);

-- Website widgets --------------------------------------------------------------------------------
-- A button a company adds to its website with one script tag; it opens one of its chat links. The
-- script stores nothing in the visitor's browser and loads nothing else.
CREATE TABLE app.chat_widgets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  link_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id ~ '^[a-z2-7]{16}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  greeting text CHECK (char_length(greeting) BETWEEN 1 AND 200),
  side text NOT NULL DEFAULT 'right' CHECK (side IN ('left', 'right')),
  color text NOT NULL DEFAULT '#1f7a4d' CHECK (color ~ '^#[0-9a-f]{6}$'),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_widgets_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT chat_widgets_public_id_uq UNIQUE (public_id),
  CONSTRAINT chat_widgets_link_fk FOREIGN KEY (tenant_id, link_id)
    REFERENCES app.chat_links (tenant_id, id),
  CONSTRAINT chat_widgets_created_by_fk FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES app.memberships (tenant_id, id)
);
CREATE TRIGGER chat_widgets_touch BEFORE UPDATE ON app.chat_widgets
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Where conversations come from -------------------------------------------------------------------
-- One row per inbound message that came from an ad (the webhook's referral object) or carried a
-- link's reference code. Only what identifies the source is kept: never the ad click id, image or
-- video addresses. Deleted with the contact on erasure.
CREATE TABLE app.conversation_sources (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  message_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ad', 'link')),
  link_id uuid,
  ad_source_type text CHECK (char_length(ad_source_type) <= 32),
  ad_source_id text CHECK (char_length(ad_source_id) <= 128),
  ad_source_url text CHECK (char_length(ad_source_url) <= 1000),
  ad_headline text CHECK (char_length(ad_headline) <= 200),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_sources_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT conversation_sources_message_uq UNIQUE (tenant_id, message_id),
  CONSTRAINT conversation_sources_kind CHECK (
    (kind = 'link' AND link_id IS NOT NULL AND ad_source_id IS NULL AND ad_source_type IS NULL
       AND ad_source_url IS NULL AND ad_headline IS NULL)
    OR (kind = 'ad' AND link_id IS NULL)),
  CONSTRAINT conversation_sources_conversation_fk FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES app.conversations (tenant_id, id),
  CONSTRAINT conversation_sources_contact_fk FOREIGN KEY (tenant_id, contact_id)
    REFERENCES app.contacts (tenant_id, id),
  CONSTRAINT conversation_sources_message_fk FOREIGN KEY (tenant_id, message_id)
    REFERENCES app.messages (tenant_id, id),
  CONSTRAINT conversation_sources_link_fk FOREIGN KEY (tenant_id, link_id)
    REFERENCES app.chat_links (tenant_id, id)
);
CREATE INDEX conversation_sources_conversation_idx
  ON app.conversation_sources (tenant_id, conversation_id, occurred_at DESC);
CREATE INDEX conversation_sources_time_idx ON app.conversation_sources (tenant_id, occurred_at);
CREATE INDEX conversation_sources_link_idx ON app.conversation_sources (tenant_id, link_id, occurred_at)
  WHERE link_id IS NOT NULL;

-- Public lookups (no company context): the short link and the widget script ------------------------
-- Follows a link: counts the click for today (company time zone) and returns what the redirect
-- needs. Nothing for archived links, numbers that are not active or deleted companies.
CREATE FUNCTION ops.follow_chat_link(p_slug text)
  RETURNS TABLE (phone text, message text, ref_code text, include_ref boolean)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v record;
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z2-7]{12}$' THEN
    RETURN;
  END IF;
  SELECT l.id, l.tenant_id, l.message, l.ref_code, l.include_ref, c.display_phone_number, t.timezone
    INTO v
    FROM app.chat_links l
    JOIN app.channel_accounts c ON c.tenant_id = l.tenant_id AND c.id = l.channel_account_id
    JOIN app.tenants t ON t.id = l.tenant_id
   WHERE l.slug = p_slug AND l.archived_at IS NULL AND c.status = 'active'
     AND t.status IN ('active', 'suspended')
     AND pg_catalog.regexp_replace(c.display_phone_number, '[^0-9]', '', 'g') ~ '^[0-9]{6,15}$';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO app.chat_link_clicks AS k (id, tenant_id, link_id, day, clicks)
  VALUES (gen_random_uuid(), v.tenant_id, v.id, (now() AT TIME ZONE v.timezone)::date, 1)
  ON CONFLICT (tenant_id, link_id, day) DO UPDATE SET clicks = k.clicks + 1;
  RETURN QUERY SELECT pg_catalog.regexp_replace(v.display_phone_number, '[^0-9]', '', 'g'),
                      v.message, v.ref_code, v.include_ref;
END
$$;

-- The configuration a widget script shows; nothing for disabled widgets, or when the link would not
-- open (the same conditions as ops.follow_chat_link), so a site never shows a button that leads
-- nowhere.
CREATE FUNCTION ops.chat_widget_config(p_public_id text)
  RETURNS TABLE (label text, greeting text, side text, color text, slug text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.label, w.greeting, w.side, w.color, l.slug
    FROM app.chat_widgets w
    JOIN app.chat_links l ON l.tenant_id = w.tenant_id AND l.id = w.link_id
    JOIN app.channel_accounts c ON c.tenant_id = l.tenant_id AND c.id = l.channel_account_id
    JOIN app.tenants t ON t.id = w.tenant_id
   WHERE p_public_id ~ '^[a-z2-7]{16}$' AND w.public_id = p_public_id AND w.enabled
     AND l.archived_at IS NULL AND c.status = 'active'
     AND t.status IN ('active', 'suspended')
     AND pg_catalog.regexp_replace(c.display_phone_number, '[^0-9]', '', 'g') ~ '^[0-9]{6,15}$'
$$;

CREATE POLICY definer_access ON app.chat_links TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_access ON app.chat_link_clicks TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_access ON app.chat_widgets TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_access ON app.conversation_sources TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY definer_read ON app.channel_accounts FOR SELECT TO w360_definer USING (true);
GRANT SELECT (tenant_id, id, channel_account_id, message, ref_code, include_ref, slug, archived_at)
  ON app.chat_links TO w360_definer;
GRANT SELECT (tenant_id, id, link_id, day, clicks), INSERT (id, tenant_id, link_id, day, clicks),
  UPDATE (clicks) ON app.chat_link_clicks TO w360_definer;
GRANT SELECT (tenant_id, id, link_id, public_id, label, greeting, side, color, enabled)
  ON app.chat_widgets TO w360_definer;
GRANT SELECT (tenant_id, contact_id), DELETE ON app.conversation_sources TO w360_definer;
GRANT SELECT (tenant_id, id, display_phone_number, status) ON app.channel_accounts TO w360_definer;
GRANT UPDATE (referral) ON app.messages TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.follow_chat_link(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.chat_widget_config(text) TO w360_app;
ALTER FUNCTION ops.follow_chat_link(text) OWNER TO w360_definer;
ALTER FUNCTION ops.chat_widget_config(text) OWNER TO w360_definer;

-- Contact erasure: same body as 0015 plus the contact's conversation sources and the referral
-- objects stored on messages before this migration (see the note on replacing definer functions
-- in 0011).
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

-- Row level security and privileges --------------------------------------------------------------
SELECT ops.apply_tenant_rls('app.chat_links');
SELECT ops.apply_tenant_rls('app.chat_link_clicks');
SELECT ops.apply_tenant_rls('app.chat_widgets');
SELECT ops.apply_tenant_rls('app.conversation_sources');

GRANT SELECT, INSERT ON app.chat_links TO w360_app;
GRANT UPDATE (channel_account_id, name, message, include_ref, archived_at, version, updated_at)
  ON app.chat_links TO w360_app;
GRANT SELECT ON app.chat_link_clicks TO w360_app;
GRANT SELECT, INSERT, DELETE ON app.chat_widgets TO w360_app;
GRANT UPDATE (link_id, label, greeting, side, color, enabled, version, updated_at)
  ON app.chat_widgets TO w360_app;
GRANT SELECT, INSERT ON app.conversation_sources TO w360_app;
