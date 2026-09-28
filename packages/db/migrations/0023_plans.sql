-- 0023_plans: plans and entitlements (P5-01, ADR-051). Platform owners define plans as immutable
-- versions; every company has one plan state; limits are enforced where things are added; a company
-- whose plan lapsed is restricted like a suspended one. Nothing is seeded and nothing is charged.

-- Companies: the restricted status ---------------------------------------------------------------------
-- restricted: the plan expired or was canceled. It behaves like suspended (read access, exports,
-- members and billing; outbound work paused), and only the plan state below sets or lifts it.
ALTER TABLE app.tenants
  DROP CONSTRAINT tenants_status_check,
  ADD CONSTRAINT tenants_status_check CHECK (status IN
    ('active', 'suspended', 'restricted', 'pending_deletion', 'deleted'));

-- Plans ----------------------------------------------------------------------------------------------------
-- One row per version of a plan code. Prices are INR paise per 1, 3 or 12 months. A NULL limit means
-- no limit; a NULL add-on price means the add-on is not sold. A published version never changes (a
-- change is a new version); retiring keeps it for the companies already on it.
CREATE TABLE ops.plans (
  id uuid PRIMARY KEY,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9-]{1,39}$'),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 10000),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  description text CHECK (char_length(description) <= 500),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  price_minor bigint NOT NULL CHECK (price_minor BETWEEN 0 AND 1000000000000),
  interval_months smallint NOT NULL CHECK (interval_months IN (1, 3, 12)),
  trial_days smallint NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 90),
  grace_days smallint NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 0 AND 30),
  seats_included integer NOT NULL CHECK (seats_included BETWEEN 1 AND 10000),
  seat_price_minor bigint CHECK (seat_price_minor BETWEEN 0 AND 1000000000000),
  seats_max integer CHECK (seats_max BETWEEN 1 AND 10000),
  numbers_included integer NOT NULL CHECK (numbers_included BETWEEN 1 AND 100),
  number_price_minor bigint CHECK (number_price_minor BETWEEN 0 AND 1000000000000),
  numbers_max integer CHECK (numbers_max BETWEEN 1 AND 100),
  teams_max integer CHECK (teams_max BETWEEN 0 AND 10000),
  live_automations_max integer CHECK (live_automations_max BETWEEN 0 AND 10000),
  automation_runs_monthly integer CHECK (automation_runs_monthly BETWEEN 0 AND 100000000),
  run_pack_size integer CHECK (run_pack_size BETWEEN 1 AND 10000000),
  run_pack_price_minor bigint CHECK (run_pack_price_minor BETWEEN 0 AND 1000000000000),
  modules text[] NOT NULL DEFAULT '{}'
    CHECK (modules <@ ARRAY['automations', 'flows', 'crm', 'commerce']::text[]),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  created_by_user_id text NOT NULL REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by_user_id text REFERENCES auth.users (id),
  published_at timestamptz,
  retired_by_user_id text REFERENCES auth.users (id),
  retired_at timestamptz,
  UNIQUE (code, version),
  -- A maximum only where extras are sold, and never below what is included.
  CHECK (seats_max IS NULL OR (seat_price_minor IS NOT NULL AND seats_max >= seats_included)),
  CHECK (numbers_max IS NULL OR (number_price_minor IS NOT NULL AND numbers_max >= numbers_included)),
  -- Run packs raise a monthly limit, so they exist only with one.
  CHECK ((run_pack_size IS NULL) = (run_pack_price_minor IS NULL)),
  CHECK (run_pack_size IS NULL OR automation_runs_monthly IS NOT NULL),
  CHECK ((published_at IS NULL) = (published_by_user_id IS NULL)),
  CHECK ((retired_at IS NULL) = (retired_by_user_id IS NULL)),
  CHECK (status <> 'published' OR published_at IS NOT NULL),
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

-- The default trial for new companies (one row). Without one, new companies start complimentary.
CREATE TABLE ops.plan_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  default_trial_plan_id uuid REFERENCES ops.plans (id),
  updated_by_user_id text REFERENCES auth.users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ops.plan_settings (id) VALUES (true);

