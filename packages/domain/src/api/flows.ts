import { z } from 'zod';
import {
  FLOW_META_STATUSES,
  and,
  desc,
  eq,
  exactTimestamp,
  flowResponses,
  flows,
  isNotNull,
  isNull,
  sql,
  type FlowAnswerOutcome,
} from '@w360/db';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { assertScope, hasScope, type ApiContext } from './context';
import { activeNumbers } from './message-templates';
import { API_LIMITS } from './model';

/**
 * WhatsApp Flows and the forms customers completed with them, through the public API (ADR-298),
 * read with `flows.read`: the company's flows as the Flows page lists them, and their responses
 * newest first on exact pages. Who completed a form and what they typed are given only to keys with
 * `contacts.read` too, as the page shows them only to members with that permission.
 */

/** A flow's status at Meta, lower case. */
export const API_FLOW_STATUSES = FLOW_META_STATUSES.map((s) => s.toLowerCase()) as Lowercase<
  (typeof FLOW_META_STATUSES)[number]
>[];

/** A JSON value, as a customer's completed form gave it. */
export type ApiJsonValue =
  string | number | boolean | null | ApiJsonValue[] | { [key: string]: ApiJsonValue };

function isJsonValue(value: unknown): value is ApiJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(isJsonValue)
  );
}

/** Any JSON value; the OpenAPI document names it `JsonValue`. */
export const apiJsonValueSchema = z.custom<ApiJsonValue>(isJsonValue, 'Expected a JSON value.');

/** A WhatsApp Flow as the API gives it. */
export interface ApiFlow {
  id: string;
  name: string;
  /** Meta's status, lower case; null before HyFib has created it at Meta. */
  status: (typeof API_FLOW_STATUSES)[number] | null;
  categories: string[];
  /** The keys of the answers a completed form returns. */
  answerKeys: string[];
  /** Where each answer goes on the contact: `name`, `email` or `field:<custom field key>`. */
  answerMapping: { key: string; target: string }[];
  /** The company's active numbers that can send it: those of its WhatsApp Business account. */
  channels: { id: string; phone: string | null }[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A completed form as the API gives it. */
export interface ApiFlowResponse {
  id: string;
  /** The flow, or null when its token matched no form HyFib sent. */
  flowId: string | null;
  /** Who completed it, null for keys without `contacts.read` (as are the next three). */
  contactId: string | null;
  conversationId: string | null;
  /** The customer's message that completed the form, among the conversation's messages. */
  messageId: string | null;
  /** The answers by key, as the customer gave them. */
  answers: Record<string, ApiJsonValue> | null;
  /** What each mapped answer did to the contact. */
  applied: {
    key: string;
    target: string;
    outcome: FlowAnswerOutcome['outcome'];
    message: string | null;
  }[];
  receivedAt: string;
}

/** A flow, as the OpenAPI document describes it. */
export const apiFlowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z
    .enum(API_FLOW_STATUSES)
    .nullable()
    .describe(
      'Meta’s status: `draft` until published, then `published`, `deprecated`, `blocked` or `throttled`; null before HyFib has created it at Meta.',
    ),
  categories: z.array(z.string()).describe('Meta’s categories, as members chose them.'),
  answerKeys: z.array(z.string()).describe('The keys of the answers a completed form returns.'),
  answerMapping: z
    .array(z.object({ key: z.string(), target: z.string() }))
    .describe(
      'Where each answer goes on the contact when a form is completed: `name`, `email` or `field:<custom field key>`.',
    ),
  channels: z
    .array(z.object({ id: z.uuid(), phone: z.string().nullable() }))
    .describe('The company’s active numbers that can send it: its WhatsApp Business account’s.'),
  archived: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** A completed form, as the OpenAPI document describes it. */
export const apiFlowResponseSchema = z.object({
  id: z.uuid(),
  flowId: z
    .uuid()
    .nullable()
    .describe('The flow; null when the form’s token matched no form HyFib sent.'),
  contactId: z
    .uuid()
    .nullable()
    .describe('The contact who completed it; null for keys without `contacts.read`.'),
  conversationId: z
    .uuid()
    .nullable()
    .describe('The conversation it was completed in; null for keys without `contacts.read`.'),
  messageId: z
    .uuid()
    .nullable()
    .describe(
      'The customer’s message that completed the form, among the conversation’s messages; null for keys without `contacts.read`.',
    ),
  answers: z
    .record(z.string(), apiJsonValueSchema)
    .nullable()
    .describe(
      'The answers by key, as the customer gave them; null for keys without `contacts.read`.',
    ),
  applied: z
    .array(
      z.object({
        key: z.string(),
        target: z.string(),
        outcome: z
          .enum(['applied', 'missing', 'invalid', 'skipped'])
          .describe(
            '`applied` to the contact; `missing` from the answers; `invalid` for the target (see `message`); `skipped`, for example when another contact completed the form.',
          ),
        message: z.string().nullable(),
      }),
    )
    .describe(
      'What each mapped answer did to the contact; key and target `*` for the whole form when none was applied.',
    ),
  receivedAt: z.iso.datetime(),
});

/** What `GET /flows` takes. */
export const apiFlowListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    archived: z
      .enum(['true', 'false'])
      .optional()
      .describe('`true`: only archived flows; otherwise only those in use.'),
  })
  .strict();

