-- The year's failed sends by company, month by month (P5-10, ADR-362).
--
-- The Usage tab lists the year's failed sends by reason, month by month (0269, 0283, ADR-350,
-- ADR-360), every company's together, and its companies table counts no failed sends (ADR-157): a
-- company whose sends began failing, or one failing all year, did not stand out. The same 365 days
-- are now read by company too, the companies ranked by their failed sends over the whole year, so
-- those failing most show their months beside their totals. Counts only, with each company's name
-- and slug, as the Usage tab's other tables show them.

-- The failed sends of the 365 days before today whose codes are counted, by company and UTC
-- calendar month (platform administrators; companies not deleted), the companies ranked by their
-- failed sends over the whole year: the eight with the most, ties by name and id, then the rest
-- together (no company, with how many it holds) when two or more are left, each row with its place
-- in that ranking (the rest's is 9). A month without a failed send of a company has no row. The
-- first month is partial unless the year starts on a 1st, the last unless today is one. Read in the
-- year's snapshot, a company's months add up to its year.
CREATE FUNCTION ops.platform_ops_failure_company_months()
  RETURNS TABLE (place integer, tenant_id uuid, tenant_name text, tenant_slug text,
    companies integer, month date, failed_sends integer)
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
    SELECT r.tenant_id AS tenant, date_trunc('month', r.utc_day::timestamp)::date AS m,
           sum(r.failed)::integer AS n
      FROM ops.platform_failure_reason_days r
      JOIN ops.platform_message_days_counted c ON c.utc_day = r.utc_day AND c.reasons
      JOIN app.tenants t ON t.id = r.tenant_id
     WHERE r.utc_day >= v_today - 365 AND r.utc_day < v_today AND t.status <> 'deleted'
     GROUP BY 1, 2),
  by_tenant AS (
    SELECT b.tenant, sum(b.n)::integer AS n FROM by_month b GROUP BY 1),
  ranked AS (
    SELECT k.tenant, t.name, t.slug,
           row_number() OVER (ORDER BY k.n DESC, t.name, k.tenant) AS r,
           count(*) OVER () AS total
      FROM by_tenant k
      JOIN app.tenants t ON t.id = k.tenant),
  named AS (
    SELECT k.tenant, k.r, k.total, k.r <= 8 OR k.total <= 9 AS shown, k.name, k.slug FROM ranked k)
  SELECT min(k.r)::integer, CASE WHEN k.shown THEN k.tenant END,
         CASE WHEN k.shown THEN k.name END, CASE WHEN k.shown THEN k.slug END,
         CASE WHEN k.shown THEN 1 ELSE (k.total - 8)::integer END, b.m, sum(b.n)::integer
    FROM by_month b
    JOIN named k ON k.tenant = b.tenant
   GROUP BY 2, 3, 4, 5, 6
   ORDER BY 6, 1;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_failure_company_months() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_failure_company_months() TO w360_platform;
ALTER FUNCTION ops.platform_ops_failure_company_months() OWNER TO w360_definer;