-- Drafts change freely; a published version only retires (and not while it is the default trial);
-- a retired version never changes. Code, version and author never change.
CREATE FUNCTION ops.guard_plan() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF (NEW.id, NEW.code, NEW.version, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.code, OLD.version, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'A plan version keeps its code, number and author.' USING ERRCODE = 'W3403';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'published', 'retired') THEN
      RAISE EXCEPTION 'Invalid plan status.' USING ERRCODE = 'W3403';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'published' AND NEW.status = 'retired' THEN
    IF (NEW.name, NEW.description, NEW.currency, NEW.price_minor, NEW.interval_months, NEW.trial_days,
        NEW.grace_days, NEW.seats_included, NEW.seat_price_minor, NEW.seats_max, NEW.numbers_included,
        NEW.number_price_minor, NEW.numbers_max, NEW.teams_max, NEW.live_automations_max,
        NEW.automation_runs_monthly, NEW.run_pack_size, NEW.run_pack_price_minor, NEW.modules,
        NEW.published_by_user_id, NEW.published_at)
       IS DISTINCT FROM
       (OLD.name, OLD.description, OLD.currency, OLD.price_minor, OLD.interval_months, OLD.trial_days,
        OLD.grace_days, OLD.seats_included, OLD.seat_price_minor, OLD.seats_max, OLD.numbers_included,
        OLD.number_price_minor, OLD.numbers_max, OLD.teams_max, OLD.live_automations_max,
        OLD.automation_runs_monthly, OLD.run_pack_size, OLD.run_pack_price_minor, OLD.modules,
        OLD.published_by_user_id, OLD.published_at) THEN
      RAISE EXCEPTION 'A published plan version cannot change. Create a new version instead.'
        USING ERRCODE = 'W3403';
    END IF;
    IF EXISTS (SELECT 1 FROM ops.plan_settings s WHERE s.default_trial_plan_id = OLD.id) THEN
      RAISE EXCEPTION 'This version is the default trial. Choose another default trial first.'
        USING ERRCODE = 'W3412';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A published plan version cannot change. Create a new version instead.'
    USING ERRCODE = 'W3403';
END
$$;
CREATE TRIGGER plans_guard BEFORE UPDATE ON ops.plans
  FOR EACH ROW EXECUTE FUNCTION ops.guard_plan();
CREATE TRIGGER plans_no_delete BEFORE DELETE ON ops.plans
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- The default trial must be a published version with trial days.
CREATE FUNCTION ops.guard_plan_settings() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.default_trial_plan_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM ops.plans p
        WHERE p.id = NEW.default_trial_plan_id AND p.status = 'published' AND p.trial_days > 0) THEN
    RAISE EXCEPTION 'The default trial must be a published plan version with trial days.'
      USING ERRCODE = 'W3412';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plan_settings_guard BEFORE UPDATE ON ops.plan_settings
  FOR EACH ROW EXECUTE FUNCTION ops.guard_plan_settings();
CREATE TRIGGER plan_settings_no_delete BEFORE DELETE ON ops.plan_settings
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

ALTER TABLE ops.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.plans FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.plan_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.plan_settings FORCE ROW LEVEL SECURITY;
-- Companies see the versions they can be on (never drafts); staff see everything.
CREATE POLICY app_read ON ops.plans FOR SELECT TO w360_app USING (status <> 'draft');
CREATE POLICY definer_read ON ops.plans FOR SELECT TO w360_definer USING (true);
CREATE POLICY platform_all ON ops.plans TO w360_platform USING (true) WITH CHECK (true);
CREATE POLICY definer_read ON ops.plan_settings FOR SELECT TO w360_definer USING (true);
CREATE POLICY platform_all ON ops.plan_settings TO w360_platform USING (true) WITH CHECK (true);
GRANT SELECT ON ops.plans TO w360_app, w360_definer;
GRANT SELECT, INSERT ON ops.plans TO w360_platform;
GRANT UPDATE (name, description, price_minor, interval_months, trial_days, grace_days, seats_included,
  seat_price_minor, seats_max, numbers_included, number_price_minor, numbers_max, teams_max,
  live_automations_max, automation_runs_monthly, run_pack_size, run_pack_price_minor, modules, status,
  published_by_user_id, published_at, retired_by_user_id, retired_at)
  ON ops.plans TO w360_platform;
GRANT SELECT ON ops.plan_settings TO w360_definer, w360_platform;
GRANT UPDATE (default_trial_plan_id, updated_by_user_id, updated_at) ON ops.plan_settings TO w360_platform;

