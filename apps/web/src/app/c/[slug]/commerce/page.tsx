import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { formatMinor } from '@w360/domain/crm-money';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { cn } from '@w360/ui/cn';
import { ORDER_STATUS } from '@/lib/commerce-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Orders' };
export const dynamic = 'force-dynamic';

const FILTERS = ['', 'received', 'confirmed', 'awaiting_payment', 'paid', 'fulfilled', 'cancelled'];

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string; before?: string }>;
}) {
  const { slug } = await params;
  const { status, before } = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read')) notFound();
  const { commerce } = await getRuntime();
  const current = status && FILTERS.includes(status) ? status : '';
  const { orders, older } = await commerce.orders(ctx, {
    ...(current ? { status: current } : {}),
    ...(before ? { before } : {}),
  });
  const base = `/c/${ctx.tenant.slug}/commerce`;
  const tz = ctx.tenant.timezone;
  const filterHref = (s: string) => (s ? `${base}?status=${s}` : base);

  return (
    <div className="grid grid-cols-1 gap-6">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Orders</CardTitle>
          <CardDescription>
            Carts customers send from your catalog in WhatsApp. You see the orders of conversations
            you can see. Amounts are the prices WhatsApp sent with the order.
          </CardDescription>
          {can(ctx, 'contacts.export') ? (
            <div>
              <Button asChild variant="outline" size="sm">
                {/* The orders this list shows, as CSV (ADR-235). */}
                <a href={`${base}/orders/export${current ? `?status=${current}` : ''}`} download>
                  Export CSV
                </a>
              </Button>
            </div>
          ) : null}
          <nav aria-label="Order status" className="flex flex-wrap gap-2 pt-2 text-sm">
            {FILTERS.map((s) => (
              <Link
                key={s || 'all'}
                href={filterHref(s)}
                aria-current={s === current ? 'page' : undefined}
                className={cn(
                  'rounded-md border px-2 py-1',
                  s === current
                    ? 'border-primary text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {s ? (ORDER_STATUS[s]?.label ?? s) : 'All'}
              </Link>
            ))}
          </nav>
        </CardHeader>
        <CardContent className="p-0">
          {orders.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title={before ? 'No older orders' : 'No orders yet'}
                description="An order appears here when a customer sends their cart from your WhatsApp catalog. Read your catalog from Meta in Catalogs first, so orders show product names."
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Order</TH>
                  <TH>Customer</TH>
                  <TH>Items</TH>
                  <TH>Total</TH>
                  <TH>Status</TH>
                  <TH>Received</TH>
                </TR>
              </THead>
              <TBody>
                {orders.map((o) => {
                  const label = ORDER_STATUS[o.status];
                  return (
                    <TR key={o.id}>
                      <TD className="font-medium">
                        <Link
                          href={`${base}/orders/${o.id}`}
                          className="font-mono text-primary underline-offset-4 hover:underline"
                        >
                          {o.reference}
                        </Link>
                      </TD>
                      <TD className="text-sm">{o.contactName ?? 'Unknown contact'}</TD>
                      <TD className="text-sm">{o.itemCount}</TD>
                      <TD className="text-sm">
                        {o.subtotalMinor !== null && o.currency
                          ? formatMinor(o.subtotalMinor, o.currency)
                          : 'Not known'}
                      </TD>
                      <TD>
                        <Badge tone={label?.tone ?? 'neutral'}>{label?.label ?? o.status}</Badge>
                      </TD>
                      <TD className="text-sm text-muted-foreground">
                        {formatDateTime(o.receivedAt, tz)}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {older || before ? (
        <div className="flex gap-4 text-sm">
          {before ? (
            <Link
              href={filterHref(current)}
              className="text-primary underline-offset-4 hover:underline"
            >
              Newest orders
            </Link>
          ) : null}
          {older ? (
            <Link
              href={`${base}?${new URLSearchParams({ ...(current ? { status: current } : {}), before: older }).toString()}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              Older orders
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
