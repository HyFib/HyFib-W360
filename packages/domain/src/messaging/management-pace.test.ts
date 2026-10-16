import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { authorizedTenantScope, type Database } from '@w360/db';
import {
  MANAGEMENT_RESUME_MARGIN_MS,
  activeManagementPause,
  assertManagementOpen,
  deferPausedJob,
  isManagementPaused,
  managementReading,
  managementResumeAt,
  pacedManagementCalls,
  pausedJobKey,
  refusedForPause,
  untilPaused,
} from './management-pace';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { requestClockStart } from '../templates/service';
import { managementUsageView } from './onboarding';
import type { BusinessUseCaseUsage, ManagementUsage } from './usage-header';

/** The pacing decisions of ADR-399: what a reading stores, when an account is paused. */
const WABA = '102290129340398';
const OTHER = '200000000000001';
const NOW = new Date('2026-10-16T10:00:00.000Z');

const usage = (id: string, values: Partial<ManagementUsage>): BusinessUseCaseUsage =>
  new Map([
    [id, { callCount: 0, totalCputime: 0, totalTime: 0, regainAccessMinutes: 0, ...values }],
  ]);

describe('managementReading', () => {
  it('stores the highest percentage and no pause while Meta gives no minutes to regain access', () => {
    expect(
      managementReading(usage(WABA, { callCount: 12, totalCputime: 97, totalTime: 30 }), WABA, NOW),
    ).toEqual({ readAt: NOW, percent: 97, pausedUntil: null });
  });

  it('pauses until the minutes Meta gives have passed', () => {
    expect(
      managementReading(usage(WABA, { callCount: 100, regainAccessMinutes: 7 }), WABA, NOW),
    ).toEqual({ readAt: NOW, percent: 100, pausedUntil: new Date('2026-10-16T10:07:00.000Z') });
  });

  it("ignores another business id's reading, and a response without one", () => {
    expect(managementReading(usage(OTHER, { regainAccessMinutes: 60 }), WABA, NOW)).toBeNull();
    expect(managementReading(undefined, WABA, NOW)).toBeNull();
    expect(managementReading(null, WABA, NOW)).toBeNull();
  });

  it('does not pause on a high percentage alone', () => {
    expect(
      managementReading(usage(WABA, { callCount: 100, totalTime: 100 }), WABA, NOW)?.pausedUntil,
    ).toBeNull();
  });
});

describe('activeManagementPause and when deferred work runs again', () => {
  it('is paused only before the stored end', () => {
    const later = new Date(NOW.getTime() + 60_000);
    expect(activeManagementPause(later, NOW)).toBe(later);
    expect(activeManagementPause(NOW, NOW)).toBeNull();
    expect(activeManagementPause(new Date(NOW.getTime() - 1), NOW)).toBeNull();
    expect(activeManagementPause(null, NOW)).toBeNull();
    expect(activeManagementPause(undefined, NOW)).toBeNull();
  });

  it('runs deferred work just after the pause', () => {
    expect(managementResumeAt(NOW).getTime() - NOW.getTime()).toBe(MANAGEMENT_RESUME_MARGIN_MS);
    expect(MANAGEMENT_RESUME_MARGIN_MS).toBeGreaterThan(0);
    expect(MANAGEMENT_RESUME_MARGIN_MS).toBeLessThanOrEqual(60_000);
  });

  it('tells a paused outcome from the others', () => {
    expect(isManagementPaused({ paused: NOW })).toBe(true);
    for (const other of ['done', 'retry', null, undefined, { paused: 'soon' }, {}]) {
      expect(isManagementPaused(other)).toBe(false);
    }
  });
});

