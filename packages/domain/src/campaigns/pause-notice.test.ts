import { describe, expect, it } from 'vitest';
import { emailPayloadSchema, renderEmail } from '../email/templates';
import { campaignPauseNotice, type AutomaticPauseReason } from './service';

describe('the email that HyFib paused a campaign by itself (ADR-210)', () => {
  it('says why, what to do and when its sending period ends, in the campaign’s time zone', () => {
    expect(
      campaignPauseNotice({
        campaignName: 'Diwali offer',
        reason: 'template_not_approved',
        sendUntil: new Date('2026-10-21T04:30:00Z'),
        timeZone: 'Asia/Kolkata',
      }),
    ).toEqual({
      subject: 'Campaign “Diwali offer” paused: its template can no longer be sent',
      lines: [
        'HyFib paused the campaign “Diwali offer”, and it sends nothing more until it is resumed.',
        'Its template is no longer approved by Meta, or no longer takes the variables the campaign fills in. Resume it once Meta approves the template again; if the template’s variables changed, cancel it and create a new campaign.',
        'Messages that had not gone out yet wait until it is resumed. Its sending period ends at 21 October 2026 at 10:00 GMT+5:30, and contacts it has not sent to by then are skipped.',
      ],
    });
  });

  it('says a campaign that had not started sent nothing and starts once resumed', () => {
    expect(
      campaignPauseNotice({
        campaignName: 'Winter launch',
        reason: 'launcher_removed',
        sendUntil: null,
        timeZone: 'Asia/Kolkata',
      }).lines[2],
    ).toBe(
      'It had not started, so nothing was sent. Once resumed, it starts at its scheduled time, or at once if that time has passed.',
    );
  });

  it('gives each automatic pause its own cause and what a member does about it', () => {
    const notices = Object.fromEntries(
      (
        [
          'budget_reached',
          'message_cap_reached',
          'template_not_approved',
          'channel_inactive',
          'launcher_removed',
          'launcher_not_permitted',
          'rate_card_missing',
        ] as const
      ).map((reason) => {
        const notice = campaignPauseNotice({
          campaignName: 'Offer',
          reason,
          sendUntil: null,
          timeZone: 'UTC',
        });
        return [reason, [notice.subject, notice.lines[1]]];
      }),
    );
    expect(notices).toEqual({
      budget_reached: [
        'Campaign “Offer” paused: its spending cap was reached',
        'It reached its spending cap. Raise or remove the cap on its page, then resume it.',
      ],
      message_cap_reached: [
        'Campaign “Offer” paused: its message cap was reached',
        'It reached its message cap. Raise or remove the cap on its page, then resume it.',
      ],
      template_not_approved: [
        'Campaign “Offer” paused: its template can no longer be sent',
        'Its template is no longer approved by Meta, or no longer takes the variables the campaign fills in. Resume it once Meta approves the template again; if the template’s variables changed, cancel it and create a new campaign.',
      ],
      channel_inactive: [
        'Campaign “Offer” paused: its WhatsApp number is not active',
        'The WhatsApp number it sends from is not active. An administrator can reconnect it in Settings → Channels; then resume the campaign.',
      ],
      launcher_removed: [
        'Campaign “Offer” paused: another member must resume it',
        'The member whose authority it sent under is no longer an active member of the company. A member who can send campaigns can resume it, and it then sends under their authority.',
      ],
      launcher_not_permitted: [
        'Campaign “Offer” paused: another member must resume it',
        'The member whose authority it sent under can no longer send campaigns. A member who can send campaigns can resume it, and it then sends under their authority.',
      ],
      rate_card_missing: [
        'Campaign “Offer” paused: its costs cannot be checked',
        'No rate card is published for the currency of its spending cap, so its costs cannot be checked against the cap. Resume it once one is published, or remove the cap on its page first.',
      ],
    } satisfies Record<AutomaticPauseReason, [string, string]>);
  });

  it('fits the email’s limits with the longest name the database allows, escaped in the HTML', () => {
    const name = `<b>${'C'.repeat(113)}</b>`;
    expect(name).toHaveLength(120);
    for (const reason of [
      'budget_reached',
      'message_cap_reached',
      'template_not_approved',
      'channel_inactive',
      'launcher_removed',
      'launcher_not_permitted',
      'rate_card_missing',
    ] as const) {
      const notice = campaignPauseNotice({
        campaignName: name,
        reason,
        sendUntil: new Date('2026-12-31T23:59:00Z'),
        timeZone: 'America/Argentina/Buenos_Aires',
      });
      const url = 'https://app.example.test/c/acme/campaigns/0199b6f2-7c3e-7a1b-9f00-123456789abc';
      const payload = {
        kind: 'tenant.notice' as const,
        companyName: 'Acme',
        subject: notice.subject,
        lines: notice.lines,
        url,
        actionLabel: 'Open campaign',
      };
      expect(emailPayloadSchema.parse(payload)).toEqual(payload);
      const email = renderEmail(payload);
      expect(email.text).toBe(`${notice.lines.join('\n\n')}\n\n${url}`);
      expect(email.html).toContain(`&lt;b&gt;${'C'.repeat(113)}&lt;/b&gt;`);
      expect(email.html).not.toContain('<b>C');
      expect(email.html).toContain('>Open campaign</a>');
    }
  });
});
