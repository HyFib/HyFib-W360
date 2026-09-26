import 'server-only';
import { can, currentEventCursor, type TenantContext } from '@w360/domain';
import type { InboxQuery } from '@/components/inbox/inbox-shell';
import { getRuntime } from './runtime';

export type SearchParams = Record<string, string | string[] | undefined>;

export function canUseInbox(ctx: TenantContext): boolean {
  return can(ctx, 'inbox.read_all') || can(ctx, 'inbox.read_assigned');
}

/**
 * The company event-log position before a page reads its data. The page hands it to LiveEvents so
 * the live stream replays anything that changed after the render, instead of starting "now" and
 * missing events that arrive before the browser connects.
 */
export async function liveEventCursor(ctx: TenantContext): Promise<string> {
  const { db } = await getRuntime();
  return currentEventCursor(db, ctx.scope);
}

/** Parses the list filters from the URL (untrusted) and loads one page of conversations. */
export async function loadInboxList(ctx: TenantContext, sp: SearchParams) {
  const views: InboxQuery['view'][] = ['mine', 'unassigned', 'all'];
  const view = views.find((v) => v === sp.view) ?? (can(ctx, 'inbox.read_all') ? 'all' : 'mine');
  const status: InboxQuery['status'] = sp.status === 'resolved' ? 'resolved' : 'open';
  const cursor = typeof sp.cursor === 'string' ? sp.cursor : undefined;
  const { inbox } = await getRuntime();
  const list = await inbox.listConversations(ctx, { view, status, ...(cursor ? { cursor } : {}) });
  return { query: { view, status } satisfies InboxQuery, views, list };
}
