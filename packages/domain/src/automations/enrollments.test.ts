import { describe, expect, it } from 'vitest';
import { getTableName, type SQL, type Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { QUEUES } from '@w360/contracts';
import { AppError, isAppError } from '@w360/core';
import type { Database, TenantScope } from '@w360/db';
import type { TenantContext } from '../authz/context';
import { RecordingJobQueue } from '../jobs/queue';
import { JobSigner } from '../jobs/envelope';
import {
  ENROLLMENT_LIMITS,
  ENROLLMENT_REFUSAL_LABELS,
  assertEnrollableCount,
  enrollmentBatchDelayMs,
  enrollmentBatchDue,
  enrollmentEndStatus,
  enrollmentStalled,
  enrollmentSweepAction,
  enrollmentEndForRefusal,
  enrollmentJobKey,
  runEnrollmentBatch,
  startEnrollmentSchema,
  summariseRefusals,
  type EnrolleeStart,
} from './enrollment-model';
import {
  createAutomationEnrollmentService,
  endEnrollmentForRemovedMember,
  deferEnrollment,
  findDueEnrollments,
  processEnrollmentBatch,
  resignalEnrollment,
  signalDueEnrollments,
} from './enrollments';
import { START_REFUSALS, startInputVariables, startRefusalOf, type StartRefusal } from './starts';

/**
 * Members' enrolments of contacts or a segment in an automation (ADR-401): the bounds, what a member
 * submits, the inputs, the batch logic, and the order of reads and writes of a batch, a start and a
 * stop against a recording database. Row security, the savepoints' rollbacks, the unique indexes and
 * the job queue run in PostgreSQL: the integration tests (CI) cover them.
 */

const TENANT = '0192a1b2-0000-7000-8000-0000000000f0';
const ENROLLMENT = '0192a1b2-0000-7000-8000-0000000000e0';
const AUTOMATION = '0192a1b2-0000-7000-8000-0000000000a0';
const VERSION = '0192a1b2-0000-7000-8000-0000000000a1';
const CHANNEL = '0192a1b2-0000-7000-8000-0000000000c0';
const MEMBER = '0192a1b2-0000-7000-8000-0000000000d0';
const SEGMENT = '0192a1b2-0000-7000-8000-0000000000b0';
const TEMPLATE = '0192a1b2-0000-7000-8000-000000000070';
const USER = 'user-1';
const NOW = new Date('2026-10-16T12:00:00.000Z');
const clock = { now: () => NOW };
const signer = new JobSigner('k'.repeat(64));

const contactId = (n: number) => `0192a1b2-0000-7000-8000-${String(100000000000 + n)}`;
const conversationOf = (contact: string) => contact.replace('-8000-', '-9000-');

const refusalOf = (reason: StartRefusal) =>
  new AppError('conflict', 'refused', { details: { startRefusal: reason } });

describe('enrolment bounds and input (ADR-401)', () => {
  it('takes at most 10,000 contacts, 50 starts per transaction (under PostgreSQL’s 64 cached subtransactions)', () => {
    expect(ENROLLMENT_LIMITS).toEqual({
      contacts: 10_000,
      batch: 50,
      stallMinutes: 10,
      resignals: 3,
      dueSlackMs: 1_000,
    });
    expect(ENROLLMENT_LIMITS.batch).toBeLessThan(64);
  });

  it('accepts the contacts page’s filters or a segment, the inputs and the count shown', () => {
    const contacts = startEnrollmentSchema.safeParse({
      automationId: AUTOMATION,
      audience: { kind: 'contacts', filter: { q: ' asha ', tag: 'vip' } },
      expectedCount: 3,
    });
    expect(contacts.success && contacts.data).toEqual({
      automationId: AUTOMATION,
      audience: { kind: 'contacts', filter: { q: 'asha', tag: 'vip', consent: 'any' } },
      inputs: {},
      expectedCount: 3,
    });
    const segment = startEnrollmentSchema.safeParse({
      automationId: AUTOMATION,
      audience: { kind: 'segment', segmentId: SEGMENT },
      inputs: { patient: 'Asha' },
      expectedCount: 10_000,
    });
    expect(segment.success).toBe(true);
    for (const bad of [
      { expectedCount: 0 },
      { expectedCount: 10_001 },
      { expectedCount: 2.5 },
      { audience: { kind: 'segment', segmentId: 'not-a-segment' } },
      { audience: { kind: 'everyone' } },
      { audience: { kind: 'contacts', filter: { consent: 'maybe' } } },
      { automationId: 'nope' },
    ]) {
      expect(
        startEnrollmentSchema.safeParse({
          automationId: AUTOMATION,
          audience: { kind: 'segment', segmentId: SEGMENT },
          expectedCount: 1,
          ...bad,
        }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('refuses nobody, more than the limit, and a count other than the one shown', () => {
    const codeOf = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        return isAppError(error) ? [error.code, error.publicMessage] : ['?', String(error)];
      }
      return null;
    };
    expect(codeOf(() => assertEnrollableCount(0, 1))?.[0]).toBe('validation_failed');
    expect(codeOf(() => assertEnrollableCount(10_001, 10_000))).toEqual([
      'validation_failed',
      'At most 10,000 contacts can be enrolled at once. Narrow the filters or the segment, or send a campaign.',
    ]);
    expect(codeOf(() => assertEnrollableCount(12, 11))).toEqual([
      'conflict',
      'These contacts now number 12, not 11. Review them and try again.',
    ]);
    expect(codeOf(() => assertEnrollableCount(10_000, 10_000))).toBeNull();
    expect(codeOf(() => assertEnrollableCount(1, 1))).toBeNull();
  });

  it('validates the inputs exactly as a start through the API, naming the place', () => {
    const automation = { inputs: ['patient', 'slot'] };
    expect(startInputVariables(automation, { patient: 'Asha', slot: '5 pm' }, 'inputs')).toEqual({
      'input.patient': 'Asha',
      'input.slot': '5 pm',
    });
    for (const [given, message] of [
      [{ patient: 'Asha' }, 'Give the input “slot” a value.'],
      [{ patient: 'Asha', slot: '  ' }, 'Give the input “slot” a value.'],
      [{ patient: 'Asha', slot: '5', extra: 'x' }, 'The automation has no input named “extra”.'],
      [
        { patient: 'Asha', slot: 'x'.repeat(1001) },
        'The input “slot” is limited to 1000 characters.',
      ],
      [['Asha'], 'Give the inputs as an object of names and texts.'],
    ] as const) {
      try {
        startInputVariables(automation, given, 'inputs');
        throw new Error(`accepted ${JSON.stringify(given)}`);
      } catch (error) {
        expect(isAppError(error) && error.issues).toEqual([{ path: 'inputs', message }]);
      }
    }
    expect(startInputVariables({ inputs: [] }, {}, 'inputs')).toEqual({});
  });

  it('reads a refused start’s code, and only a known one', () => {
    for (const reason of START_REFUSALS) expect(startRefusalOf(refusalOf(reason))).toBe(reason);
    expect(
      startRefusalOf(new AppError('conflict', 'x', { details: { startRefusal: 'odd' } })),
    ).toBe(null);
    expect(startRefusalOf(new AppError('conflict', 'x'))).toBeNull();
    expect(startRefusalOf(new Error('boom'))).toBeNull();
    expect(enrollmentEndForRefusal(refusalOf('automation_paused'))).toBe('automation_paused');
    expect(enrollmentEndForRefusal(refusalOf('automation_unavailable'))).toBe(
      'automation_unavailable',
    );
    expect(enrollmentEndForRefusal(refusalOf('channel_unavailable'))).toBe('channel_unavailable');
    expect(enrollmentEndForRefusal(refusalOf('not_in_plan'))).toBe('not_in_plan');
    expect(enrollmentEndForRefusal(refusalOf('suppressed'))).toBeNull();
    expect(enrollmentEndForRefusal(new Error('boom'))).toBeNull();
  });

  it('keys each batch’s job by the position it starts after', () => {
    expect(enrollmentJobKey(ENROLLMENT, 0)).toBe(`${ENROLLMENT}:0`);
    expect(enrollmentJobKey(ENROLLMENT, 50)).toBe(`${ENROLLMENT}:50`);
    expect(enrollmentJobKey(ENROLLMENT, 50)).not.toBe(enrollmentJobKey(ENROLLMENT, 100));
  });

  it('summarises refusals by reason, most frequent first, with members’ words', () => {
    expect(
      summariseRefusals([
        { reason: 'opted_out', count: 2 },
        { reason: 'suppressed', count: 5 },
        { reason: 'automation_busy', count: 2 },
        { reason: 'no_number', count: 0 },
        { reason: 'something_new', count: 1 },
      ]),
    ).toEqual([
      { reason: 'suppressed', label: 'On the suppression list', count: 5 },
      {
        reason: 'automation_busy',
        label: 'Another automation was handling the conversation',
        count: 2,
      },
      { reason: 'opted_out', label: 'Opted out', count: 2 },
      { reason: 'something_new', label: 'something_new', count: 1 },
    ]);
    expect(Object.keys(ENROLLMENT_REFUSAL_LABELS).sort()).toEqual(
      [
        ...START_REFUSALS.filter(
          (r) =>
            ![
              'automation_unavailable',
              'automation_paused',
              'channel_unavailable',
              'not_in_plan',
            ].includes(r),
        ),
        'contact_gone',
        'no_number',
      ].sort(),
    );
  });
});

describe('a batch of an enrolment (ADR-401)', () => {
  const pending = (n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => ({ id: `row-${from + i}`, position: from + i }));

  it('starts at most 50, in position order, and records each outcome', async () => {
    const seen: number[] = [];
    const shuffled = pending(120).reverse();
    const result = await runEnrollmentBatch(shuffled, async (e) => {
      seen.push(e.position);
      return { outcome: 'started', runId: `run-${e.position}` };
    });
    expect(seen).toEqual(pending(50).map((p) => p.position));
    expect(result.end).toBeNull();
    expect(result.outcomes).toHaveLength(50);
    expect(result.outcomes[0]).toEqual({
      id: 'row-1',
      position: 1,
      outcome: 'started',
      runId: 'run-1',
    });
  });

  it('records a refused contact with its code and goes on with the others', async () => {
    const result = await runEnrollmentBatch(pending(4), async (e): Promise<EnrolleeStart> => {
      if (e.position === 2) throw refusalOf('suppressed');
      if (e.position === 3) return { outcome: 'refused', reason: 'no_number' };
      return { outcome: 'started', runId: `run-${e.position}` };
    });
    expect(result).toEqual({
      outcomes: [
        { id: 'row-1', position: 1, outcome: 'started', runId: 'run-1' },
        { id: 'row-2', position: 2, outcome: 'refused', reason: 'suppressed' },
        { id: 'row-3', position: 3, outcome: 'refused', reason: 'no_number' },
        { id: 'row-4', position: 4, outcome: 'started', runId: 'run-4' },
      ],
      end: null,
    });
  });

  it('ends the batch when the plan has no automations, the contact not handled', async () => {
    const seen: number[] = [];
    const result = await runEnrollmentBatch(pending(5), async (e) => {
      seen.push(e.position);
      if (e.position === 3) throw refusalOf('not_in_plan');
      return { outcome: 'started', runId: `run-${e.position}` };
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(result.end).toBe('not_in_plan');
    expect(result.outcomes.map((o) => o.position)).toEqual([1, 2]);
  });

  it('throws any other error, so the whole batch rolls back and its retry starts it again', async () => {
    for (const error of [
      new Error('connection lost'),
      new AppError('forbidden', 'no'),
      refusalOf('automation_paused'),
      refusalOf('channel_unavailable'),
      refusalOf('automation_unavailable'),
    ]) {
      await expect(
        runEnrollmentBatch(pending(3), async (e) => {
          if (e.position === 2) throw error;
          return { outcome: 'started', runId: 'r' };
        }),
      ).rejects.toBe(error);
    }
  });

  it('does nothing for an empty batch', async () => {
    expect(await runEnrollmentBatch([], async () => ({ outcome: 'started', runId: 'r' }))).toEqual({
      outcomes: [],
      end: null,
    });
  });
});

// A recording database ------------------------------------------------------------------------

/** One statement a transaction ran. */
interface Step {
  op: 'select' | 'insert' | 'update' | 'delete' | 'execute';
  table: string | null;
  fields: string[];
  lock: string | null;
  set: Record<string, unknown> | null;
  values: Record<string, unknown> | null;
  where: SQL | null;
  sql: string | null;
  params: unknown[];
  returning: boolean;
  limit: number | null;
}

const dialect = new PgDialect();

function recordingDb(answer: (step: Step) => unknown) {
  const steps: Step[] = [];
  const chain = (step: Step): unknown => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'then') {
            return (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
              steps.push(step);
              try {
                resolve(answer(step));
              } catch (error) {
                reject(error);
              }
            };
          }
          return (...args: unknown[]) => {
            if (property === 'from') step.table = getTableName(args[0] as Table);
            if (property === 'for') step.lock = String(args[0]);
            if (property === 'set') step.set = args[0] as Record<string, unknown>;
            if (property === 'values') step.values = args[0] as Record<string, unknown>;
            if (property === 'returning') step.returning = true;
            if (property === 'limit') step.limit = Number(args[0]);
            if (property === 'where') {
              step.where = (args[0] as SQL | undefined) ?? null;
              step.params = step.where ? dialect.sqlToQuery(step.where).params : [];
            }
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const start = (op: Step['op'], table: Table | null, extra: Partial<Step> = {}) =>
    chain({
      op,
      table: table ? getTableName(table) : null,
      fields: [],
      lock: null,
      set: null,
      values: null,
      where: null,
      sql: null,
      params: [],
      returning: false,
      limit: null,
      ...extra,
    });
  const tx: Record<string, unknown> = {
    select: (fields?: Record<string, unknown>) =>
      start('select', null, { fields: fields ? Object.keys(fields) : [] }),
    insert: (table: Table) => start('insert', table),
    update: (table: Table) => start('update', table),
    delete: (table: Table) => start('delete', table),
    execute: (query: SQL) => {
      const q = dialect.sqlToQuery(query);
      return start('execute', null, { sql: q.sql, params: q.params });
    },
    // A savepoint: the recording keeps what a rolled-back savepoint wrote, which the tests ignore.
    transaction: (fn: (sp: unknown) => unknown) => fn(tx),
  };
  const db = {
    run: (_scope: unknown, fn: (transaction: unknown) => unknown) => fn(tx),
  } as unknown as Database;
  return { db, steps };
}

const writes = (steps: Step[]) =>
  steps.filter((s) => s.op !== 'select' && s.op !== 'execute').map((s) => `${s.op} ${s.table}`);

/** A contact of a scenario and what holds it back. */
interface ScenarioContact {
  n: number;
  phone?: string | null;
  erased?: boolean;
  merged?: boolean;
  suppressed?: boolean;
  optedOut?: boolean;
  marketing?: 'opted_in' | 'opted_out' | null;
  assigned?: boolean;
  busy?: boolean;
  recentRuns?: number;
}

interface Scenario {
  status?: 'running' | 'completed' | 'stopped';
  missing?: boolean;
  roles?: readonly string[];
  automationStatus?: string;
  trigger?: unknown;
  marketingTemplate?: boolean;
  channelStatus?: string;
  inputs?: Record<string, string>;
  contacts: ScenarioContact[];
  /** Rows the pending query answers (defaults to every contact). */
  pendingRows?: number;
  modules?: string[];
  runsLeft?: number;
  requireMarketingOptIn?: boolean;
  failRunInsert?: boolean;
  cursor?: number;
  /** How many outcome rows the update finds still pending (default: all). */
  updatedRows?: number;
  nextBatchAt?: Date | null;
  resignalCount?: number;
}

function scenarioAnswers(s: Scenario) {
  const byId = new Map(s.contacts.map((c) => [contactId(c.n), c]));
  const byConversation = new Map(s.contacts.map((c) => [conversationOf(contactId(c.n)), c]));
  let runsLeft = s.runsLeft ?? Number.POSITIVE_INFINITY;
  const contactIn = (params: unknown[]) =>
    params.map((p) => byId.get(String(p))).find((c) => c !== undefined);
  const phoneOf = (c: ScenarioContact) =>
    c.phone === undefined ? `+9198110${String(c.n).padStart(5, '0')}` : c.phone;
  return (step: Step): unknown => {
    if (step.op === 'execute') {
      if (step.sql?.includes('tenant_entitlements')) {
        return {
          rows: [
            {
              plan_status: 'active',
              plan_id: null,
              seats: 5,
              numbers: 1,
              teams: 1,
              live_automations: 5,
              automation_runs: s.runsLeft === undefined ? null : 1_000,
              api_requests: 1_000,
              modules: s.modules ?? ['automations'],
              usage_anchor: '2026-10-01T00:00:00.000Z',
              api_scopes: null,
            },
          ],
        };
      }
      if (step.sql?.includes('usage_counters')) {
        if (runsLeft <= 0) return { rows: [] };
        runsLeft -= 1;
        return { rows: [{ used: 1 }] };
      }
      if (step.sql?.includes('update app.automation_enrollment_contacts')) {
        // RETURNING: the rows still pending (all of them, unless a test says how many).
        const kinds = (step.params.filter((p) => Array.isArray(p))[1] ?? []) as string[];
        return {
          rows: kinds.slice(0, s.updatedRows ?? kinds.length).map((outcome) => ({ outcome })),
        };
      }
      return { rows: [] };
    }
    if (step.op === 'insert') {
      if (step.table === 'automation_runs' && s.failRunInsert) throw new Error('disk full');
      return [];
    }
    if (step.op === 'update' || step.op === 'delete') return [];
    switch (step.table) {
      case 'automation_enrollments':
        return s.missing
          ? []
          : [
              {
                id: ENROLLMENT,
                tenantId: TENANT,
                automationId: AUTOMATION,
                source: 'contacts',
                segmentId: null,
                inputs: s.inputs ?? { patient: 'Asha' },
                status: s.status ?? 'running',
                endReason: null,
                total: s.contacts.length,
                startedCount: 0,
                refusedCount: 0,
                cancelledCount: 0,
                cursorPosition: s.cursor ?? 0,
                nextBatchAt: s.nextBatchAt ?? null,
                resignalCount: s.resignalCount ?? 0,
                createdByMembershipId: MEMBER,
                createdByUserId: USER,
                stoppedByMembershipId: null,
                createdAt: NOW,
                updatedAt: NOW,
                endedAt: null,
              },
            ];
      case 'memberships':
        return [{ roles: s.roles ?? ['admin'] }];
      case 'automations':
        return [
          { id: AUTOMATION, status: s.automationStatus ?? 'active', activeVersionId: VERSION },
        ];
      case 'automation_versions':
        return [
          {
            id: VERSION,
            trigger: s.trigger ?? { type: 'api', inputs: ['patient'] },
            graph: s.marketingTemplate
              ? {
                  version: 1,
                  start: 'offer',
                  nodes: [
                    {
                      id: 'offer',
                      type: 'send_template',
                      templateId: TEMPLATE,
                      header: [],
                      body: [],
                      next: null,
                    },
                  ],
                }
              : {
                  version: 1,
                  start: 'hi',
                  nodes: [{ id: 'hi', type: 'send_text', text: 'Hi', next: null }],
                },
            channelAccountId: CHANNEL,
          },
        ];
      case 'message_templates':
        return s.marketingTemplate ? [{ id: TEMPLATE }] : [];
      case 'channel_accounts':
        return [{ status: s.channelStatus ?? 'active' }];
      case 'automation_enrollment_contacts': {
        const from = s.cursor ?? 0;
        const rows = s.contacts
          .map((c, i) => ({
            id: `row-${c.n}`,
            position: i + 1,
            contactId: c.merged ? null : contactId(c.n),
          }))
          .filter((r) => r.position > from);
        return rows.slice(0, s.pendingRows ?? rows.length);
      }
      case 'contacts': {
        if (step.fields.includes('id')) {
          return s.contacts
            .filter((c) => !c.merged)
            .map((c) => ({
              id: contactId(c.n),
              phone: c.erased ? null : phoneOf(c),
              erasedAt: c.erased ? NOW : null,
            }));
        }
        const c = contactIn(step.params);
        return c ? [{ erasedAt: c.erased ? NOW : null, phone: c.erased ? null : phoneOf(c) }] : [];
      }
      case 'suppressions':
        return contactIn(step.params)?.suppressed ||
          s.contacts.some((c) => c.suppressed && step.params.includes(phoneOf(c)))
          ? [{ id: 'sup' }]
          : [];
      case 'contact_consents': {
        const c = contactIn(step.params);
        const purpose = step.params.includes('marketing') ? 'marketing' : 'utility';
        if (purpose === 'utility') return c?.optedOut ? [{ status: 'opted_out' }] : [];
        return c?.marketing ? [{ status: c.marketing }] : [];
      }
      case 'messaging_settings':
        return [
          {
            optOutKeywords: 'STOP',
            marketingOptOutKeywords: '',
            optInKeywords: 'START',
            requireMarketingOptIn: s.requireMarketingOptIn ?? false,
            updatedAt: NOW,
          },
        ];
      case 'conversations': {
        const c = contactIn(step.params);
        if (!c) return [];
        return [
          {
            id: conversationOf(contactId(c.n)),
            status: 'resolved',
            resolvedAt: NOW,
            assignedMembershipId: c.assigned ? MEMBER : null,
          },
        ];
      }
      case 'automation_runs': {
        const c = step.params
          .map((p) => byConversation.get(String(p)))
          .find((x) => x !== undefined);
        if (step.lock === 'update') return c?.busy ? [{ id: 'other-run' }] : [];
        return [{ n: c?.recentRuns ?? 0 }];
      }
      default:
        throw new Error(`an unexpected read of ${step.table}`);
    }
  };
}

const scope = { kind: 'tenant', tenantId: TENANT, userId: USER } as unknown as TenantScope;

async function batchOf(s: Scenario, sendRatePerSecond?: number) {
  const recording = recordingDb(scenarioAnswers(s));
  const jobs = new RecordingJobQueue();
  const result = await processEnrollmentBatch(
    {
      db: recording.db,
      clock,
      jobs,
      signer,
      ...(sendRatePerSecond ? { sendRatePerSecond } : {}),
    },
    scope,
    ENROLLMENT,
  );
  const outcomes = recording.steps.find(
    (st) => st.op === 'execute' && st.sql?.includes('automation_enrollment_contacts'),
  );
  // The arrays the outcomes' statement takes: rows, outcomes, reasons, runs.
  return {
    result,
    steps: recording.steps,
    jobs: jobs.jobs,
    outcomes: (outcomes?.params ?? []).filter((p) => Array.isArray(p)),
  };
}

/** The enrolment's end, as the batch wrote it (the update that sets its status). */
const endOf = (steps: Step[]) =>
  steps.find((st) => st.op === 'update' && st.table === 'automation_enrollments' && st.set?.status)
    ?.set;

describe('processEnrollmentBatch (ADR-401)', () => {
  it('starts each contact as a live api run naming the enrolment, records the outcomes and completes', async () => {
    const { result, steps, jobs, outcomes } = await batchOf({
      contacts: [{ n: 1 }, { n: 2 }],
    });
    expect(result).toEqual({
      outcome: 'finished',
      status: 'completed',
      reason: null,
      started: 2,
      refused: 0,
    });
    const runs = steps.filter((st) => st.op === 'insert' && st.table === 'automation_runs');
    expect(runs.map((r) => r.values)).toEqual(
      [1, 2].map((n) =>
        expect.objectContaining({
          tenantId: TENANT,
          automationId: AUTOMATION,
          versionId: VERSION,
          contactId: contactId(n),
          conversationId: conversationOf(contactId(n)),
          channelAccountId: CHANNEL,
          mode: 'live',
          triggerType: 'api',
          apiKeyId: null,
          enrollmentId: ENROLLMENT,
          variables: { 'input.patient': 'Asha' },
          status: 'running',
          currentNodeId: 'hi',
        }),
      ),
    );
    const started = steps.filter((st) => st.op === 'insert' && st.table === 'automation_run_steps');
    expect(started.map((st) => st.values?.detail)).toEqual(['enrollment', 'enrollment']);
    // No audit entry per run: the enrolment is audited once.
    expect(
      steps
        .filter((st) => st.op === 'insert' && st.table === 'audit_events')
        .map((st) => st.values?.action),
    ).toEqual(['automation.enrollment_ended']);
    // Outcomes: the rows, started, no reasons, the runs.
    expect(outcomes[0]).toEqual(['row-1', 'row-2']);
    expect(outcomes[1]).toEqual(['started', 'started']);
    expect(outcomes[2]).toEqual([null, null]);
    expect(outcomes[3]).toEqual([runs[0]?.values?.id, runs[1]?.values?.id]);
    // Each run's first job, acting for the company; no further batch.
    expect(jobs.map((j) => [j.queue, j.envelope.actorUserId, j.options.singletonKey])).toEqual([
      [QUEUES.automationRun.name, null, `${String(runs[0]?.values?.id)}:start`],
      [QUEUES.automationRun.name, null, `${String(runs[1]?.values?.id)}:start`],
    ]);
    expect(endOf(steps)).toMatchObject({ status: 'completed', endReason: null, inputs: {} });
    // The enrolment's row is locked first, and every write follows the reads that check it.
    expect(steps[0]).toMatchObject({
      op: 'select',
      table: 'automation_enrollments',
      lock: 'update',
    });
  });

  it('handles 50 contacts and queues the next batch after the 50th, signed with the member', async () => {
    const contacts = Array.from({ length: 60 }, (_, i) => ({ n: i + 1 }));
    const { result, jobs, steps } = await batchOf({ contacts, pendingRows: 51 });
    expect(result).toEqual({
      outcome: 'batch',
      started: 50,
      refused: 0,
      nextBatchAt: new Date(NOW.getTime() + 2_500),
    });
    const next = jobs.filter((j) => j.queue === QUEUES.automationEnroll.name);
    expect(
      next.map((j) => [
        j.envelope.kind,
        j.envelope.ref,
        j.envelope.actorUserId,
        j.envelope.tenantId,
        j.options.singletonKey,
      ]),
    ).toEqual([['automation.enroll', ENROLLMENT, USER, TENANT, `${ENROLLMENT}:50`]]);
    expect(endOf(steps)).toBeUndefined();
    const progress = steps.find(
      (st) =>
        st.op === 'update' &&
        st.table === 'automation_enrollments' &&
        st.set?.cursorPosition !== undefined,
    );
    expect(progress?.set?.cursorPosition).toBe(50);
  });

  it('continues after the position already handled (a retried or restarted job)', async () => {
    const contacts = Array.from({ length: 5 }, (_, i) => ({ n: i + 1 }));
    const { steps, outcomes } = await batchOf({ contacts, cursor: 3 });
    const pendingRead = steps.find(
      (st) => st.table === 'automation_enrollment_contacts' && st.op === 'select',
    );
    expect(pendingRead?.params).toContain(3);
    expect(pendingRead?.params).toContain('pending');
    expect(outcomes[0]).toEqual(['row-4', 'row-5']);
    expect(
      steps
        .filter((st) => st.op === 'insert' && st.table === 'automation_runs')
        .map((st) => st.values?.contactId),
    ).toEqual([contactId(4), contactId(5)]);
  });

  it('refuses each contact a start step refuses, with its reason, and starts the others', async () => {
    const { result, outcomes, steps } = await batchOf({
      contacts: [
        { n: 1, suppressed: true },
        { n: 2, optedOut: true },
        { n: 3, erased: true },
        { n: 4, assigned: true },
        { n: 5, busy: true },
        { n: 6, recentRuns: 10 },
        { n: 7, recentRuns: 9 },
        { n: 8, phone: null },
        { n: 9, merged: true },
        { n: 10 },
      ],
    });
    expect(result).toMatchObject({
      outcome: 'finished',
      status: 'completed',
      started: 2,
      refused: 8,
    });
    expect(outcomes[1]).toEqual([
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'started',
      'refused',
      'refused',
      'started',
    ]);
    expect(outcomes[2]).toEqual([
      'suppressed',
      'opted_out',
      'contact_erased',
      'conversation_assigned',
      'automation_busy',
      'automation_limit',
      null,
      'no_number',
      'contact_gone',
      null,
    ]);
    const counts = steps.find(
      (st) =>
        st.op === 'update' &&
        st.table === 'automation_enrollments' &&
        st.set?.cursorPosition !== undefined,
    );
    expect(counts?.set?.cursorPosition).toBe(10);
  });

  it('refuses the contacts beyond the plan’s runs left this month, and ends when the plan has no automations', async () => {
    const quota = await batchOf({ contacts: [{ n: 1 }, { n: 2 }, { n: 3 }], runsLeft: 1 });
    expect(quota.outcomes[2]).toEqual([null, 'automation_quota', 'automation_quota']);
    const noPlan = await batchOf({ contacts: [{ n: 1 }, { n: 2 }], modules: [] });
    expect(noPlan.result).toMatchObject({
      outcome: 'finished',
      status: 'stopped',
      reason: 'not_in_plan',
    });
    expect(endOf(noPlan.steps)).toMatchObject({
      status: 'stopped',
      endReason: 'not_in_plan',
      inputs: {},
    });
    // The contacts not handled are cancelled.
    expect(
      noPlan.steps.some(
        (st) =>
          st.op === 'update' &&
          st.table === 'automation_enrollment_contacts' &&
          st.set?.outcome === 'cancelled',
      ),
    ).toBe(true);
  });

  it('asks for marketing consent when the automation sends marketing templates', async () => {
    const { outcomes } = await batchOf({
      marketingTemplate: true,
      requireMarketingOptIn: true,
      contacts: [{ n: 1, marketing: 'opted_in' }, { n: 2 }, { n: 3, marketing: 'opted_out' }],
    });
    expect(outcomes[2]).toEqual([null, 'no_marketing_opt_in', 'opted_out']);
    const utility = await batchOf({ requireMarketingOptIn: true, contacts: [{ n: 2 }] });
    expect(utility.outcomes[2]).toEqual([null]);
  });

  it('ends without starting anyone when the member, the automation, its number or the inputs no longer allow it', async () => {
    for (const [scenario, reason] of [
      [{ roles: ['marketer'] }, 'member_removed'],
      [{ roles: [] }, 'member_removed'],
      [{ automationStatus: 'paused' }, 'automation_paused'],
      [{ automationStatus: 'archived' }, 'automation_unavailable'],
      [
        { trigger: { type: 'any_message', hours: 'any', cooldownMinutes: 0 } },
        'automation_unavailable',
      ],
      [{ channelStatus: 'disconnected' }, 'channel_unavailable'],
      [{ trigger: { type: 'api', inputs: ['patient', 'slot'] } }, 'inputs_changed'],
      [{ inputs: {} }, 'inputs_changed'],
    ] as const) {
      const { result, steps, jobs } = await batchOf({ ...scenario, contacts: [{ n: 1 }] });
      expect(result, reason).toMatchObject({ outcome: 'finished', status: 'stopped', reason });
      expect(
        steps.some((st) => st.op === 'insert' && st.table === 'automation_runs'),
        reason,
      ).toBe(false);
      expect(jobs, reason).toEqual([]);
      expect(endOf(steps), reason).toMatchObject({
        status: 'stopped',
        endReason: reason,
        inputs: {},
      });
    }
  });

  it('does nothing for an enrolment that ended or is not the company’s', async () => {
    for (const status of ['completed', 'stopped'] as const) {
      const { result, steps } = await batchOf({ status, contacts: [{ n: 1 }] });
      expect(result).toEqual({ outcome: 'ended' });
      expect(writes(steps)).toEqual([]);
    }
    const { result, steps } = await batchOf({ missing: true, contacts: [{ n: 1 }] });
    expect(result).toEqual({ outcome: 'missing' });
    expect(writes(steps)).toEqual([]);
    expect(
      await processEnrollmentBatch(
        { db: recordingDb(() => []).db, clock, jobs: new RecordingJobQueue(), signer },
        scope,
        'not-an-id',
      ),
    ).toEqual({ outcome: 'missing' });
  });

  it('fails the job on an unexpected error, so its transaction rolls back every start of the batch', async () => {
    await expect(batchOf({ contacts: [{ n: 1 }, { n: 2 }], failRunInsert: true })).rejects.toThrow(
      'disk full',
    );
  });

  it('ends a running enrolment whose member left, and leaves an ended one', async () => {
    const running = recordingDb(scenarioAnswers({ contacts: [{ n: 1 }] }));
    expect(await endEnrollmentForRemovedMember({ db: running.db, clock }, scope, ENROLLMENT)).toBe(
      true,
    );
    expect(endOf(running.steps)).toMatchObject({ status: 'stopped', endReason: 'member_removed' });
    const ended = recordingDb(scenarioAnswers({ status: 'completed', contacts: [{ n: 1 }] }));
    expect(await endEnrollmentForRemovedMember({ db: ended.db, clock }, scope, ENROLLMENT)).toBe(
      false,
    );
    expect(writes(ended.steps)).toEqual([]);
  });
});

// Members' requests ----------------------------------------------------------------------------

function memberCtx(permissions: string[]): TenantContext {
  return {
    tenant: { id: TENANT, status: 'active', slug: 'acme', timezone: 'Asia/Kolkata' },
    membership: { id: MEMBER },
    user: { id: USER },
    permissions: new Set(permissions),
    rolePermissions: new Set(permissions),
    correlationId: 'corr-1',
    scope: {},
  } as unknown as TenantContext;
}

const ENROLLER = ['automations.publish', 'automations.read', 'contacts.read', 'campaigns.read'];

function startAnswers(s: { contacts: number; marketingTemplate?: boolean; trigger?: unknown }) {
  const base = scenarioAnswers({
    contacts: [],
    ...(s.marketingTemplate ? { marketingTemplate: true } : {}),
    ...(s.trigger ? { trigger: s.trigger } : {}),
  });
  return (step: Step): unknown => {
    if (step.op === 'select' && step.table === 'contacts') {
      return Array.from({ length: s.contacts }, (_, i) => ({ id: contactId(i + 1) }));
    }
    if (step.op === 'select' && step.table === 'segments') {
      return [
        {
          name: 'VIPs',
          definition: { match: 'all', conditions: [{ type: 'tag', op: 'has', tag: 'vip' }] },
          archivedAt: null,
        },
      ];
    }
    if (step.op === 'select' && step.table === 'contact_fields') return [];
    return base(step);
  };
}

describe('startEnrollment and stopEnrollment (ADR-401)', () => {
  const service = (db: Database, jobs = new RecordingJobQueue()) =>
    createAutomationEnrollmentService({ db, clock, jobs, signer });
  const input = (over: Record<string, unknown> = {}) => ({
    automationId: AUTOMATION,
    audience: { kind: 'contacts', filter: { tag: 'vip' } },
    inputs: { patient: 'Asha' },
    expectedCount: 3,
    ...over,
  });
  async function refusal(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (!isAppError(error)) throw error;
      return { code: error.code, message: error.publicMessage, issues: error.issues };
    }
    throw new Error('expected a refusal');
  }

  it('snapshots the matching contacts in id order, audits without the inputs and queues the first batch as the member', async () => {
    const recording = recordingDb(startAnswers({ contacts: 3 }));
    const jobs = new RecordingJobQueue();
    const result = await service(recording.db, jobs).startEnrollment(memberCtx(ENROLLER), input());
    expect(result.total).toBe(3);
    const snapshot = recording.steps.find((st) => st.op === 'select' && st.table === 'contacts');
    expect(snapshot?.limit).toBe(10_001);
    const inserted = recording.steps.find(
      (st) => st.op === 'insert' && st.table === 'automation_enrollments',
    );
    expect(inserted?.values).toEqual({
      id: result.id,
      tenantId: TENANT,
      automationId: AUTOMATION,
      source: 'contacts',
      segmentId: null,
      inputs: { patient: 'Asha' },
      total: 3,
      nextBatchAt: NOW,
      createdByMembershipId: MEMBER,
      createdByUserId: USER,
    });
    const rows = recording.steps.find(
      (st) => st.op === 'execute' && st.sql?.includes('automation_enrollment_contacts'),
    );
    expect(rows?.params).toContainEqual([contactId(1), contactId(2), contactId(3)]);
    const audit = recording.steps.find((st) => st.op === 'insert' && st.table === 'audit_events');
    expect(audit?.values).toMatchObject({
      action: 'automation.enrollment_started',
      actorType: 'user',
      actorId: USER,
      subjectId: result.id,
      metadata: {
        automationId: AUTOMATION,
        source: 'contacts',
        filter: { q: false, tag: 'vip', consent: 'any' },
        contacts: 3,
      },
    });
    expect(JSON.stringify(audit?.values)).not.toContain('Asha');
    expect(
      jobs.jobs.map((j) => [
        j.queue,
        j.envelope.kind,
        j.envelope.actorUserId,
        j.options.singletonKey,
      ]),
    ).toEqual([[QUEUES.automationEnroll.name, 'automation.enroll', USER, `${result.id}:0`]]);
  });

  it('enrols a segment’s members, naming the segment', async () => {
    const recording = recordingDb(startAnswers({ contacts: 2 }));
    const result = await service(recording.db).startEnrollment(
      memberCtx(ENROLLER),
      input({ audience: { kind: 'segment', segmentId: SEGMENT }, expectedCount: 2 }),
    );
    const inserted = recording.steps.find(
      (st) => st.op === 'insert' && st.table === 'automation_enrollments',
    );
    expect(inserted?.values).toMatchObject({ source: 'segment', segmentId: SEGMENT, total: 2 });
    expect(result.total).toBe(2);
  });

  it('refuses members who may not publish automations, read contacts or segments, and marketing without campaigns', async () => {
    for (const missing of ['automations.publish', 'contacts.read']) {
      const db = recordingDb(startAnswers({ contacts: 3 }));
      expect(
        (
          await refusal(
            service(db.db).startEnrollment(
              memberCtx(ENROLLER.filter((p) => p !== missing)),
              input(),
            ),
          )
        ).code,
        missing,
      ).toBe('forbidden');
      expect(writes(db.steps)).toEqual([]);
    }
    const noSegments = recordingDb(startAnswers({ contacts: 2 }));
    expect(
      (
        await refusal(
          service(noSegments.db).startEnrollment(
            memberCtx(ENROLLER.filter((p) => p !== 'campaigns.read')),
            input({ audience: { kind: 'segment', segmentId: SEGMENT }, expectedCount: 2 }),
          ),
        )
      ).code,
    ).toBe('forbidden');
    const marketing = recordingDb(startAnswers({ contacts: 3, marketingTemplate: true }));
    expect(
      await refusal(service(marketing.db).startEnrollment(memberCtx(ENROLLER), input())),
    ).toMatchObject({
      code: 'forbidden',
      message:
        'This automation sends marketing templates: enrolling contacts in it needs permission to send campaigns.',
    });
    expect(writes(marketing.steps)).toEqual([]);
    const allowed = recordingDb(startAnswers({ contacts: 3, marketingTemplate: true }));
    await service(allowed.db).startEnrollment(memberCtx([...ENROLLER, 'campaigns.send']), input());
    expect(writes(allowed.steps)).toContain('insert automation_enrollments');
  });

  it('refuses inputs the automation does not take, and a count other than the one shown, writing nothing', async () => {
    const badInputs = recordingDb(startAnswers({ contacts: 3 }));
    expect(
      await refusal(
        service(badInputs.db).startEnrollment(memberCtx(ENROLLER), input({ inputs: {} })),
      ),
    ).toMatchObject({
      code: 'validation_failed',
      issues: [{ path: 'inputs', message: 'Give the input “patient” a value.' }],
    });
    expect(writes(badInputs.steps)).toEqual([]);
    const changed = recordingDb(startAnswers({ contacts: 4 }));
    expect(
      (await refusal(service(changed.db).startEnrollment(memberCtx(ENROLLER), input()))).code,
    ).toBe('conflict');
    expect(writes(changed.steps)).toEqual([]);
    const tooMany = recordingDb(startAnswers({ contacts: 10_001 }));
    expect(
      (
        await refusal(
          service(tooMany.db).startEnrollment(
            memberCtx(ENROLLER),
            input({ expectedCount: 10_000 }),
          ),
        )
      ).code,
    ).toBe('validation_failed');
    expect(writes(tooMany.steps)).toEqual([]);
  });

  it('refuses a second running enrolment of the automation in members’ words', async () => {
    const duplicate = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'automation_enrollments_running_uq',
    });
    const db = {
      run: () => Promise.reject(duplicate),
    } as unknown as Database;
    expect(await refusal(service(db).startEnrollment(memberCtx(ENROLLER), input()))).toEqual({
      code: 'conflict',
      message:
        'Contacts are being enrolled in this automation already. Wait until that enrolment ends, or stop it.',
      issues: undefined,
    });
    const other = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'other_uq',
    });
    await expect(
      service({ run: () => Promise.reject(other) } as unknown as Database).startEnrollment(
        memberCtx(ENROLLER),
        input(),
      ),
    ).rejects.toBe(other);
  });

  it('stops a running enrolment: the contacts not handled are cancelled, the inputs cleared, audited', async () => {
    const recording = recordingDb(scenarioAnswers({ contacts: [{ n: 1 }] }));
    await service(recording.db).stopEnrollment(memberCtx(ENROLLER), { id: ENROLLMENT });
    expect(writes(recording.steps)).toEqual([
      'update automation_enrollment_contacts',
      'update automation_enrollments',
      'insert audit_events',
    ]);
    expect(endOf(recording.steps)).toMatchObject({
      status: 'stopped',
      endReason: 'stopped_by_member',
      stoppedByMembershipId: MEMBER,
      inputs: {},
    });
    expect(recording.steps[0]).toMatchObject({ table: 'automation_enrollments', lock: 'update' });
    const ended = recordingDb(scenarioAnswers({ status: 'completed', contacts: [{ n: 1 }] }));
    expect(
      (await refusal(service(ended.db).stopEnrollment(memberCtx(ENROLLER), { id: ENROLLMENT })))
        .code,
    ).toBe('conflict');
    expect(writes(ended.steps)).toEqual([]);
    const viewer = recordingDb(scenarioAnswers({ contacts: [{ n: 1 }] }));
    expect(
      (
        await refusal(
          service(viewer.db).stopEnrollment(memberCtx(['automations.read']), { id: ENROLLMENT }),
        )
      ).code,
    ).toBe('forbidden');
  });
});

describe('pacing, progress and the sweep (ADR-401 review)', () => {
  it('spaces batches by the runs they started at the number’s send rate', () => {
    expect(enrollmentBatchDelayMs(50, 20)).toBe(2_500);
    expect(enrollmentBatchDelayMs(50, 1)).toBe(50_000);
    expect(enrollmentBatchDelayMs(3, 20)).toBe(150);
    expect(enrollmentBatchDelayMs(1, 3)).toBe(334);
    expect(enrollmentBatchDelayMs(0, 20)).toBe(0);
    expect(enrollmentBatchDelayMs(10, 0)).toBe(10_000);
  });

  it('calls an enrolment stalled when its next batch is 10 minutes overdue or more', () => {
    const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
    expect(enrollmentStalled(at(11), NOW)).toBe(true);
    // The same bound as the due list's `next_batch_at <= now() - 10 minutes`.
    expect(enrollmentStalled(at(10), NOW)).toBe(true);
    expect(enrollmentStalled(new Date(NOW.getTime() - 10 * 60_000 + 1), NOW)).toBe(false);
    expect(enrollmentStalled(at(-5), NOW)).toBe(false);
    expect(enrollmentStalled(null, NOW)).toBe(false);
  });

  it('queues the next batch to start after the runs this one started take at the send rate', async () => {
    const contacts = Array.from({ length: 60 }, (_, i) => ({ n: i + 1 }));
    const paced = await batchOf({ contacts, pendingRows: 51 }, 10);
    const next = paced.jobs.find((j) => j.queue === QUEUES.automationEnroll.name);
    expect(next?.options.startAfter).toEqual(new Date(NOW.getTime() + 5_000));
    expect(paced.result).toMatchObject({
      outcome: 'batch',
      nextBatchAt: new Date(NOW.getTime() + 5_000),
    });
    const progress = paced.steps.find(
      (st) =>
        st.op === 'update' &&
        st.table === 'automation_enrollments' &&
        st.set?.cursorPosition !== undefined,
    );
    expect(progress?.set?.nextBatchAt).toEqual(new Date(NOW.getTime() + 5_000));
    // The configured rate's default when none is given (20 a second).
    const byDefault = await batchOf({ contacts, pendingRows: 51 });
    expect(
      byDefault.jobs.find((j) => j.queue === QUEUES.automationEnroll.name)?.options.startAfter,
    ).toEqual(new Date(NOW.getTime() + 2_500));
    // Refused contacts send nothing: a batch that started none queues the next one at once.
    const refused = await batchOf(
      { contacts: contacts.map((c) => ({ ...c, suppressed: true })), pendingRows: 51 },
      10,
    );
    const now = refused.jobs.find((j) => j.queue === QUEUES.automationEnroll.name);
    expect(now?.options.startAfter).toBeUndefined();
  });

  it('counts the outcomes the update recorded, not the ones it was given', async () => {
    const { result } = await batchOf({ contacts: [{ n: 1 }, { n: 2 }, { n: 3 }], updatedRows: 1 });
    expect(result).toMatchObject({ outcome: 'finished', started: 1, refused: 0 });
  });

  it('clears the next batch’s time when the enrolment ends, and sets it when it starts', async () => {
    const { steps } = await batchOf({ contacts: [{ n: 1 }] });
    expect(endOf(steps)).toMatchObject({ status: 'completed', nextBatchAt: null });
    const recording = recordingDb(startAnswers({ contacts: 3 }));
    await createAutomationEnrollmentService({
      db: recording.db,
      clock,
      jobs: new RecordingJobQueue(),
      signer,
    }).startEnrollment(memberCtx(ENROLLER), {
      automationId: AUTOMATION,
      audience: { kind: 'contacts', filter: {} },
      inputs: { patient: 'Asha' },
      expectedCount: 3,
    });
    const inserted = recording.steps.find(
      (st) => st.op === 'insert' && st.table === 'automation_enrollments',
    );
    expect(inserted?.values?.nextBatchAt).toEqual(NOW);
  });
});

describe('pacing per enrolment and the sweep’s cap (ADR-401 second review)', () => {
  const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
  const progressOf = (steps: Step[]) =>
    steps.find(
      (st) =>
        st.op === 'update' &&
        st.table === 'automation_enrollments' &&
        st.set?.cursorPosition !== undefined,
    )?.set;

  it('runs a batch only once its enrolment’s next batch is due, within a second', () => {
    expect(enrollmentBatchDue(null, NOW)).toBe(true);
    expect(enrollmentBatchDue(NOW, NOW)).toBe(true);
    expect(enrollmentBatchDue(new Date(NOW.getTime() + 1_000), NOW)).toBe(true);
    expect(enrollmentBatchDue(new Date(NOW.getTime() + 1_001), NOW)).toBe(false);
    expect(enrollmentBatchDue(minutes(-30), NOW)).toBe(true);
  });

  it('does nothing when a second chain’s job arrives before the next batch is due', async () => {
    const early = await batchOf({ contacts: [{ n: 1 }, { n: 2 }], nextBatchAt: minutes(5) });
    expect(early.result).toEqual({ outcome: 'not_due', nextBatchAt: minutes(5) });
    expect(writes(early.steps)).toEqual([]);
    expect(early.jobs).toEqual([]);
    // Due (or overdue): the batch runs and the sweep's count starts again.
    const due = await batchOf({
      contacts: [{ n: 1 }, { n: 2 }],
      nextBatchAt: minutes(-20),
      resignalCount: 2,
    });
    expect(due.result).toMatchObject({ outcome: 'finished', started: 2 });
    expect(progressOf(due.steps)).toMatchObject({ resignalCount: 0 });
  });

  it('ends an enrolment as failed only through the sweep’s cap', () => {
    expect(enrollmentEndStatus(null)).toBe('completed');
    expect(enrollmentEndStatus('stopped_by_member')).toBe('stopped');
    expect(enrollmentEndStatus('stalled')).toBe('failed');
    expect([0, 1, 2, 3].map(enrollmentSweepAction)).toEqual(['signal', 'signal', 'signal', 'fail']);
  });

  const due = (over: Partial<{ cursorPosition: number }> = {}) => ({
    tenantId: TENANT,
    enrollmentId: ENROLLMENT,
    actorUserId: USER,
    cursorPosition: 50,
    ...over,
  });
  const contacts = Array.from({ length: 60 }, (_, i) => ({ n: i + 1 }));

  it('signals an overdue enrolment again, counting the signal and making it due now', async () => {
    const recording = recordingDb(
      scenarioAnswers({ contacts, cursor: 50, nextBatchAt: minutes(-11), resignalCount: 1 }),
    );
    const jobs = new RecordingJobQueue();
    expect(await resignalEnrollment({ db: recording.db, jobs, signer, clock }, due())).toBe(
      'signalled',
    );
    expect(recording.steps[0]).toMatchObject({ table: 'automation_enrollments', lock: 'update' });
    expect(
      recording.steps.find((st) => st.op === 'update' && st.table === 'automation_enrollments')
        ?.set,
    ).toEqual({ resignalCount: 2, nextBatchAt: NOW });
    expect(
      jobs.jobs.map((j) => [
        j.queue,
        j.envelope.tenantId,
        j.envelope.ref,
        j.envelope.actorUserId,
        j.options.singletonKey,
        j.options.startAfter,
      ]),
    ).toEqual([
      [QUEUES.automationEnroll.name, TENANT, ENROLLMENT, USER, `${ENROLLMENT}:50`, undefined],
    ]);
  });

  it('ends it as failed after three signals with no batch handled, audited once, runs untouched', async () => {
    const recording = recordingDb(
      scenarioAnswers({ contacts, cursor: 50, nextBatchAt: minutes(-11), resignalCount: 3 }),
    );
    const jobs = new RecordingJobQueue();
    expect(await resignalEnrollment({ db: recording.db, jobs, signer, clock }, due())).toBe(
      'failed',
    );
    expect(writes(recording.steps)).toEqual([
      'update automation_enrollment_contacts',
      'update automation_enrollments',
      'insert audit_events',
    ]);
    expect(endOf(recording.steps)).toMatchObject({
      status: 'failed',
      endReason: 'stalled',
      inputs: {},
      nextBatchAt: null,
    });
    const audit = recording.steps.find((st) => st.op === 'insert' && st.table === 'audit_events');
    expect(audit?.values).toMatchObject({
      action: 'automation.enrollment_ended',
      actorType: 'system',
      metadata: { status: 'failed', reason: 'stalled' },
    });
    expect(jobs.jobs).toEqual([]);
  });

  it('leaves an enrolment that moved on, is no longer overdue or has ended', async () => {
    for (const [scenario, over] of [
      [{ contacts, cursor: 100, nextBatchAt: minutes(-11) }, {}],
      [{ contacts, cursor: 50, nextBatchAt: minutes(-9) }, {}],
      [{ contacts, cursor: 50, nextBatchAt: minutes(-11), status: 'stopped' as const }, {}],
      [{ contacts, cursor: 50, nextBatchAt: minutes(-11), missing: true }, {}],
    ] as const) {
      const recording = recordingDb(scenarioAnswers(scenario));
      const jobs = new RecordingJobQueue();
      expect(
        await resignalEnrollment({ db: recording.db, jobs, signer, clock }, due(over)),
        JSON.stringify(scenario),
      ).toBe('skipped');
      expect(writes(recording.steps)).toEqual([]);
      expect(jobs.jobs).toEqual([]);
    }
  });

  it('handles each enrolment of the due list on its own and returns the errors', async () => {
    const other = '0192a1b2-0000-7000-8000-0000000000e9';
    const base = scenarioAnswers({ contacts, cursor: 50, nextBatchAt: minutes(-11) });
    const recording = recordingDb((step) => {
      if (step.op === 'execute' && step.sql?.includes('ops.automation_enrollments_due')) {
        return {
          rows: [
            {
              tenant_id: TENANT,
              enrollment_id: other,
              actor_user_id: 'user-2',
              cursor_position: 50,
            },
            {
              tenant_id: TENANT,
              enrollment_id: ENROLLMENT,
              actor_user_id: USER,
              cursor_position: 50,
            },
          ],
        };
      }
      if (
        step.op === 'select' &&
        step.table === 'automation_enrollments' &&
        step.params.includes(other)
      ) {
        throw new Error('connection lost');
      }
      return base(step);
    });
    expect(await findDueEnrollments(recording.db, 7)).toHaveLength(2);
    expect(recording.steps[0]?.params).toEqual([7]);
    const jobs = new RecordingJobQueue();
    const result = await signalDueEnrollments({ db: recording.db, jobs, signer, clock });
    expect(result).toMatchObject({ signalled: 1, failed: 0, skipped: 0 });
    expect(result.errors.map((e) => [e.enrollmentId, (e.error as Error).message])).toEqual([
      [other, 'connection lost'],
    ]);
    expect(jobs.jobs.map((j) => j.options.singletonKey)).toEqual([`${ENROLLMENT}:50`]);
  });

  it('defers a suspended company’s enrolment: its next batch is due at the deferred time', async () => {
    const at = minutes(5);
    const recording = recordingDb(
      scenarioAnswers({ contacts, cursor: 50, nextBatchAt: minutes(-1) }),
    );
    const jobs = new RecordingJobQueue();
    expect(await deferEnrollment({ db: recording.db, jobs, signer }, scope, ENROLLMENT, at)).toBe(
      true,
    );
    expect(
      recording.steps.find((st) => st.op === 'update' && st.table === 'automation_enrollments')
        ?.set,
    ).toEqual({ nextBatchAt: at });
    expect(
      jobs.jobs.map((j) => [j.envelope.actorUserId, j.options.singletonKey, j.options.startAfter]),
    ).toEqual([[USER, `${ENROLLMENT}:50:deferred:${at.getTime()}`, at]]);
    // The deferred chain and the sweep's: whichever job comes before that time does nothing.
    const early = await batchOf({ contacts, cursor: 50, nextBatchAt: at });
    expect(early.result).toMatchObject({ outcome: 'not_due' });
    const ended = recordingDb(scenarioAnswers({ contacts, status: 'completed' }));
    expect(
      await deferEnrollment(
        { db: ended.db, jobs: new RecordingJobQueue(), signer },
        scope,
        ENROLLMENT,
        at,
      ),
    ).toBe(false);
    expect(writes(ended.steps)).toEqual([]);
  });

  it('shows an enrolment as without progress since its last contact, except while the company is suspended', async () => {
    const lastAt = new Date(NOW.getTime() - 30 * 60_000);
    const view = async (status: 'active' | 'suspended', over: Record<string, unknown>) => {
      const row = {
        id: ENROLLMENT,
        tenantId: TENANT,
        automationId: AUTOMATION,
        source: 'contacts',
        segmentId: null,
        inputs: {},
        status: 'running',
        endReason: null,
        total: 60,
        startedCount: 50,
        refusedCount: 0,
        cancelledCount: 0,
        cursorPosition: 50,
        nextBatchAt: minutes(-11),
        resignalCount: 0,
        createdByMembershipId: MEMBER,
        createdByUserId: USER,
        stoppedByMembershipId: null,
        createdAt: minutes(-60),
        updatedAt: NOW,
        endedAt: null,
        ...over,
      };
      const recording = recordingDb((step) => {
        if (step.table === 'automation_enrollments') {
          return [{ e: row, automationName: 'Follow-up', segmentName: null }];
        }
        if (step.table === 'memberships') return [{ id: MEMBER, name: 'Owner' }];
        if (step.table === 'automation_enrollment_contacts') {
          return step.fields.includes('at') ? [{ at: lastAt }] : [];
        }
        throw new Error(`an unexpected read of ${step.table}`);
      });
      const ctx = {
        ...memberCtx(ENROLLER),
        tenant: { id: TENANT, status, slug: 'acme', timezone: 'Asia/Kolkata' },
      } as unknown as TenantContext;
      return (
        await createAutomationEnrollmentService({
          db: recording.db,
          clock,
          jobs: new RecordingJobQueue(),
          signer,
        }).getEnrollment(ctx, ENROLLMENT)
      ).stalledSince;
    };
    expect(await view('active', {})).toEqual(lastAt);
    expect(await view('suspended', {})).toBeNull();
    // Signalled again since its last batch: still without progress, though not overdue now.
    expect(await view('active', { nextBatchAt: NOW, resignalCount: 1 })).toEqual(lastAt);
    expect(await view('active', { nextBatchAt: minutes(-5) })).toBeNull();
    expect(await view('active', { status: 'completed', nextBatchAt: null })).toBeNull();
  });
});
