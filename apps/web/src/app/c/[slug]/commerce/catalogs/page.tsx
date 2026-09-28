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
import { CatalogSyncButton } from '@/components/commerce/catalog-sync-button';
import { CATALOG_SYNC_STATE } from '@/lib/commerce-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Catalogs' };
export const dynamic = 'force-dynamic';

export default async function CatalogsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read')) notFound();
  const { commerce } = await getRuntime();
  const accounts = await commerce.catalogs(ctx);
  const base = `/c/${ctx.tenant.slug}/commerce/catalogs`;
  const tz = ctx.tenant.timezone;
  const canManage = can(ctx, 'commerce.manage');

  return (
    <div className="grid grid-cols-1 gap-6">
      <Alert tone="info" title="Catalogs are managed at Meta">
        Create products and connect a catalog to your WhatsApp account in Meta Commerce Manager.
        HyFib reads the catalogs connected to each account and their products (up to 5,000 per
        catalog), so you can send products in chats and see product names on orders. HyFib does not
        change your catalog.
      </Alert>
      {accounts.length === 0 ? (
        <Alert tone="info" title="No WhatsApp account connected">
          Connect a WhatsApp number in Settings → Channels first.
        </Alert>
      ) : null}
      {accounts.map((account) => {
        const sync = CATALOG_SYNC_STATE[account.sync.state];
        const working = account.sync.state === 'queued' || account.sync.state === 'running';
        return (
          <Card key={account.id} className="min-w-0">
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{account.name}</CardTitle>
                <Badge tone={sync?.tone ?? 'neutral'}>{sync?.label ?? account.sync.state}</Badge>
                {!account.connected ? <Badge tone="warning">Not connected</Badge> : null}
              </div>
              <CardDescription>
                {account.sync.finishedAt
                  ? `Last read from Meta ${formatDateTime(account.sync.finishedAt, tz)}.`
                  : 'Not read from Meta yet.'}{' '}
                HyFib reads catalogs again every day.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {account.sync.state === 'failed' && account.sync.error ? (
                <Alert tone="danger">{account.sync.error}</Alert>
              ) : null}
              {account.catalogs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {account.sync.finishedAt
                    ? 'Meta reported no catalog connected to this account.'
                    : 'No catalogs read yet.'}
                </p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Catalog</TH>
                      <TH>Products</TH>
                      <TH>Read</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {account.catalogs.map((c) => (
                      <TR key={c.id}>
                        <TD>
                          <Link
                            href={`${base}/${c.id}`}
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            {c.name ?? `Catalog ${c.metaCatalogId}`}
                          </Link>
                          <span className="block font-mono text-xs text-muted-foreground">
                            {c.metaCatalogId}
                          </span>
                          {c.disconnectedAt ? (
                            <Badge tone="warning">No longer connected</Badge>
                          ) : null}
                        </TD>
                        <TD className="text-sm">
                          {c.listed}
                          {c.productCount !== null ? ` of ${c.productCount} at Meta` : ''}
                          {c.truncated ? (
                            <span className="block text-xs text-muted-foreground">
                              Only the first 5,000 were read.
                            </span>
                          ) : null}
                        </TD>
                        <TD className="text-sm text-muted-foreground">
                          {formatDateTime(c.syncedAt, tz)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
              {canManage && account.connected ? (
                <CatalogSyncButton
                  slug={ctx.tenant.slug}
                  whatsappAccountId={account.id}
                  busy={working}
                />
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
