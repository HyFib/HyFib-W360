import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { formatUnitPrice } from '@w360/domain';
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
import { RateCardActions } from '@/components/platform/rate-card-forms';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Rate card' };
export const dynamic = 'force-dynamic';

export default async function RateCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requirePlatformActor();
  const { rateCards } = await getRuntime();
  let data: Awaited<ReturnType<typeof rateCards.getRateCard>>;
  try {
    data = await rateCards.getRateCard(actor, id);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const { card, prefixes, prices } = data;
  const markets = [...new Set(prices.map((p) => p.market))];
  const categories = [...new Set(prices.map((p) => p.category))];
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {card.currency} rate card <Badge>{card.status}</Badge>
        </h1>
        <p className="text-sm text-muted-foreground">
          Applies from {card.effectiveFrom.toISOString().slice(0, 16).replace('T', ' ')} UTC.
          Source:{' '}
          <a
            href={card.sourceUrl}
            rel="noreferrer noopener"
            target="_blank"
            className="text-primary underline-offset-4 hover:underline"
          >
            {card.sourceUrl}
          </a>
          {card.notes ? ` · ${card.notes}` : ''} ·{' '}
          <Link
            href="/platform/rate-cards"
            className="text-primary underline-offset-4 hover:underline"
          >
            All rate cards
          </Link>
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
          <CardDescription>Every change is recorded in the platform audit log.</CardDescription>
        </CardHeader>
        <CardContent>
          <RateCardActions id={card.id} status={card.status} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Market</TH>
                <TH>Calling codes</TH>
                {categories.map((c) => (
                  <TH key={c}>{c.replace('_', ' ')}</TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {markets.map((m) => (
                <TR key={m}>
                  <TD className="font-medium">{m}</TD>
                  <TD className="text-sm">
                    {prefixes
                      .filter((p) => p.market === m)
                      .map((p) => `+${p.prefix}`)
                      .join(' ')}
                  </TD>
                  {categories.map((c) => {
                    const price = prices.find(
                      (p) => p.market === m && p.category === c && p.tierFrom === 0,
                    );
                    return (
                      <TD key={c} className="text-sm">
                        {price ? formatUnitPrice(price.priceMicros, card.currency) : '—'}
                      </TD>
                    );
                  })}
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
