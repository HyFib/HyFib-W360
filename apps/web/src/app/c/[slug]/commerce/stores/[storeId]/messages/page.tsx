import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { STORE_MESSAGE_SKIP_REASONS, can, formatMinor, isCartEvent } from '@w360/domain';
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
import {
  StoreCartSettings,
  StoreMessageRuleForm,
  StoreMessageSettingsForm,
} from '@/components/stores/store-messages';
import { RUN_STATUS } from '@/lib/automation-labels';
import { COD_ANSWER, STORE_MESSAGE_STATUS } from '@/lib/commerce-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Order messages' };
export const dynamic = 'force-dynamic';

export default async function StoreMessagesPage({
  params,
}: {
  params: Promise<{ slug: string; storeId: string }>;
}) {
  const { slug, storeId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'commerce.read')) notFound();
  const { storeMessages } = await getRuntime();
  let data: Awaited<ReturnType<typeof storeMessages.storeMessages>>;
  try {
    data = await storeMessages.storeMessages(ctx, storeId);
  } catch (error) {
    if (isAppError(error) && (error.code === 'not_found' || error.code === 'validation_failed')) {
      notFound();
    }
    throw error;
  }
  const {
    store,
    rules,
    channels,
    templates,
    automations,
    canChooseAutomations,
    counts,
    recent,
    canManage,
    canManageConsent,
    timezone,
    cart,
  } = data;
  const orderRules = rules.filter((r) => !isCartEvent(r.event));
  const cartRules = rules.filter((r) => isCartEvent(r.event));
  const tz = ctx.tenant.timezone;
  const base = `/c/${ctx.tenant.slug}/commerce/stores`;
  const optInNote = store.messagesOptInAt
    ? `Confirmed ${store.optInBy ? `by ${store.optInBy} ` : ''}on ${formatDateTime(store.messagesOptInAt, tz)}.`
    : null;
  const hasActiveNumber = channels.some((c) => c.status === 'active');
  const consentNote = store.storeConsentAt
    ? `Turned on ${store.storeConsentBy ? `by ${store.storeConsentBy} ` : ''}on ${formatDateTime(store.storeConsentAt, tz)}.`
    : null;

  const ruleCard = (rule: (typeof rules)[number]) => (
    <Card key={rule.event} className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{rule.label}</CardTitle>
          {rule.available ? (
            <Badge tone={rule.enabled ? 'success' : 'neutral'}>{rule.enabled ? 'On' : 'Off'}</Badge>
          ) : null}
        </div>
        <CardDescription>{rule.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {canManage ? (
          <StoreMessageRuleForm
            slug={ctx.tenant.slug}
            storeId={store.id}
            rule={rule}
            channels={channels}
            templates={templates}
            automations={automations}
            canChooseAutomations={canChooseAutomations}
          />
        ) : rule.enabled ? (
          <p className="text-sm">
            {rule.action === 'automation'
              ? `Starts the automation ${rule.automationName ?? ''}`.trimEnd()
              : `Sends ${templates.find((t) => t.id === rule.templateId)?.name ?? 'a template'}`}
            {rule.delayMinutes > 0 ? ` ${rule.delayMinutes} minutes after the event` : ''}.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Not sent.</p>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="grid grid-cols-1 gap-6">
      <Link
        href={`${base}/${store.id}`}
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        ← {store.name ?? store.shopDomain ?? store.storeUrl}
      </Link>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Order messages</CardTitle>
          <CardDescription>
            When an order in this store is placed, paid for on delivery, shipped, delivered or
            cancelled, HyFib sends the customer the WhatsApp template you choose for it, or starts
            an automation for it (placed, shipped, delivered and cancelled). Each order gets at most
            one message per event, and a message never goes out about something that happened before
            it was switched on. Customers who opted out, numbers on the suppression list and erased
            contacts are never messaged.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          {store.state !== 'connected' ? (
            <Alert tone="warning">
              The store is not connected, so no messages are sent. Connect it again from the store’s
              page.
            </Alert>
          ) : null}
          {!hasActiveNumber ? (
            <Alert tone="warning">
              Connect a WhatsApp number in Settings → Channels before switching messages on.
            </Alert>
          ) : null}
          {canManage ? (
            <StoreMessageSettingsForm
              slug={ctx.tenant.slug}
              storeId={store.id}
              optIn={store.messagesOptInAt !== null}
              optInNote={optInNote}
              windowStart={store.sendWindowStart}
              windowEnd={store.sendWindowEnd}
              testOrders={store.messageTestOrders}
              platform={store.platform}
              timezone={timezone}
            />
          ) : (
            <dl className="grid gap-1">
              <div>
                <dt className="inline font-medium">Customers’ opt-in: </dt>
                <dd className="inline">{optInNote ?? 'Not confirmed'}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Sending hours: </dt>
                <dd className="inline">
                  {store.sendWindowStart
                    ? `${store.sendWindowStart}–${store.sendWindowEnd} (${timezone})`
                    : 'Any time'}
                </dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      {orderRules.map(ruleCard)}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Cart reminders</CardTitle>
          <CardDescription>
            When a customer leaves a checkout with a phone number, HyFib can remind them with an
            approved marketing template, once or twice. Only customers who opted in to marketing
            messages get them, never after the checkout was completed or an order with the same
            number was placed, and never more than three days after they left it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          {store.platform !== 'shopify' ? (
            <p className="text-muted-foreground">
              Not available for this store: WooCommerce has no carts HyFib can read.
            </p>
          ) : (
            <>
              {store.checkoutsError ? <Alert tone="warning">{store.checkoutsError}</Alert> : null}
              {store.detailsWithheld ? (
                <Alert tone="info">
                  Shopify withholds some customer details from HyFib, so checkouts may have no
                  number.
                </Alert>
              ) : null}
              <StoreCartSettings
                slug={ctx.tenant.slug}
                storeId={store.id}
                customerAccess={store.customerAccess}
                accessError={store.accessError}
                consentSupported={store.consentSupported}
                useStoreConsent={store.storeConsentAt !== null}
                consentNote={consentNote}
                canManageConsent={canManageConsent}
              />
              {cart ? (
                <dl className="grid gap-1" aria-label="Cart reminders in the last 30 days">
                  <div>
                    <dt className="inline font-medium">Reminders sent (30 days): </dt>
                    <dd className="inline">{cart.sent}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Checkouts recovered: </dt>
                    <dd className="inline">{cart.recovered}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Recovered value: </dt>
                    <dd className="inline">
                      {cart.value.length === 0
                        ? '—'
                        : cart.value.map((v) => formatMinor(v.totalMinor, v.currency)).join(', ')}
                    </dd>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    A checkout counts as recovered when Shopify reports it completed after one of
                    its reminders was sent; its value is the checkout’s total. Reminders that
                    failed, or whose sending could not be confirmed, are left out.
                  </p>
                </dl>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
      {store.platform === 'shopify' ? cartRules.map(ruleCard) : null}

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Messages in the last 30 days</CardTitle>
          <CardDescription>
            Delivery comes from WhatsApp’s reports. “Not sent” gives the reason.
          </CardDescription>
          <ul className="flex flex-wrap gap-2 pt-2" aria-label="Messages by status">
            {Object.entries(counts).map(([status, count]) => (
              <li key={status}>
                <Badge tone={STORE_MESSAGE_STATUS[status]?.tone ?? 'neutral'}>
                  {STORE_MESSAGE_STATUS[status]?.label ?? status}: {count}
                </Badge>
              </li>
            ))}
          </ul>
        </CardHeader>
        <CardContent className="p-0">
          {recent.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No messages yet.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Event</TH>
                  <TH>Order or checkout</TH>
                  <TH>Status</TH>
                  <TH>When</TH>
                </TR>
              </THead>
              <TBody>
                {recent.map((m) => {
                  const status = STORE_MESSAGE_STATUS[m.status];
                  const answer = m.answer ? COD_ANSWER[m.answer] : null;
                  return (
                    <TR key={m.id}>
                      <TD className="text-sm">{m.label}</TD>
                      <TD className="text-sm">
                        {m.orderId === null ? (
                          m.checkoutName
                        ) : can(ctx, 'contacts.read') ? (
                          <Link
                            href={`${base}/orders/${m.orderId}`}
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            {m.orderName}
                          </Link>
                        ) : (
                          m.orderName
                        )}
                        {m.customerName ? (
                          <span className="block text-xs text-muted-foreground">
                            {m.customerName}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="text-sm">
                        <Badge tone={status?.tone ?? 'neutral'}>{status?.label ?? m.status}</Badge>
                        {m.skipReason ? (
                          <span className="block text-xs text-muted-foreground">
                            {STORE_MESSAGE_SKIP_REASONS[m.skipReason] ?? m.skipReason}
                          </span>
                        ) : null}
                        {m.status === 'failed' && m.errorTitle ? (
                          <span className="block text-xs text-muted-foreground">
                            {m.errorTitle}
                          </span>
                        ) : null}
                        {answer ? (
                          <span className="mt-1 block">
                            <Badge tone={answer.tone}>{answer.label}</Badge>
                          </span>
                        ) : null}
                        {m.automation ? (
                          <span className="block text-xs text-muted-foreground">
                            {m.automation.runId ? (
                              <Link
                                href={`/c/${ctx.tenant.slug}/automations/runs/${m.automation.runId}`}
                                className="text-primary underline-offset-4 hover:underline"
                              >
                                {m.automation.automationName ?? 'The run'}
                              </Link>
                            ) : (
                              (m.automation.automationName ?? 'An automation')
                            )}
                            {m.automation.runStatus
                              ? `: ${RUN_STATUS[m.automation.runStatus]?.label ?? m.automation.runStatus}`
                              : ''}
                          </span>
                        ) : null}
                      </TD>
                      <TD className="text-xs text-muted-foreground">
                        {m.status === 'waiting'
                          ? `Due ${formatDateTime(m.sendAt, tz)}`
                          : formatDateTime(m.createdAt, tz)}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
