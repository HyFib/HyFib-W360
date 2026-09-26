import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from '@w360/ui';
import { Composer } from '@/components/inbox/composer';
import { ConversationControls } from '@/components/inbox/conversation-controls';
import { InboxShell, inboxQueryString } from '@/components/inbox/inbox-shell';
import { MarkRead } from '@/components/inbox/mark-read';
import { MessageBubble, type ThreadMessage } from '@/components/inbox/message-bubble';
import { NoteForm } from '@/components/inbox/note-form';
import { formatDateTime } from '@/lib/format';
import { canUseInbox, loadInboxList, type SearchParams } from '@/server/inbox';
import { TemplateSender } from '@/components/templates/template-sender';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';
import { sendableTemplates } from '@/server/templates';

export const metadata: Metadata = { title: 'Conversation' };
export const dynamic = 'force-dynamic';

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; conversationId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug, conversationId } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!canUseInbox(ctx)) notFound();
  const { inbox } = await getRuntime();
  const before = typeof sp.before === 'string' ? sp.before : undefined;
  let thread: Awaited<ReturnType<typeof inbox.getConversation>>;
  try {
    thread = await inbox.getConversation(ctx, conversationId, before);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const [{ query, views, list }, members, templates] = await Promise.all([
    loadInboxList(ctx, sp),
    can(ctx, 'inbox.assign') && can(ctx, 'members.read')
      ? inbox.assignableMembers(ctx)
      : Promise.resolve([]),
    sendableTemplates(ctx),
  ]);
  const conv = thread.conversation;
  const unread = list.items.find((i) => i.id === conv.id)?.unreadCount ?? 0;
  const canReply = can(ctx, 'inbox.reply');
  const disabledReason = !canReply
    ? 'Your role can read this conversation but not reply.'
    : !conv.channelActive
      ? 'This WhatsApp number is not active. An administrator can reconnect it in Settings → Channels.'
      : !conv.windowOpen
        ? 'The 24-hour customer service window has closed. Free-form replies are not allowed until the customer writes again; you can send an approved template instead.'
        : !conv.identity.hasPhone
          ? 'This contact is known only by a WhatsApp user id. Replying to user ids is not enabled until Meta’s request format is verified.'
          : null;
  const tz = ctx.tenant.timezone;
  const name = conv.contactName ?? conv.contactPhone ?? 'Unknown contact';

  return (
    <InboxShell
      slug={ctx.tenant.slug}
      query={query}
      views={views}
      items={list.items}
      nextCursor={list.nextCursor}
      activeId={conv.id}
      timeZone={tz}
    >
      <MarkRead slug={ctx.tenant.slug} conversationId={conv.id} unread={unread} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid min-w-0 content-start gap-4">
          <div className="grid gap-2">
            <Link
              href={`/c/${ctx.tenant.slug}/inbox${inboxQueryString(query)}`}
              className="text-sm text-primary underline-offset-4 hover:underline lg:hidden"
            >
              ← All conversations
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{name}</h2>
              {conv.status === 'resolved' ? (
                <Badge>Resolved</Badge>
              ) : (
                <Badge tone="info">Open</Badge>
              )}
              {conv.windowOpen ? (
                <Badge tone="success">
                  Window open until {formatDateTime(conv.windowExpiresAt, tz)}
                </Badge>
              ) : (
                <Badge tone="warning">Window closed</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {conv.contactPhone ?? 'No phone number shared'} · via {conv.channelName ?? 'WhatsApp'}
            </p>
            <ConversationControls
              slug={ctx.tenant.slug}
              conversationId={conv.id}
              version={conv.version}
              status={conv.status}
              assignedMembershipId={conv.assignedMembershipId}
              myMembershipId={ctx.membership.id}
              canManageAssignment={can(ctx, 'inbox.assign')}
              canReply={canReply}
              members={members.map((m) => ({ membershipId: m.membershipId, name: m.name }))}
            />
          </div>
          {thread.olderCursor ? (
            <Link
              className="text-sm text-primary underline-offset-4 hover:underline"
              href={`/c/${ctx.tenant.slug}/inbox/${conv.id}${inboxQueryString(query)}&before=${encodeURIComponent(thread.olderCursor)}`}
            >
              Show older messages
            </Link>
          ) : null}
          {thread.messages.length === 0 ? (
            <Alert tone="info">No messages in this range.</Alert>
          ) : (
            <ol className="grid gap-2" aria-label={`Messages with ${name}`}>
              {thread.messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  slug={ctx.tenant.slug}
                  message={m as ThreadMessage}
                  timeZone={tz}
                  canResolveUnknown={canReply}
                />
              ))}
            </ol>
          )}
          <Composer
            key={conv.id}
            slug={ctx.tenant.slug}
            conversationId={conv.id}
            draftKey={`w360:draft:${ctx.user.id}:${ctx.tenant.id}:${conv.id}`}
            disabledReason={disabledReason}
          />
          {canReply && conv.channelActive && !conv.windowOpen && can(ctx, 'templates.read') ? (
            <Card>
              <CardHeader>
                <CardTitle>Send a template</CardTitle>
              </CardHeader>
              <CardContent>
                <TemplateSender
                  slug={ctx.tenant.slug}
                  contactId={conv.contactId}
                  channels={[
                    {
                      id: conv.channelAccountId,
                      label: conv.channelName ?? 'WhatsApp',
                      whatsappAccountId: conv.whatsappAccountId,
                    },
                  ]}
                  templates={templates}
                />
              </CardContent>
            </Card>
          ) : null}
        </div>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {thread.notes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No notes yet.</p>
            ) : (
              <ul className="grid gap-2">
                {thread.notes.map((n) => (
                  <li key={n.id} className="rounded-md border border-border p-2 text-sm">
                    <p className="whitespace-pre-wrap break-words">{n.body}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {n.authorName} · {formatDateTime(n.createdAt, tz)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {canReply ? <NoteForm slug={ctx.tenant.slug} conversationId={conv.id} /> : null}
          </CardContent>
        </Card>
      </div>
    </InboxShell>
  );
}