describe("a member's management action while paused", () => {
  it('says Meta is limiting management requests until the time, in the company time zone', () => {
    const until = new Date('2026-10-16T10:07:00.000Z');
    try {
      assertManagementOpen(until, NOW, 'Asia/Kolkata');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.code).toBe('provider_unavailable');
      expect(error.httpStatus).toBe(503);
      expect(error.publicMessage).toMatch(
        /^Meta is limiting management requests for this WhatsApp account until 16 October 2026 at 15:37 /,
      );
      expect(error.details).toEqual({ pausedUntil: until.toISOString() });
    }
  });

  it('goes ahead when the account is not paused, or its pause has ended', () => {
    expect(() => assertManagementOpen(null, NOW, 'UTC')).not.toThrow();
    expect(() => assertManagementOpen(NOW, NOW, 'UTC')).not.toThrow();
  });
});

describe('pacedManagementCalls', () => {
  const scope = authorizedTenantScope('01900000-0000-7000-8000-000000000001', null);
  const account = { whatsappAccountId: '01900000-0000-7000-8000-000000000002', wabaId: WABA };
  const fakeDb = () => {
    const runs: unknown[] = [];
    const db = {
      run: async (s: unknown) => {
        runs.push(s);
        return true;
      },
    } as unknown as Database;
    return { db, runs };
  };
  const clock = { now: () => NOW };
  /** A response that reported no usage. */
  const noUsage: { ok: boolean; usage?: BusinessUseCaseUsage } = { ok: true };

  it('records a reading for the account and makes no call after one pauses it', async () => {
    const { db, runs } = fakeDb();
    const call = pacedManagementCalls({ db, clock }, scope, account);
    let calls = 0;
    const outcome = await untilPaused(async () => {
      await call(async () => {
        calls += 1;
        return { ok: true, usage: usage(WABA, { callCount: 50 }) };
      });
      await call(async () => {
        calls += 1;
        return { ok: true, usage: usage(WABA, { regainAccessMinutes: 2 }) };
      });
      // Not made: the response before paused the account.
      await call(async () => {
        calls += 1;
        return noUsage;
      });
      return 'done' as const;
    });
    expect(calls).toBe(2);
    expect(runs).toEqual([scope, scope]);
    expect(outcome).toEqual({ paused: new Date('2026-10-16T10:02:00.000Z') });
  });

  it("neither records nor stops for a reading of another account's id or a response without one", async () => {
    const { db, runs } = fakeDb();
    const call = pacedManagementCalls({ db, clock }, scope, account);
    const outcome = await untilPaused(async () => {
      await call(async () => ({ ok: false, usage: usage(OTHER, { regainAccessMinutes: 30 }) }));
      await call(async () => noUsage);
      return 'done' as const;
    });
    expect(outcome).toBe('done');
    expect(runs).toEqual([]);
  });

  it('lets other errors through', async () => {
    await expect(
      untilPaused(async () => {
        throw new Error('database down');
      }),
    ).rejects.toThrow('database down');
  });

  it('defers at once when a refusal for now carries the pause itself', async () => {
    const { db, runs } = fakeDb();
    const call = pacedManagementCalls({ db, clock }, scope, account);
    const outcome = await untilPaused(async () => {
      await call(async () => ({
        ok: false,
        kind: 'retryable',
        code: 80007,
        usage: usage(WABA, { callCount: 100, regainAccessMinutes: 4 }),
      }));
      throw new Error('the refusal was returned as a failure');
    });
    expect(outcome).toEqual({ paused: new Date('2026-10-16T10:04:00.000Z') });
    expect(runs).toEqual([scope]);
  });

  it('returns a permanent, credential or unknown refusal that pauses, then makes no further call', async () => {
    for (const kind of ['permanent', 'auth', 'unknown']) {
      const { db } = fakeDb();
      const call = pacedManagementCalls({ db, clock }, scope, account);
      const refused = {
        ok: false,
        kind,
        usage: usage(WABA, { regainAccessMinutes: 1 }),
      };
      let next = 0;
      const outcome = await untilPaused(async () => {
        expect(await call(async () => refused)).toBe(refused);
        await call(async () => {
          next += 1;
          return noUsage;
        });
        return 'done' as const;
      });
      expect(outcome, kind).toEqual({ paused: new Date('2026-10-16T10:01:00.000Z') });
      expect(next).toBe(0);
    }
  });

  it('returns a refusal for now without a pause as before', async () => {
    const { db } = fakeDb();
    const call = pacedManagementCalls({ db, clock }, scope, account);
    const refused = { ok: false, kind: 'retryable', usage: usage(WABA, { callCount: 99 }) };
    expect(await untilPaused(() => call(async () => refused))).toBe(refused);
  });
});

