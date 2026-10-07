import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
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
import {
  CancelPaymentLinkButton,
  OrderStatusButtons,
  RequestPaymentButton,
} from '@/components/commerce/order-actions';
import { CopyField } from '@/components/growth/copy-field';
import { ORDER_STATUS, PAYMENT_ACCOUNT_STATUS, PAYMENT_LINK_STATUS } from '@/lib/commerce-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Order' };
export const dynamic = 'force-dynamic';

const money = (minor: number | null, currency: string | null) =>
  minor !== null && currency ? formatMinor(minor, currency) : 'Not known';

export default async function OrderPage({
  params,
}: {
  params: Promise<{ slug: string; orderId: string }>;
}) {
  const { slug, orderId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read')) notFound();
  const { commerce } = await getRuntime();
  let detail: Awaited<ReturnType<typeof commerce.order>>;
  try {
    detail = await commerce.order(ctx, orderId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const { order, items, links, nextStatuses, payment } = detail;
  const tz = ctx.tenant.timezone;
  const status = ORDER_STATUS[order.status];
  const base = `/c/${ctx.tenant.slug}`;
  const showWhy =
    !payment.payable &&
    payment.why &&
    (order.status === 'received' || order.status === 'confirmed') &&
    can(ctx, 'inbox.reply');

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="grid min-w-0 content-start gap-6">
        <Card className="min-w-0">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>
                Order <span className="font-mono">{order.reference}</span>
              </CardTitle>
              <Badge tone={status?.tone ?? 'neutral'}>{status?.label ?? order.status}</Badge>
            </div>
            <CardDescription>
              From {order.contactName ?? 'an unknown contact'} ·{' '}
              {formatDateTime(order.receivedAt, tz)} ·{' '}
              <Link
                href={`${base}/inbox/${order.conversationId}`}
                className="text-primary underline-offset-4 hover:underline"
              >
                Open the conversation
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>Quantity</TH>
                  <TH>Price</TH>
                  <TH>Amount</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((item) => {
                  const line =
                    item.unitPriceMinor !== null ? item.unitPriceMinor * item.quantity : null;
                  return (
                    <TR key={item.position}>
                      <TD>
                        <span className="font-medium">
                          {item.name ?? 'Product not in your catalog copy'}
                        </span>
                        <span className="block font-mono text-xs text-muted-foreground">
                          {item.retailerId}
                        </span>
                      </TD>
                      <TD className="text-sm">{item.quantity}</TD>
                      <TD className="text-sm">{money(item.unitPriceMinor, item.currency)}</TD>
                      <TD className="text-sm">
                        {line !== null && Number.isSafeInteger(line)
                          ? money(line, item.currency)
                          : 'Not known'}
                      </TD>
                    </TR>
                  );
                })}
                <TR>
                  <TD className="font-medium" colSpan={3}>
                    Total
                  </TD>
                  <TD className="font-medium">{money(order.subtotalMinor, order.currency)}</TD>
                </TR>
              </TBody>
            </Table>
            {order.droppedItems > 0 ? (
              <div className="px-6">
                <Alert tone="warning">
                  HyFib could not read {order.droppedItems} item
                  {order.droppedItems === 1 ? '' : 's'} of this cart, so the order has no total and
                  payment cannot be requested. The items above are the ones it could read; ask the
                  customer to send the cart again.
                </Alert>
              </div>
            ) : order.subtotalMinor === null ? (
              <p className="px-6 text-sm text-muted-foreground">
                The total is not known: a price was missing, had more decimals than its currency, or
                the items were in different currencies.
              </p>
            ) : null}
            {order.customerNote ? (
              <div className="px-6 pb-6 text-sm">
                <p className="font-medium">Customer’s note</p>
                <p className="whitespace-pre-wrap break-words">{order.customerNote}</p>
              </div>
            ) : (
              <div className="pb-2" />
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Payment Links</CardTitle>
            <CardDescription>
              Links are created in your own Razorpay account and sent in the chat. HyFib records a
              payment only from the link as Razorpay reports it, checking every 15 minutes on the
              first day and every 6 hours after that, and at once when Razorpay notifies HyFib.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {links.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payment requested yet.</p>
            ) : (
              <ul className="grid gap-3">
                {links.map((link) => {
                  const label = PAYMENT_LINK_STATUS[link.status];
                  const open = ['creating', 'created', 'partially_paid'].includes(link.status);
                  return (
                    <li key={link.id} className="grid gap-2 rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge tone={label?.tone ?? 'neutral'}>{label?.label ?? link.status}</Badge>
                        <span className="font-medium">
                          {money(link.amountMinor, link.currency)}
                        </span>
                        {link.amountPaidMinor > 0 && link.status !== 'paid' ? (
                          <span className="text-muted-foreground">
                            {money(link.amountPaidMinor, link.currency)} paid so far
                          </span>
                        ) : null}
                        {link.cancelRequestedAt && open ? (
                          <Badge tone="info">Cancelling</Badge>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Requested {formatDateTime(link.createdAt, tz)}
                        {link.throughApi ? ' through the API' : ''}
                        {link.paidAt ? ` · paid ${formatDateTime(link.paidAt, tz)}` : ''}
                        {open ? ` · open until ${formatDateTime(link.expiresAt, tz)}` : ''}
                        {link.checkedAt
                          ? ` · last checked with Razorpay ${formatDateTime(link.checkedAt, tz)}`
                          : ''}
                        {link.messageId ? ' · sent in the chat' : ''}
                      </p>
                      {link.error ? <p className="text-sm text-destructive">{link.error}</p> : null}
                      {link.status === 'creating' ? (
                        <p className="text-sm text-muted-foreground">
                          HyFib is creating this link in Razorpay. Reload in a moment.
                        </p>
                      ) : null}
                      {link.cancelRequestedAt && open ? (
                        <p className="text-sm text-muted-foreground">
                          HyFib is cancelling this link in Razorpay. If the customer has already
                          paid, the payment is recorded instead.
                        </p>
                      ) : null}
                      {open && link.sendError && !link.messageId ? (
                        <p className="text-sm text-destructive">{link.sendError}</p>
                      ) : null}
                      {open && link.shortUrl ? (
                        <CopyField label="Payment Link" value={link.shortUrl} />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {payment.payable && order.subtotalMinor !== null && order.currency ? (
              <RequestPaymentButton
                slug={ctx.tenant.slug}
                orderId={order.id}
                version={order.version}
                amount={formatMinor(order.subtotalMinor, order.currency)}
              />
            ) : null}
            {showWhy ? <Alert tone="info">{payment.why}</Alert> : null}
            {payment.canCancelLink ? (
              <CancelPaymentLinkButton slug={ctx.tenant.slug} orderId={order.id} />
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="grid min-w-0 content-start gap-6">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Status</CardTitle>
            <CardDescription>
              {status?.label ?? order.status} since {formatDateTime(order.statusChangedAt, tz)}.
              {order.status === 'awaiting_payment'
                ? ' The order goes back to confirmed if the link expires or is cancelled unpaid.'
                : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {nextStatuses.length > 0 ? (
              <OrderStatusButtons
                slug={ctx.tenant.slug}
                orderId={order.id}
                version={order.version}
                next={nextStatuses}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {order.status === 'awaiting_payment'
                  ? 'Cancel the Payment Link to change this order.'
                  : 'No further changes.'}
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Razorpay account</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {payment.account ? (
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone={PAYMENT_ACCOUNT_STATUS[payment.account.status]?.tone ?? 'neutral'}>
                  {PAYMENT_ACCOUNT_STATUS[payment.account.status]?.label ?? payment.account.status}
                </Badge>
                <span className="text-muted-foreground">
                  {payment.account.mode === 'live' ? 'Live keys' : 'Test keys (no real money)'}
                </span>
              </p>
            ) : (
              <p className="text-muted-foreground">Not added yet.</p>
            )}
            <Link
              href={`${base}/commerce/payments`}
              className="text-primary underline-offset-4 hover:underline"
            >
              Payment settings
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
