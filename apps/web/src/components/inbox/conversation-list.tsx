import Link from 'next/link';
import { Badge, EmptyState } from '@w360/ui';
import { cn } from '@w360/ui/cn';
import type { ConversationSummary } from '@w360/domain';
import { formatShort } from '@/lib/format';
import { ReplyTimer } from './reply-timer';

export function ConversationList({
  slug,
  items,
  activeId,
  query,
  timeZone,
  nextCursor,
}: {
  slug: string;
  items: ConversationSummary[];
  activeId?: string;
  query: string;
  timeZone: string;
  nextCursor: string | null;
}) {
  const now = new Date();
  if (items.length === 0) {
    return (
      <EmptyState
        title="No conversations here"
        description="Incoming WhatsApp messages appear here as soon as they arrive."
      />
    );
  }
  return (
    <div className="grid gap-2">
      <ul className="grid gap-1" aria-label="Conversations">
        {items.map((c) => {
          const name = c.contactName ?? c.contactPhone ?? 'Unknown contact';
          const active = c.id === activeId;
          return (
            <li key={c.id}>
              <Link
                href={`/c/${slug}/inbox/${c.id}${query}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'grid gap-1 rounded-md border border-transparent px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active && 'border-border bg-accent',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span
                    className={cn('truncate', c.unreadCount > 0 ? 'font-semibold' : 'font-medium')}
                  >
                    {name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatShort(c.lastMessageAt, timeZone)}
                  </span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-muted-foreground">
                    {c.lastMessagePreview ?? ''}
                  </span>
                  {c.unreadCount > 0 ? (
                    <Badge tone="info">
                      {c.unreadCount}
                      <span className="sr-only"> unread</span>
                    </Badge>
                  ) : null}
                </span>
                <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <span>{c.assignedName ? `Assigned to ${c.assignedName}` : 'Unassigned'}</span>
                  {c.automationActive ? <Badge tone="neutral">Automation</Badge> : null}
                  {c.teamName ? <span>· {c.teamName}</span> : null}
                  {!c.windowOpen ? <span>· Window closed</span> : null}
                </span>
                {c.waitingSince ? (
                  <span className="text-xs text-muted-foreground">
                    <ReplyTimer
                      waitingSince={c.waitingSince}
                      replyDueAt={c.replyDueAt}
                      overdue={c.overdue}
                      timerPausedUntil={c.timerPausedUntil}
                      timeZone={timeZone}
                      now={now}
                    />
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
      {nextCursor ? (
        <Link
          className="px-3 text-sm text-primary underline-offset-4 hover:underline"
          href={`/c/${slug}/inbox${activeId ? `/${activeId}` : ''}${query}${query ? '&' : '?'}cursor=${encodeURIComponent(nextCursor)}`}
        >
          Older conversations
        </Link>
      ) : null}
    </div>
  );
}
