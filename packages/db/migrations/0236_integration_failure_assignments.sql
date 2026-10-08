-- Assigning companies' failing integrations on the operations console (P5-10, ADR-313).
-- Since ADR-141 an administrator acknowledges a failure Operations → Integrations lists, with a
-- note, so the others see who took it and what was found; an administrator now also assigns a
-- failure to a platform administrator, themselves or another, so each failure has someone who
-- handles it until it recovers.

-- One assignment per failure, by its integration (source and subject) and state: to whom, by whom
-- and when. `listed_at` is when the minute sweep's check last found the failure listed; an
-- assignment whose failure has not been listed for an hour is forgotten, as acknowledgements are
-- (0107), so a later failure of the same integration starts unassigned. No company data: the
-- failure is read from the console's list.
CREATE TABLE ops.integration_assignments (
  source text NOT NULL CHECK (char_length(source) <= 40),
  subject_id uuid NOT NULL,
  state text NOT NULL CHECK (char_length(state) <= 40),
  assignee_user_id text NOT NULL REFERENCES auth.users (id),
  assigned_by_user_id text NOT NULL REFERENCES auth.users (id),
  assigned_at timestamptz NOT NULL,
  listed_at timestamptz NOT NULL,
  CONSTRAINT integration_assignments_pkey PRIMARY KEY (source, subject_id, state)
);
GRANT SELECT, INSERT, DELETE,
  UPDATE (assignee_user_id, assigned_by_user_id, assigned_at, listed_at)
  ON ops.integration_assignments TO w360_definer;

