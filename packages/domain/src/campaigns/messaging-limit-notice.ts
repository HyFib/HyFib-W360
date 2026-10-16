import { and, channelAccounts, eq, type CampaignStatus, type Tx } from '@w360/db';
import { isListedMessagingLimit, messagingLimitFigure } from '../messaging/messaging-limit';

/**
 * A campaign's messaging-limit notice (ADR-400): its sending number's messaging limit as Meta last
 * reported it (ADR-398) set against how many contacts the campaign may reach. A notice only: it
 * never blocks a campaign, since Meta, not HyFib, enforces the limit, and the limit is shared by the
 * whole business portfolio, whose use HyFib cannot see (research M-058).
 */

/** A number's limit as HyFib keeps it (migration 0309): Meta's text, and when it was last asked. */
export interface NumberMessagingLimit {
  /** The text Meta gave (clipped to 64 characters), or null when it gave none. */
  limit: string | null;
  /** The last health read that asked Meta for the limit; null for a number never asked. */
  checkedAt: Date | null;
}

/**
 * How the campaign compares with the limit: `over` a tier's figure, `within` it, a limit that is
 * `unlimited`, or `unknown` (no figure to compare with).
 */
export type MessagingLimitStatus = 'over' | 'within' | 'unlimited' | 'unknown';

/**
 * Why a limit is unknown: the number was never asked (`not_asked`), Meta gave no limit
 * (`not_reported`), Meta gave `TIER_50` or `UNTIERED`, which research gives no figure for
 * (`no_figure`), or a value Meta's SDK does not list (`unlisted`).
 */
export type MessagingLimitUnknown = 'not_asked' | 'not_reported' | 'no_figure' | 'unlisted';

export interface CampaignMessagingLimitNotice {
  status: MessagingLimitStatus;
  /** Why the limit is unknown; null unless `status` is `unknown`. */
  unknown: MessagingLimitUnknown | null;
  limit: string | null;
  checkedAt: Date | null;
  /** The tier's figure from research M-058; null without one. */
  figure: number | null;
  /** The contacts the campaign may reach: an upper bound of what counts toward the limit. */
  recipients: number;
  /** `warning` only when the recipients are over a figure; never a reason to block. */
  tone: 'warning' | 'info';
  title: string;
  lines: string[];
}

const count = (n: number) => n.toLocaleString('en-US');
const contacts = (n: number) => `${count(n)} ${n === 1 ? 'contact' : 'contacts'}`;

/** Why the campaign's count may be higher than what Meta counts (research M-058). */
export const MESSAGING_LIMIT_UPPER_BOUND =
  'Contacts whose customer service window is open when their message is sent do not count toward the limit, so this count is an upper bound.';
/** The portfolio's shared allowance, whose use HyFib cannot see (research M-058). */
export const MESSAGING_LIMIT_SHARED =
  'Since 7 October 2025 the limit is shared by every number of your business portfolio: its other numbers and campaigns use the same allowance, and HyFib cannot see how much of it they have used.';
/** Who enforces it, and what HyFib shows of it, without naming a Meta error code. */
export const MESSAGING_LIMIT_ENFORCED =
  'Meta, not HyFib, enforces the limit, and HyFib does not hold the campaign back for it: a message Meta does not deliver is shown as failed with the code Meta gives.';

/**
 * The notice for a campaign sending from a number with `number`'s limit to `recipients` contacts
 * (ADR-400): a warning when a tier research gives a figure for (250, 2,000, 10,000, 100,000) is
 * exceeded, an informational line at or under it, a line without a warning for `TIER_UNLIMITED`,
 * and "limit unknown", with no comparison, for `TIER_50`, `UNTIERED`, a value Meta's SDK does not
 * list, a read that got no limit and a number never asked. Pure: it reads nothing.
 */
