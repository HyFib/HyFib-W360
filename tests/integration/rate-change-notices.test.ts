import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, uuidv7, type Clock } from '@w360/core';
import {
  announceRateChange,
  announceRateChanges,
  createCampaignsService,
  outboxAad,
  RATE_NOTICE_DAYS,
  type BillingNoticeDeps,
  type RateNoticeDeps,
} from '@w360/domain';
import { acceptInvitation, createUser, invite } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * A notice before Meta's rates change (P5-07, ADR-065) against real PostgreSQL: the billing
 * managers of each active company whose billing currency a published card is for are emailed once,
 * when the card takes effect within 7 days, with what it changes against the card in force before
 * it. Drafts, withdrawn cards, cards already in force or further away, other currencies and
 * companies that are not active get nothing; a correction is a new card with its own notice. QAR,
 * KWD, BHD, JOD and BND cards are used here only: rate cards are shared by every company in the
 * database.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ESTIMATES =
  "HyFib's cost estimates use the new prices from that time. They are Meta's list prices: Meta bills your WhatsApp account directly.";

const notices = (): BillingNoticeDeps => ({
  outbox: { keyring: fx.keyring, jobs: fx.jobs(), signer: fx.signer },
  appBaseUrl: 'http://localhost:3000',
});
const deps = (clock: Clock = systemClock): RateNoticeDeps => ({
  db: fx.dbs.app,
  clock,
  notices: notices(),
});
const sweep = (clock: Clock = systemClock) => announceRateChanges(deps(clock));
const fixedClock = (at: Date): Clock => ({ now: () => new Date(at) });

async function member(c: Company, role: string) {
  const user = await createUser(fx.dbs, { name: `Rates ${role}` });
  const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(fx.dbs, user, token);
  return user;
}

/** A company with the billing currency chosen in Settings → Messaging (none when null). */
async function companyIn(currency: string | null, timezone?: string): Promise<Company> {
  const c = await fx.company();
  if (timezone) {
    await fx.query(`UPDATE app.tenants SET timezone = $2 WHERE id = $1`, [c.tenant.id, timezone]);
  }
  if (currency) await chooseCurrency(c, currency);
  return c;
}

async function chooseCurrency(c: Company, currency: string) {
  const campaigns = createCampaignsService({
    db: fx.dbs.app,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
    notices: fx.notices(),
  });
  await campaigns.updateSettings(
    await fx.ctx(c, c.owner),
    { approvalRequired: false, cap: null, costCurrency: currency },
    {},
  );
}

let staff: string | undefined;
/** A rate card as platform staff enter it (a fixture step through the owner role). */
async function rateCard(
  currency: string,
  effectiveFrom: Date,
  prices: [string, string, number][],
  status: 'draft' | 'published' | 'withdrawn' = 'published',
): Promise<string> {
  staff ??= (await createUser(fx.dbs, { name: 'Rates staff' })).id;
  const id = uuidv7();
  await fx.query(
    `INSERT INTO ops.rate_cards (id, currency, effective_from, source_url, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, currency, effectiveFrom, `https://example.test/rates/${id}`, staff],
  );
  const markets = [...new Set(prices.map(([market]) => market))];
  for (const [i, market] of markets.entries()) {
    await fx.query(
      `INSERT INTO ops.rate_card_prefixes (rate_card_id, prefix, market) VALUES ($1, $2, $3)`,
      [id, String(900 + i), market],
    );
  }
  for (const [market, category, micros] of prices) {
    await fx.query(
      `INSERT INTO ops.rate_card_prices (rate_card_id, market, category, price_micros)
       VALUES ($1, $2, $3, $4)`,
      [id, market, category, micros],
    );
  }
  if (status !== 'draft') await publish(id);
  if (status === 'withdrawn') await withdraw(id);
  return id;
}

const publish = (id: string) =>
  fx.query(`UPDATE ops.rate_cards SET status = 'published' WHERE id = $1`, [id]);