/** What `GET /flow-responses` takes. */
export const apiFlowResponseQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    flowId: z.uuid().optional().describe('Only this flow’s responses.'),
    contactId: z
      .uuid()
      .optional()
      .describe('Only this contact’s responses; needs `contacts.read` too.'),
    receivedSince: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('Only the responses received at or after this time.'),
  })
  .strict();

const lower = (status: (typeof FLOW_META_STATUSES)[number] | null) =>
  status === null ? null : (status.toLowerCase() as (typeof API_FLOW_STATUSES)[number]);

/**
 * The company's flows, newest first on exact pages: those in use, or archived ones when asked, with
 * the numbers that can send them. Never the Flow JSON or its endpoint.
 */
export async function apiListFlows(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiFlow[]; nextCursor: string | null }> {
  assertScope(ctx, 'flows.read');
  const q = parseInput(apiFlowListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select({
          id: flows.id,
          whatsappAccountId: flows.whatsappAccountId,
          name: flows.name,
          metaStatus: flows.metaStatus,
          categories: flows.categories,
          answerKeys: flows.answerKeys,
          answerMapping: flows.answerMapping,
          archivedAt: flows.archivedAt,
          createdAt: flows.createdAt,
          updatedAt: flows.updatedAt,
          cursorAt: exactTimestamp(flows.createdAt),
        })
        .from(flows)
        .where(
          and(
            eq(flows.tenantId, ctx.tenant.id),
            q.archived === 'true' ? isNotNull(flows.archivedAt) : isNull(flows.archivedAt),
            cursor
              ? sql`(${flows.createdAt}, ${flows.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(flows.createdAt), desc(flows.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const numbers = shown.length > 0 ? await activeNumbers(tx, ctx.tenant.id) : [];
      const last = shown.at(-1);
      return {
        data: shown.map((r) => ({
          id: r.id,
          name: r.name,
          status: lower(r.metaStatus),
          categories: r.categories,
          answerKeys: r.answerKeys,
          answerMapping: r.answerMapping.map((m) => ({ key: m.key, target: m.target })),
          channels: numbers
            .filter((n) => n.whatsappAccountId === r.whatsappAccountId)
            .map((n) => ({ id: n.id, phone: n.phone })),
          archived: r.archivedAt !== null,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}

/**
 * The forms customers completed, newest first on exact pages, by flow, contact and time. Erasing a
 * contact deletes its responses. Who completed them, and their answers, only with `contacts.read`.
 */
export async function apiListFlowResponses(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiFlowResponse[]; nextCursor: string | null }> {
  assertScope(ctx, 'flows.read');
  const q = parseInput(apiFlowResponseQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  // Members without contacts.read never see who completed a form, so such a key may not ask.
  if (q.contactId) assertScope(ctx, 'contacts.read');
  const withContacts = hasScope(ctx, 'contacts.read');
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select({
          id: flowResponses.id,
          flowId: flowResponses.flowId,
          contactId: flowResponses.contactId,
          conversationId: flowResponses.conversationId,
          messageId: flowResponses.messageId,
          answers: flowResponses.answers,
          applied: flowResponses.applied,
          receivedAt: flowResponses.receivedAt,
          cursorAt: exactTimestamp(flowResponses.receivedAt),
        })
        .from(flowResponses)
        .where(
          and(
            eq(flowResponses.tenantId, ctx.tenant.id),
            q.flowId ? eq(flowResponses.flowId, q.flowId) : undefined,
            q.contactId ? eq(flowResponses.contactId, q.contactId) : undefined,
            q.receivedSince
              ? sql`${flowResponses.receivedAt} >= ${q.receivedSince}::timestamptz`
              : undefined,
            cursor
              ? sql`(${flowResponses.receivedAt}, ${flowResponses.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(flowResponses.receivedAt), desc(flowResponses.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map((r) => ({
          id: r.id,
          flowId: r.flowId,
          contactId: withContacts ? r.contactId : null,
          conversationId: withContacts ? r.conversationId : null,
          messageId: withContacts ? r.messageId : null,
          // Stored as Meta's form gave them, parsed from JSON (flows/responses.ts).
          answers: withContacts ? (r.answers as Record<string, ApiJsonValue>) : null,
          applied: r.applied.map((a) => ({
            key: a.key,
            target: a.target,
            outcome: a.outcome,
            message: a.message ?? null,
          })),
          receivedAt: r.receivedAt.toISOString(),
        })),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}
