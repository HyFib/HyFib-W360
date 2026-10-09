import type { Metadata } from 'next';
import Link from 'next/link';
import {
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
import { USAGE_WINDOWS, opsCompanyPage, usageChange } from '@w360/domain';
import { CompanyLink, CompanyPager, StatTile } from '@/components/platform/ops';
import { DailyMessagesChart } from '@/components/platform/daily-chart';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Usage · Operations' };
export const dynamic = 'force-dynamic';

/** A count in the window before and how it moved (ADR-157); nothing when it is 0 in both. */
function before(current: number, previous: number): string | null {
  const change = usageChange(current, previous);
  if (change === null) return null;
  return previous === 0 ? change : `${previous} before · ${change}`;
}

function Before({ current, previous }: { current: number; previous: number | undefined }) {
  const text = previous === undefined ? null : before(current, previous);
  return text ? (
    <div className="whitespace-nowrap text-xs text-muted-foreground">{text}</div>
  ) : null;
}

export default async function OpsUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; page?: string }>;
}) {
  const actor = await requirePlatformActor();
  const { days, page } = await searchParams;
  const { platformOps } = await getRuntime();
  const o = await platformOps.usage(actor, Number(days ?? 30));
  const t = o.totals;
  // A page of the companies (ADR-331); the totals and the CSV cover them all.
  const shown = opsCompanyPage(o.rows, Number(page ?? 1));
  return (
    <div className="grid grid-cols-1 gap-6">
      <nav aria-label="Period" className="flex flex-wrap gap-2 text-sm">
        {USAGE_WINDOWS.map((w) => (
          <Link
            key={w}
            href={`/platform/ops/usage?days=${w}`}
            aria-current={w === o.days ? 'page' : undefined}
            className={
              w === o.days
                ? 'rounded-md bg-primary px-3 py-1 text-primary-foreground'
                : 'rounded-md border border-border px-3 py-1 text-primary hover:bg-muted'
            }
          >
            {w} days
          </Link>
        ))}
      </nav>
      <section aria-label="Totals" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Messages sent"
          value={t.outbound}
          detail={[
            `${t.campaign} by campaigns · ${t.bot} by automations · ${t.api} through the API`,
            o.previous ? before(t.outbound, o.previous.outbound) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
        <StatTile
          label="Messages received"
          value={t.inbound}
          detail={o.previous ? (before(t.inbound, o.previous.inbound) ?? undefined) : undefined}
        />
        <StatTile label="Webhook deliveries" value={t.webhookDeliveries} />
        <StatTile
          label="Members and numbers"
          value={`${t.members} · ${t.numbers}`}
          detail="Active members · WhatsApp numbers"
        />
      </section>
      <Card>
        <CardHeader>
          <CardTitle>Messages a day</CardTitle>
          <CardDescription>
            Every company&apos;s messages each UTC day of the {o.days} days: the first day from the
            period&apos;s start at {o.since.toISOString().slice(11, 16)} UTC, today so far. Point at
            a day, or focus the chart and use the arrow keys, for its numbers with the sends that
            failed; the table gives every day.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {o.daily.every((d) => d.outbound === 0 && d.inbound === 0) ? (
            <EmptyState
              title="No messages in these days"
              description="No company sent or received a message since the period started."
            />
          ) : (
            <>
              <DailyMessagesChart
                days={o.daily}
                label={`Messages sent and received each UTC day, ${o.days} days`}
              />
              {/* min-w-0: the table scrolls in its box rather than widening the card on a phone. */}
              <details className="min-w-0 rounded-md border border-border p-3">
                <summary className="cursor-pointer text-sm font-medium">Table of the days</summary>
                <Table aria-label="Messages a day" className="mt-3">
                  <THead>
                    <TR>
                      <TH>Day (UTC)</TH>
                      <TH>Sent</TH>
                      <TH>Failed</TH>
                      <TH>Received</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {o.daily.map((d) => (
                      <TR key={d.day}>
                        <TD className="whitespace-nowrap">{d.day}</TD>
                        <TD className="tabular-nums">{d.outbound}</TD>
                        <TD className="tabular-nums">{d.failed}</TD>
                        <TD className="tabular-nums">{d.inbound}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </details>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>By company ({o.days} days)</CardTitle>
            <Button asChild variant="outline" size="sm">
              <a href={`/platform/ops/export/usage?days=${o.days}`} download>
                Download CSV
              </a>
            </Button>
          </div>
          <CardDescription>
            Busiest first. Automation runs and API requests are the plan&apos;s counters for its
            current period (from the date shown); messages sent through the API also count under
            Sent.{' '}
            {o.previous
              ? `Under Sent and Received, the ${o.days} days before and the change.`
              : 'The 90 days before are not compared: the console reads at most 93 days back.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {o.rows.length === 0 ? (
            <EmptyState title="No companies yet" />
          ) : (
            <>
              <CompanyPager
                page={shown}
                href={(n) => `/platform/ops/usage?days=${o.days}&page=${n}`}
              />
              <Table aria-label="Usage by company">
                <THead>
                  <TR>
                    <TH>Company</TH>
                    <TH>Sent</TH>
                    <TH>By</TH>
                    <TH>Received</TH>
                    <TH>Webhook deliveries</TH>
                    <TH>Automation runs</TH>
                    <TH>API requests</TH>
                    <TH>Members</TH>
                    <TH>Numbers</TH>
                  </TR>
                </THead>
                <TBody>
                  {shown.rows.map((a) => (
                    <TR key={a.tenantId}>
                      <TD>
                        <CompanyLink id={a.tenantId} name={a.name} slug={a.slug} />
                      </TD>
                      <TD className="tabular-nums">
                        {a.outbound}
                        <Before current={a.outbound} previous={a.previous?.outbound} />
                      </TD>
                      <TD className="whitespace-nowrap text-xs text-muted-foreground">
                        {a.outbound === 0
                          ? '—'
                          : [
                              ['agents', a.outboundBySender.agent],
                              ['automations', a.outboundBySender.bot],
                              ['campaigns', a.outboundBySender.campaign],
                              ['API', a.outboundBySender.api],
                              ['system', a.outboundBySender.system],
                            ]
                              .filter(([, n]) => Number(n) > 0)
                              .map(([label, n]) => `${n} ${label}`)
                              .join(' · ')}
                      </TD>
                      <TD className="tabular-nums">
                        {a.inbound}
                        <Before current={a.inbound} previous={a.previous?.inbound} />
                      </TD>
                      <TD className="tabular-nums">{a.webhookDeliveries}</TD>
                      <TD className="tabular-nums">
                        {a.automationRuns}
                        {a.runsPeriodStart ? (
                          <div className="text-xs text-muted-foreground">
                            from {a.runsPeriodStart.toISOString().slice(0, 10)}
                          </div>
                        ) : null}
                      </TD>
                      <TD className="tabular-nums">
                        {a.apiRequests}
                        {a.apiPeriodStart ? (
                          <div className="text-xs text-muted-foreground">
                            from {a.apiPeriodStart.toISOString().slice(0, 10)}
                          </div>
                        ) : null}
                      </TD>
                      <TD className="tabular-nums">{a.members}</TD>
                      <TD className="tabular-nums">{a.numbers}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
