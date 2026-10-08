-- Emailing a platform administrator a failing integration was assigned to (P5-10, ADR-314). Since
-- 0236 an administrator assigns a failure Operations → Integrations lists to another, who learnt
-- of it only by opening the console; the worker's minute sweep now emails each assignee once about
-- the failures assigned to them since its last run, with counts by kind and who assigned them, as
-- the alert emails do (0106): the companies and errors stay on the console.

-- When the assignee was told; null while they were not. An administrator who assigns a failure to
-- themselves needs no email, and assignments made before this migration are taken as told, so
-- nobody is emailed about one made before the email existed.
ALTER TABLE ops.integration_assignments ADD COLUMN notified_at timestamptz;
UPDATE ops.integration_assignments SET notified_at = assigned_at;
GRANT UPDATE (notified_at) ON ops.integration_assignments TO w360_definer;

-- 0236's assignment, which now also says whether the assignee is still to be told: an assignee
-- who assigned the failure to themselves is told by doing it; the same assignee keeps what they
-- were told; a new one is told by the next sweep. The owner drops the function and the migration
-- role recreates it (see 0011).
SET ROLE w360_definer;
DROP FUNCTION ops.platform_assign_integration_failure(text, uuid, text, text, text);
RESET ROLE;
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
      (source, subject_id, state, assignee_user_id, assigned_by_user_id, assigned_at, listed_at,
       notified_at)
    VALUES (p_source, p_subject_id, p_state, p_assignee_user_id, v_actor, now(), now(),
            CASE WHEN p_assignee_user_id = v_actor THEN now() END)
    ON CONFLICT ON CONSTRAINT integration_assignments_pkey DO UPDATE
      SET assignee_user_id = EXCLUDED.assignee_user_id,
          assigned_by_user_id = EXCLUDED.assigned_by_user_id,
          assigned_at = EXCLUDED.assigned_at,
          listed_at = EXCLUDED.listed_at,
          notified_at = CASE
            WHEN EXCLUDED.assignee_user_id = EXCLUDED.assigned_by_user_id
              THEN coalesce(k.notified_at, now())
            WHEN EXCLUDED.assignee_user_id = k.assignee_user_id THEN k.notified_at
          END;
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

-- The minute sweep's notices: marks every assignment not told yet as told, and returns those whose
-- failure the console still lists and whose assignee is still a platform administrator, with the
-- assignee's address and who assigned it (an account an assignment names cannot be deleted), for
-- the emails queued in the same transaction. A failure that recovered, or an assignee who is no
-- longer an administrator, is marked and not told, so it is never told later. Two sweeps at once
-- tell each assignment once: the second waits for the first's rows and finds them told. The
-- worker's role only.
CREATE FUNCTION ops.claim_integration_assignment_notices()
  RETURNS TABLE (assignee_user_id text, email text, assigned_by_user_id text,
    assigned_by_name text, source text, state text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  RETURN QUERY
  WITH told AS (
    UPDATE ops.integration_assignments s SET notified_at = now()
     WHERE s.notified_at IS NULL
    RETURNING s.source, s.subject_id, s.state, s.assignee_user_id, s.assigned_by_user_id
  ), listed AS MATERIALIZED (
    SELECT f.source, f.subject_id, f.state FROM ops.integration_failures() f
     WHERE EXISTS (SELECT 1 FROM told)
  )
  SELECT t.assignee_user_id, u.email, t.assigned_by_user_id, b.name, t.source, t.state
    FROM told t
    JOIN listed l ON l.source = t.source AND l.subject_id = t.subject_id AND l.state = t.state
    JOIN ops.platform_admins a ON a.user_id = t.assignee_user_id
    JOIN auth.users u ON u.id = t.assignee_user_id
    JOIN auth.users b ON b.id = t.assigned_by_user_id
   ORDER BY t.assignee_user_id, t.source, t.state;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.claim_integration_assignment_notices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.claim_integration_assignment_notices() TO w360_app;
ALTER FUNCTION ops.claim_integration_assignment_notices() OWNER TO w360_definer;
