import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import {
  AnswerRequestButton,
  StoreReconnectButton,
  StoreRemoveButton,
  StoreSettingsForm,
  StoreSyncButton,
} from '@/components/stores/store-actions';
import { STORE_PLATFORM, STORE_STATE } from '@/lib/commerce-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Store' };
export const dynamic = 'force-dynamic';

export default async function StorePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; storeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, storeId } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read')) notFound();
  const { stores } = await getRuntime();
  let detail: Awaited<ReturnType<typeof stores.store>>;
  try {
    detail = await stores.store(ctx, storeId);
  } catch (error) {
    if (isAppError(error) && (error.code === 'not_found' || error.code === 'validation_failed')) {
      notFound();
    }
    throw error;
  }
  const { store, orders, pendingReads, privacyRequests, canManage } = detail;
  const tz = ctx.tenant.timezone;
  const state = STORE_STATE[store.state];
  const base = `/c/${ctx.tenant.slug}/commerce/stores/${store.id}`;
  const address = store.shopDomain ?? store.storeUrl;
  const canSeeOrders = can(ctx, 'contacts.read');
  // WooCommerce sends the owner back with success=0 when they deny access (WC-003).
  const denied = sp.success === '0' && store.state === 'authorizing';
  const openRequests = privacyRequests.filter((r) => r.kind === 'data_request' && !r.answeredAt);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid min-w-0 content-start gap-6">
        <Card className="min-w-0">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{store.name ?? address}</CardTitle>
              <Badge tone={state?.tone ?? 'neutral'}>{state?.label ?? store.state}</Badge>
            </div>
            <CardDescription>
              {STORE_PLATFORM[store.platform]} · {address}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            {denied ? (
              <Alert tone="warning">
                Access was not approved in WooCommerce. Connect the store again to try once more.
              </Alert>
            ) : null}
            {store.state === 'authorizing' && !denied ? (
              <Alert tone="info">
                Waiting for the store owner to approve HyFib. If the approval page was closed,
                connect the store again.
              </Alert>
            ) : null}
            {store.state === 'connecting' ? (
              <Alert tone="info">
                HyFib is finishing the connection with the store. Reload in a moment.
              </Alert>
            ) : null}
            {store.state === 'connected' && !store.backfilledAt ? (
              <Alert tone="info">
                HyFib is reading the store’s orders from the last 60 days and its products for the
                first time. Reload in a moment.
              </Alert>
            ) : null}
            {store.statusError ? <Alert tone="danger">{store.statusError}</Alert> : null}
            {store.state === 'connected' && store.syncError ? (
              <Alert tone="warning">
                The last read did not finish: {store.syncError} HyFib tries again in a few minutes.
              </Alert>
            ) : null}
            {store.webhookError ? <Alert tone="warning">{store.webhookError}</Alert> : null}
            {store.detailsWithheld ? (
              <Alert tone="info">
                Shopify did not share customers’ names, numbers and emails, so orders cannot be
                linked to contacts. HyFib’s Shopify app needs Shopify’s approval for protected
                customer data.
              </Alert>
            ) : null}
            {store.productsTruncated ? (
              <Alert tone="info">HyFib keeps the first 20,000 products of a store.</Alert>
            ) : null}
            <dl className="grid gap-1">
              <div>
                <dt className="inline font-medium">Orders: </dt>
                <dd className="inline">
                  {orders}
                  {canSeeOrders ? (
                    <>
                      {' · '}
                      <Link
                        href={`${base}/orders`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        View orders
                      </Link>
                    </>
                  ) : null}
                  {' · '}
                  <Link
                    href={`${base}/products`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    View products
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">Currency: </dt>
                <dd className="inline">{store.currency ?? 'Not known yet'}</dd>
              </div>
              <div>
                <dt className="inline font-medium">First read finished: </dt>
                <dd className="inline">
                  {store.backfilledAt ? formatDateTime(store.backfilledAt, tz) : 'Not yet'}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">Last read: </dt>
                <dd className="inline">
                  {store.syncedAt ? formatDateTime(store.syncedAt, tz) : 'Not yet'}
                </dd>
              </div>
              {store.state === 'connected' && store.nextSyncAt ? (
                <div>
                  <dt className="inline font-medium">Next read: </dt>
                  <dd className="inline">{formatDateTime(store.nextSyncAt, tz)}</dd>
                </div>
              ) : null}
              {pendingReads > 0 ? (
                <div>
                  <dt className="inline font-medium">Changes waiting to be read: </dt>
                  <dd className="inline">{pendingReads}</dd>
                </div>
              ) : null}
              <div>
                <dt className="inline font-medium">Webhooks last checked: </dt>
                <dd className="inline">
                  {store.webhooksCheckedAt
                    ? formatDateTime(store.webhooksCheckedAt, tz)
                    : 'Not yet'}
                </dd>
              </div>
              {store.uninstalledAt ? (
                <div>
                  <dt className="inline font-medium">Uninstalled in Shopify: </dt>
                  <dd className="inline">{formatDateTime(store.uninstalledAt, tz)}</dd>
                </div>
              ) : null}
            </dl>
            {canManage ? (
              <div className="flex flex-wrap items-start gap-3">
                {store.state === 'connected' ? (
                  <StoreSyncButton slug={ctx.tenant.slug} storeId={store.id} />
                ) : null}
                {['failed', 'uninstalled', 'authorizing'].includes(store.state) ? (
                  <StoreReconnectButton
                    slug={ctx.tenant.slug}
                    platform={store.platform}
                    address={address}
                  />
                ) : null}
                {store.state !== 'removing' ? (
                  <StoreRemoveButton
                    slug={ctx.tenant.slug}
                    storeId={store.id}
                    platform={store.platform}
                  />
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>

        {store.platform === 'shopify' ? (
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Customers’ privacy requests</CardTitle>
              <CardDescription>
                Shopify passes on customers’ requests. HyFib removes a customer’s details from the
                orders it keeps when asked, and lists requests for data so you can answer the
                customer with what HyFib holds.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {privacyRequests.length === 0 ? (
                <p className="text-muted-foreground">No requests.</p>
              ) : (
                <ul className="grid gap-3">
                  {privacyRequests.map((r) => (
                    <li key={r.id} className="grid gap-1 rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          tone={
                            r.kind === 'redact' ? 'neutral' : r.answeredAt ? 'success' : 'warning'
                          }
                        >
                          {r.kind === 'redact'
                            ? 'Details removed'
                            : r.answeredAt
                              ? 'Data request answered'
                              : 'Data request'}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(r.receivedAt, tz)}
                        </span>
                      </div>
                      {r.kind === 'redact' ? (
                        <p className="text-muted-foreground">
                          {r.ordersRedacted ?? 0} order{r.ordersRedacted === 1 ? '' : 's'} no longer
                          keep the customer’s details.
                        </p>
                      ) : (
                        <>
                          {r.customerEmail || r.customerPhone ? (
                            <p>
                              From {[r.customerEmail, r.customerPhone].filter(Boolean).join(' · ')}
                            </p>
                          ) : null}
                          {r.orderIds.length > 0 ? (
                            <p className="text-muted-foreground">
                              Orders named: {r.orderIds.join(', ')}
                            </p>
                          ) : null}
                          {canManage && !r.answeredAt ? (
                            <AnswerRequestButton slug={ctx.tenant.slug} requestId={r.id} />
                          ) : null}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {openRequests.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Answer within 30 days. The customer’s store orders are listed on the orders page
                  (search by their email or number).
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="grid min-w-0 content-start gap-6">
        {canManage ? (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Linking customers</CardTitle>
              <CardDescription>
                Orders are linked to contacts with the same phone number.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <StoreSettingsForm
                slug={ctx.tenant.slug}
                storeId={store.id}
                callingCode={store.phoneCallingCode}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
