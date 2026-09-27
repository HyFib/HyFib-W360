import { uuidv7 } from '@w360/core';
import {
  and,
  commerceStoreCheckouts,
  commerceStoreMessageRules,
  commerceStoreMessages,
  commerceStores,
  consentEvents,
  eq,
  inArray,
  lt,
  sql,
  suppressions,
  tenants,
  type Tx,
} from '@w360/db';
import { contactForPhone } from '../contacts/service';
import {
  STORE_MESSAGE_LIMITS,
  checkoutReminders,
  isCartEvent,
  storeConsentAction,
  storeMessageSendAt,
  type CheckoutState,
} from './messages-model';
import { storeCustomerPhone, type StoreCheckoutConsent, type StoreCheckoutRecord } from './model';
import { enqueueStoreMessage, sendWindowOf, type StoreMessageQueueDeps } from './order-messages';

/**
 * Cart reminders (P4-06d, ADR-049): the copy of the checkouts customers left in a Shopify store,
 * the reminders a read calls for, and the WhatsApp consent Shopify records for their numbers.
 * Everything here runs in the transaction that saves a page of checkouts, under the store's lease.
 */

type StoreRow = typeof commerceStores.$inferSelect;

/** A checkout as a read left it. */
export interface SavedCheckout {
  checkoutId: string;
  externalId: string;
  /** New to the copy, updated since (a later update time), or completed by this read. */
  changed: boolean;
  state: CheckoutState;
  /** The number in E.164 (null when there is none, it does not read as one, or it was redacted). */
  phone: string | null;
  customerName: string | null;
  /** Shopify's consent for `phone` (null when not read or redacted). */
  consent: StoreCheckoutConsent | null;
}

/**
 * Saves checkouts read from the store. An older copy never replaces a newer one; a redacted
 * checkout stays without customer details, and a checkout with the number of an erased contact is
 * redacted as it arrives.
 */
