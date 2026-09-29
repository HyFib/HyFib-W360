import { describe, expect, it } from 'vitest';
import { renderEmail } from '../email/templates';
import { apiKeyReminderNotice } from './expiry-reminders';
import { API_KEY_REMINDER_DAYS, apiKeyExpiresSoon } from './model';

const DAY = 86_400_000;
const now = new Date('2026-09-29T09:00:00Z');

const key = {
  name: 'Orders sync',
  keyPrefix: 'w360_abcdefghijkl',
  expiresAt: new Date('2026-10-05T09:00:00Z'),
  createdAt: new Date('2026-07-07T04:30:00Z'),
  createdBy: 'Asha Rao',
  lastUsedAt: new Date('2026-09-28T05:32:00Z'),
};

describe('which keys expire soon (ADR-067)', () => {
  const usable = { revokedAt: null, replacedByKeyId: null };

  it('counts a usable key expiring within 7 days, up to the boundary', () => {
    expect(API_KEY_REMINDER_DAYS).toBe(7);
    const at = (ms: number) => ({ ...usable, expiresAt: new Date(now.getTime() + ms) });
    expect(apiKeyExpiresSoon(at(1), now)).toBe(true);
    expect(apiKeyExpiresSoon(at(3 * DAY), now)).toBe(true);
    expect(apiKeyExpiresSoon(at(7 * DAY), now)).toBe(true);
    expect(apiKeyExpiresSoon(at(7 * DAY + 1), now)).toBe(false);
    expect(apiKeyExpiresSoon(at(30 * DAY), now)).toBe(false);
  });

  it('leaves out keys that never expire, have expired, were revoked or were rotated', () => {
    const soon = new Date(now.getTime() + 2 * DAY);
    expect(apiKeyExpiresSoon({ ...usable, expiresAt: null }, now)).toBe(false);
    expect(apiKeyExpiresSoon({ ...usable, expiresAt: now }, now)).toBe(false);
    expect(apiKeyExpiresSoon({ ...usable, expiresAt: new Date(now.getTime() - DAY) }, now)).toBe(
      false,
    );
    expect(apiKeyExpiresSoon({ ...usable, expiresAt: soon, revokedAt: now }, now)).toBe(false);
    expect(apiKeyExpiresSoon({ ...usable, expiresAt: soon, replacedByKeyId: 'new-key' }, now)).toBe(
      false,
    );
  });
});

describe('the reminder before a key expires (ADR-067)', () => {
  it('names the key by its name and public prefix, with times in the company’s time zone', () => {
    expect(apiKeyReminderNotice(key, 'Asia/Kolkata')).toEqual({
      subject: 'API key “Orders sync” expires on 5 Oct 2026',
      lines: [
        'The API key “Orders sync” (w360_abcdefghijkl_…) expires on 5 October 2026 at 14:30 GMT+5:30. From then on the API refuses requests made with it.',
        'It was created by Asha Rao on 7 Jul 2026 and last used on 28 September 2026 at 11:02 GMT+5:30.',
        'To keep an integration working, rotate the key in Settings → API keys: the new key has the same name, scopes and expiry period, and the old key can keep working for up to 72 hours while you switch.',
        'If nothing uses the key any more, let it expire or revoke it.',
      ],
    });
    expect(apiKeyReminderNotice(key, 'Europe/London').lines[0]).toContain(
      'expires on 5 October 2026 at 10:00 BST.',
    );
  });

  it('says when a key has not been used, and leaves out an unknown creator', () => {
    const notice = apiKeyReminderNotice(
      { ...key, createdBy: null, lastUsedAt: null },
      'Asia/Kolkata',
    );
    expect(notice.lines[1]).toBe('It was created on 7 Jul 2026 and has not been used.');
  });

  it('keeps the subject on one line whatever the name holds', () => {
    const notice = apiKeyReminderNotice(
      { ...key, name: '  Orders\r\nBcc: someone@example.test\tsync ' },
      'Asia/Kolkata',
    );
    expect(notice.subject).toBe(
      'API key “Orders Bcc: someone@example.test sync” expires on 5 Oct 2026',
    );
    expect(notice.subject).not.toMatch(/[\r\n\t]/);
  });

  it('renders as a company notice linking Settings → API keys, with the name escaped', () => {
    const notice = apiKeyReminderNotice({ ...key, name: '<Orders> & sync' }, 'Asia/Kolkata');
    const url = 'https://app.example.test/c/acme/settings/api-keys';
    const email = renderEmail({
      kind: 'tenant.notice',
      companyName: 'Acme',
      subject: notice.subject,
      lines: notice.lines,
      url,
      actionLabel: 'Open API keys',
    });
    expect(email.subject).toBe('API key “<Orders> & sync” expires on 5 Oct 2026 · Acme');
    expect(email.text).toBe(`${notice.lines.join('\n\n')}\n\n${url}`);
    expect(email.html).toContain('The API key “&lt;Orders&gt; &amp; sync”');
    expect(email.html).not.toContain('<Orders>');
    expect(email.html).toContain(`href="${url}"`);
    expect(email.html).toContain('>Open API keys</a>');
  });
});
