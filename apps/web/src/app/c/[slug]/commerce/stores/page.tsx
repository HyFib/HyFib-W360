import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
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
import { ShopifyConnectForm, WooConnectForm, WooKeysForm } from '@/components/stores/connect-forms';
import { STORE_PLATFORM, STORE_STATE } from '@/lib/commerce-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Stores' };
export const dynamic = 'force-dynamic';

/** Why the Shopify callback sent the member back here (set by /api/stores/shopify/callback). */
const CONNECT_ERRORS: Record<string, string> = {
  invalid:
    'Shopify’s approval could not be verified or has expired. Start connecting the store again.',
  expired: 'This approval is no longer valid. Start connecting the store again.',
  forbidden: 'Only the member who started connecting a store can finish it.',
};

export default async function StoresPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read')) notFound();
  const { stores } = await getRuntime();
  const list = await stores.stores(ctx);
  const canManage = can(ctx, 'commerce.manage');
  const { shopify } = stores.capabilities();
  const tz = ctx.tenant.timezone;
  const base = `/c/${ctx.tenant.slug}/commerce/stores`;
  const error = typeof sp.error === 'string' ? CONNECT_ERRORS[sp.error] : undefined;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid min-w-0 content-start gap-6">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Your stores</CardTitle>
            <CardDescription>
              Shopify and WooCommerce stores connected to HyFib. Their orders and products are kept
              in step with the store, and orders appear next to the customer’s conversations.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {list.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">No store connected yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Store</TH>
                    <TH>Status</TH>
                    <TH>Orders</TH>
                    <TH>Products</TH>
                    <TH>Last read</TH>
                  </TR>
                </THead>
                <TBody>
                  {list.map((store) => {
                    const state = STORE_STATE[store.state];
                    return (
                      <TR key={store.id}>
                        <TD>
                          <Link
                            href={`${base}/${store.id}`}
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            {store.name ?? store.shopDomain ?? store.storeUrl}
                          </Link>
                          <span className="block text-xs text-muted-foreground">
                            {STORE_PLATFORM[store.platform]} · {store.shopDomain ?? store.storeUrl}
                          </span>
                        </TD>
                        <TD>
                          <div className="flex flex-wrap gap-1">
                            <Badge tone={state?.tone ?? 'neutral'}>
                              {state?.label ?? store.state}
                            </Badge>
                            {store.openRequests > 0 ? (
                              <Badge tone="warning">
                                {store.openRequests} data request
                                {store.openRequests === 1 ? '' : 's'}
                              </Badge>
                            ) : null}
                          </div>
                        </TD>
                        <TD className="text-sm">{store.orders}</TD>
                        <TD className="text-sm">{store.products}</TD>
                        <TD className="text-sm">
                          {store.syncedAt ? formatDateTime(store.syncedAt, tz) : 'Not yet'}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {canManage ? (
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Connect a Shopify store</CardTitle>
              <CardDescription>
                HyFib asks Shopify for read access to orders and products only. You approve it in
                your Shopify admin.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {shopify ? (
                <ShopifyConnectForm slug={ctx.tenant.slug} />
              ) : (
                <Alert tone="info">
                  Shopify is not set up for HyFib yet: an operator has to add HyFib’s Shopify app
                  credentials first.
                </Alert>
              )}
            </CardContent>
          </Card>
        ) : null}
        {canManage ? (
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Connect a WooCommerce store</CardTitle>
              <CardDescription>
                WooCommerce asks you to approve Read/Write keys for HyFib: it reads orders and
                products, and uses write access only to create and remove its own webhooks.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6">
              <WooConnectForm slug={ctx.tenant.slug} />
              <details className="grid gap-4 rounded-md border border-border p-4">
                <summary className="cursor-pointer text-sm font-medium">
                  Or connect with REST API keys
                </summary>
                <div className="mt-4">
                  <WooKeysForm slug={ctx.tenant.slug} />
                </div>
              </details>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="grid min-w-0 content-start gap-6">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>What HyFib reads</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm text-muted-foreground">
            <p>
              Orders from the last 60 days when a store is connected, then every new or changed
              order; and the store’s products. HyFib never changes orders, products or customers in
              your store.
            </p>
            <p>
              The store tells HyFib when something changes, and HyFib reads it from the store
              itself. Every hour it also reads what changed, in case a notification was lost.
            </p>
            <p>
              Customers’ names, numbers and emails are kept as the store shares them, and orders are
              shown next to the conversations of contacts with the same number.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