export async function saveStoreCheckouts(
  tx: Tx,
  store: Pick<StoreRow, 'id' | 'tenantId' | 'phoneCallingCode'>,
  records: readonly StoreCheckoutRecord[],
  now: Date,
): Promise<SavedCheckout[]> {
  if (records.length === 0) return [];
  const phones = records.map((r) => storeCustomerPhone(r.phone, store.phoneCallingCode));
  const distinct = [...new Set(phones.filter((p): p is string => p !== null))];
  const erased = new Set(
    distinct.length === 0
      ? []
      : (
          await tx
            .select({ phone: suppressions.phoneE164 })
            .from(suppressions)
            .where(
              and(
                eq(suppressions.tenantId, store.tenantId),
                eq(suppressions.reason, 'erased'),
                inArray(suppressions.phoneE164, distinct),
              ),
            )
        ).map((r) => r.phone),
  );
  const before = new Map(
    (
      await tx
        .select({
          externalId: commerceStoreCheckouts.externalId,
          remoteUpdatedAt: commerceStoreCheckouts.remoteUpdatedAt,
          completedAt: commerceStoreCheckouts.completedAt,
        })
        .from(commerceStoreCheckouts)
        .where(
          and(
            eq(commerceStoreCheckouts.tenantId, store.tenantId),
            eq(commerceStoreCheckouts.storeId, store.id),
            inArray(
              commerceStoreCheckouts.externalId,
              records.map((r) => r.externalId),
            ),
          ),
        )
    ).map((row) => [row.externalId, row]),
  );
  const saved: SavedCheckout[] = [];
  for (const [index, record] of records.entries()) {
    const phone = phones[index] ?? null;
    const redact = phone !== null && erased.has(phone);
    // Consent belongs to the customer's own number only (the parser keeps it only then).
    const consent = !redact && phone !== null ? record.consent : null;
    const [row] = await tx
      .insert(commerceStoreCheckouts)
      .values({
        id: uuidv7(),
        tenantId: store.tenantId,
        storeId: store.id,
        externalId: record.externalId,
        name: record.name,
        remoteCreatedAt: record.createdAt,
        remoteUpdatedAt: record.updatedAt,
        completedAt: record.completedAt,
        customerExternalId: redact ? null : record.customerExternalId,
        customerName: redact ? null : record.customerName,
        customerPhone: redact ? null : phone,
        consentState: consent?.state ?? null,
        consentUpdatedAt: consent?.updatedAt ?? null,
        consentOptInLevel: consent?.optInLevel ?? null,
        consentCollectedFrom: consent?.collectedFrom ?? null,
        currency: record.currency,
        totalMinor: record.currency ? record.totalMinor : null,
        items: record.items,
        itemCount: record.itemCount,
        recoveryUrl: redact ? null : record.recoveryUrl,
        redactedAt: redact ? now : null,
        readAt: now,
      })
      .onConflictDoUpdate({
        target: [
          commerceStoreCheckouts.tenantId,
          commerceStoreCheckouts.storeId,
          commerceStoreCheckouts.externalId,
        ],
        set: {
          name: sql`excluded.name`,
          remoteCreatedAt: sql`excluded.remote_created_at`,
          remoteUpdatedAt: sql`excluded.remote_updated_at`,
          completedAt: sql`excluded.completed_at`,
          customerExternalId: sql`case when ${commerceStoreCheckouts.redactedAt} is null then excluded.customer_external_id end`,
          customerName: sql`case when ${commerceStoreCheckouts.redactedAt} is null then excluded.customer_name end`,
          customerPhone: sql`case when ${commerceStoreCheckouts.redactedAt} is null then excluded.customer_phone end`,
          consentState: sql`case when ${commerceStoreCheckouts.redactedAt} is null then excluded.consent_state end`,
          consentUpdatedAt: sql`case when ${commerceStoreCheckouts.redactedAt} is null then excluded.consent_updated_at end`,
          consentOptInLevel: sql`case when ${commerceStoreCheckouts.redactedAt} is null then excluded.consent_opt_in_level end`,
          consentCollectedFrom: sql`case when ${commerceStoreCheckouts.redactedAt} is null then excluded.consent_collected_from end`,
          currency: sql`excluded.currency`,
          totalMinor: sql`excluded.total_minor`,
          items: sql`excluded.items`,
          itemCount: sql`excluded.item_count`,
          recoveryUrl: sql`case when ${commerceStoreCheckouts.redactedAt} is null then excluded.recovery_url end`,
          redactedAt: sql`coalesce(${commerceStoreCheckouts.redactedAt}, excluded.redacted_at)`,
          readAt: now,
        },
        setWhere: sql`${commerceStoreCheckouts.remoteUpdatedAt} <= excluded.remote_updated_at`,
      })
      .returning({
        id: commerceStoreCheckouts.id,
        customerPhone: commerceStoreCheckouts.customerPhone,
        customerName: commerceStoreCheckouts.customerName,
        consentState: commerceStoreCheckouts.consentState,
        consentUpdatedAt: commerceStoreCheckouts.consentUpdatedAt,
        consentOptInLevel: commerceStoreCheckouts.consentOptInLevel,
        consentCollectedFrom: commerceStoreCheckouts.consentCollectedFrom,
        redactedAt: commerceStoreCheckouts.redactedAt,
      });
    // A copy newer than this read stays as it is.
    if (!row) continue;
    const previous = before.get(record.externalId);
    const changed =
      !previous ||
      record.updatedAt.getTime() > previous.remoteUpdatedAt.getTime() ||
      (record.completedAt !== null && previous.completedAt === null);
    saved.push({
      checkoutId: row.id,
      externalId: record.externalId,
      changed,
      state: {
        updatedAt: record.updatedAt,
        completed: record.completedAt !== null,
        hasPhone: row.customerPhone !== null,
        redacted: row.redactedAt !== null,
      },
      phone: row.customerPhone,
      customerName: row.customerName,
      consent:
        row.consentState !== null
          ? {
              state: row.consentState,
              updatedAt: row.consentUpdatedAt,
              optInLevel: row.consentOptInLevel,
              collectedFrom: row.consentCollectedFrom,
            }
          : null,
    });
  }
  return saved;
}

