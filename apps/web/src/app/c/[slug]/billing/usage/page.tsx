import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  RATE_CATEGORY_LABELS,
  assertCan,
  can,
  formatMicros,
  formatRateChange,
  formatUnitPrice,
  priceKey,
  type RateCardView,
  type RateChange,
  type TenantContext,
  type UsageAndRates,
} from '@w360/domain';
import {
  Alert,
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
import { formatDateTime } from '@/lib/format';
import { formatCount, formatDayLong } from '@/lib/report-format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Usage and rates' };
export const dynamic = 'force-dynamic';

const CATEGORIES = Object.keys(RATE_CATEGORY_LABELS) as (keyof typeof RATE_CATEGORY_LABELS)[];

/** Meta's rates for the company's billing currency and this month's estimate (ADR-060). */
export default async function UsagePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'billing.read');
  const { billingUsage } = await getRuntime();
  const usage = await billingUsage.usageAndRates(ctx);
  const tz = ctx.tenant.timezone;
  const { currency, current, next } = usage;

  return (
    <div className="grid grid-cols-1 gap-6">
      <a
        href={`/c/${ctx.tenant.slug}/billing`}
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        ← Billing
      </a>
      <PageHeader
        title="Usage and rates"
        description="Meta bills your WhatsApp account directly for delivered messages. HyFib estimates those charges from Meta’s published rates so you can plan; estimates are never taken from your service credit."
      />
      {!currency ? (
        <Alert tone="info" title="No billing currency chosen">
          Choose the currency Meta bills you in under <SettingsLink ctx={ctx} /> to see Meta’s rates
          and estimates.
        </Alert>
      ) : !current && !next ? (
        <Alert tone="info" title={`No ${currency} rate card published`}>
          HyFib has not published Meta’s {currency} rates yet, so nothing can be estimated. HyFib
          staff copy the rates from Meta’s published rate cards.
        </Alert>
      ) : null}
      {currency && next ? (
        <Alert
          tone="warning"
          title={
            current
              ? `Meta’s ${currency} rates change on ${formatDateTime(next.effectiveFrom, tz)}`
              : `Meta’s ${currency} rates apply from ${formatDateTime(next.effectiveFrom, tz)}`
          }
        >
          {current
            ? `${usage.changes.length} ${usage.changes.length === 1 ? 'price changes' : 'prices change'}; see what changes below. Estimates for messages from that time use the new rates.`
            : 'Until then no rates are in force, so messages cannot be estimated.'}
        </Alert>
      ) : null}

      <MonthCard usage={usage} ctx={ctx} />

      {currency && current ? (
        <Card>
          <CardHeader>
            <CardTitle>Rates in force</CardTitle>
            <CardDescription>
              Effective {formatDateTime(current.effectiveFrom, tz)}. List prices per delivered
              message (volume tier 0), copied from{' '}
              <SourceLink card={current}>Meta’s rate card</SourceLink>.
              {current.notes ? ` ${current.notes}` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PriceTable card={current} caption={`Meta’s ${currency} rates in force`} />
          </CardContent>
        </Card>
      ) : null}

      {currency && next ? (
        <Card id="changes">
          <CardHeader>
            <CardTitle>
              {current ? 'What changes on ' : 'Rates from '}
              {formatDateTime(next.effectiveFrom, tz)}
            </CardTitle>
            <CardDescription>
              From <SourceLink card={next}>Meta’s rate card</SourceLink> taking effect then.
              {next.notes ? ` ${next.notes}` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!current ? (
              <PriceTable card={next} caption={`Meta’s ${currency} rates from the next change`} />
            ) : usage.changes.length === 0 ? (
              <p className="text-sm text-muted-foreground">The prices stay the same.</p>
            ) : (
              <ChangesTable
                changes={usage.changes}
                currency={currency}
                from={formatDateTime(next.effectiveFrom, tz)}
              />
            )}
          </CardContent>
        </Card>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Estimates use list prices and count every message Meta marks billable; volume-tier discounts
        are not applied, so Meta’s invoice can be lower. Meta’s invoice is authoritative.
      </p>
    </div>
  );
}

function SettingsLink({ ctx }: { ctx: TenantContext }) {
  return can(ctx, 'tenant.settings.manage') ? (
    <Link
      href={`/c/${ctx.tenant.slug}/settings/messaging`}
      className="text-primary underline-offset-4 hover:underline"
    >
      Settings → Messaging
    </Link>
  ) : (
    <>Settings → Messaging (ask an owner or administrator)</>
  );
}

function SourceLink({ card, children }: { card: RateCardView; children: ReactNode }) {
  return (
    <a
      href={card.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline-offset-4 hover:underline"
    >
      {children}
    </a>
  );
}

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="grid gap-1 rounded-md border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold">{value}</dd>
      {detail ? <dd className="text-xs text-muted-foreground">{detail}</dd> : null}
    </div>
  );
}

function MonthCard({ usage, ctx }: { usage: UsageAndRates; ctx: TenantContext }) {
  const { charges: c, period, currency } = usage;
  const unpriced =
    c.unpriced.noCurrency +
    c.unpriced.noRateCard +
    c.unpriced.otherCategory +
    c.unpriced.marketUnknown +
    c.unpriced.noPrice;
  const reasons: [string, number][] = [
    ['No billing currency chosen', c.unpriced.noCurrency],
    ['No rate card in force when the message was recorded', c.unpriced.noRateCard],
    ['Pricing category without a rate on the card', c.unpriced.otherCategory],
    ['Recipient’s market unknown (not on the card, or recipient erased)', c.unpriced.marketUnknown],
    ['No price for the market and category', c.unpriced.noPrice],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>This month so far</CardTitle>
        <CardDescription>
          {formatDayLong(period.from)} to {formatDayLong(period.to)} ({period.timezone}). Each
          message is priced with the rates in force when it was recorded.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-6">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Stat
            label="Estimated Meta charges"
            value={currency ? formatMicros(c.totalMicros, currency) : '—'}
            detail={`${formatCount(c.priced)} priced of ${formatCount(c.billable)} billable delivered messages`}
          />
          <Stat
            label="Delivered messages"
            value={formatCount(c.delivered)}
            detail="Meta charges only delivered messages"
          />
          <Stat
            label="Free (reported by Meta)"
            value={formatCount(c.free)}
            detail="For example replies in a customer service window"
          />
          <Stat
            label="Not priced by Meta yet"
            value={formatCount(c.notReported)}
            detail="Delivered without pricing in Meta’s status update"
          />
        </dl>
        {currency && usage.byCategory.length > 0 ? (
          <Table>
            <caption className="sr-only">Estimated Meta charges by pricing category</caption>
            <THead>
              <TR>
                <TH scope="col">Pricing category</TH>
                <TH scope="col" className="text-right">
                  Messages
                </TH>
                <TH scope="col" className="text-right">
                  Estimate
                </TH>
              </TR>
            </THead>
            <TBody>
              {usage.byCategory.map((line) => (
                <TR key={line.category}>
                  <TD>{RATE_CATEGORY_LABELS[line.category]}</TD>
                  <TD className="text-right">{formatCount(line.count)}</TD>
                  <TD className="text-right">{formatMicros(line.micros, currency)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : c.delivered === 0 ? (
          <EmptyState
            title="No delivered messages this month"
            description="Messages your company sends appear here once WhatsApp delivers them."
          />
        ) : null}
        {unpriced > 0 ? (
          <div className="grid gap-2 text-sm">
            <h3 className="font-medium">
              {unpriced} billable {unpriced === 1 ? 'message' : 'messages'} could not be priced
            </h3>
            <ul className="list-disc pl-5 text-muted-foreground">
              {reasons
                .filter(([, n]) => n > 0)
                .map(([reason, n]) => (
                  <li key={reason}>
                    {reason}: {n}
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
        {can(ctx, 'reports.read') ? (
          <p className="text-sm">
            <Link
              href={`/c/${ctx.tenant.slug}/reports?preset=this_month`}
              className="text-primary underline-offset-4 hover:underline"
            >
              See the estimate by market in Reports
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PriceTable({ card, caption }: { card: RateCardView; caption: string }) {
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <THead>
        <TR>
          <TH scope="col">Market</TH>
          {CATEGORIES.map((category) => (
            <TH key={category} scope="col" className="text-right">
              {RATE_CATEGORY_LABELS[category]}
            </TH>
          ))}
        </TR>
      </THead>
      <TBody>
        {card.markets.map((market) => (
          <TR key={market}>
            <TD>{market}</TD>
            {CATEGORIES.map((category) => (
              <TD key={category} className="whitespace-nowrap text-right">
                <Price
                  micros={card.prices.get(priceKey(market, category)) ?? null}
                  currency={card.currency}
                />
              </TD>
            ))}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/** A list price, or a dash that reads "not priced" (a missing price is never shown as zero). */
function Price({ micros, currency }: { micros: number | null; currency: string }) {
  return micros === null ? (
    <span className="text-muted-foreground">
      —<span className="sr-only">not priced</span>
    </span>
  ) : (
    <>{formatUnitPrice(micros, currency)}</>
  );
}

function ChangesTable({
  changes,
  currency,
  from,
}: {
  changes: RateChange[];
  currency: string;
  from: string;
}) {
  return (
    <Table>
      <caption className="sr-only">Prices that change on {from}</caption>
      <THead>
        <TR>
          <TH scope="col">Market</TH>
          <TH scope="col">Pricing category</TH>
          <TH scope="col" className="text-right">
            Now
          </TH>
          <TH scope="col" className="text-right">
            From {from}
          </TH>
          <TH scope="col" className="text-right">
            Change
          </TH>
        </TR>
      </THead>
      <TBody>
        {changes.map((c) => (
          <TR key={priceKey(c.market, c.category)}>
            <TD>{c.market}</TD>
            <TD>{RATE_CATEGORY_LABELS[c.category]}</TD>
            <TD className="whitespace-nowrap text-right">
              <Price micros={c.currentMicros} currency={currency} />
            </TD>
            <TD className="whitespace-nowrap text-right">
              <Price micros={c.nextMicros} currency={currency} />
            </TD>
            <TD className="whitespace-nowrap text-right">{formatRateChange(c, currency)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
