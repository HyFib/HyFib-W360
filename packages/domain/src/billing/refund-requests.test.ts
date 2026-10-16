import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Keyring } from '@w360/core';
import type { Database, SQL } from '@w360/db';
import { renderEmail } from '../email/templates';
import { alertPostBody, alertPostPlain } from '../platform/alert-channel';
import {
  REFUND_REQUEST_LIMITS,
  announceRefundRequests,
  refundRequestsAnnouncement,
} from './refund-requests';

const BASE = 'https://app.example.test';

describe('the refund request announcement to platform owners (ADR-073)', () => {
  it('counts the requests and links to Platform → Refunds, naming no company, amount or reason', () => {
    expect(refundRequestsAnnouncement(1, BASE)).toEqual({
      subject: 'A refund request is waiting for a decision',
      lines: [
        'A company asked HyFib to refund unused service credit from a paid top-up.',
        'A platform owner approves each request, which refunds it through Razorpay as a staff refund does, or declines it with a note the company reads.',
        'Platform → Refunds lists them with the companies, amounts and reasons.',
      ],
      url: `${BASE}/platform/refunds`,
      actionLabel: 'Open refunds',
    });
    const several = refundRequestsAnnouncement(3, BASE);
    expect(several.subject).toBe('3 refund requests are waiting for a decision');
    expect(several.lines[0]).toBe(
      'Companies asked HyFib 3 times to refund unused service credit from paid top-ups.',
    );
    expect(several.lines.slice(1)).toEqual(refundRequestsAnnouncement(1, BASE).lines.slice(1));
  });

  it('counts requests of plan payments apart, and links straight to them when they are all there is (ADR-104)', () => {
    const credit = refundRequestsAnnouncement(1, BASE);
    const plan = refundRequestsAnnouncement(0, BASE, 1);
    expect(plan).toEqual({
      subject: 'A refund request is waiting for a decision',
      lines: [
        'A company asked HyFib to refund a plan payment.',
        credit.lines[1],
        'Platform → Refunds → Plan payments lists them with the companies, amounts and reasons.',
      ],
      url: `${BASE}/platform/refunds?kind=plan`,
      actionLabel: 'Open refunds',
    });
    const plans = refundRequestsAnnouncement(0, BASE, 2);
    expect(plans.subject).toBe('2 refund requests are waiting for a decision');
    expect(plans.lines[0]).toBe('Companies asked HyFib 2 times to refund plan payments.');
    expect(plans.url).toBe(`${BASE}/platform/refunds?kind=plan`);
    const both = refundRequestsAnnouncement(2, BASE, 1);
    expect(both).toEqual({
      subject: '3 refund requests are waiting for a decision',
      lines: [
        'Companies asked HyFib 3 times for refunds: 2 of unused service credit and 1 of plan payments.',
        credit.lines[1],
        'Platform → Refunds lists them with the companies, amounts and reasons, under Service credit and Plan payments.',
      ],
      url: `${BASE}/platform/refunds`,
      actionLabel: 'Open refunds',
    });
    // Service credit alone reads as before plan payments could be refunded.
    expect(refundRequestsAnnouncement(3, BASE, 0)).toEqual(refundRequestsAnnouncement(3, BASE));
    for (const alert of [plan, plans, both]) {
      const email = renderEmail({ kind: 'platform.notice', ...alert });
      expect(email.text).not.toMatch(/₹|INR|inv_/);
      expect(email.html).toContain(`href="${alert.url}"`);
    }
  });

  it('renders as a platform notice with the link', () => {
    const alert = refundRequestsAnnouncement(2, BASE);
    const email = renderEmail({ kind: 'platform.notice', ...alert });
    expect(email.subject).toBe(
      '2 refund requests are waiting for a decision · HyFib W360 platform',
    );
    expect(email.text).toBe(`${alert.lines.join('\n\n')}\n\n${BASE}/platform/refunds`);
    expect(email.html).toContain(`href="${BASE}/platform/refunds"`);
    expect(email.html).toContain('>Open refunds</a>');
    expect(email.text).not.toMatch(/₹|INR/);
  });

  it('keeps the limits the database checks', () => {
    // The table's CHECK allows reasons of 10 to 1,000 characters after trimming (0046).
    expect(REFUND_REQUEST_LIMITS.reasonMin).toBe(10);
    expect(REFUND_REQUEST_LIMITS.reasonMax).toBe(1000);
    expect(REFUND_REQUEST_LIMITS.perDay).toBe(5);
  });
});