async function companyTimeZone(tx: Tx, tenantId: string): Promise<string> {
  const [row] = await tx
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row?.timezone ?? 'UTC';
}

/**
 * Records the cart reminders checkouts changed by a read call for: a pending reminder per cart rule
 * that is on (at most one per checkout and reminder), or, for one still waiting, a later send time
 * when the customer came back to the checkout. A reminder already sent or skipped stays as it is.
 */
export async function recordCheckoutReminders(
  tx: Tx,
  deps: StoreMessageQueueDeps,
  store: Pick<StoreRow, 'id' | 'tenantId' | 'sendWindowStart' | 'sendWindowEnd'>,
  checkouts: readonly SavedCheckout[],
  now: Date,
): Promise<number> {
  const candidates = checkouts.filter((c) => c.changed);
  if (candidates.length === 0) return 0;
  const rules = (
    await tx
      .select({
        event: commerceStoreMessageRules.event,
        enabledAt: commerceStoreMessageRules.enabledAt,
        delayMinutes: commerceStoreMessageRules.delayMinutes,
      })
      .from(commerceStoreMessageRules)
      .where(
        and(
          eq(commerceStoreMessageRules.tenantId, store.tenantId),
          eq(commerceStoreMessageRules.storeId, store.id),
          eq(commerceStoreMessageRules.enabled, true),
        ),
      )
  ).flatMap((r) => (r.enabledAt && isCartEvent(r.event) ? [{ ...r, enabledAt: r.enabledAt }] : []));
  if (rules.length === 0) return 0;
  const timeZone = await companyTimeZone(tx, store.tenantId);
  const window = sendWindowOf(store);
  const delays = new Map(rules.map((r) => [r.event, r.delayMinutes]));
  let recorded = 0;
  for (const checkout of candidates) {
    for (const reminder of checkoutReminders({ checkout: checkout.state, rules })) {
      const sendAt = storeMessageSendAt({
        occurredAt: reminder.occurredAt,
        now,
        delayMinutes: delays.get(reminder.event) ?? 0,
        window,
        timeZone,
      });
      const [inserted] = await tx
        .insert(commerceStoreMessages)
        .values({
          id: uuidv7(),
          tenantId: store.tenantId,
          storeId: store.id,
          checkoutId: checkout.checkoutId,
          event: reminder.event,
          state: 'pending',
          occurredAt: reminder.occurredAt,
          sendAt,
        })
        .onConflictDoNothing({
          target: [
            commerceStoreMessages.tenantId,
            commerceStoreMessages.checkoutId,
            commerceStoreMessages.event,
          ],
        })
        .returning({ id: commerceStoreMessages.id });
      if (inserted) {
        await enqueueStoreMessage(deps, tx, store.tenantId, inserted.id, sendAt);
        recorded += 1;
        continue;
      }
      // The customer came back: a reminder still waiting counts from the new time.
      const [moved] = await tx
        .update(commerceStoreMessages)
        .set({ occurredAt: reminder.occurredAt, sendAt })
        .where(
          and(
            eq(commerceStoreMessages.tenantId, store.tenantId),
            eq(commerceStoreMessages.checkoutId, checkout.checkoutId),
            eq(commerceStoreMessages.event, reminder.event),
            eq(commerceStoreMessages.state, 'pending'),
            lt(commerceStoreMessages.occurredAt, reminder.occurredAt),
          ),
        )
        .returning({ id: commerceStoreMessages.id });
      if (moved) {
        await enqueueStoreMessage(deps, tx, store.tenantId, moved.id, sendAt);
        recorded += 1;
      }
    }
  }
  return recorded;
}

/**
 * Records the WhatsApp consent Shopify reports for checkout numbers as consent events (source
 * `store`, SH-041), while the store's managers chose to use it. The event carries Shopify's update
 * time, so the newest consent from any source wins; the same state read again is not recorded
 * twice (a unique index), and a suppressed number never becomes a contact.
 */