-- Company plan state -------------------------------------------------------------------------------------
-- One row per company. complimentary: no plan and no limits; trialing: until trial_ends_at; active:
-- a paid period; past_due: the period ended, access continues until grace_ends_at; expired and
-- canceled: the company is restricted. Written only by SQL functions and platform staff.
CREATE TABLE app.tenant_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  plan_id uuid REFERENCES ops.plans (id),
  status text NOT NULL CHECK (status IN
    ('complimentary', 'trialing', 'active', 'past_due', 'expired', 'canceled')),
  trial_ends_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  grace_ends_at timestamptz,
  extra_seats integer NOT NULL DEFAULT 0 CHECK (extra_seats BETWEEN 0 AND 10000),
  extra_numbers integer NOT NULL DEFAULT 0 CHECK (extra_numbers BETWEEN 0 AND 100),
  run_packs integer NOT NULL DEFAULT 0 CHECK (run_packs BETWEEN 0 AND 10000),
  -- Monthly usage periods start on this instant's day of the month.
  usage_anchor timestamptz NOT NULL DEFAULT now(),
  note text CHECK (char_length(note) <= 500),
  changed_by_user_id text REFERENCES auth.users (id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (tenant_id),
  UNIQUE (tenant_id, id),
  CHECK ((status = 'complimentary') = (plan_id IS NULL)),
  CHECK (status <> 'trialing' OR trial_ends_at IS NOT NULL),
  CHECK (status NOT IN ('active', 'past_due')
    OR (period_start IS NOT NULL AND period_end IS NOT NULL AND period_end > period_start)),
  CHECK ((status = 'past_due') = (grace_ends_at IS NOT NULL)),
  CHECK (plan_id IS NOT NULL OR (extra_seats = 0 AND extra_numbers = 0 AND run_packs = 0))
);

-- A plan is assigned only while published (a company keeps a version that retires later), and
-- add-ons stay within what the version sells.
CREATE FUNCTION app.guard_tenant_plan() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v ops.plans%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.tenant_id) IS DISTINCT FROM (OLD.id, OLD.tenant_id) THEN
    RAISE EXCEPTION 'A plan state belongs to its company.' USING ERRCODE = 'W3403';
  END IF;
  IF NEW.plan_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v FROM ops.plans p WHERE p.id = NEW.plan_id;
  IF NOT FOUND OR v.status = 'draft'
     OR (v.status = 'retired' AND (TG_OP = 'INSERT' OR NEW.plan_id IS DISTINCT FROM OLD.plan_id)) THEN
    RAISE EXCEPTION 'Only a published plan version can be assigned.' USING ERRCODE = 'W3412';
  END IF;
  IF NEW.extra_seats > 0 AND (v.seat_price_minor IS NULL
       OR (v.seats_max IS NOT NULL AND v.seats_included + NEW.extra_seats > v.seats_max)) THEN
    RAISE EXCEPTION 'This plan does not sell that many extra seats.' USING ERRCODE = 'W3412';
  END IF;
  IF NEW.extra_numbers > 0 AND (v.number_price_minor IS NULL
       OR v.numbers_included + NEW.extra_numbers > coalesce(v.numbers_max, 100)) THEN
    RAISE EXCEPTION 'This plan does not sell that many extra WhatsApp numbers.' USING ERRCODE = 'W3412';
  END IF;
  IF NEW.run_packs > 0 AND v.run_pack_size IS NULL THEN
    RAISE EXCEPTION 'This plan does not sell automation run packs.' USING ERRCODE = 'W3412';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tenant_plans_guard BEFORE INSERT OR UPDATE ON app.tenant_plans
  FOR EACH ROW EXECUTE FUNCTION app.guard_tenant_plan();
CREATE TRIGGER tenant_plans_no_delete BEFORE DELETE ON app.tenant_plans
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- A lapsed plan restricts an active company and a current one lifts the restriction; suspended and
-- deleted companies are left alone (reactivation decides between active and restricted).
CREATE FUNCTION app.sync_tenant_plan_access() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.status IN ('expired', 'canceled') THEN
    UPDATE app.tenants
       SET status = 'restricted',
           status_reason = CASE NEW.status WHEN 'canceled' THEN 'The plan was canceled.'
                                           ELSE 'The plan ended.' END,
           status_changed_at = now(), updated_at = now()
     WHERE id = NEW.tenant_id AND status = 'active';
  ELSE
    UPDATE app.tenants
       SET status = 'active', status_reason = NULL, status_changed_at = now(), updated_at = now()
     WHERE id = NEW.tenant_id AND status = 'restricted';
  END IF;
  RETURN NULL;
