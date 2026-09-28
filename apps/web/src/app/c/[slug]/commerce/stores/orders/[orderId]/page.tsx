import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { STORE_MESSAGE_SKIP_REASONS, can } from '@w360/domain';
import { formatMinor } from '@w360/domain/crm-money';
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
import { CopyField } from '@/components/growth/copy-field';
import {
  COD_ANSWER,
  STORE_MESSAGE_STATUS,
  STORE_ORDER_STATUS,
  STORE_PLATFORM,
  statusText,
} from '@/lib/commerce-labels';
import { RUN_STATUS } from '@/lib/automation-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Store order' };
export const dynamic = 'force-dynamic';

export default async function StoreOrderPage({
  params,
}: {
  params: Promise<{ slug: string; orderId: string }>;
}) {
  const { slug, orderId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read') || !can(ctx, 'contacts.read')) notFound();
  const { stores, storeMessages } = await getRuntime();
  let detail: Awaited<ReturnType<typeof stores.storeOrder>>;
  let sent: Awaited<ReturnType<typeof storeMessages.orderMessages>>;
  try {
    detail = await stores.storeOrder(ctx, orderId);
    sent = await storeMessages.orderMessages(ctx, orderId);
  } catch (error) {
    if (isAppError(error) && (error.code === 'not_found' || error.code === 'validation_failed')) {
      notFound();
    }
    throw error;
  }
  const { order, items, contact, storeName, storeUrl, platform } = detail;
  const tz = ctx.tenant.timezone;
  const status = STORE_ORDER_STATUS[order.status];
  const base = `/c/${ctx.tenant.slug}`;
  const money = (minor: number | null) =>
    minor !== null && order.currency ? formatMinor(minor, order.currency) : 'Not known';

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="grid min-w-0 content-start gap-6">
        <Link
          href={`${base}/commerce/stores/${order.storeId}/orders`}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          ← Orders of {storeName ?? storeUrl}
        </Link>
        {order.deletedAt ? (
          <Alert tone="warning">This order was deleted in the store.</Alert>
        ) : null}
        <Card className="min-w-0">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Order {order.name}</CardTitle>
              <Badge tone={status?.tone ?? 'neutral'}>
                {status?.label ?? statusText(order.status)}
              </Badge>
              {order.financialStatus ? (
                <Badge tone="neutral">{statusText(order.financialStatus)}</Badge>
              ) : null}
              {order.fulfillmentStatus ? (
                <Badge tone="neutral">{statusText(order.fulfillmentStatus)}</Badge>
              ) : null}
              {order.test ? <Badge tone="warning">Test order</Badge> : null}
            </div>
            <CardDescription>
              {STORE_PLATFORM[platform]} · placed {formatDateTime(order.placedAt, tz)} · last read{' '}
              {formatDateTime(order.syncedAt, tz)}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Item</TH>
                  <TH>Quantity</TH>
                  <TH>Amount</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((item) => (
                  <TR key={item.id}>
                    <TD>
                      <span className="font-medium">{item.title}</span>
                      {item.sku ? (
                        <span className="block font-mono text-xs text-muted-foreground">
                          {item.sku}
                        </span>
                      ) : null}
                    </TD>
                    <TD className="text-sm">{item.quantity}</TD>
                    <TD className="text-sm">{money(item.totalMinor)}</TD>
                  </TR>
                ))}
                <TR>
                  <TD className="font-medium" colSpan={2}>
                    Total
                  </TD>
                  <TD className="font-medium">{money(order.totalMinor)}</TD>
                </TR>
              </TBody>
            </Table>
            {order.itemsTruncated ? (
              <p className="px-6 pb-4 text-sm text-muted-foreground">
                The order has more items than HyFib lists; the total is the store’s.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="grid min-w-0 content-start gap-6">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Customer</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {order.redactedAt ? (
              <p className="text-muted-foreground">
                The customer’s details were removed (at their request or because their contact was
                erased).
              </p>
            ) : (
              <>
                <p>
                  {order.customerName ?? (
                    <span className="text-muted-foreground">Name not shared</span>
                  )}
                </p>
                {order.customerPhone ? <p className="font-mono">{order.customerPhone}</p> : null}
                {order.customerEmail ? <p>{order.customerEmail}</p> : null}
                {!order.customerPhone && !order.customerEmail ? (
                  <p className="text-muted-foreground">No number or email shared by the store.</p>
                ) : null}
              </>
            )}
            {contact ? (
              <Link
                href={`${base}/contacts/${contact.id}`}
                className="text-primary underline-offset-4 hover:underline"
              >
                Open contact{contact.name ? `: ${contact.name}` : ''}
              </Link>
            ) : null}
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Payment and shipping</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {order.paymentNames.length > 0 ? (
              <p>
                Paid with {order.paymentNames.join(', ')}
                {order.cashOnDelivery ? (
                  <span className="ml-2">
                    <Badge tone="info">Cash on delivery</Badge>
                  </span>
                ) : null}
              </p>
            ) : null}
            <p>
              {order.shippedAt
                ? `Shipped ${formatDateTime(order.shippedAt, tz)}`
                : 'Not shipped yet (as last read).'}
            </p>
            {order.deliveredAt ? <p>Delivered {formatDateTime(order.deliveredAt, tz)}</p> : null}
            {order.trackingCompany || order.trackingNumber ? (
              <p>{[order.trackingCompany, order.trackingNumber].filter(Boolean).join(' · ')}</p>
            ) : null}
            {order.trackingUrl ? (
              <CopyField label="Tracking link" value={order.trackingUrl} />
            ) : null}
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>WhatsApp messages</CardTitle>
            <CardDescription>
              Order messages sent about this order (set up per store).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            {sent.length === 0 ? (
              <p className="text-muted-foreground">None.</p>
            ) : (
              <ul className="grid gap-3">
                {sent.map((m) => {
                  const label = STORE_MESSAGE_STATUS[m.status];
                  const answer = m.answer ? COD_ANSWER[m.answer] : null;
                  return (
                    <li key={m.id} className="grid gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{m.label}</span>
                        <Badge tone={label?.tone ?? 'neutral'}>{label?.label ?? m.status}</Badge>
                      </div>
                      {m.skipReason ? (
                        <p className="text-xs text-muted-foreground">
                          {STORE_MESSAGE_SKIP_REASONS[m.skipReason] ?? m.skipReason}
                        </p>
                      ) : null}
                      {m.status === 'failed' && m.errorTitle ? (
                        <p className="text-xs text-muted-foreground">{m.errorTitle}</p>
                      ) : null}
                      {m.status === 'waiting' ? (
                        <p className="text-xs text-muted-foreground">
                          Due {formatDateTime(m.sendAt, tz)}
                        </p>
                      ) : null}
                      {answer && m.answeredAt ? (
                        <p>
                          <Badge tone={answer.tone}>{answer.label}</Badge>{' '}
                          <span className="text-xs text-muted-foreground">
                            {formatDateTime(m.answeredAt, tz)}
                          </span>
                        </p>
                      ) : null}
                      {m.automation ? (
                        <p className="text-xs text-muted-foreground">
                          {m.automation.runId ? (
                            <Link
                              href={`${base}/automations/runs/${m.automation.runId}`}
                              className="text-primary underline-offset-4 hover:underline"
                            >
                              {m.automation.automationName ?? 'The run'}
                            </Link>
                          ) : (
                            (m.automation.automationName ?? 'An automation')
                          )}
                          {m.automation.runStatus
                            ? `: ${RUN_STATUS[m.automation.runStatus]?.label ?? m.automation.runStatus}`
                            : ''}
                        </p>
                      ) : null}
                      {m.conversationId ? (
                        <Link
                          href={`${base}/inbox/${m.conversationId}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          Open conversation
                        </Link>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
        {order.statusUrl ? (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Order status page</CardTitle>
              <CardDescription>
                Shopify’s page where the customer can follow this order. Share it only with them.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CopyField label="Status page" value={order.statusUrl} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
