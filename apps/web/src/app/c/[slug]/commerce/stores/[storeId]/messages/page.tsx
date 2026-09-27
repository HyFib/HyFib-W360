import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { STORE_MESSAGE_SKIP_REASONS, can } from '@w360/domain';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { StoreMessageRuleForm, StoreMessageSettingsForm } from '@/components/stores/store-messages';
import { COD_ANSWER, STORE_MESSAGE_STATUS } from '@/lib/commerce-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Order messages' };
export const dynamic = 'force-dynamic';

export default async function StoreMessagesPage({
  params,
}: {
  params: Promise<{ slug: string; storeId: string }>;
}) {
  const { slug, storeId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read')) notFound();
  const { storeMessages } = await getRuntime();
  let data: Awaited<ReturnType<typeof storeMessages.storeMessages>>;
  try {
    data = await storeMessages.storeMessages(ctx, storeId);
  } catch (error) {
    if (isAppError(error) && (error.code === 'not_found' || error.code === 'validation_failed')) {
      notFound();
    }
    throw error;
  }
  const { store, rules, channels, templates, counts, recent, canManage, timezone } = data;
  const tz = ctx.tenant.timezone;
  const base = `/c/${ctx.tenant.slug}/commerce/stores`;
  const optInNote = store.messagesOptInAt
    ? `Confirmed ${store.optInBy ? `by ${store.optInBy} ` : ''}on ${formatDateTime(store.messagesOptInAt, tz)}.`
    : null;
  const hasActiveNumber = channels.some((c) => c.status === 'active');

  return (
    <div className="grid grid-cols-1 gap-6">
      <Link
        href={`${base}/${store.id}`}
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        ← {store.name ?? store.shopDomain ?? store.storeUrl}
      </Link>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Order messages</CardTitle>
          <CardDescription>
            When an order in this store is placed, paid for on delivery, shipped, delivered or
            cancelled, HyFib sends the customer the WhatsApp template you choose for it. Each order
            gets at most one message per event, and a message never goes out about something that
            happened before it was switched on. Customers who opted out, numbers on the suppression
            list and erased contacts are never messaged.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          {store.state !== 'connected' ? (
            <Alert tone="warning">
              The store is not connected, so no messages are sent. Connect it again from the store’s
              page.
            </Alert>
          ) : null}
          {!hasActiveNumber ? (
            <Alert tone="warning">
              Connect a WhatsApp number in Settings → Channels before switching messages on.
            </Alert>
          ) : null}
          {canManage ? (
            <StoreMessageSettingsForm
              slug={ctx.tenant.slug}
              storeId={store.id}
              optIn={store.messagesOptInAt !== null}
              optInNote={optInNote}
              windowStart={store.sendWindowStart}
              windowEnd={store.sendWindowEnd}
              testOrders={store.messageTestOrders}
              platform={store.platform}
              timezone={timezone}
            />
          ) : (
            <dl className="grid gap-1">
              <div>
                <dt className="inline font-medium">Customers’ opt-in: </dt>
                <dd className="inline">{optInNote ?? 'Not confirmed'}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Sending hours: </dt>
                <dd className="inline">
                  {store.sendWindowStart
                    ? `${store.sendWindowStart}–${store.sendWindowEnd} (${timezone})`
                    : 'Any time'}
                </dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      {rules.map((rule) => (
        <Card key={rule.event} className="min-w-0">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{rule.label}</CardTitle>
              {rule.available ? (
                <Badge tone={rule.enabled ? 'success' : 'neutral'}>
                  {rule.enabled ? 'On' : 'Off'}
                </Badge>
              ) : null}
            </div>
            <CardDescription>{rule.description}</CardDescription>
          </CardHeader>
          <CardContent>
            {canManage ? (
              <StoreMessageRuleForm
                slug={ctx.tenant.slug}
                storeId={store.id}
                rule={rule}
                channels={channels}
                templates={templates}
              />
            ) : rule.enabled ? (
              <p className="text-sm">
                Sends {templates.find((t) => t.id === rule.templateId)?.name ?? 'a template'}
                {rule.delayMinutes > 0 ? ` ${rule.delayMinutes} minutes after the event` : ''}.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Not sent.</p>
            )}
          </CardContent>
        </Card>
      ))}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Messages in the last 30 days</CardTitle>
          <CardDescription>
            Delivery comes from WhatsApp’s reports. “Not sent” gives the reason.
          </CardDescription>
          <ul className="flex flex-wrap gap-2 pt-2" aria-label="Messages by status">
            {Object.entries(counts).map(([status, count]) => (
              <li key={status}>
                <Badge tone={STORE_MESSAGE_STATUS[status]?.tone ?? 'neutral'}>
                  {STORE_MESSAGE_STATUS[status]?.label ?? status}: {count}
                </Badge>
              </li>
            ))}
          </ul>
        </CardHeader>
        <CardContent className="p-0">
          {recent.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No order messages yet.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Event</TH>
                  <TH>Order</TH>
                  <TH>Status</TH>
                  <TH>When</TH>
                </TR>
              </THead>
              <TBody>
                {recent.map((m) => {
                  const status = STORE_MESSAGE_STATUS[m.status];
                  const answer = m.answer ? COD_ANSWER[m.answer] : null;
                  return (
                    <TR key={m.id}>
                      <TD className="text-sm">{m.label}</TD>
                      <TD className="text-sm">
                        {can(ctx, 'contacts.read') ? (
                          <Link
                            href={`${base}/orders/${m.orderId}`}
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            {m.orderName}
                          </Link>
                        ) : (
                          m.orderName
                        )}
                        {m.customerName ? (
                          <span className="block text-xs text-muted-foreground">
                            {m.customerName}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="text-sm">
                        <Badge tone={status?.tone ?? 'neutral'}>{status?.label ?? m.status}</Badge>
                        {m.skipReason ? (
                          <span className="block text-xs text-muted-foreground">
                            {STORE_MESSAGE_SKIP_REASONS[m.skipReason] ?? m.skipReason}
                          </span>
                        ) : null}
                        {m.status === 'failed' && m.errorTitle ? (
                          <span className="block text-xs text-muted-foreground">
                            {m.errorTitle}
                          </span>
                        ) : null}
                        {answer ? (
                          <span className="mt-1 block">
                            <Badge tone={answer.tone}>{answer.label}</Badge>
                          </span>
                        ) : null}
                      </TD>
                      <TD className="text-xs text-muted-foreground">
                        {m.status === 'waiting'
                          ? `Due ${formatDateTime(m.sendAt, tz)}`
                          : formatDateTime(m.createdAt, tz)}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