export function campaignMessagingLimitNotice(
  number: NumberMessagingLimit,
  recipients: number,
): CampaignMessagingLimitNotice {
  const { limit, checkedAt } = number;
  const base = { limit, checkedAt, recipients };
  const reach = `up to ${contacts(recipients)}`;
  const unknown = (why: MessagingLimitUnknown, first: string): CampaignMessagingLimitNotice => ({
    ...base,
    status: 'unknown',
    unknown: why,
    figure: null,
    tone: 'info',
    title: 'Messaging limit unknown',
    lines: [
      `${first}, so HyFib cannot compare it with the ${reach} this campaign may reach.`,
      MESSAGING_LIMIT_UPPER_BOUND,
      MESSAGING_LIMIT_SHARED,
      MESSAGING_LIMIT_ENFORCED,
    ],
  });
  if (checkedAt === null) {
    return unknown('not_asked', "HyFib has not read this number's messaging limit from Meta yet");
  }
  if (limit === null) {
    return unknown(
      'not_reported',
      'Meta did not report a messaging limit when HyFib last read this number',
    );
  }
  if (!isListedMessagingLimit(limit)) {
    return unknown(
      'unlisted',
      `Meta reported “${limit}” when HyFib last read this number, a value HyFib does not recognise`,
    );
  }
  if (limit === 'TIER_UNLIMITED') {
    return {
      ...base,
      status: 'unlimited',
      unknown: null,
      figure: null,
      tone: 'info',
      title: 'Messaging limit: unlimited',
      lines: [
        'Meta reported an unlimited messaging limit (TIER_UNLIMITED) when HyFib last read this number.',
      ],
    };
  }
  const figure = messagingLimitFigure(limit);
  if (figure === null) {
    return unknown(
      'no_figure',
      limit === 'UNTIERED'
        ? 'Meta reported this number as untiered (UNTIERED) when HyFib last read it, which HyFib has no documented figure for'
        : `Meta reported ${limit} when HyFib last read this number, a level HyFib has no documented figure for`,
    );
  }
  const over = recipients > figure;
  return {
    ...base,
    status: over ? 'over' : 'within',
    unknown: null,
    figure,
    tone: over ? 'warning' : 'info',
    title: over
      ? "More recipients than the number's messaging limit"
      : "Within the number's messaging limit",
    lines: [
      `This campaign may reach ${reach}, ${over ? 'more than' : 'within'} the ${count(figure)} unique customers its number's messaging limit allows outside a customer service window in a moving 24 hours (Meta reported ${limit} when HyFib last read the number).`,
      MESSAGING_LIMIT_UPPER_BOUND,
      MESSAGING_LIMIT_SHARED,
      MESSAGING_LIMIT_ENFORCED,
    ],
  };
}

/**
 * The submitted statuses whose page shows the notice: a campaign not yet finished (ADR-400). A
 * draft shows it in its review, from the contacts who can receive it now.
 */
export const SUBMITTED_NOTICE_STATUSES: readonly CampaignStatus[] = [
  'pending_approval',
  'scheduled',
  'running',
  'paused',
];

/**
 * The contacts a submitted campaign may reach (ADR-400), counted as its approval email counts them
 * (ADR-204): its frozen audience less those it skipped, which includes those already sent to.
 */
export function submittedCampaignRecipients(c: {
  audienceCount: number;
  skippedCount: number;
}): number {
  return Math.max(0, c.audienceCount - c.skippedCount);
}

/**
 * The messaging limit of one of the company's numbers (ADR-400), read in the caller's transaction,
 * which runs under the authorized tenant scope (`db.run(scope, fn)`): the company is named in the
 * query as well as by row security, so another company's number is never read. Null when the
 * company has no such number.
 */
export async function loadNumberMessagingLimit(
  tx: Tx,
  tenantId: string,
  channelAccountId: string,
): Promise<NumberMessagingLimit | null> {
  const [row] = await tx
    .select({
      limit: channelAccounts.messagingLimit,
      checkedAt: channelAccounts.messagingLimitCheckedAt,
    })
    .from(channelAccounts)
    .where(and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.id, channelAccountId)));
  return row ?? null;
}
