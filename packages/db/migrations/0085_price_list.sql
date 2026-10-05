-- A price list for visitors (P5-01/P5-07, ADR-107).
--
-- Platform owners show the plan versions offered to companies (ADR-105) on a public price list, or
-- hide it again; it stays hidden until one of them shows it. Who showed it is kept with the time,
-- for the platform role only.
ALTER TABLE ops.plan_settings
  ADD COLUMN price_list_shown_at timestamptz,
  ADD COLUMN price_list_shown_by_user_id text REFERENCES auth.users (id),
  ADD CONSTRAINT plan_settings_price_list_by
    CHECK ((price_list_shown_at IS NULL) = (price_list_shown_by_user_id IS NULL));
GRANT UPDATE (price_list_shown_at, price_list_shown_by_user_id) ON ops.plan_settings TO w360_platform;

-- The price list reads in the system scope as the runtime role, which already reads published and
-- retired versions (0023) and the tax on plan prices (0037). It also needs whether the list is shown
-- and the default trial, whose length it states; not who showed it.
GRANT SELECT (default_trial_plan_id, price_list_shown_at) ON ops.plan_settings TO w360_app;
