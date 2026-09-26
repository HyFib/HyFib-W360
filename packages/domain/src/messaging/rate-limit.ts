import { sql, systemScope, type Database } from '@w360/db';

/**
 * PostgreSQL token bucket shared by all workers. One atomic statement refills by elapsed time and
 * takes a token only if one is available. Keys are ids (e.g. "meta:pn:<phone_number_id>").
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
