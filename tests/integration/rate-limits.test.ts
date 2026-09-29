import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@w360/core';
import {
  API_LIMITS,
  admitApiRate,
  admitFailedApiAuthentication,
  purgeRateLimitBuckets,
  takeToken,
} from '@w360/domain';
import { connectTestDatabases, type TestDatabases } from './helpers';

/**
 * Token buckets in PostgreSQL (shared by every web replica and worker) and the public API's limits
 * built on them (ADR-052, ADR-068): the burst and the refill, atomic takes under concurrency,
 * failed authentication per client address, per key then per company, and the purge of buckets
 * that are full again. Time is moved by setting a bucket's last use back (a fixture step), never by
 * waiting.
 */
let dbs: TestDatabases;

beforeAll(() => {
  dbs = connectTestDatabases({ appPoolMax: 10 });
});

afterAll(async () => {
  await dbs.close();
});

const take = (key: string, capacity: number, refillPerSecond: number) =>
  takeToken(dbs.app, key, { capacity, refillPerSecond });

/** How many of `n` takes one after another succeed. */
async function takes(n: number, attempt: () => Promise<boolean>): Promise<number> {
  let allowed = 0;
  for (let i = 0; i < n; i += 1) if (await attempt()) allowed += 1;
  return allowed;
}

/** Moves a bucket's last use back, as if `seconds` had passed (a fixture step). */
async function age(key: string, seconds: number) {
  const moved = await dbs.adminPool.query(
    `UPDATE ops.rate_limit_buckets SET updated_at = updated_at - $2 * interval '1 second'
      WHERE key = $1`,
    [key, seconds],
  );
  expect(moved.rowCount).toBe(1);
}

/**
 * Empties a bucket and slows its refill to one token in 1,000 seconds, so it stays empty while a
 * test looks at it (a fixture step; the refill of a new bucket comes from its caller).
 */
async function empty(key: string) {
  const emptied = await dbs.adminPool.query(
    `UPDATE ops.rate_limit_buckets SET tokens = 0, refill_per_second = 0.001, updated_at = now()
      WHERE key = $1`,
    [key],
  );
  expect(emptied.rowCount).toBe(1);
}

/** The capacity and refill a bucket was created with (by the limit that took from it first). */
async function limits(key: string) {
  const { rows } = await dbs.adminPool.query<{ capacity: number; refill_per_second: number }>(
    'SELECT capacity, refill_per_second FROM ops.rate_limit_buckets WHERE key = $1',
    [key],
  );
  return rows[0] ?? null;
}

async function bucket(key: string) {
  const { rows } = await dbs.adminPool.query<{ tokens: number; updated_at: Date }>(
    'SELECT tokens, updated_at FROM ops.rate_limit_buckets WHERE key = $1',
    [key],
  );
  return rows[0] ?? null;
}

describe('token buckets (ADR-068)', () => {
  it('allow a burst of their capacity, then refill with time up to the capacity', async () => {
    const key = `test:burst:${uuidv7()}`;
    expect(await takes(5, () => take(key, 5, 1))).toBe(5);
    expect(await take(key, 5, 1)).toBe(false);
    // Two seconds at one token a second: two more.
    await age(key, 2);
    expect(await takes(3, () => take(key, 5, 1))).toBe(2);
    // An hour refills to the capacity, not beyond.
    await age(key, 3600);
    expect(await takes(8, () => take(key, 5, 1))).toBe(5);
    // Another key is a bucket of its own.
    expect(await take(`test:burst:${uuidv7()}`, 5, 1)).toBe(true);
  });

  it('take tokens atomically: 40 takes at once from a bucket of 10 admit 10', async () => {
    const key = `test:race:${uuidv7()}`;
    const results = await Promise.all(Array.from({ length: 40 }, () => take(key, 10, 0.001)));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect((await bucket(key))!.tokens).toBeLessThan(1);
  });
});

