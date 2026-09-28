import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import {
  Alert,
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
import { PRODUCT_AVAILABILITY } from '@/lib/commerce-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Products' };
export const dynamic = 'force-dynamic';

export default async function CatalogProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; catalogId: string }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { slug, catalogId } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read')) notFound();
  const { commerce } = await getRuntime();
  const q = typeof sp.q === 'string' ? sp.q.slice(0, 100) : '';
  const page = Number.parseInt(sp.page ?? '1', 10) || 1;
  let result: Awaited<ReturnType<typeof commerce.products>>;
  try {
    result = await commerce.products(ctx, catalogId, { q, page });
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const { catalog, products, hasMore } = result;
  const base = `/c/${ctx.tenant.slug}/commerce/catalogs`;
  const tz = ctx.tenant.timezone;
  const pageHref = (p: number) =>
    `${base}/${catalog.id}?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) }).toString()}`;

  return (
    <div className="grid grid-cols-1 gap-6">
      <Link href={base} className="text-sm text-primary underline-offset-4 hover:underline">
        ← All catalogs
      </Link>
      {catalog.disconnectedAt ? (
        <Alert tone="warning">
          This catalog is no longer connected to the WhatsApp account, so its products cannot be
          sent. It stays here for the orders that name its products.
        </Alert>
      ) : null}
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{catalog.name ?? `Catalog ${catalog.metaCatalogId}`}</CardTitle>
          <CardDescription>
            Products as HyFib last read them from Meta
            {catalog.syncedAt ? ` (${formatDateTime(catalog.syncedAt, tz)})` : ''}. Prices and
            availability are Meta’s; change them in Commerce Manager.
            {catalog.truncated ? ' Only the first 5,000 products were read.' : ''}
          </CardDescription>
          <form
            method="get"
            className="flex flex-wrap items-end gap-3 pt-2"
            role="search"
            aria-label="Search products"
          >
            <div className="grid gap-1">
              <Label htmlFor="q">Search</Label>
              <Input
                id="q"
                name="q"
                defaultValue={q}
                maxLength={100}
                placeholder="Name or retailer id"
                className="w-64"
              />
            </div>
            <Button type="submit" variant="outline">
              Search
            </Button>
            {q ? (
              <Link
                href={`${base}/${catalog.id}`}
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                Clear
              </Link>
            ) : null}
          </form>
        </CardHeader>
        <CardContent className="p-0">
          {products.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              {q ? 'No product matches your search.' : 'No products read from this catalog.'}
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>Price</TH>
                  <TH>Availability</TH>
                  <TH>Review</TH>
                </TR>
              </THead>
              <TBody>
                {products.map((p) => (
                  <TR key={p.id}>
                    <TD>
                      <span className="font-medium">{p.name ?? 'No name at Meta'}</span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {p.retailerId}
                      </span>
                    </TD>
                    <TD className="text-sm">{p.priceText ?? 'Not given'}</TD>
                    <TD className="text-sm">
                      {p.availability
                        ? (PRODUCT_AVAILABILITY[p.availability] ?? p.availability)
                        : 'Not given'}
                    </TD>
                    <TD>
                      {p.reviewStatus ? (
                        <Badge tone={p.reviewStatus === 'approved' ? 'success' : 'warning'}>
                          {p.reviewStatus}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">Not given</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {page > 1 || hasMore ? (
        <div className="flex gap-4 text-sm">
          {page > 1 ? (
            <Link
              href={pageHref(page - 1)}
              className="text-primary underline-offset-4 hover:underline"
            >
              Previous page
            </Link>
          ) : null}
          {hasMore ? (
            <Link
              href={pageHref(page + 1)}
              className="text-primary underline-offset-4 hover:underline"
            >
              Next page
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
