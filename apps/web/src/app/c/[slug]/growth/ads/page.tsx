import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import {
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
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Ads' };
export const dynamic = 'force-dynamic';

export default async function AdsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'campaigns.read')) notFound();
  const { growth } = await getRuntime();
  const ads = await growth.adSources(ctx);
  const tz = ctx.tenant.timezone;
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Conversations from click-to-WhatsApp ads (last 30 days)</CardTitle>
        <CardDescription>
          When a customer messages you from a Meta click-to-WhatsApp ad, WhatsApp includes the ad in
          the message; HyFib records which ad it was (not the visitor’s ad click id). Ad spend and
          ad accounts are not connected, so costs per conversation are not shown.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {ads.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            No conversations from ads in the last 30 days.
          </p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Ad</TH>
                <TH>Conversations</TH>
                <TH>Messages from the ad</TH>
                <TH>Last</TH>
              </TR>
            </THead>
            <TBody>
              {ads.map((a, i) => (
                <TR key={`${a.sourceId ?? 'none'}-${i}`}>
                  <TD className="text-sm">
                    <span className="font-medium">{a.headline ?? 'Untitled ad'}</span>
                    <span className="block text-xs text-muted-foreground">
                      {a.sourceType ?? 'ad'}
                      {a.sourceId ? ` ${a.sourceId}` : ''}
                    </span>
                    {a.sourceUrl ? (
                      <a
                        href={a.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="block break-all text-xs text-primary underline-offset-4 hover:underline"
                      >
                        {a.sourceUrl}
                      </a>
                    ) : null}
                  </TD>
                  <TD className="text-sm">{a.conversations}</TD>
                  <TD className="text-sm">{a.messages}</TD>
                  <TD className="whitespace-nowrap text-sm text-muted-foreground">
                    {formatDateTime(a.lastAt, tz)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
