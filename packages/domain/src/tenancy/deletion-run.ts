import { performance } from 'node:perf_hooks';
import type { Clock, Keyring } from '@w360/core';
import {
  and,
  authorizedTenantScope,
  autoRechargeSettings,
  billingCustomers,
  commerceStores,
  eq,
  inArray,
  paymentMandates,
  sql,
  systemScope,
  tenants,
  users,
  whatsappAccounts,
  type Database,
  type TenantDeletionCleanup,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { isAppError } from '@w360/core';
import { cancelPendingAutoRecharge } from '../billing/attempts';
import type { RazorpayClient } from '../billing/razorpay';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { credentialAad } from '../messaging/credentials';
import type { GraphClient } from '../messaging/graph';
import { removeStoreForDeletion, type StoreWorkerDeps } from '../stores/worker';
import { formatCompanyTime } from './deletion';

/**
 * The worker's part of a company deletion (ADR-055). A run starts the deletion (from then on it
 * cannot be cancelled), cleans up at providers once, deletes the company's rows a batch per
 * transaction for a few minutes, and finishes when nothing is left. Everything it has done is in
 * the database, so the next run continues where this one stopped.
 */
export interface DeletionRunDeps extends OutboxDeps {
  db: Database;
  clock: Clock;
  keyring: Keyring;
  /** Null when the Meta app is not configured: WhatsApp accounts are then recorded as skipped. */
  graph: GraphClient | null;
  /** Null when Razorpay is not configured: card mandates are then recorded as skipped. */
  razorpay: RazorpayClient | null;
  stores: StoreWorkerDeps;
}

export interface DeletionRunOptions {
  /** How long one run keeps deleting before it lets the next run continue. */
  budgetMs?: number;
  batchSize?: number;
}

export type DeletionRunResult =
  /** Not pending deletion, cancelled, or not due (nothing was done). */
  | { outcome: 'not_due' }
  | { outcome: 'continue'; rowsDeleted: number }
  | { outcome: 'finished'; rowsDeleted: number; cleanup: TenantDeletionCleanup[] };

interface StartedDeletion {
  deletionId: string;
  companyName: string;
  notifyUserIds: string[];
  providerCleanupDone: boolean;
  /** Outcomes recorded by an earlier run (empty until the providers were visited). */
  providerCleanup: TenantDeletionCleanup[];
}

async function startDeletion(db: Database, tenantId: string): Promise<StartedDeletion | null> {
  try {
    const result = await db.run(systemScope, (tx) =>
      tx.execute<{
        deletion_id: string;
        company_name: string;
        notify_user_ids: string[];
        provider_cleanup_done: boolean;
        provider_cleanup: TenantDeletionCleanup[];
      }>(
        sql`select deletion_id, company_name, notify_user_ids, provider_cleanup_done, provider_cleanup
              from ops.start_tenant_deletion(${tenantId}::uuid)`,
      ),
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      deletionId: row.deletion_id,
      companyName: row.company_name,
      notifyUserIds: row.notify_user_ids,
      providerCleanupDone: row.provider_cleanup_done,
      providerCleanup: row.provider_cleanup,
    };
  } catch (error) {
    // Cancelled, not due, or already finished: nothing to do (W3412 / W3404 from the function).
    if (isAppError(error) && ['precondition_failed', 'not_found'].includes(error.code)) return null;
    throw error;
  }
}

function graphCode(result: { kind: string; code?: number }): string {
  return result.code ? `meta_${result.code}` : `meta_${result.kind}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'a WooCommerce store';
  }
}

/** Removes HyFib from the company's providers, once; every outcome is recorded, none stops it. */
async function cleanUpProviders(
  deps: DeletionRunDeps,
  scope: TenantScope,
): Promise<TenantDeletionCleanup[]> {
  const items: TenantDeletionCleanup[] = [];
  const tenantId = scope.tenantId;

  // WhatsApp: stop Meta sending this account's events to HyFib. Numbers stay registered.
  const accounts = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select({
          id: whatsappAccounts.id,
          wabaId: whatsappAccounts.wabaId,
          name: whatsappAccounts.name,
          credential: whatsappAccounts.credentialCiphertext,
        })
        .from(whatsappAccounts)
        .where(eq(whatsappAccounts.tenantId, tenantId))
        .orderBy(whatsappAccounts.id),
    { accessMode: 'read only' },
  );
  for (const account of accounts) {
    const label = `WhatsApp account ${account.name ?? account.wabaId} (${account.wabaId})`.slice(
      0,
      160,
    );
    if (!account.credential) {
      items.push({ kind: 'whatsapp_account', label, outcome: 'skipped', code: 'no_credential' });
      continue;
    }
    if (!deps.graph) {
      items.push({ kind: 'whatsapp_account', label, outcome: 'skipped', code: 'meta_not_set_up' });
      continue;
    }
    const token = deps.keyring.decryptString(
      account.credential,
      credentialAad(tenantId, account.id),
    );
    const result = await deps.graph.unsubscribeApp(account.wabaId, token);
    items.push(
      result.ok
        ? { kind: 'whatsapp_account', label, outcome: 'done' }
        : { kind: 'whatsapp_account', label, outcome: 'failed', code: graphCode(result) },
    );
  }

  // Stores: uninstall from Shopify; delete HyFib's webhooks at WooCommerce (keys stay with the
  // store owner, who is asked to revoke them).
  const stores = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select({
          id: commerceStores.id,
          platform: commerceStores.platform,
          shopDomain: commerceStores.shopDomain,
          storeUrl: commerceStores.storeUrl,
        })
        .from(commerceStores)
        .where(eq(commerceStores.tenantId, tenantId))
        .orderBy(commerceStores.id),
    { accessMode: 'read only' },
  );
  for (const store of stores) {
    const shopify = store.platform === 'shopify';
    const kind = shopify ? 'shopify_store' : 'woocommerce_store';
    const label = (
      shopify ? (store.shopDomain ?? 'A Shopify store') : hostOf(store.storeUrl)
    ).slice(0, 160);
    const remote = await removeStoreForDeletion(deps.stores, scope, store.id);
    if (remote === 'gone') continue;
    items.push(
      remote === 'done'
        ? { kind, label, outcome: 'done', ...(shopify ? {} : { code: 'revoke_key_in_store' }) }
        : { kind, label, outcome: 'failed', code: remote },
    );
  }

  // HyFib's own card mandate: delete the token at Razorpay (how a card mandate is cancelled).
  const mandates = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select({
          id: paymentMandates.id,
          tokenId: paymentMandates.providerTokenId,
          network: paymentMandates.cardNetwork,
          last4: paymentMandates.cardLast4,
          customerId: billingCustomers.providerCustomerId,
        })
        .from(paymentMandates)
        .innerJoin(
          billingCustomers,
          and(
            eq(billingCustomers.tenantId, paymentMandates.tenantId),
            eq(billingCustomers.id, paymentMandates.billingCustomerId),
          ),
        )
        .where(
          and(
            eq(paymentMandates.tenantId, tenantId),
            inArray(paymentMandates.status, ['active', 'paused', 'pending_authorization']),
          ),
        )
        .orderBy(paymentMandates.id),
    { accessMode: 'read only' },
  );
  for (const mandate of mandates) {
    const label = `Card ${mandate.network ?? ''} •••• ${mandate.last4 ?? '????'}`
      .replace(/\s+/g, ' ')
      .slice(0, 160);
    let item: TenantDeletionCleanup;
    if (!mandate.tokenId) {
      item = { kind: 'card_mandate', label, outcome: 'skipped', code: 'no_token' };
    } else if (!deps.razorpay) {
      item = { kind: 'card_mandate', label, outcome: 'skipped', code: 'razorpay_not_set_up' };
    } else {
      const deleted = await deps.razorpay.deleteToken(mandate.customerId, mandate.tokenId);
      // A permanent refusal means the token no longer exists at Razorpay.
      item =
        deleted.ok || deleted.kind === 'permanent'
          ? { kind: 'card_mandate', label, outcome: 'done' }
          : {
              kind: 'card_mandate',
              label,
              outcome: 'failed',
              code: `razorpay_${deleted.kind}`,
            };
    }
    items.push(item);
    const now = deps.clock.now();
    await deps.db.run(scope, async (tx) => {
      await tx
        .update(paymentMandates)
        .set({ status: 'cancelled', endedAt: now })
        .where(and(eq(paymentMandates.tenantId, tenantId), eq(paymentMandates.id, mandate.id)));
      await tx
        .update(autoRechargeSettings)
        .set({ enabled: false })
        .where(
          and(
            eq(autoRechargeSettings.tenantId, tenantId),
            eq(autoRechargeSettings.mandateId, mandate.id),
          ),
        );
      await cancelPendingAutoRecharge(tx, scope, 'The company is being deleted.', now);
    });
  }
  return items;
}

async function notifyDeleted(
  deps: DeletionRunDeps,
  tx: Tx,
  started: StartedDeletion,
  cleanup: TenantDeletionCleanup[],
  timeZone: string,
): Promise<void> {
  if (started.notifyUserIds.length === 0) return;
  const people = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, started.notifyUserIds));
  const failed = cleanup.filter((item) => item.outcome === 'failed');
  const woo = cleanup.filter((item) => item.kind === 'woocommerce_store');
  const lines = [
    `${started.companyName} was deleted at the request of its owners on ${formatCompanyTime(deps.clock.now(), timeZone)}.`,
    "Its members, contacts, conversations, messages, templates, campaigns, automations and other data were deleted. Copies in HyFib's encrypted backups are removed when those backups expire.",
    'Billing records are kept as the law requires. Your own HyFib account is not deleted.',
  ];
  if (failed.length > 0) {
    lines.push(
      `HyFib could not remove itself from: ${failed.map((item) => item.label).join('; ')}. Remove HyFib's access there yourself.`,
    );
  }
  if (woo.length > 0) {
    lines.push(
      `WooCommerce does not let HyFib revoke its own key: revoke the HyFib REST API key in your store's settings (${woo.map((item) => item.label).join(', ')}).`,
    );
  }
  lines.push(
    'The WhatsApp numbers stay registered in your WhatsApp Business Account; HyFib no longer receives or sends their messages.',
  );
  for (const person of people) {
    await enqueueEmail(deps, tx, {
      to: person.email,
      // Not the company's: its rows are gone, and this email is to the people themselves.
      tenantId: null,
      dedupeKey: `tenant-deletion:${started.deletionId}:finished:${person.id}`,
      payload: {
        kind: 'tenant.notice',
        companyName: started.companyName,
        subject: 'Company deleted',
        lines: lines.map((line) => line.slice(0, 600)),
      },
    });
  }
}

