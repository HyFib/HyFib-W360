import 'server-only';
import { can, currentEventCursor, normalizeTag, type TenantContext } from '@w360/domain';
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/** Parses the list filters from the URL (untrusted; the service validates them again). */
export function parseInboxQuery(ctx: TenantContext, sp: SearchParams): InboxQuery {
  const views: InboxQuery['view'][] = ['mine', 'unassigned', 'all'];
  const view = views.find((v) => v === sp.view) ?? (can(ctx, 'inbox.read_all') ? 'all' : 'mine');
  const status: InboxQuery['status'] = sp.status === 'resolved' ? 'resolved' : 'open';
  const team = one(sp.team);
  const channel = one(sp.channel);
  // Written as tags are, so the filter's choice shows it; a value that cannot be a tag is dropped.
  const tag = normalizeTag(one(sp.tag)?.slice(0, 100) ?? '');
  const q = one(sp.q)?.trim().slice(0, 100);
  return {
    view,
    status,
    ...(team && (team === 'none' || UUID.test(team)) ? { team } : {}),
    ...(channel && UUID.test(channel) ? { channel } : {}),
    ...(tag.ok ? { tag: tag.tag } : {}),
    ...(q ? { q } : {}),
    order: sp.order === 'waiting' && status === 'open' ? 'waiting' : 'recent',
  };
}

/** Loads one page of conversations, the filter options and the member's inbox state. */
export async function loadInboxList(ctx: TenantContext, sp: SearchParams) {
  const query = parseInboxQuery(ctx, sp);
  const views: InboxQuery['view'][] = ['mine', 'unassigned', 'all'];
  const cursor = one(sp.cursor);
  const { inbox, teams, conversationTags } = await getRuntime();
  const renderedAt = new Date().toISOString();
  const [list, teamOptions, channelOptions, tags, mentions, available, waiting] = await Promise.all(
    [
      inbox.listConversations(ctx, { ...query, ...(cursor ? { cursor } : {}) }),
      teams.teamOptions(ctx),
      can(ctx, 'channels.read') ? teams.channelOptions(ctx) : Promise.resolve([]),
      conversationTags.tagsInUse(ctx),
      inbox.unreadMentionCount(ctx),
      can(ctx, 'inbox.reply') ? teams.getAvailability(ctx) : Promise.resolve(null),
      // The notice of overdue replies (ADR-241) counts these against the clock in the browser.
      inbox.waitingReplies(ctx),
    ],
  );
  return {
    query,
    views,
    list,
    waiting: { ...waiting, renderedAt },
    filters: {
      teams: teamOptions,
      channels: channelOptions.map((c) => ({ id: c.id, label: c.label })),
      tags: tags.map((t) => t.tag),
    },
    unreadMentions: mentions,
    available,
  };
}
