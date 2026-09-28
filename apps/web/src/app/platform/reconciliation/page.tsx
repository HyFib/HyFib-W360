import type { Metadata } from 'next';
import Link from 'next/link';
import { displayMoney } from '@w360/core';
import {
  addDays,
  indiaDate,
  SETTLEMENT_RECON_RUN_STATUS_LABELS,
  UNSETTLED_AFTER_DAYS,
  type SettlementReconRunSummary,
} from '@w360/domain';
import {
  Alert,
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
import { Utc } from '@/components/platform/ops';
import { ReconcileDayForm } from '@/components/platform/reconciliation-forms';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Settlement reconciliation · Platform' };
export const dynamic = 'force-dynamic';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

function statusTone(run: SettlementReconRunSummary) {
  if (run.status === 'failed') return 'danger' as const;
  if (run.status === 'completed')
    return run.openCount > 0 ? ('warning' as const) : ('success' as const);
  return 'neutral' as const;
}

export default async function ReconciliationPage() {
  const actor = await requirePlatformActor();
  const { platformReconciliation, razorpay, clock } = await getRuntime();
  const [runs, unsettled] = await Promise.all([
    platformReconciliation.runs(actor),
    platformReconciliation.unsettled(actor),
  ]);
  const latestDay = addDays(indiaDate(clock.now()), -1);
  const isOwner = actor.role === 'platform_owner';
  const open = runs.reduce((sum, run) => sum + run.openCount, 0);
  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="grid gap-1">
        <Link href="/platform" className="text-sm text-primary underline-offset-4 hover:underline">
          ← Platform administration
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Settlement reconciliation</h1>
        <p className="text-sm text-muted-foreground">
          Every transaction Razorpay settled to HyFib’s account, matched against HyFib’s records
          each day from 06:00 India time. Payments and refunds HyFib had missed are recorded the way
          their webhooks would have recorded them; everything else that does not match waits here
          for a person.
        </p>
      </div>
      {!razorpay ? (
        <Alert tone="warning" title="Razorpay is not configured">
          This environment has no Razorpay keys, so no settlement report is read.
        </Alert>
      ) : null}
      {open > 0 ? (
        <Alert
          tone="warning"
          title={`${open} ${open === 1 ? 'transaction needs' : 'transactions need'} a person`}
        >
          Open the day to see what did not match and resolve each one with a note.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Days</CardTitle>
          <CardDescription>
            The latest 90 days reconciled, newest first. Amounts are what Razorpay settled; fees
            include GST and are borne by HyFib.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <EmptyState
              title="No day reconciled yet"
              description="The first run starts after 06:00 India time for the previous day, or a platform owner can reconcile a day below."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Day</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Transactions</TH>
                  <TH className="text-right">Recorded by the check</TH>
                  <TH className="text-right">Need a person</TH>
                  <TH className="text-right">Credited</TH>
                  <TH className="text-right">Debited</TH>
                  <TH className="text-right">Fees</TH>
                </TR>
              </THead>
              <TBody>
                {runs.map((run) => (
                  <TR key={run.id}>
                    <TD>
                      <Link
                        href={`/platform/reconciliation/${run.date}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {run.date}
                      </Link>
                    </TD>
                    <TD>
                      <Badge tone={statusTone(run)}>
                        {SETTLEMENT_RECON_RUN_STATUS_LABELS[run.status]}
                      </Badge>
                      {run.status === 'pending' && run.attempts > 0 ? (
                        <span className="block text-xs text-muted-foreground">
                          Tried {run.attempts} {run.attempts === 1 ? 'time' : 'times'}; next at{' '}
                          <Utc at={run.nextAttemptAt} />
                        </span>
                      ) : null}
                    </TD>
                    <TD className="text-right">
                      {run.status === 'completed' ? run.itemCount : '—'}
                    </TD>
                    <TD className="text-right">
                      {run.status === 'completed' ? run.recordedCount : '—'}
                    </TD>
                    <TD className="text-right">
                      {run.status === 'completed' ? (
                        <span
                          className={run.openCount > 0 ? 'font-medium text-warning' : undefined}
                        >
                          {run.openCount}
                          {run.attentionCount > run.openCount
                            ? ` (${run.attentionCount - run.openCount} resolved)`
                            : ''}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TD>
                    <TD className="text-right">
                      {run.status === 'completed' ? inr(run.creditMinor) : '—'}
                    </TD>
                    <TD className="text-right">
                      {run.status === 'completed' ? inr(run.debitMinor) : '—'}
                    </TD>
                    <TD className="text-right">
                      {run.status === 'completed' ? inr(run.feeMinor) : '—'}
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
          <CardTitle>Payments not seen in a settlement</CardTitle>
          <CardDescription>
            Paid top-ups whose payment no settlement has shown {UNSETTLED_AFTER_DAYS} days after the
            payment. A top-up is listed only when every day from its payment to{' '}
            {UNSETTLED_AFTER_DAYS} days later was reconciled; settlement is normally two working
            days after the payment.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {unsettled.latestDay && unsettled.daysWithoutRun > 0 ? (
            <p className="text-sm text-muted-foreground">
              {unsettled.daysWithoutRun} of the 30 days up to {unsettled.latestDay} have no
              completed run, so payments from around those days cannot be checked.
            </p>
          ) : null}
          {unsettled.topups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {unsettled.latestDay
                ? 'None: every paid top-up that can be checked appeared in a settlement.'
                : 'Nothing can be checked until a day is reconciled.'}
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Company</TH>
                  <TH>Receipt</TH>
                  <TH>Razorpay payment</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Paid</TH>
                </TR>
              </THead>
              <TBody>
                {unsettled.topups.map((t) => (
                  <TR key={t.id}>
                    <TD>
                      <Link
                        href={`/platform/tenants/${t.tenantId}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {t.companyName}
                      </Link>
                    </TD>
                    <TD className="font-mono text-xs">{t.receipt}</TD>
                    <TD className="font-mono text-xs">{t.paymentId}</TD>
                    <TD className="text-right">{inr(t.amountMinor)}</TD>
                    <TD>
                      <Utc at={t.paidAt} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {isOwner ? (
        <Card>
          <CardHeader>
            <CardTitle>Reconcile a day</CardTitle>
            <CardDescription>
              For a day before the first run, or to read a day again. What an earlier run recorded
              and people’s resolutions are kept.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReconcileDayForm latestDay={latestDay} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
