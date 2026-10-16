import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Keyring } from '@w360/core';
import type { Database, SQL } from '@w360/db';
import { outboxAad } from '../email/outbox';
import { renderEmail } from '../email/templates';
import { alertPostBody, alertPostPlain } from '../platform/alert-channel';
import {
  alertSettlementReconFindings,
  alertUnsettledPayments,
  settlementReconAlert,
  settlementReconPost,
  unsettledPaymentsAlert,
  type SettlementReconAlertDay,
} from './settlement-alerts';

const BASE = 'https://app.example.test';
const CLOSING =
  'Platform owners resolve each transaction with a note, or run a failed day again, on Platform → Reconciliation.';

const waiting = (
  date: string,
  counts: Partial<Pick<SettlementReconAlertDay, 'openMismatch' | 'openReview' | 'openNotHyfib'>>,
): SettlementReconAlertDay => ({
  date,
  status: 'completed',
  lastError: null,
  openMismatch: 0,
  openReview: 0,
  openNotHyfib: 0,
  ...counts,
});

describe('the reconciliation alert (ADR-066)', () => {
  it('names one day that needs a person, with its open transactions by status and its page', () => {
    expect(settlementReconAlert([waiting('2026-09-27', { openNotHyfib: 1 })], BASE)).toEqual({
      subject: 'Settlement reconciliation for 27 Sept 2026 needs a person',
      lines: ['27 Sept 2026: 1 transaction waits for a person (1 is not HyFib’s).', CLOSING],
      url: `${BASE}/platform/reconciliation/2026-09-27`,
      actionLabel: 'Open reconciliation',
    });
    expect(
      settlementReconAlert(
        [waiting('2026-09-27', { openMismatch: 2, openReview: 1, openNotHyfib: 3 })],
        BASE,
      ).lines[0],
    ).toBe(
      '27 Sept 2026: 6 transactions wait for a person (2 do not match HyFib’s records, 1 needs a look, 3 are not HyFib’s).',
    );
    expect(
      settlementReconAlert([waiting('2026-09-27', { openMismatch: 1, openReview: 2 })], BASE)
        .lines[0],
    ).toBe(
      '27 Sept 2026: 3 transactions wait for a person (1 does not match HyFib’s records, 2 need a look).',
    );
  });

  it('says a day failed with its last error, cut to 400 characters', () => {
    const alert = settlementReconAlert(
      [
        {
          ...waiting('2026-09-26', {}),
          status: 'failed',
          lastError:
            "Razorpay refused HyFib's API keys (HTTP 401): The api key provided is invalid",
        },
      ],
      BASE,
    );
    expect(alert.subject).toBe('Settlement reconciliation for 26 Sept 2026 failed');
    expect(alert.lines[0]).toBe(
      "26 Sept 2026: the check failed and waits for a platform owner to run the day again. The last error: Razorpay refused HyFib's API keys (HTTP 401): The api key provided is invalid",
    );
    const long = settlementReconAlert(
      [{ ...waiting('2026-09-26', {}), status: 'failed', lastError: 'x'.repeat(500) }],
      BASE,
    );
    expect(long.lines[0]).toMatch(/The last error: x{400}$/);
    const none = settlementReconAlert(
      [{ ...waiting('2026-09-26', {}), status: 'failed', lastError: null }],
      BASE,
    );
    expect(none.lines[0]).toBe(
      '26 Sept 2026: the check failed and waits for a platform owner to run the day again.',
    );
  });

  it('lists several days, oldest first as given, and links the reconciliation page', () => {
    const alert = settlementReconAlert(
      [
        { ...waiting('2026-09-25', {}), status: 'failed', lastError: 'Busy' },
        waiting('2026-09-26', { openReview: 1 }),
      ],
      BASE,
    );
    expect(alert).toEqual({
      subject: 'Settlement reconciliation needs a person for 2 days',
      lines: [
        '25 Sept 2026: the check failed and waits for a platform owner to run the day again. The last error: Busy',
        '26 Sept 2026: 1 transaction waits for a person (1 needs a look).',
        CLOSING,
      ],
      url: `${BASE}/platform/reconciliation`,
      actionLabel: 'Open reconciliation',
    });
  });

  it('posts the email’s text to the chat channel without a failed check’s error (ADR-340)', () => {
    const days: SettlementReconAlertDay[] = [
      {
        ...waiting('2026-09-25', {}),
        status: 'failed',
        lastError: "Razorpay refused HyFib's API keys (HTTP 401)",
      },
      waiting('2026-09-26', { openReview: 1 }),
    ];
    expect(settlementReconPost(days, BASE)).toEqual({
      ...settlementReconAlert(days, BASE),
      lines: [
        '25 Sept 2026: the check failed and waits for a platform owner to run the day again.',
        '26 Sept 2026: 1 transaction waits for a person (1 needs a look).',
        CLOSING,
      ],
    });
    // The days are left as they were, for the email.
    expect(days[0]?.lastError).toContain('HTTP 401');
  });

  it('renders as a platform notice with the link in the text and a button', () => {
    const alert = settlementReconAlert([waiting('2026-09-27', { openReview: 1 })], BASE);
    const email = renderEmail({ kind: 'platform.notice', ...alert });
    expect(email.subject).toBe(
      'Settlement reconciliation for 27 Sept 2026 needs a person · HyFib W360 platform',
    );
    expect(email.text).toBe(`${alert.lines.join('\n\n')}\n\n${alert.url}`);
    expect(email.html).toContain(`href="${alert.url}"`);
    expect(email.html).toContain('>Open reconciliation</a>');
    expect(email.html).toContain('1 transaction waits for a person (1 needs a look).');
  });
});