export async function importStoreConsent(
  tx: Tx,
  store: Pick<StoreRow, 'id' | 'tenantId' | 'name' | 'shopDomain'>,
  checkouts: readonly SavedCheckout[],
): Promise<number> {
  // The setting as it is now, not when the read began: a manager may have turned it off meanwhile
  // (the share lock makes turning it off wait for this page, or this page see it off).
  const [setting] = await tx
    .select({ storeConsentAt: commerceStores.storeConsentAt })
    .from(commerceStores)
    .where(and(eq(commerceStores.tenantId, store.tenantId), eq(commerceStores.id, store.id)))
    .for('share');
  if (!setting?.storeConsentAt) return 0;
  const found = checkouts.flatMap((c) => {
    if (!c.changed || !c.phone || !c.consent || c.state.redacted) return [];
    const action = storeConsentAction(c.consent);
    return action && c.consent.updatedAt
      ? [{ checkout: c, phone: c.phone, action, at: c.consent.updatedAt, consent: c.consent }]
      : [];
  });
  if (found.length === 0) return 0;
  const suppressed = new Set(
    (
      await tx
        .select({ phone: suppressions.phoneE164 })
        .from(suppressions)
        .where(
          and(
            eq(suppressions.tenantId, store.tenantId),
            inArray(
              suppressions.phoneE164,
              found.map((f) => f.phone),
            ),
          ),
        )
    ).map((r) => r.phone),
  );
  let recorded = 0;
  for (const item of found) {
    if (suppressed.has(item.phone)) continue;
    const contactId = await contactForPhone(tx, store.tenantId, {
      phoneE164: item.phone,
      displayName: item.checkout.customerName,
      source: 'store',
    });
    const inserted = await tx
      .insert(consentEvents)
      .values({
        id: uuidv7(),
        tenantId: store.tenantId,
        contactId,
        purpose: 'marketing',
        action: item.action,
        source: 'store',
        evidence: {
          storeId: store.id,
          store: store.name ?? store.shopDomain,
          checkout: item.checkout.externalId,
          state: item.consent.state,
          optInLevel: item.consent.optInLevel,
          collectedFrom: item.consent.collectedFrom,
        },
        actorType: 'provider',
        actorId: store.shopDomain ? `shopify:${store.shopDomain}` : null,
        occurredAt: item.at,
      })
      .onConflictDoNothing({
        target: [
          consentEvents.tenantId,
          consentEvents.contactId,
          consentEvents.purpose,
          consentEvents.action,
          consentEvents.occurredAt,
        ],
        where: sql`source = 'store'`,
      })
      .returning({ id: consentEvents.id });
    recorded += inserted.length;
  }
  return recorded;
}

/** Deletes checkouts of the store last updated before the retention period (ADR-049). */
export async function pruneStoreCheckouts(
  tx: Tx,
  store: Pick<StoreRow, 'id' | 'tenantId'>,
  now: Date,
): Promise<number> {
  const deleted = await tx
    .delete(commerceStoreCheckouts)
    .where(
      and(
        eq(commerceStoreCheckouts.tenantId, store.tenantId),
        eq(commerceStoreCheckouts.storeId, store.id),
        lt(
          commerceStoreCheckouts.remoteUpdatedAt,
          new Date(now.getTime() - STORE_MESSAGE_LIMITS.checkoutRetentionDays * 86_400_000),
        ),
      ),
    )
    .returning({ id: commerceStoreCheckouts.id });
  return deleted.length;
}

/** Whether any cart reminder of the store is on (checkouts are read only then). */
export async function cartRemindersOn(
  tx: Tx,
  store: Pick<StoreRow, 'id' | 'tenantId'>,
): Promise<boolean> {
  const [rule] = await tx
    .select({ id: commerceStoreMessageRules.id })
    .from(commerceStoreMessageRules)
    .where(
      and(
        eq(commerceStoreMessageRules.tenantId, store.tenantId),
        eq(commerceStoreMessageRules.storeId, store.id),
        eq(commerceStoreMessageRules.enabled, true),
        inArray(commerceStoreMessageRules.event, ['cart_reminder', 'cart_second_reminder']),
      ),
    )
    .limit(1);
  return rule !== undefined;
}
