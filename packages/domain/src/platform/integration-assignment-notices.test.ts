import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database, SQL } from '@w360/db';
import { emailPayloadSchema } from '../email/templates';
import {
  assignmentNotice,
  noticeIntegrationAssignments,
  type AssignmentNoticeRow,
} from './integration-assignment-notices';
import { INTEGRATION_SOURCE_LABELS, INTEGRATION_STATE_LABELS } from './ops-model';

const BASE = 'https://app.w360.test';
const ASHA = { assignedByUserId: 'user-asha', assignedByName: 'Asha Rao' };

describe('the email telling an administrator of failures assigned to them (ADR-314)', () => {
  it('names who assigned one failure and its kind, and links the Integrations tab', () => {
    const notice = assignmentNotice([{ ...ASHA, source: 'store', state: 'sync_error' }], BASE);
    expect(notice).toEqual({
      subject: 'A failing integration was assigned to you',
      lines: [
        'Asha Rao assigned you a failing integration on the operations console.',
        'By kind: Store, sync error 1.',
        'This email gives counts only: the companies and errors are on the operations console. Failures you assign to yourself are not emailed.',
      ],
      url: `${BASE}/platform/ops/integrations`,
      actionLabel: 'Open integrations',
    });
    expect(() => emailPayloadSchema.parse({ kind: 'platform.notice', ...notice })).not.toThrow();
  });

  it('counts several failures by the console’s kinds, the most first, and names their one assigner', () => {
    const notice = assignmentNotice(
      [
        { ...ASHA, source: 'whatsapp_number', state: 'needs_reconnect' },
        { ...ASHA, source: 'webhook_endpoint', state: 'failing' },
        { ...ASHA, source: 'store', state: 'failed' },
        { ...ASHA, source: 'webhook_endpoint', state: 'failing' },
      ],
      BASE,
    );
    expect(notice.subject).toBe('4 failing integrations were assigned to you');
    expect(notice.lines.slice(0, 2)).toEqual([
      'Asha Rao assigned you 4 failing integrations on the operations console.',
      'By kind: Webhook endpoint, failing 2; Store, failed 1; WhatsApp number, needs reconnecting 1.',
    ]);
  });

  it('counts the administrators who assigned them by account, so two of one name are two', () => {
    const notice = assignmentNotice(
      [
        { ...ASHA, source: 'store', state: 'failed' },
        {
          assignedByUserId: 'user-asha-2',
          assignedByName: 'Asha Rao',
          source: 'store',
          state: 'failed',
        },
        { ...ASHA, source: 'store', state: 'failed' },
      ],
      BASE,
    );
    expect(notice.lines.slice(0, 2)).toEqual([
      '2 administrators assigned you 3 failing integrations on the operations console.',
      'By kind: Store, failed 3.',
    ]);
  });

  it('names six kinds at most and counts the rest, so the longest name and every kind fit a notice', () => {
    // Every source and state the console's list produces; kind i is assigned i + 1 times.
    const kinds: [string, string][] = [
      ['whatsapp_number', 'needs_reconnect'],
      ['whatsapp_number', 'failed'],
      ['whatsapp_account', 'needs_reconnect'],
      ['whatsapp_access_check', 'not_checked'],
      ['whatsapp_webhooks', 'not_subscribed'],
      ['whatsapp_webhooks', 'not_checked'],
      ['store', 'failed'],
      ['store', 'sync_error'],
      ['store', 'webhook_error'],
      ['payment_account', 'failed'],
      ['catalog_sync', 'failed'],
      ['flow_sync', 'failed'],
      ['webhook_endpoint', 'failing'],
      ['webhook_endpoint', 'disabled'],
    ];
    for (const [source, state] of kinds) {
      expect(INTEGRATION_SOURCE_LABELS[source]).toBeDefined();
      expect(INTEGRATION_STATE_LABELS[state]).toBeDefined();
    }
    // The longest name an account may have.
    const by = { assignedByUserId: 'user-long', assignedByName: 'N'.repeat(200) };
    const rows = kinds.flatMap(([source, state], i) =>
      Array.from({ length: i + 1 }, () => ({ ...by, source, state })),
    );
    const notice = assignmentNotice(rows, BASE);
    expect(notice.subject).toBe('105 failing integrations were assigned to you');
    expect(notice.lines[0]).toBe(
      `${'N'.repeat(200)} assigned you 105 failing integrations on the operations console.`,
    );
    // The six most (indexes 13 down to 8), then the other eight counted: 1 + 2 + … + 8 = 36.
    expect(notice.lines[1]).toBe(
      'By kind: Webhook endpoint, turned off for failing 14; Webhook endpoint, failing 13; Flow sync, failed 12; Catalog sync, failed 11; Payment account, failed 10; Store, webhook error 9 and 36 more.',
    );
    expect(() => emailPayloadSchema.parse({ kind: 'platform.notice', ...notice })).not.toThrow();
  });
});