/** The sweep's database: each statement takes the next answer, in one transaction per run. */
function sweeping(answers: { rows: unknown[] }[]) {
  const statements: { tx: number; sql: string; params: unknown[] }[] = [];
  const emails: { toAddress: string; id: string; payloadCiphertext: string }[] = [];
  /** Each statement and email in turn. */
  const order: string[] = [];
  const keyring = new Keyring({ primaryKeyId: 'k1', keys: { k1: randomBytes(32) } });
  let transactions = 0;
  const db = {
    run: async (_scope: unknown, fn: (t: unknown) => Promise<unknown>) => {
      const tx = ++transactions;
      return fn({
        execute: async (q: SQL) => {
          const built = new PgDialect().sqlToQuery(q);
          statements.push({ tx, sql: built.sql.replace(/\s+/g, ' ').trim(), params: built.params });
          order.push(built.sql.includes('queue_platform_alert_post') ? 'post' : 'statement');
          const next = answers.shift();
          if (!next) throw new Error(`unexpected statement: ${built.sql}`);
          return next;
        },
        insert: () => ({
          values: async (values: { toAddress: string; id: string; payloadCiphertext: string }) => {
            emails.push(values);
            order.push('email');
          },
        }),
      });
    },
  } as unknown as Database;
  const outbox = {
    keyring,
    jobs: { enqueue: async () => 'job-1' },
    signer: { sign: (envelope: unknown) => envelope },
  } as never;
  return { db, outbox, statements, emails, order };
}

const OWNERS = {
  rows: [
    { user_id: 'u-1', email: 'owner-1@example.test' },
    { user_id: 'u-2', email: 'owner-2@example.test' },
  ],
};

describe('the refund requests’ post (ADR-345)', () => {
  it('posts the email’s text after the emails, in their transaction, as the channel’s kind', async () => {
    const { db, outbox, statements, emails, order } = sweeping([
      { rows: [{ request_id: 'c-1' }] },
      { rows: [{ request_id: 'p-1' }] },
      OWNERS,
      { rows: [{ request_id: 'c-1' }] },
      { rows: [{ request_id: 'p-1' }] },
      { rows: [{ queued: true }] },
    ]);
    expect(await announceRefundRequests({ db, outbox, appBaseUrl: BASE })).toEqual({
      announced: 2,
      unsent: 0,
      recipients: 2,
      posted: true,
    });
    expect(emails.map((e) => e.toAddress)).toEqual([
      'owner-1@example.test',
      'owner-2@example.test',
    ]);
    const marked = statements.filter((s) => s.sql.includes('mark_announced'));
    expect(statements.at(-1)).toEqual({
      tx: marked[0]!.tx,
      sql: 'select ops.queue_platform_alert_post($1, $2, $3) as queued',
      params: [
        'refund_requests',
        alertPostBody(refundRequestsAnnouncement(1, BASE, 1)),
        alertPostPlain(refundRequestsAnnouncement(1, BASE, 1)),
      ],
    });
    expect(marked.map((s) => s.tx)).toEqual([3, 3]);
    expect(order.slice(-3)).toEqual(['email', 'email', 'post']);
  });

  it('says it did not post when the channel does not get refund requests', async () => {
    const { db, outbox, statements } = sweeping([
      { rows: [{ request_id: 'c-1' }] },
      { rows: [] },
      OWNERS,
      { rows: [{ request_id: 'c-1' }] },
      { rows: [{ queued: false }] },
    ]);
    expect(await announceRefundRequests({ db, outbox, appBaseUrl: BASE })).toEqual({
      announced: 1,
      unsent: 0,
      recipients: 2,
      posted: false,
    });
    expect(statements.at(-1)?.params).toEqual([
      'refund_requests',
      alertPostBody(refundRequestsAnnouncement(1, BASE)),
      alertPostPlain(refundRequestsAnnouncement(1, BASE)),
    ]);
  });

  it('posts nothing while there is no platform owner to email, or nothing was marked', async () => {
    const ownerless = sweeping([{ rows: [{ request_id: 'c-1' }] }, { rows: [] }, { rows: [] }]);
    expect(
      await announceRefundRequests({
        db: ownerless.db,
        outbox: ownerless.outbox,
        appBaseUrl: BASE,
      }),
    ).toEqual({ announced: 0, unsent: 1, recipients: 0, posted: false });
    expect(ownerless.statements).toHaveLength(3);
    const raced = sweeping([{ rows: [{ request_id: 'c-1' }] }, { rows: [] }, OWNERS, { rows: [] }]);
    expect(
      await announceRefundRequests({ db: raced.db, outbox: raced.outbox, appBaseUrl: BASE }),
    ).toEqual({ announced: 0, unsent: 0, recipients: 2, posted: false });
    expect(raced.statements).toHaveLength(4);
    expect(raced.emails).toEqual([]);
  });
});
