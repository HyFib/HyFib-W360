-- 0041_rate_limit_bucket_purge: token buckets are deleted once they are full again (P5-08,
-- ADR-068). A full bucket limits nothing and behaves exactly like a missing one: the next request
-- starts a full bucket and takes a token from it. Deleting it keeps the table to the buckets that
-- limit something. Failed public API authentication is counted per client address, so those keys
-- hold an address (migration 0003 said keys were only ids): they are now kept only while they limit
-- anything, at most minutes.

GRANT SELECT, DELETE ON ops.rate_limit_buckets TO w360_definer;

-- Deletes up to p_limit (1 to 10,000) buckets that are full now: their tokens, refilled for the time
-- since their last use, reach their capacity. A bucket taken from after it was listed is checked
-- again and kept. Returns how many were deleted.
CREATE FUNCTION ops.purge_rate_limit_buckets(p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM ops.rate_limit_buckets b
   WHERE b.key IN (SELECT f.key FROM ops.rate_limit_buckets f
                    WHERE f.tokens + extract(epoch from (now() - f.updated_at)) * f.refill_per_second
                          >= f.capacity
                    ORDER BY f.updated_at
                    LIMIT least(greatest(coalesce(p_limit, 5000), 1), 10000))
     AND b.tokens + extract(epoch from (now() - b.updated_at)) * b.refill_per_second >= b.capacity;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
REVOKE EXECUTE ON FUNCTION ops.purge_rate_limit_buckets(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.purge_rate_limit_buckets(integer) TO w360_app;
ALTER FUNCTION ops.purge_rate_limit_buckets(integer) OWNER TO w360_definer;
