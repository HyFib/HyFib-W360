import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import QRCode from 'qrcode';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import {
  Alert,
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
import { CopyField } from '@/components/growth/copy-field';
import { ArchiveLinkButton, ChatLinkForm } from '@/components/growth/link-forms';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Chat link' };
export const dynamic = 'force-dynamic';

export default async function ChatLinkPage({
  params,
}: {
  params: Promise<{ slug: string; linkId: string }>;
}) {
  const { slug, linkId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'campaigns.read')) notFound();
  const { growth, config } = await getRuntime();
  let detail: Awaited<ReturnType<typeof growth.getLink>>;
  try {
    detail = await growth.getLink(ctx, linkId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const { link, days, canManage } = detail;
  const channels = canManage ? await growth.channelOptions(ctx) : [];
  const shortUrl = `${config.APP_BASE_URL.replace(/\/$/, '')}/l/${link.slug}`;
  // The QR code holds the short link, so scans are counted like clicks.
  const png = await QRCode.toDataURL(shortUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
  });
  const svg = await QRCode.toString(shortUrl, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
  });
  const svgHref = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const file =
    link.name
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'chat-link';
  const total = days.reduce((sum, d) => sum + d.clicks, 0);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid min-w-0 content-start gap-6">
        <div>
          <Link
            href={`/c/${ctx.tenant.slug}/growth`}
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            All chat links
          </Link>
          <h2 className="mt-2 text-xl font-semibold">{link.name}</h2>
          <p className="text-sm text-muted-foreground">
            Opens a chat with {link.channelName}
            {link.includeRef ? `, reference code ${link.refCode}` : ', without a reference code'}.
          </p>
        </div>
        {link.archivedAt ? (
          <Alert tone="warning" title="Archived">
            The short link, its QR code and website buttons using it show “not available” until the
            link is restored.
          </Alert>
        ) : !link.channelActive || !link.waMeUrl ? (
          <Alert tone="warning" title="The number is not active">
            The short link shows “not available” until the number is active again.
          </Alert>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>Share</CardTitle>
            <CardDescription>
              The short link counts clicks, then opens WhatsApp. The direct link skips counting.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <CopyField label="Short link" value={shortUrl} />
            {link.waMeUrl ? (
              <CopyField
                label="Direct WhatsApp link"
                value={link.waMeUrl}
                description="Clicks on this link are not counted; conversations still are, from the reference code."
              />
            ) : null}
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Clicks in the last 30 days: {total}</CardTitle>
            <CardDescription>
              Short link and QR code opens per day ({ctx.tenant.timezone}), including repeated
              clicks and automated visits. Conversations from this link in the last 30 days:{' '}
              {link.includeRef ? link.conversations30 : 'not counted (no reference code)'}.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {days.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">No clicks yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Day</TH>
                    <TH>Clicks</TH>
                  </TR>
                </THead>
                <TBody>
                  {[...days].reverse().map((d) => (
                    <TR key={d.day}>
                      <TD className="text-sm">{d.day}</TD>
                      <TD className="text-sm">{d.clicks}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
        {canManage && !link.archivedAt ? (
          <Card>
            <CardHeader>
              <CardTitle>Edit</CardTitle>
              <CardDescription>
                Printed QR codes keep working: they hold the short link, which always opens the
                current settings.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChatLinkForm
                slug={ctx.tenant.slug}
                channels={channels}
                link={{
                  id: link.id,
                  version: link.version,
                  name: link.name,
                  channelAccountId: link.channelAccountId,
                  message: link.message,
                  includeRef: link.includeRef,
                  refCode: link.refCode,
                }}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
      <div className="grid content-start gap-6">
        <Card>
          <CardHeader>
            <CardTitle>QR code</CardTitle>
            <CardDescription>Opens the short link when scanned.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL */}
            <img
              src={png}
              alt={`QR code for the chat link ${link.name}`}
              width={256}
              height={256}
              className="h-auto w-full max-w-64 rounded-md border border-border bg-white"
            />
            <div className="flex flex-wrap gap-3 text-sm">
              <a
                href={png}
                download={`${file}-qr.png`}
                className="text-primary underline-offset-4 hover:underline"
              >
                Download PNG
              </a>
              <a
                href={svgHref}
                download={`${file}-qr.svg`}
                className="text-primary underline-offset-4 hover:underline"
              >
                Download SVG
              </a>
            </div>
          </CardContent>
        </Card>
        {canManage ? (
          <Card>
            <CardHeader>
              <CardTitle>{link.archivedAt ? 'Restore' : 'Archive'}</CardTitle>
              <CardDescription>
                {link.archivedAt
                  ? 'The short link and QR code work again.'
                  : 'Stops the short link, its QR code and website buttons using it.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ArchiveLinkButton
                slug={ctx.tenant.slug}
                id={link.id}
                version={link.version}
                archived={Boolean(link.archivedAt)}
                name={link.name}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
