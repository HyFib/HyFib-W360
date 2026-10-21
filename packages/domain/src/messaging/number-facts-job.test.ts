import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, TenantScope } from '@w360/db';
import type * as accessModule from './access';
import { checkWhatsAppAccess, type AccessCheckDeps } from './access';
import { checkAccessAndRefreshNumbers } from './number-facts';

// The access check itself is covered by its own tests; here only what the job does after it.
vi.mock('./access', async (importOriginal) => {
  const actual = await importOriginal<typeof accessModule>();
  return { ...actual, checkWhatsAppAccess: vi.fn() };
});

const checkAccess = vi.mocked(checkWhatsAppAccess);
const SCOPE = { tenantId: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01' } as unknown as TenantScope;
const ACCOUNT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';

/** The job's dependencies, recording every database run and phone number read. */
function depsOf(run: () => unknown) {
  const runs: unknown[] = [];
  const reads: unknown[] = [];
  const deps = {
    db: {
      run: (...args: unknown[]) => {
        runs.push(args);
        return run();
      },
    } as unknown as Database,
    keyring: { decryptString: () => 'token' },
    graph: {
      getPhoneNumber: (...args: unknown[]) => {
        reads.push(args);
        throw new Error('read not expected');
      },
    },
    clock: { now: () => new Date('2026-10-16T10:00:00Z') },
    meta: { appId: '1', appSecret: 's' },
    notices: { outbox: {}, appBaseUrl: 'https://app.w360.test' },
  } as unknown as AccessCheckDeps;
  return { deps, runs, reads };
}

beforeEach(() => {
  checkAccess.mockReset();
});

describe('the access check’s job and the numbers’ refresh (ADR-402)', () => {
  it('refreshes nothing unless the access check is healthy', async () => {
    const outcomes = [
      { outcome: 'lost' as const },
      { outcome: 'not_checked' as const, error: 'retryable 2: OAuthException' },
      { outcome: 'skipped' as const },
      { outcome: 'paused' as const, pausedUntil: new Date('2026-10-16T10:05:00Z') },
    ];
    for (const access of outcomes) {
      checkAccess.mockResolvedValueOnce(access);
      const { deps, runs, reads } = depsOf(() => {
        throw new Error('no database run expected');
      });
      expect(await checkAccessAndRefreshNumbers(deps, SCOPE, ACCOUNT), access.outcome).toEqual({
        access,
        numbers: null,
      });
      expect(runs, access.outcome).toEqual([]);
      expect(reads, access.outcome).toEqual([]);
    }
    expect(checkAccess).toHaveBeenCalledTimes(outcomes.length);
  });

  it('refreshes after a healthy check, and gives the check’s outcome unchanged', async () => {
    const access = { outcome: 'healthy' as const, webhooks: { state: 'subscribed' as const } };
    checkAccess.mockResolvedValueOnce(access);
    // The account is gone by the time the refresh loads it: nothing to refresh.
    const { deps, runs } = depsOf(() => Promise.resolve(null));
    expect(await checkAccessAndRefreshNumbers(deps, SCOPE, ACCOUNT)).toEqual({
      access,
      numbers: { outcome: 'skipped', numbers: [], left: 0 },
    });
    expect(runs).toHaveLength(1);
  });

  it('gives a refresh’s error with the stored outcome instead of throwing', async () => {
    const access = { outcome: 'healthy' as const, webhooks: { state: 'subscribed' as const } };
    checkAccess.mockResolvedValueOnce(access);
    const failure = new Error('connection terminated');
    const { deps } = depsOf(() => Promise.reject(failure));
    const result = await checkAccessAndRefreshNumbers(deps, SCOPE, ACCOUNT);
    expect(result).toEqual({ access, numbers: null, numbersError: failure });
    expect(result.numbersError).toBe(failure);
  });
});
