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
import {
  FAILURE_COMPANIES_SHOWN,
  FAILURE_REASONS_SHOWN,
  MESSAGE_DAYS_KEPT,
  USAGE_WINDOWS,
  opsCompanyPage,
  usageChange,
} from '@w360/domain';
import { CompanyLink, CompanyPager, StatTile } from '@/components/platform/ops';
import { DailyMessages } from '@/components/platform/daily-messages';
import { FailureCompaniesTable } from '@/components/platform/failure-companies';
import { FailureReasonsTable } from '@/components/platform/failure-reasons';
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
  // The year, from the counts the worker keeps as days pass (ADR-341), and its failed sends by
  // reason (ADR-350).
  const year = await platformOps.messageYear(actor);
  const reasonYear = await platformOps.failureReasonYear(actor);
  // And by company, month by month (ADR-362).
  const companyYear = await platformOps.failureCompanyYear(actor);
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
          <DailyMessages
            days={o.daily}
            label={`Messages sent and received each UTC day, ${o.days} days`}
            empty="No company sent or received a message since the period started."
            failed={{
              label: `Share of the messages sent that failed each UTC day, ${o.days} days`,
              noneSent: 'No company sent a message in these days, so none failed.',
              period: `${o.days} days`,
            }}
            delivered={{
              label: `Share of the messages sent that were delivered and read each UTC day, ${o.days} days`,
              legend: 'Delivered and read, legend',
              noneSent: 'No company sent a message in these days, so none was delivered.',
            }}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Failed sends by reason ({o.days} days)</CardTitle>
          <CardDescription>
            Every company&apos;s failed sends of the {o.days} days by the code they failed with:
            Meta&apos;s, from the status it reported or its answer to the send (or that
            answer&apos;s HTTP status when it carried no code), or HyFib&apos;s own for a send
            refused before it left or whose last attempt could not reach Meta. The{' '}
            {FAILURE_REASONS_SHOWN} most frequent, then the rest together when two or more are left;
            companies deleted are left out. Codes only: the error texts stay in each company&apos;s
            inbox.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FailureReasonsTable
            reasons={o.reasons}
            label={`Failed sends by reason, ${o.days} days`}
            empty="No company's send failed in these days."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>The last 12 months</CardTitle>
          <CardDescription>
            Every company&apos;s messages each UTC day of the 365 before today, as the worker counts
            them once each day has ended and again each day for a week while statuses arrive: a
            status reported later than that is not among them. Today&apos;s are in the chart above.
            {year.uncounted > 0
              ? ` ${year.uncounted} of the 365 days ${year.uncounted === 1 ? 'is' : 'are'} not counted yet, a few more each minute.`
              : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {year.days.length === 0 ? (
            <EmptyState
              title="No day is counted yet"
              description="The worker counts each day after it ends, and the days before it back to a year ago, a few a minute."
            />
          ) : (
            <DailyMessages
              days={year.days}
              label="Messages sent and received each UTC day, the last 12 months"
              empty="No company sent or received a message in the days counted."
              failed={{
                label: 'Share of the messages sent that failed each UTC day, the last 12 months',
                noneSent: 'No company sent a message in the days counted, so none failed.',
                period: 'the last 12 months',
              }}
              delivered={{
                label:
                  'Share of the messages sent that were delivered and read each UTC day, the last 12 months',
                legend: 'Delivered and read in the 12 months, legend',
                noneSent: 'No company sent a message in the days counted, so none was delivered.',
              }}
              // Unlike the window's chart above: names matched in part never find both.
              names={{
                legend: 'Legend of the 12 months',
                summary: 'Table of the 12 months',
                table: 'The 12 months, day by day',
              }}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Failed sends by reason (12 months)</CardTitle>
          <CardDescription>
            Every company&apos;s failed sends of the 365 days before today by the code they failed
            with, as the worker counts them with each day&apos;s messages: the{' '}
            {FAILURE_REASONS_SHOWN} most frequent, then the rest together when two or more are left;
            companies deleted are left out.
            {reasonYear.uncounted > 0
              ? ` ${reasonYear.uncounted} of the 365 days ${reasonYear.uncounted === 1 ? 'is' : 'are'} not counted yet, a few more each minute.`
              : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {reasonYear.uncounted >= MESSAGE_DAYS_KEPT ? (
            <EmptyState
              title="None counted yet"
              description="The worker counts each day's failed sends by code after the day ends, back to a year ago, a few days a minute."
            />
          ) : (
            <FailureReasonsTable
              reasons={reasonYear.reasons}
              label="Failed sends by reason, the last 12 months"
              empty="No company's send failed in the days counted."
              months={{
                months: reasonYear.months,
                byMonth: reasonYear.byMonth,
                label: 'Failed sends by reason and month, the last 12 months',
              }}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Failed sends by company (12 months)</CardTitle>
          <CardDescription>
            The companies whose sends failed most in the 365 days before today, as the worker counts
            them with each day&apos;s messages: the {FAILURE_COMPANIES_SHOWN} with the most, then
            the rest together when two or more are left; companies deleted are left out. Each
            company&apos;s months show when its failures began, grew or faded.
            {companyYear.uncounted > 0
              ? ` ${companyYear.uncounted} of the 365 days ${companyYear.uncounted === 1 ? 'is' : 'are'} not counted yet, a few more each minute.`
              : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {companyYear.uncounted >= MESSAGE_DAYS_KEPT ? (
            <EmptyState
              title="No company counted yet"
              description="The worker counts each day's failed sends by company after the day ends, back to a year ago, a few days a minute."
            />
          ) : (
            <FailureCompaniesTable
              year={companyYear}
              label="Failed sends by company, the last 12 months"
              monthsLabel="Failed sends by company and month, the last 12 months"
              empty="No send of any company failed in the days counted."
            />
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
