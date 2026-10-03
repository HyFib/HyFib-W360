-- Rotating the job signing key (SEC-4, ADR-135). A job's envelope names the key that signed it
-- (`kid`, outside the signature). While a previous key is configured, the worker's minute sweep signs
-- the jobs that key signed again with the signing key; the runtime role writes pg-boss's jobs
-- itself, as pg-boss does. ops.job_signing_key_counts tells the operations console how many jobs
-- that can still run name each key, so that staff know when the previous key can be removed. The
-- definer reads pg-boss's job data for it (granted by the migration runner, which installs pg-boss's
-- schema after these migrations); the function returns key ids, states and counts only.
CREATE FUNCTION ops.job_signing_key_counts()
  RETURNS TABLE (key_id text, state text, jobs bigint)
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
  SELECT j.data ->> 'kid', j.state::text, count(*)
    FROM pgboss.job j
   WHERE j.state IN ('created', 'retry', 'active', 'failed')
     AND jsonb_typeof(j.data) = 'object' AND j.data ? 'sig'
   GROUP BY 1, 2;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.job_signing_key_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.job_signing_key_counts() TO w360_platform;
ALTER FUNCTION ops.job_signing_key_counts() OWNER TO w360_definer;
