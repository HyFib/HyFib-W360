import { describe, expect, it } from 'vitest';
import { emailPayloadSchema, renderEmail } from '../email/templates';
import {
  MENTION_EMAIL_DELAY_MS,
  MENTION_EMAIL_LATE_LIMIT_MS,
  mentionEmailNotice,
} from './mention-emails';

describe('the email to a member mentioned in a note who has not opened it (ADR-211)', () => {
  it('names who mentioned them, and leaves out the note and the customer', () => {
    expect(mentionEmailNotice({ authorName: 'Asha Rao', unread: 1 })).toEqual({
      subject: 'Asha Rao mentioned you in a note',
      lines: [
        'Asha Rao mentioned you in a note on a conversation in the inbox, and you have not opened the conversation since.',
        'Open the conversation to read the note; this email leaves out the note and the customer’s details.',
      ],
    });
  });

  it('says how many of their mentions in the conversation are unread', () => {
    expect(mentionEmailNotice({ authorName: 'Ravi Kumar', unread: 2 }).lines[1]).toBe(
      'You have 2 unread mentions in that conversation.',
    );
    expect(mentionEmailNotice({ authorName: 'Ravi Kumar', unread: 1_200 }).lines).toEqual([
      'Ravi Kumar mentioned you in a note on a conversation in the inbox, and you have not opened the conversation since.',
      'You have 1,200 unread mentions in that conversation.',
      'Open the conversation to read the note; this email leaves out the note and the customer’s details.',
    ]);
  });

  it('is due 10 minutes after the note and dropped once a day late', () => {
    expect(MENTION_EMAIL_DELAY_MS).toBe(600_000);
    expect(MENTION_EMAIL_LATE_LIMIT_MS).toBe(86_400_000);
  });

  it('fits the email’s limits with the longest name a member can have, escaped in the HTML', () => {
    const name = `<b>${'N'.repeat(193)}</b>`;
    expect(name).toHaveLength(200);
    const notice = mentionEmailNotice({ authorName: name, unread: 20 });
    expect(notice.subject).toBe(`<b>${'N'.repeat(117)} mentioned you in a note`);
    const url = 'https://app.example.test/c/acme/inbox/0199b6f2-7c3e-7a1b-9f00-123456789abc';
    const payload = {
      kind: 'tenant.notice' as const,
      companyName: 'Acme',
      subject: notice.subject,
      lines: notice.lines,
      url,
      actionLabel: 'Open conversation',
    };
    expect(emailPayloadSchema.parse(payload)).toEqual(payload);
    const email = renderEmail(payload);
    expect(email.text).toBe(`${notice.lines.join('\n\n')}\n\n${url}`);
    expect(email.html).toContain(`&lt;b&gt;${'N'.repeat(117)} mentioned you`);
    expect(email.html).not.toContain('<b>N');
    expect(email.html).toContain('>Open conversation</a>');
  });
});
