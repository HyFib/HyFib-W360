import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@w360/ui/cn';
import type { ConversationSummary } from '@w360/domain';
import { ConversationList } from './conversation-list';
import { LiveEvents } from './live-events';

export interface InboxQuery {
  view: 'mine' | 'unassigned' | 'all';
  status: 'open' | 'resolved';
}

export function inboxQueryString(q: InboxQuery): string {
  return `?view=${q.view}&status=${q.status}`;
}

export function InboxShell({
  slug,
  query,
  views,
  items,
  nextCursor,
  activeId,
  timeZone,
  children,
}: {
  slug: string;
  query: InboxQuery;
  views: InboxQuery['view'][];
  items: ConversationSummary[];
  nextCursor: string | null;
  activeId?: string;
  timeZone: string;
  children: ReactNode;
}) {
  const viewLabels = { mine: 'Mine', unassigned: 'Unassigned', all: 'All' } as const;
  const tab = (active: boolean) =>
    cn(
      'rounded-md px-2.5 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-muted',
    );
  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <section
        aria-label="Conversation list"
        className={cn('grid content-start gap-3', activeId && 'hidden lg:grid')}
      >
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
          <LiveEvents slug={slug} {...(activeId ? { conversationId: activeId } : {})} />
        </div>
        <nav aria-label="Inbox views" className="flex flex-wrap gap-1">
          {views.map((v) => (
            <Link
              key={v}
              href={`/c/${slug}/inbox${inboxQueryString({ ...query, view: v })}`}
              aria-current={query.view === v ? 'page' : undefined}
              className={tab(query.view === v)}
            >
              {viewLabels[v]}
            </Link>
          ))}
          <span aria-hidden="true" className="mx-1 text-border">
            |
          </span>
          {(['open', 'resolved'] as const).map((s) => (
            <Link
              key={s}
              href={`/c/${slug}/inbox${inboxQueryString({ ...query, status: s })}`}
              aria-current={query.status === s ? 'page' : undefined}
              className={tab(query.status === s)}
            >
              {s === 'open' ? 'Open' : 'Resolved'}
            </Link>
          ))}
        </nav>
        <ConversationList
          slug={slug}
          items={items}
          {...(activeId ? { activeId } : {})}
          query={inboxQueryString(query)}
          timeZone={timeZone}
          nextCursor={nextCursor}
        />
      </section>
      <section aria-label="Conversation" className="min-w-0">
        {children}
      </section>
    </div>
  );
}
