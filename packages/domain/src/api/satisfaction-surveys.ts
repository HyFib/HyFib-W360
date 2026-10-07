import { z } from 'zod';
import {
  and,
  contacts,
  conversations,
  csatSurveys,
  desc,
  eq,
  isNotNull,
  isNull,
  messages,
  sql,
} from '@w360/db';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';
import {
  SATISFACTION_SURVEY_STATUSES,
  satisfactionSurveyColumns,
  toApiSatisfactionSurvey,
  type ApiSatisfactionSurvey,
} from './satisfaction-survey-view';

/**
 * Satisfaction surveys through the public API (ADR-292): the surveys HyFib sent, or chose not to
 * send, when members resolved conversations, and the customers' answers, read by keys that read
 * conversations, which already read the survey messages and the taps answering them.
 */

/** What `GET /satisfaction-surveys` takes. */
export const apiSatisfactionSurveyQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    conversationId: z.uuid().optional().describe('Only this conversation’s surveys.'),
    status: z
      .enum(SATISFACTION_SURVEY_STATUSES)
      .optional()
      .describe('Only the surveys in this status.'),
    createdSince: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('Only the surveys sent or skipped at or after this time.'),
  })
  .strict();

/**
 * The company's satisfaction surveys, newest first on exact pages, without those of erased
 * contacts' conversations, as the conversations they belong to are hidden.
 */
export async function apiListSatisfactionSurveys(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiSatisfactionSurvey[]; nextCursor: string | null }> {
  assertScope(ctx, 'conversations.read');
  const q = parseInput(apiSatisfactionSurveyQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select(satisfactionSurveyColumns)
        .from(csatSurveys)
        .innerJoin(
          conversations,
          and(
            eq(conversations.tenantId, csatSurveys.tenantId),
            eq(conversations.id, csatSurveys.conversationId),
          ),
        )
        .innerJoin(
          contacts,
          and(
            eq(contacts.tenantId, conversations.tenantId),
            eq(contacts.id, conversations.contactId),
            isNull(contacts.erasedAt),
          ),
        )
        .leftJoin(
          messages,
          and(eq(messages.tenantId, csatSurveys.tenantId), eq(messages.id, csatSurveys.messageId)),
        )
        .where(
          and(
            eq(csatSurveys.tenantId, ctx.tenant.id),
            q.conversationId ? eq(csatSurveys.conversationId, q.conversationId) : undefined,
            q.status === 'skipped' ? isNotNull(csatSurveys.skipReason) : undefined,
            q.status === 'asked'
              ? and(isNull(csatSurveys.skipReason), isNull(csatSurveys.answeredAt))
              : undefined,
            q.status === 'answered' ? isNotNull(csatSurveys.answeredAt) : undefined,
            q.createdSince
              ? sql`${csatSurveys.createdAt} >= ${q.createdSince}::timestamptz`
              : undefined,
            cursor
              ? sql`(${csatSurveys.createdAt}, ${csatSurveys.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(csatSurveys.createdAt), desc(csatSurveys.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map(toApiSatisfactionSurvey),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}
