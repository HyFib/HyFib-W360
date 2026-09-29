-- API access and monthly API requests by plan (ADR-061).

-- Plan versions -------------------------------------------------------------------------------------------
-- NULL: no monthly limit; 0: the plan leaves the public API out; otherwise the requests a company may
-- make per monthly usage period. Versions published before this migration keep NULL, which is what
-- they gave: the API without a monthly limit.
ALTER TABLE ops.plans
  ADD COLUMN api_requests_monthly integer
    CHECK (api_requests_monthly BETWEEN 0 AND 1000000000);

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
        NEW.api_requests_monthly, NEW.published_by_user_id, NEW.published_at)
       IS DISTINCT FROM
       (OLD.name, OLD.description, OLD.currency, OLD.price_minor, OLD.interval_months, OLD.trial_days,
        OLD.grace_days, OLD.seats_included, OLD.seat_price_minor, OLD.seats_max, OLD.numbers_included,
        OLD.number_price_minor, OLD.numbers_max, OLD.teams_max, OLD.live_automations_max,
        OLD.automation_runs_monthly, OLD.run_pack_size, OLD.run_pack_price_minor, OLD.modules,
        OLD.api_requests_monthly, OLD.published_by_user_id, OLD.published_at) THEN
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

GRANT UPDATE (api_requests_monthly) ON ops.plans TO w360_platform;

-- Usage counters -------------------------------------------------------------------------------------------
-- API requests are counted per company and monthly period like automation runs, with or without a
-- limit.
ALTER TABLE app.usage_counters DROP CONSTRAINT usage_counters_metric_check;
ALTER TABLE app.usage_counters ADD CONSTRAINT usage_counters_metric_check
  CHECK (metric IN ('automation_runs', 'api_requests'));

-- Entitlements ---------------------------------------------------------------------------------------------
-- As in 0023, with the monthly API requests (NULL: no limit; 0: the plan leaves the API out).
-- Complimentary access has no limit. The result gains a column, so the function is recreated.
DROP FUNCTION app.tenant_entitlements(uuid);
CREATE FUNCTION app.tenant_entitlements(p_tenant_id uuid)
  RETURNS TABLE (plan_status text, plan_id uuid, seats integer, numbers integer, teams integer,
    live_automations integer, automation_runs integer, modules text[], usage_anchor timestamptz,
    api_requests integer)
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
         p.api_requests_monthly
    FROM app.tenant_plans tp
    LEFT JOIN ops.plans p ON p.id = tp.plan_id
   WHERE tp.tenant_id = p_tenant_id
$$;
REVOKE EXECUTE ON FUNCTION app.tenant_entitlements(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_entitlements(uuid) TO w360_app, w360_definer, w360_platform;

-- Notices --------------------------------------------------------------------------------------------------
-- API request counters of the last month that reached their company's limit and were not announced
-- yet (ids only), like ops.usage_limits_reached for automation runs.
CREATE FUNCTION ops.api_quota_reached(p_limit integer)
  RETURNS TABLE (tenant_id uuid, counter_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT u.tenant_id, u.id
    FROM app.usage_counters u
    JOIN app.tenant_plans tp ON tp.tenant_id = u.tenant_id
    JOIN ops.plans p ON p.id = tp.plan_id
    JOIN app.tenants t ON t.id = u.tenant_id AND t.status = 'active'
   WHERE u.metric = 'api_requests' AND u.notified_at IS NULL
     AND u.period_start > now() - interval '32 days'
     AND p.api_requests_monthly > 0
     AND u.used >= p.api_requests_monthly
   ORDER BY u.tenant_id
   LIMIT p_limit
$$;
REVOKE EXECUTE ON FUNCTION ops.api_quota_reached(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.api_quota_reached(integer) TO w360_app;
ALTER FUNCTION ops.api_quota_reached(integer) OWNER TO w360_definer;