describe('refusedForPause', () => {
  it('holds only for a retryable refusal whose own response set a pause', () => {
    expect(refusedForPause({ ok: false, kind: 'retryable' }, NOW)).toBe(true);
    expect(refusedForPause({ ok: false, kind: 'retryable' }, null)).toBe(false);
    for (const kind of ['permanent', 'auth', 'unknown']) {
      expect(refusedForPause({ ok: false, kind }, NOW)).toBe(false);
    }
    expect(refusedForPause({ ok: true }, NOW)).toBe(false);
  });
});

describe('deferPausedJob', () => {
  const job = {
    kind: 'template.submit',
    tenantId: '01900000-0000-7000-8000-000000000001',
    actorUserId: null,
    ref: '01900000-0000-7000-8000-000000000003',
  };
  const signer = { sign: (input: unknown) => ({ signed: input }) } as unknown as JobSigner;

  it('queues the job for just after the pause under a key of the deferring job’s id', async () => {
    const sent: unknown[][] = [];
    const jobs = {
      enqueue: async (...args: unknown[]) => {
        sent.push(args);
        return 'new-job';
      },
    } as unknown as JobQueue;
    const resumeAt = await deferPausedJob({ jobs, signer }, 'template.submit', job, NOW, 'job-1');
    expect(resumeAt).toEqual(new Date(NOW.getTime() + MANAGEMENT_RESUME_MARGIN_MS));
    expect(sent).toEqual([
      [
        null,
        'template.submit',
        { signed: job },
        { singletonKey: pausedJobKey('job-1'), startAfter: resumeAt },
      ],
    ]);
    expect(pausedJobKey('job-1')).toBe('paused:job-1');
  });

  it('says when nothing was queued', async () => {
    const jobs = { enqueue: async () => null } as unknown as JobQueue;
    expect(await deferPausedJob({ jobs, signer }, 'template.submit', job, NOW, 'job-1')).toBeNull();
  });
});

describe('requestClockStart', () => {
  it('counts a request from the later of its time and its deferred job’s run', () => {
    const later = new Date(NOW.getTime() + 60_000);
    expect(requestClockStart(NOW, null)).toBe(NOW);
    expect(requestClockStart(NOW, later)).toBe(later);
    expect(requestClockStart(later, NOW)).toBe(later);
  });
});

describe('managementUsageView', () => {
  const row = {
    managementUsageReadAt: NOW,
    managementUsagePercent: 42,
    managementPausedUntil: null as Date | null,
  };

  it('shows nothing before a first reading', () => {
    expect(managementUsageView({ ...row, managementUsageReadAt: null }, NOW)).toBeNull();
    expect(managementUsageView({ ...row, managementUsagePercent: null }, NOW)).toBeNull();
  });

  it('shows the reading, and the pause only until it ends', () => {
    expect(managementUsageView(row, NOW)).toEqual({
      percent: 42,
      readAt: NOW.toISOString(),
      pausedUntil: null,
    });
    const until = new Date(NOW.getTime() + 300_000);
    expect(managementUsageView({ ...row, managementPausedUntil: until }, NOW)?.pausedUntil).toBe(
      until.toISOString(),
    );
    expect(
      managementUsageView({ ...row, managementPausedUntil: until }, new Date(until.getTime() + 1))
        ?.pausedUntil,
    ).toBeNull();
  });
});
