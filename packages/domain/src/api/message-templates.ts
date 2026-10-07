import { z } from 'zod';
import { notFound } from '@w360/core';
import {
  and,
  channelAccounts,
  desc,
  eq,
  exactTimestamp,
  messageTemplates,
  sql,
  templateStatusEvents,
  TEMPLATE_STATUSES,
  type TemplateStatus,
  type Tx,
} from '@w360/db';
import type { OutboundDeps } from '../messaging/outbound';
import {
  sendSpecFor,
  type TemplateDefinition,
  type TemplateHeaderMedia,
} from '../templates/definition';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * Message templates of every status through the public API (ADR-294): the company's templates as
 * the Templates page lists them, drafts and those Meta reviews or reviewed, with their review
 * status and history, read by keys with `templates.read`, which listed only the approved templates
 * a send can use (GET /templates).
 */

/** How many status changes a template's read gives, newest first, as Settings shows them. */
export const MESSAGE_TEMPLATE_HISTORY = 50;

/** A message template of any status, as the API gives it. */
export interface ApiMessageTemplate {
  id: string;
  name: string;
  language: string;
  category: 'marketing' | 'utility' | 'authentication';
  status: TemplateStatus;
  /** Meta's reason for rejecting it, as Meta gave it. */
  rejectionReason: string | null;
  /** Meta's quality rating of an approved template, as Meta gave it. */
  qualityScore: string | null;
  /** Why HyFib could not submit it, while its status is `submit_failed`. */
  submitError: string | null;
  /** `local`: added in HyFib; `synced`: found at Meta, added in WhatsApp Manager. */
  origin: 'local' | 'synced';
  /** Who added it in HyFib: a member (never which) or a key (ADR-295); null when found at Meta. */
  createdBy: 'member' | 'api' | null;
  createdByApiKeyId: string | null;
  /** Changes with every change HyFib records. */
  version: number;
  /** Whether a send can use it now: as GET /templates lists the approved templates. */
  sendable: boolean;
  /** Why HyFib cannot send it or show its content, when it cannot. */
  unsupportedReason: string | null;
  /** Its content as HyFib represents it; null when HyFib cannot (`unsupportedReason`). */
  definition: TemplateDefinition | null;
  /** The file its header takes when sent (ADR-201), or null. */
  headerMedia: TemplateHeaderMedia | null;
  /** The active numbers of its WhatsApp Business account, which send it once approved. */
  channels: { id: string; phone: string | null }[];
  submittedAt: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A template with its latest status changes, newest first. */
export type ApiMessageTemplateDetail = ApiMessageTemplate & { history: ApiMessageTemplateChange[] };

/** A change of a template's status, newest first. */
export interface ApiMessageTemplateChange {
  status: string;
  /** Meta's reason, or HyFib's, when one was given. */
  reason: string | null;
  /** `submit`: sent for review; `sync`: read from Meta; `send`: refused by Meta on a send; `delete`. */
  source: 'submit' | 'sync' | 'send' | 'delete';
  occurredAt: string;
}

/** What `GET /message-templates` takes. */
export const apiMessageTemplateListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    status: z
      .enum(TEMPLATE_STATUSES)
      .optional()
      .describe('Only the templates in this status; deleted ones are listed only so.'),
    channelId: z
      .uuid()
      .optional()
      .describe('Only the templates this number can send: its WhatsApp Business account’s.'),
    name: z.string().trim().min(1).max(512).optional().describe('Only the templates of this name.'),
  })
  .strict();

const templateColumns = {
  id: messageTemplates.id,
  whatsappAccountId: messageTemplates.whatsappAccountId,
  name: messageTemplates.name,
  language: messageTemplates.language,
  category: messageTemplates.category,
  status: messageTemplates.status,
  components: messageTemplates.components,
  rejectionReason: messageTemplates.rejectionReason,
  qualityScore: messageTemplates.qualityScore,
  submitError: messageTemplates.submitError,
  origin: messageTemplates.origin,
  createdByUserId: messageTemplates.createdByUserId,
  createdByApiKeyId: messageTemplates.createdByApiKeyId,
  version: messageTemplates.version,
  submittedAt: messageTemplates.submittedAt,
  lastSyncedAt: messageTemplates.lastSyncedAt,
  createdAt: messageTemplates.createdAt,
  updatedAt: messageTemplates.updatedAt,
  cursorAt: exactTimestamp(messageTemplates.createdAt),
};

