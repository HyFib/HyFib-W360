import { displayMoney, formatMinorUnits } from '@w360/core';
import {
  CREDIT_REFUND_STATUS_LABELS,
  paymentMethodLabel,
  refundableTopups,
  type CreditRefundStatus,
  type PlatformCompanyBilling,
} from '@w360/domain';
import { Badge, TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import { CreditRefundForm, type RefundableTopup } from './credit-refund-form';
import { Utc } from './ops';

const inr = (paise: number) => displayMoney(BigInt(paise), 'INR');

const TOPUP_STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  paid: { label: 'Paid', tone: 'success' },
  partially_refunded: { label: 'Partly refunded', tone: 'warning' },
  refunded: { label: 'Refunded', tone: 'neutral' },
};

const REFUND_TONE: Record<CreditRefundStatus, 'info' | 'success' | 'danger'> = {
  requested: 'info',
  submitted: 'info',
  processed: 'success',
  failed: 'danger',
};

/** The form's choices: the domain decides what can be refunded and up to how much. */
function refundChoices(billing: PlatformCompanyBilling): RefundableTopup[] {
  return refundableTopups(billing).map((t) => ({
    id: t.id,
    label: `${t.receipt} · ${inr(t.amountMinor)}${t.refundedMinor > 0 ? ` (${inr(t.refundedMinor)} refunded)` : ''} · ${(t.paidAt ?? t.createdAt).toISOString().slice(0, 10)}`,
    maxMinor: t.maxMinor,
    maxAmount: formatMinorUnits(BigInt(t.maxMinor), 'INR'),
    maxLabel: inr(t.maxMinor),
  }));
}

/**
 * A company's service credit on its platform page: balances, paid top-ups and staff refunds
 * (payments to HyFib; no company content). Platform owners get the refund form unless
 * `refundBlocked` says why a refund cannot be started.
 */
export function ServiceCredit({
  tenantId,
  billing,
  refundBlocked,
}: {
  tenantId: string;
  billing: PlatformCompanyBilling;
  refundBlocked: string | null;
}) {
  const receipts = new Map(billing.topups.map((t) => [t.id, t.receipt]));
  const refundable = refundChoices(billing);
  return (
    <div className="grid grid-cols-1 gap-6 text-sm">
      {billing.availableMinor === null ? (
        <p className="text-muted-foreground">The company has not paid for service credit.</p>
      ) : (
        <dl className="grid gap-2 sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Available</dt>
            <dd className={billing.availableMinor < 0 ? 'text-destructive' : ''}>
              {inr(billing.availableMinor)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Reserved (running services and refunds)</dt>
            <dd>{inr(billing.reservedMinor ?? 0)}</dd>
          </div>
        </dl>
      )}
      {billing.topups.length > 0 ? (
        <div className="grid gap-2">
          <h3 className="font-medium">Paid top-ups (latest 50)</h3>
          <Table>
            <THead>
              <TR>
                <TH>Paid</TH>
                <TH>Receipt</TH>
                <TH>Amount</TH>
                <TH>Method</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {billing.topups.map((t) => (
                <TR key={t.id}>
                  <TD>
                    <Utc at={t.paidAt ?? t.createdAt} />
                  </TD>
                  <TD className="font-mono text-xs">{t.receipt}</TD>
                  <TD className="whitespace-nowrap">
                    {inr(t.amountMinor)}
                    {t.refundedMinor > 0 ? (
                      <span className="block text-xs text-muted-foreground">
                        {inr(t.refundedMinor)} refunded
                      </span>
                    ) : null}
                  </TD>
                  <TD>
                    {t.kind === 'auto_recharge' ? 'Automatic top-up' : 'One-time'}
                    {t.paymentMethod ? (
                      <span className="block text-xs text-muted-foreground">
                        {paymentMethodLabel(t.paymentMethod)}
                      </span>
                    ) : null}
                  </TD>
                  <TD>
                    <Badge tone={TOPUP_STATUS[t.status]?.tone ?? 'neutral'}>
                      {TOPUP_STATUS[t.status]?.label ?? t.status}
                    </Badge>
                    {t.openRefund ? (
                      <span className="block text-xs text-muted-foreground">
                        Refund of {inr(t.openRefund.amountMinor)} in progress
                      </span>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      ) : null}
      {billing.refunds.length > 0 ? (
        <div className="grid gap-2">
          <h3 className="font-medium">Refunds started here (latest 50)</h3>
          <Table>
            <THead>
              <TR>
                <TH>Requested</TH>
                <TH>Receipt</TH>
                <TH>Amount</TH>
                <TH>Status</TH>
                <TH>Reason</TH>
              </TR>
            </THead>
            <TBody>
              {billing.refunds.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Utc at={r.requestedAt} />
                    {r.requestedByName ? (
                      <span className="block text-xs text-muted-foreground">
                        by {r.requestedByName}
                      </span>
                    ) : null}
                  </TD>
                  <TD className="font-mono text-xs">{receipts.get(r.topupId) ?? '—'}</TD>
                  <TD className="whitespace-nowrap">{inr(r.amountMinor)}</TD>
                  <TD>
                    <Badge tone={REFUND_TONE[r.status]}>
                      {CREDIT_REFUND_STATUS_LABELS[r.status]}
                    </Badge>
                    {r.providerRefundId ? (
                      <code className="block text-xs text-muted-foreground">
                        {r.providerRefundId}
                      </code>
                    ) : null}
                    {r.lastError ? (
                      <span className="block text-xs text-muted-foreground">{r.lastError}</span>
                    ) : null}
                  </TD>
                  <TD className="min-w-48 break-words">{r.reason}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      ) : null}
      {refundBlocked ? (
        <p className="text-muted-foreground">{refundBlocked}</p>
      ) : billing.topups.length > 0 ? (
        // Rendered even when nothing is refundable, so a refund's confirmation survives the refresh
        // that removes the payment from the choices.
        <div className="grid gap-2">
          <h3 className="font-medium">Refund unused credit</h3>
          <CreditRefundForm tenantId={tenantId} topups={refundable} />
        </div>
      ) : null}
    </div>
  );
}
