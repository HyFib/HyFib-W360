import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import { Button, Card, CardContent, EmptyState, TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import { PageHeader } from '@/components/page-header';
import { SKIP_REASONS, failureLabel } from '@/lib/campaign-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Campaign recipients' };
export const dynamic = 'force-dynamic';

const FILTERS = [
  ['all', 'All'],
  ['pending', 'Waiting'],
  ['skipped', 'Not sent'],
  ['in_progress', 'In progress'],
  ['sent', 'Sent'],
  ['delivered', 'Delivered'],
  ['read', 'Read'],
  ['replied', 'Replied'],
  ['failed', 'Failed'],
] as const;

const MESSAGE_STATUS: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending',
  accepted: 'Accepted by Meta',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  played: 'Played',
  failed: 'Failed',
  canceled: 'Cancelled',
  unknown_outcome: 'Unknown outcome',
};

export default async function RecipientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; campaignId: string }>;
  searchParams: Promise<{ filter?: string; cursor?: string }>;
}) {
  const { slug, campaignId } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'campaigns.read') || !can(ctx, 'contacts.read')) notFound();
  const { campaigns } = await getRuntime();
  const filter = FILTERS.some(([v]) => v === sp.filter) ? (sp.filter as string) : 'all';
  let page: Awaited<ReturnType<typeof campaigns.listRecipients>>;
  let name: string;
  try {
    const view = await campaigns.getCampaign(ctx, campaignId);
    name = view.campaign.name;
    page = await campaigns.listRecipients(ctx, campaignId, {
      filter,
      ...(typeof sp.cursor === 'string' ? { cursor: sp.cursor } : {}),
    });
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const base = `/c/${ctx.tenant.slug}/campaigns/${campaignId}`;
  const tz = ctx.tenant.timezone;
  return (
    <>
      <PageHeader
        title="Recipients"
        description={
          <Link href={base} className="text-primary underline-offset-4 hover:underline">
            {name}
          </Link>
        }
      />
      <nav aria-label="Filter recipients" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map(([value, label]) => (
          <Button key={value} asChild size="sm" variant={value === filter ? 'primary' : 'outline'}>
            <Link
              href={`${base}/recipients?filter=${value}`}
              aria-current={value === filter ? 'page' : undefined}
            >
              {label}
            </Link>
          </Button>
        ))}
      </nav>
      <Card>
        <CardContent className="p-0">
          {page.items.length === 0 ? (
            <div className="p-6">
              <EmptyState title="No recipients" description="Nobody matches this filter." />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Contact</TH>
                  {page.withVariants ? <TH>Variant</TH> : null}
                  <TH>Outcome</TH>
                  <TH>Queued</TH>
                  <TH>Replied</TH>
                </TR>
              </THead>
              <TBody>
                {page.items.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      <Link
                        href={`/c/${ctx.tenant.slug}/contacts/${r.contactId}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {r.displayName ?? r.phoneE164 ?? 'Erased contact'}
                      </Link>
                    </TD>
                    {page.withVariants ? <TD className="text-sm">{r.variant}</TD> : null}
                    <TD className="text-sm">
                      {r.state === 'skipped'
                        ? `Not sent: ${SKIP_REASONS[r.skipReason ?? ''] ?? r.skipReason}`
                        : r.state === 'pending'
                          ? 'Waiting'
                          : r.state === 'canceled'
                            ? 'Cancelled'
                            : (MESSAGE_STATUS[r.messageStatus ?? ''] ?? r.messageStatus ?? '—')}
                      {r.errorCode ? (
                        <span className="block text-xs text-muted-foreground">
                          {failureLabel(r.errorCode)}
                        </span>
                      ) : null}
                      {r.optedOutAt ? (
                        <span className="block text-xs text-muted-foreground">
                          Opted out afterwards
                        </span>
                      ) : null}
                    </TD>
                    <TD className="text-sm text-muted-foreground">
                      {r.queuedAt ? formatDateTime(r.queuedAt.toISOString(), tz) : '—'}
                    </TD>
                    <TD className="text-sm text-muted-foreground">
                      {r.repliedAt ? formatDateTime(r.repliedAt.toISOString(), tz) : '—'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {page.nextCursor ? (
        <div className="mt-4">
          <Button asChild variant="outline">
            <Link href={`${base}/recipients?filter=${filter}&cursor=${page.nextCursor}`}>
              Next page
            </Link>
          </Button>
        </div>
      ) : null}
    </>
  );
}
