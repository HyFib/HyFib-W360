import { describe, expect, it } from 'vitest';
import {
  MESSAGING_LIMIT_ENFORCED,
  MESSAGING_LIMIT_SHARED,
  MESSAGING_LIMIT_UPPER_BOUND,
  SUBMITTED_NOTICE_STATUSES,
  campaignMessagingLimitNotice,
  submittedCampaignRecipients,
} from './messaging-limit-notice';
import { MESSAGING_LIMITS, messagingLimitFigure } from '../messaging/messaging-limit';

const checkedAt = new Date('2026-10-16T08:00:00Z');
const read = (limit: string | null) => ({ limit, checkedAt });
const COMMON = [MESSAGING_LIMIT_UPPER_BOUND, MESSAGING_LIMIT_SHARED, MESSAGING_LIMIT_ENFORCED];

describe('a campaign’s messaging-limit notice (ADR-400)', () => {
  const tiers = [
    ['TIER_250', 250, '250'],
    ['TIER_2K', 2_000, '2,000'],
    ['TIER_10K', 10_000, '10,000'],
    ['TIER_100K', 100_000, '100,000'],
  ] as const;

  it.each(tiers)(
    'warns for %s only above its figure, and informs at or under it',
    (limit, figure, shown) => {
      const at = campaignMessagingLimitNotice(read(limit), figure);
      expect(at).toEqual({
        status: 'within',
        unknown: null,
        limit,
        checkedAt,
        figure,
        recipients: figure,
        tone: 'info',
        title: "Within the number's messaging limit",
        lines: [
          `This campaign may reach up to ${shown} contacts, within the ${shown} unique customers its number's messaging limit allows outside a customer service window in a moving 24 hours (Meta reported ${limit} when HyFib last read the number).`,
          ...COMMON,
        ],
      });
      expect(campaignMessagingLimitNotice(read(limit), figure - 1)).toMatchObject({
        status: 'within',
        tone: 'info',
      });
      const over = campaignMessagingLimitNotice(read(limit), figure + 1);
      expect(over).toEqual({
        status: 'over',
        unknown: null,
        limit,
        checkedAt,
        figure,
        recipients: figure + 1,
        tone: 'warning',
        title: "More recipients than the number's messaging limit",
        lines: [
          `This campaign may reach up to ${(figure + 1).toLocaleString('en-US')} contacts, more than the ${shown} unique customers its number's messaging limit allows outside a customer service window in a moving 24 hours (Meta reported ${limit} when HyFib last read the number).`,
          ...COMMON,
        ],
      });
    },
  );

  it('never warns for an unlimited limit, however many recipients', () => {
    for (const recipients of [0, 1, 250_001, 50_000]) {
      expect(campaignMessagingLimitNotice(read('TIER_UNLIMITED'), recipients)).toEqual({
        status: 'unlimited',
        unknown: null,
        limit: 'TIER_UNLIMITED',
        checkedAt,
        figure: null,
        recipients,
        tone: 'info',
        title: 'Messaging limit: unlimited',
        lines: [
          'Meta reported an unlimited messaging limit (TIER_UNLIMITED) when HyFib last read this number.',
        ],
      });
    }
  });

  it('says the limit is unknown, with no figure or warning, for every value research gives no figure for', () => {
    const cases = [
      {
        number: { limit: null, checkedAt: null },
        unknown: 'not_asked',
        first: "HyFib has not read this number's messaging limit from Meta yet",
      },
      {
        number: read(null),
        unknown: 'not_reported',
        first: 'Meta did not report a messaging limit when HyFib last read this number',
      },
      {
        number: read('TIER_50'),
        unknown: 'no_figure',
        first:
          'Meta reported TIER_50 when HyFib last read this number, a level HyFib has no documented figure for',
      },
      {
        number: read('UNTIERED'),
        unknown: 'no_figure',
        first:
          'Meta reported this number as untiered (UNTIERED) when HyFib last read it, which HyFib has no documented figure for',
      },
      {
        // The deprecated field's tier, which the new field's SDK list does not have.
        number: read('TIER_1K'),
        unknown: 'unlisted',
        first:
          'Meta reported “TIER_1K” when HyFib last read this number, a value HyFib does not recognise',
      },
      {
        // Listed values are matched exactly as written.
        number: read('tier_2k'),
        unknown: 'unlisted',
        first:
          'Meta reported “tier_2k” when HyFib last read this number, a value HyFib does not recognise',
      },
    ] as const;
    for (const { number, unknown, first } of cases) {
      // Far above every figure: still no warning.
      const notice = campaignMessagingLimitNotice(number, 100_001);
      expect(notice, String(number.limit)).toEqual({
        status: 'unknown',
        unknown,
        limit: number.limit,
        checkedAt: number.checkedAt,
        figure: null,
        recipients: 100_001,
        tone: 'info',
        title: 'Messaging limit unknown',
        lines: [
          `${first}, so HyFib cannot compare it with the up to 100,001 contacts this campaign may reach.`,
          ...COMMON,
        ],
      });
    }
  });

  it('treats a number never asked as unknown even should a limit be present', () => {
    // The database's check forbids it (0309); the notice still never compares without a read.
    expect(
      campaignMessagingLimitNotice({ limit: 'TIER_250', checkedAt: null }, 1_000),
    ).toMatchObject({ status: 'unknown', unknown: 'not_asked', figure: null, tone: 'info' });
  });

  it('words zero and one recipient', () => {
    expect(campaignMessagingLimitNotice(read('TIER_250'), 0)).toMatchObject({
      status: 'within',
      tone: 'info',
      recipients: 0,
      lines: [
        "This campaign may reach up to 0 contacts, within the 250 unique customers its number's messaging limit allows outside a customer service window in a moving 24 hours (Meta reported TIER_250 when HyFib last read the number).",
        ...COMMON,
      ],
    });
    expect(campaignMessagingLimitNotice(read('TIER_50'), 0).lines[0]).toBe(
      'Meta reported TIER_50 when HyFib last read this number, a level HyFib has no documented figure for, so HyFib cannot compare it with the up to 0 contacts this campaign may reach.',
    );
    expect(campaignMessagingLimitNotice(read('TIER_250'), 1).lines[0]).toContain(
      'may reach up to 1 contact, within',
    );
    expect(campaignMessagingLimitNotice({ limit: null, checkedAt: null }, 0)).toMatchObject({
      status: 'unknown',
      unknown: 'not_asked',
    });
  });

  it('is honest about what the limit counts, who shares it and who enforces it', () => {
    expect(MESSAGING_LIMIT_UPPER_BOUND).toBe(
      'Contacts whose customer service window is open when their message is sent do not count toward the limit, so this count is an upper bound.',
    );
    expect(MESSAGING_LIMIT_SHARED).toBe(
      'Since 7 October 2025 the limit is shared by every number of your business portfolio: its other numbers and campaigns use the same allowance, and HyFib cannot see how much of it they have used.',
    );
    expect(MESSAGING_LIMIT_ENFORCED).toBe(
      'Meta, not HyFib, enforces the limit, and HyFib does not hold the campaign back for it: a message Meta does not deliver is shown as failed with the code Meta gives.',
    );
    // No Meta error code is claimed for exceeding the limit: research documents none.
    for (const limit of [...MESSAGING_LIMITS, null, 'TIER_1K']) {
      for (const line of campaignMessagingLimitNotice(read(limit), 300).lines) {
        expect(line, String(limit)).not.toMatch(/\berror\b|\b1\d{5}\b/iu);
      }
    }
  });
});

