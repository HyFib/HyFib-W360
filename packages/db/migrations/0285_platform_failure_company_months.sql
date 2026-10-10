-- The year's failed sends by company, month by month, with the company's sends (P5-10, ADR-362,
-- ADR-364).
--
-- The Usage tab lists the year's failed sends by reason, month by month (0269, 0283, ADR-350,
-- ADR-360), every company's together, and its companies table counts no failed sends (ADR-157): a
-- company whose sends began failing, or one failing all year, did not stand out. The same 365 days
-- are now read by company too, the companies ranked by their failed sends over the whole year, so
-- those failing most show their months beside their totals. A company that sends much fails more
-- by count though its sends may seldom fail, so each month comes with the company's sends of the
-- same days (ADR-364), and its failed sends read as a share of them. Counts only, with each
-- company's name and slug, as the Usage tab's other tables show them.

-- The failed sends of the 365 days before today whose codes are counted, by company and UTC
-- calendar month (platform administrators; companies not deleted), the companies ranked by their
-- failed sends over the whole year: the eight with the most, ties by name and id, then the rest
-- together (no company, with how many it holds) when two or more are left, each row with its place
-- in that ranking (the rest's is 9, in every month). Each row has the sends of its companies on the
-- same days, those not cancelled, as the shares of the sends count them (ADR-344, ADR-346): the
-- day's count writes a company's sends and its failed sends by code in one statement (0269), so
-- they cover the same messages. A company whose deletion has started has no sends here: the
-- deletion removes its sends before its codes (steps 35 and 36), which would leave a share of what
-- is left. A month in which a company neither sent nor failed has no row. The first month is
-- partial unless the year starts on a 1st, the last unless today is one. Read in the year's
-- snapshot, a company's months add up to its year.
CREATE FUNCTION ops.platform_ops_failure_company_months()
  RETURNS TABLE (place integer, tenant_id uuid, tenant_name text, tenant_slug text,
    companies integer, month date, failed_sends integer, sends bigint)
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
  -- The same days' sends of each company with a failed send, those cancelled left out (ADR-364),
  -- none of a company whose deletion has started.
  sent AS (
    SELECT d.tenant_id AS tenant, date_trunc('month', d.utc_day::timestamp)::date AS m,
           sum(d.outbound - d.canceled) AS s
      FROM ops.platform_message_days d
      JOIN ops.platform_message_days_counted c ON c.utc_day = d.utc_day AND c.reasons
      JOIN by_tenant k ON k.tenant = d.tenant_id
     WHERE d.utc_day >= v_today - 365 AND d.utc_day < v_today
       AND NOT EXISTS (SELECT 1 FROM ops.tenant_deletions dl
                        WHERE dl.tenant_id = d.tenant_id AND dl.started_at IS NOT NULL)
     GROUP BY 1, 2),
  both_months AS (
    SELECT coalesce(b.tenant, s.tenant) AS tenant, coalesce(b.m, s.m) AS m, coalesce(b.n, 0) AS n,
           coalesce(s.s, 0) AS s
      FROM by_month b
      FULL JOIN sent s ON s.tenant = b.tenant AND s.m = b.m),
  ranked AS (
    SELECT k.tenant, t.name, t.slug,
           row_number() OVER (ORDER BY k.n DESC, t.name, k.tenant) AS r,
           count(*) OVER () AS total
      FROM by_tenant k
      JOIN app.tenants t ON t.id = k.tenant),
  -- A company listed by itself keeps its rank; the rest share place 9 in every month, whichever of
  -- its companies have rows in it.
  named AS (
    SELECT k.tenant, k.total, k.r <= 8 OR k.total <= 9 AS shown, k.name, k.slug,
           CASE WHEN k.r <= 8 OR k.total <= 9 THEN k.r ELSE 9 END AS place
      FROM ranked k)
  SELECT k.place::integer, CASE WHEN k.shown THEN k.tenant END,
         CASE WHEN k.shown THEN k.name END, CASE WHEN k.shown THEN k.slug END,
         CASE WHEN k.shown THEN 1 ELSE (k.total - 8)::integer END, x.m, sum(x.n)::integer,
         sum(x.s)::bigint
    FROM both_months x
    JOIN named k ON k.tenant = x.tenant
   GROUP BY 1, 2, 3, 4, 5, 6
   ORDER BY 6, 1;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_failure_company_months() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_failure_company_months() TO w360_platform;
ALTER FUNCTION ops.platform_ops_failure_company_months() OWNER TO w360_definer;
