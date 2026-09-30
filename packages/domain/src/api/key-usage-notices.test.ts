import { describe, expect, it } from 'vitest';
import { emailPayloadSchema, renderEmail } from '../email/templates';
import { apiKeyUsageNotice } from './key-usage-notices';

const key = {
  name: 'Partner feed',
  keyPrefix: 'w360_aaaabbbbcccc',
  used: 8_000,
  limit: 10_000,
  periodEnd: new Date('2026-10-15T09:00:00Z'),
};

describe("the emails about a key's own monthly limit (ADR-098)", () => {
  it('warns with the requests used, the limit and the end of the period in the company’s time zone', () => {
    expect(apiKeyUsageNotice('warning', key, 'Asia/Kolkata')).toEqual({
      subject: 'API key “Partner feed” has used 8,000 of its 10,000 requests this month',
      lines: [
        'The API key “Partner feed” (w360_aaaabbbbcccc_…) has made 8,000 of the 10,000 requests its monthly limit allows in the period that ends on 15 October 2026 at 14:30 GMT+5:30.',
        'Once they are used up, the API refuses its requests until then.',
        "Owners and administrators can raise or remove the key's limit in Settings → API keys; the company's other keys are not affected.",
      ],
    });
    expect(apiKeyUsageNotice('warning', key, 'Europe/London').lines[0]).toContain(
      'ends on 15 October 2026 at 10:00 BST.',
    );
  });

  it('tells when the limit is reached, with the refusal and when requests are accepted again', () => {
    expect(apiKeyUsageNotice('reached', { ...key, used: 10_000 }, 'Asia/Kolkata')).toEqual({
      subject: 'API key “Partner feed” has used all 10,000 of its requests this month',
      lines: [
        'The API key “Partner feed” (w360_aaaabbbbcccc_…) has made all 10,000 requests its monthly limit allows. The API refuses its requests (429, reason key_quota_exceeded) until the period ends on 15 October 2026 at 14:30 GMT+5:30.',
        "Owners and administrators can raise or remove the key's limit in Settings → API keys; the company's other keys are not affected.",
      ],
    });
  });

  it('keeps the subject on one line whatever the name holds', () => {
    const notice = apiKeyUsageNotice(
      'reached',
      { ...key, name: '  Partner\r\nBcc: someone@example.test\tfeed ' },
      'Asia/Kolkata',
    );
    expect(notice.subject).toBe(
      'API key “Partner Bcc: someone@example.test feed” has used all 10,000 of its requests this month',
    );
    expect(notice.subject).not.toMatch(/[\r\n\t]/);
  });

  it('renders as a company notice linking Settings → API keys, with the name escaped', () => {
    const notice = apiKeyUsageNotice('warning', { ...key, name: '<Partner> & feed' }, 'UTC');
    const url = 'https://app.example.test/c/acme/settings/api-keys';
    const payload = {
      kind: 'tenant.notice' as const,
      companyName: 'Acme',
      subject: notice.subject,
      lines: notice.lines,
      url,
      actionLabel: 'Open API keys',
    };
    expect(emailPayloadSchema.safeParse(payload).success).toBe(true);
    const email = renderEmail(payload);
    expect(email.subject).toBe(
      'API key “<Partner> & feed” has used 8,000 of its 10,000 requests this month · Acme',
    );
    expect(email.html).toContain('The API key “&lt;Partner&gt; &amp; feed”');
    expect(email.html).not.toContain('<Partner>');
    expect(email.html).toContain(`href="${url}"`);
  });
});
