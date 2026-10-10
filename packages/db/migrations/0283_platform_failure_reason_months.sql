-- The year's failed sends by reason, month by month (P5-10, ADR-360).
--
-- The Usage tab and a company's platform page list the year's failed sends by the code they failed
-- with (0269, ADR-350): which reasons, not when. A reason that began in the spring, or one that has
-- faded since, read the same as one there all year. The same 365 days are now read by UTC calendar
-- month too, the codes ranked as the year ranks them, so each listed reason draws its months beside
-- its total. Codes and counts only, as the year's.

-- The failed sends of the 365 days before today whose codes are counted, by UTC calendar month and
-- code (platform administrators; every company's not deleted, or one company's), the codes ranked
-- as ops.platform_ops_failure_reason_year ranks them over the whole year: the eight most frequent,
-- ties by code, then the rest together (null) when two or more are left. A month without a failed
-- send of a code has no row. The first and last months are partial: the year starts 365 days before
-- today and ends yesterday. Read in the year's snapshot, a code's months add up to its year.
CREATE FUNCTION ops.platform_ops_failure_reason_months(p_tenant_id uuid)
  RETURNS TABLE (month date, reason_code text, failed_sends integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
  v_today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  RETURN QUERY
  WITH by_month AS (
    SELECT r.reason_code AS code, date_trunc('month', r.utc_day::timestamp)::date AS m,
           sum(r.failed)::integer AS n
      FROM ops.platform_failure_reason_days r
      JOIN ops.platform_message_days_counted c ON c.utc_day = r.utc_day AND c.reasons
      JOIN app.tenants t ON t.id = r.tenant_id
     WHERE r.utc_day >= v_today - 365 AND r.utc_day < v_today
       AND t.status <> 'deleted' AND (p_tenant_id IS NULL OR r.tenant_id = p_tenant_id)
     GROUP BY 1, 2),
  by_code AS (
    SELECT b.code, sum(b.n)::integer AS n FROM by_month b GROUP BY 1),
  ranked AS (
    SELECT k.code, row_number() OVER (ORDER BY k.n DESC, k.code) AS r, count(*) OVER () AS total
      FROM by_code k)
  SELECT b.m, CASE WHEN k.r <= 8 OR k.total <= 9 THEN b.code END, sum(b.n)::integer
    FROM by_month b
    JOIN ranked k ON k.code = b.code
   GROUP BY 1, 2
   ORDER BY 1, min(k.r);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_failure_reason_months(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_failure_reason_months(uuid) TO w360_platform;
ALTER FUNCTION ops.platform_ops_failure_reason_months(uuid) OWNER TO w360_definer;