-- Assigns a failure the console lists now to a platform administrator, replacing an earlier
-- assignment of the same failure, or takes the assignment off (no assignee), and audits it in the
-- same transaction. Platform administrators only, and only to one.
CREATE FUNCTION ops.platform_assign_integration_failure(p_source text, p_subject_id uuid,
    p_state text, p_assignee_user_id text, p_correlation_id text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_tenant uuid;
BEGIN
  IF v_actor IS NULL
     OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF p_assignee_user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = p_assignee_user_id) THEN
    RAISE EXCEPTION 'Assign the failure to a platform administrator.' USING ERRCODE = 'W3412';
  END IF;
  SELECT f.tenant_id INTO v_tenant
    FROM ops.integration_failures() f
   WHERE f.source = p_source AND f.subject_id = p_subject_id AND f.state = p_state
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This integration is no longer failing in that state. Reload the page.'
      USING ERRCODE = 'W3404';
  END IF;
  IF p_assignee_user_id IS NULL THEN
    DELETE FROM ops.integration_assignments k
     WHERE k.source = p_source AND k.subject_id = p_subject_id AND k.state = p_state;
    -- Taking off an assignment nobody made changes nothing, and is not audited.
    IF NOT FOUND THEN
      RETURN;
    END IF;
  ELSE
    INSERT INTO ops.integration_assignments AS k
      (source, subject_id, state, assignee_user_id, assigned_by_user_id, assigned_at, listed_at)
    VALUES (p_source, p_subject_id, p_state, p_assignee_user_id, v_actor, now(), now())
    ON CONFLICT ON CONSTRAINT integration_assignments_pkey DO UPDATE
      SET assignee_user_id = EXCLUDED.assignee_user_id,
          assigned_by_user_id = EXCLUDED.assigned_by_user_id,
          assigned_at = EXCLUDED.assigned_at,
          listed_at = EXCLUDED.listed_at;
  END IF;
  INSERT INTO ops.platform_audit_events
    (actor_user_id, action, target_tenant_id, result, correlation_id, metadata)
  VALUES (v_actor,
          CASE WHEN p_assignee_user_id IS NULL THEN 'platform.integration_failure_unassigned'
               ELSE 'platform.integration_failure_assigned' END,
          v_tenant, 'success', p_correlation_id,
          jsonb_build_object('source', p_source, 'subjectId', p_subject_id, 'state', p_state)
          || CASE WHEN p_assignee_user_id IS NULL THEN '{}'::jsonb
                  ELSE jsonb_build_object('assigneeUserId', p_assignee_user_id) END);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_assign_integration_failure(text, uuid, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_assign_integration_failure(text, uuid, text, text, text)
  TO w360_platform;
ALTER FUNCTION ops.platform_assign_integration_failure(text, uuid, text, text, text)
  OWNER TO w360_definer;

-- The console's list as in 0107, with each failure's assignment (when, to whom and by whom). The
-- owner drops the function and the migration role recreates it (see 0011).
SET ROLE w360_definer;
DROP FUNCTION ops.platform_ops_integration_failures(integer);
RESET ROLE;
CREATE FUNCTION ops.platform_ops_integration_failures(p_limit integer)
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
    LEFT JOIN ops.integration_acknowledgements k
      ON k.source = f.source AND k.subject_id = f.subject_id AND k.state = f.state
    LEFT JOIN auth.users u ON u.id = k.acknowledged_by_user_id
    LEFT JOIN ops.integration_assignments s
      ON s.source = f.source AND s.subject_id = f.subject_id AND s.state = f.state
    LEFT JOIN auth.users assignee ON assignee.id = s.assignee_user_id
    LEFT JOIN auth.users assigner ON assigner.id = s.assigned_by_user_id
   ORDER BY f.since DESC NULLS LAST, f.subject_id
   LIMIT least(greatest(p_limit, 1), 1000);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_integration_failures(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_integration_failures(integer) TO w360_platform;
ALTER FUNCTION ops.platform_ops_integration_failures(integer) OWNER TO w360_definer;

-- The sweep's check as in 0107, reading the console's list once: keeps the alert marks, the
-- acknowledgements and the assignments of failures still listed (refreshed at most every 10
-- minutes), counts the listed failures not told yet, then forgets marks, acknowledgements and
-- assignments not listed for an hour.
SET ROLE w360_definer;
DROP FUNCTION ops.integration_alerts_due();
RESET ROLE;
CREATE FUNCTION ops.integration_alerts_due()
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_due integer;
BEGIN
  WITH listed AS MATERIALIZED (
    SELECT l.source, l.subject_id, l.state FROM ops.integration_failures() l
  ), kept_marks AS (
    UPDATE ops.integration_alerts a SET listed_at = now()
      FROM listed f
     WHERE a.source = f.source AND a.subject_id = f.subject_id AND a.state = f.state
       AND a.listed_at < now() - interval '10 minutes'
    RETURNING 1
  ), kept_acknowledgements AS (
    UPDATE ops.integration_acknowledgements k SET listed_at = now()
      FROM listed f
     WHERE k.source = f.source AND k.subject_id = f.subject_id AND k.state = f.state
       AND k.listed_at < now() - interval '10 minutes'
    RETURNING 1
  ), kept_assignments AS (
    UPDATE ops.integration_assignments s SET listed_at = now()
      FROM listed f
     WHERE s.source = f.source AND s.subject_id = f.subject_id AND s.state = f.state
       AND s.listed_at < now() - interval '10 minutes'
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_due
    FROM listed f
   WHERE NOT EXISTS (SELECT 1 FROM ops.integration_alerts a
                      WHERE a.source = f.source AND a.subject_id = f.subject_id
                        AND a.state = f.state);
  DELETE FROM ops.integration_alerts a WHERE a.listed_at < now() - interval '1 hour';
  DELETE FROM ops.integration_acknowledgements k WHERE k.listed_at < now() - interval '1 hour';
  DELETE FROM ops.integration_assignments s WHERE s.listed_at < now() - interval '1 hour';
  RETURN v_due;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.integration_alerts_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.integration_alerts_due() TO w360_app;
ALTER FUNCTION ops.integration_alerts_due() OWNER TO w360_definer;
