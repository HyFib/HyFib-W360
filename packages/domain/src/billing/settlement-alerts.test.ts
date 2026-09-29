import { describe, expect, it } from 'vitest';
import { renderEmail } from '../email/templates';
import {
  settlementReconAlert,
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
