import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import {
  createBillingUsageService,
  createCampaignsService,
  createReportsService,
  type TenantContext,
} from '@w360/domain';
import { acceptInvitation, createUser, invite } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Billing → Usage and rates (P5-07, ADR-060) against real PostgreSQL: who may read it, which
 * published card is in force and which comes next (drafts, withdrawn cards and other currencies
 * never), what the next card changes, the switch at its effective time, and this month's estimate,
 * which is the Reports estimate and changes no billing record. AED and OMR cards are used here
 * only: rate cards are shared by every company in the database.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const DAY = 86_400_000;

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

const usage = (clock: Clock = systemClock) => createBillingUsageService({ db: fx.dbs.app, clock });

async function member(c: Company, role: string) {
  const user = await createUser(fx.dbs, { name: `Usage ${role}` });
  const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(fx.dbs, user, token);
  return fx.ctx(c, user);
}

async function chooseCurrency(ctx: TenantContext, currency: string) {
  const campaigns = createCampaignsService({
    db: fx.dbs.app,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
  });
  await campaigns.updateSettings(
    ctx,
    { approvalRequired: false, cap: null, costCurrency: currency },
    {},
  );
}

interface CardSpec {
  currency: string;
  effectiveFrom: Date;
  prefixes: [string, string][];
  /** Market, category, list price in micros and, for a volume tier, the tier's first message. */
  prices: [string, string, number, number?][];
  status: 'draft' | 'published' | 'withdrawn';
  notes?: string;
}

