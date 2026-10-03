import { z } from 'zod';
import { notFound } from '@w360/core';
import {
  CAMPAIGN_COMPLETION_REASONS,
  CAMPAIGN_PAUSE_REASONS,
  CAMPAIGN_STATUSES,
  SKIP_REASONS,
  and,
  campaigns,
  channelAccounts,
  desc,
  eq,
  exactTimestamp,
  messageTemplates,
  sql,
  type SQL,
  type Tx,
} from '@w360/db';
import { ATTRIBUTION_WINDOW_HOURS } from '../campaigns/attribution';
import { campaignAnalytics } from '../campaigns/service';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * Campaigns through the public API (ADR-125): a key with `campaigns.read` lists the company's
 * campaigns, newest first, as the campaign events describe them (ADR-087), and reads one with its
 * results as members' campaign page counts them (`campaignAnalytics`), when it is read. Counts
 * only: never recipients, members or costs.
 */

export const apiCampaignListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    status: z.enum(CAMPAIGN_STATUSES).optional().describe('Only campaigns in this status.'),
  })
  .strict();

export const apiCampaignSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(CAMPAIGN_STATUSES),
  pauseReason: z
    .enum(CAMPAIGN_PAUSE_REASONS)
    .nullable()
    .describe(
      'Why it paused, while it is paused: a member paused it (manual), the spending or message cap was reached, the template is no longer approved, the number is not active, the member whose authority it runs under left or lost the permission, or no rate card is published for its spending cap.',
    ),
  completionReason: z
    .enum(CAMPAIGN_COMPLETION_REASONS)
    .nullable()
    .describe(
      'Why it completed: every recipient was processed, or its sending time ran out. Null otherwise.',
    ),
  templateId: z.uuid().nullable(),
  templateName: z.string().nullable(),
  channel: z
    .object({
      id: z.uuid(),
      phone: z.string().nullable().describe('The WhatsApp number as WhatsApp displays it.'),
    })
    .nullable()
    .describe('The number it sends from; null if none is set.'),
  scheduledAt: z.iso.datetime().nullable().describe('When it was set to start.'),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  canceledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  audienceCount: z
    .number()
    .int()
    .describe('Contacts in the audience taken when it was submitted; 0 while it is a draft.'),
  queuedCount: z.number().int().describe('Recipients whose message has been queued.'),
  skippedCount: z
    .number()
    .int()
    .describe('Recipients skipped: no consent, suppressed, erased, over a cap and the like.'),
});
export type ApiCampaign = z.infer<typeof apiCampaignSchema>;

const count = (description: string) => z.number().int().describe(description);

export const apiCampaignResultsSchema = z.object({
  audience: count('Recipients: the contacts in the audience taken when it was submitted.'),
  pending: count('Recipients not processed yet.'),
  skipped: count('Recipients skipped, with the reasons in skipReasons.'),
  canceled: count('Recipients left out because the campaign was canceled before their turn.'),
  queued: count('Recipients whose message was queued.'),
  inProgress: count('Queued messages not sent yet.'),
  sent: count('Messages WhatsApp sent (delivered and read ones included).'),
  delivered: count('Messages delivered (read ones included).'),
  read: count('Messages read (or played).'),
  failed: count('Messages that failed, with the commonest codes in failureCodes.'),
  unknown: count(
    'Messages whose sending outcome is unknown: the call to WhatsApp ended without an answer, and they are never sent again blindly.',
  ),
  messagesCanceled: count('Queued messages canceled before they were sent.'),
  replied: count(
    `Delivered recipients who replied. A reply counts once, for the last campaign message (of any campaign) sent to the contact from the same number in the ${ATTRIBUTION_WINDOW_HOURS} hours before it.`,
  ),
  optedOut: count(
    `Delivered recipients who opted out of marketing. An opt-out counts once, for the last campaign message (of any campaign) sent to the contact in the ${ATTRIBUTION_WINDOW_HOURS} hours before it.`,
  ),
  skipReasons: z
    .array(z.object({ reason: z.enum(SKIP_REASONS), count: z.number().int() }))
    .describe('Skipped recipients by reason, the commonest first.'),
  failureCodes: z
    .array(z.object({ code: z.string(), count: z.number().int() }))
    .describe('Failed messages by WhatsApp error code, the 10 commonest, the commonest first.'),
});
export type ApiCampaignResults = z.infer<typeof apiCampaignResultsSchema>;