type TemplateRow = {
  id: string;
  whatsappAccountId: string;
  name: string;
  language: string;
  category: string;
  status: TemplateStatus;
  components: unknown[];
  rejectionReason: string | null;
  qualityScore: string | null;
  submitError: string | null;
  origin: 'local' | 'synced';
  createdByUserId: string | null;
  createdByApiKeyId: string | null;
  version: number;
  submittedAt: Date | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A template row as the API gives it, with the active numbers of its account. */
export function toApiMessageTemplate(
  row: TemplateRow,
  numbers: { id: string; phone: string | null; whatsappAccountId: string }[],
): ApiMessageTemplate {
  // As GET /templates reads them: a send gives the file of a photo, video or document header.
  const spec = sendSpecFor(row.category, row.components, { mediaHeaders: true });
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    category: row.category.toLowerCase() as ApiMessageTemplate['category'],
    status: row.status,
    rejectionReason: row.rejectionReason,
    qualityScore: row.qualityScore,
    submitError: row.submitError,
    origin: row.origin,
    createdBy: row.createdByApiKeyId ? 'api' : row.createdByUserId ? 'member' : null,
    createdByApiKeyId: row.createdByApiKeyId,
    version: row.version,
    sendable: row.status === 'approved' && spec.supported,
    unsupportedReason: spec.supported ? null : spec.reason,
    definition: spec.supported ? spec.definition : null,
    headerMedia: spec.supported ? spec.headerMedia : null,
    channels: numbers
      .filter((n) => n.whatsappAccountId === row.whatsappAccountId)
      .map((n) => ({ id: n.id, phone: n.phone })),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The company's active numbers, with their WhatsApp Business accounts. */
export function activeNumbers(tx: Tx, tenantId: string) {
  return tx
    .select({
      id: channelAccounts.id,
      phone: channelAccounts.displayPhoneNumber,
      whatsappAccountId: channelAccounts.whatsappAccountId,
    })
    .from(channelAccounts)
    .where(and(eq(channelAccounts.tenantId, tenantId), eq(channelAccounts.status, 'active')));
}

/**
 * The company's templates of every status but deleted, newest first by when HyFib added them, on
 * exact pages. Reading works while the company is suspended.
 */
export async function apiListMessageTemplates(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiMessageTemplate[]; nextCursor: string | null }> {
  assertScope(ctx, 'templates.read');
  const q = parseInput(apiMessageTemplateListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      let account: string | undefined;
      if (q.channelId) {
        const [channel] = await tx
          .select({ whatsappAccountId: channelAccounts.whatsappAccountId })
          .from(channelAccounts)
          .where(
            and(eq(channelAccounts.tenantId, ctx.tenant.id), eq(channelAccounts.id, q.channelId)),
          );
        // Another company's number, or none, has no templates here.
        if (!channel) return { data: [], nextCursor: null };
        account = channel.whatsappAccountId;
      }
      const rows = await tx
        .select(templateColumns)
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.tenantId, ctx.tenant.id),
            q.status
              ? eq(messageTemplates.status, q.status)
              : sql`${messageTemplates.status} <> 'deleted'`,
            account ? eq(messageTemplates.whatsappAccountId, account) : undefined,
            q.name ? eq(messageTemplates.name, q.name) : undefined,
            cursor
              ? sql`(${messageTemplates.createdAt}, ${messageTemplates.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(messageTemplates.createdAt), desc(messageTemplates.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const numbers = shown.length > 0 ? await activeNumbers(tx, ctx.tenant.id) : [];
      const last = shown.at(-1);
      return {
        data: shown.map((row) => toApiMessageTemplate(row, numbers)),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/** A template of any status as the API gives it, with its latest status changes, or null. */
export async function readApiMessageTemplate(
  tx: Tx,
  tenantId: string,
  templateId: string,
): Promise<ApiMessageTemplateDetail | null> {
  const [row] = await tx
    .select(templateColumns)
    .from(messageTemplates)
    .where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, templateId)));
  if (!row) return null;
  const history = await tx
    .select({
      status: templateStatusEvents.status,
      reason: templateStatusEvents.reason,
      source: templateStatusEvents.source,
      occurredAt: templateStatusEvents.occurredAt,
    })
    .from(templateStatusEvents)
    .where(
      and(
        eq(templateStatusEvents.tenantId, tenantId),
        eq(templateStatusEvents.templateId, templateId),
      ),
    )
    .orderBy(desc(templateStatusEvents.occurredAt), desc(templateStatusEvents.id))
    .limit(MESSAGE_TEMPLATE_HISTORY);
  return {
    ...toApiMessageTemplate(row, await activeNumbers(tx, tenantId)),
    history: history.map((h) => ({
      status: h.status,
      reason: h.reason,
      source: h.source,
      occurredAt: h.occurredAt.toISOString(),
    })),
  };
}

/**
 * One of the company's templates, of any status, deleted included, with its latest status changes;
 * another company's answers 404, as an unknown one does.
 */
export async function apiGetMessageTemplate(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  templateId: string,
): Promise<ApiMessageTemplateDetail> {
  assertScope(ctx, 'templates.read');
  if (!z.uuid().safeParse(templateId).success) throw notFound('Template');
  const found = await deps.db.run(
    ctx.scope,
    (tx) => readApiMessageTemplate(tx, ctx.tenant.id, templateId),
    { accessMode: 'read only' },
  );
  if (!found) throw notFound('Template');
  return found;
}
