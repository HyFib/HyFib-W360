-- Failed sends by reason (P5-10, ADR-347).
--
-- The Usage tab and a company's platform page chart each UTC day's failed sends as a share of those
-- not cancelled (ADR-344, ADR-346), and the Signals tab counts two of Meta's errors per company
-- (131049, 131050). Why the other sends failed was left to each company's inbox: a failed message
-- keeps the code it failed with (Meta's, from the status webhook or the answer to the send, or that
-- answer's HTTP status when it carried no code, or HyFib's own when the send was refused before it
-- left or its last attempt could not reach Meta; packages/domain messaging/ingest.ts and
-- outbound.ts), but nothing platform staff read counted them. This function counts a window's
-- failed sends by their code. Counts a code only: never a contact, a message or its error title,
-- which may quote what was sent.

-- The failed sends since a time at most 93 days back (platform administrators), the platform's or
-- one company's, by code: the eight most frequent, most first (ties by code), then one row with no
-- code for the rest, with how many codes it holds, when two or more are left (a ninth alone is
-- listed). A failure recorded without a code is counted under the empty code. Companies deleted are
-- left out, as the other counts leave them out; each company's messages are read through
-- messages_tenant_created_idx, as the daily counts read them.
CREATE FUNCTION ops.platform_ops_failure_reasons(p_since timestamptz, p_tenant_id uuid)
  RETURNS TABLE (reason_code text, failed_sends integer, codes integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_actor text := app.current_user_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM ops.platform_admins a WHERE a.user_id = v_actor) THEN
    RAISE EXCEPTION 'platform administrator required' USING ERRCODE = 'W3403';
  END IF;
  IF p_since IS NULL OR p_since > now() OR p_since < now() - interval '93 days' THEN
    RAISE EXCEPTION 'the period must start within the last 93 days' USING ERRCODE = 'W3412';
  END IF;
  RETURN QUERY
  WITH by_code AS (
    SELECT coalesce(m.error_code, '') AS code, count(*)::integer AS n
      FROM app.tenants t
      JOIN LATERAL (
        SELECT mm.error_code
          FROM app.messages mm
         WHERE mm.tenant_id = t.id AND mm.created_at >= p_since
           AND mm.direction = 'outbound' AND mm.status = 'failed') m ON true
     WHERE t.status <> 'deleted' AND (p_tenant_id IS NULL OR t.id = p_tenant_id)
     GROUP BY 1),
  ranked AS (
    SELECT b.code, b.n, row_number() OVER (ORDER BY b.n DESC, b.code) AS r,
           count(*) OVER () AS total
      FROM by_code b)
  SELECT CASE WHEN k.r <= 8 OR k.total <= 9 THEN k.code END, sum(k.n)::integer, count(*)::integer
    FROM ranked k
   GROUP BY CASE WHEN k.r <= 8 OR k.total <= 9 THEN k.code END
   ORDER BY min(k.r);
END
$$;
REVOKE EXECUTE ON FUNCTION ops.platform_ops_failure_reasons(timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.platform_ops_failure_reasons(timestamptz, uuid) TO w360_platform;
ALTER FUNCTION ops.platform_ops_failure_reasons(timestamptz, uuid) OWNER TO w360_definer;
