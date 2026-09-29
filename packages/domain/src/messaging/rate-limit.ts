import { sql, systemScope, type Database } from '@w360/db';

/**
 * PostgreSQL token bucket shared by all workers. One atomic statement refills by elapsed time and
 * takes a token only if one is available. Keys name what is limited: provider ids (e.g.
 * "meta:pn:<phone_number_id>"), API keys and companies, and a client address for failed public API
 * authentication. Buckets that are full again are deleted by `purgeRateLimitBuckets`.
 */
export async function takeToken(
  db: Database,
  key: string,
  options: { capacity: number; refillPerSecond: number },
): Promise<boolean> {
  return db.run(systemScope, async (tx) => {
    const res = await tx.execute<{ tokens: number }>(sql`
      insert into ops.rate_limit_buckets as b (key, tokens, capacity, refill_per_second, updated_at)
      values (${key}, ${options.capacity - 1}, ${options.capacity}, ${options.refillPerSecond}, now())
      on conflict (key) do update
        set tokens = least(b.capacity, b.tokens + extract(epoch from (now() - b.updated_at)) * b.refill_per_second) - 1,
            updated_at = now()
        where least(b.capacity, b.tokens + extract(epoch from (now() - b.updated_at)) * b.refill_per_second) >= 1
      returning tokens`);
    return res.rows.length > 0;
  });
}

/**
 * Deletes token buckets that are full again (the messaging retention sweep, ADR-068). A full bucket
 * limits nothing and behaves like a missing one, so no limit changes; the table keeps only buckets
 * in use, and a client address counted for failed authentication is kept only while it limits.
 */
export async function purgeRateLimitBuckets(db: Database, limit = 5000): Promise<number> {
  const res = await db.run(systemScope, (tx) =>
    tx.execute<{ purged: number }>(
      sql`select ops.purge_rate_limit_buckets(${limit}::int) as purged`,
    ),
  );
  return Number(res.rows[0]?.purged ?? 0);
}
