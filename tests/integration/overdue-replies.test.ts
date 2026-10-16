import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, type Clock } from '@w360/core';
import {
  createBusinessHoursService,
  createEmailPreferencesService,
  createInboxService,
  createTeamsService,
  noticeOverdueReplies,
  outboxAad,
  queueTextMessage,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Emails when a waiting customer's reply is overdue (ADR-230) against real PostgreSQL: the definer
 * sweep query, the company-scoped pass with its row locks, the notices that make each reply turn
 * emailed at most once, and the outbox. Customer messages take the database's time, so each sweep
 * is given a later "now" instead of waiting. The sweep reads every company's turns; assertions
 * read only this file's companies.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const MINUTE = 60_000;
const at = (when: Date): Clock => ({ now: () => when });
const sweep = (when: Date) =>
  noticeOverdueReplies({ db: fx.dbs.app, clock: at(when), ...fx.notices() }, 500);
const later = (from: Date, minutes: number) => new Date(from.getTime() + minutes * MINUTE);

/** A company with a reply target of `minutes`. */
async function companyWithTarget(minutes = 30) {
  const c = await fx.company();
  const owner = await fx.ctx(c, c.owner);
  await createInboxService({ db: fx.dbs.app, clock: systemClock }).updateResponseTarget(owner, {
    minutes,
  });
  return { c, owner };
}

/** A customer writes; the reply turn their message opened. */
async function waitingCustomer(c: Company, waId: string) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId, text: 'Where is my order?' }] }));
  const [turn] = await fx.query<{ id: string; conversation_id: string; started_at: Date }>(
    `SELECT id, conversation_id, started_at FROM app.conversation_turns
      WHERE tenant_id = $1 AND ended_at IS NULL ORDER BY started_at DESC, id DESC LIMIT 1`,
    [c.tenant.id],
  );
  return turn!;
}

const notice = async (turnId: string) =>
  (
    await fx.query<{
      state: string;
      due_at: Date;
      emailed: number;
      skip_reason: string | null;
    }>(
      `SELECT state, due_at, emailed, skip_reason FROM app.overdue_reply_notices WHERE turn_id = $1`,
      [turnId],
    )
  )[0];

/** The company's overdue reply emails in the outbox, by recipient. */
async function overdueEmails(tenantId: string) {
  const rows = await fx.query<{ id: string; to_address: string; payload_ciphertext: string }>(
    `SELECT id, to_address, payload_ciphertext FROM ops.email_outbox
      WHERE tenant_id = $1 AND dedupe_key LIKE 'reply-overdue:%' ORDER BY to_address, id`,
    [tenantId],
  );
  return rows.map((r) => ({
    to: r.to_address,
    ...(JSON.parse(fx.keyring.decryptString(r.payload_ciphertext, outboxAad(r.id))) as {
      kind: string;
      companyName: string;
      subject: string;
      lines: string[];
      url: string;
      actionLabel: string;
    }),
  }));
}