const withdraw = (id: string) =>
  fx.query(`UPDATE ops.rate_cards SET status = 'withdrawn' WHERE id = $1`, [id]);

interface Notice {
  to: string;
  subject: string;
  lines: string[];
  url: string;
}

/** The company's billing notices, oldest first. */
async function billingNotices(tenantId: string): Promise<Notice[]> {
  const { rows } = await fx.dbs.adminPool.query<{
    id: string;
    to_address: string;
    payload_ciphertext: string;
  }>(
    `SELECT id, to_address, payload_ciphertext FROM ops.email_outbox
      WHERE tenant_id = $1 AND kind = 'billing.notice' ORDER BY id`,
    [tenantId],
  );
  return rows.map((r) => {
    const payload = JSON.parse(fx.keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
      subject: string;
      lines: string[];
      url: string;
    };
    return { to: r.to_address, subject: payload.subject, lines: payload.lines, url: payload.url };
  });
}

/** The cards `ops.rate_change_notices_due` lists for the company. */
async function due(tenantId: string, days = RATE_NOTICE_DAYS): Promise<string[]> {
  const { rows } = await fx.dbs.adminPool.query<{ rate_card_id: string }>(
    `SELECT rate_card_id FROM ops.rate_change_notices_due(1000, $2) WHERE tenant_id = $1`,
    [tenantId, days],
  );
  return rows.map((r) => r.rate_card_id);
}

async function recorded(tenantId: string) {
  const { rows } = await fx.dbs.adminPool.query<{
    rate_card_id: string;
    currency: string;
    effective_from: Date;
  }>(
    `SELECT rate_card_id, currency, effective_from FROM app.rate_change_notices
      WHERE tenant_id = $1 ORDER BY sent_at, id`,
    [tenantId],
  );
  return rows;
}

const when = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
    at,
  );
const day = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone }).format(at);