END
$$;
-- The trigger is created while the migration role still owns the function (it has no EXECUTE after).
CREATE TRIGGER tenant_plans_access AFTER INSERT OR UPDATE OF status ON app.tenant_plans
  FOR EACH ROW EXECUTE FUNCTION app.sync_tenant_plan_access();
REVOKE EXECUTE ON FUNCTION app.sync_tenant_plan_access() FROM PUBLIC;
ALTER FUNCTION app.sync_tenant_plan_access() OWNER TO w360_definer;

-- A new company starts a trial of the default trial version, else complimentary.
CREATE FUNCTION app.init_tenant_plan() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_plan uuid;
  v_days smallint;
BEGIN
  SELECT p.id, p.trial_days INTO v_plan, v_days
    FROM ops.plan_settings s
    JOIN ops.plans p ON p.id = s.default_trial_plan_id
   WHERE s.id AND p.status = 'published' AND p.trial_days > 0;
  IF FOUND THEN
    INSERT INTO app.tenant_plans (id, tenant_id, plan_id, status, trial_ends_at, usage_anchor, note)
    VALUES (gen_random_uuid(), NEW.id, v_plan, 'trialing', now() + make_interval(days => v_days), now(),
            'Trial started with the company.');
  ELSE
    INSERT INTO app.tenant_plans (id, tenant_id, plan_id, status, note)
    VALUES (gen_random_uuid(), NEW.id, NULL, 'complimentary',
            'No default trial was set when the company was created.');
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER tenants_init_plan AFTER INSERT ON app.tenants
  FOR EACH ROW EXECUTE FUNCTION app.init_tenant_plan();
REVOKE EXECUTE ON FUNCTION app.init_tenant_plan() FROM PUBLIC;
ALTER FUNCTION app.init_tenant_plan() OWNER TO w360_definer;

SELECT ops.apply_tenant_rls('app.tenant_plans');
CREATE POLICY definer_all ON app.tenant_plans TO w360_definer USING (true) WITH CHECK (true);
CREATE POLICY platform_read ON app.tenant_plans FOR SELECT TO w360_platform USING (true);
CREATE POLICY platform_update ON app.tenant_plans FOR UPDATE TO w360_platform USING (true) WITH CHECK (true);
GRANT SELECT ON app.tenant_plans TO w360_app, w360_platform;
GRANT SELECT, INSERT, UPDATE ON app.tenant_plans TO w360_definer;
GRANT UPDATE (plan_id, status, trial_ends_at, period_start, period_end, grace_ends_at, extra_seats,
  extra_numbers, run_packs, usage_anchor, note, changed_by_user_id, changed_at, version)
  ON app.tenant_plans TO w360_platform;

-- Companies created before plans are complimentary. Companies are behind forced RLS, which applies
-- to the migration role too, so the definer role (which may read them) writes the rows.
SET ROLE w360_definer;
INSERT INTO app.tenant_plans (id, tenant_id, plan_id, status, note)
SELECT gen_random_uuid(), t.id, NULL, 'complimentary', 'Created before plans existed.'
  FROM app.tenants t;
RESET ROLE;

-- Usage counters -------------------------------------------------------------------------------------------
-- One row per company, metric and monthly period, incremented atomically below the limit.
-- notified_at: when the company's billing managers were told the limit was reached.
CREATE TABLE app.usage_counters (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES app.tenants (id),
  metric text NOT NULL CHECK (metric IN ('automation_runs')),
  period_start timestamptz NOT NULL,
  used integer NOT NULL CHECK (used >= 0),
  notified_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, metric, period_start)
);
SELECT ops.apply_tenant_rls('app.usage_counters');
GRANT SELECT, INSERT ON app.usage_counters TO w360_app;
GRANT UPDATE (used, notified_at) ON app.usage_counters TO w360_app;
GRANT SELECT ON app.usage_counters TO w360_platform, w360_definer;
CREATE POLICY platform_read ON app.usage_counters FOR SELECT TO w360_platform USING (true);
CREATE POLICY definer_read ON app.usage_counters FOR SELECT TO w360_definer USING (true);

