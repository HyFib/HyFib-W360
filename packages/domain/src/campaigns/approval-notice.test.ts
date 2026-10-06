import { describe, expect, it } from 'vitest';
import { emailPayloadSchema, renderEmail } from '../email/templates';
import { campaignApprovalNotice, campaignReviewNotice } from './service';

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

describe('the email to the member who submitted a campaign about its review (ADR-205)', () => {
  const base = {
    campaignName: 'Diwali offer',
    reviewer: 'Ravi Kumar',
    note: null,
    startsAt: null,
    timeZone: 'Asia/Kolkata',
  };

  it('says an approved campaign starts at its time in the campaign’s time zone, or now, under their authority', () => {
    expect(
      campaignReviewNotice({
        ...base,
        outcome: 'approved',
        note: 'Looks good',
        startsAt: new Date('2026-10-20T04:30:00Z'),
      }),
    ).toEqual({
      subject: 'Campaign “Diwali offer” was approved',
      lines: [
        'Ravi Kumar approved your campaign “Diwali offer”.',
        'It starts at 20 October 2026 at 10:00 GMT+5:30.',
        'Their note: “Looks good”',
        'It sends under your authority, so it pauses if you leave the company or can no longer send campaigns. You can follow, pause or cancel it on its page.',
      ],
    });
    expect(campaignReviewNotice({ ...base, outcome: 'approved' }).lines.slice(0, 2)).toEqual([
      'Ravi Kumar approved your campaign “Diwali offer”.',
      'It starts now.',
    ]);
  });

  it('gives a campaign sent back with the note, and one taken back without one', () => {
    expect(
      campaignReviewNotice({ ...base, outcome: 'rejected', note: 'Use the\n\nnew   offer' }),
    ).toEqual({
      subject: 'Campaign “Diwali offer” was sent back',
      lines: [
        'Ravi Kumar sent your campaign “Diwali offer” back to you as a draft. Nothing was sent.',
        'Their note: “Use the new offer”',
        'Change what is needed, then submit it again for approval.',
      ],
    });
    expect(campaignReviewNotice({ ...base, outcome: 'withdrawn' })).toEqual({
      subject: 'Campaign “Diwali offer” was taken back to a draft',
      lines: [
        'Ravi Kumar took your campaign “Diwali offer” back to a draft while it waited for approval. Nothing was sent.',
        'Submit it again when it is ready.',
      ],
    });
  });

  it('fits the email’s limits with the longest names and note, escaped in the HTML', () => {
    for (const outcome of ['approved', 'rejected', 'withdrawn'] as const) {
      const notice = campaignReviewNotice({
        campaignName: `<i>${'C'.repeat(113)}</i>`,
        outcome,
        reviewer: 'R'.repeat(200),
        note: `<b>${'n'.repeat(493)}</b>`,
        startsAt: new Date('2026-12-31T23:59:00Z'),
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
      expect(html).toContain(`&lt;i&gt;${'C'.repeat(113)}&lt;/i&gt;`);
      expect(html).not.toContain('<i>C');
      if (outcome !== 'withdrawn') expect(html).toContain(`&lt;b&gt;${'n'.repeat(493)}&lt;/b&gt;`);
    }
  });
});
