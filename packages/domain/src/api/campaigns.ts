import { z } from 'zod';
import { AppError, notFound } from '@w360/core';
import {
  CAMPAIGN_COMPLETION_REASONS,
  CAMPAIGN_PAUSE_REASONS,
  CAMPAIGN_STATUSES,
  MESSAGE_STATUSES,
  RECIPIENT_STATES,
  SKIP_REASONS,
  and,
  campaigns,
  channelAccounts,
  desc,
  eq,
  exactTimestamp,
  messageTemplates,
  sql,
  type MessageStatus,
  type CampaignStatus,
  type RecipientState,
  type SkipReason,
  type SQL,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { ATTRIBUTION_WINDOW_HOURS } from '../campaigns/attribution';
import { RECIPIENT_OUTCOMES, RECIPIENT_OUTCOME_SQL } from '../campaigns/outcomes';
import {
  campaignResultsSchema,
  toCampaignResults,
  type CampaignResults,
} from '../campaigns/results';
import {
  campaignAnalytics,
  campaignLauncherStanding,
  cancelLockedCampaign,
  lockCampaign,
  pauseLockedCampaign,
  resumeLockedCampaign,
} from '../campaigns/service';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { apiActor, assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * Campaigns through the public API (ADR-125): a key with `campaigns.read` lists the company's
 * campaigns, newest first, as the campaign events describe them (ADR-087), and reads one with its
 * results as members' campaign page counts them (`campaignAnalytics`), when it is read. A key that
 * also reads contacts lists a campaign's recipients, each with what happened to it (ADR-127).
 * Never members or costs. A key with `campaigns.stop` pauses and cancels campaigns as members do
 * (ADR-128); everything else that changes a campaign stays with members.
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
      'Why it paused, while it is paused: a member paused it (manual), an API key did (api), the spending or message cap was reached, the template is no longer approved, the number is not active, the member whose authority it runs under left or lost the permission, or no rate card is published for its spending cap. Null otherwise.',
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

/** The results `GET /campaigns/{id}` answers, as campaign events carry them too (ADR-150). */
export const apiCampaignResultsSchema = campaignResultsSchema;
export type ApiCampaignResults = CampaignResults;

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
    // Given while the campaign is paused, as described: a cancelled campaign keeps the column.
    pauseReason: row.status === 'paused' ? row.pauseReason : null,
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
      return { ...toApiCampaign(row), results: toCampaignResults(counted) };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export const apiCampaignRecipientQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z
      .uuid({ error: 'Invalid cursor: give the nextCursor of the previous page.' })
      .optional()
      .describe('`nextCursor` from the previous page.'),
    outcome: z
      .enum(RECIPIENT_OUTCOMES)
      .optional()
      .describe(
        'Only the recipients one count of the campaign’s results counts (GET /campaigns/{id}): in_progress is inProgress, message_canceled messagesCanceled and opted_out optedOut. Recipients whose contact was erased are never listed.',
      ),
  })
  .strict();

const attributed = (what: string, from: string) =>
  `When ${what} was counted for the recipient’s message: it counts once, for the last campaign message (of any campaign) queued to the contact${from} in the ${ATTRIBUTION_WINDOW_HOURS} hours before it, if WhatsApp had accepted that message. The results count it once the message is delivered.`;

export const apiCampaignRecipientSchema = z.object({
  id: z.uuid(),
  contact: z.object({
    id: z.uuid(),
    name: z.string().nullable(),
    phone: z.string().nullable().describe('E.164, like +919876543210.'),
  }),
  state: z
    .enum(RECIPIENT_STATES)
    .describe(
      'pending: not processed yet; queued: its message was queued; skipped: not sent, for skipReason; canceled: the campaign was canceled before its turn, or before its queued message was sent.',
    ),
  skipReason: z.enum(SKIP_REASONS).nullable().describe('Why it was skipped; null otherwise.'),
  message: z
    .object({
      id: z.uuid(),
      status: z.enum(MESSAGE_STATUSES),
      statusAt: z.iso.datetime().describe('When the message reached its status.'),
      error: z
        .object({ code: z.string().nullable(), title: z.string().nullable() })
        .nullable()
        .describe(
          'Why the message failed or was not sent: WhatsApp’s error code and title, or HyFib’s reason (like campaign_canceled) for one canceled before it was sent.',
        ),
    })
    .nullable()
    .describe('The message queued for the recipient; null until it is queued.'),
  queuedAt: z.iso.datetime().nullable(),
  repliedAt: z.iso
    .datetime()
    .nullable()
    .describe(attributed('a reply', ' from the number the reply came to')),
  optedOutAt: z.iso.datetime().nullable().describe(attributed('an opt-out from marketing', '')),
});
export type ApiCampaignRecipient = z.infer<typeof apiCampaignRecipientSchema>;

