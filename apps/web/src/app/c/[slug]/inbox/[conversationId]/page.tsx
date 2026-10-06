import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { COMMERCE_LIMITS, can } from '@w360/domain';
import { formatMinor } from '@w360/domain/crm-money';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from '@w360/ui';
import { TakeOverButton } from '@/components/automations/automation-actions';
import { ProductSender } from '@/components/commerce/product-sender';
import { ContactCrmPanel } from '@/components/crm/contact-crm-panel';
import { FlowSender } from '@/components/flows/flow-sender';
import { Composer } from '@/components/inbox/composer';
import { FileSender } from '@/components/inbox/file-sender';
import { ConversationControls, TeamControl } from '@/components/inbox/conversation-controls';
import { InboxShell, inboxQueryString } from '@/components/inbox/inbox-shell';
import { MarkRead } from '@/components/inbox/mark-read';
import { MessageBubble, type ThreadMessage } from '@/components/inbox/message-bubble';
import { NoteForm } from '@/components/inbox/note-form';
import { ReplyTimer } from '@/components/inbox/reply-timer';
import { ORDER_STATUS, STORE_ORDER_STATUS, statusText } from '@/lib/commerce-labels';
import { formatDateTime } from '@/lib/format';
import { crmLookups } from '@/server/crm';
import { canUseInbox, liveEventCursor, loadInboxList, type SearchParams } from '@/server/inbox';
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
  const { inbox, savedReplies, crm, flows, commerce, stores } = await getRuntime();
  const since = await liveEventCursor(ctx);
  const before = typeof sp.before === 'string' ? sp.before : undefined;
  let thread: Awaited<ReturnType<typeof inbox.getConversation>>;
  try {
    thread = await inbox.getConversation(ctx, conversationId, before);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const canReply = can(ctx, 'inbox.reply');
  const showCrm = can(ctx, 'crm.read');
  const showCommerce = can(ctx, 'commerce.read');
  // Store orders carry customers' details: contacts.read too (as on the store pages).
  const showStoreOrders = showCommerce && can(ctx, 'contacts.read');
  const [
    { query, views, list, filters, unreadMentions, available },
    members,
    templates,
    mentionable,
    replies,
    crmData,
    lookups,
    forms,
    products,
    orders,
    storeOrders,
  ] = await Promise.all([
    loadInboxList(ctx, sp),
    can(ctx, 'inbox.assign') && can(ctx, 'members.read')
      ? inbox.assignableMembers(ctx)
      : Promise.resolve([]),
    sendableTemplates(ctx),
    canReply ? inbox.mentionableMembers(ctx, conversationId) : Promise.resolve([]),
    canReply ? savedReplies.savedRepliesFor(ctx, conversationId) : Promise.resolve([]),
    showCrm ? crm.contactCrm(ctx, thread.conversation.contactId) : null,
    showCrm ? crmLookups(ctx) : null,
    // Sending flows and products needs their modules in the company's plan (ADR-051).
    canReply && can(ctx, 'flows.read') && ctx.plan.modules.has('flows')
      ? flows.sendable(ctx, conversationId)
      : Promise.resolve([]),
    canReply && showCommerce && ctx.plan.modules.has('commerce')
      ? commerce.sendableProducts(ctx, conversationId)
      : Promise.resolve([]),
    showCommerce ? commerce.orders(ctx, { conversationId }) : null,
    showStoreOrders ? stores.conversationStoreOrders(ctx, conversationId) : null,
  ]);
  const conv = thread.conversation;
  const unread = list.items.find((i) => i.id === conv.id)?.unreadCount ?? 0;
  const now = new Date();
  // The newest message shown, for the composer's collision check (not when paging back).
  const latestMessageId = before ? undefined : thread.messages.at(-1)?.id;
  const csat = thread.csat;
  const CSAT_SKIPS: Record<string, string> = {
    window_closed: 'not sent: the 24-hour window had closed',
    opted_out: 'not sent: the customer opted out',
    suppressed: 'not sent: the number is suppressed',
    contact_erased: 'not sent: the contact was erased',
    no_phone: 'not sent: no phone number',
    channel_inactive: 'not sent: the number is inactive',
    recently_surveyed: 'not sent: asked in the last 24 hours',
  };
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
      since={since}
      filters={filters}
      unreadMentions={unreadMentions}
      available={available}
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
              {conv.teamName && !can(ctx, 'inbox.assign') ? ` · ${conv.teamName}` : ''}
            </p>
            {thread.source ? (
              <p className="text-sm text-muted-foreground">
                {thread.source.kind === 'ad' ? (
                  <>
                    Came from the ad{' '}
                    {thread.source.adSourceUrl ? (
                      <a
                        href={thread.source.adSourceUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="font-medium text-foreground underline underline-offset-4"
                      >
                        {thread.source.adHeadline ?? 'without a headline'}
                      </a>
                    ) : (
                      <span className="font-medium text-foreground">
                        {thread.source.adHeadline ?? 'without a headline'}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    Came from the chat link{' '}
                    {can(ctx, 'campaigns.read') && thread.source.linkId ? (
                      <Link
                        href={`/c/${ctx.tenant.slug}/growth/links/${thread.source.linkId}`}
                        className="font-medium text-foreground underline underline-offset-4"
                      >
                        {thread.source.linkName}
                      </Link>
                    ) : (
                      <span className="font-medium text-foreground">{thread.source.linkName}</span>
                    )}
                  </>
                )}{' '}
                ({formatDateTime(thread.source.occurredAt, tz)})
              </p>
            ) : null}
            {conv.waitingSince ? (
              <p className="text-sm">
                <ReplyTimer
                  waitingSince={conv.waitingSince}
                  replyDueAt={conv.replyDueAt}
                  overdue={conv.overdue}
                  timerPausedUntil={conv.timerPausedUntil}
                  timeZone={tz}
                  now={now}
                />
              </p>
            ) : null}
            {thread.automation ? (
              <Alert tone="info">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p>
                    {thread.automation.mode === 'test' ? 'A test of ' : 'The automation '}
                    {can(ctx, 'automations.read') ? (
                      <Link
                        href={`/c/${ctx.tenant.slug}/automations/runs/${thread.automation.runId}`}
                        className="font-medium underline underline-offset-4"
                      >
                        {thread.automation.automationName}
                      </Link>
                    ) : (
                      <span className="font-medium">{thread.automation.automationName}</span>
                    )}{' '}
                    is handling this conversation
                    {thread.automation.sending
                      ? ' and is sending a message'
                      : thread.automation.waitingFor === 'reply'
                        ? ' and is waiting for the customer’s reply'
                        : thread.automation.waitingFor === 'timer'
                          ? ' and is waiting before its next step'
                          : thread.automation.waitingFor === 'http'
                            ? ' and is waiting for a web request'
                            : ''}
                    . Replying, assigning or taking over stops it.
                  </p>
                  {canReply ? (
                    <TakeOverButton slug={ctx.tenant.slug} conversationId={conv.id} />
                  ) : null}
                </div>
              </Alert>
            ) : null}
            {csat ? (
              <p className="text-sm text-muted-foreground">
                CSAT survey{' '}
                {csat.skipReason
                  ? (CSAT_SKIPS[csat.skipReason] ?? 'not sent')
                  : csat.score !== null
                    ? `answered with the ${['worst', 'middle', 'best'][csat.score - 1] ?? ''} rating`
                    : csat.messageStatus === 'failed' || csat.messageStatus === 'canceled'
                      ? 'not delivered'
                      : 'sent, no answer yet'}{' '}
                ({formatDateTime(csat.createdAt, tz)})
              </p>
            ) : null}
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
            {can(ctx, 'inbox.assign') && filters.teams.length > 0 ? (
              <TeamControl
                slug={ctx.tenant.slug}
                conversationId={conv.id}
                version={conv.version}
                teamId={conv.teamId}
                teams={filters.teams}
              />
            ) : null}
            {can(ctx, 'inbox.export') ? (
              <a
                href={`/c/${ctx.tenant.slug}/inbox/${conv.id}/transcript`}
                download
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                Download transcript
              </a>
            ) : null}
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
                  conversationId={conv.id}
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
            savedReplies={replies}
            {...(latestMessageId ? { latestMessageId } : {})}
          />
          {disabledReason === null ? (
            <Card>
              <CardHeader>
                <CardTitle>Send a file</CardTitle>
              </CardHeader>
              <CardContent>
                <FileSender slug={ctx.tenant.slug} conversationId={conv.id} />
              </CardContent>
            </Card>
          ) : null}
          {disabledReason === null && forms.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Send a form</CardTitle>
              </CardHeader>
              <CardContent>
                <FlowSender slug={ctx.tenant.slug} conversationId={conv.id} flows={forms} />
              </CardContent>
            </Card>
          ) : null}
          {disabledReason === null && products.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Send products</CardTitle>
              </CardHeader>
              <CardContent>
                <ProductSender
                  slug={ctx.tenant.slug}
                  conversationId={conv.id}
                  products={products}
                  limits={{
                    productsPerMessage: COMMERCE_LIMITS.productsPerMessage,
                    headerLength: COMMERCE_LIMITS.headerLength,
                    bodyLength: COMMERCE_LIMITS.bodyLength,
                    footerLength: COMMERCE_LIMITS.footerLength,
                    sectionTitleLength: COMMERCE_LIMITS.sectionTitleLength,
                  }}
                />
              </CardContent>
            </Card>
          ) : null}
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
        <div className="grid min-w-0 content-start gap-4">
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
                      {n.mentions.length > 0 ? (
                        <p className="mt-1 text-xs">
                          Mentioned: {n.mentions.map((m) => m.name).join(', ')}
                        </p>
                      ) : null}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {n.apiKeyName !== null ? `API (${n.apiKeyName})` : n.authorName} ·{' '}
                        {formatDateTime(n.createdAt, tz)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {canReply ? (
                <NoteForm
                  slug={ctx.tenant.slug}
                  conversationId={conv.id}
                  mentionable={mentionable}
                  myMembershipId={ctx.membership.id}
                />
              ) : null}
            </CardContent>
          </Card>
          {orders && orders.orders.length > 0 ? (
            <Card className="h-fit">
              <CardHeader>
                <CardTitle>Orders</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-2 text-sm">
                  {orders.orders.slice(0, 10).map((o) => (
                    <li key={o.id} className="grid gap-0.5">
                      <Link
                        href={`/c/${ctx.tenant.slug}/commerce/orders/${o.id}`}
                        className="font-mono text-primary underline-offset-4 hover:underline"
                      >
                        {o.reference}
                      </Link>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge tone={ORDER_STATUS[o.status]?.tone ?? 'neutral'}>
                          {ORDER_STATUS[o.status]?.label ?? o.status}
                        </Badge>
                        {o.subtotalMinor !== null && o.currency
                          ? formatMinor(o.subtotalMinor, o.currency)
                          : null}
                        <span>{formatDateTime(o.receivedAt, tz)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
          {storeOrders && storeOrders.orders.length > 0 ? (
            <Card className="h-fit">
              <CardHeader>
                <CardTitle>Store orders</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2">
                <ul className="grid gap-2 text-sm">
                  {storeOrders.orders.map((o) => (
                    <li key={o.id} className="grid gap-0.5">
                      <Link
                        href={`/c/${ctx.tenant.slug}/commerce/stores/orders/${o.id}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {o.name}
                        <span className="text-muted-foreground"> · {o.storeName ?? 'Store'}</span>
                      </Link>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge tone={STORE_ORDER_STATUS[o.status]?.tone ?? 'neutral'}>
                          {STORE_ORDER_STATUS[o.status]?.label ?? statusText(o.status)}
                        </Badge>
                        {o.financialStatus ? <span>{statusText(o.financialStatus)}</span> : null}
                        {o.fulfillmentStatus ? (
                          <span>{statusText(o.fulfillmentStatus)}</span>
                        ) : null}
                        {o.totalMinor !== null && o.currency
                          ? formatMinor(o.totalMinor, o.currency)
                          : null}
                        <span>{formatDateTime(o.placedAt, tz)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {storeOrders.total > storeOrders.orders.length ? (
                  <p className="text-xs text-muted-foreground">
                    {storeOrders.total - storeOrders.orders.length} older order
                    {storeOrders.total - storeOrders.orders.length === 1 ? '' : 's'} for this
                    number.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
          {crmData && lookups ? (
            <Card className="h-fit">
              <CardHeader>
                <CardTitle>CRM</CardTitle>
              </CardHeader>
              <CardContent>
                <ContactCrmPanel
                  slug={ctx.tenant.slug}
                  timeZone={tz}
                  canWrite={can(ctx, 'crm.write')}
                  conversationId={conv.id}
                  data={crmData}
                  pipelines={lookups.options}
                  members={lookups.memberOptions}
                  myMembershipId={ctx.membership.id}
                  stageNames={lookups.stageNames}
                  memberNames={lookups.memberNames}
                  compact
                />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </InboxShell>
  );
}
