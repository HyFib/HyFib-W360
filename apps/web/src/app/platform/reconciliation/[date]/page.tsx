import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { displayMoney } from '@w360/core';
import {
  needsAttention,
  SETTLEMENT_RECON_ITEM_STATUS_LABELS,
  SETTLEMENT_RECON_REASON_TEXT,
  SETTLEMENT_RECON_RUN_STATUS_LABELS,
  type SettlementReconItemView,
} from '@w360/domain';
import {
  Alert,
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
import { Utc } from '@/components/platform/ops';
import {
  ResolveSettlementItemForm,
  RunDayAgainForm,
} from '@/components/platform/reconciliation-forms';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Settlement day · Platform' };
export const dynamic = 'force-dynamic';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

const TYPE_LABELS: Record<SettlementReconItemView['type'], string> = {
  payment: 'Payment',
  refund: 'Refund',
  transfer: 'Transfer',
  adjustment: 'Adjustment',
  other: 'Other',
};

function statusTone(item: SettlementReconItemView) {
  if (item.status === 'matched') return 'success' as const;
  if (item.status === 'recorded') return 'info' as const;
  if (item.resolvedAt) return 'neutral' as const;
  return item.status === 'mismatch' ? ('danger' as const) : ('warning' as const);
}

function ItemsTable({
  items,
  resolve,
}: {
  items: SettlementReconItemView[];
  /** Platform owners resolve items that need a person. */
  resolve: boolean;
}) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Transaction</TH>
          <TH>Company</TH>
          <TH className="text-right">Razorpay</TH>
          <TH className="text-right">HyFib</TH>
          <TH>Outcome</TH>
          {resolve ? <TH>Action</TH> : null}
        </TR>
      </THead>
      <TBody>
        {items.map((item) => (
          <TR key={item.id}>
            <TD>
              <span className="block text-xs text-muted-foreground">
                {item.type === 'other' && item.providerType
                  ? `Other (${item.providerType})`
                  : TYPE_LABELS[item.type]}
                {item.method ? ` · ${item.method}` : ''}
              </span>
              <span className="font-mono text-xs break-all">{item.entityId}</span>
              {item.paymentId ? (
                <span className="block font-mono text-xs text-muted-foreground break-all">
                  of {item.paymentId}
                </span>
              ) : null}
              {item.disputeId ? (
                <span className="block font-mono text-xs text-warning break-all">
                  dispute {item.disputeId}
                </span>
              ) : null}
            </TD>
            <TD>
              {item.tenantId ? (
                <Link
                  href={`/platform/tenants/${item.tenantId}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {item.companyName ?? 'Company'}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
              {item.topupReceipt ? (
                <span className="block font-mono text-xs text-muted-foreground">
                  {item.topupReceipt}
                </span>
              ) : null}
            </TD>
            <TD className="text-right whitespace-nowrap">
              {item.currency && item.currency !== 'INR'
                ? `${item.amountMinor} ${item.currency} subunits`
                : inr(item.amountMinor)}
              {item.feeMinor > 0 ? (
                <span className="block text-xs text-muted-foreground">
                  fee {inr(item.feeMinor)}
                </span>
              ) : null}
            </TD>
            <TD className="text-right whitespace-nowrap">
              {item.hyfibAmountMinor === null ? '—' : inr(item.hyfibAmountMinor)}
            </TD>
            <TD className="min-w-56">
              <Badge tone={statusTone(item)}>
                {SETTLEMENT_RECON_ITEM_STATUS_LABELS[item.status]}
              </Badge>
              {item.reason ? (
                <span className="mt-1 block text-sm">
                  {SETTLEMENT_RECON_REASON_TEXT[item.reason]}
                </span>
              ) : null}
              {item.resolvedAt ? (
                <span className="mt-1 block text-sm text-muted-foreground">
                  Resolved by {item.resolvedByName ?? 'a platform owner'} on{' '}
                  <Utc at={item.resolvedAt} />: {item.resolutionNote}
                </span>
              ) : null}
            </TD>
            {resolve ? (
              <TD>
                {needsAttention(item) ? (
                  <ResolveSettlementItemForm itemId={item.id} entityId={item.entityId} />
                ) : null}
              </TD>
            ) : null}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export default async function ReconciliationDayPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  const actor = await requirePlatformActor();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();
  const { platformReconciliation } = await getRuntime();
  const detail = await platformReconciliation.run(actor, date);
  if (!detail) notFound();
  const { run, items, settlements } = detail;
  const isOwner = actor.role === 'platform_owner';
  const attention = items.filter(needsAttention);
  const recorded = items.filter((i) => i.status === 'recorded');
  const resolved = items.filter((i) => i.resolvedAt !== null);
  const matched = items.filter((i) => i.status === 'matched' && i.resolvedAt === null);
  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="grid gap-1">
        <Link
          href="/platform/reconciliation"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          ← Settlement reconciliation
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Settlements of {run.date}</h1>
        <p className="text-sm text-muted-foreground">
          India’s calendar day, as HyFib asks Razorpay for it.
        </p>
      </div>

      {run.status === 'failed' && run.lastError ? (
        <Alert tone="danger" title="The last attempt failed">
          {run.lastError}
          {isOwner ? ' Fix the cause, then run the day again below.' : ''}
        </Alert>
      ) : null}
      {run.status === 'pending' && run.lastError ? (
        <Alert tone="warning" title="Waiting to try again">
          {run.lastError} Next attempt at <Utc at={run.nextAttemptAt} />.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Summary <Badge>{SETTLEMENT_RECON_RUN_STATUS_LABELS[run.status]}</Badge>
          </CardTitle>
          <CardDescription>
            {run.requestedByName
              ? `Last asked for by ${run.requestedByName}.`
              : 'Run by the daily schedule.'}{' '}
            {run.attempts > 0
              ? `${run.attempts} ${run.attempts === 1 ? 'attempt' : 'attempts'} since then.`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Transactions</dt>
              <dd className="font-medium">{run.itemCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Matched</dt>
              <dd className="font-medium">{run.matchedCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Recorded by the check</dt>
              <dd className="font-medium">{run.recordedCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Need a person</dt>
              <dd className="font-medium">
                {run.openCount} open, {run.attentionCount - run.openCount} resolved
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Credited</dt>
              <dd className="font-medium">{inr(run.creditMinor)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Debited</dt>
              <dd className="font-medium">{inr(run.debitMinor)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Fees (including GST)</dt>
              <dd className="font-medium">{inr(run.feeMinor)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">GST in the fees</dt>
              <dd className="font-medium">{inr(run.taxMinor)}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">
            Started <Utc at={run.startedAt} />
            {run.completedAt ? (
              <>
                , completed <Utc at={run.completedAt} />
              </>
            ) : null}
            .{' '}
            {run.removedCount > 0
              ? `${run.removedCount} ${run.removedCount === 1 ? 'transaction' : 'transactions'} an earlier run listed ${run.removedCount === 1 ? 'is' : 'are'} no longer in Razorpay’s report and ${run.removedCount === 1 ? 'was' : 'were'} removed.`
              : ''}
          </p>
          {settlements.length > 0 ? (
            <div className="text-sm">
              <p className="text-muted-foreground">Settlements</p>
              <ul className="font-mono text-xs">
                {settlements.map((s) => (
                  <li key={s.id} className="break-all">
                    {s.id}
                    {s.utr ? ` · UTR ${s.utr}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Needs a person ({attention.length})</CardTitle>
          <CardDescription>
            Transactions that did not match HyFib’s records, could not be recorded or are not
            HyFib’s. Nothing was changed for them; refunds are made in the Razorpay Dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {attention.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing: every transaction matched.</p>
          ) : (
            <ItemsTable items={attention} resolve={isOwner} />
          )}
        </CardContent>
      </Card>

      {recorded.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recorded by the check ({recorded.length})</CardTitle>
            <CardDescription>
              Razorpay settled these before HyFib had recorded them: each was fetched from Razorpay
              and recorded the way its webhook would have recorded it, once.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ItemsTable items={recorded} resolve={false} />
          </CardContent>
        </Card>
      ) : null}

      {resolved.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Resolved ({resolved.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ItemsTable items={resolved} resolve={false} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Matched ({matched.length})</CardTitle>
          {items.length < run.itemCount ? (
            <CardDescription>
              The first {items.length} of {run.itemCount} transactions are shown.
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent>
          {matched.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ItemsTable items={matched} resolve={false} />
          )}
        </CardContent>
      </Card>

      {isOwner && run.status !== 'running' ? (
        <Card>
          <CardHeader>
            <CardTitle>Run this day again</CardTitle>
            <CardDescription>
              Reads Razorpay’s report for the day again. Nothing is recorded twice; what an earlier
              run recorded and resolutions are kept.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RunDayAgainForm date={run.date} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
