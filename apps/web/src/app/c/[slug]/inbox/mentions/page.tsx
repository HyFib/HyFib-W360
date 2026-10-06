import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, EmptyState } from '@w360/ui';
import { cn } from '@w360/ui/cn';
import { InboxShell } from '@/components/inbox/inbox-shell';
import { formatShort } from '@/lib/format';
import { canUseInbox, liveEventCursor, loadInboxList } from '@/server/inbox';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Mentions' };
export const dynamic = 'force-dynamic';

/** Notes that mention the current member, in conversations they can still see. */
export default async function MentionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!canUseInbox(ctx)) notFound();
  const since = await liveEventCursor(ctx);
  const { inbox } = await getRuntime();
  const [{ query, views, filters, unreadMentions, available, waiting }, mentions] =
    await Promise.all([loadInboxList(ctx, {}), inbox.listMentions(ctx)]);
  const tz = ctx.tenant.timezone;
  const list =
    mentions.length === 0 ? (
      <EmptyState
        title="No mentions"
        description="When someone mentions you in an internal note, it appears here."
      />
    ) : (
      <ul className="grid gap-1" aria-label="Mentions">
        {mentions.map((m) => (
          <li key={m.id}>
            <Link
              href={`/c/${ctx.tenant.slug}/inbox/${m.conversationId}`}
              className={cn(
                'grid gap-1 rounded-md border border-transparent px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                !m.readAt && 'border-border',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className={cn('truncate', !m.readAt ? 'font-semibold' : 'font-medium')}>
                  {m.contactName ?? m.contactPhone ?? 'Unknown contact'}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatShort(m.createdAt, tz)}
                </span>
              </span>
              <span className="line-clamp-2 text-muted-foreground">
                {m.authorName}: {m.body}
              </span>
              {!m.readAt ? (
                <span>
                  <Badge tone="info">New</Badge>
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    );
  return (
    <InboxShell
      slug={ctx.tenant.slug}
      since={since}
      query={query}
      views={views}
      items={[]}
      nextCursor={null}
      timeZone={tz}
      filters={filters}
      unreadMentions={unreadMentions}
      available={available}
      waiting={waiting}
      mentionsActive
      list={list}
    >
      <div className="hidden lg:block">
        <EmptyState
          title="Select a mention"
          description="Open a mention to read the note in its conversation."
        />
      </div>
    </InboxShell>
  );
}
