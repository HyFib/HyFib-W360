import type { Metadata } from 'next';
import { Alert, EmptyState } from '@w360/ui';
import { InboxShell } from '@/components/inbox/inbox-shell';
import { canUseInbox, liveEventCursor, loadInboxList, type SearchParams } from '@/server/inbox';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Inbox' };
export const dynamic = 'force-dynamic';

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!canUseInbox(ctx)) {
    return (
      <Alert tone="warning" title="No inbox access">
        Your role does not include the shared inbox.
      </Alert>
    );
  }
  const since = await liveEventCursor(ctx);
  const { query, views, list, filters, unreadMentions, available } = await loadInboxList(
    ctx,
    await searchParams,
  );
  return (
    <InboxShell
      slug={ctx.tenant.slug}
      since={since}
      query={query}
      views={views}
      items={list.items}
      nextCursor={list.nextCursor}
      timeZone={ctx.tenant.timezone}
      filters={filters}
      unreadMentions={unreadMentions}
      available={available}
    >
      <div className="hidden lg:block">
        <EmptyState
          title="Select a conversation"
          description="Choose a conversation to read the thread and reply."
        />
      </div>
    </InboxShell>
  );
}
