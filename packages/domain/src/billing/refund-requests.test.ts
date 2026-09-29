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
