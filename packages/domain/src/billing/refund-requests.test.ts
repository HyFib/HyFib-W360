import { describe, expect, it } from 'vitest';
import { renderEmail } from '../email/templates';
import { REFUND_REQUEST_LIMITS, refundRequestsAnnouncement } from './refund-requests';

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