/** One run of a company's deletion; see `DeletionRunResult`. */
export async function runTenantDeletion(
  deps: DeletionRunDeps,
  tenantId: string,
  options: DeletionRunOptions = {},
): Promise<DeletionRunResult> {
  const budgetMs = options.budgetMs ?? 5 * 60_000;
  const batchSize = options.batchSize ?? 2_000;
  const started = await startDeletion(deps.db, tenantId);
  if (!started) return { outcome: 'not_due' };
  const scope = authorizedTenantScope(tenantId, null);
  const [company] = await deps.db.run(
    scope,
    (tx) => tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)),
    { accessMode: 'read only' },
  );
  const timeZone = company?.timezone ?? 'UTC';

  let cleanup = started.providerCleanup;
  if (!started.providerCleanupDone) {
    cleanup = await cleanUpProviders(deps, scope);
    const items = JSON.stringify(cleanup);
    await deps.db.run(systemScope, (tx) =>
      tx.execute(
        sql`select ops.record_tenant_deletion_cleanup(${tenantId}::uuid, ${items}::jsonb)`,
      ),
    );
  }

  const startedAt = performance.now();
  let rowsDeleted = 0;
  while (performance.now() - startedAt < budgetMs) {
    const result = await deps.db.run(systemScope, (tx) =>
      tx.execute<{ deleted: number; step: number | null }>(
        sql`select deleted, step from ops.delete_tenant_data(${tenantId}::uuid, ${batchSize})`,
      ),
    );
    const deleted = Number(result.rows[0]?.deleted ?? 0);
    rowsDeleted += deleted;
    if (deleted > 0) continue;
    const finished = await deps.db.run(systemScope, async (tx) => {
      const done = await tx.execute<{ finished: boolean }>(
        sql`select ops.finish_tenant_deletion(${tenantId}::uuid) as finished`,
      );
      if (done.rows[0]?.finished !== true) return null;
      await notifyDeleted(deps, tx, started, cleanup, timeZone);
      return cleanup;
    });
    // Null: a row was written while the run deleted (the next pass removes it).
    if (finished) return { outcome: 'finished', rowsDeleted, cleanup: finished };
  }
  return { outcome: 'continue', rowsDeleted };
}

/** Companies whose deletion is due, for the minute sweep (ids come from the database). */
export async function findDueTenantDeletions(db: Database, limit = 20): Promise<string[]> {
  const result = await db.run(systemScope, (tx) =>
    tx.execute<{ tenant_id: string }>(
      sql`select tenant_id from ops.tenant_deletions_due(${limit})`,
    ),
  );
  return result.rows.map((row) => row.tenant_id);
}
