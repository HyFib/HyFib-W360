import { uuidv7, type Clock, type Keyring } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  authorizedTenantScope,
  commercePaymentAccounts,
  commercePaymentEvents,
  commercePaymentLinks,
  eq,
  inArray,
  sql,
  systemScope,
  OPEN_PAYMENT_LINK_STATUSES,
  type Database,
} from '@w360/db';
import { verifyRazorpayWebhookSignature } from '../billing/razorpay';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { PAYMENT_WEBHOOK_ID_RE, paymentAccountAad } from './model';

/**
 * Webhooks from companies' own Razorpay accounts (/api/webhooks/razorpay-links/<public id>). The
 * public id names the company; the signature (HMAC-SHA256 of the raw body with that company's
 * webhook secret, research R-017) proves the request comes from its Razorpay account, a verified
 * provider mapping. Nothing in the body is trusted: a delivery for one of the company's Payment
 * Links only makes the worker fetch that link from Razorpay now (research R-108). Deliveries are
 * recorded by event id, so a redelivery does nothing twice; the body itself is not stored.
 */

export interface PaymentWebhookDeps {
  db: Database;
  keyring: Keyring;
  clock: Clock;
  jobs: JobQueue;
  signer: JobSigner;
}

export interface PaymentWebhookResult {
  status: number;
  log: { outcome: string; tenantId?: string; event?: string };
}

const LINK_EVENTS = new Set([
  'payment_link.paid',
  'payment_link.partially_paid',
  'payment_link.cancelled',
  'payment_link.expired',
]);

export async function handlePaymentWebhook(
  deps: PaymentWebhookDeps,
  input: { publicId: string; rawBody: Buffer; signature: string | null; eventId: string | null },
): Promise<PaymentWebhookResult> {
  if (!PAYMENT_WEBHOOK_ID_RE.test(input.publicId))
    return { status: 404, log: { outcome: 'unknown_account' } };
  const targetRes = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; account_id: string }>(
        sql`select tenant_id, account_id from ops.commerce_payment_webhook_target(${input.publicId})`,
      ),
    { accessMode: 'read only' },
  );
  const target = targetRes.rows[0];
  if (!target) return { status: 404, log: { outcome: 'unknown_account' } };
  const scope = authorizedTenantScope(target.tenant_id, null);
  const [account] = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select({ secret: commercePaymentAccounts.webhookSecretCiphertext })
        .from(commercePaymentAccounts)
        .where(
          and(
            eq(commercePaymentAccounts.tenantId, scope.tenantId),
            eq(commercePaymentAccounts.id, target.account_id),
          ),
        ),
    { accessMode: 'read only' },
  );
  if (!account) return { status: 404, log: { outcome: 'unknown_account' } };
  const secret = deps.keyring.decryptString(
    account.secret,
    paymentAccountAad(scope.tenantId, target.account_id, 'webhook'),
  );
  if (!verifyRazorpayWebhookSignature(input.rawBody, input.signature, [secret])) {
    return { status: 400, log: { outcome: 'bad_signature', tenantId: scope.tenantId } };
  }
  const eventId = input.eventId?.trim() ?? '';
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(eventId)) {
    return { status: 400, log: { outcome: 'missing_event_id', tenantId: scope.tenantId } };
  }
  let body: { event?: unknown; payload?: { payment_link?: { entity?: { id?: unknown } } } };
  try {
    body = JSON.parse(input.rawBody.toString('utf8')) as typeof body;
  } catch {
    return { status: 400, log: { outcome: 'malformed', tenantId: scope.tenantId } };
  }
  const event = typeof body.event === 'string' ? body.event.slice(0, 64) : 'unknown';
  const rawLinkId = body.payload?.payment_link?.entity?.id;
  const providerLinkId =
    typeof rawLinkId === 'string' && /^plink_[A-Za-z0-9]{6,32}$/.test(rawLinkId) ? rawLinkId : null;

  const outcome = await deps.db.run(scope, async (tx) => {
    const recorded = await tx
      .insert(commercePaymentEvents)
      .values({ id: uuidv7(), tenantId: scope.tenantId, eventId, event, providerLinkId })
      .onConflictDoNothing({
        target: [commercePaymentEvents.tenantId, commercePaymentEvents.eventId],
      })
      .returning({ id: commercePaymentEvents.id });
    if (recorded.length === 0) return 'duplicate';
    if (!LINK_EVENTS.has(event) || !providerLinkId) return 'ignored';
    const [link] = await tx
      .update(commercePaymentLinks)
      .set({ nextCheckAt: deps.clock.now() })
      .where(
        and(
          eq(commercePaymentLinks.tenantId, scope.tenantId),
          eq(commercePaymentLinks.providerLinkId, providerLinkId),
          inArray(commercePaymentLinks.status, [...OPEN_PAYMENT_LINK_STATUSES]),
        ),
      )
      .returning({ id: commercePaymentLinks.id });
    if (!link) return 'no_open_link';
    await deps.jobs.enqueue(
      tx,
      QUEUES.commerceLink.name,
      deps.signer.sign({
        kind: 'commerce.link',
        tenantId: scope.tenantId,
        actorUserId: null,
        ref: link.id,
      }),
      { singletonKey: `${link.id}:webhook:${eventId}` },
    );
    return 'check_signalled';
  });
  return { status: 200, log: { outcome, tenantId: scope.tenantId, event } };
}
