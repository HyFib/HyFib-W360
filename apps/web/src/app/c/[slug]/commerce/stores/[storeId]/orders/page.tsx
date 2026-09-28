import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
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
  Input,
  Label,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { STORE_ORDER_STATUS, statusText } from '@/lib/commerce-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Store orders' };
export const dynamic = 'force-dynamic';

export default async function StoreOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; storeId: string }>;
  searchParams: Promise<{ q?: string; cursor?: string }>;
}) {
  const { slug, storeId } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read') || !can(ctx, 'contacts.read')) notFound();
  const { stores } = await getRuntime();
  const q = typeof sp.q === 'string' ? sp.q.slice(0, 100) : '';
  let data: Awaited<ReturnType<typeof stores.storeOrders>>;
  let store: Awaited<ReturnType<typeof stores.store>>['store'];
  try {
    store = (await stores.store(ctx, storeId)).store;
    data = await stores.storeOrders(ctx, {
      storeId,
      ...(q ? { q } : {}),
      ...(typeof sp.cursor === 'string' ? { cursor: sp.cursor } : {}),
    });
  } catch (error) {
    if (isAppError(error) && (error.code === 'not_found' || error.code === 'validation_failed')) {
      notFound();
    }
    throw error;
  }
  const tz = ctx.tenant.timezone;
  const base = `/c/${ctx.tenant.slug}/commerce/stores`;
  const pageHref = (cursor: string) =>
    `${base}/${storeId}/orders?${new URLSearchParams({ ...(q ? { q } : {}), cursor }).toString()}`;

  return (
    <div className="grid grid-cols-1 gap-6">
      <Link
        href={`${base}/${storeId}`}
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        ← {store.name ?? store.shopDomain ?? store.storeUrl}
      </Link>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Orders</CardTitle>
          <CardDescription>
            Newest first, as HyFib last read them from the store. Change orders in the store itself.
          </CardDescription>
          <form
            method="get"
            className="flex flex-wrap items-end gap-3 pt-2"
            role="search"
            aria-label="Search orders"
          >
            <div className="grid gap-1">
              <Label htmlFor="q">Search</Label>
              <Input
                id="q"
                name="q"
                defaultValue={q}
                maxLength={100}
                placeholder="Order, name, number or email"
                className="w-64"
              />
            </div>
            <Button type="submit" variant="outline">
              Search
            </Button>
            {q ? (
              <Link
                href={`${base}/${storeId}/orders`}
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                Clear
              </Link>
            ) : null}
          </form>
        </CardHeader>
        <CardContent className="p-0">
          {data.orders.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              {q ? 'No order matches your search.' : 'No orders read from this store yet.'}
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Order</TH>
                  <TH>Customer</TH>
                  <TH>Status</TH>
                  <TH>Total</TH>
                </TR>
              </THead>
              <TBody>
                {data.orders.map((o) => (
                  <TR key={o.id}>
                    <TD>
                      <Link
                        href={`${base}/orders/${o.id}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {o.name}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {formatDateTime(o.placedAt, tz)}
                      </span>
                    </TD>
                    <TD className="text-sm">
                      {o.redactedAt ? (
                        <span className="text-muted-foreground">Details removed</span>
                      ) : (
                        <>
                          {o.customerName ?? (
                            <span className="text-muted-foreground">Name not shared</span>
                          )}
                          {o.customerPhone ? (
                            <span className="block font-mono text-xs text-muted-foreground">
                              {o.customerPhone}
                            </span>
                          ) : null}
                        </>
                      )}
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={STORE_ORDER_STATUS[o.status]?.tone ?? 'neutral'}>
                          {STORE_ORDER_STATUS[o.status]?.label ?? statusText(o.status)}
                        </Badge>
                        {o.financialStatus ? (
                          <Badge tone="neutral">{statusText(o.financialStatus)}</Badge>
                        ) : null}
                        {o.fulfillmentStatus ? (
                          <Badge tone="neutral">{statusText(o.fulfillmentStatus)}</Badge>
                        ) : null}
                        {o.test ? <Badge tone="warning">Test order</Badge> : null}
                      </div>
                    </TD>
                    <TD className="text-sm">
                      {o.totalMinor !== null && o.currency
                        ? formatMinor(o.totalMinor, o.currency)
                        : 'Not known'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {data.next ? (
            <div className="px-6 py-4">
              <Link
                href={pageHref(data.next)}
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                Older orders →
              </Link>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