describe('the unsettled payments alert (ADR-071)', () => {
  const ADVICE =
    'Razorpay may be holding a payment, it may have been refunded or disputed in the Razorpay Dashboard, or HyFib’s records may be wrong: check each payment in the Razorpay Dashboard.';
  const WHERE =
    'Platform → Reconciliation lists them under “Payments not seen in a settlement”, with their companies, amounts and Razorpay payment ids.';

  it('names one payment’s day in India time and links the reconciliation page', () => {
    // 20:00 UTC on 20 September is 01:30 on 21 September in India.
    expect(unsettledPaymentsAlert([new Date('2026-09-20T20:00:00Z')], BASE)).toEqual({
      subject: 'A paid top-up was not settled within 7 days',
      lines: [
        'A top-up paid on 21 Sept 2026 (India time) was in no settlement Razorpay reported for the 7 days after payment, although every one of those days was reconciled.',
        ADVICE,
        WHERE,
      ],
      url: `${BASE}/platform/reconciliation`,
      actionLabel: 'Open reconciliation',
    });
  });

  it('counts several payments and gives the range of their days, whatever the order given', () => {
    const alert = unsettledPaymentsAlert(
      [
        new Date('2026-09-18T05:00:00Z'),
        new Date('2026-09-12T05:00:00Z'),
        new Date('2026-09-15T05:00:00Z'),
      ],
      BASE,
    );
    expect(alert.subject).toBe('3 paid top-ups were not settled within 7 days');
    expect(alert.lines[0]).toBe(
      '3 top-ups paid from 12 Sept 2026 to 18 Sept 2026 (India time) were in no settlement Razorpay reported for the 7 days after payment, although every one of those days was reconciled.',
    );
    // Two payments on the same day in India give one day.
    expect(
      unsettledPaymentsAlert(
        [new Date('2026-09-12T19:00:00Z'), new Date('2026-09-13T03:00:00Z')],
        BASE,
      ).lines[0],
    ).toBe(
      '2 top-ups paid on 13 Sept 2026 (India time) were in no settlement Razorpay reported for the 7 days after payment, although every one of those days was reconciled.',
    );
  });

  it('renders as a platform notice without companies, amounts or payment ids', () => {
    const alert = unsettledPaymentsAlert([new Date('2026-09-20T05:00:00Z')], BASE);
    const email = renderEmail({ kind: 'platform.notice', ...alert });
    expect(email.subject).toBe('A paid top-up was not settled within 7 days · HyFib W360 platform');
    expect(email.text).toBe(`${alert.lines.join('\n\n')}\n\n${BASE}/platform/reconciliation`);
    expect(email.text).not.toMatch(/pay_|₹|INR/);
  });
});

/**
 * A database for the minute sweeps: each statement recorded and answered in turn, the emails'
 * inserts and the jobs they queue recorded too.
 */
