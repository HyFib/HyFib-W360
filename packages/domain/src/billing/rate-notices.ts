import { uuidv7, type Clock } from '@w360/core';
import {
  and,
  authorizedTenantScope,
  eq,
  messagingSettings,
  rateCards,
  rateChangeNotices,
  sql,
  systemScope,
  tenants,
  type Database,
} from '@w360/db';
import { formatUnitPrice } from '../campaigns/costs';
import { notifyBillingManagers, type BillingNoticeDeps } from './notices';
import {
  compareRateCards,
  RATE_CATEGORY_LABELS,
  rateCardInForce,
  rateCardWithPrices,
  type RateChange,
} from './usage';

/**
 * A notice before Meta's rates change (ADR-065). When a published rate card for a company's
 * billing currency takes effect within RATE_NOTICE_DAYS days, the company's billing managers are
 * emailed once: when it takes effect and what it changes against the card in force before it. The
 * minute billing sweep lists due companies and cards (ids only); each pair is checked again and
 * recorded in the company's own scope, in the transaction that queues the email.
 */

/** How long before a card takes effect companies are told about it. */
export const RATE_NOTICE_DAYS = 7;
/** Changes named in the email; the rest are counted and shown on Billing → Usage and rates. */
const EXAMPLES = 3;

export interface RateNoticeDeps {
  db: Database;
  clock: Clock;
  notices: BillingNoticeDeps;
}

export interface RateNoticeSweepResult {
  announced: number;
  failed: { tenantId: string; rateCardId: string; error: unknown }[];
}

/** The size of a change, for choosing the examples: relative when possible, new and dropped last. */
function weight(change: RateChange): number {
  const { currentMicros: from, nextMicros: to } = change;
  if (from === null || to === null) return -1;
  if (from === 0) return to === 0 ? 0 : Number.MAX_SAFE_INTEGER;
  return Math.abs(to - from) / from;
}

/** One change as the email names it, e.g. "India, marketing: 0.7846 INR to 0.8631 INR (+10.0%)". */
function describe(change: RateChange, currency: string): string {
  const what = `${change.market}, ${RATE_CATEGORY_LABELS[change.category].toLowerCase()}`;
  const { currentMicros: from, nextMicros: to } = change;
  if (to === null) {
    return from === null
      ? what
      : `${what}: no longer priced (was ${formatUnitPrice(from, currency)})`;
  }
  if (from === null) return `${what}: new price ${formatUnitPrice(to, currency)}`;
  const prices = `${formatUnitPrice(from, currency)} to ${formatUnitPrice(to, currency)}`;
  if (from === 0) return `${what}: ${prices}`;
  const sign = to > from ? '+' : '−';
  return `${what}: ${prices} (${sign}${((Math.abs(to - from) / from) * 100).toFixed(1)}%)`;
}

function summary(changes: RateChange[]): string {
  const changed = changes.filter((c) => c.currentMicros !== null && c.nextMicros !== null).length;
  const added = changes.filter((c) => c.currentMicros === null).length;
  const dropped = changes.filter((c) => c.nextMicros === null).length;
  const parts = [
    changed > 0 ? `changes ${changed} ${changed === 1 ? 'price' : 'prices'}` : null,
    added > 0 ? `adds ${added} ${added === 1 ? 'price' : 'prices'}` : null,
    dropped > 0 ? `no longer lists ${dropped} ${dropped === 1 ? 'price' : 'prices'}` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return 'The new card has the same list prices as the card before it.';
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `Compared with the card before it, the new card ${list}.`;
}

/**
 * Tells one company about one card, unless it was told already or the card is no longer due for
 * it (withdrawn, not for the company's billing currency, in force already or more than
 * RATE_NOTICE_DAYS days away, the company not active). Returns whether it emailed. The ids come
 * from `ops.rate_change_notices_due`, never from a request.
 */
export async function announceRateChange(
  deps: RateNoticeDeps,
  tenantId: string,
  rateCardId: string,
): Promise<boolean> {
  const scope = authorizedTenantScope(tenantId, null);
  return deps.db.run(scope, async (tx) => {
    const now = deps.clock.now();
    const [company] = await tx
      .select({ status: tenants.status, timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (company?.status !== 'active') return false;
    const [settings] = await tx
      .select({ currency: messagingSettings.costCurrency })
      .from(messagingSettings)
      .where(eq(messagingSettings.tenantId, tenantId));
    const currency = settings?.currency ?? null;
    if (!currency) return false;
    const [card] = await tx
      .select({
        id: rateCards.id,
        currency: rateCards.currency,
        effectiveFrom: rateCards.effectiveFrom,
        sourceUrl: rateCards.sourceUrl,
        notes: rateCards.notes,
      })
      .from(rateCards)
      .where(
        and(
          eq(rateCards.id, rateCardId),
          eq(rateCards.status, 'published'),
          eq(rateCards.currency, currency),
        ),
      );
    const until = now.getTime() + RATE_NOTICE_DAYS * 86_400_000;
    if (!card || card.effectiveFrom <= now || card.effectiveFrom.getTime() > until) return false;
    const recorded = await tx
      .insert(rateChangeNotices)
      .values({
        id: uuidv7(),
        tenantId,
        rateCardId: card.id,
        currency,
        effectiveFrom: card.effectiveFrom,
      })
      .onConflictDoNothing()
      .returning({ id: rateChangeNotices.id });
    if (recorded.length === 0) return false;

    const next = await rateCardWithPrices(tx, card);
    const before = await rateCardInForce(tx, currency, new Date(card.effectiveFrom.getTime() - 1));
    const changes = before ? compareRateCards(before, next) : [];
    const examples = [...changes]
      .sort((a, b) => weight(b) - weight(a))
      .slice(0, EXAMPLES)
      .map((c) => `• ${describe(c, currency)}`);
    const when = new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: company.timezone,
    }).format(card.effectiveFrom);
    const day = new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeZone: company.timezone,
    }).format(card.effectiveFrom);
    await notifyBillingManagers(deps.notices, tx, scope, {
      subject: `Meta's WhatsApp rates for ${currency} change on ${day}`,
      lines: [
        `Meta's rate card for ${currency} changes at ${when} (${company.timezone}).`,
        before
          ? summary(changes)
          : `It is the first rate card HyFib has for ${currency}, so there is nothing to compare it with.`,
        ...(examples.length > 0
          ? [
              changes.length > examples.length
                ? `The largest of the ${changes.length} changes (Billing → Usage and rates lists them all before the card takes effect):`
                : 'The changes:',
              ...examples,
            ]
          : []),
        "HyFib's cost estimates use the new prices from that time. They are Meta's list prices: Meta bills your WhatsApp account directly.",
      ],
      billingPath: 'usage',
    });
    return true;
  });
}

/** The minute sweep's rate change notices; one failure does not hold up the others. */
export async function announceRateChanges(
  deps: RateNoticeDeps,
  limit = 100,
): Promise<RateNoticeSweepResult> {
  const due = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; rate_card_id: string }>(
        sql`select tenant_id, rate_card_id from ops.rate_change_notices_due(${limit}, ${RATE_NOTICE_DAYS})`,
      ),
    { accessMode: 'read only' },
  );
  const result: RateNoticeSweepResult = { announced: 0, failed: [] };
  for (const { tenant_id: tenantId, rate_card_id: rateCardId } of due.rows) {
    try {
      if (await announceRateChange(deps, tenantId, rateCardId)) result.announced += 1;
    } catch (error) {
      result.failed.push({ tenantId, rateCardId, error });
    }
  }
  return result;
}
