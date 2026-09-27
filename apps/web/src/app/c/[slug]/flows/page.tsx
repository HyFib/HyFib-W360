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
import { FLOW_STATUS, FLOW_SYNC_OP } from '@/lib/flow-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Flows' };
export const dynamic = 'force-dynamic';

export default async function FlowsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ archived?: string }>;
}) {
  const { slug } = await params;
  const { archived } = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'flows.read')) notFound();
  const { flows } = await getRuntime();
  const showArchived = archived === '1';
  const [accounts, list] = await Promise.all([
    flows.accounts(ctx),
    flows.list(ctx, { archived: showArchived }),
  ]);
  const base = `/c/${ctx.tenant.slug}/flows`;
  const tz = ctx.tenant.timezone;
  const canCreate = can(ctx, 'flows.write') && accounts.some((a) => a.connected);

  return (
    <>
      <PageHeader
        title="Flows"
        description="Forms that customers fill in without leaving WhatsApp. Build a draft, check it with Meta, publish it, then send it from a conversation; answers can be saved on the contact."
        actions={
          canCreate ? (
            <Button asChild>
              <Link href={`${base}/new`}>New flow</Link>
            </Button>
          ) : null
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid content-start gap-6">
          {accounts.length === 0 ? (
            <Alert tone="info" title="No WhatsApp account connected">
              Connect a WhatsApp number in Settings → Channels: a flow belongs to one WhatsApp
              account.
            </Alert>
          ) : null}
          <Card>
            <CardContent className="p-0">
              {list.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    title={showArchived ? 'No archived flows' : 'No flows yet'}
                    description={
                      showArchived
                        ? 'Deleted drafts and archived deprecated flows appear here.'
                        : 'Create a flow from the starter form, check it with Meta, then publish it.'
                    }
                  />
                </div>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Flow</TH>
                      <TH>Status</TH>
                      <TH>Sent</TH>
                      <TH>Answered</TH>
                      <TH>Updated</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {list.map((f) => {
                      const status = f.metaStatus ? FLOW_STATUS[f.metaStatus] : undefined;
                      const working = f.syncState === 'queued' || f.syncState === 'running';
                      return (
                        <TR key={f.id}>
                          <TD className="font-medium">
                            <Link
                              href={`${base}/${f.id}`}
                              className="text-primary underline-offset-4 hover:underline"
                            >
                              {f.name}
                            </Link>
                            <span className="block text-xs text-muted-foreground">
                              {f.accountName}
                              {f.usesEndpoint ? ' · fetches data from your endpoint' : ''}
                            </span>
                          </TD>
                          <TD>
                            <div className="flex flex-wrap items-center gap-1">
                              {status ? (
                                <Badge tone={status.tone}>{status.label}</Badge>
                              ) : (
                                <Badge tone="neutral">Not at Meta yet</Badge>
                              )}
                              {working && f.syncOp ? (
                                <Badge tone="info">{FLOW_SYNC_OP[f.syncOp] ?? f.syncOp}…</Badge>
                              ) : null}
                              {f.syncState === 'failed' ? (
                                <Badge tone="danger">Needs attention</Badge>
                              ) : null}
                            </div>
                            {f.validationErrors > 0 ? (
                              <span className="block text-xs text-destructive">
                                Meta found {f.validationErrors} problem
                                {f.validationErrors === 1 ? '' : 's'}
                              </span>
                            ) : f.unsentChanges && !working ? (
                              <span className="block text-xs text-muted-foreground">
                                Changes not at Meta yet
                              </span>
                            ) : null}
                          </TD>
                          <TD className="text-sm">{f.sends}</TD>
                          <TD className="text-sm">{f.responses}</TD>
                          <TD className="text-sm text-muted-foreground">
                            {formatDateTime(f.updatedAt, tz)}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>How flows work</CardTitle>
            <CardDescription>
              Publishing is final at Meta: a published flow cannot change. To change one, make a new
              draft from it and publish that instead.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <Link
              href={showArchived ? base : `${base}?archived=1`}
              className="text-primary underline-offset-4 hover:underline"
            >
              {showArchived ? 'Hide archived flows' : 'Show archived flows'}
            </Link>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
