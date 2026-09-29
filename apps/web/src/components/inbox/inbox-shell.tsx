import Form from 'next/form';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, Button, Input, Label, Select } from '@w360/ui';
import { cn } from '@w360/ui/cn';
import type { ConversationSummary } from '@w360/domain';
import { AvailabilityToggle } from '@/components/settings/team-editor';
import { ConversationList } from './conversation-list';
import { LiveEvents } from './live-events';

export interface InboxQuery {
  view: 'mine' | 'unassigned' | 'all';
  status: 'open' | 'resolved';
  /** A team id, or 'none'. */
  team?: string;
  channel?: string;
  q?: string;
  order: 'recent' | 'waiting';
}

export interface InboxFilters {
  teams: { id: string; name: string }[];
  channels: { id: string; label: string }[];
}

export function inboxQueryString(q: InboxQuery): string {
  const params = new URLSearchParams({ view: q.view, status: q.status });
  if (q.team) params.set('team', q.team);
  if (q.channel) params.set('channel', q.channel);
  if (q.q) params.set('q', q.q);
  if (q.order === 'waiting') params.set('order', 'waiting');
  return `?${params.toString()}`;
}

const tab = (active: boolean) =>
  cn(
    'rounded-md px-2.5 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-muted',
  );

export function InboxShell({
  slug,
  query,
  views,
  items,
  nextCursor,
  activeId,
  timeZone,
  since,
  filters,
  unreadMentions,
  available,
  mentionsActive = false,
  list,
  children,
}: {
  slug: string;
  query: InboxQuery;
  views: InboxQuery['view'][];
  items: ConversationSummary[];
  nextCursor: string | null;
  activeId?: string;
  timeZone: string;
  /** Event-log cursor read before the page loaded its data (see liveEventCursor). */
  since: string;
  filters: InboxFilters;
  unreadMentions: number;
  /** The member's availability, or null when their role cannot take conversations. */
  available: boolean | null;
  /** The mentions page replaces the conversation list with its own. */
  mentionsActive?: boolean;
  list?: ReactNode;
  children: ReactNode;
}) {
  const viewLabels = { mine: 'Mine', unassigned: 'Unassigned', all: 'All' } as const;
  const base = `/c/${slug}/inbox`;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <section
        aria-label="Conversation list"
        className={cn('grid min-w-0 content-start gap-3', activeId && 'hidden lg:grid')}
      >
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
          <LiveEvents
            slug={slug}
            since={since}
            {...(activeId ? { conversationId: activeId } : {})}
          />
        </div>
        {available !== null ? <AvailabilityToggle slug={slug} available={available} /> : null}
        <nav aria-label="Inbox views" className="flex flex-wrap gap-1">
          {views.map((v) => (
            <Link
              key={v}
              href={`${base}${inboxQueryString({ ...query, view: v })}`}
              aria-current={!mentionsActive && query.view === v ? 'page' : undefined}
              className={tab(!mentionsActive && query.view === v)}
            >
              {viewLabels[v]}
            </Link>
          ))}
          <Link
            href={`${base}/mentions`}
            aria-current={mentionsActive ? 'page' : undefined}
            className={tab(mentionsActive)}
          >
            Mentions
            {unreadMentions > 0 ? (
              <Badge tone="info" className="ml-1.5">
                {unreadMentions}
                <span className="sr-only"> unread</span>
              </Badge>
            ) : null}
          </Link>
          {mentionsActive ? null : (
            <>
              <span aria-hidden="true" className="mx-1 text-border">
                |
              </span>
              {(['open', 'resolved'] as const).map((s) => (
                <Link
                  key={s}
                  href={`${base}${inboxQueryString({ ...query, status: s, order: s === 'resolved' ? 'recent' : query.order })}`}
                  aria-current={query.status === s ? 'page' : undefined}
                  className={tab(query.status === s)}
                >
                  {s === 'open' ? 'Open' : 'Resolved'}
                </Link>
              ))}
            </>
          )}
        </nav>
        {mentionsActive ? null : (
          // Applied with a client-side navigation, like the view links: a page load would cancel a
          // live refresh in flight, and Next.js would answer by loading the unfiltered page again.
          <Form action={base} className="grid gap-2" aria-label="Filter conversations">
            <input type="hidden" name="view" value={query.view} />
            <input type="hidden" name="status" value={query.status} />
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1">
                <Label htmlFor="inbox-team" className="text-xs">
                  Team
                </Label>
                <Select id="inbox-team" name="team" defaultValue={query.team ?? ''}>
                  <option value="">All teams</option>
                  <option value="none">No team</option>
                  {filters.teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </div>
              {query.status === 'open' ? (
                <div className="grid gap-1">
                  <Label htmlFor="inbox-order" className="text-xs">
                    Order
                  </Label>
                  <Select id="inbox-order" name="order" defaultValue={query.order}>
                    <option value="recent">Latest message</option>
                    <option value="waiting">Longest waiting</option>
                  </Select>
                </div>
              ) : null}
              {filters.channels.length > 1 ? (
                <div className="grid gap-1">
                  <Label htmlFor="inbox-channel" className="text-xs">
                    Number
                  </Label>
                  <Select id="inbox-channel" name="channel" defaultValue={query.channel ?? ''}>
                    <option value="">All numbers</option>
                    {filters.channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              <div className="grid gap-1">
                <Label htmlFor="inbox-q" className="text-xs">
                  Customer
                </Label>
                <Input
                  id="inbox-q"
                  name="q"
                  type="search"
                  defaultValue={query.q ?? ''}
                  placeholder="Name or number"
                  maxLength={100}
                />
              </div>
            </div>
            <div>
              <Button type="submit" size="sm" variant="outline">
                Apply filters
              </Button>
            </div>
          </Form>
        )}
        {list ?? (
          <ConversationList
            slug={slug}
            items={items}
            {...(activeId ? { activeId } : {})}
            query={inboxQueryString(query)}
            timeZone={timeZone}
            nextCursor={nextCursor}
          />
        )}
      </section>
      <section aria-label="Conversation" className="min-w-0">
        {children}
      </section>
    </div>
  );
}