describe('emails when a waiting customer’s reply is overdue (ADR-230)', () => {
  it('emails the member it is assigned to once the reply is overdue, once per waiting turn', async () => {
    const { c } = await companyWithTarget(30);
    const agent = await fx.ctx(c, c.agent);
    const turn = await waitingCustomer(c, '919845100001');
    await fx.query(
      `UPDATE app.conversations SET assigned_membership_id = $1 WHERE tenant_id = $2 AND id = $3`,
      [agent.membership.id, c.tenant.id, turn.conversation_id],
    );

    // Not due yet: not even looked at.
    await sweep(later(turn.started_at, 29));
    expect(await notice(turn.id)).toBeUndefined();
    expect(await overdueEmails(c.tenant.id)).toEqual([]);

    await sweep(later(turn.started_at, 31));
    expect(await notice(turn.id)).toEqual({
      state: 'sent',
      due_at: later(turn.started_at, 30),
      emailed: 1,
      skip_reason: null,
    });
    const [email, ...others] = await overdueEmails(c.tenant.id);
    expect(others).toEqual([]);
    expect(email).toMatchObject({
      to: c.agent.email,
      kind: 'tenant.notice',
      subject: 'A customer is waiting past your reply target',
      url: `http://localhost:3000/c/${c.tenant.slug}/inbox/${turn.conversation_id}`,
      actionLabel: 'Open conversation',
    });
    expect(email!.lines[0]).toBe(
      'A customer has waited longer than your company’s reply target of 30 minutes, in a conversation assigned to you.',
    );
    // Never the customer: neither their number nor their message.
    expect(JSON.stringify(email)).not.toContain('919845100001');
    expect(JSON.stringify(email)).not.toContain('Where is my order');

    // Later sweeps send nothing more for the same wait.
    await sweep(later(turn.started_at, 45));
    expect(await overdueEmails(c.tenant.id)).toHaveLength(1);

    // Once a member replies the wait is over; the customer's next message starts a new one.
    const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
    await queueTextMessage(deps, agent, {
      conversationId: turn.conversation_id,
      text: 'Checking now',
      clientKey: `overdue-${turn.id}`,
    });
    const next = await waitingCustomer(c, '919845100001');
    expect(next.id).not.toBe(turn.id);
    await sweep(later(next.started_at, 31));
    expect(await notice(next.id)).toMatchObject({ state: 'sent', emailed: 1 });
    expect(await overdueEmails(c.tenant.id)).toHaveLength(2);
  });

  it('sends nothing for a customer a member answered in time', async () => {
    const { c, owner } = await companyWithTarget(30);
    const turn = await waitingCustomer(c, '919845100002');
    const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
    await queueTextMessage(deps, owner, {
      conversationId: turn.conversation_id,
      text: 'On its way',
      clientKey: `answered-${turn.id}`,
    });
    await sweep(later(turn.started_at, 31));
    expect(await notice(turn.id)).toBeUndefined();
    expect(await overdueEmails(c.tenant.id)).toEqual([]);
  });

  it('emails the team when nobody has taken it, else the members who assign, one email each', async () => {
    const { c, owner } = await companyWithTarget(60);
    const agent = await fx.ctx(c, c.agent);
    const { teamId } = await createTeamsService({ db: fx.dbs.app, clock: systemClock }).createTeam(
      owner,
      { name: 'Returns', memberIds: [agent.membership.id] },
    );
    const forTeam = await waitingCustomer(c, '919845100003');
    await fx.query(`UPDATE app.conversations SET team_id = $1 WHERE tenant_id = $2 AND id = $3`, [
      teamId,
      c.tenant.id,
      forTeam.conversation_id,
    ]);
    const first = await waitingCustomer(c, '919845100004');
    const second = await waitingCustomer(c, '919845100005');

    await sweep(later(second.started_at, 61));
    for (const turn of [forTeam, first, second]) {
      expect(await notice(turn.id)).toMatchObject({ state: 'sent', emailed: 1 });
    }
    const emails = await overdueEmails(c.tenant.id);
    expect(emails.map((e) => e.to).sort()).toEqual([c.agent.email, c.owner.email].sort());
    const toAgent = emails.find((e) => e.to === c.agent.email)!;
    expect(toAgent.subject).toBe('A customer is waiting past your reply target');
    expect(toAgent.lines[0]).toBe(
      'A customer has waited longer than your company’s reply target of 1 hour, in a conversation for the Returns team that nobody has taken yet.',
    );
    // The owner assigns conversations: both customers without a team, in one email.
    const toOwner = emails.find((e) => e.to === c.owner.email)!;
    expect(toOwner).toMatchObject({
      subject: '2 customers are waiting past your reply target',
      url: `http://localhost:3000/c/${c.tenant.slug}/inbox?view=all&status=open&order=waiting`,
      actionLabel: 'Open the inbox',
    });
    expect(toOwner.lines[1]).toBe('Their conversations: 2 not taken by a member who can reply.');
  });

  it('holds a conversation to its team’s own target, even when the company has none (ADR-377)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const { teamId } = await createTeamsService({ db: fx.dbs.app, clock: systemClock }).createTeam(
      owner,
      { name: 'Returns', memberIds: [agent.membership.id], firstResponseTargetMinutes: '10' },
    );
    const forTeam = await waitingCustomer(c, '919845100201');
    await fx.query(`UPDATE app.conversations SET team_id = $1 WHERE tenant_id = $2 AND id = $3`, [
      teamId,
      c.tenant.id,
      forTeam.conversation_id,
    ]);
    const noTeam = await waitingCustomer(c, '919845100202');

    await sweep(later(forTeam.started_at, 9));
    expect(await notice(forTeam.id)).toBeUndefined();
    await sweep(later(forTeam.started_at, 11));
    expect(await notice(forTeam.id)).toEqual({
      state: 'sent',
      due_at: later(forTeam.started_at, 10),
      emailed: 1,
      skip_reason: null,
    });
    const [email, ...others] = await overdueEmails(c.tenant.id);
    expect(others).toEqual([]);
    expect(email).toMatchObject({
      to: c.agent.email,
      subject: 'A customer is waiting past your reply target',
    });
    expect(email!.lines[0]).toBe(
      'A customer has waited longer than the Returns team’s reply target of 10 minutes, in a conversation for the Returns team that nobody has taken yet.',
    );
    // Without a team, the company's target applies, and it has none: nothing is due.
    await sweep(later(noTeam.started_at, 120));
    expect(await notice(noTeam.id)).toBeUndefined();

    // Once the company has a target, the customer without a team is due against it.
    await createInboxService({ db: fx.dbs.app, clock: systemClock }).updateResponseTarget(owner, {
      minutes: 30,
    });
    await sweep(later(noTeam.started_at, 29));
    expect(await notice(noTeam.id)).toBeUndefined();
    await sweep(later(noTeam.started_at, 31));
    expect(await notice(noTeam.id)).toMatchObject({
      state: 'sent',
      due_at: later(noTeam.started_at, 30),
    });
    const toOwner = (await overdueEmails(c.tenant.id)).find((e) => e.to === c.owner.email);
    expect(toOwner?.lines[0]).toBe(
      'A customer has waited longer than your company’s reply target of 30 minutes, in a conversation that no member who can reply has taken.',
    );
  });

  it('skips a wait whose members all turned these emails off, and one due more than a day ago', async () => {
    const { c } = await companyWithTarget(30);
    const agent = await fx.ctx(c, c.agent);
    await createEmailPreferencesService({ db: fx.dbs.app }).updateEmailPreferences(agent, {
      off: ['reply_overdue'],
    });
    const turn = await waitingCustomer(c, '919845100006');
    await fx.query(
      `UPDATE app.conversations SET assigned_membership_id = $1 WHERE tenant_id = $2 AND id = $3`,
      [agent.membership.id, c.tenant.id, turn.conversation_id],
    );
    await sweep(later(turn.started_at, 31));
    expect(await notice(turn.id)).toMatchObject({ state: 'skipped', skip_reason: 'opted_out' });
    expect(await overdueEmails(c.tenant.id)).toEqual([]);

    const { c: late } = await companyWithTarget(30);
    const stale = await waitingCustomer(late, '919845100007');
    await sweep(later(stale.started_at, 30 + 25 * 60));
    expect(await notice(stale.id)).toEqual({
      state: 'skipped',
      due_at: later(stale.started_at, 30),
      emailed: 0,
      skip_reason: 'too_late',
    });
    expect(await overdueEmails(late.tenant.id)).toEqual([]);
  });

  it('waits for business hours: a reply due when the business opens again is emailed then', async () => {
    const { c, owner } = await companyWithTarget(30);
    const hours = createBusinessHoursService({ db: fx.dbs.app, clock: systemClock });
    await hours.updateBusinessHours(owner, { enabled: true, days: Array(7).fill('00:00-24:00') });
    const [{ timezone }] = (await fx.query<{ timezone: string }>(
      'SELECT timezone FROM app.tenants WHERE id = $1',
      [c.tenant.id],
    )) as [{ timezone: string }];
    const localDay = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    const turn = await waitingCustomer(c, '919845100008');
    // Closed the day the customer wrote and the next (the company's dates), so the reply is due
    // 30 minutes after the business opens the day after.
    const today = localDay(turn.started_at);
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    await hours.addHoliday(owner, { day: today, name: 'Closed' });
    await hours.addHoliday(owner, { day: tomorrow, name: 'Closed' });

    await sweep(later(turn.started_at, 31));
    const waiting = await notice(turn.id);
    expect(waiting).toMatchObject({ state: 'waiting', emailed: 0, skip_reason: null });
    expect(waiting!.due_at.getTime()).toBeGreaterThan(later(turn.started_at, 24 * 60).getTime());
    expect(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(waiting!.due_at),
    ).toBe('00:30');
    expect(await overdueEmails(c.tenant.id)).toEqual([]);

    // Not looked at again before its due time.
    await sweep(new Date(waiting!.due_at.getTime() - MINUTE));
    expect(await notice(turn.id)).toMatchObject({ state: 'waiting' });

    await sweep(new Date(waiting!.due_at.getTime() + MINUTE));
    expect(await notice(turn.id)).toMatchObject({
      state: 'sent',
      due_at: waiting!.due_at,
      emailed: 1,
    });
    const [email] = await overdueEmails(c.tenant.id);
    expect(email!.lines[0]).toContain('reply target of 30 minutes of business hours');
  });

  it('counts a team’s conversations in its own business hours, planned again when they change (ADR-389)', async () => {
    const { c, owner } = await companyWithTarget(30);
    const hours = createBusinessHoursService({ db: fx.dbs.app, clock: systemClock });
    await hours.updateBusinessHours(owner, { enabled: true, days: Array(7).fill('00:00-24:00') });
    const [{ timezone }] = (await fx.query<{ timezone: string }>(
      'SELECT timezone FROM app.tenants WHERE id = $1',
      [c.tenant.id],
    )) as [{ timezone: string }];
    const localDay = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    const hhmm = (d: Date) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(d);
    const forTeam = await waitingCustomer(c, '919845100401');
    const noTeam = await waitingCustomer(c, '919845100402');
    // The team opens only the day after tomorrow (the company's dates).
    const [y, m, d] = localDay(forTeam.started_at).split('-').map(Number) as [
      number,
      number,
      number,
    ];
    const inTwoDays = new Date(Date.UTC(y, m - 1, d + 2));
    const weekdayIndex = (inTwoDays.getUTCDay() + 6) % 7;
    const teams = createTeamsService({ db: fx.dbs.app, clock: systemClock });
    const teamWeek = Array.from({ length: 7 }, (_, i) => (i === weekdayIndex ? '00:00-24:00' : ''));
    const { teamId } = await teams.createTeam(owner, { name: 'Later', businessHours: teamWeek });
    await fx.query(`UPDATE app.conversations SET team_id = $1 WHERE tenant_id = $2 AND id = $3`, [
      teamId,
      c.tenant.id,
      forTeam.conversation_id,
    ]);

    await sweep(later(noTeam.started_at, 31));
    // The company's conversation is due by the company's hours (open all week).
    expect(await notice(noTeam.id)).toMatchObject({
      state: 'sent',
      due_at: later(noTeam.started_at, 30),
    });
    // The team's waits for its hours: 30 minutes after it opens the day after tomorrow.
    const waiting = await notice(forTeam.id);
    expect(waiting).toMatchObject({ state: 'waiting', emailed: 0 });
    expect(localDay(waiting!.due_at)).toBe(inTwoDays.toISOString().slice(0, 10));
    expect(hhmm(waiting!.due_at)).toBe('00:30');

    // The team gives up its own hours: the waiting notice is planned again by the company's, and
    // the next sweep emails it, not late for having waited.
    await teams.updateTeam(owner, teamId, { name: 'Later', businessHours: null });
    expect((await notice(forTeam.id))!.due_at.getTime()).toBeLessThan(waiting!.due_at.getTime());
    await sweep(later(forTeam.started_at, 32));
    expect(await notice(forTeam.id)).toMatchObject({
      state: 'sent',
      due_at: later(forTeam.started_at, 30),
    });
  });

  it('plans a waiting notice again when its conversation changes team (ADR-389)', async () => {
    const { c, owner } = await companyWithTarget(30);
    const hours = createBusinessHoursService({ db: fx.dbs.app, clock: systemClock });
    await hours.updateBusinessHours(owner, { enabled: true, days: Array(7).fill('00:00-24:00') });
    const teams = createTeamsService({ db: fx.dbs.app, clock: systemClock });
    // A team never open on the day the customer writes nor the next: open on one other weekday.
    const turn = await waitingCustomer(c, '919845100403');
    const [{ timezone }] = (await fx.query<{ timezone: string }>(
      'SELECT timezone FROM app.tenants WHERE id = $1',
      [c.tenant.id],
    )) as [{ timezone: string }];
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(turn.started_at);
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const weekdayIndex = (new Date(Date.UTC(y, m - 1, d + 2)).getUTCDay() + 6) % 7;
    const { teamId } = await teams.createTeam(owner, {
      name: 'Later',
      businessHours: Array.from({ length: 7 }, (_, i) => (i === weekdayIndex ? '00:00-24:00' : '')),
    });
    const inbox = createInboxService({ db: fx.dbs.app, clock: systemClock });
    const version = async () =>
      (
        await fx.query<{ version: number }>(`SELECT version FROM app.conversations WHERE id = $1`, [
          turn.conversation_id,
        ])
      )[0]!.version;
    await inbox.setTeam(owner, {
      conversationId: turn.conversation_id,
      teamId,
      expectedVersion: await version(),
    });
    await sweep(later(turn.started_at, 31));
    const waiting = await notice(turn.id);
    expect(waiting).toMatchObject({ state: 'waiting' });
    // Back to no team: planned again (the database's time), then emailed by the company's hours.
    await inbox.setTeam(owner, {
      conversationId: turn.conversation_id,
      teamId: null,
      expectedVersion: await version(),
    });
    expect((await notice(turn.id))!.due_at.getTime()).toBeLessThan(waiting!.due_at.getTime());
    await sweep(later(turn.started_at, 32));
    expect(await notice(turn.id)).toMatchObject({ state: 'sent' });
  });

  it('lets only the runtime role run the sweep query, and keeps sent notices as they are', async () => {
    const [fn] = await fx.query<{ public: boolean; app: boolean; owner: string; definer: boolean }>(
      `SELECT has_function_privilege('public', p.oid, 'EXECUTE') AS public,
              has_function_privilege('w360_app', p.oid, 'EXECUTE') AS app,
              pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer
         FROM pg_proc p WHERE p.oid = 'ops.overdue_reply_turns(timestamptz,integer)'::regprocedure`,
    );
    expect(fn).toEqual({ public: false, app: true, owner: 'w360_definer', definer: true });

    const { c } = await companyWithTarget(30);
    const turn = await waitingCustomer(c, '919845100009');
    await sweep(later(turn.started_at, 31));
    expect(await notice(turn.id)).toMatchObject({ state: 'sent' });
    await expect(
      fx.query(`UPDATE app.overdue_reply_notices SET state = 'waiting' WHERE turn_id = $1`, [
        turn.id,
      ]),
    ).rejects.toThrow(/cannot change/);
  });
});

