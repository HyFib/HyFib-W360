-- API scopes by plan (P5-01, P5-08, ADR-092). A plan version could leave the whole public API out
-- (0 monthly requests, ADR-061) but not part of it. It now chooses the scopes it includes; a request
-- whose key has a scope the plan leaves out is refused, and new keys cannot be given one.

-- Plan versions -------------------------------------------------------------------------------------------
-- NULL: every scope, including scopes HyFib adds later; otherwise the scopes the plan includes.
-- Versions published before this migration keep NULL, which is what they gave. A plan without the
-- API has no scopes to choose.
ALTER TABLE ops.plans
  ADD COLUMN api_scopes text[]
    CONSTRAINT plans_api_scopes_check CHECK (
      api_scopes IS NULL
      OR (cardinality(api_scopes) BETWEEN 1 AND 10
          AND array_position(api_scopes, NULL) IS NULL
          AND api_scopes <@ ARRAY['templates.read', 'contacts.read', 'contacts.write',
                                  'messages.send', 'messages.send_marketing', 'messages.reply',
                                  'conversations.read', 'conversations.write', 'automations.start',
                                  'webhooks.manage']::text[])),
  ADD CONSTRAINT plans_api_scopes_need_api
    CHECK (api_scopes IS NULL OR api_requests_monthly IS DISTINCT FROM 0);

-- The guard compares the new column too, so a published version still cannot change.
CREATE OR REPLACE FUNCTION ops.guard_plan() RETURNS trigger
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
        NEW.api_requests_monthly, NEW.api_scopes, NEW.published_by_user_id, NEW.published_at)
       IS DISTINCT FROM
       (OLD.name, OLD.description, OLD.currency, OLD.price_minor, OLD.interval_months, OLD.trial_days,
        OLD.grace_days, OLD.seats_included, OLD.seat_price_minor, OLD.seats_max, OLD.numbers_included,
        OLD.number_price_minor, OLD.numbers_max, OLD.teams_max, OLD.live_automations_max,
        OLD.automation_runs_monthly, OLD.run_pack_size, OLD.run_pack_price_minor, OLD.modules,
        OLD.api_requests_monthly, OLD.api_scopes, OLD.published_by_user_id, OLD.published_at) THEN
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

GRANT UPDATE (api_scopes) ON ops.plans TO w360_platform;

-- Entitlements ---------------------------------------------------------------------------------------------
-- As in 0035, with the plan's API scopes (NULL: every scope). Complimentary access includes every
-- scope. The result gains a column, so the function is recreated; the web app of the previous
-- release reads its columns by name, so it keeps working while a deploy rolls out.
DROP FUNCTION app.tenant_entitlements(uuid);
CREATE FUNCTION app.tenant_entitlements(p_tenant_id uuid)
  RETURNS TABLE (plan_status text, plan_id uuid, seats integer, numbers integer, teams integer,
    live_automations integer, automation_runs integer, modules text[], usage_anchor timestamptz,
    api_requests integer, api_scopes text[])
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
         tp.usage_anchor,
         p.api_requests_monthly,
         p.api_scopes
    FROM app.tenant_plans tp
    LEFT JOIN ops.plans p ON p.id = tp.plan_id
   WHERE tp.tenant_id = p_tenant_id
$$;
REVOKE EXECUTE ON FUNCTION app.tenant_entitlements(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_entitlements(uuid) TO w360_app, w360_definer, w360_platform;