/** The sweep over a database that answers the claim with `claimed` and records the emails queued. */
function sweepWith(claimed: AssignmentNoticeRow[]) {
  const runs: { scope: unknown; statements: string[] }[] = [];
  const emails: { to: string; tenantId: string | null; payload: unknown }[] = [];
  const db = {
    run: async (scope: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      const statements: string[] = [];
      runs.push({ scope, statements });
      return fn({
        execute: async (query: SQL) => {
          statements.push(new PgDialect().sqlToQuery(query).sql.replace(/\s+/g, ' '));
          return {
            rows: claimed.map((r) => ({
              assignee_user_id: r.assigneeUserId,
              email: r.email,
              assigned_by_user_id: r.assignedByUserId,
              assigned_by_name: r.assignedByName,
              source: r.source,
              state: r.state,
            })),
          };
        },
        insert: () => ({
          values: async (v: {
            toAddress: string;
            tenantId: string | null;
            payloadCiphertext: string;
          }) => {
            emails.push({
              to: v.toAddress,
              tenantId: v.tenantId,
              payload: JSON.parse(v.payloadCiphertext),
            });
          },
        }),
      });
    },
  } as unknown as Database;
  const outbox = {
    // Leaves the payload readable: the outbox's encryption is tested with the real keyring.
    keyring: { encrypt: (plain: string) => plain },
    jobs: { enqueue: async () => undefined },
    signer: { sign: (envelope: unknown) => envelope },
  } as never;
  return {
    sweep: () => noticeIntegrationAssignments({ db, outbox, appBaseUrl: BASE }),
    runs,
    emails,
  };
}

/** The claim, in one transaction of the system scope with the emails it queues. */
const CLAIM = [
  {
    scope: { kind: 'system' },
    statements: [
      'select assignee_user_id, email, assigned_by_user_id, assigned_by_name, source, state from ops.claim_integration_assignment_notices()',
    ],
  },
];

describe('the sweep’s assignment notices (ADR-314)', () => {
  it('queues one email to each assignee for the failures claimed for them, with no company', async () => {
    const mei = { assigneeUserId: 'user-mei', email: 'mei@hyfib.test' };
    const ravi = { assigneeUserId: 'user-ravi', email: 'ravi@hyfib.test' };
    const kiran = { assignedByUserId: 'user-kiran', assignedByName: 'Kiran Das' };
    const { sweep, runs, emails } = sweepWith([
      { ...mei, ...ASHA, source: 'store', state: 'failed' },
      { ...mei, ...kiran, source: 'webhook_endpoint', state: 'failing' },
      { ...ravi, ...ASHA, source: 'store', state: 'failed' },
    ]);
    expect(await sweep()).toEqual({ told: 3, recipients: 2 });
    expect(runs).toEqual(CLAIM);
    expect(emails).toEqual([
      {
        to: 'mei@hyfib.test',
        tenantId: null,
        payload: {
          kind: 'platform.notice',
          ...assignmentNotice(
            [
              { ...ASHA, source: 'store', state: 'failed' },
              { ...kiran, source: 'webhook_endpoint', state: 'failing' },
            ],
            BASE,
          ),
        },
      },
      {
        to: 'ravi@hyfib.test',
        tenantId: null,
        payload: {
          kind: 'platform.notice',
          ...assignmentNotice([{ ...ASHA, source: 'store', state: 'failed' }], BASE),
        },
      },
    ]);
    expect(emails.map((e) => (e.payload as { lines: string[] }).lines.slice(0, 2))).toEqual([
      [
        '2 administrators assigned you 2 failing integrations on the operations console.',
        'By kind: Store, failed 1; Webhook endpoint, failing 1.',
      ],
      [
        'Asha Rao assigned you a failing integration on the operations console.',
        'By kind: Store, failed 1.',
      ],
    ]);
  });

  it('queues nothing when nothing was claimed', async () => {
    const { sweep, runs, emails } = sweepWith([]);
    expect(await sweep()).toEqual({ told: 0, recipients: 0 });
    expect(runs).toEqual(CLAIM);
    expect(emails).toEqual([]);
  });
});