/** A rate card as platform staff enter it (a fixture step through the owner role). */
async function rateCard(createdBy: string, spec: CardSpec): Promise<string> {
  const id = uuidv7();
  await fx.query(
    `INSERT INTO ops.rate_cards (id, currency, effective_from, source_url, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      spec.currency,
      spec.effectiveFrom,
      `https://example.test/rates/${id}`,
      spec.notes ?? null,
      createdBy,
    ],
  );
  for (const [prefix, market] of spec.prefixes) {
    await fx.query(
      `INSERT INTO ops.rate_card_prefixes (rate_card_id, prefix, market) VALUES ($1, $2, $3)`,
      [id, prefix, market],
    );
  }
  for (const [market, category, micros, tierFrom = 0] of spec.prices) {
    await fx.query(
      `INSERT INTO ops.rate_card_prices (rate_card_id, market, category, price_micros, tier_from)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, market, category, micros, tierFrom],
    );
  }
  if (spec.status !== 'draft') {
    await fx.query(`UPDATE ops.rate_cards SET status = 'published' WHERE id = $1`, [id]);
  }
  if (spec.status === 'withdrawn') {
    await fx.query(`UPDATE ops.rate_cards SET status = 'withdrawn' WHERE id = $1`, [id]);
  }
  return id;
}

async function deliveredMessage(
  c: Company,
  phone: string,
  pricing: Record<string, unknown> | null,
): Promise<void> {
  const contactId = uuidv7();
  const conversationId = uuidv7();
  const id = uuidv7();
  await fx.query(
    `INSERT INTO app.contacts (id, tenant_id, phone_e164, display_name, source)
     VALUES ($1, $2, $3, 'Usage customer', 'manual')`,
    [contactId, c.tenant.id, phone],
  );
  await fx.query(
    `INSERT INTO app.conversations (id, tenant_id, channel_account_id, contact_id)
     VALUES ($1, $2, $3, $4)`,
    [conversationId, c.tenant.id, c.channelAccountId, contactId],
  );
  await fx.query(
    `INSERT INTO app.messages (id, tenant_id, conversation_id, channel_account_id, direction,
       external_message_id, type, content, status, sender_type, pricing)
     VALUES ($1, $2, $3, $4, 'outbound', $5, 'template', '{}'::jsonb, 'delivered', 'campaign', $6)`,
    [
      id,
      c.tenant.id,
      conversationId,
      c.channelAccountId,
      `wamid.usage.${id}`,
      pricing ? JSON.stringify(pricing) : null,
    ],
  );
  await fx.query(
    `INSERT INTO app.message_status_events (id, tenant_id, channel_account_id, message_id,
       external_message_id, status, provider_timestamp, recipient_wa_id)
     VALUES ($1, $2, $3, $4, $5, 'delivered', now(), $6)`,
    [uuidv7(), c.tenant.id, c.channelAccountId, id, `wamid.usage.${id}`, phone.slice(1)],
  );
}

const billable = (category: string) => ({
  billable: true,
  pricing_model: 'PMP',
  type: 'regular',
  category,
});

describe('usage and rates', () => {
  let c: Company;
  let owner: TenantContext;
  let current: string;
  let next: string;
  let later: string;
  let nextFrom: Date;

  beforeAll(async () => {
    c = await fx.company();
    owner = await fx.ctx(c, c.owner);
    const now = Date.now();
    current = await rateCard(c.owner.id, {
      currency: 'AED',
      effectiveFrom: new Date(now - 40 * DAY),
      prefixes: [
        ['91', 'India'],
        ['65', 'Singapore'],
      ],
      prices: [
        ['India', 'marketing', 785_000],
        // A volume tier's price: the page shows list prices (tier 0) only.
        ['India', 'marketing', 700_000, 250_000],
        ['India', 'utility', 115_000],
        ['India', 'authentication', 115_000],
        ['Singapore', 'marketing', 4_620_000],
      ],
      status: 'published',
      notes: 'Copied from Meta’s July rate card',
    });
    // Later than the card in force, but withdrawn or never published: never shown.
    await rateCard(c.owner.id, {
      currency: 'AED',
      effectiveFrom: new Date(now - 20 * DAY),
      prefixes: [['91', 'India']],
      prices: [['India', 'marketing', 1]],
      status: 'withdrawn',
    });
    await rateCard(c.owner.id, {
      currency: 'AED',
      effectiveFrom: new Date(now - 10 * DAY),
      prefixes: [['91', 'India']],
      prices: [['India', 'marketing', 2]],
      status: 'draft',
    });
    // Another currency's cards are not this company's.
    await rateCard(c.owner.id, {
      currency: 'OMR',
      effectiveFrom: new Date(now - 5 * DAY),
      prefixes: [['91', 'India']],
      prices: [['India', 'marketing', 3]],
      status: 'published',
    });
    await rateCard(c.owner.id, {
      currency: 'OMR',
      effectiveFrom: new Date(now + DAY),
      prefixes: [['91', 'India']],
      prices: [['India', 'marketing', 4]],
      status: 'published',
    });
    // Taking effect before the next card, but never published or withdrawn: never shown.
    await rateCard(c.owner.id, {
      currency: 'AED',
      effectiveFrom: new Date(now + DAY),
      prefixes: [['91', 'India']],
      prices: [['India', 'marketing', 5]],
      status: 'draft',
    });
    await rateCard(c.owner.id, {
      currency: 'AED',
      effectiveFrom: new Date(now + 2 * DAY),
      prefixes: [['91', 'India']],
      prices: [['India', 'marketing', 6]],
      status: 'withdrawn',
    });
    nextFrom = new Date(now + 3 * DAY);
    next = await rateCard(c.owner.id, {
      currency: 'AED',
      effectiveFrom: nextFrom,
      prefixes: [
        ['91', 'India'],
        ['971', 'United Arab Emirates'],
      ],
      prices: [
        ['India', 'marketing', 865_000],
        ['India', 'utility', 115_000],
        ['India', 'service', 42_000],
        ['United Arab Emirates', 'marketing', 1_400_000],
      ],
      status: 'published',
    });
    later = await rateCard(c.owner.id, {
      currency: 'AED',
      effectiveFrom: new Date(now + 10 * DAY),
      prefixes: [['91', 'India']],
      prices: [['India', 'marketing', 900_000]],
      status: 'published',
    });
  });

  it('shows nothing to estimate without a billing currency, and only to members who can read billing', async () => {
    const other = await fx.company();
    const otherOwner = await fx.ctx(other, other.owner);
    const empty = await usage().usageAndRates(otherOwner);
    expect(empty).toMatchObject({
      currency: null,
      current: null,
      next: null,
      changes: [],
      byCategory: [],
    });
    expect(empty.charges).toMatchObject({ currency: null, delivered: 0, totalMicros: 0 });
    expect(empty.period.preset).toBe('this_month');

    // Billing managers read it; members without billing access are refused.
    expect((await usage().usageAndRates(await member(other, 'billing'))).currency).toBeNull();
    expect(await refusal(usage().usageAndRates(await fx.ctx(other, other.agent)))).toBe(
      'forbidden',
    );
    expect(await refusal(usage().usageAndRates(await fx.ctx(other, other.marketer)))).toBe(
      'forbidden',
    );
    expect(await refusal(usage().usageAndRates(await member(other, 'supervisor')))).toBe(
      'forbidden',
    );
  });

  it('shows the published card in force and the next one with what changes, never drafts, withdrawn cards or other currencies', async () => {
    await chooseCurrency(owner, 'AED');
    const u = await usage().usageAndRates(owner);
    expect(u.currency).toBe('AED');
    expect(u.current).toMatchObject({
      id: current,
      currency: 'AED',
      sourceUrl: `https://example.test/rates/${current}`,
      notes: 'Copied from Meta’s July rate card',
      markets: ['India', 'Singapore'],
    });
    expect(Object.fromEntries(u.current!.prices)).toEqual({
      'India|marketing': 785_000,
      'India|utility': 115_000,
      'India|authentication': 115_000,
      'Singapore|marketing': 4_620_000,
    });
    expect(u.next).toMatchObject({ id: next, effectiveFrom: nextFrom });
    expect(u.changes).toEqual([
      { market: 'India', category: 'marketing', currentMicros: 785_000, nextMicros: 865_000 },
      { market: 'India', category: 'authentication', currentMicros: 115_000, nextMicros: null },
      { market: 'India', category: 'service', currentMicros: null, nextMicros: 42_000 },
      { market: 'Singapore', category: 'marketing', currentMicros: 4_620_000, nextMicros: null },
      {
        market: 'United Arab Emirates',
        category: 'marketing',
        currentMicros: null,
        nextMicros: 1_400_000,
      },
    ]);

    // The next card is in force from its effective time, not a moment earlier.
    const before = await usage({ now: () => new Date(nextFrom.getTime() - 1) }).usageAndRates(
      owner,
    );
    expect([before.current?.id, before.next?.id]).toEqual([current, next]);
    const at = await usage({ now: () => nextFrom }).usageAndRates(owner);
    expect([at.current?.id, at.next?.id]).toEqual([next, later]);
    expect(at.changes).toEqual([
      { market: 'India', category: 'marketing', currentMicros: 865_000, nextMicros: 900_000 },
      { market: 'India', category: 'utility', currentMicros: 115_000, nextMicros: null },
      { market: 'India', category: 'service', currentMicros: 42_000, nextMicros: null },
      {
        market: 'United Arab Emirates',
        category: 'marketing',
        currentMicros: 1_400_000,
        nextMicros: null,
      },
    ]);
  });

  it('estimates this month exactly as Reports does, for this company only, and changes no billing record', async () => {
    await chooseCurrency(owner, 'AED');
    await deliveredMessage(c, '+919876543210', billable('utility'));
    await deliveredMessage(c, '+6591234567', billable('marketing'));
    await deliveredMessage(c, '+919876543211', {
      billable: false,
      pricing_model: 'PMP',
      type: 'free_customer_service',
      category: 'service',
    });
    await deliveredMessage(c, '+919876543212', null);
    await deliveredMessage(c, '+14155550123', billable('marketing'));
    // Another company's delivered message on the same rates.
    const other = await fx.company();
    await chooseCurrency(await fx.ctx(other, other.owner), 'AED');
    await deliveredMessage(other, '+919876543213', billable('marketing'));
    const ledgerRows = async () =>
      (
        await fx.query<{ n: number }>(
          `SELECT (SELECT count(*) FROM app.ledger_transactions WHERE tenant_id = $1)
                + (SELECT count(*) FROM app.wallets WHERE tenant_id = $1) AS n`,
          [c.tenant.id],
        )
      )[0]!.n;
    const rowsBefore = Number(await ledgerRows());

    const u = await usage().usageAndRates(owner);
    expect(u.charges).toMatchObject({
      currency: 'AED',
      delivered: 5,
      billable: 3,
      free: 1,
      notReported: 1,
      priced: 2,
      totalMicros: 115_000 + 4_620_000,
      unpriced: { noCurrency: 0, noRateCard: 0, otherCategory: 0, marketUnknown: 1, noPrice: 0 },
    });
    expect(u.byCategory).toEqual([
      { category: 'marketing', count: 1, micros: 4_620_000 },
      { category: 'utility', count: 1, micros: 115_000 },
    ]);
    const report = await createReportsService({ db: fx.dbs.app, clock: systemClock }).getReport(
      owner,
      { preset: 'this_month' },
    );
    expect(u.period).toEqual(report.period);
    expect(u.charges).toEqual(report.costs);
    // Billing managers see the same estimate; nothing was written to the wallet or the ledger.
    expect((await usage().usageAndRates(await member(c, 'billing'))).charges).toEqual(u.charges);
    expect(Number(await ledgerRows())).toBe(rowsBefore);
  });
});
