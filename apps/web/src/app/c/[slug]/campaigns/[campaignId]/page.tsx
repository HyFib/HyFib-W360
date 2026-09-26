import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import {
  METRIC_DEFINITIONS,
  can,
  formatMicros,
  type CampaignAnalytics,
  type TenantContext,
} from '@w360/domain';
import {
  Alert,
  Badge,
  Button,
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
import {
  ApprovalActions,
  AutoRefresh,
  GuardrailsForm,
  RunControls,
  SendTest,
  SubmitCampaign,
} from '@/components/campaigns/campaign-actions';
import { CampaignEditor, type EditableCampaign } from '@/components/campaigns/campaign-editor';
import type { Definition } from '@/components/segments/segment-builder';
import { PageHeader } from '@/components/page-header';
import {
  CAMPAIGN_STATUS,
  EVENT_LABELS,
  PAUSE_REASONS,
  SKIP_REASONS,
  failureLabel,
  percent,
} from '@/lib/campaign-labels';
import { formatDateTime } from '@/lib/format';
import { segmentBuilderInputs } from '@/server/campaigns';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';
import { sendableTemplates } from '@/server/templates';

export const metadata: Metadata = { title: 'Campaign' };
export const dynamic = 'force-dynamic';

type View = Awaited<ReturnType<Awaited<ReturnType<typeof getRuntime>>['campaigns']['getCampaign']>>;

function micros(value: number | null): string {
  if (value === null) return '';
  const whole = Math.floor(value / 1_000_000);
  const fraction = String(value % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function timeOf(value: string | null): string {
  return value ? value.slice(0, 5) : '';
}

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ slug: string; campaignId: string }>;
}) {
  const { slug, campaignId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'campaigns.read')) notFound();
  const { campaigns } = await getRuntime();
  let view: View;
  try {
    view = await campaigns.getCampaign(ctx, campaignId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const c = view.campaign;
  const status = CAMPAIGN_STATUS[c.status] ?? { label: c.status, tone: 'neutral' as const };
  const settings = await campaigns.getSettings(ctx);

  return (
    <>
      <PageHeader
        title={c.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            {view.template ? (
              <span>
                Template {view.template.name} ({view.template.language},{' '}
                {view.template.category.toLowerCase()})
              </span>
            ) : null}
          </span>
        }
      />
      {c.status === 'draft' ? (
        <DraftView ctx={ctx} view={view} currencies={settings.availableCurrencies} />
      ) : (
        <LiveView ctx={ctx} view={view} settings={settings} />
      )}
    </>
  );
}

async function DraftView({
  ctx,
  view,
  currencies,
}: {
  ctx: TenantContext;
  view: View;
  currencies: string[];
}) {
  const { campaigns, templates, segments } = await getRuntime();
  const c = view.campaign;
  const slug = ctx.tenant.slug;
  const editable = can(ctx, 'campaigns.write');
  const [review, channels, sendable, segmentList, inputs] = await Promise.all([
    campaigns.reviewDraft(ctx, c.id),
    editable ? templates.sendChannels(ctx) : Promise.resolve([]),
    editable ? sendableTemplates(ctx) : Promise.resolve([]),
    editable ? segments.listSegments(ctx) : Promise.resolve([]),
    editable ? segmentBuilderInputs(ctx) : Promise.resolve({ fields: [], campaigns: [] }),
  ]);
  const zones = Intl.supportedValuesOf('timeZone');
  const timezones = zones.includes(c.timezone) ? zones : [c.timezone, ...zones];
  const editableCampaign: EditableCampaign = {
    id: c.id,
    version: c.version,
    name: c.name,
    channelAccountId: c.channelAccountId,
    templateId: c.templateId,
    variables: view.variables,
    segmentId: c.segmentId,
    audienceDefinition: (c.audienceDefinition as unknown as Definition | null) ?? null,
    timezone: c.timezone,
    scheduleKind: c.scheduleKind,
    scheduledLocal: c.scheduledLocal ? c.scheduledLocal.slice(0, 16).replace(' ', 'T') : '',
    windowStart: timeOf(c.windowStart),
    windowEnd: timeOf(c.windowEnd),
    ratePerMinute: c.ratePerMinute,
    maxMessages: c.maxMessages,
    budgetAmount: micros(c.budgetMicros),
    budgetCurrency: c.budgetCurrency,
    stopAfterHours: c.stopAfterHours,
  };
  const audience = review.audience;
  const summary = audience
    ? `${audience.eligible} of ${audience.total} contacts can receive it now.`
    : 'The audience is not complete yet.';

  return (
    <div className="grid gap-6">
      {c.reviewNote ? (
        <Alert tone="warning" title="Sent back for changes">
          {c.reviewNote}
        </Alert>
      ) : null}
      {editable ? (
        <Card>
          <CardHeader>
            <CardTitle>Draft</CardTitle>
            <CardDescription>Save to update the review below.</CardDescription>
          </CardHeader>
          <CardContent>
            <CampaignEditor
              slug={slug}
              campaign={editableCampaign}
              channels={channels}
              templates={sendable}
              segments={segmentList.map((s) => ({ id: s.id, name: s.name }))}
              fields={inputs.fields}
              campaigns={inputs.campaigns}
              timezones={timezones}
              currencies={currencies}
            />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Review</CardTitle>
          <CardDescription>What starting this campaign would do right now.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {review.problems.length > 0 ? (
            <Alert tone="warning" title="Before it can start">
              <ul className="list-disc pl-5">
                {review.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {audience ? (
            <div className="grid gap-2">
              <p className="text-sm">
                <strong>{audience.eligible}</strong> of {audience.total} contacts in the audience
                can receive it now.
              </p>
              {Object.keys(audience.skipped).length > 0 ? (
                <ul className="grid gap-1 text-sm text-muted-foreground">
                  {Object.entries(audience.skipped).map(([reason, n]) => (
                    <li key={reason}>
                      {SKIP_REASONS[reason] ?? reason}: {n}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {review.frequencyCap ? (
            <p className="text-sm text-muted-foreground">
              Contacts who already received {review.frequencyCap.count} marketing message
              {review.frequencyCap.count === 1 ? '' : 's'} in the last {review.frequencyCap.days}{' '}
              day
              {review.frequencyCap.days === 1 ? '' : 's'} are skipped when their turn comes.
            </p>
          ) : null}
          {review.scheduledAt ? (
            <p className="text-sm">
              {c.scheduleKind === 'now'
                ? 'Sends as soon as it starts'
                : `Starts ${formatDateTime(review.scheduledAt.toISOString(), c.timezone)} (${c.timezone})`}
              {review.adjustment === 'gap_shifted'
                ? ' — the chosen time does not exist on that day because clocks move forward, so it starts after the jump.'
                : review.adjustment === 'ambiguous_earlier'
                  ? ' — that time happens twice on that day because clocks move back; the first occurrence is used.'
                  : '.'}
            </p>
          ) : null}
          {review.estimate ? (
            <div className="grid gap-1 text-sm">
              <p>
                Estimated Meta cost:{' '}
                <strong>
                  {formatMicros(review.estimate.totalMicros, review.estimate.currency)}
                </strong>{' '}
                for {review.estimate.pricedCount} message
                {review.estimate.pricedCount === 1 ? '' : 's'}
                {review.estimate.unpricedCount > 0
                  ? `; ${review.estimate.unpricedCount} recipient${review.estimate.unpricedCount === 1 ? ' is' : 's are'} in markets without a published rate`
                  : ''}
                .
              </p>
              <p className="text-muted-foreground">
                An upper bound from the published rate card: Meta charges delivered messages only
                and bills your company directly.
              </p>
            </div>
          ) : review.costCurrency ? (
            <p className="text-sm text-muted-foreground">
              No {review.costCurrency} rate card is published yet, so no cost estimate is shown.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              To see cost estimates, choose the currency Meta bills you in (Settings → Messaging).
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {review.approvalRequired
              ? 'Your company requires approval: another member with approval rights must approve it before it starts.'
              : 'It starts without approval (Settings → Messaging can require one).'}{' '}
            Meta limits how many people a business can message in 24 hours; messages over that limit
            fail with Meta’s error and are shown as failed.
          </p>
          <div className="flex flex-wrap items-start gap-4">
            {can(ctx, 'campaigns.write') && can(ctx, 'campaigns.send') ? (
              <SubmitCampaign
                slug={slug}
                campaignId={c.id}
                version={c.version}
                approvalRequired={review.approvalRequired}
                disabled={review.problems.length > 0}
                summary={summary}
              />
            ) : null}
            {editable ? <RunControls slug={slug} campaignId={c.id} status={c.status} /> : null}
          </div>
        </CardContent>
      </Card>
      {can(ctx, 'campaigns.send') && c.channelAccountId && c.templateId ? (
        <Card>
          <CardHeader>
            <CardTitle>Test</CardTitle>
          </CardHeader>
          <CardContent>
            <SendTest slug={slug} campaignId={c.id} />
          </CardContent>
        </Card>
      ) : null}
      <Timeline ctx={ctx} view={view} />
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="grid gap-1 rounded-md border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold">{value}</dd>
      {detail ? <dd className="text-xs text-muted-foreground">{detail}</dd> : null}
    </div>
  );
}

function Results({ a, currency }: { a: CampaignAnalytics; currency: string | null }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <Stat
        label="Audience"
        value={a.audience}
        detail={`${a.skipped} not sent, ${a.canceled} cancelled`}
      />
      <Stat
        label="Handed to WhatsApp"
        value={a.queued}
        detail={`${a.inProgress} awaiting a status from Meta`}
      />
      <Stat
        label="Sent"
        value={percent(a.sent, a.queued)}
        detail={`${a.sent} of ${a.queued} handed over`}
      />
      <Stat
        label="Delivered"
        value={percent(a.delivered, a.sent)}
        detail={`${a.delivered} of ${a.sent} sent`}
      />
      <Stat
        label="Read"
        value={percent(a.read, a.delivered)}
        detail={`${a.read} of ${a.delivered} delivered (a lower bound)`}
      />
      <Stat
        label="Replied"
        value={percent(a.replied, a.delivered)}
        detail={`${a.replied} of ${a.delivered} delivered, within 72 hours`}
      />
      <Stat
        label="Opted out"
        value={percent(a.optedOut, a.delivered)}
        detail={`${a.optedOut} of ${a.delivered} delivered, within 72 hours`}
      />
      <Stat
        label="Failed or unknown"
        value={percent(a.failed + a.unknown, a.queued)}
        detail={`${a.failed} failed, ${a.unknown} unknown outcome, of ${a.queued}`}
      />
      <Stat
        label="Clicked"
        value="Not measured"
        detail="Meta does not report website-button taps."
      />
      <Stat label="Converted" value="Not measured" detail="No conversion source is connected." />
      <Stat
        label="Estimated Meta cost"
        value={currency ? formatMicros(a.estimateMicros, currency) : '—'}
        detail={
          currency
            ? a.estimateMissing > 0
              ? `Upper bound; ${a.estimateMissing} message${a.estimateMissing === 1 ? '' : 's'} without a price`
              : 'Upper bound from the published rate card'
            : 'Choose your Meta billing currency in Settings → Messaging'
        }
      />
    </dl>
  );
}

async function LiveView({
  ctx,
  view,
  settings,
}: {
  ctx: TenantContext;
  view: View;
  settings: Awaited<ReturnType<Awaited<ReturnType<typeof getRuntime>>['campaigns']['getSettings']>>;
}) {
  const c = view.campaign;
  const a = view.analytics;
  const tz = ctx.tenant.timezone;
  const slug = ctx.tenant.slug;
  const base = `/c/${slug}/campaigns/${c.id}`;
  const currency = c.estimateCurrency ?? c.budgetCurrency ?? settings.costCurrency;
  const inProgress = c.status === 'scheduled' || c.status === 'running';
  return (
    <div className="grid gap-6">
      <AutoRefresh active={inProgress} />
      {c.status === 'paused' && c.pauseReason ? (
        <Alert tone="warning" title="Paused">
          {PAUSE_REASONS[c.pauseReason] ?? c.pauseReason}
        </Alert>
      ) : null}
      {c.status === 'completed' ? (
        <Alert tone="success" title="Completed">
          {c.completionReason === 'deadline_passed'
            ? 'The sending period ended; recipients not reached by then were not sent to.'
            : 'Every recipient was handed to WhatsApp or skipped. Delivery statuses keep updating.'}
        </Alert>
      ) : null}
      {c.status === 'pending_approval' ? (
        <Card>
          <CardHeader>
            <CardTitle>Waiting for approval</CardTitle>
            <CardDescription>
              Submitted by {view.people.submittedBy ?? 'a member'}
              {c.submittedAt ? ` on ${formatDateTime(c.submittedAt.toISOString(), tz)}` : ''}. A
              different member with approval rights must approve it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ApprovalActions
              slug={slug}
              campaignId={c.id}
              canApprove={can(ctx, 'campaigns.approve') && c.submittedByUserId !== ctx.user.id}
              canWithdraw={
                can(ctx, 'campaigns.write') &&
                (c.submittedByUserId === ctx.user.id || can(ctx, 'campaigns.approve'))
              }
            />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid gap-1">
            <CardTitle>Results</CardTitle>
            <CardDescription>
              {inProgress ? 'Updates every 15 seconds while sending. ' : ''}
              Rates show their denominators; see how each number is counted below.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {can(ctx, 'contacts.read') ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`${base}/recipients`}>Recipients</Link>
              </Button>
            ) : null}
            {can(ctx, 'contacts.export') ? (
              <Button asChild variant="outline" size="sm">
                <a href={`${base}/export`} download>
                  Export CSV
                </a>
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="grid gap-6">
          {a ? <Results a={a} currency={currency} /> : null}
          {a && a.skipReasons.length > 0 ? (
            <div className="grid gap-2">
              <h2 className="text-sm font-semibold">Not sent, by reason</h2>
              <Table>
                <TBody>
                  {a.skipReasons.map((r) => (
                    <TR key={r.reason}>
                      <TD>{SKIP_REASONS[r.reason] ?? r.reason}</TD>
                      <TD className="text-right">{r.count}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          ) : null}
          {a && a.failureCodes.length > 0 ? (
            <div className="grid gap-2">
              <h2 className="text-sm font-semibold">Failures, by code</h2>
              <Table>
                <THead>
                  <TR>
                    <TH>Code</TH>
                    <TH>Meaning</TH>
                    <TH className="text-right">Messages</TH>
                  </TR>
                </THead>
                <TBody>
                  {a.failureCodes.map((f) => (
                    <TR key={f.code}>
                      <TD className="font-mono text-xs">{f.code}</TD>
                      <TD className="text-sm">{failureLabel(f.code)}</TD>
                      <TD className="text-right">{f.count}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          ) : null}
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">How these numbers are counted</summary>
            <dl className="mt-3 grid gap-3">
              {METRIC_DEFINITIONS.filter((m) => m.key.startsWith('campaign.')).map((m) => (
                <div key={m.key} className="grid gap-1">
                  <dt className="font-medium">
                    {m.label}{' '}
                    <span className="text-xs text-muted-foreground">
                      ({m.key} v{m.version})
                    </span>
                  </dt>
                  <dd className="text-muted-foreground">
                    {m.description}
                    {m.denominator ? ` Denominator: ${m.denominator}` : ''}
                    {m.window ? ` Window: ${m.window}` : ''} {m.missingData}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        </CardContent>
      </Card>
      {can(ctx, 'campaigns.send') &&
      ['scheduled', 'running', 'paused', 'pending_approval'].includes(c.status) ? (
        <Card>
          <CardHeader>
            <CardTitle>Controls</CardTitle>
            <CardDescription>
              Pausing stops new messages and holds back queued ones that no worker has picked up;
              resuming continues under your name. Cancelling cannot be undone.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <RunControls slug={slug} campaignId={c.id} status={c.status} />
            {c.status !== 'pending_approval' ? (
              <GuardrailsForm
                slug={slug}
                campaignId={c.id}
                initial={{
                  ratePerMinute: c.ratePerMinute,
                  maxMessages: c.maxMessages,
                  budgetAmount: micros(c.budgetMicros),
                  budgetCurrency: c.budgetCurrency,
                }}
                currencies={settings.availableCurrencies}
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Fact
              label="Send from"
              value={
                view.channel
                  ? [view.channel.verifiedName, view.channel.displayPhoneNumber]
                      .filter(Boolean)
                      .join(' · ')
                  : '—'
              }
            />
            <Fact
              label="Audience"
              value={
                view.segment ? `Segment: ${view.segment.name}` : 'Conditions for this campaign'
              }
            />
            <Fact
              label="Scheduled"
              value={
                c.scheduledAt
                  ? `${formatDateTime(c.scheduledAt.toISOString(), c.timezone)} (${c.timezone})`
                  : '—'
              }
            />
            <Fact
              label="Started"
              value={c.startedAt ? formatDateTime(c.startedAt.toISOString(), tz) : '—'}
            />
            <Fact
              label="Stops sending by"
              value={
                c.deadlineAt
                  ? formatDateTime(c.deadlineAt.toISOString(), tz)
                  : `${c.stopAfterHours} hours after it starts`
              }
            />
            <Fact
              label="Sending window"
              value={
                c.windowStart && c.windowEnd
                  ? `${timeOf(c.windowStart)}–${timeOf(c.windowEnd)} (${c.timezone})`
                  : 'Any time'
              }
            />
            <Fact
              label="Pacing"
              value={
                c.ratePerMinute ? `${c.ratePerMinute} per minute` : 'The number’s sending rate'
              }
            />
            <Fact label="Message cap" value={c.maxMessages ? String(c.maxMessages) : 'None'} />
            <Fact
              label="Spending cap"
              value={
                c.budgetMicros && c.budgetCurrency
                  ? `${formatMicros(c.budgetMicros, c.budgetCurrency)} (estimate)`
                  : 'None'
              }
            />
            <Fact label="Sends under the authority of" value={view.people.launchedBy ?? '—'} />
            <Fact
              label="Approved by"
              value={view.people.approvedBy ?? (c.approvedAt ? 'A member' : 'Not required')}
            />
          </dl>
        </CardContent>
      </Card>
      <Timeline ctx={ctx} view={view} />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Timeline({ ctx, view }: { ctx: TenantContext; view: View }) {
  if (view.events.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-2 text-sm">
          {view.events.map((e) => {
            const reason = typeof e.detail.reason === 'string' ? e.detail.reason : null;
            const note = typeof e.detail.note === 'string' ? e.detail.note : null;
            const reasonText =
              e.type === 'paused' && reason
                ? (PAUSE_REASONS[reason] ?? reason)
                : e.type === 'completed' && reason === 'deadline_passed'
                  ? 'the sending period ended'
                  : null;
            return (
              <li key={e.id} className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground">
                  {formatDateTime(e.occurredAt.toISOString(), ctx.tenant.timezone)}
                </span>
                <span className="font-medium">{EVENT_LABELS[e.type] ?? e.type}</span>
                <span className="text-muted-foreground">
                  {e.actorName ? `by ${e.actorName}` : 'by HyFib'}
                  {reasonText ? ` — ${reasonText}` : ''}
                  {note ? ` — “${note}”` : ''}
                </span>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
