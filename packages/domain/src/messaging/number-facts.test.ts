import { describe, expect, it } from 'vitest';
import type { Keyring } from '@w360/core';
import {
  auditEvents,
  channelAccounts,
  tenantEvents,
  whatsappAccounts,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { GraphClient, PHONE_NUMBER_FACT_LIMITS, type GraphResult } from './graph';
import { ManagementPauseSignal } from './management-pace';
import {
  NUMBER_FACTS_BUDGET_MS,
  NUMBER_FACTS_REFRESH_AFTER_MS,
  limitRefusalAuditDue,
  numberFactsColumns,
  numberFactsDue,
  readNumberFacts,
  refreshNumberFacts,
  refreshedFactsColumns,
} from './number-facts';

type PhoneRead = Awaited<ReturnType<GraphClient['getPhoneNumber']>>;
type Failure = Extract<GraphResult<never>, { ok: false }>;

const FIELD = 'whatsapp_business_manager_messaging_limit';
const facts = {
  displayPhoneNumber: '+91 98000 00000',
  verifiedName: 'Acme',
  qualityRating: 'YELLOW',
  nameStatus: 'APPROVED',
  codeVerificationStatus: 'VERIFIED',
};
const withLimit: PhoneRead = { ok: true, data: { ...facts, messagingLimit: 'TIER_10K' } };
const plain: PhoneRead = { ok: true, data: { ...facts, messagingLimit: null } };
const refused: Failure = {
  ok: false,
  kind: 'permanent',
  httpStatus: 400,
  code: 100,
  title: 'OAuthException',
  detail: `(#100) Tried accessing nonexisting field (${FIELD})`,
};
const revoked: Failure = {
  ok: false,
  kind: 'auth',
  httpStatus: 401,
  code: 190,
  title: 'OAuthException',
  detail: 'Error validating access token: The session has been invalidated.',
};
const throttled: Failure = { ...refused, kind: 'retryable', httpStatus: 429, code: 80007 };

/** A Graph answering `answers` in order, recording each read's options. */
function graphOf(answers: PhoneRead[]) {
  const reads: { id: string; options: Record<string, unknown> | undefined }[] = [];
  const graph = {
    getPhoneNumber: (id: string, _token: string, options?: Record<string, unknown>) => {
      reads.push({ id, options });
      const answer = answers.shift();
      if (!answer) throw new Error('read not expected');
      return Promise.resolve(answer);
    },
  } as unknown as GraphClient;
  return { graph, reads };
}

/** Paced calls that pass every request through, or signal a pause before the call numbered `pauseAt`. */
function callsOf(pauseAt = Infinity) {
  let made = 0;
  return async <R>(request: () => Promise<R>): Promise<R> => {
    made += 1;
    if (made >= pauseAt) throw new ManagementPauseSignal(new Date('2026-10-16T11:00:00Z'));
    return request();
  };
}

describe('the shared read of a number’s facts (ADR-402)', () => {
  it('reads once, with the limit, when Meta answers', async () => {
    const { graph, reads } = graphOf([withLimit]);
    expect(await readNumberFacts(graph, callsOf(), '1234', 'token')).toEqual({
      ok: true,
      facts: withLimit.ok && withLimit.data,
      limitRefusal: null,
    });
    expect(reads).toEqual([{ id: '1234', options: undefined }]);
  });

  it('reads once more without the limit after a permanent or lost-access refusal, and gives the refusal', async () => {
    for (const refusal of [refused, revoked]) {
      const { graph, reads } = graphOf([refusal, plain]);
      expect(await readNumberFacts(graph, callsOf(), '1234', 'token'), refusal.kind).toEqual({
        ok: true,
        facts: plain.ok && plain.data,
        limitRefusal: refusal,
      });
      expect(reads.map((r) => r.options)).toEqual([undefined, { messagingLimit: false }]);
    }
  });

  it('gives the second read’s failure when it fails too', async () => {
    const second = { ...refused, detail: 'Unsupported get request.' };
    const { graph } = graphOf([revoked, second]);
    expect(await readNumberFacts(graph, callsOf(), '1234', 'token')).toEqual({
      ok: false,
      failure: second,
    });
  });

  it('makes no second read for a failure that may pass', async () => {
    for (const failure of [throttled, { ...refused, kind: 'unknown' as const }]) {
      const { graph, reads } = graphOf([failure]);
      expect(await readNumberFacts(graph, callsOf(), '1234', 'token')).toEqual({
        ok: false,
        failure,
      });
      expect(reads).toHaveLength(1);
    }
  });

  it('makes no second read once the first response paused the account', async () => {
    const { graph, reads } = graphOf([refused, plain]);
    await expect(readNumberFacts(graph, callsOf(2), '1234', 'token')).rejects.toBeInstanceOf(
      ManagementPauseSignal,
    );
    expect(reads).toHaveLength(1);
  });

  it('stores the facts and the time as the health’s and the limit’s check, never a status', () => {
    const at = new Date('2026-10-16T10:00:00Z');
    expect(numberFactsColumns({ ...facts, messagingLimit: 'TIER_10K' }, at)).toEqual({
      ...facts,
      messagingLimit: 'TIER_10K',
      messagingLimitCheckedAt: at,
      healthCheckedAt: at,
    });
  });
});

describe('a number’s facts bounded as they are parsed (ADR-402)', () => {
  async function parsed(body: Record<string, unknown>) {
    const graph = new GraphClient({
      baseUrl: 'https://graph.test',
      version: 'v26.0',
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    const result = await graph.getPhoneNumber('1234', 'token');
    if (!result.ok) throw new Error('read failed');
    return result.data;
  }

  it('keeps each fact within its column, and no cut phone number', async () => {
    expect(PHONE_NUMBER_FACT_LIMITS).toEqual({
      displayPhoneNumber: 32,
      verifiedName: 200,
      qualityRating: 32,
      nameStatus: 64,
      codeVerificationStatus: 64,
    });
    const long = await parsed({
      display_phone_number: '+91 '.padEnd(33, '9'),
      verified_name: 'N'.repeat(250),
      quality_rating: 'Q'.repeat(40),
      name_status: 'S'.repeat(70),
      code_verification_status: 'C'.repeat(70),
    });
    expect(long).toEqual({
      // A cut phone number would be another number: none is kept.
      displayPhoneNumber: null,
      verifiedName: 'N'.repeat(200),
      qualityRating: 'Q'.repeat(32),
      nameStatus: 'S'.repeat(64),
      codeVerificationStatus: 'C'.repeat(64),
      messagingLimit: null,
    });
    // An emoji is never split at the bound.
    expect((await parsed({ verified_name: `${'N'.repeat(199)}😀` })).verifiedName).toBe(
      'N'.repeat(199),
    );
    // At the bounds, as given; empty or not text, none.
    const exact = await parsed({
      display_phone_number: '9'.repeat(32),
      verified_name: 'N'.repeat(200),
      quality_rating: 'GREEN',
      name_status: '',
      code_verification_status: 7,
    });
    expect(exact).toMatchObject({
      displayPhoneNumber: '9'.repeat(32),
      verifiedName: 'N'.repeat(200),
      qualityRating: 'GREEN',
      nameStatus: null,
      codeVerificationStatus: null,
    });
  });
});

describe('when a number’s facts are refreshed (ADR-402)', () => {
  const now = new Date('2026-10-16T10:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('is due when never read, never asked for the limit, or read 20 hours ago or more', () => {
    expect(NUMBER_FACTS_REFRESH_AFTER_MS).toBe(20 * 3_600_000);
    const due = (
      healthCheckedAt: Date | null,
      messagingLimitCheckedAt: Date | null,
      factsAttemptedAt: Date | null = null,
    ) => numberFactsDue({ healthCheckedAt, messagingLimitCheckedAt, factsAttemptedAt }, now);
    expect(due(null, null)).toBe(true);
    // Read before ADR-398: never asked for the limit.
    expect(due(ago(60_000), null)).toBe(true);
    expect(due(ago(NUMBER_FACTS_REFRESH_AFTER_MS), ago(NUMBER_FACTS_REFRESH_AFTER_MS))).toBe(true);
    expect(due(ago(25 * 3_600_000), ago(25 * 3_600_000))).toBe(true);
    expect(
      due(ago(NUMBER_FACTS_REFRESH_AFTER_MS - 1), ago(NUMBER_FACTS_REFRESH_AFTER_MS - 1)),
    ).toBe(false);
    expect(due(ago(60_000), ago(60_000))).toBe(false);
    // A read time ahead of this clock is recent.
    expect(due(new Date(now.getTime() + 60_000), now)).toBe(false);
    // Tried by a refresh within 20 hours (its reads failing): not tried again, however stale.
    const stale = ago(3 * 86_400_000);
    expect(due(stale, stale, ago(60_000))).toBe(false);
    expect(due(null, null, ago(NUMBER_FACTS_REFRESH_AFTER_MS - 1))).toBe(false);
    expect(due(stale, stale, ago(NUMBER_FACTS_REFRESH_AFTER_MS))).toBe(true);
    // A successful refresh's attempt never makes a stale number due earlier, nor a fresh one due.
    expect(due(ago(60_000), ago(60_000), ago(25 * 3_600_000))).toBe(false);
  });

  it('keeps a stored fact Meta left out, never an old limit, in a refresh only', () => {
    const at = new Date('2026-10-16T10:00:00Z');
    const tried = new Date('2026-10-16T09:59:59Z');
    const partial = {
      displayPhoneNumber: null,
      verifiedName: null,
      qualityRating: 'RED',
      nameStatus: null,
      codeVerificationStatus: null,
      messagingLimit: null,
    };
    // Only what Meta gave, and the limit as not reported (ADR-398), are written.
    expect(refreshedFactsColumns(partial, at, tried)).toEqual({
      qualityRating: 'RED',
      messagingLimit: null,
      messagingLimitCheckedAt: at,
      healthCheckedAt: at,
      factsAttemptedAt: tried,
    });
    expect(refreshedFactsColumns({ ...facts, messagingLimit: 'TIER_2K' }, at, tried)).toEqual({
      ...facts,
      messagingLimit: 'TIER_2K',
      messagingLimitCheckedAt: at,
      healthCheckedAt: at,
      factsAttemptedAt: tried,
    });
    // Setup still stores every fact as Meta gave it, nulls included.
    expect(numberFactsColumns(partial, at)).toEqual({
      ...partial,
      messagingLimitCheckedAt: at,
      healthCheckedAt: at,
    });
  });

  it('audits a refused limit only when Channels changes to "not reported"', () => {
    const at = ago(25 * 3_600_000);
    // Never asked (a number set up before ADR-398).
    expect(limitRefusalAuditDue({ messagingLimit: null, messagingLimitCheckedAt: null })).toBe(
      true,
    );
    // A limit was shown.
    expect(limitRefusalAuditDue({ messagingLimit: 'TIER_2K', messagingLimitCheckedAt: at })).toBe(
      true,
    );
    // Already shown as not reported: not audited again each day.
    expect(limitRefusalAuditDue({ messagingLimit: null, messagingLimitCheckedAt: at })).toBe(false);
  });
});

describe('refreshing an account’s numbers (ADR-402)', () => {
  const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
  const ACCOUNT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
  const NOW = new Date('2026-10-16T10:00:00Z');
  const OLD = new Date(NOW.getTime() - 25 * 3_600_000);
  const RECENT = new Date(NOW.getTime() - 3_600_000);
  const connected = {
    wabaId: '5678',
    status: 'connected',
    credential: 'sealed',
    managementPausedUntil: null as Date | null,
  };
  const number = (id: string, healthCheckedAt: Date | null, limitCheckedAt = healthCheckedAt) => ({
    id,
    phoneNumberId: `ph-${id}`,
    healthCheckedAt,
    messagingLimitCheckedAt: limitCheckedAt,
    factsAttemptedAt: null,
  });
  /** The number's row as the write re-reads it, and its account's. */
  const current = (
    over: Partial<{
      status: string;
      messagingLimit: string | null;
      limitCheckedAt: Date | null;
      healthCheckedAt: Date | null;
    }> = {},
  ) => [
    [
      {
        status: over.status ?? 'active',
        whatsappAccountId: ACCOUNT,
        messagingLimit: over.messagingLimit === undefined ? 'TIER_2K' : over.messagingLimit,
        messagingLimitCheckedAt: over.limitCheckedAt === undefined ? OLD : over.limitCheckedAt,
        healthCheckedAt: over.healthCheckedAt === undefined ? OLD : over.healthCheckedAt,
      },
    ],
    [{ status: 'connected' }],
  ];

  /**
   * Runs the refresh against a database whose selects answer `selects` in order and a Graph
   * answering `answers` in order, and gives what was read and written.
   */
  async function run(opts: {
    selects: unknown[][];
    answers?: PhoneRead[];
    clockStep?: number;
    /** Writes that throw, by their order among the updates (0 for the first). */
    failingUpdates?: number[];
  }) {
    const selects = [...opts.selects];
    let updateCount = 0;
    const updates: { table: unknown; values: Record<string, unknown> }[] = [];
    const audits: Record<string, unknown>[] = [];
    let events = 0;
    const query = () => {
      const rows = selects.shift();
      if (!rows) throw new Error('select not expected');
      const q: Record<string, unknown> = {};
      for (const step of ['from', 'innerJoin', 'where', 'orderBy', 'for']) q[step] = () => q;
      q.then = (done: (r: unknown[]) => unknown) => Promise.resolve(rows).then(done);
      return q;
    };
    const tx = {
      select: () => query(),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          const index = updateCount;
          updateCount += 1;
          if (opts.failingUpdates?.includes(index)) {
            throw new Error(`write ${index} failed`);
          }
          updates.push({ table, values });
          return {
            where: () =>
              Object.assign(Promise.resolve(), {
                returning: () => Promise.resolve([{ id: ACCOUNT }]),
              }),
          };
        },
      }),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          if (table === auditEvents) audits.push(row);
          else if (table === tenantEvents) events += 1;
          else throw new Error('unexpected insert');
          return Promise.resolve();
        },
      }),
    } as unknown as Tx;
    const db = { run: (_scope: unknown, fn: (t: Tx) => unknown) => fn(tx) } as unknown as Database;
    const { graph, reads } = graphOf([...(opts.answers ?? [])]);
    let t = NOW.getTime();
    const clock = {
      now: () => {
        const at = new Date(t);
        t += opts.clockStep ?? 0;
        return at;
      },
    };
    const keyring = { decryptString: () => 'token' } as unknown as Keyring;
    const result = await refreshNumberFacts(
      { db, keyring, graph, clock },
      { tenantId: TENANT } as unknown as TenantScope,
      ACCOUNT,
      NOW,
    );
    return { result, reads, updates, audits, events };
  }

  it('reads and stores each due active number, stalest first, and leaves recent ones', async () => {
    const r = await run({
      selects: [
        [connected],
        [number('a', null), number('b', OLD), number('c', RECENT)],
        ...current(),
        ...current(),
      ],
      answers: [withLimit, withLimit],
    });
    expect(r.result).toEqual({
      outcome: 'done',
      numbers: [
        { channelAccountId: 'a', state: 'refreshed', limitRefused: false },
        { channelAccountId: 'b', state: 'refreshed', limitRefused: false },
      ],
      left: 0,
    });
    expect(r.reads.map((x) => x.id)).toEqual(['ph-a', 'ph-b']);
    expect(r.updates.map((u) => u.table)).toEqual([channelAccounts, channelAccounts]);
    for (const u of r.updates) {
      expect(u.values).toEqual({
        ...facts,
        messagingLimit: 'TIER_10K',
        messagingLimitCheckedAt: NOW,
        healthCheckedAt: NOW,
        factsAttemptedAt: NOW,
      });
      expect(u.values).not.toHaveProperty('status');
    }
    expect(r.audits).toEqual([]);
    expect(r.events).toBe(2);
  });

  it('reads nothing for an account that is not connected or has no token', async () => {
    for (const account of [
      { ...connected, status: 'needs_reconnect' },
      { ...connected, status: 'disconnected' },
      { ...connected, credential: null },
    ]) {
      const r = await run({ selects: [[account], [number('a', null)]] });
      expect(r.result).toEqual({ outcome: 'skipped', numbers: [], left: 0 });
      expect(r.reads).toEqual([]);
    }
    const missing = await run({ selects: [[]] });
    expect(missing.result.outcome).toBe('skipped');
  });

  it('reads nothing while Meta throttles the account’s management calls', async () => {
    const until = new Date(NOW.getTime() + 5 * 60_000);
    const r = await run({
      selects: [
        [{ ...connected, managementPausedUntil: until }],
        [number('a', null), number('b', OLD)],
      ],
    });
    expect(r.result).toEqual({ outcome: 'paused', numbers: [], left: 2, pausedUntil: until });
    expect(r.reads).toEqual([]);
    expect(r.updates).toEqual([]);
    // A pause that has ended stops nothing.
    const ended = await run({
      selects: [
        [{ ...connected, managementPausedUntil: new Date(NOW.getTime() - 1) }],
        [number('a', null)],
        ...current(),
      ],
      answers: [withLimit],
    });
    expect(ended.result.outcome).toBe('done');
  });

  it('stores nothing and changes no status when a read fails, and goes on with the next number', async () => {
    const r = await run({
      selects: [[connected], [number('a', OLD), number('b', OLD)], ...current()],
      answers: [revoked, revoked, withLimit],
    });
    expect(r.result).toEqual({
      outcome: 'done',
      numbers: [
        { channelAccountId: 'a', state: 'failed', kind: 'auth', error: 'auth 190: OAuthException' },
        { channelAccountId: 'b', state: 'refreshed', limitRefused: false },
      ],
      left: 0,
    });
    // a's attempt, then b's facts; nothing touches an account or a status.
    expect(r.updates.map((u) => u.table)).toEqual([channelAccounts, channelAccounts]);
    expect(r.updates[0]!.values).toEqual({ factsAttemptedAt: NOW });
    expect(r.updates[1]!.values).toMatchObject({ qualityRating: 'YELLOW', factsAttemptedAt: NOW });
    expect(r.audits).toEqual([]);
  });

  it('stops after the response that paused the account and leaves the rest for the next check', async () => {
    const usage = new Map([
      ['5678', { callCount: 100, totalCputime: 10, totalTime: 10, regainAccessMinutes: 5 }],
    ]);
    // a's read succeeds and pauses the account: stored, then no further read.
    const stored = await run({
      selects: [[connected], [number('a', OLD), number('b', OLD)], ...current()],
      answers: [{ ...withLimit, usage }],
    });
    const until = new Date(NOW.getTime() + 5 * 60_000);
    expect(stored.result).toEqual({
      outcome: 'paused',
      numbers: [{ channelAccountId: 'a', state: 'refreshed', limitRefused: false }],
      left: 1,
      pausedUntil: until,
    });
    expect(stored.reads.map((x) => x.id)).toEqual(['ph-a']);
    // The reading is stored on the account (ADR-399), then a's facts.
    expect(stored.updates.map((u) => u.table)).toEqual([whatsappAccounts, channelAccounts]);
    // A refusal of the limit whose response paused the account: no field-less read, nothing stored.
    const refusedThenPaused = await run({
      selects: [[connected], [number('a', OLD)]],
      answers: [{ ...refused, usage }],
    });
    expect(refusedThenPaused.result).toEqual({
      outcome: 'paused',
      numbers: [],
      left: 1,
      pausedUntil: until,
    });
    expect(refusedThenPaused.reads).toHaveLength(1);
    expect(refusedThenPaused.updates.map((u) => u.table)).toEqual([whatsappAccounts]);
    expect(refusedThenPaused.audits).toEqual([]);
  });

  it('starts no read once the job has run out of time', async () => {
    const r = await run({
      selects: [[connected], [number('a', OLD), number('b', OLD), number('c', OLD)], ...current()],
      answers: [withLimit],
      clockStep: NUMBER_FACTS_BUDGET_MS / 2,
    });
    expect(r.result.outcome).toBe('done');
    expect(r.result.numbers).toEqual([
      { channelAccountId: 'a', state: 'refreshed', limitRefused: false },
    ]);
    expect(r.result.left).toBe(2);
    expect(r.reads.map((x) => x.id)).toEqual(['ph-a']);
  });

  it('skips a number that stopped being active, or whose account stopped being connected, during the read', async () => {
    const stopped = await run({
      selects: [[connected], [number('a', OLD)], current({ status: 'disconnected' })[0]!],
      answers: [withLimit],
    });
    expect(stopped.result.numbers).toEqual([{ channelAccountId: 'a', state: 'skipped' }]);
    expect(stopped.updates).toEqual([]);
    expect(stopped.events).toBe(0);
    const lost = await run({
      selects: [[connected], [number('a', OLD)], current()[0]!, [{ status: 'needs_reconnect' }]],
      answers: [withLimit],
    });
    expect(lost.result.numbers).toEqual([{ channelAccountId: 'a', state: 'skipped' }]);
    expect(lost.updates).toEqual([]);
  });

  it('stores a refused limit as none and audits it as ADR-398 does, only when Channels changes', async () => {
    const shown = await run({
      selects: [[connected], [number('a', OLD)], ...current({ messagingLimit: 'TIER_2K' })],
      answers: [refused, plain],
    });
    expect(shown.result.numbers).toEqual([
      { channelAccountId: 'a', state: 'refreshed', limitRefused: true },
    ]);
    expect(shown.updates[0]!.values).toMatchObject({
      messagingLimit: null,
      messagingLimitCheckedAt: NOW,
    });
    expect(
      shown.audits.map((a) => [a.action, a.subjectType, a.subjectId, a.result, a.metadata]),
    ).toEqual([
      [
        'channel.messaging_limit_refused',
        'channel',
        'a',
        'failure',
        {
          messagingLimit: 'refused',
          kind: 'permanent',
          httpStatus: 400,
          code: 100,
          subcode: null,
          detail: refused.detail,
        },
      ],
    ]);
    // Never asked before (set up before ADR-398): audited too.
    const never = await run({
      selects: [
        [connected],
        [number('a', OLD, null)],
        ...current({ messagingLimit: null, limitCheckedAt: null }),
      ],
      answers: [refused, plain],
    });
    expect(never.audits).toHaveLength(1);
    // Already not reported: refreshed, not audited again.
    const again = await run({
      selects: [[connected], [number('a', OLD)], ...current({ messagingLimit: null })],
      answers: [refused, plain],
    });
    expect(again.result.numbers).toEqual([
      { channelAccountId: 'a', state: 'refreshed', limitRefused: true },
    ]);
    expect(again.audits).toEqual([]);
  });

  it('goes on with the other numbers when one number’s read cannot be stored, and records its attempt', async () => {
    const r = await run({
      selects: [[connected], [number('a', OLD), number('b', OLD)], ...current(), ...current()],
      answers: [withLimit, withLimit],
      // a's facts (a CHECK violation, say): its attempt is then recorded, and b is stored.
      failingUpdates: [0],
    });
    expect(r.result.outcome).toBe('done');
    expect(r.result.left).toBe(0);
    expect(r.result.numbers).toEqual([
      { channelAccountId: 'a', state: 'store_failed', error: new Error('write 0 failed') },
      { channelAccountId: 'b', state: 'refreshed', limitRefused: false },
    ]);
    expect(r.updates.map((u) => u.values)).toEqual([
      { factsAttemptedAt: NOW },
      expect.objectContaining({ qualityRating: 'YELLOW', factsAttemptedAt: NOW }),
    ]);
    // Recording the attempt failing too is reported with it, and the next number still runs.
    const both = await run({
      selects: [[connected], [number('a', OLD), number('b', OLD)], ...current(), ...current()],
      answers: [withLimit, withLimit],
      failingUpdates: [0, 1],
    });
    expect(both.result.numbers).toEqual([
      {
        channelAccountId: 'a',
        state: 'store_failed',
        error: new Error('write 0 failed'),
        attemptError: new Error('write 1 failed'),
      },
      { channelAccountId: 'b', state: 'refreshed', limitRefused: false },
    ]);
  });

  it('keeps a read setup made after this read started', async () => {
    const r = await run({
      selects: [
        [connected],
        [number('a', OLD)],
        ...current({ healthCheckedAt: new Date(NOW.getTime() + 1_000) }),
      ],
      answers: [withLimit],
    });
    expect(r.result.numbers).toEqual([{ channelAccountId: 'a', state: 'skipped' }]);
    expect(r.updates).toEqual([]);
    // A read stored at the same instant as this one started is not newer.
    const same = await run({
      selects: [[connected], [number('a', OLD)], ...current({ healthCheckedAt: NOW })],
      answers: [withLimit],
    });
    expect(same.result.numbers[0]).toMatchObject({ state: 'refreshed' });
  });

  it('keeps the stored facts Meta left out of its answer', async () => {
    const r = await run({
      selects: [[connected], [number('a', OLD)], ...current()],
      answers: [
        {
          ok: true,
          data: {
            displayPhoneNumber: null,
            verifiedName: null,
            qualityRating: 'RED',
            nameStatus: null,
            codeVerificationStatus: null,
            messagingLimit: 'TIER_250',
          },
        },
      ],
    });
    expect(r.updates[0]!.values).toEqual({
      qualityRating: 'RED',
      messagingLimit: 'TIER_250',
      messagingLimitCheckedAt: NOW,
      healthCheckedAt: NOW,
      factsAttemptedAt: NOW,
    });
  });
});
