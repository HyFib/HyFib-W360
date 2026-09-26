-- 0001_foundation: schemas, tenant context, identity tables, companies, memberships,
-- invitations, audit, platform administration. Runs as w360_owner.
--
-- Isolation model (see docs/ARCHITECTURE.md#tenant-isolation):
--   * Every tenant-owned table has tenant_id and FORCE ROW LEVEL SECURITY.
--   * Runtime code sets app.tenant_id / app.user_id with set_config(..., true), i.e. transaction
--     local. A missing or empty value yields NULL, and NULL never equals a tenant id: fail closed.
--   * Tenant scope (tenant set) sees only that tenant's rows. User scope (no tenant set) sees only
--     the user's own memberships and the companies they actively belong to.

-- Schemas ------------------------------------------------------------------------------------
CREATE SCHEMA app;
CREATE SCHEMA auth;
CREATE SCHEMA ops;
REVOKE ALL ON SCHEMA app, auth, ops FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO w360_app, w360_platform, w360_definer;
GRANT USAGE ON SCHEMA auth TO w360_auth, w360_app, w360_platform, w360_definer;
GRANT USAGE ON SCHEMA ops TO w360_app, w360_platform, w360_definer;
-- w360_definer must hold CREATE to own functions in these schemas. It cannot log in.
GRANT CREATE ON SCHEMA app, ops TO w360_definer;

ALTER DEFAULT PRIVILEGES IN SCHEMA app, auth, ops REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Tenant context -------------------------------------------------------------------------------
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.current_user_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.user_id', true), '') $$;

GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id()
  TO w360_app, w360_platform, w360_definer;

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;

-- Append-only guard used by audit and ledger tables. Retention purges run through a dedicated
-- maintenance function which sets w360.allow_retention_purge for its own transaction; runtime
-- roles have no DELETE privilege on these tables regardless of that setting.
CREATE FUNCTION app.reject_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_catalog.current_setting('w360.allow_retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '%.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'W3403';
END
$$;

-- Standard tenant policy. Called by migrations only (owner); not granted to anyone.
CREATE FUNCTION ops.apply_tenant_rls(p_table regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE pg_catalog.format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE pg_catalog.format(
    'CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL TO w360_app '
    'USING (tenant_id = (SELECT app.current_tenant_id())) '
    'WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))', p_table);
END
$$;

-- Customer-content tables are readable by platform staff only through an active, reasoned,
-- time-boxed support grant that names the scope (see ops.support_access_grants below).
CREATE FUNCTION ops.apply_support_read(p_table regclass, p_scope text) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY support_read ON %s AS PERMISSIVE FOR SELECT TO w360_platform '
    'USING (ops.has_support_access(tenant_id, %L))', p_table, p_scope);
END
$$;

-- Identity (managed by the authentication library through w360_auth) ---------------------------
CREATE TABLE auth.users (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  two_factor_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON auth.users (lower(email));

CREATE TABLE auth.sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sessions_token_uq ON auth.sessions (token);
CREATE INDEX sessions_user_idx ON auth.sessions (user_id);

CREATE TABLE auth.accounts (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounts_user_idx ON auth.accounts (user_id);
CREATE UNIQUE INDEX accounts_provider_account_uq ON auth.accounts (provider_id, account_id);

CREATE TABLE auth.verifications (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verifications_identifier_idx ON auth.verifications (identifier);

CREATE TABLE auth.two_factors (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  secret text NOT NULL,
  backup_codes text NOT NULL,
  verified boolean DEFAULT true,
  failed_verification_count integer DEFAULT 0,
  locked_until timestamptz
);
CREATE INDEX two_factors_user_idx ON auth.two_factors (user_id);

CREATE TABLE auth.rate_limits (
  id text PRIMARY KEY,
  key text NOT NULL,
  count integer NOT NULL,
  last_request bigint NOT NULL
);
CREATE UNIQUE INDEX rate_limits_key_uq ON auth.rate_limits (key);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO w360_auth;
-- Tenant code may read public profile columns only; never password hashes, sessions or secrets.
GRANT SELECT (id, name, email, email_verified, image, two_factor_enabled, created_at, updated_at)
  ON auth.users TO w360_app, w360_platform, w360_definer;
-- Platform administrators can inspect and revoke sessions of compromised accounts.
GRANT SELECT (id, user_id, expires_at, created_at, updated_at, ip_address, user_agent), DELETE
  ON auth.sessions TO w360_platform;

-- Companies (tenants) ----------------------------------------------------------------------------
CREATE TABLE app.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'pending_deletion', 'deleted')),
  status_reason text CHECK (char_length(status_reason) <= 2000),
  status_changed_at timestamptz,
  -- Who pays Meta for WhatsApp messaging. 'direct_meta': the customer's own Meta payment method
  -- (default; HyFib wallet never funds Meta charges). 'partner_billed': only allowed once a
  -- verified partner/credit-line agreement exists; launch-gated in application policy.
  billing_mode text NOT NULL DEFAULT 'direct_meta' CHECK (billing_mode IN ('direct_meta', 'partner_billed')),
  timezone text NOT NULL DEFAULT 'Asia/Kolkata' CHECK (char_length(timezone) <= 64),
  locale text NOT NULL DEFAULT 'en' CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  data_region text NOT NULL DEFAULT 'in' CHECK (data_region ~ '^[a-z]{2}$'),
  require_mfa_all_members boolean NOT NULL DEFAULT false,
  created_by_user_id text NOT NULL REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenants_slug_uq ON app.tenants (slug);
CREATE INDEX tenants_created_by_idx ON app.tenants (created_by_user_id, created_at);
CREATE TRIGGER tenants_touch BEFORE UPDATE ON app.tenants
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Memberships ------------------------------------------------------------------------------------
CREATE TABLE app.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  user_id text NOT NULL REFERENCES auth.users (id),
  roles text[] NOT NULL CHECK (
    cardinality(roles) BETWEEN 1 AND 7
    AND roles <@ ARRAY['owner', 'admin', 'supervisor', 'agent', 'marketer', 'analyst', 'billing']::text[]
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  display_name text CHECK (char_length(display_name) <= 120),
  invited_by_user_id text REFERENCES auth.users (id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz,
  status_changed_by text REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT memberships_tenant_user_uq UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_active_idx ON app.memberships (user_id) WHERE status = 'active';
CREATE TRIGGER memberships_touch BEFORE UPDATE ON app.memberships
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Invitations ------------------------------------------------------------------------------------
CREATE TABLE app.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 320),
  roles text[] NOT NULL CHECK (
    cardinality(roles) BETWEEN 1 AND 7
    AND roles <@ ARRAY['owner', 'admin', 'supervisor', 'agent', 'marketer', 'analyst', 'billing']::text[]
  ),
  -- SHA-256 of a 256-bit random token. The raw token exists only in the invitation email.
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  invited_by_user_id text NOT NULL REFERENCES auth.users (id),
  accepted_by_user_id text REFERENCES auth.users (id),
  accepted_at timestamptz,
  revoked_by_user_id text REFERENCES auth.users (id),
  revoked_at timestamptz,
  send_count integer NOT NULL DEFAULT 1 CHECK (send_count BETWEEN 1 AND 20),
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_tenant_id_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX invitations_token_hash_uq ON app.invitations (token_hash);
CREATE UNIQUE INDEX invitations_pending_email_uq ON app.invitations (tenant_id, email) WHERE status = 'pending';
CREATE INDEX invitations_tenant_created_idx ON app.invitations (tenant_id, created_at DESC);
CREATE TRIGGER invitations_touch BEFORE UPDATE ON app.invitations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Tenant audit log (append-only) -----------------------------------------------------------------
CREATE TABLE app.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system', 'platform_admin', 'api_key', 'provider')),
  actor_id text CHECK (char_length(actor_id) <= 200),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{2,99}$'),
  subject_type text CHECK (char_length(subject_type) <= 64),
  subject_id text CHECK (char_length(subject_id) <= 200),
  result text NOT NULL CHECK (result IN ('success', 'denied', 'failure')),
  correlation_id text CHECK (char_length(correlation_id) <= 100),
  ip_address inet,
  user_agent text CHECK (char_length(user_agent) <= 512),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(metadata) <= 8192)
);
CREATE INDEX audit_events_tenant_time_idx ON app.audit_events (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX audit_events_tenant_action_idx ON app.audit_events (tenant_id, action, occurred_at DESC);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Per-user preferences (user scope) --------------------------------------------------------------
CREATE TABLE app.user_preferences (
  user_id text PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  last_tenant_id uuid REFERENCES app.tenants (id),
  theme text CHECK (theme IN ('system', 'light', 'dark')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_preferences_touch BEFORE UPDATE ON app.user_preferences
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Row level security -----------------------------------------------------------------------------
ALTER TABLE app.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope_select ON app.tenants FOR SELECT TO w360_app
  USING (id = (SELECT app.current_tenant_id()));
CREATE POLICY user_scope_select ON app.tenants FOR SELECT TO w360_app
  USING (
    (SELECT app.current_tenant_id()) IS NULL
    AND EXISTS (
      SELECT 1 FROM app.memberships m
      WHERE m.tenant_id = tenants.id
        AND m.user_id = (SELECT app.current_user_id())
        AND m.status = 'active'
    )
  );
CREATE POLICY tenant_scope_update ON app.tenants FOR UPDATE TO w360_app
  USING (id = (SELECT app.current_tenant_id()))
  WITH CHECK (id = (SELECT app.current_tenant_id()));
CREATE POLICY definer_all ON app.tenants TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY platform_read ON app.tenants FOR SELECT TO w360_platform USING (true);
CREATE POLICY platform_update ON app.tenants FOR UPDATE TO w360_platform USING (true) WITH CHECK (true);

ALTER TABLE app.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope_select ON app.memberships FOR SELECT TO w360_app
  USING (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY user_scope_select ON app.memberships FOR SELECT TO w360_app
  USING ((SELECT app.current_tenant_id()) IS NULL AND user_id = (SELECT app.current_user_id()));
CREATE POLICY tenant_scope_update ON app.memberships FOR UPDATE TO w360_app
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY definer_all ON app.memberships TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY platform_read ON app.memberships FOR SELECT TO w360_platform USING (true);

SELECT ops.apply_tenant_rls('app.invitations');
CREATE POLICY definer_all ON app.invitations TO w360_definer USING (true) WITH CHECK (true);

SELECT ops.apply_tenant_rls('app.audit_events');
CREATE POLICY definer_insert ON app.audit_events FOR INSERT TO w360_definer WITH CHECK (true);
-- Platform actions that affect a company are also written to that company's own audit log.
CREATE POLICY platform_insert ON app.audit_events FOR INSERT TO w360_platform
  WITH CHECK (actor_type = 'platform_admin' AND actor_id = (SELECT app.current_user_id()));

ALTER TABLE app.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY user_scope_all ON app.user_preferences TO w360_app
  USING (user_id = (SELECT app.current_user_id()))
  WITH CHECK (user_id = (SELECT app.current_user_id()));

-- Privileges -------------------------------------------------------------------------------------
-- Column-level grants keep status, slug and billing mode out of reach of tenant code paths.
GRANT SELECT ON app.tenants TO w360_app, w360_platform;
GRANT UPDATE (name, timezone, locale, require_mfa_all_members, updated_at) ON app.tenants TO w360_app;
GRANT UPDATE (status, status_reason, status_changed_at, updated_at) ON app.tenants TO w360_platform;
GRANT SELECT, INSERT, UPDATE ON app.tenants TO w360_definer;

GRANT SELECT ON app.memberships TO w360_app, w360_platform;
GRANT UPDATE (roles, status, status_changed_at, status_changed_by, display_name, updated_at)
  ON app.memberships TO w360_app;
GRANT SELECT, INSERT, UPDATE ON app.memberships TO w360_definer;

GRANT SELECT, INSERT ON app.invitations TO w360_app;
GRANT UPDATE (status, expires_at, token_hash, send_count, last_sent_at, revoked_by_user_id, revoked_at, updated_at)
  ON app.invitations TO w360_app;
GRANT SELECT ON app.invitations TO w360_platform;
GRANT SELECT, UPDATE ON app.invitations TO w360_definer;

GRANT SELECT, INSERT ON app.audit_events TO w360_app;
GRANT SELECT, INSERT ON app.audit_events TO w360_platform;
GRANT INSERT ON app.audit_events TO w360_definer;

GRANT SELECT, INSERT, UPDATE ON app.user_preferences TO w360_app;

-- Platform operations (not tenant data) ---------------------------------------------------------
CREATE TABLE ops.platform_admins (
  user_id text PRIMARY KEY REFERENCES auth.users (id),
  role text NOT NULL CHECK (role IN ('platform_owner', 'platform_operator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
ALTER TABLE ops.platform_admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY self_read ON ops.platform_admins FOR SELECT TO w360_app
  USING (user_id = (SELECT app.current_user_id()));
CREATE POLICY platform_read ON ops.platform_admins FOR SELECT TO w360_platform USING (true);
GRANT SELECT ON ops.platform_admins TO w360_app, w360_platform;

-- Time-boxed, reasoned support access. There is no unrestricted impersonation.
CREATE TABLE ops.support_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  platform_user_id text NOT NULL REFERENCES auth.users (id),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 2000),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) >= 1
    AND scopes <@ ARRAY['tenant.read', 'members.read', 'messages.metadata.read', 'billing.read', 'diagnostics.read']::text[]
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text REFERENCES auth.users (id),
  CONSTRAINT support_access_expiry_bounds CHECK (expires_at > created_at AND expires_at <= created_at + interval '8 hours')
);
CREATE INDEX support_access_tenant_idx ON ops.support_access_grants (tenant_id, created_at DESC);
CREATE INDEX support_access_active_idx ON ops.support_access_grants (platform_user_id, expires_at) WHERE revoked_at IS NULL;
ALTER TABLE ops.support_access_grants ENABLE ROW LEVEL SECURITY;
-- Tenants can see who from the platform accessed their company, and why.
CREATE POLICY tenant_transparency ON ops.support_access_grants FOR SELECT TO w360_app
  USING (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY platform_all ON ops.support_access_grants TO w360_platform USING (true) WITH CHECK (true);
GRANT SELECT ON ops.support_access_grants TO w360_app;
GRANT SELECT, INSERT ON ops.support_access_grants TO w360_platform;
GRANT UPDATE (revoked_at, revoked_by) ON ops.support_access_grants TO w360_platform;

CREATE FUNCTION ops.has_support_access(p_tenant_id uuid, p_scope text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM ops.support_access_grants g
     WHERE g.tenant_id = p_tenant_id
       AND g.platform_user_id = app.current_user_id()
       AND g.revoked_at IS NULL
       AND g.expires_at > now()
       AND p_scope = ANY (g.scopes)
  )
$$;
GRANT EXECUTE ON FUNCTION ops.has_support_access(uuid, text) TO w360_platform;

SELECT ops.apply_support_read('app.invitations', 'members.read');
SELECT ops.apply_support_read('app.audit_events', 'diagnostics.read');

-- Step-up verification: sensitive actions require the current session to have re-verified the
-- password (and TOTP when enabled) within a short window.
CREATE TABLE ops.step_up_verifications (
  session_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL DEFAULT now(),
  methods text[] NOT NULL CHECK (methods <@ ARRAY['password', 'totp']::text[] AND cardinality(methods) >= 1)
);
ALTER TABLE ops.step_up_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY self_all ON ops.step_up_verifications TO w360_app
  USING (user_id = (SELECT app.current_user_id()))
  WITH CHECK (user_id = (SELECT app.current_user_id()));
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.step_up_verifications TO w360_app;

CREATE TABLE ops.platform_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id text NOT NULL REFERENCES auth.users (id),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{2,99}$'),
  target_tenant_id uuid REFERENCES app.tenants (id),
  reason text CHECK (char_length(reason) <= 2000),
  result text NOT NULL CHECK (result IN ('success', 'denied', 'failure')),
  correlation_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(metadata) <= 8192)
);
CREATE INDEX platform_audit_time_idx ON ops.platform_audit_events (occurred_at DESC);
CREATE TRIGGER platform_audit_append_only BEFORE UPDATE OR DELETE ON ops.platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
GRANT SELECT, INSERT ON ops.platform_audit_events TO w360_platform;

-- Security events without a tenant context (failed sign-in bursts, denied company access, invalid
-- webhook signatures). Runtime code can insert but not read them.
CREATE TABLE ops.security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,99}$'),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  user_id text,
  tenant_id uuid,
  ip_address inet,
  user_agent text CHECK (char_length(user_agent) <= 512),
  correlation_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(details) <= 8192)
);
CREATE INDEX security_events_time_idx ON ops.security_events (occurred_at DESC);
CREATE INDEX security_events_type_idx ON ops.security_events (event_type, occurred_at DESC);
GRANT INSERT ON ops.security_events TO w360_app;
GRANT SELECT ON ops.security_events TO w360_platform;

-- Durable transactional email queue. Payloads that contain one-time links are encrypted with the
-- application keyring (AAD = row id) and cleared once delivered.
CREATE TABLE ops.email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES app.tenants (id),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{2,63}$'),
  to_address text NOT NULL CHECK (char_length(to_address) BETWEEN 3 AND 320),
  payload_ciphertext text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text CHECK (char_length(last_error) <= 2000),
  provider_message_id text,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE UNIQUE INDEX email_outbox_dedupe_uq ON ops.email_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX email_outbox_due_idx ON ops.email_outbox (next_attempt_at) WHERE status IN ('pending', 'sending');
GRANT SELECT, INSERT, UPDATE ON ops.email_outbox TO w360_app;
GRANT SELECT (id, tenant_id, kind, status, attempts, next_attempt_at, last_error, created_at, sent_at)
  ON ops.email_outbox TO w360_platform;

-- SECURITY DEFINER entry points ------------------------------------------------------------------
-- Each function: fixed search_path, explicit identity check against app.current_user_id(), custom
-- SQLSTATEs (W34xx) that the application maps to typed errors.

CREATE FUNCTION app.create_tenant(
  p_tenant_id uuid,
  p_membership_id uuid,
  p_name text,
  p_slug text,
  p_timezone text,
  p_locale text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_user text := app.current_user_id();
  v_verified boolean;
  v_recent integer;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = 'W3401';
  END IF;
  IF app.current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'company creation must not run inside a company context' USING ERRCODE = 'W3403';
  END IF;
  SELECT u.email_verified INTO v_verified FROM auth.users u WHERE u.id = v_user;
  IF NOT FOUND OR NOT v_verified THEN
    RAISE EXCEPTION 'verify your email address before creating a company' USING ERRCODE = 'W3403';
  END IF;
  SELECT count(*) INTO v_recent FROM app.tenants t
   WHERE t.created_by_user_id = v_user AND t.created_at > now() - interval '24 hours';
  IF v_recent >= 5 THEN
    RAISE EXCEPTION 'company creation limit reached; try again later' USING ERRCODE = 'W3429';
  END IF;

  INSERT INTO app.tenants (id, slug, name, timezone, locale, created_by_user_id)
  VALUES (p_tenant_id, p_slug, btrim(p_name), p_timezone, p_locale, v_user);

  INSERT INTO app.memberships (id, tenant_id, user_id, roles, status)
  VALUES (p_membership_id, p_tenant_id, v_user, ARRAY['owner'], 'active');

  INSERT INTO app.audit_events (tenant_id, actor_type, actor_id, action, subject_type, subject_id, result, metadata)
  VALUES (p_tenant_id, 'user', v_user, 'tenant.created', 'tenant', p_tenant_id::text, 'success',
          jsonb_build_object('slug', p_slug));
  RETURN p_tenant_id;
END
$$;
ALTER FUNCTION app.create_tenant(uuid, uuid, text, text, text, text) OWNER TO w360_definer;
GRANT EXECUTE ON FUNCTION app.create_tenant(uuid, uuid, text, text, text, text) TO w360_app;

-- Limited invitation details for the token holder's accept page.
CREATE FUNCTION app.invitation_preview(p_token_hash text)
  RETURNS TABLE (
    invitation_id uuid,
    tenant_name text,
    email text,
    roles text[],
    expires_at timestamptz,
    status text,
    inviter_name text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT i.id,
         t.name,
         i.email,
         i.roles,
         i.expires_at,
         CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired'
              WHEN t.status <> 'active' THEN 'unavailable'
              ELSE i.status END,
         u.name
    FROM app.invitations i
    JOIN app.tenants t ON t.id = i.tenant_id
    JOIN auth.users u ON u.id = i.invited_by_user_id
   WHERE i.token_hash = p_token_hash
$$;
ALTER FUNCTION app.invitation_preview(text) OWNER TO w360_definer;
GRANT EXECUTE ON FUNCTION app.invitation_preview(text) TO w360_app;

CREATE FUNCTION app.accept_invitation(p_token_hash text, p_membership_id uuid)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_user text := app.current_user_id();
  v_inv app.invitations%ROWTYPE;
  v_email text;
  v_verified boolean;
  v_tenant_status text;
  v_existing app.memberships%ROWTYPE;
  v_membership_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = 'W3401';
  END IF;
  IF app.current_tenant_id() IS NOT NULL THEN
    RAISE EXCEPTION 'invitation acceptance must not run inside a company context' USING ERRCODE = 'W3403';
  END IF;

  SELECT * INTO v_inv FROM app.invitations i WHERE i.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'W3404';
  END IF;
  IF v_inv.status <> 'pending' THEN
    RAISE EXCEPTION 'invitation is no longer valid' USING ERRCODE = 'W3409';
  END IF;
  IF v_inv.expires_at <= now() THEN
    RAISE EXCEPTION 'invitation has expired' USING ERRCODE = 'W3412';
  END IF;

  SELECT lower(u.email), u.email_verified INTO v_email, v_verified FROM auth.users u WHERE u.id = v_user;
  IF v_email IS DISTINCT FROM v_inv.email THEN
    RAISE EXCEPTION 'invitation was issued to a different email address' USING ERRCODE = 'W3403';
  END IF;
  IF NOT v_verified THEN
    RAISE EXCEPTION 'verify your email address before accepting' USING ERRCODE = 'W3403';
  END IF;

  SELECT t.status INTO v_tenant_status FROM app.tenants t WHERE t.id = v_inv.tenant_id;
  IF v_tenant_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'company is not accepting new members' USING ERRCODE = 'W3412';
  END IF;

  SELECT * INTO v_existing FROM app.memberships m
   WHERE m.tenant_id = v_inv.tenant_id AND m.user_id = v_user FOR UPDATE;
  IF FOUND THEN
    IF v_existing.status = 'active' THEN
      RAISE EXCEPTION 'already a member of this company' USING ERRCODE = 'W3409';
    ELSIF v_existing.status = 'suspended' THEN
      RAISE EXCEPTION 'membership is suspended; ask an administrator to restore it' USING ERRCODE = 'W3403';
    END IF;
    UPDATE app.memberships
       SET roles = v_inv.roles, status = 'active', status_changed_at = now(), status_changed_by = v_user,
           joined_at = now(), invited_by_user_id = v_inv.invited_by_user_id
     WHERE id = v_existing.id;
    v_membership_id := v_existing.id;
  ELSE
    INSERT INTO app.memberships (id, tenant_id, user_id, roles, status, invited_by_user_id)
    VALUES (p_membership_id, v_inv.tenant_id, v_user, v_inv.roles, 'active', v_inv.invited_by_user_id);
    v_membership_id := p_membership_id;
  END IF;

  UPDATE app.invitations
     SET status = 'accepted', accepted_by_user_id = v_user, accepted_at = now()
   WHERE id = v_inv.id;

  INSERT INTO app.audit_events (tenant_id, actor_type, actor_id, action, subject_type, subject_id, result, metadata)
  VALUES (v_inv.tenant_id, 'user', v_user, 'member.joined', 'membership', v_membership_id::text, 'success',
          jsonb_build_object('invitation_id', v_inv.id, 'roles', v_inv.roles));
  RETURN v_inv.tenant_id;
END
$$;
ALTER FUNCTION app.accept_invitation(text, uuid) OWNER TO w360_definer;
GRANT EXECUTE ON FUNCTION app.accept_invitation(text, uuid) TO w360_app;

-- Last-owner protection. The tenant row lock serialises concurrent demotions: the second
-- transaction re-reads committed state after the first commits and is rejected.
CREATE FUNCTION app.guard_last_owner() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.status = 'active' AND 'owner' = ANY (OLD.roles)
     AND (NEW.status <> 'active' OR NOT ('owner' = ANY (NEW.roles))) THEN
    PERFORM 1 FROM app.tenants t WHERE t.id = OLD.tenant_id FOR UPDATE;
    IF NOT EXISTS (
      SELECT 1 FROM app.memberships m
       WHERE m.tenant_id = OLD.tenant_id AND m.status = 'active' AND 'owner' = ANY (m.roles) AND m.id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'a company must keep at least one active owner' USING ERRCODE = 'W3412';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
ALTER FUNCTION app.guard_last_owner() OWNER TO w360_definer;
CREATE TRIGGER memberships_last_owner BEFORE UPDATE ON app.memberships
  FOR EACH ROW EXECUTE FUNCTION app.guard_last_owner();

-- Worker fan-out: ids of companies that are not deleted. Ids only, never data.
CREATE FUNCTION app.list_live_tenant_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT t.id FROM app.tenants t WHERE t.status IN ('active', 'suspended') ORDER BY t.id $$;
ALTER FUNCTION app.list_live_tenant_ids() OWNER TO w360_definer;
GRANT EXECUTE ON FUNCTION app.list_live_tenant_ids() TO w360_app;

-- Status of one company, used by workers before acting on a signed job. Returns NULL when the
-- company does not exist.
CREATE FUNCTION app.tenant_status(p_tenant_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT t.status FROM app.tenants t WHERE t.id = p_tenant_id $$;
ALTER FUNCTION app.tenant_status(uuid) OWNER TO w360_definer;
GRANT EXECUTE ON FUNCTION app.tenant_status(uuid) TO w360_app;

-- Account recovery for a verified account owner who lost their second factor. Platform operators
-- only, with a mandatory reason; removes the second factor, signs out all sessions and records the
-- action. The reason and actor come from the platform session (app.user_id).
CREATE FUNCTION ops.platform_reset_user_mfa(p_user_id text, p_reason text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF v_actor = p_user_id THEN
    RAISE EXCEPTION 'administrators cannot reset their own second factor' USING ERRCODE = 'W3403';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'a reason of at least 10 characters is required' USING ERRCODE = 'W3412';
  END IF;
  DELETE FROM auth.two_factors WHERE user_id = p_user_id;
  UPDATE auth.users SET two_factor_enabled = false, updated_at = now() WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'W3404';
  END IF;
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  INSERT INTO ops.platform_audit_events (actor_user_id, action, reason, result, metadata)
  VALUES (v_actor, 'account.mfa_reset', p_reason, 'success', jsonb_build_object('user_id', p_user_id));
END
$$;
GRANT DELETE ON auth.two_factors TO w360_definer;
GRANT UPDATE (two_factor_enabled, updated_at) ON auth.users TO w360_definer;
GRANT DELETE ON auth.sessions TO w360_definer;
GRANT SELECT (user_id) ON auth.two_factors TO w360_definer;
GRANT SELECT (user_id) ON auth.sessions TO w360_definer;
GRANT SELECT ON ops.platform_admins TO w360_definer;
CREATE POLICY definer_read ON ops.platform_admins FOR SELECT TO w360_definer USING (true);
GRANT INSERT ON ops.platform_audit_events TO w360_definer;
ALTER FUNCTION ops.platform_reset_user_mfa(text, text) OWNER TO w360_definer;
GRANT EXECUTE ON FUNCTION ops.platform_reset_user_mfa(text, text) TO w360_platform;
