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
import type { GraphClient, GraphResult } from './graph';
import { ManagementPauseSignal } from './management-pace';
import {
  NUMBER_FACTS_BUDGET_MS,
  NUMBER_FACTS_REFRESH_AFTER_MS,
  limitRefusalAuditDue,
  numberFactsColumns,
  numberFactsDue,
  readNumberFacts,
  refreshNumberFacts,
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

describe('when a number’s facts are refreshed (ADR-402)', () => {
  const now = new Date('2026-10-16T10:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('is due when never read, never asked for the limit, or read 20 hours ago or more', () => {
    expect(NUMBER_FACTS_REFRESH_AFTER_MS).toBe(20 * 3_600_000);
    const due = (healthCheckedAt: Date | null, messagingLimitCheckedAt: Date | null) =>
      numberFactsDue({ healthCheckedAt, messagingLimitCheckedAt }, now);
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
  });
  /** The number's row as the write re-reads it, and its account's. */
  const current = (
    over: Partial<{
      status: string;
      messagingLimit: string | null;
      limitCheckedAt: Date | null;
    }> = {},
  ) => [
    [
      {
        status: over.status ?? 'active',
        whatsappAccountId: ACCOUNT,
        messagingLimit: over.messagingLimit === undefined ? 'TIER_2K' : over.messagingLimit,
        messagingLimitCheckedAt: over.limitCheckedAt === undefined ? OLD : over.limitCheckedAt,
      },
    ],
    [{ status: 'connected' }],
  ];

  /**
   * Runs the refresh against a database whose selects answer `selects` in order and a Graph
   * answering `answers` in order, and gives what was read and written.
   */
  async function run(opts: { selects: unknown[][]; answers?: PhoneRead[]; clockStep?: number }) {
    const selects = [...opts.selects];
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
    // Only b's facts are written; nothing touches an account or a status.
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]!.table).toBe(channelAccounts);
    expect(r.updates.some((u) => u.table === whatsappAccounts)).toBe(false);
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
});
