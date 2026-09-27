import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import {
  PaymentAccountForm,
  RemovePaymentAccountButton,
} from '@/components/commerce/payment-account-form';
import { CopyField } from '@/components/growth/copy-field';
import { PAYMENT_ACCOUNT_STATUS } from '@/lib/commerce-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Payments' };
export const dynamic = 'force-dynamic';

const LINK_EVENTS = [
  'payment_link.paid',
  'payment_link.partially_paid',
  'payment_link.expired',
  'payment_link.cancelled',
];

export default async function CommercePaymentsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read')) notFound();
  const runtime = await getRuntime();
  const { account, canManage } = await runtime.commerce.paymentAccount(ctx);
  const tz = ctx.tenant.timezone;
  const status = account ? PAYMENT_ACCOUNT_STATUS[account.status] : null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid min-w-0 content-start gap-6">
        <Card className="min-w-0">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Your Razorpay account</CardTitle>
              {account && status ? <Badge tone={status.tone}>{status.label}</Badge> : null}
              {account ? (
                <Badge tone={account.mode === 'live' ? 'warning' : 'neutral'}>
                  {account.mode === 'live'
                    ? 'Live keys: real payments'
                    : 'Test keys: no real money'}
                </Badge>
              ) : null}
            </div>
            <CardDescription>
              Payment Links are created in your own Razorpay account, so customers pay you directly
              and Razorpay settles to your bank. HyFib never handles card details and takes no part
              of the payment.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            {account ? (
              <dl className="grid gap-1">
                {account.keyId ? (
                  <div>
                    <dt className="inline font-medium">Key id: </dt>
                    <dd className="inline font-mono">{account.keyId}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="inline font-medium">Last checked: </dt>
                  <dd className="inline">
                    {account.checkedAt ? formatDateTime(account.checkedAt, tz) : 'Not yet'}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-muted-foreground">
                No Razorpay account added yet. Until one is added and checked, payment cannot be
                requested for orders.
              </p>
            )}
            {account?.status === 'failed' && account.statusError ? (
              <Alert tone="danger">{account.statusError}</Alert>
            ) : null}
            {canManage ? (
              <PaymentAccountForm
                slug={ctx.tenant.slug}
                keyId={account?.keyId ?? null}
                liveAllowed={runtime.config.APP_ENV === 'production'}
              />
            ) : (
              <p className="text-muted-foreground">
                An owner or administrator can add or change the keys.
              </p>
            )}
            {canManage && account ? <RemovePaymentAccountButton slug={ctx.tenant.slug} /> : null}
          </CardContent>
        </Card>
        {canManage && account?.webhookUrl ? (
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Payment notifications (optional)</CardTitle>
              <CardDescription>
                HyFib checks every open Payment Link with Razorpay on a schedule, so payments are
                recorded without this. Adding a webhook in Razorpay makes HyFib check a link as soon
                as something happens to it. A notification never marks an order paid by itself:
                HyFib always fetches the link from Razorpay first.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm">
              <CopyField
                label="Webhook address"
                value={account.webhookUrl}
                description="Add it in Razorpay’s webhook settings with the webhook secret you saved above."
              />
              <div>
                <p className="font-medium">Events to select</p>
                <ul className="list-disc pl-5 font-mono text-xs">
                  {LINK_EVENTS.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>How payment works</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <p>
            From an order, request payment: HyFib creates a Payment Link for the order total (Indian
            rupees, at least ₹1) and sends it in the chat while the 24-hour window is open.
          </p>
          <p>
            Links stay open for 7 days. Razorpay sends no SMS or email for them, and partial
            payments are not accepted.
          </p>
          <p>
            An order is marked paid only when Razorpay reports its link paid in full. Refunds are
            made in your Razorpay Dashboard.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