describe('the figures research gives for each limit (ADR-400)', () => {
  it('are 250, 2,000, 10,000 and 100,000, and none for any other value', () => {
    expect(MESSAGING_LIMITS.map((l) => [l, messagingLimitFigure(l)])).toEqual([
      ['TIER_50', null],
      ['TIER_250', 250],
      ['TIER_2K', 2_000],
      ['TIER_10K', 10_000],
      ['TIER_100K', 100_000],
      ['TIER_UNLIMITED', null],
      ['UNTIERED', null],
    ]);
    expect(messagingLimitFigure('TIER_1K')).toBeNull();
    expect(messagingLimitFigure('')).toBeNull();
  });
});

describe('what a submitted campaign counts (ADR-400)', () => {
  it('is its frozen audience less those it skipped, never below zero', () => {
    expect(submittedCampaignRecipients({ audienceCount: 3_000, skippedCount: 400 })).toBe(2_600);
    expect(submittedCampaignRecipients({ audienceCount: 0, skippedCount: 0 })).toBe(0);
    expect(submittedCampaignRecipients({ audienceCount: 5, skippedCount: 7 })).toBe(0);
  });

  it('is shown while it is not finished', () => {
    expect([...SUBMITTED_NOTICE_STATUSES]).toEqual([
      'pending_approval',
      'scheduled',
      'running',
      'paused',
    ]);
  });
});
