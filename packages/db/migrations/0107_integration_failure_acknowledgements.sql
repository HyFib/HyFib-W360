-- Acknowledging companies' failing integrations on the operations console (P5-10, ADR-141). Since
-- ADR-139 every platform administrator is emailed about each failure Operations → Integrations
-- lists; an administrator now records on the console that a failure is being handled, with a note,
-- so the others see who took it and what was found.

-- One acknowledgement per failure, by its integration (source and subject) and state: who, when and
-- the note. `listed_at` is when the minute sweep's check last found the failure listed; an
-- acknowledgement whose failure has not been listed for an hour is forgotten, as the alert marks are
-- (0106), so a later failure of the same integration starts unacknowledged. No company data: the
-- failure is read from the console's list.
CREATE TABLE ops.integration_acknowledgements (
  source text NOT NULL CHECK (char_length(source) <= 40),
  subject_id uuid NOT NULL,
  state text NOT NULL CHECK (char_length(state) <= 40),
  acknowledged_by_user_id text NOT NULL REFERENCES auth.users (id),
  acknowledged_at timestamptz NOT NULL,
  note text NOT NULL CHECK (char_length(note) BETWEEN 10 AND 500),
  listed_at timestamptz NOT NULL,
  CONSTRAINT integration_acknowledgements_pkey PRIMARY KEY (source, subject_id, state)
);
GRANT SELECT, INSERT, DELETE,
  UPDATE (acknowledged_by_user_id, acknowledged_at, note, listed_at)
  ON ops.integration_acknowledgements TO w360_definer;

-- Records an acknowledgement of a failure the console lists now, replacing an earlier one of the
-- same failure, and audits it in the same transaction. Platform administrators only.
CREATE FUNCTION ops.platform_acknowledge_integration_failure(p_source text, p_subject_id uuid,
    p_state text, p_note text, p_correlation_id text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_note text := btrim(p_note);
  v_tenant uuid;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF v_note IS NULL OR char_length(v_note) < 10 OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'Write a note of 10 to 500 characters.' USING ERRCODE = 'W3412';
  END IF;
  SELECT f.tenant_id INTO v_tenant
    FROM ops.integration_failures() f
   WHERE f.source = p_source AND f.subject_id = p_subject_id AND f.state = p_state
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This integration is no longer failing in that state. Reload the page.'
      USING ERRCODE = 'W3404';
  END IF;
  INSERT INTO ops.integration_acknowledgements AS k
    (source, subject_id, state, acknowledged_by_user_id, acknowledged_at, note, listed_at)
  VALUES (p_source, p_subject_id, p_state, v_actor, now(), v_note, now())
  ON CONFLICT ON CONSTRAINT integration_acknowledgements_pkey DO UPDATE
    SET acknowledged_by_user_id = EXCLUDED.acknowledged_by_user_id,
        acknowledged_at = EXCLUDED.acknowledged_at,
        note = EXCLUDED.note,
        listed_at = EXCLUDED.listed_at;
  INSERT INTO ops.platform_audit_events
    (actor_user_id, action, target_tenant_id, reason, result, correlation_id, metadata)
  VALUES (v_actor, 'platform.integration_failure_acknowledged', v_tenant, v_note, 'success',
          p_correlation_id,
          jsonb_build_object('source', p_source, 'subjectId', p_subject_id, 'state', p_state));
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_acknowledge_integration_failure(text, uuid, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_acknowledge_integration_failure(text, uuid, text, text, text)
  TO w360_platform;
ALTER FUNCTION ops.platform_acknowledge_integration_failure(text, uuid, text, text, text)
  OWNER TO w360_definer;

-- The console's list as in 0106, with each failure's acknowledgement (when, by whom and the note).
-- The owner drops the function and the migration role recreates it (see 0011).
SET ROLE w360_definer;
DROP FUNCTION ops.platform_ops_integration_failures(integer);
RESET ROLE;
CREATE FUNCTION ops.platform_ops_integration_failures(p_limit integer)
  RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_slug text, source text, subject_id uuid,
    label text, state text, error text, since timestamptz, acknowledged_at timestamptz,
    acknowledged_by_name text, acknowledgement text)
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
  SELECT f.tenant_id, f.tenant_name, f.tenant_slug, f.source, f.subject_id, f.label, f.state,
         f.error, f.since, k.acknowledged_at, u.name, k.note
    FROM ops.integration_failures() f
    LEFT JOIN ops.integration_acknowledgements k
      ON k.source = f.source AND k.subject_id = f.subject_id AND k.state = f.state
    LEFT JOIN auth.users u ON u.id = k.acknowledged_by_user_id
   ORDER BY f.since DESC NULLS LAST, f.subject_id
   LIMIT least(greatest(p_limit, 1), 1000);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_integration_failures(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_integration_failures(integer) TO w360_platform;
ALTER FUNCTION ops.platform_ops_integration_failures(integer) OWNER TO w360_definer;

-- The sweep's check as in 0106, reading the console's list once: keeps the alert marks and the
-- acknowledgements of failures still listed (refreshed at most every 10 minutes), counts the listed
-- failures not told yet, then forgets marks and acknowledgements not listed for an hour.
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
  )
  SELECT count(*)::integer INTO v_due
    FROM listed f
   WHERE NOT EXISTS (SELECT 1 FROM ops.integration_alerts a
                      WHERE a.source = f.source AND a.subject_id = f.subject_id
                        AND a.state = f.state);
  DELETE FROM ops.integration_alerts a WHERE a.listed_at < now() - interval '1 hour';
  DELETE FROM ops.integration_acknowledgements k WHERE k.listed_at < now() - interval '1 hour';
  RETURN v_due;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.integration_alerts_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.integration_alerts_due() TO w360_app;
ALTER FUNCTION ops.integration_alerts_due() OWNER TO w360_definer;
