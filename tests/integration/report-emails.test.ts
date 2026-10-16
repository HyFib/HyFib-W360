import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, reportEmailSubscriptions } from '@w360/db';
import {
  createReportEmailsService,
  dayOf,
  findDueReportEmailCompanies,
  nextReportEmailAt,
  outboxAad,
  reportEmailPeriod,
  sendDueReportEmails,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Report emails (ADR-376) against real PostgreSQL: members' own choices under row security, the
 * definer sweep query, the company-scoped job with its row locks, the outbox, and each period
 * emailed at most once. Times are given to each call instead of waited for. The sweep query reads
 * every company's rows; assertions read only this file's companies.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const IST = 'Asia/Kolkata';
const HOUR = 3_600_000;
const at = (when: Date): Clock => ({ now: () => when });
const later = (from: Date, hours: number) => new Date(from.getTime() + hours * HOUR);
const service = (when: Date) => createReportEmailsService({ db: fx.dbs.app, clock: at(when) });
const send = (c: Company, when: Date) =>
  sendDueReportEmails(
    { db: fx.dbs.app, clock: at(when), ...fx.notices() },
    authorizedTenantScope(c.tenant.id, null),
  );
const due = async (c: Company, when: Date) =>
  (await findDueReportEmailCompanies(fx.dbs.app, when, 500)).includes(c.tenant.id);

/** The company's rows, as the database holds them. */
const rows = (c: Company) =>
  fx.query<{
    id: string;
    membership_id: string;
    frequency: string;
    next_send_at: Date;
    attempted_at: Date | null;
    last_period_from: string | null;
    last_period_to: string | null;
    last_sent_at: Date | null;
  }>(
    `SELECT id, membership_id, frequency, next_send_at, attempted_at,
            to_char(last_period_from, 'YYYY-MM-DD') AS last_period_from,
            to_char(last_period_to, 'YYYY-MM-DD') AS last_period_to, last_sent_at
       FROM app.report_email_subscriptions WHERE tenant_id = $1 ORDER BY membership_id, frequency`,
    [c.tenant.id],
  );

/** The company's report emails in the outbox. */
async function reportEmails(c: Company) {
  const outbox = await fx.query<{
    id: string;
    to_address: string;
    dedupe_key: string;
    payload_ciphertext: string;
  }>(
    `SELECT id, to_address, dedupe_key, payload_ciphertext FROM ops.email_outbox
      WHERE tenant_id = $1 AND dedupe_key LIKE 'report-email:%' ORDER BY to_address, id`,
    [c.tenant.id],
  );
  return outbox.map((r) => ({
    to: r.to_address,
    dedupeKey: r.dedupe_key,
    ...(JSON.parse(fx.keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
      kind: string;
      companyName: string;
      title: string;
      period: string;
      timezone: string;
      rows: { label: string; value: string }[];
      notes: string[];
      url: string;
    }),
  }));
}

describe('members’ choice of report emails (ADR-376)', () => {
  it('is each member’s own, needs reports.read, and is audited when it changes', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    const agent = await fx.ctx(c, c.agent);
    // A Wednesday afternoon in India: the weekly email is due Monday 07:00 there, the monthly
    // email on the first of next month.
    const wednesday = new Date('2026-10-14T10:00:00Z');
    expect(await service(wednesday).getReportEmails(owner)).toEqual([]);
    expect(
      await service(wednesday).updateReportEmails(
        owner,
        { weekly: true, monthly: true },
        { ipAddress: '203.0.113.9' },
      ),
    ).toEqual([
      {
        frequency: 'weekly',
        nextSendAt: new Date('2026-10-19T01:30:00Z'),
        lastPeriod: null,
        lastSentAt: null,
      },
      {
        frequency: 'monthly',
        nextSendAt: new Date('2026-11-01T01:30:00Z'),
        lastPeriod: null,
        lastSentAt: null,
      },
    ]);
    await service(wednesday).updateReportEmails(marketer, { weekly: false, monthly: true });
    // Each member sees and changes only their own.
    expect((await service(wednesday).getReportEmails(marketer)).map((e) => e.frequency)).toEqual([
      'monthly',
    ]);
    expect(
      await service(wednesday).updateReportEmails(owner, { weekly: true, monthly: false }),
    ).toHaveLength(1);
    expect((await rows(c)).map((r) => [r.membership_id, r.frequency]).sort()).toEqual(
      [
        [owner.membership.id, 'weekly'],
        [marketer.membership.id, 'monthly'],
      ].sort(),
    );
    // Saving the same choice again changes nothing and is not audited.
    await service(wednesday).updateReportEmails(owner, { weekly: true, monthly: false });
    const audit = await fx.query<{ actor_id: string; subject_id: string; metadata: unknown }>(
      `SELECT actor_id, subject_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'membership.report_emails_updated' ORDER BY id`,
      [c.tenant.id],
    );
    expect(audit).toEqual([
      {
        actor_id: c.owner.id,
        subject_id: owner.membership.id,
        metadata: { weekly: true, monthly: true },
      },
      {
        actor_id: c.marketer.id,
        subject_id: marketer.membership.id,
        metadata: { weekly: false, monthly: true },
      },
      {
        actor_id: c.owner.id,
        subject_id: owner.membership.id,
        metadata: { weekly: true, monthly: false },
      },
    ]);
    // Agents do not read reports.
    await expect(service(wednesday).getReportEmails(agent)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      service(wednesday).updateReportEmails(agent, { weekly: true, monthly: false }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service(wednesday).updateReportEmails(owner, { weekly: 'yes', monthly: false }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('stays inside its company', async () => {
    const a = await fx.company();
    const b = await fx.company();
    const ownerA = await fx.ctx(a, a.owner);
    const ownerB = await fx.ctx(b, b.owner);
    const now = new Date('2026-10-14T10:00:00Z');
    await service(now).updateReportEmails(ownerA, { weekly: true, monthly: false });
    expect(await service(now).getReportEmails(ownerB)).toEqual([]);
    // Company B's scope reads none of A's rows, and cannot write one for A.
    const seen = await fx.dbs.app.run(ownerB.scope, (tx) =>
      tx.select({ id: reportEmailSubscriptions.id }).from(reportEmailSubscriptions),
    );
    expect(seen).toEqual([]);
    await expect(
      fx.dbs.app.run(ownerB.scope, (tx) =>
        tx.insert(reportEmailSubscriptions).values({
          id: uuidv7(),
          tenantId: a.tenant.id,
          membershipId: ownerA.membership.id,
          frequency: 'monthly',
          nextSendAt: now,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('sending report emails (ADR-376)', () => {
  /** A company whose owner and marketer chose the weekly email; one customer wrote first. */
  async function companyWithWeeklyEmails() {
    const c = await fx.company();
    await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: '919845200001', text: 'Where is my order?' }] }),
    );
    const [message] = await fx.query<{ created_at: Date }>(
      `SELECT created_at FROM app.messages WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
      [c.tenant.id],
    );
    const written = message!.created_at;
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    for (const ctx of [owner, marketer]) {
      await service(written).updateReportEmails(ctx, { weekly: true, monthly: false });
    }
    const sendAt = nextReportEmailAt('weekly', IST, written);
    return { c, owner, marketer, written, sendAt };
  }

  it('emails each member who chose it once, with the company’s totals for the week', async () => {
    const { c, owner, marketer, written, sendAt } = await companyWithWeeklyEmails();
    const period = reportEmailPeriod('weekly', IST, sendAt);
    expect(await due(c, later(sendAt, -0.01))).toBe(false);
    expect(await due(c, later(sendAt, 0.01))).toBe(true);

    expect(await send(c, later(sendAt, 0.01))).toEqual({
      sent: 2,
      reports: 1,
      late: 0,
      repeated: 0,
      stopped: 0,
    });
    const emails = await reportEmails(c);
    expect(emails.map((e) => e.to).sort()).toEqual([c.marketer.email, c.owner.email].sort());
    expect(emails.map((e) => e.dedupeKey).sort()).toEqual(
      (await rows(c)).map((r) => `report-email:${r.id}:${period.from}`).sort(),
    );
    const email = emails.find((e) => e.to === c.owner.email)!;
    expect(email).toMatchObject({
      kind: 'reports.summary',
      companyName: `Company ${c.tenant.slug}`,
      title: 'Weekly report',
      timezone: IST,
      url: `http://localhost:3000/c/${c.tenant.slug}/reports?preset=custom&from=${period.from}&to=${period.to}`,
    });
    // The customer's message counts when it was written in the week reported.
    const day = dayOf(written, IST);
    const inbound = day >= period.from && day <= period.to ? '1' : '0';
    expect(email.rows[0]).toEqual({ label: 'Customer messages', value: inbound });
    // Never the customer: neither their number nor their message.
    expect(JSON.stringify(emails)).not.toContain('919845200001');
    expect(JSON.stringify(emails)).not.toContain('Where is my order');

    // Each row moves to the next Monday, with the week it emailed.
    for (const row of await rows(c)) {
      expect(row).toMatchObject({
        next_send_at: later(sendAt, 7 * 24),
        last_period_from: period.from,
        last_period_to: period.to,
        last_sent_at: later(sendAt, 0.01),
      });
    }
    expect((await service(sendAt).getReportEmails(owner))[0]?.lastPeriod).toEqual(period);
    expect((await service(sendAt).getReportEmails(marketer))[0]?.lastPeriod).toEqual(period);

    // Nothing is due any more: a duplicate or late job sends nothing twice.
    expect(await due(c, later(sendAt, 2))).toBe(false);
    expect(await send(c, later(sendAt, 2))).toEqual({
      sent: 0,
      reports: 0,
      late: 0,
      repeated: 0,
      stopped: 0,
    });
    expect(await reportEmails(c)).toHaveLength(2);
  });

  it('stops for a member who left or can no longer read reports, and deletes their choice', async () => {
    const { c, owner, marketer, written, sendAt } = await companyWithWeeklyEmails();
    // The agent becomes an analyst, chooses the email too, then leaves.
    const agentId = (await fx.ctx(c, c.agent)).membership.id;
    await fx.query(`UPDATE app.memberships SET roles = '{analyst}' WHERE id = $1`, [agentId]);
    await service(written).updateReportEmails(await fx.ctx(c, c.agent), {
      weekly: true,
      monthly: false,
    });
    await fx.query(`UPDATE app.memberships SET status = 'suspended' WHERE id = $1`, [agentId]);
    // The marketer becomes an agent, who does not read reports.
    await fx.query(`UPDATE app.memberships SET roles = '{agent}' WHERE id = $1`, [
      marketer.membership.id,
    ]);
    expect(await send(c, later(sendAt, 0.01))).toMatchObject({ sent: 1, stopped: 2 });
    expect((await reportEmails(c)).map((e) => e.to)).toEqual([c.owner.email]);
    expect((await rows(c)).map((r) => r.membership_id)).toEqual([owner.membership.id]);
  });

  it('skips an email more than 72 hours late, and tries a failing company once an hour', async () => {
    const { c, sendAt } = await companyWithWeeklyEmails();
    const tooLate = later(sendAt, 73);
    expect(await send(c, tooLate)).toMatchObject({ sent: 0, late: 2, reports: 0 });
    expect(await reportEmails(c)).toEqual([]);
    for (const row of await rows(c)) {
      expect(row).toMatchObject({
        next_send_at: nextReportEmailAt('weekly', IST, tooLate),
        attempted_at: tooLate,
        last_sent_at: null,
      });
    }

    // An attempt that failed after it started (the row is still due) is signalled again only an
    // hour after it started.
    await fx.query(
      `UPDATE app.report_email_subscriptions SET next_send_at = $2, attempted_at = $3
        WHERE tenant_id = $1`,
      [c.tenant.id, later(tooLate, -1), tooLate],
    );
    expect(await due(c, later(tooLate, 0.5))).toBe(false);
    expect(await due(c, later(tooLate, 1))).toBe(true);
  });

  it('never emails a period twice, and waits while the company is not active', async () => {
    const { c, sendAt } = await companyWithWeeklyEmails();
    const period = reportEmailPeriod('weekly', IST, sendAt);
    // The week was emailed already (the company's time zone moved west since it was scheduled).
    await fx.query(
      `UPDATE app.report_email_subscriptions
          SET last_period_from = $2, last_period_to = $3, last_sent_at = $4 WHERE tenant_id = $1`,
      [c.tenant.id, period.from, period.to, later(sendAt, -24)],
    );
    expect(await send(c, later(sendAt, 0.01))).toMatchObject({ sent: 0, repeated: 2 });
    expect(await reportEmails(c)).toEqual([]);
    for (const row of await rows(c)) expect(row.next_send_at).toEqual(later(sendAt, 7 * 24));

    // A suspended company is not signalled until it is active again.
    const nextWeek = later(sendAt, 7 * 24 + 0.01);
    await fx.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [c.tenant.id]);
    expect(await due(c, nextWeek)).toBe(false);
    await fx.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [c.tenant.id]);
    expect(await due(c, nextWeek)).toBe(true);
    expect(await send(c, nextWeek)).toMatchObject({ sent: 2, repeated: 0 });
  });
});