describe('rate change notices', () => {
  it('emails the billing managers of companies in the card’s currency once, within a week of the change', async () => {
    const now = Date.now();
    const qar = await companyIn('QAR', 'Asia/Qatar');
    const billing = await member(qar, 'billing');
    await member(qar, 'admin');
    const kwd = await companyIn('KWD');
    const none = await companyIn(null);

    await rateCard('QAR', new Date(now - 30 * DAY), [
      ['Brazil', 'utility', 80_000],
      ['India', 'marketing', 785_000],
      ['India', 'utility', 115_000],
      ['India', 'authentication', 115_000],
      ['Singapore', 'marketing', 4_620_000],
    ]);
    // More than a week away: not yet.
    const later = await rateCard('QAR', new Date(now + (RATE_NOTICE_DAYS + 1) * DAY), [
      ['India', 'marketing', 1],
    ]);
    await sweep();
    expect(await due(qar.tenant.id)).toEqual([]);
    expect(await billingNotices(qar.tenant.id)).toEqual([]);

    const effectiveFrom = new Date(now + 6 * DAY + 5 * HOUR);
    const next = await rateCard('QAR', effectiveFrom, [
      // Brazil is no longer priced; India's utility price stays; the United Arab Emirates is new.
      ['India', 'marketing', 863_500],
      ['India', 'utility', 115_000],
      ['India', 'authentication', 138_000],
      ['Singapore', 'marketing', 4_065_600],
      ['United Arab Emirates', 'marketing', 3_840_000],
    ]);
    // A card for the other company's currency, due as well.
    const kwdCard = await rateCard('KWD', new Date(now + 2 * DAY), [['Kuwait', 'marketing', 1]]);
    expect(await due(qar.tenant.id)).toEqual([next]);
    expect(await due(kwd.tenant.id)).toEqual([kwdCard]);
    expect(await due(none.tenant.id)).toEqual([]);

    const result = await sweep();
    expect(result.failed).toEqual([]);
    expect(result.announced).toBeGreaterThanOrEqual(2);
    await sweep();

    const sent = await billingNotices(qar.tenant.id);
    expect(sent.map((n) => n.to).sort()).toEqual([billing.email, qar.owner.email].sort());
    for (const notice of sent) {
      expect(notice).toMatchObject({
        subject: `Meta's WhatsApp rates for QAR change on ${day(effectiveFrom, 'Asia/Qatar')}`,
        url: `http://localhost:3000/c/${qar.tenant.slug}/billing/usage`,
        lines: [
          `Meta's rate card for QAR changes at ${when(effectiveFrom, 'Asia/Qatar')} (Asia/Qatar).`,
          'Compared with the card before it, the new card changes 3 prices, adds 1 price and no longer lists 1 price.',
          'The largest of the 5 changes (Billing → Usage and rates lists them all before the card takes effect):',
          '• India, authentication: 0.115 QAR to 0.138 QAR (+20.0%)',
          '• Singapore, marketing: 4.62 QAR to 4.0656 QAR (−12.0%)',
          '• India, marketing: 0.785 QAR to 0.8635 QAR (+10.0%)',
          ESTIMATES,
        ],
      });
    }
    expect(await recorded(qar.tenant.id)).toEqual([
      { rate_card_id: next, currency: 'QAR', effective_from: effectiveFrom },
    ]);
    expect((await billingNotices(kwd.tenant.id)).map((n) => n.subject)).toEqual([
      `Meta's WhatsApp rates for KWD change on ${day(new Date(now + 2 * DAY), 'Asia/Kolkata')}`,
    ]);
    expect(await billingNotices(none.tenant.id)).toEqual([]);
    expect(await due(qar.tenant.id)).toEqual([]);

    // The card further away is announced, once, when a week is left: seen here with a longer window.
    expect(await due(qar.tenant.id, RATE_NOTICE_DAYS + 2)).toEqual([later]);
  });

  it('tells nobody about drafts, withdrawn cards, cards already in force, or companies that are not active', async () => {
    const now = Date.now();
    const active = await companyIn('BHD');
    const suspended = await companyIn('BHD');
    const deleting = await companyIn('BHD');
    await fx.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [
      suspended.tenant.id,
    ]);
    await fx.query(`UPDATE app.tenants SET status = 'pending_deletion' WHERE id = $1`, [
      deleting.tenant.id,
    ]);

    await rateCard('BHD', new Date(now - 30 * DAY), [['Bahrain', 'marketing', 20_000]]);
    await rateCard('BHD', new Date(now + 2 * DAY), [['Bahrain', 'marketing', 21_000]], 'draft');
    await rateCard('BHD', new Date(now + 3 * DAY), [['Bahrain', 'marketing', 22_000]], 'withdrawn');
    // Published after the time it took effect: already in force, so there is nothing to announce.
    await rateCard('BHD', new Date(now - HOUR), [['Bahrain', 'marketing', 23_000]]);
    await sweep();
    for (const c of [active, suspended, deleting]) {
      expect(await due(c.tenant.id)).toEqual([]);
      expect(await billingNotices(c.tenant.id)).toEqual([]);
    }

    const effectiveFrom = new Date(now + 5 * DAY);
    const card = await rateCard('BHD', effectiveFrom, [['Bahrain', 'marketing', 25_300]]);
    await sweep();
    expect(await billingNotices(suspended.tenant.id)).toEqual([]);
    expect(await billingNotices(deleting.tenant.id)).toEqual([]);
    // Not listed at all, so they never take the place of active companies in a sweep.
    expect(await due(suspended.tenant.id)).toEqual([]);
    expect(await due(deleting.tenant.id)).toEqual([]);
    const sent = await billingNotices(active.tenant.id);
    expect(sent).toHaveLength(1);
    // Compared with the card in force before it: the one published late, not the withdrawn one.
    expect(sent[0]!.lines.slice(1)).toEqual([
      'Compared with the card before it, the new card changes 1 price.',
      'The changes:',
      '• Bahrain, marketing: 0.023 BHD to 0.0253 BHD (+10.0%)',
      ESTIMATES,
    ]);

    // Withdrawn after the notice: nothing more. Its correction is a new card with its own notice.
    await withdraw(card);
    const correction = await rateCard('BHD', new Date(now + 5 * DAY + HOUR), [
      ['Bahrain', 'marketing', 23_000],
    ]);
    // A company that chooses the currency now is told about the correction only.
    const newcomer = await companyIn('BHD');
    await sweep();
    const after = await billingNotices(active.tenant.id);
    expect(after).toHaveLength(2);
    expect(after[1]!.lines.slice(1)).toEqual([
      'The new card has the same list prices as the card before it.',
      ESTIMATES,
    ]);
    expect((await recorded(active.tenant.id)).map((r) => r.rate_card_id)).toEqual([
      card,
      correction,
    ]);
    expect((await recorded(newcomer.tenant.id)).map((r) => r.rate_card_id)).toEqual([correction]);
    expect(await billingNotices(suspended.tenant.id)).toEqual([]);
    expect(await billingNotices(deleting.tenant.id)).toEqual([]);
  });

  it('says so when a card is the first for its currency', async () => {
    const c = await companyIn('JOD');
    const effectiveFrom = new Date(Date.now() + DAY);
    await rateCard('JOD', effectiveFrom, [['Jordan', 'marketing', 14_000]]);
    await sweep();
    expect((await billingNotices(c.tenant.id)).map((n) => n.lines)).toEqual([
      [
        `Meta's rate card for JOD changes at ${when(effectiveFrom, 'Asia/Kolkata')} (Asia/Kolkata).`,
        'It is the first rate card HyFib has for JOD, so there is nothing to compare it with.',
        ESTIMATES,
      ],
    ]);
  });

  it('checks each listed card again before telling a company, and tells it once when sweeps overlap', async () => {
    const now = Date.now();
    const c = await companyIn('BND');
    const other = await companyIn('KWD');
    await rateCard('BND', new Date(now - 30 * DAY), [['Brunei', 'marketing', 100_000]]);
    const card = await rateCard('BND', new Date(now + 4 * DAY), [['Brunei', 'marketing', 110_000]]);
    const draft = await rateCard(
      'BND',
      new Date(now + 3 * DAY),
      [['Brunei', 'utility', 1]],
      'draft',
    );
    const withdrawn = await rateCard(
      'BND',
      new Date(now + 2 * DAY),
      [['Brunei', 'utility', 2]],
      'withdrawn',
    );

    // As when the card was withdrawn, the company changed its currency or left, or time passed
    // after a sweep listed the pair: nothing is sent or recorded.
    expect(await announceRateChange(deps(), other.tenant.id, card)).toBe(false);
    expect(await announceRateChange(deps(), c.tenant.id, draft)).toBe(false);
    expect(await announceRateChange(deps(), c.tenant.id, withdrawn)).toBe(false);
    expect(await announceRateChange(deps(), c.tenant.id, uuidv7())).toBe(false);
    // The card in force already, or still more than a week away, by the sweep's clock.
    expect(
      await announceRateChange(deps(fixedClock(new Date(now + 5 * DAY))), c.tenant.id, card),
    ).toBe(false);
    expect(
      await announceRateChange(
        deps(fixedClock(new Date(now - (RATE_NOTICE_DAYS - 4) * DAY - HOUR))),
        c.tenant.id,
        card,
      ),
    ).toBe(false);
    await fx.query(`UPDATE app.tenants SET status = 'restricted' WHERE id = $1`, [c.tenant.id]);
    expect(await announceRateChange(deps(), c.tenant.id, card)).toBe(false);
    await fx.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [c.tenant.id]);
    expect(await billingNotices(c.tenant.id)).toEqual([]);
    expect(await billingNotices(other.tenant.id)).toEqual([]);
    expect(await recorded(c.tenant.id)).toEqual([]);

    // Two sweeps at once: one notice, from one of them.
    const outcomes = await Promise.all([
      announceRateChange(deps(), c.tenant.id, card),
      announceRateChange(deps(), c.tenant.id, card),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await billingNotices(c.tenant.id)).toHaveLength(1);
    expect(await recorded(c.tenant.id)).toHaveLength(1);
    expect(await announceRateChange(deps(), c.tenant.id, card)).toBe(false);

    // A second card published before the first takes effect is compared with the first.
    await rateCard('BND', new Date(now + 6 * DAY), [['Brunei', 'marketing', 121_000]]);
    await sweep();
    const sent = await billingNotices(c.tenant.id);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.lines.slice(1, 4)).toEqual([
      'Compared with the card before it, the new card changes 1 price.',
      'The changes:',
      '• Brunei, marketing: 0.11 BND to 0.121 BND (+10.0%)',
    ]);
  });

  it('goes on with the other companies when one fails, and tries that one again later', async () => {
    const broken = await companyIn('ISK');
    const fine = await companyIn('ISK');
    // A time zone no formatter knows (the database checks only its length): the email cannot be
    // written, so nothing is recorded or queued for that company.
    await fx.query(`UPDATE app.tenants SET timezone = 'Mars/Olympus_Mons' WHERE id = $1`, [
      broken.tenant.id,
    ]);
    const card = await rateCard('ISK', new Date(Date.now() + 3 * DAY), [
      ['Iceland', 'marketing', 900_000],
    ]);
    const result = await sweep();
    expect(result.failed.filter((f) => f.tenantId === broken.tenant.id)).toEqual([
      { tenantId: broken.tenant.id, rateCardId: card, error: expect.any(RangeError) },
    ]);
    expect(await billingNotices(fine.tenant.id)).toHaveLength(1);
    expect(await billingNotices(broken.tenant.id)).toEqual([]);
    expect(await recorded(broken.tenant.id)).toEqual([]);
    expect(await due(broken.tenant.id)).toEqual([card]);

    await fx.query(`UPDATE app.tenants SET timezone = 'Atlantic/Reykjavik' WHERE id = $1`, [
      broken.tenant.id,
    ]);
    expect((await sweep()).failed.filter((f) => f.tenantId === broken.tenant.id)).toEqual([]);
    expect(await billingNotices(broken.tenant.id)).toHaveLength(1);
    expect(await billingNotices(fine.tenant.id)).toHaveLength(1);
  });

  it('keeps the record append-only and each company’s records to itself', async () => {
    const { rows } = await fx.dbs.adminPool.query<{ tenant_id: string; id: string }>(
      `SELECT tenant_id, id FROM app.rate_change_notices ORDER BY id LIMIT 1`,
    );
    const { id } = rows[0]!;
    await expect(
      fx.dbs.appPool.query(`UPDATE app.rate_change_notices SET currency = 'USD' WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      fx.dbs.appPool.query(`DELETE FROM app.rate_change_notices WHERE id = $1`, [id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      fx.dbs.adminPool.query(`UPDATE app.rate_change_notices SET currency = 'USD' WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/app\.rate_change_notices is append-only/);
    // Without a company scope the runtime role sees no record at all (RLS).
    expect((await fx.dbs.appPool.query(`SELECT id FROM app.rate_change_notices`)).rows).toEqual([]);
  });

  it('lets the listing function read published cards and billing currencies only', async () => {
    /** Runs one statement as w360_definer, the owner of `ops.rate_change_notices_due`. */
    async function asDefiner(text: string) {
      const client = await fx.dbs.adminPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE w360_definer');
        return (await client.query<{ status: string }>(text)).rows;
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
    const statuses = await asDefiner(`SELECT status FROM ops.rate_cards WHERE currency = 'BND'`);
    // BND has three published cards, a draft and a withdrawn card.
    expect(statuses.map((r) => r.status)).toEqual(['published', 'published', 'published']);
    await expect(asDefiner(`SELECT source_url FROM ops.rate_cards`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(asDefiner(`SELECT csat_question FROM app.messaging_settings`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(asDefiner(`SELECT sent_at FROM app.rate_change_notices`)).rejects.toThrow(
      /permission denied/,
    );
  });
});
