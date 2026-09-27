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
import { statusText } from '@/lib/commerce-labels';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Store products' };
export const dynamic = 'force-dynamic';

export default async function StoreProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; storeId: string }>;
  searchParams: Promise<{ q?: string; cursor?: string }>;
}) {
  const { slug, storeId } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read')) notFound();
  const { stores } = await getRuntime();
  const q = typeof sp.q === 'string' ? sp.q.slice(0, 100) : '';
  let data: Awaited<ReturnType<typeof stores.storeProducts>>;
  let store: Awaited<ReturnType<typeof stores.store>>['store'];
  try {
    store = (await stores.store(ctx, storeId)).store;
    data = await stores.storeProducts(ctx, {
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
  const base = `/c/${ctx.tenant.slug}/commerce/stores/${storeId}`;
  const pageHref = (cursor: string) =>
    `${base}/products?${new URLSearchParams({ ...(q ? { q } : {}), cursor }).toString()}`;
  const price = (p: (typeof data.products)[number]) => {
    if (p.priceMinMinor === null || p.priceMaxMinor === null || !p.currency) return 'Not known';
    if (p.priceMinMinor === p.priceMaxMinor) {
      const text = formatMinor(p.priceMinMinor, p.currency);
      return (p.variants ?? 1) > 1 ? `From ${text}` : text;
    }
    return `${formatMinor(p.priceMinMinor, p.currency)} – ${formatMinor(p.priceMaxMinor, p.currency)}`;
  };

  return (
    <div className="grid grid-cols-1 gap-6">
      <Link href={base} className="text-sm text-primary underline-offset-4 hover:underline">
        ← {store.name ?? store.shopDomain ?? store.storeUrl}
      </Link>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Products</CardTitle>
          <CardDescription>
            As HyFib last read them from the store. Change products in the store itself.
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
                placeholder="Title or SKU"
                className="w-64"
              />
            </div>
            <Button type="submit" variant="outline">
              Search
            </Button>
            {q ? (
              <Link
                href={`${base}/products`}
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                Clear
              </Link>
            ) : null}
          </form>
        </CardHeader>
        <CardContent className="p-0">
          {data.products.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              {q ? 'No product matches your search.' : 'No products read from this store yet.'}
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>Price</TH>
                  <TH>Stock</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {data.products.map((p) => (
                  <TR key={p.id}>
                    <TD>
                      {p.url ? (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {p.title}
                        </a>
                      ) : (
                        <span className="font-medium">{p.title}</span>
                      )}
                      {p.sku ? (
                        <span className="block font-mono text-xs text-muted-foreground">
                          {p.sku}
                        </span>
                      ) : null}
                    </TD>
                    <TD className="text-sm">{price(p)}</TD>
                    <TD className="text-sm">{p.inventory ?? 'Not tracked'}</TD>
                    <TD>
                      <Badge
                        tone={
                          p.status === 'active' || p.status === 'publish' ? 'success' : 'neutral'
                        }
                      >
                        {p.status === 'publish' ? 'Published' : statusText(p.status)}
                      </Badge>
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
                More products →
              </Link>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
