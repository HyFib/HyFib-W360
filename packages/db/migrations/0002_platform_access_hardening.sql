-- 0002_platform_access_hardening: function privileges and the platform role's read boundary.

-- 1. Function privileges -------------------------------------------------------------------------
-- 0001 intended every function to be callable only by the roles named in explicit grants, but:
--   * ALTER DEFAULT PRIVILEGES ... IN SCHEMA cannot revoke PostgreSQL's global default EXECUTE
--     grant to PUBLIC, so every function was executable by every role; and
--   * GRANTs issued after ALTER FUNCTION ... OWNER TO w360_definer granted nothing ("no privileges
--     were granted"): the migration role may SET ROLE to w360_definer but does not inherit its
--     privileges, so it could not grant on functions it no longer owned.
-- Remove PUBLIC execution, make that the global default for functions created by the migration
-- role, and re-issue the intended grants on definer-owned functions as their owner. From now on,
-- grant on a new definer function BEFORE handing it to w360_definer (ownership transfer rewrites the
-- grantor), as the functions below do.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE FUNCTION ops.revoke_public_execute_on_own_functions() RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
     WHERE p.pronamespace IN ('app'::regnamespace, 'ops'::regnamespace)
       AND p.proowner = (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user)
  LOOP
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.revoke_public_execute_on_own_functions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.revoke_public_execute_on_own_functions() TO w360_definer;

SELECT ops.revoke_public_execute_on_own_functions();

SET ROLE w360_definer;
SELECT ops.revoke_public_execute_on_own_functions();
GRANT EXECUTE ON FUNCTION app.create_tenant(uuid, uuid, text, text, text, text) TO w360_app;
GRANT EXECUTE ON FUNCTION app.invitation_preview(text) TO w360_app;
GRANT EXECUTE ON FUNCTION app.accept_invitation(text, uuid) TO w360_app;
GRANT EXECUTE ON FUNCTION app.list_live_tenant_ids() TO w360_app;
GRANT EXECUTE ON FUNCTION app.tenant_status(uuid) TO w360_app;
GRANT EXECUTE ON FUNCTION ops.platform_reset_user_mfa(text, text) TO w360_platform;
RESET ROLE;

DROP FUNCTION ops.revoke_public_execute_on_own_functions();

-- 2. Membership directory ------------------------------------------------------------------------
-- A company's membership directory (user ids, roles, statuses) is customer data. Platform staff
-- read it only through an active, reasoned, time-boxed support grant with the members.read scope,
-- the same boundary that already applied to invitations.
DROP POLICY platform_read ON app.memberships;
SELECT ops.apply_support_read('app.memberships', 'members.read');

-- 3. Narrow platform facts -----------------------------------------------------------------------
-- The platform console still needs two facts without a grant, through SECURITY DEFINER functions
-- that check the caller is a platform administrator and return nothing more:
--   * active seat counts for the company list;
--   * the owners of one company, for account recovery (an owner who lost their second factor
--     cannot approve a support grant).
CREATE FUNCTION ops.platform_active_member_counts(p_tenant_ids uuid[])
  RETURNS TABLE (tenant_id uuid, active_members integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF cardinality(p_tenant_ids) > 500 THEN
    RAISE EXCEPTION 'at most 500 companies per call' USING ERRCODE = 'W3412';
  END IF;
  RETURN QUERY
    SELECT m.tenant_id, count(*)::integer
      FROM app.memberships m
     WHERE m.tenant_id = ANY (p_tenant_ids)
       AND m.status = 'active'
     GROUP BY m.tenant_id;
END
$$;
GRANT EXECUTE ON FUNCTION ops.platform_active_member_counts(uuid[]) TO w360_platform;
ALTER FUNCTION ops.platform_active_member_counts(uuid[]) OWNER TO w360_definer;

CREATE FUNCTION ops.platform_tenant_owners(p_tenant_id uuid)
  RETURNS TABLE (user_id text, name text, membership_status text, two_factor_enabled boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  RETURN QUERY
    SELECT u.id, u.name, m.status, u.two_factor_enabled
      FROM app.memberships m
      JOIN auth.users u ON u.id = m.user_id
     WHERE m.tenant_id = p_tenant_id
       AND 'owner' = ANY (m.roles)
     ORDER BY u.name, u.id;
END
$$;
GRANT EXECUTE ON FUNCTION ops.platform_tenant_owners(uuid) TO w360_platform;
ALTER FUNCTION ops.platform_tenant_owners(uuid) OWNER TO w360_definer;
