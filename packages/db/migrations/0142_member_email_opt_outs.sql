-- Members choose which notice emails they get, per company (ADR-215).
-- Notice emails about campaigns (ADR-204, ADR-205, ADR-210, ADR-214) and mentions (ADR-211) went to
-- every member they concern, with no way to stop them. A membership now lists the kinds its member
-- turned off; a notice skips a member who turned its kind off. Security, sign-in and billing
-- emails are not listed: they cannot be turned off.
--
-- The list is on the membership, so it is the company's data (exported with the membership, deleted
-- with the company) and each company's notices read it in the company's own scope. Existing members
-- keep every email: the list starts empty.
ALTER TABLE app.memberships
  ADD COLUMN email_opt_outs text[] NOT NULL DEFAULT '{}'
    CONSTRAINT memberships_email_opt_outs_check
    CHECK (email_opt_outs <@ ARRAY['mentions', 'campaign_approvals', 'campaign_reviews',
      'campaign_pauses', 'campaign_completions']::text[]);

-- Sets the current member's own list in the current company, sorted and without repeats, and
-- returns it. The membership is found from the scope (the company and the signed-in user), never
-- from an argument, so no member changes another's list; the runtime role has no update on
-- memberships.
CREATE FUNCTION app.set_own_email_opt_outs(p_opt_outs text[])
  RETURNS text[]
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_user text := app.current_user_id();
  v_result text[];
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'a signed-in member of a company is required' USING ERRCODE = 'W3403';
  END IF;
  UPDATE app.memberships m
     SET email_opt_outs = (SELECT coalesce(array_agg(DISTINCT k ORDER BY k), '{}')
                             FROM unnest(coalesce(p_opt_outs, '{}')) AS k)
   WHERE m.tenant_id = v_tenant AND m.user_id = v_user AND m.status = 'active'
  RETURNING m.email_opt_outs INTO v_result;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Membership not found.' USING ERRCODE = 'W3404';
  END IF;
  RETURN v_result;
END
$$;
REVOKE EXECUTE ON FUNCTION app.set_own_email_opt_outs(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_own_email_opt_outs(text[]) TO w360_app;
ALTER FUNCTION app.set_own_email_opt_outs(text[]) OWNER TO w360_definer;
