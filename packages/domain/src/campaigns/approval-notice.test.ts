import { describe, expect, it } from 'vitest';
import { emailPayloadSchema, renderEmail } from '../email/templates';
import { campaignApprovalNotice } from './service';

describe('the email that a campaign waits for approval (ADR-204)', () => {
  it('names the member who submitted it, how many it reaches and its start in the campaign’s time zone', () => {
    expect(
      campaignApprovalNotice({
        campaignName: 'Diwali offer',
        submitter: { kind: 'member', name: 'Asha Rao' },
        pending: 118_000,
        total: 125_000,
        startsAt: new Date('2026-10-20T04:30:00Z'),
        timeZone: 'Asia/Kolkata',
      }),
    ).toEqual({
      subject: 'Campaign “Diwali offer” waits for your approval',
      lines: [
        "Asha Rao submitted the campaign “Diwali offer”, and it waits for a member's approval.",
        'It would be sent to 1,18,000 of the 1,25,000 contacts in its audience.',
        'Once approved, it starts at 20 October 2026 at 10:00 GMT+5:30, or at once if that time has passed.',
        'Approve it, or send it back with a note, on its page.',
      ],
    });
  });

  it('names a key’s submission, which sends under the authority of the member who approves it', () => {
    expect(
      campaignApprovalNotice({
        campaignName: 'Winter launch',
        submitter: { kind: 'key', name: 'Campaign drafts' },
        pending: 0,
        total: 1,
        startsAt: null,
        timeZone: 'Asia/Kolkata',
      }).lines,
    ).toEqual([
      "The API key “Campaign drafts” submitted the campaign “Winter launch”, and it waits for a member's approval.",
      'It would be sent to 0 of the 1 contact in its audience.',
      'Once approved, it starts at once.',
      'Approving it needs permission to send campaigns, as it then sends under your authority. You can also send it back with a note.',
    ]);
  });

  it('fits the email’s limits with the longest names the database allows, escaped in the HTML', () => {
    const name = `<b>${'C'.repeat(113)}</b>`;
    const notice = campaignApprovalNotice({
      campaignName: name,
      submitter: { kind: 'member', name: 'M'.repeat(200) },
      pending: 2_000_000_000,
      total: 2_000_000_000,
      startsAt: new Date('2026-12-31T23:59:00Z'),
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    expect(name).toHaveLength(120);
    const url = 'https://app.example.test/c/acme/campaigns/0199b6f2-7c3e-7a1b-9f00-123456789abc';
    const payload = {
      kind: 'tenant.notice' as const,
      companyName: 'Acme',
      subject: notice.subject,
      lines: notice.lines,
      url,
      actionLabel: 'Review campaign',
    };
    expect(emailPayloadSchema.parse(payload)).toEqual(payload);
    const email = renderEmail(payload);
    expect(email.text).toBe(`${notice.lines.join('\n\n')}\n\n${url}`);
    expect(email.html).toContain(`&lt;b&gt;${'C'.repeat(113)}&lt;/b&gt;`);
    expect(email.html).not.toContain('<b>C');
    expect(email.html).toContain('>Review campaign</a>');
  });
});