describe('the public API’s limits (ADR-052)', () => {
  it('allow each client address 20 failed authentications, then one every 5 seconds', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}-${uuidv7()}`;
    const { capacity, refillPerSecond } = API_LIMITS.authFailureRate;
    expect(capacity).toBe(20);
    expect(refillPerSecond).toBe(0.2);
    expect(await takes(20, () => admitFailedApiAuthentication(dbs.app, ip))).toBe(20);
    expect(await admitFailedApiAuthentication(dbs.app, ip)).toBe(false);
    expect(await limits(`api:auth-failure:${ip}`)).toEqual({
      capacity: 20,
      refill_per_second: 0.2,
    });
    // Another address is not held back.
    expect(await admitFailedApiAuthentication(dbs.app, `${ip}-other`)).toBe(true);
    // Five seconds later, one more attempt.
    await age(`api:auth-failure:${ip}`, 5);
    expect(await takes(2, () => admitFailedApiAuthentication(dbs.app, ip))).toBe(1);
  });

  it('share one bucket between requests whose address is unknown', async () => {
    await dbs.adminPool.query(
      `DELETE FROM ops.rate_limit_buckets WHERE key = 'api:auth-failure:unknown'`,
    );
    expect(await admitFailedApiAuthentication(dbs.app, null)).toBe(true);
    expect(await bucket('api:auth-failure:unknown')).not.toBeNull();
    expect((await bucket('api:auth-failure:unknown'))!.tokens).toBeCloseTo(19, 0);
  });

  it('allow each key bursts of 50 and each company bursts of 200; a request its key refuses takes nothing from the company', async () => {
    const tenantId = uuidv7();
    const [first, second] = [uuidv7(), uuidv7()];
    expect(API_LIMITS.keyRate).toEqual({ capacity: 50, refillPerSecond: 10 });
    expect(API_LIMITS.companyRate).toEqual({ capacity: 200, refillPerSecond: 30 });
    const admit = (keyId: string) => admitApiRate(dbs.app, { keyId, tenantId });

    // A burst on one key: 50 pass, each also taken from the company's bucket (200, refilling).
    expect(await takes(50, () => admit(first))).toBe(50);
    expect(await limits(`api:key:${first}`)).toEqual({ capacity: 50, refill_per_second: 10 });
    expect(await limits(`api:company:${tenantId}`)).toEqual({
      capacity: 200,
      refill_per_second: 30,
    });
    expect((await bucket(`api:key:${first}`))!.tokens).toBeLessThan(50);
    expect((await bucket(`api:company:${tenantId}`))!.tokens).toBeGreaterThanOrEqual(150);
    // The key's burst is used up (and, for this check, refills slowly, so it stays empty): its
    // requests are refused without touching the company's bucket.
    await empty(`api:key:${first}`);
    const company = await bucket(`api:company:${tenantId}`);
    expect(await admit(first)).toBe(false);
    expect(await admit(first)).toBe(false);
    expect(await bucket(`api:company:${tenantId}`)).toEqual(company);

    // The company's other key still sends.
    expect(await admit(second)).toBe(true);

    // With the company's burst used up, every key is refused, then passes once tokens refill.
    await empty(`api:company:${tenantId}`);
    const third = uuidv7();
    expect(await admit(third)).toBe(false);
    expect(await admit(second)).toBe(false);
    await age(`api:company:${tenantId}`, 1000);
    expect(await admit(third)).toBe(true);
    // Another company is not held back.
    expect(await admitApiRate(dbs.app, { keyId: uuidv7(), tenantId: uuidv7() })).toBe(true);
  });
});

describe('the purge of full buckets (ADR-068)', () => {
  it('deletes buckets that are full again and keeps those still limiting; a deleted bucket starts full', async () => {
    const full = `test:purge:full:${uuidv7()}`;
    const limiting = `test:purge:limiting:${uuidv7()}`;
    const ip = `198.51.100.7-${uuidv7()}`;
    expect(await take(full, 3, 1)).toBe(true);
    expect(await takes(3, () => take(limiting, 3, 1))).toBe(3);
    expect(await admitFailedApiAuthentication(dbs.app, ip)).toBe(true);
    // One token taken a second ago from a bucket refilling one a second: full again.
    await age(full, 1);
    // The failed attempt's bucket (one every 5 seconds) is full again after 5 seconds.
    await age(`api:auth-failure:${ip}`, 5);

    expect(await purgeRateLimitBuckets(dbs.app)).toBeGreaterThanOrEqual(2);
    expect(await bucket(full)).toBeNull();
    expect(await bucket(`api:auth-failure:${ip}`)).toBeNull();
    // Empty, and refilling: kept.
    expect(await bucket(limiting)).not.toBeNull();
    expect(await take(limiting, 3, 1)).toBe(false);

    // A deleted bucket behaves as the full one did: a burst of its capacity.
    expect(await takes(4, () => take(full, 3, 1))).toBe(3);
  });

  it('keeps a bucket that was nearly full but not quite', async () => {
    const key = `test:purge:nearly:${uuidv7()}`;
    expect(await takes(2, () => take(key, 2, 1))).toBe(2);
    // 1.5 of 2 tokens back: still limiting.
    await age(key, 1.5);
    await purgeRateLimitBuckets(dbs.app);
    expect(await bucket(key)).not.toBeNull();
    await age(key, 0.5);
    await purgeRateLimitBuckets(dbs.app);
    expect(await bucket(key)).toBeNull();
  });

  it('is the worker’s alone: the runtime role cannot delete buckets itself', async () => {
    const key = `test:purge:direct:${uuidv7()}`;
    expect(await take(key, 1, 1)).toBe(true);
    const client = await dbs.appPool.connect();
    try {
      await expect(
        client.query('DELETE FROM ops.rate_limit_buckets WHERE key = $1', [key]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      client.release();
    }
  });
});
