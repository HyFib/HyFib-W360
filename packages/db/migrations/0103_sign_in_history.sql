-- Sign-in history for each person (SEC-9, ADR-136). Every completed sign-in is a security event
-- `auth.sign_in` (recorded by the web's Better Auth plugin) naming the person, the address and
-- browser of the session it handed out, and in its details how they signed in and the session's id.
-- People read only their own through ops.my_sign_ins: the application role still inserts security
-- events and reads none otherwise. The definer reads the columns it returns.
CREATE INDEX security_events_sign_ins_idx ON ops.security_events (user_id, occurred_at DESC, id DESC)
  WHERE event_type = 'auth.sign_in';

CREATE FUNCTION ops.my_sign_ins(p_limit integer)
  RETURNS TABLE (occurred_at timestamptz, method text, session_id text, ip_address inet, user_agent text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_user text := app.current_user_id();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = 'W3401';
  END IF;
  RETURN QUERY
  SELECT e.occurred_at, e.details ->> 'method', e.details ->> 'sessionId', e.ip_address, e.user_agent
    FROM ops.security_events e
   WHERE e.event_type = 'auth.sign_in' AND e.user_id = v_user
   ORDER BY e.occurred_at DESC, e.id DESC
   LIMIT least(greatest(coalesce(p_limit, 0), 0), 100);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.my_sign_ins(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.my_sign_ins(integer) TO w360_app;
GRANT SELECT (id, occurred_at, event_type, user_id, ip_address, user_agent, details)
  ON ops.security_events TO w360_definer;
ALTER FUNCTION ops.my_sign_ins(integer) OWNER TO w360_definer;
