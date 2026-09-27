import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import {
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
import { ChatLinkForm } from '@/components/growth/link-forms';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Chat links' };
export const dynamic = 'force-dynamic';

export default async function ChatLinksPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ archived?: string }>;
}) {
  const { slug } = await params;
  const { archived } = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'campaigns.read')) notFound();
  const { growth } = await getRuntime();
  const showArchived = archived === '1';
  const [links, channels] = await Promise.all([
    growth.listLinks(ctx, { archived: showArchived }),
    growth.channelOptions(ctx),
  ]);
  const base = `/c/${ctx.tenant.slug}/growth`;
  const tz = ctx.tenant.timezone;
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{showArchived ? 'Archived links' : 'Chat links'}</CardTitle>
          <CardDescription>
            Each link opens a chat with one of your numbers, with a message the customer can send.
            Share the short link or its QR code. Clicks are counted per day, without recording
            anything about the visitor; conversations count when the customer sends the reference
            code.{' '}
            <Link
              href={showArchived ? base : `${base}?archived=1`}
              className="text-primary underline-offset-4 hover:underline"
            >
              {showArchived ? 'Show active links' : 'Show archived links'}
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {links.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              {showArchived ? 'No archived links.' : 'No links yet.'}
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Number</TH>
                  <TH>Clicks (30 days)</TH>
                  <TH>Conversations (30 days)</TH>
                  <TH>Created</TH>
                </TR>
              </THead>
              <TBody>
                {links.map((l) => (
                  <TR key={l.id}>
                    <TD className="text-sm">
                      <Link
                        href={`${base}/links/${l.id}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {l.name}
                      </Link>
                    </TD>
                    <TD className="text-sm">
                      {l.channelName}
                      {l.channelActive ? null : (
                        <Badge tone="warning" className="ml-2">
                          Number not active
                        </Badge>
                      )}
                    </TD>
                    <TD className="text-sm">{l.clicks30}</TD>
                    <TD className="text-sm">{l.includeRef ? l.conversations30 : '—'}</TD>
                    <TD className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatDateTime(l.createdAt, tz)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {can(ctx, 'campaigns.write') && !showArchived ? (
        <Card>
          <CardHeader>
            <CardTitle>New chat link</CardTitle>
          </CardHeader>
          <CardContent>
            <ChatLinkForm slug={ctx.tenant.slug} channels={channels} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
