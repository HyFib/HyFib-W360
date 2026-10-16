import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { isAppError } from '@w360/core';
import {
  PERIOD_PRESETS,
  RATE_CATEGORY_LABELS,
  can,
  formatMicros,
  type CloseBucket,
  type MetricDefinition,
  type Report,
  type TenantContext,
} from '@w360/domain';
import { formatMinor } from '@w360/domain/crm-money';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  cn,
} from '@w360/ui';
import { PageHeader } from '@/components/page-header';
import { ReportEmailsForm } from '@/components/reports/report-emails-form';
import { CAMPAIGN_STATUS, failureLabel, percent } from '@/lib/campaign-labels';
import { formatDateTime } from '@/lib/format';
import {
  formatCount,
  formatDay,
  formatDayLong,
  formatDuration,
  formatMonth,
} from '@/lib/report-format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

const PRESET_LABELS: Record<string, string> = {
  last_7_days: 'Last 7 days',
  last_30_days: 'Last 30 days',
  this_month: 'This month',
  last_month: 'Last month',
  custom: 'Custom dates',
};

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'reports.read')) notFound();
  const { reports, reportEmails } = await getRuntime();
  let report: Report;
  let periodError: string | null = null;
  try {
    report = await reports.getReport(ctx, {
      preset: one(sp.preset),
      from: one(sp.from),
      to: one(sp.to),
    });
  } catch (error) {
    if (!isAppError(error) || error.code !== 'validation_failed') throw error;
    periodError = error.publicMessage;
    report = await reports.getReport(ctx, {});
  }
  const { period } = report;
  const tz = ctx.tenant.timezone;
  const emailChoices = await reportEmails.getReportEmails(ctx);
  const exportQuery = `?preset=custom&from=${period.from}&to=${period.to}`;
  const exportHref = can(ctx, 'reports.export')
    ? (section: string) => `/c/${ctx.tenant.slug}/reports/export/${section}${exportQuery}`
    : null;
  const label = (key: string) => report.definitions.find((d) => d.key === key)?.label ?? key;

  return (
    <>
      <PageHeader
        title="Reports"
        description="Messaging outcomes, estimated Meta charges, inbox response and resolution times, CSAT, member activity and campaign funnels, computed from HyFib’s records when the page loads."
      />
      <div className="grid grid-cols-1 gap-6">
        <Card>
          <CardContent className="grid grid-cols-1 gap-4 pt-6">
            {periodError ? (
              <Alert tone="warning" title="Showing the last 7 days instead">
                {periodError}
              </Alert>
            ) : null}
            <form method="get" className="grid items-end gap-4 sm:grid-cols-4">
              <div className="grid gap-1.5">
                <Label htmlFor="rp-preset">Period</Label>
                <Select id="rp-preset" name="preset" defaultValue={period.preset}>
                  {[...PERIOD_PRESETS, 'custom'].map((p) => (
                    <option key={p} value={p}>
                      {PRESET_LABELS[p]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rp-from">From (custom dates)</Label>
                <Input id="rp-from" name="from" type="date" defaultValue={period.from} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rp-to">To (custom dates)</Label>
                <Input id="rp-to" name="to" type="date" defaultValue={period.to} />
              </div>
              <div>
                <Button type="submit" variant="outline">
                  Show report
                </Button>
              </div>
            </form>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {formatDayLong(period.from)} – {formatDayLong(period.to)}
              </span>{' '}
              in {tz} ({period.days.length} {period.days.length === 1 ? 'day' : 'days'}).
              {period.inProgress
                ? ' The period includes today, so its numbers are still moving.'
                : ''}{' '}
              Computed {formatDateTime(report.generatedAt.toISOString(), tz)}. Delivery statuses
              reach HyFib through Meta’s webhooks and can arrive later.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Report emails</CardTitle>
            <CardDescription>
              The totals of this report by email: messages, replies, resolutions, CSAT, automation
              runs, closed deals and estimated Meta charges, never a customer’s details. Your choice
              is yours only; other members choose their own.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <ReportEmailsForm
              slug={ctx.tenant.slug}
              timezone={tz}
              weekly={emailChoices.some((c) => c.frequency === 'weekly')}
              monthly={emailChoices.some((c) => c.frequency === 'monthly')}
            />
            {emailChoices.length > 0 ? (
              <ul className="grid gap-1 text-sm text-muted-foreground">
                {emailChoices.map((c) => (
                  <li key={c.frequency}>
                    {c.frequency === 'weekly' ? 'Weekly' : 'Monthly'}: next on{' '}
                    {formatDateTime(c.nextSendAt.toISOString(), tz)}
                    {c.lastPeriod
                      ? `; last sent for ${formatDayLong(c.lastPeriod.from)} – ${formatDayLong(c.lastPeriod.to)}`
                      : ''}
                    .
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>

        <MessagingSection report={report} label={label} exportHref={exportHref} />
        <CostSection report={report} ctx={ctx} exportHref={exportHref} />
        <InboxSection report={report} label={label} exportHref={exportHref} />
        <CsatSection report={report} label={label} exportHref={exportHref} />
        <AutomationSection report={report} label={label} exportHref={exportHref} />
        <AgentSection report={report} exportHref={exportHref} />
        <CampaignSection report={report} ctx={ctx} exportHref={exportHref} />
        <DealSection report={report} label={label} exportHref={exportHref} />
        <UnavailableSection definitions={report.definitions} />
        <DefinitionsSection definitions={report.definitions} />
      </div>
    </>
  );
}

type ExportHref = ((section: string) => string) | null;

/** A row label cell: a header for assistive technology, styled like body text. */
function RowHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <TH
      scope="row"
      className={cn(
        'h-auto py-3 text-sm font-normal normal-case tracking-normal text-foreground',
        className,
      )}
    >
      {children}
    </TH>
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

function SectionHeader({
  title,
  description,
  exportHref,
  section,
}: {
  title: string;
  description: string;
  exportHref: ExportHref;
  section: string;
}) {
  return (
    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="grid gap-1.5">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
      {exportHref ? (
        <Button asChild variant="outline" size="sm">
          <a href={exportHref(section)} download>
            Export CSV<span className="sr-only"> ({title})</span>
          </a>
        </Button>
      ) : null}
    </CardHeader>
  );
}

function MessagingSection({
  report,
  label,
  exportHref,
}: {
  report: Report;
  label: (key: string) => string;
  exportHref: ExportHref;
}) {
  const m = report.messaging;
  const t = m.totals;
  return (
    <Card>
      <SectionHeader
        title="Messaging outcomes"
        description="Messages recorded in the period, by the day HyFib recorded them. Rates show their denominators."
        exportHref={exportHref}
        section="messaging"
      />
      <CardContent className="grid grid-cols-1 gap-6">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label={label('messaging.inbound')} value={formatCount(t.inbound)} />
          <Stat
            label={label('messaging.outbound')}
            value={formatCount(t.outbound)}
            detail={`${t.byMember} by members, ${t.byCampaign} by campaigns, ${t.byOther} other; ${t.canceled} canceled before sending`}
          />
          <Stat
            label={label('messaging.sent_rate')}
            value={percent(m.rates.sent.numerator, m.rates.sent.denominator)}
            detail={`${m.rates.sent.numerator} of ${m.rates.sent.denominator}; ${t.inProgress} still in progress`}
          />
          <Stat
            label={label('messaging.delivered_rate')}
            value={percent(m.rates.delivered.numerator, m.rates.delivered.denominator)}
            detail={`${m.rates.delivered.numerator} of ${m.rates.delivered.denominator} sent`}
          />
          <Stat
            label={label('messaging.read_rate')}
            value={percent(m.rates.read.numerator, m.rates.read.denominator)}
            detail={`${m.rates.read.numerator} of ${m.rates.read.denominator} delivered (a lower bound)`}
          />
          <Stat
            label={label('messaging.failure_rate')}
            value={percent(m.rates.failure.numerator, m.rates.failure.denominator)}
            detail={`${t.failed} failed, ${t.unknown} unknown outcome, of ${m.rates.failure.denominator}`}
          />
        </dl>
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">Messages per day</caption>
            <THead>
              <TR>
                <TH scope="col">Day</TH>
                <TH scope="col" className="text-right">
                  Customer messages
                </TH>
                <TH scope="col" className="text-right">
                  Sent by you
                </TH>
                <TH scope="col" className="text-right">
                  Delivered
                </TH>
                <TH scope="col" className="text-right">
                  Read
                </TH>
                <TH scope="col" className="text-right">
                  Failed or unknown
                </TH>
              </TR>
            </THead>
            <TBody>
              {m.days.map((d) => (
                <TR key={d.day}>
                  <RowHeader className="whitespace-nowrap">{formatDay(d.day)}</RowHeader>
                  <TD className="text-right">{d.inbound}</TD>
                  <TD className="text-right">{d.outbound}</TD>
                  <TD className="text-right">{d.delivered}</TD>
                  <TD className="text-right">{d.read}</TD>
                  <TD className="text-right">{d.failed + d.unknown}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
        {m.failureCodes.length > 0 ? (
          <div className="grid grid-cols-1 gap-2">
            <h3 className="text-sm font-medium">Why messages failed (Meta’s error codes)</h3>
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH scope="col">Code</TH>
                    <TH scope="col">Meaning</TH>
                    <TH scope="col" className="text-right">
                      Messages
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {m.failureCodes.map((f) => (
                    <TR key={f.code}>
                      <TD className="font-mono text-xs">{f.code}</TD>
                      <TD className="text-sm">{failureLabel(f.code)}</TD>
                      <TD className="text-right">{f.count}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CostSection({
  report,
  ctx,
  exportHref,
}: {
  report: Report;
  ctx: TenantContext;
  exportHref: ExportHref;
}) {
  const c = report.costs;
  const unpriced =
    c.unpriced.noCurrency +
    c.unpriced.noRateCard +
    c.unpriced.otherCategory +
    c.unpriced.marketUnknown +
    c.unpriced.noPrice;
  const reasons: [string, number][] = [
    ['No billing currency chosen', c.unpriced.noCurrency],
    ['No rate card in force for the currency', c.unpriced.noRateCard],
    ['Pricing category without a rate on the card', c.unpriced.otherCategory],
    ['Recipient’s market unknown (not on the card, or recipient erased)', c.unpriced.marketUnknown],
    ['No price for the market and category', c.unpriced.noPrice],
  ];
  return (
    <Card>
      <SectionHeader
        title="Estimated Meta charges"
        description="Meta charges per delivered message and bills your company directly; HyFib does not charge this. These are list-price estimates, not Meta’s invoice."
        exportHref={exportHref}
        section="costs"
      />
      <CardContent className="grid grid-cols-1 gap-6">
        {!c.currency ? (
          <Alert tone="info" title="No billing currency chosen">
            Choose the currency Meta bills you in under{' '}
            {can(ctx, 'tenant.settings.manage') ? (
              <Link
                href={`/c/${ctx.tenant.slug}/settings/messaging`}
                className="text-primary underline-offset-4 hover:underline"
              >
                Settings → Messaging
              </Link>
            ) : (
              'Settings → Messaging'
            )}{' '}
            to see estimates.
          </Alert>
        ) : c.cards.length === 0 ? (
          <Alert tone="info" title={`No ${c.currency} rate card for this period`}>
            No published rate card in {c.currency} was in force during the period, so no message
            could be priced.
          </Alert>
        ) : null}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Stat
            label="Estimated charges"
            value={c.currency ? formatMicros(c.totalMicros, c.currency) : '—'}
            detail={`${c.priced} priced of ${c.billable} billable delivered messages`}
          />
          <Stat
            label="Delivered messages"
            value={formatCount(c.delivered)}
            detail="Only delivered messages are charged"
          />
          <Stat
            label="Free (reported by Meta)"
            value={formatCount(c.free)}
            detail="For example inside the free service tier"
          />
          <Stat
            label="Not priced by Meta yet"
            value={formatCount(c.notReported)}
            detail="Delivered without pricing in the status webhook"
          />
        </dl>
        {c.lines.length > 0 && c.currency ? (
          <CostLines lines={c.lines} currency={c.currency} />
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
        <p className="text-xs text-muted-foreground">
          Priced at the list price (volume tier 0) of the published rate card in force when each
          message was recorded
          {c.cards.length > 0
            ? ` (cards effective ${c.cards
                .map((card) => formatDateTime(card.effectiveFrom.toISOString(), 'UTC'))
                .join(', ')} UTC)`
            : ''}
          . Volume-tier discounts are not applied; Meta’s invoice is authoritative.
        </p>
      </CardContent>
    </Card>
  );
}

function CostLines({ lines, currency }: { lines: Report['costs']['lines']; currency: string }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <caption className="sr-only">Estimated charges by category and market</caption>
        <THead>
          <TR>
            <TH scope="col">Pricing category</TH>
            <TH scope="col">Market</TH>
            <TH scope="col" className="text-right">
              Messages
            </TH>
            <TH scope="col" className="text-right">
              Estimate
            </TH>
          </TR>
        </THead>
        <TBody>
          {lines.map((l) => (
            <TR key={`${l.category}|${l.market}`}>
              <TD>{RATE_CATEGORY_LABELS[l.category]}</TD>
              <TD>{l.market}</TD>
              <TD className="text-right">{l.count}</TD>
              <TD className="text-right">{formatMicros(l.micros, currency)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function InboxSection({
  report,
  label,
  exportHref,
}: {
  report: Report;
  label: (key: string) => string;
  exportHref: ExportHref;
}) {
  const i = report.inbox;
  const n = i.now;
  const t = i.turns;
  return (
    <Card>
      <SectionHeader
        title="Inbox"
        description={`A reply turn starts with the first customer message that has no reply yet and ends when a member replies or the conversation is resolved. ${i.businessHours ? 'Business hours are on: the target and the business-hours figures count opening hours only; other times are absolute.' : 'Times are absolute; business hours are off.'}`}
        exportHref={exportHref}
        section="inbox"
      />
      <CardContent className="grid grid-cols-1 gap-6">
        <div className="grid grid-cols-1 gap-2">
          <h3 className="text-sm font-medium">Right now</h3>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label={label('inbox.open_conversations')} value={n.open} />
            <Stat label={label('inbox.unassigned')} value={n.unassigned} />
            <Stat label={label('inbox.waiting')} value={n.waiting} />
            <Stat label={label('inbox.oldest_wait')} value={formatDuration(n.oldestWaitSeconds)} />
            <Stat
              label={label('inbox.windows_closing')}
              value={n.windowsClosing}
              detail={`${n.windowsClosed} waiting with the window already closed`}
            />
            <Stat
              label={label('inbox.overdue')}
              value={n.overTarget ?? '—'}
              detail={
                i.targetMinutes === null
                  ? 'No target set'
                  : `Target ${i.targetMinutes} min${i.businessHours ? ' of business hours' : ''}`
              }
            />
          </dl>
          {n.byAssignee.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <caption className="sr-only">Waiting customers by assignee</caption>
                <THead>
                  <TR>
                    <TH scope="col">Assigned to</TH>
                    <TH scope="col" className="text-right">
                      Waiting
                    </TH>
                    <TH scope="col" className="text-right">
                      Longest wait
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {n.byAssignee.map((a) => (
                    <TR key={a.membershipId ?? 'unassigned'}>
                      <TD>{a.membershipId ? (a.name ?? 'Former member') : 'Unassigned'}</TD>
                      <TD className="text-right">{a.waiting}</TD>
                      <TD className="text-right">{formatDuration(a.oldestWaitSeconds)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-2">
          <h3 className="text-sm font-medium">Reply turns started in the period</h3>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Stat
              label="Turns"
              value={t.started}
              detail={`${t.answered} answered, ${t.resolvedWithoutReply} resolved without a reply, ${t.waiting} still waiting`}
            />
            <Stat
              label={`${label('inbox.first_response_time')} (median)`}
              value={formatDuration(t.medianSeconds)}
              detail={`90th percentile ${formatDuration(t.p90Seconds)}`}
            />
            <Stat
              label={`${label('inbox.first_response_business_time')} (median)`}
              value={i.businessHours ? formatDuration(t.businessMedianSeconds) : '—'}
              detail={
                i.businessHours
                  ? `90th percentile ${formatDuration(t.businessP90Seconds)}`
                  : 'Business hours are off (Settings → Inbox)'
              }
            />
            <Stat
              label={label('inbox.within_target')}
              value={
                t.withinTarget
                  ? percent(t.withinTarget.numerator, t.withinTarget.denominator)
                  : 'No target'
              }
              detail={
                t.withinTarget
                  ? `${t.withinTarget.numerator} of ${t.withinTarget.denominator} within ${i.targetMinutes} min${i.businessHours ? ' of business hours' : ''}`
                  : 'Set one in Settings → Inbox'
              }
            />
            <Stat
              label={`${label('inbox.resolution_time')} (median)`}
              value={formatDuration(i.resolution.medianSeconds)}
              detail={`${i.resolution.resolved} resolved · 90th percentile ${formatDuration(i.resolution.p90Seconds)}`}
            />
            <Stat
              label="Answered turns by reply time"
              value={
                <ul className="grid gap-0.5 text-sm font-normal">
                  <li>Within 5 min: {t.buckets.upTo5m}</li>
                  <li>5 to 60 min: {t.buckets.upTo1h}</li>
                  <li>1 to 24 h: {t.buckets.upTo24h}</li>
                  <li>Over 24 h: {t.buckets.over24h}</li>
                </ul>
              }
            />
          </dl>
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">Reply turns per day</caption>
              <THead>
                <TR>
                  <TH scope="col">Day</TH>
                  <TH scope="col" className="text-right">
                    Turns
                  </TH>
                  <TH scope="col" className="text-right">
                    Answered
                  </TH>
                  <TH scope="col" className="text-right">
                    Resolved without a reply
                  </TH>
                  <TH scope="col" className="text-right">
                    Still waiting
                  </TH>
                  <TH scope="col" className="text-right">
                    Median first response
                  </TH>
                  {i.businessHours ? (
                    <TH scope="col" className="text-right">
                      Median in business hours
                    </TH>
                  ) : null}
                  <TH scope="col" className="text-right">
                    Cases resolved
                  </TH>
                  <TH scope="col" className="text-right">
                    Median resolution
                  </TH>
                </TR>
              </THead>
              <TBody>
                {i.days.map((d) => (
                  <TR key={d.day}>
                    <RowHeader className="whitespace-nowrap">{formatDay(d.day)}</RowHeader>
                    <TD className="text-right">{d.started}</TD>
                    <TD className="text-right">{d.answered}</TD>
                    <TD className="text-right">{d.resolvedWithoutReply}</TD>
                    <TD className="text-right">{d.waiting}</TD>
                    <TD className="text-right">{formatDuration(d.medianSeconds)}</TD>
                    {i.businessHours ? (
                      <TD className="text-right">{formatDuration(d.businessMedianSeconds)}</TD>
                    ) : null}
                    <TD className="text-right">{d.casesResolved}</TD>
                    <TD className="text-right">{formatDuration(d.medianResolutionSeconds)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const SKIP_LABELS: Record<string, string> = {
  window_closed: 'Window closed',
  opted_out: 'Opted out',
  suppressed: 'Suppressed',
  contact_erased: 'Contact erased',
  no_phone: 'No phone number',
  channel_inactive: 'Number inactive',
  recently_surveyed: 'Asked in the last 24 hours',
};

function CsatSection({
  report,
  label,
  exportHref,
}: {
  report: Report;
  label: (key: string) => string;
  exportHref: ExportHref;
}) {
  const c = report.csat;
  const skipped = Object.entries(c.skipped).filter(([, n]) => n > 0);
  return (
    <Card>
      <SectionHeader
        title="CSAT"
        description="Rating questions sent after a member resolved a conversation, by the day they were sent. The customer’s first tap counts; the best of the three ratings counts as satisfied."
        exportHref={exportHref}
        section="csat"
      />
      <CardContent className="grid grid-cols-1 gap-4">
        {!c.enabled && c.surveys === 0 ? (
          <p className="text-sm text-muted-foreground">
            CSAT surveys are off. An administrator can turn them on in Settings → Inbox.
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Stat
            label={label('csat.score')}
            value={c.score.denominator > 0 ? percent(c.score.numerator, c.score.denominator) : '—'}
            detail={`${c.ratings.best} best, ${c.ratings.middle} middle, ${c.ratings.worst} worst of ${c.answered} ${c.answered === 1 ? 'answer' : 'answers'}`}
          />
          <Stat
            label={label('csat.response_rate')}
            value={
              c.responseRate.denominator > 0
                ? percent(c.responseRate.numerator, c.responseRate.denominator)
                : '—'
            }
            detail={`${c.answered} of ${c.delivered} delivered`}
          />
          <Stat
            label={label('csat.surveys')}
            value={c.sent}
            detail={`sent · ${c.surveys - c.sent} not sent`}
          />
        </dl>
        {skipped.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Not sent:{' '}
            {skipped.map(([reason, n]) => `${SKIP_LABELS[reason] ?? reason} ${n}`).join(' · ')}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

const runsLabel = (n: number) => `${n} ${n === 1 ? 'run' : 'runs'}`;

const FAILURE_LABELS: Record<string, string> = {
  budget_steps: 'step limit',
  budget_loop: 'loop limit',
  budget_messages: 'message limit',
  budget_http: 'web request limit',
  expired: 'older than 7 days',
  send_blocked: 'message could not be sent',
  send_failed: 'message did not reach the customer',
  error: 'could not continue',
};

function AutomationSection({
  report,
  label,
  exportHref,
}: {
  report: Report;
  label: (key: string) => string;
  exportHref: ExportHref;
}) {
  const a = report.automations;
  const t = a.totals;
  const finished = t.started - t.active;
  const share = (n: number) => (finished > 0 ? percent(n, finished) : '—');
  return (
    <Card>
      <SectionHeader
        title="Automations"
        description="Runs of published automations started by customer messages, by the day they started (test runs are left out). Shares are of the runs that have finished."
        exportHref={exportHref}
        section="automations"
      />
      <CardContent className="grid grid-cols-1 gap-4">
        {t.started === 0 ? (
          <p className="text-sm text-muted-foreground">No automation runs in this period.</p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat
                label={label('automation.runs')}
                value={t.started}
                detail={t.active > 0 ? `${t.active} still running` : 'all finished'}
              />
              <Stat label="Completed" value={share(t.completed)} detail={runsLabel(t.completed)} />
              <Stat
                label="Handed off"
                value={share(t.handed_off)}
                detail={runsLabel(t.handed_off)}
              />
              <Stat
                label="Taken over"
                value={share(t.taken_over)}
                detail={runsLabel(t.taken_over)}
              />
              <Stat label="Stopped" value={share(t.stopped)} detail={runsLabel(t.stopped)} />
              <Stat label="Failed" value={share(t.failed)} detail={runsLabel(t.failed)} />
            </dl>
            {a.failures.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                Failures:{' '}
                {a.failures
                  .map((f) => `${FAILURE_LABELS[f.reason] ?? f.reason} ${f.runs}`)
                  .join(' · ')}
              </p>
            ) : null}
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Automation</TH>
                    <TH className="text-right">Runs</TH>
                    <TH className="text-right">Completed</TH>
                    <TH className="text-right">Handed off</TH>
                    <TH className="text-right">Taken over</TH>
                    <TH className="text-right">Stopped</TH>
                    <TH className="text-right">Failed</TH>
                  </TR>
                </THead>
                <TBody>
                  {a.automations.map((row) => (
                    <TR key={row.id}>
                      <RowHeader>{row.name}</RowHeader>
                      <TD className="text-right">{row.started}</TD>
                      <TD className="text-right">{row.completed}</TD>
                      <TD className="text-right">{row.handed_off}</TD>
                      <TD className="text-right">{row.taken_over}</TD>
                      <TD className="text-right">{row.stopped}</TD>
                      <TD className="text-right">{row.failed}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A forecast row's heading (ADR-252): past expected dates count in this month, as on the board. */
function bucketLabel(bucket: CloseBucket, months: readonly [string, string, string]): string {
  switch (bucket) {
    case 'this_month':
      return `${formatMonth(months[0])} (and dates already past)`;
    case 'next_month':
      return formatMonth(months[1]);
    case 'month_after':
      return formatMonth(months[2]);
    case 'later':
      return 'Later';
    case 'undated':
      return 'No expected date';
  }
}

/** Amounts per pipeline currency, never added across currencies. */
function amounts(list: { currency: string; valueMinor: number }[]): string {
  return list.length === 0
    ? 'no value'
    : list.map((a) => formatMinor(a.valueMinor, a.currency)).join(' + ');
}

function DealSection({
  report,
  label,
  exportHref,
}: {
  report: Report;
  label: (key: string) => string;
  exportHref: ExportHref;
}) {
  const d = report.deals;
  const won = d.won.reduce((n, a) => n + a.deals, 0);
  const lost = d.lost.reduce((n, a) => n + a.deals, 0);
  const openPipelines = d.pipelines.filter((p) => p.stages.length > 0);
  return (
    <Card>
      <SectionHeader
        title="Deals"
        description="Deals won or lost in the period, by the day they closed, and the open pipeline now. Values stay in each pipeline’s currency."
        exportHref={exportHref}
        section="deals"
      />
      <CardContent className="grid grid-cols-1 gap-6">
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Deals won" value={formatCount(won)} detail={amounts(d.won)} />
          <Stat label="Deals lost" value={formatCount(lost)} detail={amounts(d.lost)} />
          <Stat
            label={label('crm.win_rate')}
            value={percent(d.winRate.numerator, d.winRate.denominator)}
            detail={`${d.winRate.numerator} of ${d.winRate.denominator} closed`}
          />
          <Stat
            label={label('crm.time_to_win')}
            value={formatDuration(d.medianSecondsToWin)}
            detail="median, deals won in the period"
          />
        </dl>
        {openPipelines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pipelines in use.</p>
        ) : (
          openPipelines.map((p) => (
            <div key={p.id} className="grid gap-2">
              <h3 className="text-sm font-semibold">
                {label('crm.open_pipeline')}: {p.name}
              </h3>
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Stage</TH>
                      <TH className="text-right">Open deals</TH>
                      <TH className="text-right">Value ({p.currency})</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {p.stages.map((s) => (
                      <TR key={s.id}>
                        <RowHeader>{s.name}</RowHeader>
                        <TD className="text-right">{formatCount(s.deals)}</TD>
                        <TD className="text-right">{formatMinor(s.valueMinor, p.currency)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <h3 className="mt-2 text-sm font-semibold">
                {label('crm.forecast')}: {p.name}
              </h3>
              {p.forecast.hasChances ? null : (
                <p className="text-sm text-muted-foreground">
                  No stage of this pipeline has a chance of winning, so nothing is weighed. Set the
                  chances in Settings → Pipelines.
                </p>
              )}
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Expected to close</TH>
                      <TH className="text-right">Open deals</TH>
                      <TH className="text-right">Value ({p.currency})</TH>
                      <TH className="text-right">Weighted ({p.currency})</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {p.forecast.buckets.map((b) => (
                      <TR key={b.bucket}>
                        <RowHeader>{bucketLabel(b.bucket, p.forecast.months)}</RowHeader>
                        <TD className="text-right">{formatCount(b.deals)}</TD>
                        <TD className="text-right">{formatMinor(b.valueMinor, p.currency)}</TD>
                        <TD className="text-right">
                          {p.forecast.hasChances ? formatMinor(b.weightedMinor, p.currency) : '—'}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              {p.forecast.hasChances && p.forecast.dealsWithoutChance > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {formatCount(p.forecast.dealsWithoutChance)}{' '}
                  {p.forecast.dealsWithoutChance === 1 ? 'open deal is' : 'open deals are'} in
                  stages without a chance of winning: counted, but not weighed.
                </p>
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function AgentSection({ report, exportHref }: { report: Report; exportHref: ExportHref }) {
  return (
    <Card>
      <SectionHeader
        title="Member activity"
        description="Replies sent, reply turns answered first, conversations resolved and CSAT answers for conversations assigned to the member when resolved. Members who can reply are listed even when they were quiet."
        exportHref={exportHref}
        section="agents"
      />
      <CardContent className="p-0">
        {report.agents.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No member activity in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH scope="col">Member</TH>
                  <TH scope="col" className="text-right">
                    Replies sent
                  </TH>
                  <TH scope="col" className="text-right">
                    Turns answered
                  </TH>
                  <TH scope="col" className="text-right">
                    Median first response
                  </TH>
                  <TH scope="col" className="text-right">
                    Resolved
                  </TH>
                  <TH scope="col" className="text-right">
                    CSAT
                  </TH>
                </TR>
              </THead>
              <TBody>
                {report.agents.map((a) => (
                  <TR key={a.membershipId}>
                    <RowHeader className="font-medium">
                      {a.name}
                      {a.status !== 'active' ? (
                        <Badge tone="neutral" className="ml-2">
                          {a.status}
                        </Badge>
                      ) : null}
                    </RowHeader>
                    <TD className="text-right">
                      {a.replies}
                      {a.templates > 0 ? (
                        <span className="block text-xs text-muted-foreground">
                          {a.templates} {a.templates === 1 ? 'template' : 'templates'}
                        </span>
                      ) : null}
                    </TD>
                    <TD className="text-right">{a.turnsAnswered}</TD>
                    <TD className="text-right">{formatDuration(a.medianSeconds)}</TD>
                    <TD className="text-right">{a.resolved}</TD>
                    <TD className="text-right">
                      {a.csatAnswered > 0 ? percent(a.csatBest, a.csatAnswered) : '—'}
                      <span className="block text-xs text-muted-foreground">
                        {a.csatAnswered} {a.csatAnswered === 1 ? 'answer' : 'answers'}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CampaignSection({
  report,
  ctx,
  exportHref,
}: {
  report: Report;
  ctx: TenantContext;
  exportHref: ExportHref;
}) {
  const { rows, truncated } = report.campaigns;
  return (
    <Card>
      <SectionHeader
        title="Campaign funnels"
        description="Campaigns that started in the period. Delivered, read and replied use the counts before them as denominators; replies and opt-outs count within 72 hours, last touch."
        exportHref={exportHref}
        section="campaigns"
      />
      <CardContent className="grid grid-cols-1 gap-4 p-0">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No campaign started in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH scope="col">Campaign</TH>
                  <TH scope="col" className="text-right">
                    Audience
                  </TH>
                  <TH scope="col" className="text-right">
                    Handed to WhatsApp
                  </TH>
                  <TH scope="col" className="text-right">
                    Delivered
                  </TH>
                  <TH scope="col" className="text-right">
                    Read
                  </TH>
                  <TH scope="col" className="text-right">
                    Replied
                  </TH>
                  <TH scope="col" className="text-right">
                    Opted out
                  </TH>
                  <TH scope="col" className="text-right">
                    Failed
                  </TH>
                  <TH scope="col" className="text-right">
                    Estimated cost
                  </TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => {
                  const status = CAMPAIGN_STATUS[r.status] ?? {
                    label: r.status,
                    tone: 'neutral' as const,
                  };
                  return (
                    <TR key={r.id}>
                      <RowHeader className="font-medium">
                        <Link
                          href={`/c/${ctx.tenant.slug}/campaigns/${r.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {r.name}
                        </Link>
                        <span className="mt-1 flex items-center gap-2 text-xs font-normal text-muted-foreground">
                          <Badge tone={status.tone}>{status.label}</Badge>
                          {formatDateTime(r.startedAt.toISOString(), ctx.tenant.timezone)}
                        </span>
                      </RowHeader>
                      <TD className="text-right">
                        {r.audience}
                        <span className="block text-xs text-muted-foreground">
                          {r.skipped} not sent
                        </span>
                      </TD>
                      <TD className="text-right">{r.queued}</TD>
                      <TD className="text-right">
                        {r.delivered}
                        <span className="block text-xs text-muted-foreground">
                          {percent(r.delivered, r.sent)} of sent
                        </span>
                      </TD>
                      <TD className="text-right">
                        {r.read}
                        <span className="block text-xs text-muted-foreground">
                          {percent(r.read, r.delivered)}
                        </span>
                      </TD>
                      <TD className="text-right">
                        {r.replied}
                        <span className="block text-xs text-muted-foreground">
                          {percent(r.replied, r.delivered)}
                        </span>
                      </TD>
                      <TD className="text-right">
                        {r.optedOut}
                        <span className="block text-xs text-muted-foreground">
                          {percent(r.optedOut, r.delivered)}
                        </span>
                      </TD>
                      <TD className="text-right">{r.failed + r.unknown}</TD>
                      <TD className="text-right">
                        {r.currency ? formatMicros(r.estimateMicros, r.currency) : '—'}
                        {r.estimateMissing > 0 ? (
                          <span className="block text-xs text-muted-foreground">
                            {r.estimateMissing} unpriced
                          </span>
                        ) : null}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
        {truncated ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            Showing the {rows.length} most recent campaigns of the period; choose a shorter period
            to see the rest.
          </p>
        ) : null}
        <p className="px-6 pb-6 text-xs text-muted-foreground">
          Clicks and conversions are not measured: Meta does not report website-button taps, and no
          orders or deals are connected yet. Campaign cost estimates are upper bounds from the rate
          card when each message was queued.
        </p>
      </CardContent>
    </Card>
  );
}

function UnavailableSection({ definitions }: { definitions: MetricDefinition[] }) {
  const missing = definitions.filter((d) => !d.available && !d.key.startsWith('campaign.'));
  if (missing.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Not available yet</CardTitle>
        <CardDescription>
          Reports HyFib cannot produce honestly with the data it has today.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3 text-sm">
          {missing.map((d) => (
            <li key={d.key}>
              <span className="font-medium">{d.label}.</span>{' '}
              <span className="text-muted-foreground">{d.missingData}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

const DEFINITION_GROUPS: [string, string][] = [
  ['messaging.', 'Messaging'],
  ['inbox.', 'Inbox'],
  ['csat.', 'CSAT'],
  ['agent.', 'Member activity'],
  ['campaign.', 'Campaigns'],
];

function DefinitionsSection({ definitions }: { definitions: MetricDefinition[] }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">How these numbers are counted</summary>
          <div className="mt-4 grid gap-6">
            {DEFINITION_GROUPS.map(([prefix, title]) => (
              <section key={prefix} className="grid gap-3">
                <h3 className="font-medium">{title}</h3>
                <dl className="grid gap-3">
                  {definitions
                    .filter((d) => d.key.startsWith(prefix) && d.available)
                    .map((d) => (
                      <div key={d.key} className="grid gap-1">
                        <dt className="font-medium">
                          {d.label}{' '}
                          <span className="text-xs font-normal text-muted-foreground">
                            ({d.key} v{d.version})
                          </span>
                        </dt>
                        <dd className="text-muted-foreground">
                          {d.description} Counts: {d.numerator}
                          {d.denominator ? ` Denominator: ${d.denominator}` : ''}
                          {d.window ? ` Window: ${d.window}` : ''}
                          {d.timezoneRule ? ` Days: ${d.timezoneRule}` : ''} Missing data:{' '}
                          {d.missingData} Freshness: {d.freshness}
                        </dd>
                      </div>
                    ))}
                </dl>
              </section>
            ))}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
