import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { PageHeader } from '@/components/page-header';
import { CAMPAIGN_STATUS } from '@/lib/campaign-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Campaigns' };
export const dynamic = 'force-dynamic';

export default async function CampaignsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { slug } = await params;
  const { cursor } = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'campaigns.read')) notFound();
  const { campaigns } = await getRuntime();
  let list: Awaited<ReturnType<typeof campaigns.listCampaigns>>;
  try {
    list = await campaigns.listCampaigns(ctx, {
      cursor: typeof cursor === 'string' ? cursor : undefined,
    });
  } catch (error) {
    if (!isAppError(error) || error.code !== 'validation_failed') throw error;
    list = await campaigns.listCampaigns(ctx);
  }
  const base = `/c/${ctx.tenant.slug}/campaigns`;
  const tz = ctx.tenant.timezone;
  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Approved templates sent to a saved audience, with consent and suppression checked again before every message."
        actions={
          can(ctx, 'campaigns.write') ? (
            <Button asChild>
              <Link href={`${base}/new`}>New campaign</Link>
            </Button>
          ) : null
        }
      />
      <Card>
        <CardContent className="p-0">
          {list.items.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No campaigns yet"
                description="Create a draft, choose an approved template and an audience, review, then start or send it for approval."
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Campaign</TH>
                  <TH>Status</TH>
                  <TH>Template</TH>
                  <TH>Audience</TH>
                  <TH>Handed to WhatsApp</TH>
                  <TH>Created</TH>
                </TR>
              </THead>
              <TBody>
                {list.items.map((c) => {
                  const status = CAMPAIGN_STATUS[c.status] ?? {
                    label: c.status,
                    tone: 'neutral' as const,
                  };
                  return (
                    <TR key={c.id}>
                      <TD className="font-medium">
                        <Link
                          href={`${base}/${c.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {c.name}
                        </Link>
                      </TD>
                      <TD>
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </TD>
                      <TD className="text-sm">{c.templateName ?? '—'}</TD>
                      <TD className="text-sm">{c.status === 'draft' ? '—' : c.audienceCount}</TD>
                      <TD className="text-sm">{c.status === 'draft' ? '—' : c.queuedCount}</TD>
                      <TD className="text-sm text-muted-foreground">
                        {formatDateTime(c.createdAt.toISOString(), tz)}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {list.nextCursor ? (
        <div className="mt-4">
          <Button asChild variant="outline">
            <Link href={`${base}?cursor=${encodeURIComponent(list.nextCursor)}`}>
              Older campaigns
            </Link>
          </Button>
        </div>
      ) : null}
    </>
  );
}