-- Entitlements ---------------------------------------------------------------------------------------------
-- What a company may use: limits (NULL: no limit) and modules. Complimentary has no limits and every
-- module. Runs with the caller's rights, so a company only ever sees its own (platform staff read
-- every company's plan state anyway).
CREATE FUNCTION app.tenant_entitlements(p_tenant_id uuid)
  RETURNS TABLE (plan_status text, plan_id uuid, seats integer, numbers integer, teams integer,
    live_automations integer, automation_runs integer, modules text[], usage_anchor timestamptz)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT tp.status, tp.plan_id,
         CASE WHEN p.id IS NULL THEN NULL ELSE p.seats_included + tp.extra_seats END,
         CASE WHEN p.id IS NULL THEN NULL ELSE p.numbers_included + tp.extra_numbers END,
         p.teams_max,
         p.live_automations_max,
         CASE WHEN p.automation_runs_monthly IS NULL THEN NULL
              ELSE p.automation_runs_monthly + tp.run_packs * coalesce(p.run_pack_size, 0) END,
         CASE WHEN p.id IS NULL THEN ARRAY['automations', 'flows', 'crm', 'commerce']::text[]
              ELSE p.modules END,
         tp.usage_anchor
    FROM app.tenant_plans tp
    LEFT JOIN ops.plans p ON p.id = tp.plan_id
   WHERE tp.tenant_id = p_tenant_id