type RecipientRow = {
  id: string;
  contact_id: string;
  display_name: string | null;
  phone_e164: string | null;
  state: RecipientState;
  skip_reason: SkipReason | null;
  message_id: string | null;
  message_status: MessageStatus | null;
  message_status_at: string | Date | null;
  error_code: string | null;
  error_title: string | null;
  queued_at: string | Date | null;
  replied_at: string | Date | null;
  opted_out_at: string | Date | null;
};

const iso = (value: string | Date | null) => (value ? new Date(value).toISOString() : null);

function toApiRecipient(r: RecipientRow): ApiCampaignRecipient {
  const statusAt = iso(r.message_status_at);
  return {
    id: r.id,
    contact: { id: r.contact_id, name: r.display_name, phone: r.phone_e164 },
    state: r.state,
    skipReason: r.skip_reason,
    message:
      r.message_id && r.message_status && statusAt
        ? {
            id: r.message_id,
            status: r.message_status,
            statusAt,
            error:
              r.error_code || r.error_title ? { code: r.error_code, title: r.error_title } : null,
          }
        : null,
    queuedAt: iso(r.queued_at),
    repliedAt: iso(r.replied_at),
    optedOutAt: iso(r.opted_out_at),
  };
}

/**
 * The recipients of one of the company's campaigns by id, on keyset pages: a campaign's recipients
 * are taken once, when it is submitted, so paging never skips or repeats one. `outcome` keeps the
 * recipients one count of its results counts, with the count's own condition. Recipients whose
 * contact was erased are left out, as the API leaves erased contacts out everywhere.
 */
export async function apiListCampaignRecipients(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  campaignId: string,
  query: unknown,
): Promise<{ data: ApiCampaignRecipient[]; nextCursor: string | null }> {
  assertScope(ctx, 'campaigns.read');
  assertScope(ctx, 'contacts.read');
  if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
  const q = parseInput(apiCampaignRecipientQuerySchema, query);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const [campaign] = await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.tenantId, ctx.tenant.id), eq(campaigns.id, campaignId)));
      if (!campaign) throw notFound('Campaign');
      const res = await tx.execute<RecipientRow>(sql`
        select r.id, r.contact_id, c.display_name, c.phone_e164, r.state, r.skip_reason,
               r.message_id, m.status as message_status, m.status_at as message_status_at,
               m.error_code, m.error_title, r.queued_at, r.replied_at, r.opted_out_at
          from app.campaign_recipients r
          join app.contacts c on c.tenant_id = r.tenant_id and c.id = r.contact_id
          left join app.messages m on m.tenant_id = r.tenant_id and m.id = r.message_id
         where r.tenant_id = ${ctx.tenant.id} and r.campaign_id = ${campaignId}
           and c.erased_at is null
           ${q.outcome ? sql`and ${RECIPIENT_OUTCOME_SQL[q.outcome]}` : sql``}
           ${q.cursor ? sql`and r.id > ${q.cursor}::uuid` : sql``}
         order by r.id
         limit ${q.limit + 1}`);
      const shown = res.rows.slice(0, q.limit);
      return {
        data: shown.map(toApiRecipient),
        nextCursor: res.rows.length > q.limit ? (shown.at(-1)?.id ?? null) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** The campaign as `GET /campaigns/{id}` describes it, without its results. */
async function readApiCampaign(tx: Tx, tenantId: string, campaignId: string): Promise<ApiCampaign> {
  const [row] = await selectCampaigns(
    tx,
    and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)),
  );
  if (!row) throw new Error('The campaign was not found after changing it');
  return toApiCampaign(row);
}

/** A refusal that names the campaign's status, as `status` gives it. */
const statusRefusal = (message: string, status: CampaignStatus) =>
  new AppError('conflict', `${message} This campaign's status is ${status}.`);

/**
 * Pauses one of the company's campaigns as members pause it (ADR-128), with the campaign row
 * locked: a scheduled or running campaign pauses with the reason `api`, sends no worker claimed are
 * released and their recipients wait again. A paused campaign is answered as it is, whatever paused
 * it, so a retry changes nothing; any other status is refused with 409, naming it. Members resume it
 * in the app, and keys with `campaigns.resume` (ADR-176).
 */
