-- Companies choose their add-ons (P5-01/P5-07, ADR-106).
--
-- A company's owners and billing managers set the extra seats, extra WhatsApp numbers and automation
-- run packs of the plan version it is on, under the conditions and locks of choosing a plan
-- (ADR-105), and then pay for them with the plan as before (ADR-063). Only the three quantities
-- change, through app.choose_add_ons; the plan state's guard (0023) keeps them to what the version
-- sells, within its maximums.

-- The company's own add-ons, in its own scope by the member in app.user_id (the web checks
-- `billing.manage` and a recent sign-in first). Allowed while the company is active or restricted,
-- has no subscription that may still be charged, is on a trial, past due, expired or canceled, its
-- version is still published, and paying for plans is set up (the tax on plan prices). Only the
-- quantities change; the version, status, dates and usage period stay. Locks as app.choose_plan:
-- the advisory lock a subscription start takes (so a start never records add-ons being replaced),
-- then the company row, shared (a deletion request updates it), then the plan state, in the order
-- the plan sweep and staff changes take them. The version is read without a lock: a retirement
-- committing meanwhile leaves the company on its version, as it leaves every company on it, and a
-- retired version cannot be paid for whatever its add-ons. Returns 'chosen' or 'unchanged', with
-- the quantities before.
CREATE FUNCTION app.choose_add_ons(p_extra_seats integer, p_extra_numbers integer,
                                   p_run_packs integer)
  RETURNS TABLE (result text, previous_extra_seats integer, previous_extra_numbers integer,
                 previous_run_packs integer)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_user text := app.current_user_id();
  v_company text;
  v app.tenant_plans%ROWTYPE;
  p ops.plans%ROWTYPE;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'Add-ons are chosen by a member, in the company''s own scope.'
      USING ERRCODE = 'W3403';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('w360:plan-subscriptions:' || v_tenant::text, 0));
  SELECT t.status INTO v_company FROM app.tenants t WHERE t.id = v_tenant FOR SHARE;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'Company not found.' USING ERRCODE = 'W3404';
  END IF;
  IF v_company IN ('pending_deletion', 'deleted') THEN
    RAISE EXCEPTION 'Your company is being deleted, so its add-ons cannot change.'
      USING ERRCODE = 'W3412';
  END IF;
  IF v_company = 'suspended' THEN
    RAISE EXCEPTION 'Your company is suspended, so its add-ons cannot change.'
      USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO v FROM app.tenant_plans tp WHERE tp.tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The company has no plan state.' USING ERRCODE = 'W3404';
  END IF;
  IF v.status = 'complimentary' THEN
    RAISE EXCEPTION 'Your company has complimentary access, so there are no add-ons to choose.'
      USING ERRCODE = 'W3412';
  END IF;
  IF v.status = 'active' THEN
    RAISE EXCEPTION 'Your plan has a paid period. You can choose add-ons once it ends, or ask HyFib to change them.'
      USING ERRCODE = 'W3412';
  END IF;
  IF EXISTS (SELECT 1 FROM app.plan_subscriptions s
              WHERE s.tenant_id = v_tenant
                AND s.status IN ('creating', 'created', 'authenticated', 'active', 'pending',
                                 'halted', 'paused')) THEN
    RAISE EXCEPTION 'Your company has a plan subscription that can still be charged. Cancel it, or let its payment window close, before choosing add-ons.'
      USING ERRCODE = 'W3412';
  END IF;
  SELECT * INTO p FROM ops.plans pl WHERE pl.id = v.plan_id;
  IF NOT FOUND OR p.status <> 'published' THEN
    RAISE EXCEPTION 'Your plan version is no longer offered, so its add-ons cannot change. Choose another plan.'
      USING ERRCODE = 'W3412';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ops.plan_settings s WHERE s.plan_tax_bp IS NOT NULL) THEN
    RAISE EXCEPTION 'Paying for plans here is not available yet. Ask HyFib to change your add-ons.'
      USING ERRCODE = 'W3412';
  END IF;
  IF (v.extra_seats, v.extra_numbers, v.run_packs)
     IS NOT DISTINCT FROM (p_extra_seats, p_extra_numbers, p_run_packs) THEN
    RETURN QUERY SELECT 'unchanged'::text, v.extra_seats, v.extra_numbers, v.run_packs;
    RETURN;
  END IF;
  UPDATE app.tenant_plans
     SET extra_seats = p_extra_seats,
         extra_numbers = p_extra_numbers,
         run_packs = p_run_packs,
         note = 'Add-ons chosen by the company.',
         changed_by_user_id = v_user, changed_at = now(), version = v.version + 1
   WHERE id = v.id;
  RETURN QUERY SELECT 'chosen'::text, v.extra_seats, v.extra_numbers, v.run_packs;
END
$$;
REVOKE EXECUTE ON FUNCTION app.choose_add_ons(integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.choose_add_ons(integer, integer, integer) TO w360_app;
ALTER FUNCTION app.choose_add_ons(integer, integer, integer) OWNER TO w360_definer;