describe('the inbox’s notice of overdue replies (ADR-241)', () => {
  it('gives the reply due times of the waits a member can see, earliest first, and none without a target', async () => {
    const { c, owner } = await companyWithTarget(30);
    const inbox = createInboxService({ db: fx.dbs.app, clock: systemClock });
    const agent = await fx.ctx(c, c.agent);
    const first = await waitingCustomer(c, '919845100101');
    const second = await waitingCustomer(c, '919845100102');
    const third = await waitingCustomer(c, '919845100103');
    const assign = (turn: { conversation_id: string }, membershipId: string) =>
      fx.query(
        `UPDATE app.conversations SET assigned_membership_id = $1 WHERE tenant_id = $2 AND id = $3`,
        [membershipId, c.tenant.id, turn.conversation_id],
      );
    // The first is the agent's, the second the owner's, the third nobody's.
    await assign(first, agent.membership.id);
    await assign(second, owner.membership.id);
    const due = (turn: { started_at: Date }) => later(turn.started_at, 30).toISOString();

    // Only times and whose they are: the owner sees all three, the agent their own and the queue's.
    expect(await inbox.waitingReplies(owner)).toEqual({
      waits: [
        { dueAt: due(first), mine: false },
        { dueAt: due(second), mine: true },
        { dueAt: due(third), mine: false },
      ],
      capped: false,
    });
    expect(await inbox.waitingReplies(agent)).toEqual({
      waits: [
        { dueAt: due(first), mine: true },
        { dueAt: due(third), mine: false },
      ],
      capped: false,
    });

    // A resolved conversation waits for nobody.
    await fx.query(
      `UPDATE app.conversations SET status = 'resolved' WHERE tenant_id = $1 AND id = $2`,
      [c.tenant.id, third.conversation_id],
    );
    expect((await inbox.waitingReplies(agent)).waits).toEqual([{ dueAt: due(first), mine: true }]);

    // Members without the inbox and other companies get none.
    expect(await inbox.waitingReplies(await fx.ctx(c, c.marketer))).toEqual({
      waits: [],
      capped: false,
    });
    const other = await companyWithTarget(30);
    expect(await inbox.waitingReplies(other.owner)).toEqual({ waits: [], capped: false });

    // Without a first-response target, nothing is due.
    await inbox.updateResponseTarget(owner, { minutes: null });
    expect(await inbox.waitingReplies(owner)).toEqual({ waits: [], capped: false });
  });

  it('gives each wait its team’s own target, the earliest due first (ADR-377)', async () => {
    const { c, owner } = await companyWithTarget(60);
    const inbox = createInboxService({ db: fx.dbs.app, clock: systemClock });
    const { teamId } = await createTeamsService({ db: fx.dbs.app, clock: systemClock }).createTeam(
      owner,
      { name: 'Priority', firstResponseTargetMinutes: '5' },
    );
    const noTeam = await waitingCustomer(c, '919845100301');
    const priority = await waitingCustomer(c, '919845100302');
    await fx.query(`UPDATE app.conversations SET team_id = $1 WHERE tenant_id = $2 AND id = $3`, [
      teamId,
      c.tenant.id,
      priority.conversation_id,
    ]);
    const priorityDue = later(priority.started_at, 5).toISOString();
    const noTeamDue = later(noTeam.started_at, 60).toISOString();
    // The later customer is due first: their team's target is shorter.
    expect(await inbox.waitingReplies(owner)).toEqual({
      waits: [
        { dueAt: priorityDue, mine: false },
        { dueAt: noTeamDue, mine: false },
      ],
      capped: false,
    });
    // The inbox's list and the conversation give the same due times.
    const items = (await inbox.listConversations(owner, {})).items;
    expect(items.find((i) => i.id === priority.conversation_id)?.replyDueAt).toBe(priorityDue);
    expect(items.find((i) => i.id === noTeam.conversation_id)?.replyDueAt).toBe(noTeamDue);
    const detail = await inbox.getConversation(owner, priority.conversation_id);
    expect(detail.conversation.replyDueAt).toBe(priorityDue);
    // Without the company's target, only the team's customer is due.
    await inbox.updateResponseTarget(owner, { minutes: null });
    expect(await inbox.waitingReplies(owner)).toEqual({
      waits: [{ dueAt: priorityDue, mine: false }],
      capped: false,
    });
  });
});
