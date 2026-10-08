import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isAppError } from '@w360/core';
import type { SQL } from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { FAILURES_CSV_COLUMNS, integrationFailureView } from './ops-model';
import { createPlatformOpsService } from './ops';
import type { PlatformActor } from './service';

const ACTOR: PlatformActor = {
  userId: 'user-ops-1',
  role: 'platform_operator',
  correlationId: 'corr-1',
};
const SUBJECT = '0190a5b2-0000-7000-8000-00000000003d';
const FAILURE = { source: 'webhook_endpoint', subjectId: SUBJECT, state: 'failing' };

/** The ops service over a platform database that records what each call asked it to run. */
function opsWith() {
  const runs: { userId: string; statements: { sql: string; params: unknown[] }[] }[] = [];
  const platformDb = {
    run: async (userId: string, fn: (tx: unknown) => Promise<unknown>) => {
      const statements: { sql: string; params: unknown[] }[] = [];
      runs.push({ userId, statements });
      return fn({
        execute: async (query: SQL) => {
          const { sql, params } = new PgDialect().sqlToQuery(query);
          statements.push({ sql, params });
          return { rows: [] };
        },
      });
    },
  } as unknown as PlatformDatabase;
  const ops = createPlatformOpsService({
    platformDb,
    queues: { snapshot: async () => ({ queues: [] }) } as never,
    clock: { now: () => new Date() },
    keyring: { currentKeyId: 'k1', keyIds: ['k1'] },
    jobSigning: { keyId: 'j1', nextKeyId: null, previousKeyId: null },
  });
  return { ops, runs };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, (error.issues ?? []).map((i) => i.path)];
  }
  throw new Error('expected a refusal');
}

describe('assigning companies’ failing integrations (ADR-313)', () => {
  it('refuses a failure not named by its integration and state, and an assignee that is no account, before any query', async () => {
    const { ops, runs } = opsWith();
    for (const [input, path] of [
      [{ ...FAILURE, subjectId: 'f1', assigneeUserId: 'user-ops-2' }, 'subjectId'],
      [{ ...FAILURE, source: '   ', assigneeUserId: 'user-ops-2' }, 'source'],
      [{ ...FAILURE, source: 'x'.repeat(41), assigneeUserId: 'user-ops-2' }, 'source'],
      [{ ...FAILURE, state: '', assigneeUserId: 'user-ops-2' }, 'state'],
      [{ ...FAILURE, state: 'x'.repeat(41), assigneeUserId: 'user-ops-2' }, 'state'],
      [{ ...FAILURE, assigneeUserId: '   ' }, 'assigneeUserId'],
      [{ ...FAILURE, assigneeUserId: 'x'.repeat(201) }, 'assigneeUserId'],
      [{ ...FAILURE, assigneeUserId: 42 }, 'assigneeUserId'],
      // Left out is not "nobody": taking an assignment off says so with null.
      [FAILURE, 'assigneeUserId'],
    ] as const) {
      expect(await refusal(ops.assignFailure(ACTOR, input)), JSON.stringify(input)).toEqual([
        'validation_failed',
        [path],
      ]);
    }
    expect(runs).toEqual([]);
  });

  it('asks the definer function as the administrator, with the trimmed failure, the assignee or null, and the request’s correlation id', async () => {
    const { ops, runs } = opsWith();
    await ops.assignFailure(ACTOR, {
      source: ' webhook_endpoint ',
      subjectId: SUBJECT,
      state: ' failing ',
      assigneeUserId: ' user-ops-2 ',
    });
    await ops.assignFailure(ACTOR, { ...FAILURE, assigneeUserId: null });
    const sql = 'select ops.platform_assign_integration_failure($1, $2::uuid, $3, $4, $5)';
    expect(runs).toEqual([
      {
        userId: 'user-ops-1',
        statements: [
          { sql, params: ['webhook_endpoint', SUBJECT, 'failing', 'user-ops-2', 'corr-1'] },
        ],
      },
      {
        userId: 'user-ops-1',
        statements: [{ sql, params: ['webhook_endpoint', SUBJECT, 'failing', null, 'corr-1'] }],
      },
    ]);
  });

  it('leaves assignments out of the failures’ CSV, which stays as ADR-158 wrote it', () => {
    expect(FAILURES_CSV_COLUMNS.filter((c) => /assign|administrator/i.test(c))).toEqual([]);
  });
});

describe('the failures assigned to the administrator reading the console (ADR-315)', () => {
  it('lists them when the query string asks for mine, and every failure for anything else', () => {
    expect(integrationFailureView('mine')).toBe('mine');
    for (const value of [undefined, '', 'all', 'MINE', ' mine', 'yours', ['mine'], 1]) {
      expect(integrationFailureView(value), JSON.stringify(value)).toBe('all');
    }
  });
});
