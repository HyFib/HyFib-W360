import 'server-only';
import { can, type TenantContext } from '@w360/domain';
import type { InboxQuery } from '@/components/inbox/inbox-shell';
import { getRuntime } from './runtime';

export type SearchParams = Record<string, string | string[] | undefined>;

export function canUseInbox(ctx: TenantContext): boolean {
  return can(ctx, 'inbox.read_all') || can(ctx, 'inbox.read_assigned');
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
