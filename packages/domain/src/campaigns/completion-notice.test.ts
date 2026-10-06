import { describe, expect, it } from 'vitest';
import { emailPayloadSchema, renderEmail } from '../email/templates';
import { campaignCompletionNotice } from './service';

const base = {
  campaignName: 'Diwali offer',
  audience: 125_000,
  queued: 118_000,
  skipped: 7_000,
  expired: 0,
  sendUntil: new Date('2026-10-21T04:30:00Z'),
  timeZone: 'Asia/Kolkata',
};

describe('the email that a campaign finished (ADR-214)', () => {
  it('says it handed every contact to WhatsApp or skipped them, with its counts', () => {
    expect(campaignCompletionNotice({ ...base, reason: 'all_processed' })).toEqual({
      subject: 'Campaign “Diwali offer” finished sending',
      lines: [
        'The campaign “Diwali offer” finished: every contact in its audience was handed to WhatsApp or skipped.',
        'It handed 1,18,000 messages to WhatsApp and skipped 7,000 of the 1,25,000 contacts in its audience; its page says why each was skipped.',
        'WhatsApp keeps reporting deliveries, reads and replies after this, and its page shows them as they arrive.',
      ],
    });
  });

  it('says when its sending period ended and how many contacts it had not reached', () => {
    const notice = campaignCompletionNotice({
      ...base,
      reason: 'deadline_passed',
      queued: 1,
      skipped: 1,
      expired: 1,
      audience: 2,
    });
    expect(notice.subject).toBe('Campaign “Diwali offer” ended: its sending period is over');
    expect(notice.lines.slice(0, 2)).toEqual([
      'The sending period of the campaign “Diwali offer” ended at 21 October 2026 at 10:00 GMT+5:30, so the 1 contact it had not reached was skipped.',
      'It handed 1 message to WhatsApp and skipped 1 of the 2 contacts in its audience; its page says why each was skipped.',
    ]);
  });

  it('says a period that ended with nobody left waiting skipped no one, and many were skipped', () => {
    const ended = { ...base, reason: 'deadline_passed' as const };
    expect(campaignCompletionNotice(ended).lines[0]).toBe(
      'The sending period of the campaign “Diwali offer” ended at 21 October 2026 at 10:00 GMT+5:30, after every contact in its audience was handed to WhatsApp or skipped.',
    );
    expect(campaignCompletionNotice({ ...ended, expired: 4_000, sendUntil: null }).lines[0]).toBe(
      'The sending period of the campaign “Diwali offer” ended, so the 4,000 contacts it had not reached were skipped.',
    );
  });

  it('fits the email’s limits with the longest name the database allows, escaped in the HTML', () => {
    const name = `<b>${'C'.repeat(113)}</b>`;
    for (const reason of ['all_processed', 'deadline_passed'] as const) {
      const notice = campaignCompletionNotice({
        ...base,
        campaignName: name,
        reason,
        audience: 2_000_000_000,
        queued: 2_000_000_000,
        skipped: 2_000_000_000,
        expired: 2_000_000_000,
        timeZone: 'America/Argentina/Buenos_Aires',
      });
      const payload = {
        kind: 'tenant.notice' as const,
        companyName: 'Acme',
        subject: notice.subject,
        lines: notice.lines,
        url: 'https://app.example.test/c/acme/campaigns/0199b6f2-7c3e-7a1b-9f00-123456789abc',
        actionLabel: 'Open campaign',
      };
      expect(emailPayloadSchema.parse(payload)).toEqual(payload);
      const html = renderEmail(payload).html;
      expect(html).toContain(`&lt;b&gt;${'C'.repeat(113)}&lt;/b&gt;`);
      expect(html).not.toContain('<b>C');
    }
  });
});