function sweeping(answers: { rows: unknown[] }[]) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const emails: { toAddress: string; id: string; payloadCiphertext: string }[] = [];
  const jobs: unknown[][] = [];
  const keyring = new Keyring({ primaryKeyId: 'k1', keys: { k1: randomBytes(32) } });
  const tx = {
    execute: async (q: SQL) => {
      const built = new PgDialect().sqlToQuery(q);
      statements.push({ sql: built.sql.replace(/\s+/g, ' ').trim(), params: built.params });
      const next = answers.shift();
      if (!next) throw new Error(`unexpected statement: ${built.sql}`);
      return next;
    },
    insert: () => ({
      values: async (values: { toAddress: string; id: string; payloadCiphertext: string }) => {
        emails.push(values);
      },
    }),
  };
  const db = {
    run: async (_scope: unknown, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Database;
  const outbox = {
    keyring,
    jobs: {
      enqueue: async (...args: unknown[]) => {
        jobs.push(args);
        return 'job-1';
      },
    },
    signer: { sign: (envelope: unknown) => envelope },
  } as never;
  const payload = (email: { id: string; payloadCiphertext: string }) =>
    JSON.parse(keyring.decryptString(email.payloadCiphertext, outboxAad(email.id))) as {
      lines: string[];
    };
  return { db, outbox, statements, emails, jobs, payload };
}

const RECIPIENTS = {
  rows: [
    { user_id: 'u-1', email: 'owner-1@example.test' },
    { user_id: 'u-2', email: 'owner-2@example.test' },
  ],
};

describe('the financial alerts’ posts (ADR-340)', () => {
  it('posts the reconciliation alert after its emails, as the chat channel’s kind and without the error', async () => {
    const failed = {
      settlement_date: '2026-09-25',
      status: 'failed',
      last_error: "Razorpay refused HyFib's API keys (HTTP 401)",
      open_mismatch: 0,
      open_review: 0,
      open_not_hyfib: 0,
    };
    const { db, outbox, statements, emails, payload } = sweeping([
      { rows: [{ run_id: 'run-1', attempt: 2 }] },
      RECIPIENTS,
      { rows: [failed] },
      { rows: [{ queued: true }] },
    ]);
    expect(await alertSettlementReconFindings({ db, outbox, appBaseUrl: BASE })).toEqual({
      alerted: 1,
      unsent: 0,
      recipients: 2,
      posted: true,
    });
    expect(emails.map((e) => e.toAddress)).toEqual([
      'owner-1@example.test',
      'owner-2@example.test',
    ]);
    // The email keeps the error; the post leaves it out.
    expect(payload(emails[0]!).lines[0]).toContain('The last error: Razorpay refused');
    const day: SettlementReconAlertDay = {
      date: '2026-09-25',
      status: 'failed',
      lastError: failed.last_error,
      openMismatch: 0,
      openReview: 0,
      openNotHyfib: 0,
    };
    expect(statements.at(-1)).toEqual({
      sql: 'select ops.queue_platform_alert_post($1, $2, $3) as queued',
      params: [
        'reconciliation',
        alertPostBody(settlementReconPost([day], BASE)),
        alertPostPlain(settlementReconPost([day], BASE)),
      ],
    });
    expect(String(statements.at(-1)?.params[1])).not.toContain('Razorpay refused');
    expect(String(statements.at(-1)?.params[2])).not.toContain('Razorpay refused');
  });

  it('posts the unsettled payments alert after its emails with the emails’ text', async () => {
    const paidAt = '2026-09-20T05:00:00Z';
    const { db, outbox, statements, emails, payload } = sweeping([
      { rows: [{ payment_id: 'pay_1' }] },
      RECIPIENTS,
      { rows: [{ payment_id: 'pay_1', paid_at: paidAt }] },
      { rows: [{ queued: false }] },
    ]);
    expect(await alertUnsettledPayments({ db, outbox, appBaseUrl: BASE })).toEqual({
      alerted: 1,
      unsent: 0,
      recipients: 2,
      posted: false,
    });
    expect(emails).toHaveLength(2);
    const alert = unsettledPaymentsAlert([new Date(paidAt)], BASE);
    expect(payload(emails[1]!).lines).toEqual(alert.lines);
    expect(statements.at(-1)).toEqual({
      sql: 'select ops.queue_platform_alert_post($1, $2, $3) as queued',
      params: ['unsettled', alertPostBody(alert), alertPostPlain(alert)],
    });
  });

  it('posts nothing while there is no platform owner to email', async () => {
    const recon = sweeping([{ rows: [{ run_id: 'run-1', attempt: 1 }] }, { rows: [] }]);
    expect(
      await alertSettlementReconFindings({ db: recon.db, outbox: recon.outbox, appBaseUrl: BASE }),
    ).toEqual({ alerted: 0, unsent: 1, recipients: 0, posted: false });
    expect(recon.statements).toHaveLength(2);
    const unsettled = sweeping([{ rows: [{ payment_id: 'pay_1' }] }, { rows: [] }]);
    expect(
      await alertUnsettledPayments({
        db: unsettled.db,
        outbox: unsettled.outbox,
        appBaseUrl: BASE,
      }),
    ).toEqual({ alerted: 0, unsent: 1, recipients: 0, posted: false });
    expect(unsettled.statements).toHaveLength(2);
  });
});