export async function apiPauseCampaign(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  campaignId: string,
): Promise<ApiCampaign> {
  assertScope(ctx, 'campaigns.stop');
  if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
  return deps.db.run(ctx.scope, async (tx) => {
    const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
    if (c.status === 'scheduled' || c.status === 'running') {
      const { released } = await pauseLockedCampaign(
        tx,
        ctx.tenant.id,
        campaignId,
        { apiKeyId: ctx.key.id },
        deps.clock.now(),
      );
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'campaign.paused',
          subjectType: 'campaign',
          subjectId: campaignId,
          metadata: { reason: 'api', released, source: 'api' },
          correlationId: ctx.requestId,
        },
        apiActor(ctx),
      );
    } else if (c.status !== 'paused') {
      throw statusRefusal('Only a scheduled or running campaign can be paused.', c.status);
    }
    return readApiCampaign(tx, ctx.tenant.id, campaignId);
  });
}

/**
 * Resumes one of the company's campaigns that a key paused (ADR-176), with the campaign row locked:
 * a campaign paused with the reason `api` runs again, or waits for its scheduled time, after the
 * checks members' resuming makes, and keeps sending under the authority of the member who launched
 * it, who must still be allowed to send campaigns. A scheduled or running campaign is answered as it
 * is, so a retry changes nothing; a campaign a member or HyFib paused is refused with 409, naming
 * why (members resume it in the app), and so is any other status.
 */
export async function apiResumeCampaign(
  deps: OutboundDeps,
  ctx: ApiContext,
  campaignId: string,
): Promise<ApiCampaign> {
  assertScope(ctx, 'campaigns.resume');
  if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
  return deps.db.run(ctx.scope, async (tx) => {
    const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
    if (c.status === 'paused') {
      if (c.pauseReason !== 'api') {
        throw new AppError(
          'conflict',
          `Only a campaign a key paused is resumed through the API: members resume this one in the app. This campaign's pauseReason is ${c.pauseReason ?? 'unknown'}.`,
        );
      }
      if ((await campaignLauncherStanding(tx, ctx.tenant.id, c.launchedByUserId)) !== 'permitted') {
        throw new AppError(
          'precondition_failed',
          'The member who launched this campaign can no longer send campaigns, so it is not resumed through the API: a member who can resumes it in the app.',
        );
      }
      await resumeLockedCampaign(deps, tx, c, { apiKeyId: ctx.key.id }, deps.clock.now());
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'campaign.resumed',
          subjectType: 'campaign',
          subjectId: campaignId,
          metadata: { source: 'api' },
          correlationId: ctx.requestId,
        },
        apiActor(ctx),
      );
    } else if (c.status !== 'scheduled' && c.status !== 'running') {
      throw statusRefusal('Only a paused campaign can be resumed.', c.status);
    }
    return readApiCampaign(tx, ctx.tenant.id, campaignId);
  });
}

/**
 * Cancels one of the company's campaigns as members cancel it (ADR-128), with the campaign row
 * locked: one waiting for approval, scheduled, running or paused is cancelled, with its waiting
 * recipients and the sends no worker claimed. A cancelled or completed campaign is answered as it
 * is, so a retry changes nothing; a draft, which sends nothing until a member submits it, is
 * refused with 409.
 */
export async function apiCancelCampaign(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  campaignId: string,
): Promise<ApiCampaign> {
  assertScope(ctx, 'campaigns.stop');
  if (!z.uuid().safeParse(campaignId).success) throw notFound('Campaign');
  return deps.db.run(ctx.scope, async (tx) => {
    const c = await lockCampaign(tx, ctx.tenant.id, campaignId);
    if (c.status === 'draft') {
      throw statusRefusal(
        'A draft sends nothing until a member submits it, so it is not cancelled through the API: members edit or cancel drafts in the app.',
        c.status,
      );
    }
    if (c.status !== 'canceled' && c.status !== 'completed') {
      const counts = await cancelLockedCampaign(
        tx,
        ctx.tenant.id,
        campaignId,
        { apiKeyId: ctx.key.id },
        deps.clock.now(),
      );
      await recordSystemAudit(
        tx,
        ctx.tenant.id,
        {
          action: 'campaign.canceled',
          subjectType: 'campaign',
          subjectId: campaignId,
          metadata: { ...counts, source: 'api' },
          correlationId: ctx.requestId,
        },
        apiActor(ctx),
      );
    }
    return readApiCampaign(tx, ctx.tenant.id, campaignId);
  });
}
