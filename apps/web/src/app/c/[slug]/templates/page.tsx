import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
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
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { PageHeader } from '@/components/page-header';
import { SyncTemplates } from '@/components/templates/template-actions';
import { formatDateTime } from '@/lib/format';
import { templateStatus } from '@/lib/template-status';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Templates' };
export const dynamic = 'force-dynamic';

export default async function TemplatesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'templates.read')) notFound();
  const { templates } = await getRuntime();
  const [accounts, list] = await Promise.all([
    templates.syncStatus(ctx),
    templates.listTemplates(ctx),
  ]);
  const base = `/c/${ctx.tenant.slug}/templates`;
  const tz = ctx.tenant.timezone;
  const connected = accounts.filter((a) => a.status === 'connected');

  return (
    <>
      <PageHeader
        title="Templates"
        description="Messages approved by Meta that can start a conversation or be sent after the 24-hour window closes."
        actions={
          can(ctx, 'templates.write') && connected.length > 0 ? (
            <Button asChild>
              <Link href={`${base}/new`}>New template</Link>
            </Button>
          ) : null
        }
      />
      {/* One shrinkable column: a wide template table scrolls inside its card on phones. */}
      <div className="grid grid-cols-1 gap-6">
        {accounts.length === 0 ? (
          <Alert tone="info" title="No WhatsApp account connected">
            Connect a WhatsApp number in Settings → Channels to create and sync templates.
          </Alert>
        ) : null}
        {accounts.map((account) => {
          const rows = list.filter((t) => t.whatsappAccountId === account.id);
          return (
            <Card key={account.id}>
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="grid gap-1">
                  <CardTitle>{account.name ?? 'WhatsApp account'}</CardTitle>
                  <CardDescription>
                    {account.status !== 'connected'
                      ? 'This account is not connected; statuses are not being refreshed.'
                      : account.templatesSyncedAt
                        ? `Last checked with Meta ${formatDateTime(account.templatesSyncedAt.toISOString(), tz)}.`
                        : 'Not checked with Meta yet.'}
                  </CardDescription>
                </div>
                {account.status === 'connected' ? (
                  <SyncTemplates slug={ctx.tenant.slug} whatsappAccountId={account.id} />
                ) : null}
              </CardHeader>
              <CardContent className="p-0">
                {rows.length === 0 ? (
                  <div className="p-6 pt-0">
                    <EmptyState
                      title="No templates yet"
                      description="Create one here, or templates made in WhatsApp Manager appear after the next refresh."
                    />
                  </div>
                ) : (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Name</TH>
                        <TH>Language</TH>
                        <TH>Category</TH>
                        <TH>Status</TH>
                        <TH>Sending</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {rows.map((t) => {
                        const status = templateStatus(t.status);
                        return (
                          <TR key={t.id}>
                            <TD className="font-medium">
                              <Link
                                href={`${base}/${t.id}`}
                                className="text-primary underline-offset-4 hover:underline"
                              >
                                {t.name}
                              </Link>
                              {t.origin === 'synced' ? (
                                <span className="ml-2 text-xs text-muted-foreground">
                                  from WhatsApp Manager
                                </span>
                              ) : null}
                            </TD>
                            <TD>{t.language}</TD>
                            <TD className="text-sm">
                              {t.category.charAt(0) + t.category.slice(1).toLowerCase()}
                            </TD>
                            <TD>
                              <Badge tone={status.tone}>{status.label}</Badge>
                            </TD>
                            <TD className="text-sm text-muted-foreground">
                              {t.sendable
                                ? 'Ready'
                                : t.status === 'approved'
                                  ? 'Not supported yet'
                                  : '—'}
                            </TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