$$;
REVOKE EXECUTE ON FUNCTION app.tenant_entitlements(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_entitlements(uuid) TO w360_app, w360_definer, w360_platform;

-- What a company uses against its limits, for platform staff: counts only, because the records
-- themselves are customer data (like ops.platform_active_member_counts in 0002).
CREATE POLICY definer_read ON app.automations FOR SELECT TO w360_definer USING (true);
GRANT SELECT (tenant_id, id, status) ON app.automations TO w360_definer;
CREATE FUNCTION ops.platform_tenant_usage(p_tenant_id uuid)
  RETURNS TABLE (active_members integer, pending_invitations integer, numbers integer, teams integer,
    live_automations integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  RETURN QUERY SELECT
    (SELECT count(m.id)::integer FROM app.memberships m
      WHERE m.tenant_id = p_tenant_id AND m.status = 'active'),
    (SELECT count(i.id)::integer FROM app.invitations i
      WHERE i.tenant_id = p_tenant_id AND i.status = 'pending' AND i.expires_at > now()),
    (SELECT count(c.id)::integer FROM app.channel_accounts c
      WHERE c.tenant_id = p_tenant_id AND c.status IN ('onboarding', 'active', 'needs_reconnect')),
    (SELECT count(t.id)::integer FROM app.teams t WHERE t.tenant_id = p_tenant_id),
    (SELECT count(a.id)::integer FROM app.automations a
      WHERE a.tenant_id = p_tenant_id AND a.status = 'active');
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_tenant_usage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_tenant_usage(uuid) TO w360_platform;
ALTER FUNCTION ops.platform_tenant_usage(uuid) OWNER TO w360_definer;

-- Time moves plan states on ---------------------------------------------------------------------------------
-- Companies whose trial, period or grace has ended (ids only).
CREATE FUNCTION ops.plan_transitions_due(p_limit integer)
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT tp.tenant_id
    FROM app.tenant_plans tp
    JOIN app.tenants t ON t.id = tp.tenant_id AND t.status NOT IN ('pending_deletion', 'deleted')
   WHERE (tp.status = 'trialing' AND tp.trial_ends_at <= now())
      OR (tp.status = 'active' AND tp.period_end <= now())
      OR (tp.status = 'past_due' AND tp.grace_ends_at <= now())
   ORDER BY tp.tenant_id
   LIMIT p_limit
$$;
REVOKE EXECUTE ON FUNCTION ops.plan_transitions_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.plan_transitions_due(integer) TO w360_app;
ALTER FUNCTION ops.plan_transitions_due(integer) OWNER TO w360_definer;

-- Automation run counters of the last month that reached their company's limit and were not
-- announced yet (ids only).
CREATE FUNCTION ops.usage_limits_reached(p_limit integer)
  RETURNS TABLE (tenant_id uuid, counter_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT u.tenant_id, u.id
    FROM app.usage_counters u
    JOIN app.tenant_plans tp ON tp.tenant_id = u.tenant_id
    JOIN ops.plans p ON p.id = tp.plan_id
    JOIN app.tenants t ON t.id = u.tenant_id AND t.status = 'active'
   WHERE u.metric = 'automation_runs' AND u.notified_at IS NULL
     AND u.period_start > now() - interval '32 days'
     AND p.automation_runs_monthly IS NOT NULL
     AND u.used >= p.automation_runs_monthly + tp.run_packs * coalesce(p.run_pack_size, 0)
   ORDER BY u.tenant_id
   LIMIT p_limit
$$;
REVOKE EXECUTE ON FUNCTION ops.usage_limits_reached(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.usage_limits_reached(integer) TO w360_app;
ALTER FUNCTION ops.usage_limits_reached(integer) OWNER TO w360_definer;

-- Applies the transition that is due for the company in scope: a trial ends (expired); a paid period
-- ends (past_due for the version's grace days, or expired without them); a grace period ends
-- (expired). Recorded in the company's audit log. Returns nothing when nothing is due.
CREATE FUNCTION app.apply_plan_transition(p_tenant_id uuid)
  RETURNS TABLE (previous_status text, new_status text, plan_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v app.tenant_plans%ROWTYPE;
  v_grace smallint;
  v_new text;
BEGIN
  IF app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'plan transitions run in the company''s own scope' USING ERRCODE = 'W3403';
  END IF;
  -- The company row first, then its plan state: the order platform changes lock them in.
  PERFORM 1 FROM app.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
  SELECT * INTO v FROM app.tenant_plans tp WHERE tp.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v.status = 'trialing' AND v.trial_ends_at <= now() THEN
    v_new := 'expired';
  ELSIF v.status = 'active' AND v.period_end <= now() THEN
    SELECT p.grace_days INTO v_grace FROM ops.plans p WHERE p.id = v.plan_id;
    v_new := CASE WHEN v.period_end + make_interval(days => coalesce(v_grace, 0)) > now()
                  THEN 'past_due' ELSE 'expired' END;
  ELSIF v.status = 'past_due' AND v.grace_ends_at <= now() THEN
    v_new := 'expired';
  ELSE
    RETURN;
  END IF;
  UPDATE app.tenant_plans
     SET status = v_new,
         grace_ends_at = CASE WHEN v_new = 'past_due'
                              THEN v.period_end + make_interval(days => coalesce(v_grace, 0)) END,
         note = CASE v.status WHEN 'trialing' THEN 'The trial ended.'
                              WHEN 'active' THEN 'The paid period ended.'
                              ELSE 'The grace period ended.' END,
         changed_by_user_id = NULL, changed_at = now(), version = v.version + 1
   WHERE id = v.id;
  INSERT INTO app.audit_events (tenant_id, actor_type, actor_id, action, subject_type, subject_id, result,
                                metadata)
  VALUES (p_tenant_id, 'system', NULL, 'plan.' || v_new, 'tenant_plan', v.id::text, 'success',
          jsonb_build_object('previous_status', v.status, 'plan_id', v.plan_id));
  RETURN QUERY SELECT v.status, v_new, v.plan_id;
END
$$;
REVOKE EXECUTE ON FUNCTION app.apply_plan_transition(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_plan_transition(uuid) TO w360_app;
ALTER FUNCTION app.apply_plan_transition(uuid) OWNER TO w360_definer;

-- Invitations: a free seat --------------------------------------------------------------------------------
-- Same as 0001, and accepting needs a free seat of the company's plan (active members below the
-- limit), under the same per-company lock that invitations take (see the note on replacing
-- definer functions in 0011).
SET ROLE w360_definer;
DROP FUNCTION app.accept_invitation(text, uuid);
RESET ROLE;
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
  v_seats integer;
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

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('seats:' || v_inv.tenant_id::text, 0));
  SELECT e.seats INTO v_seats FROM app.tenant_entitlements(v_inv.tenant_id) e;
  IF v_seats IS NOT NULL AND (SELECT count(*) FROM app.memberships m
                               WHERE m.tenant_id = v_inv.tenant_id AND m.status = 'active') >= v_seats THEN
    RAISE EXCEPTION 'Every seat of this company''s plan is taken. Ask an administrator of the company to free a seat or add seats.'
      USING ERRCODE = 'W3412';
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
GRANT EXECUTE ON FUNCTION app.accept_invitation(text, uuid) TO w360_app;
ALTER FUNCTION app.accept_invitation(text, uuid) OWNER TO w360_definer;

-- Restricted companies stay reachable like suspended ones -------------------------------------------------
-- Same bodies as before, with restricted beside suspended: chat links, the website button, the
-- flow endpoint, payment and store webhooks keep resolving (see the note on replacing definer
-- functions in 0011), and workers keep fanning out to restricted companies.
SET ROLE w360_definer;
DROP FUNCTION app.list_live_tenant_ids();
DROP FUNCTION ops.follow_chat_link(text);
DROP FUNCTION ops.chat_widget_config(text);
DROP FUNCTION ops.flow_endpoint_target(text);
DROP FUNCTION ops.commerce_payment_webhook_target(text);
DROP FUNCTION ops.commerce_store_by_shop(text);
DROP FUNCTION ops.commerce_store_by_webhook(text);
RESET ROLE;

CREATE FUNCTION app.list_live_tenant_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT t.id FROM app.tenants t WHERE t.status IN ('active', 'suspended', 'restricted') ORDER BY t.id $$;

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
     AND t.status IN ('active', 'suspended', 'restricted')
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
     AND t.status IN ('active', 'suspended', 'restricted')
     AND pg_catalog.regexp_replace(c.display_phone_number, '[^0-9]', '', 'g') ~ '^[0-9]{6,15}$'
$$;

CREATE FUNCTION ops.flow_endpoint_target(p_public_id text)
  RETURNS TABLE (tenant_id uuid, flow_id uuid, tenant_status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT f.tenant_id, f.id, t.status
    FROM app.flows f
    JOIN app.tenants t ON t.id = f.tenant_id
   WHERE p_public_id ~ '^[a-z2-7]{16}$' AND f.public_id = p_public_id
     AND t.status IN ('active', 'suspended', 'restricted')
$$;

CREATE FUNCTION ops.commerce_payment_webhook_target(p_public_id text)
  RETURNS TABLE (tenant_id uuid, account_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT a.tenant_id, a.id
    FROM app.commerce_payment_accounts a
    JOIN app.tenants t ON t.id = a.tenant_id
   WHERE p_public_id ~ '^[a-z2-7]{16}$' AND a.webhook_public_id = p_public_id
     AND t.status IN ('active', 'suspended', 'restricted')
$$;

CREATE FUNCTION ops.commerce_store_by_shop(p_shop_domain text)
  RETURNS TABLE (tenant_id uuid, store_id uuid, state text, shop_external_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, s.id, s.state, s.shop_external_id
    FROM app.commerce_stores s
    JOIN app.tenants t ON t.id = s.tenant_id
   WHERE p_shop_domain ~ '^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$'
     AND s.platform = 'shopify' AND s.shop_domain = p_shop_domain
     AND t.status IN ('active', 'suspended', 'restricted')
$$;

CREATE FUNCTION ops.commerce_store_by_webhook(p_public_id text)
  RETURNS TABLE (tenant_id uuid, store_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.tenant_id, s.id
    FROM app.commerce_stores s
    JOIN app.tenants t ON t.id = s.tenant_id
   WHERE p_public_id ~ '^[a-z2-7]{16}$' AND s.platform = 'woocommerce'
     AND s.webhook_public_id = p_public_id
     AND t.status IN ('active', 'suspended', 'restricted')
$$;

GRANT EXECUTE ON FUNCTION app.list_live_tenant_ids() TO w360_app;
GRANT EXECUTE ON FUNCTION ops.follow_chat_link(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.chat_widget_config(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.flow_endpoint_target(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.commerce_payment_webhook_target(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.commerce_store_by_shop(text) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.commerce_store_by_webhook(text) TO w360_app;
ALTER FUNCTION app.list_live_tenant_ids() OWNER TO w360_definer;
ALTER FUNCTION ops.follow_chat_link(text) OWNER TO w360_definer;
ALTER FUNCTION ops.chat_widget_config(text) OWNER TO w360_definer;
ALTER FUNCTION ops.flow_endpoint_target(text) OWNER TO w360_definer;
ALTER FUNCTION ops.commerce_payment_webhook_target(text) OWNER TO w360_definer;
ALTER FUNCTION ops.commerce_store_by_shop(text) OWNER TO w360_definer;
ALTER FUNCTION ops.commerce_store_by_webhook(text) OWNER TO w360_definer;