export const apiCampaignWithResultsSchema = apiCampaignSchema.extend({
  results: apiCampaignResultsSchema
    .nullable()
    .describe('Counted when read; null for a draft, which has no recipients yet.'),
});

const campaignColumns = {
  id: campaigns.id,
  name: campaigns.name,
  status: campaigns.status,
  pauseReason: campaigns.pauseReason,
  completionReason: campaigns.completionReason,
  templateId: campaigns.templateId,
  templateName: messageTemplates.name,
  channelId: campaigns.channelAccountId,
  channelPhone: channelAccounts.displayPhoneNumber,
  scheduledAt: campaigns.scheduledAt,
  startedAt: campaigns.startedAt,
  completedAt: campaigns.completedAt,
  canceledAt: campaigns.canceledAt,
  createdAt: campaigns.createdAt,
  cursorAt: exactTimestamp(campaigns.createdAt),
  audienceCount: campaigns.audienceCount,
  queuedCount: campaigns.queuedCount,
  skippedCount: campaigns.skippedCount,
};

function selectCampaigns(tx: Tx, where: SQL | undefined) {
  return tx
    .select(campaignColumns)
    .from(campaigns)
    .leftJoin(
      messageTemplates,
      and(
        eq(messageTemplates.tenantId, campaigns.tenantId),
        eq(messageTemplates.id, campaigns.templateId),
      ),
    )
    .leftJoin(
      channelAccounts,
      and(
        eq(channelAccounts.tenantId, campaigns.tenantId),
        eq(channelAccounts.id, campaigns.channelAccountId),
      ),
    )
    .where(where);
}

type CampaignRow = Awaited<ReturnType<typeof selectCampaigns>>[number];

function toApiCampaign(row: CampaignRow): ApiCampaign {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    pauseReason: row.pauseReason,
    completionReason: row.completionReason,
    templateId: row.templateId,
    templateName: row.templateName ?? null,
    channel: row.channelId ? { id: row.channelId, phone: row.channelPhone ?? null } : null,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    canceledAt: row.canceledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    audienceCount: row.audienceCount,
    queuedCount: row.queuedCount,
    skippedCount: row.skippedCount,
  };
}

/**
 * The company's campaigns newest first (by creation) on exact keyset pages, in one status or all.
 * Campaigns are made by members, so a company has few and a page reads them through their index
 * without a window.
 */
export async function apiListCampaigns(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiCampaign[]; nextCursor: string | null }> {
  assertScope(ctx, 'campaigns.read');
  const q = parseInput(apiCampaignListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await selectCampaigns(
        tx,
        and(
          eq(campaigns.tenantId, ctx.tenant.id),
          q.status ? eq(campaigns.status, q.status) : undefined,
          cursor
            ? sql`(${campaigns.createdAt}, ${campaigns.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
        .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map(toApiCampaign),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/**
 * One of the company's campaigns with its results counted now, in the snapshot its row is read
 * in: null for a draft, which has no recipients yet.
 */
export async function apiGetCampaign(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  campaignId: string,
): Promise<ApiCampaign & { results: ApiCampaignResults | null }> {
  assertScope(ctx, 'campaigns.read');
  if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const [row] = await selectCampaigns(
        tx,
        and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)),
      );
      if (!row) throw notFound('Campaign');
      if (row.status === 'draft') return { ...toApiCampaign(row), results: null };
      const counted = await campaignAnalytics(tx, ctx.tenant.id, campaignId);
      return {
        ...toApiCampaign(row),
        results: {
          audience: counted.audience,
          pending: counted.pending,
          skipped: counted.skipped,
          canceled: counted.canceled,
          queued: counted.queued,
          inProgress: counted.inProgress,
          sent: counted.sent,
          delivered: counted.delivered,
          read: counted.read,
          failed: counted.failed,
          unknown: counted.unknown,
          messagesCanceled: counted.messageCanceled,
          replied: counted.replied,
          optedOut: counted.optedOut,
          skipReasons: counted.skipReasons,
          failureCodes: counted.failureCodes,
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
