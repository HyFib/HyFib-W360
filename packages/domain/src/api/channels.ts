import { z } from 'zod';
import {
  and,
  asc,
  CHANNEL_STATUSES,
  channelAccounts,
  eq,
  exactTimestamp,
  sql,
  type ChannelStatus,
} from '@w360/db';
import type { OutboundDeps } from '../messaging/outbound';
import { decodeKeysetCursor, encodeKeysetCursor, parseInput } from '../validation';
import { assertScope, type ApiContext } from './context';
import { API_LIMITS } from './model';

/**
 * The company's WhatsApp numbers through the public API (ADR-171), read with `channels.read`: the
 * ids messages, conversations, orders and webhook events give as `channelId` and sends take as
 * `from`, with each number as WhatsApp shows it, its verified name and its status. Meta's ids,
 * credentials and registration details are never given. Paged oldest first, as members and teams
 * are; a number is never deleted, so a number seen once is listed for as long as the company is.
 */

export const apiChannelListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSize).default(50),
    cursor: z.string().max(200).optional().describe('`nextCursor` from the previous page.'),
    status: z
      .enum(CHANNEL_STATUSES)
      .optional()
      .describe('Only the numbers with this status (`active` for those that send and receive).'),
  })
  .strict();

export interface ApiChannel {
  id: string;
  /** The number as WhatsApp shows it; null until Meta reports it. */
  phone: string | null;
  /** The business name WhatsApp verified for the number; null until Meta reports it. */
  name: string | null;
  status: ChannelStatus;
  /** When the number was added to the company. */
  createdAt: string;
}

export async function apiListChannels(
  deps: Pick<OutboundDeps, 'db'>,
  ctx: ApiContext,
  query: unknown,
): Promise<{ data: ApiChannel[]; nextCursor: string | null }> {
  assertScope(ctx, 'channels.read');
  const q = parseInput(apiChannelListQuerySchema, query);
  const cursor = decodeKeysetCursor(q.cursor);
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const rows = await tx
        .select({
          id: channelAccounts.id,
          phone: channelAccounts.displayPhoneNumber,
          name: channelAccounts.verifiedName,
          status: channelAccounts.status,
          createdAt: channelAccounts.createdAt,
          cursorAt: exactTimestamp(channelAccounts.createdAt),
        })
        .from(channelAccounts)
        .where(
          and(
            eq(channelAccounts.tenantId, ctx.tenant.id),
            q.status ? eq(channelAccounts.status, q.status) : undefined,
            cursor
              ? sql`(${channelAccounts.createdAt}, ${channelAccounts.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(channelAccounts.createdAt), asc(channelAccounts.id))
        .limit(q.limit + 1);
      const shown = rows.slice(0, q.limit);
      const last = shown.at(-1);
      return {
        data: shown.map((r) => ({
          id: r.id,
          phone: r.phone,
          name: r.name,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
        nextCursor:
          rows.length > q.limit && last ? encodeKeysetCursor(last.cursorAt, last.id) : null,
      };
    },
    { accessMode: 'read only' },
  );
}
