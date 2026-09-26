import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Badge,
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
import { CreateRateCardForm } from '@/components/platform/rate-card-forms';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Rate cards' };
export const dynamic = 'force-dynamic';

const TONE = { draft: 'neutral', published: 'success', withdrawn: 'warning' } as const;

export default async function RateCardsPage() {
  const actor = await requirePlatformActor();
  const { rateCards } = await getRuntime();
  const list = await rateCards.listRateCards(actor);
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Meta rate cards</h1>
        <p className="text-sm text-muted-foreground">
          Copied from Meta’s published rate cards; used only for cost estimates and spending caps.
          HyFib ships no prices of its own.{' '}
          <Link href="/platform" className="text-primary underline-offset-4 hover:underline">
            Back to platform
          </Link>
        </p>
      </div>
      <Card>
        <CardContent className="p-0">
          {list.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="No rate cards"
                description="Companies see no cost estimates until one is published."
              />
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Currency</TH>
                  <TH>Applies from (UTC)</TH>
                  <TH>Markets</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {list.map((card) => (
                  <TR key={card.id}>
                    <TD className="font-medium">
                      <Link
                        href={`/platform/rate-cards/${card.id}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {card.currency}
                      </Link>
                    </TD>
                    <TD className="text-sm">
                      {card.effectiveFrom.toISOString().slice(0, 16).replace('T', ' ')}
                    </TD>
                    <TD className="text-sm">{card.markets}</TD>
                    <TD>
                      <Badge tone={TONE[card.status]}>{card.status}</Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>New rate card</CardTitle>
          <CardDescription>Saved as a draft; review it, then publish.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateRateCardForm />
        </CardContent>
      </Card>
    </div>
  );
}
