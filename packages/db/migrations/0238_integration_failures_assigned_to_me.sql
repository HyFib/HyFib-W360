-- The failing integrations assigned to the administrator reading the console (P5-10, ADR-315).
-- Since 0236 Current failures shows each failure's assignee, among up to 500 failures, newest
-- first; an administrator looking for the failures they handle read the whole list. The console
-- now also lists only the failures assigned to the administrator reading it, read before the
-- limit, so none of theirs is left out by older failures of others.

-- 0236's list, narrowed to the failures assigned to the administrator calling it: the same
-- columns, order and limit, and the same refusal of anyone who is not a platform administrator.
-- The platform role only, as the full list.
CREATE FUNCTION ops.platform_ops_assigned_integration_failures(p_limit integer)
  RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_slug text, source text, subject_id uuid,
    label text, state text, error text, since timestamptz, acknowledged_at timestamptz,
    acknowledged_by_name text, acknowledgement text, assigned_at timestamptz,
    assignee_user_id text, assignee_name text, assigned_by_name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
BEGIN
  IF v_actor IS NULL
     OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  RETURN QUERY
  SELECT f.tenant_id, f.tenant_name, f.tenant_slug, f.source, f.subject_id, f.label, f.state,
         f.error, f.since, k.acknowledged_at, u.name, k.note, s.assigned_at, s.assignee_user_id,
         assignee.name, assigner.name
    FROM ops.integration_failures() f
    JOIN ops.integration_assignments s
      ON s.source = f.source AND s.subject_id = f.subject_id AND s.state = f.state
     AND s.assignee_user_id = v_actor
    LEFT JOIN ops.integration_acknowledgements k
      ON k.source = f.source AND k.subject_id = f.subject_id AND k.state = f.state
    LEFT JOIN auth.users u ON u.id = k.acknowledged_by_user_id
    LEFT JOIN auth.users assignee ON assignee.id = s.assignee_user_id
    LEFT JOIN auth.users assigner ON assigner.id = s.assigned_by_user_id
   ORDER BY f.since DESC NULLS LAST, f.subject_id
   LIMIT least(greatest(p_limit, 1), 1000);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_assigned_integration_failures(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_assigned_integration_failures(integer)
  TO w360_platform;
ALTER FUNCTION ops.platform_ops_assigned_integration_failures(integer) OWNER TO w360_definer;
