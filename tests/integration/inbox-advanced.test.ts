import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '@w360/contracts';
import { isAppError, systemClock, type Clock } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  MENTION_EMAIL_DELAY_MS,
  MENTION_EMAIL_LATE_LIMIT_MS,
  createBusinessHoursService,
  createEmailPreferencesService,
  createInboxService,
  createSavedRepliesService,
  createTeamsService,
  createTenancyService,
  mentionEmailNotice,
  outboxAad,
  queueTextMessage,
  routeDueConversations,
  sendMentionEmail,
  transcriptTime,
  type TenantContext,
} from '@w360/domain';
import { acceptInvitation, createUser, invite, type TestUser } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Inbox teams and routing, saved replies, mentions and collision warnings against real PostgreSQL:
 * number and keyword routing, round robin with availability and limits, the minute sweep, release
 * when a member leaves, concurrent routing, conversation cases, the inbox list filters and reply
 * timers, and company isolation.
 */
let fx: WhatsAppFixture;
beforeAll(async () => {
  fx = await startWhatsAppFixture();
});
afterAll(async () => {
  await fx?.close();
});

const teamsService = () => createTeamsService({ db: fx.dbs.app, clock: systemClock });
const inboxService = () =>
  createInboxService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.publicMessage).toMatch(message);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

interface Setup {
  c: Company;
  owner: TenantContext;
  agents: { user: TestUser; membershipId: string; ctx: TenantContext }[];
}

async function setup(extraAgents = 2): Promise<Setup> {
  const c = await fx.company();
  const owner = await fx.ctx(c, c.owner);
  const first = await fx.ctx(c, c.agent);
  const agents = [{ user: c.agent, membershipId: first.membership.id, ctx: first }];
  for (let i = 0; i < extraAgents; i += 1) {
    const user = await createUser(fx.dbs, { name: `Agent ${String.fromCharCode(66 + i)}` });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, ['agent']);
    await acceptInvitation(fx.dbs, user, token);
    const ctx = await fx.ctx(c, user);
    agents.push({ user, membershipId: ctx.membership.id, ctx });
  }
  return { c, owner, agents };
}

async function inbound(c: Company, from: string, text = 'Hello') {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, text }] }));
  const [row] = await fx.query<{ id: string; team_id: string | null; assigned: string | null }>(
    `SELECT cv.id, cv.team_id, cv.assigned_membership_id AS assigned
       FROM app.conversations cv
       JOIN app.contact_identities i ON i.tenant_id = cv.tenant_id AND i.contact_id = cv.contact_id
      WHERE cv.tenant_id = $1 AND i.wa_id = $2`,
    [c.tenant.id, from],
  );
  if (!row) throw new Error('conversation not created');
  return row;
}

async function conversation(id: string) {
  const [row] = await fx.query<{
    team_id: string | null;
    assigned: string | null;
    status: string;
    version: number;
  }>(
    `SELECT team_id, assigned_membership_id AS assigned, status, version
       FROM app.conversations WHERE id = $1`,
    [id],
  );
  if (!row) throw new Error('missing conversation');
  return row;
}

describe('teams', () => {
  it('are managed by supervisors, with validated members, numbers and keywords', async () => {
    const { c, owner, agents } = await setup(1);
    const teams = teamsService();
    const marketer = await fx.ctx(c, c.marketer);
    const marketerId = marketer.membership.id;

    await expectAppError(teams.createTeam(agents[0]!.ctx, { name: 'Support' }), 'forbidden');
    await expectAppError(
      teams.createTeam(owner, { name: 'Support', memberIds: [marketerId] }),
      'validation_failed',
      /can reply in the inbox/,
    );
    const { teamId } = await teams.createTeam(owner, {
      name: 'Support',
      description: 'First line',
      assignment: 'round_robin',
      maxOpenPerMember: '3',
      routingKeywords: 'Help, WHERE IS my order?\nhelp',
      memberIds: agents.map((a) => a.membershipId),
      channelIds: [c.channelAccountId],
    });
    await expectAppError(teams.createTeam(owner, { name: ' support ' }), 'conflict', /name/);
    await expectAppError(
      teams.createTeam(owner, { name: 'Sales', maxOpenPerMember: 0 }),
      'validation_failed',
    );

    const [team] = await teams.listTeams(agents[0]!.ctx);
    expect(team).toMatchObject({
      id: teamId,
      name: 'Support',
      description: 'First line',
      assignment: 'round_robin',
      maxOpenPerMember: 3,
      routingKeywords: ['help', 'where is my order'],
      channelIds: [c.channelAccountId],
      openConversations: 0,
    });
    expect(team?.members.map((m) => m.membershipId).sort()).toEqual(
      agents.map((a) => a.membershipId).sort(),
    );

    // Moving the number to another team takes it from the first one.
    const { teamId: salesId } = await teams.createTeam(owner, {
      name: 'Sales',
      channelIds: [c.channelAccountId],
    });
    const listed = await teams.listTeams(owner);
    expect(listed.find((t) => t.id === teamId)?.channelIds).toEqual([]);
    expect(listed.find((t) => t.id === salesId)?.channelIds).toEqual([c.channelAccountId]);

    const audit = await fx.query<{ action: string }>(
      `SELECT action FROM app.audit_events WHERE tenant_id = $1 AND action LIKE 'team.%' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(audit.map((a) => a.action)).toEqual(['team.created', 'team.created']);
  });

  it('are deleted with their conversations leaving the team', async () => {
    const { c, owner } = await setup(0);
    const teams = teamsService();
    const { teamId } = await teams.createTeam(owner, {
      name: 'Night shift',
      channelIds: [c.channelAccountId],
    });
    const conv = await inbound(c, waId());
    expect(conv.team_id).toBe(teamId);
    await teams.deleteTeam(owner, teamId);
    expect((await conversation(conv.id)).team_id).toBeNull();
    expect(await teams.listTeams(owner)).toEqual([]);
    const [channel] = await fx.query<{ default_team_id: string | null }>(
      `SELECT default_team_id FROM app.channel_accounts WHERE id = $1`,
      [c.channelAccountId],
    );
    expect(channel?.default_team_id).toBeNull();
    await expectAppError(teams.deleteTeam(owner, teamId), 'not_found');
  });
});

describe('business hours per team (ADR-389)', () => {
  const week = ['09:00-13:00, 14:00-18:00', '', '', '', '', '10:00-14:00', ''];

  it('are set with the team by supervisors, checked, audited, and go with the team', async () => {
    const { c, owner, agents } = await setup(0);
    const teams = teamsService();
    await expectAppError(
      teams.createTeam(agents[0]!.ctx, { name: 'Night', businessHours: week }),
      'forbidden',
    );
    await expectAppError(
      teams.createTeam(owner, { name: 'Night', businessHours: ['', '', '', '', '', '', ''] }),
      'validation_failed',
      /at least one opening time/,
    );
    try {
      await teams.createTeam(owner, {
        name: 'Night',
        businessHours: ['', '', '18:00-09:00', '', '', '', ''],
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isAppError(error) && error.issues?.map((i) => i.path)).toEqual(['businessHours.2']);
    }
    const { teamId } = await teams.createTeam(owner, { name: 'Night', businessHours: week });
    const listed = async () => (await teams.listTeams(agents[0]!.ctx)).find((t) => t.id === teamId);
    expect((await listed())?.businessHours).toEqual([
      { weekday: 1, opens: 540, closes: 780 },
      { weekday: 1, opens: 840, closes: 1080 },
      { weekday: 6, opens: 600, closes: 840 },
    ]);
    // A team without its own uses the company's.
    const { teamId: salesId } = await teams.createTeam(owner, { name: 'Sales' });
    expect((await teams.listTeams(owner)).find((t) => t.id === salesId)?.businessHours).toBeNull();

    const base = { name: 'Night' };
    await teams.updateTeam(owner, teamId, { ...base, businessHours: week });
    await teams.updateTeam(owner, teamId, {
      ...base,
      businessHours: ['', '', '', '', '', '', '00:00-24:00'],
    });
    expect((await listed())?.businessHours).toEqual([{ weekday: 7, opens: 0, closes: 1440 }]);
    await teams.updateTeam(owner, teamId, { ...base, businessHours: null });
    expect((await listed())?.businessHours).toBeNull();
    const rows = () =>
      fx.query<{ team_id: string }>(
        `SELECT team_id FROM app.team_business_hours WHERE tenant_id = $1`,
        [c.tenant.id],
      );
    expect(await rows()).toEqual([]);

    const audit = await fx.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 ORDER BY occurred_at, id`,
      [c.tenant.id, teamId],
    );
    expect(
      audit.map((a) => [
        a.action,
        a.metadata.ownBusinessHours,
        a.metadata.businessHoursRanges,
        a.metadata.businessHoursChanged,
      ]),
    ).toEqual([
      ['team.created', true, 3, undefined],
      ['team.updated', true, 3, false],
      ['team.updated', true, 1, true],
      ['team.updated', false, 0, true],
    ]);

    // Deleting the team deletes its hours.
    await teams.updateTeam(owner, teamId, { ...base, businessHours: week });
    expect(await rows()).toHaveLength(3);
    await teams.deleteTeam(owner, teamId);
    expect(await rows()).toEqual([]);
  });

  it('are kept apart per company, with least-privilege grants and team keys of the company', async () => {
    const { c, owner } = await setup(0);
    const other = await fx.company();
    const { teamId } = await teamsService().createTeam(owner, {
      name: 'Night',
      businessHours: week,
    });
    const [table] = await fx.query<{ rls: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
        WHERE oid = 'app.team_business_hours'::regclass`,
    );
    expect(table).toEqual({ rls: true, forced: true });
    const [grants] = await fx.query<Record<string, boolean>>(
      `SELECT has_table_privilege('w360_app', 'app.team_business_hours', 'SELECT') AS app_select,
              has_table_privilege('w360_app', 'app.team_business_hours', 'INSERT') AS app_insert,
              has_table_privilege('w360_app', 'app.team_business_hours', 'DELETE') AS app_delete,
              has_table_privilege('w360_app', 'app.team_business_hours', 'UPDATE') AS app_update,
              has_table_privilege('public', 'app.team_business_hours', 'SELECT') AS public_select,
              has_table_privilege('w360_definer', 'app.team_business_hours', 'INSERT') AS definer_insert`,
    );
    expect(grants).toEqual({
      app_select: true,
      app_insert: true,
      app_delete: true,
      app_update: false,
      public_select: false,
      definer_insert: false,
    });
    const [trigger] = await fx.query<{ public: boolean }>(
      `SELECT has_function_privilege('public', 'app.replan_waiting_turn_on_team_change()', 'EXECUTE') AS public`,
    );
    expect(trigger).toEqual({ public: false });
    // Another company sees none of them, and cannot give its rows this company's team.
    const seen = await fx.dbs.app.run(authorizedTenantScope(other.tenant.id, null), (tx) =>
      tx.execute(sql`SELECT id FROM app.team_business_hours`),
    );
    expect(seen.rows).toEqual([]);
    await expect(
      fx.query(
        `INSERT INTO app.team_business_hours (id, tenant_id, team_id, weekday, opens_at, closes_at)
         VALUES (gen_random_uuid(), $1, $2, 1, '09:00', '17:00')`,
        [other.tenant.id, teamId],
      ),
    ).rejects.toThrow(/team_business_hours_team_fk/);
    await expect(
      fx.query(
        `INSERT INTO app.team_business_hours (id, tenant_id, team_id, weekday, opens_at, closes_at)
         VALUES (gen_random_uuid(), $1, $2, 1, '17:00', '09:00')`,
        [c.tenant.id, teamId],
      ),
    ).rejects.toThrow(/team_business_hours_order/);
  });

  it('give the inbox’s timers the team’s hours while business hours are on, and the company’s otherwise', async () => {
    const { c, owner } = await setup(0);
    const inbox = inboxService();
    await inbox.updateResponseTarget(owner, { minutes: 30 });
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
    const conv = await inbound(c, waId());
    const [turn] = await fx.query<{ started_at: Date }>(
      `SELECT started_at FROM app.conversation_turns WHERE conversation_id = $1 AND ended_at IS NULL`,
      [conv.id],
    );
    // The team opens only the day after tomorrow (the company's dates).
    const [y, m, d] = localDay(turn!.started_at).split('-').map(Number) as [number, number, number];
    const inTwoDays = new Date(Date.UTC(y, m - 1, d + 2));
    const weekdayIndex = (inTwoDays.getUTCDay() + 6) % 7;
    const teamWeek = Array.from({ length: 7 }, (_, i) => (i === weekdayIndex ? '00:00-24:00' : ''));
    const { teamId } = await teamsService().createTeam(owner, {
      name: 'Later',
      businessHours: teamWeek,
    });
    const due = async () =>
      (await inbox.listConversations(owner, {})).items.find((i) => i.id === conv.id)?.replyDueAt;
    const companyDue = new Date(turn!.started_at.getTime() + 30 * 60_000).toISOString();
    expect(await due()).toBe(companyDue);
    await inbox.setTeam(owner, {
      conversationId: conv.id,
      teamId,
      expectedVersion: (await conversation(conv.id)).version,
    });
    const teamDue = await due();
    expect(teamDue && localDay(new Date(teamDue))).toBe(inTwoDays.toISOString().slice(0, 10));
    expect((await inbox.getConversation(owner, conv.id)).conversation.replyDueAt).toBe(teamDue);
    expect(await inbox.waitingReplies(owner)).toEqual({
      waits: [{ dueAt: teamDue, mine: false }],
      capped: false,
    });
    // Business hours off: absolute time for every conversation, the team's hours unused.
    await hours.updateBusinessHours(owner, { enabled: false, days: Array(7).fill('00:00-24:00') });
    expect(await due()).toBe(companyDue);
  });
});

describe('closed days per team (ADR-392)', () => {
  it('are set with the team by supervisors, checked, audited, written only when changed, and go with the team', async () => {
    const { c, owner, agents } = await setup(0);
    const teams = teamsService();
    await expectAppError(
      teams.createTeam(agents[0]!.ctx, { name: 'Holidays', closedDays: [] }),
      'forbidden',
    );
    try {
      await teams.createTeam(owner, { name: 'Holidays', closedDays: ['2026-12-25', '2026-02-30'] });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isAppError(error) && error.issues?.map((i) => i.path)).toEqual(['closedDays.1']);
    }
    await expectAppError(
      teams.createTeam(owner, {
        name: 'Holidays',
        closedDays: Array.from({ length: 367 }, () => '2026-12-25'),
      }),
      'validation_failed',
      /at most 366 closed days/,
    );
    const { teamId } = await teams.createTeam(owner, {
      name: 'Holidays',
      closedDays: ['2026-12-25', '2026-11-08', '2026-12-25'],
    });
    const listed = async () => (await teams.listTeams(agents[0]!.ctx)).find((t) => t.id === teamId);
    expect((await listed())?.closedDays).toEqual(['2026-11-08', '2026-12-25']);
    // A team without its own list uses the company's.
    const { teamId: salesId } = await teams.createTeam(owner, { name: 'Sales' });
    expect((await teams.listTeams(owner)).find((t) => t.id === salesId)?.closedDays).toBeNull();
    const rows = () =>
      fx.query<{ id: string; team_id: string; day: string }>(
        `SELECT id, team_id, day::text AS day FROM app.team_closed_days
          WHERE tenant_id = $1 ORDER BY day`,
        [c.tenant.id],
      );
    const flag = async () =>
      (
        await fx.query<{ own_closed_days: boolean }>(
          `SELECT own_closed_days FROM app.teams WHERE id = $1`,
          [teamId],
        )
      )[0]?.own_closed_days;
    const before = await rows();
    expect(before.map((r) => r.day)).toEqual(['2026-11-08', '2026-12-25']);
    expect(await flag()).toBe(true);

    const base = { name: 'Holidays' };
    // The same days in another order: nothing is written (the rows keep their ids).
    await teams.updateTeam(owner, teamId, { ...base, closedDays: ['2026-12-25', '2026-11-08'] });
    expect(await rows()).toEqual(before);
    // An empty list of its own: the team works on every day its week opens.
    await teams.updateTeam(owner, teamId, { ...base, closedDays: [] });
    expect(await rows()).toEqual([]);
    expect((await listed())?.closedDays).toEqual([]);
    expect(await flag()).toBe(true);
    // Null: the company's closed days again.
    await teams.updateTeam(owner, teamId, { ...base, closedDays: null });
    expect((await listed())?.closedDays).toBeNull();
    expect(await flag()).toBe(false);

    const audit = await fx.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND subject_id = $2 ORDER BY occurred_at, id`,
      [c.tenant.id, teamId],
    );
    expect(
      audit.map((a) => [
        a.action,
        a.metadata.ownClosedDays,
        a.metadata.closedDays,
        a.metadata.closedDaysChanged,
      ]),
    ).toEqual([
      ['team.created', true, 2, undefined],
      ['team.updated', true, 2, false],
      ['team.updated', true, 0, true],
      ['team.updated', false, 0, true],
    ]);
    // The audit holds counts, never the days.
    expect(JSON.stringify(audit)).not.toContain('2026-11-08');

    // Deleting the team deletes its days.
    await teams.updateTeam(owner, teamId, { ...base, closedDays: ['2026-11-08'] });
    expect(await rows()).toHaveLength(1);
    await teams.deleteTeam(owner, teamId);
    expect(await rows()).toEqual([]);
  });

  it('are kept apart per company, with least-privilege grants and team keys of the company', async () => {
    const { c, owner } = await setup(0);
    const other = await fx.company();
    const { teamId } = await teamsService().createTeam(owner, {
      name: 'Holidays',
      closedDays: ['2026-11-08'],
    });
    const [table] = await fx.query<{ rls: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
        WHERE oid = 'app.team_closed_days'::regclass`,
    );
    expect(table).toEqual({ rls: true, forced: true });
    const [grants] = await fx.query<Record<string, boolean>>(
      `SELECT has_table_privilege('w360_app', 'app.team_closed_days', 'SELECT') AS app_select,
              has_table_privilege('w360_app', 'app.team_closed_days', 'INSERT') AS app_insert,
              has_table_privilege('w360_app', 'app.team_closed_days', 'DELETE') AS app_delete,
              has_table_privilege('w360_app', 'app.team_closed_days', 'UPDATE') AS app_update,
              has_table_privilege('public', 'app.team_closed_days', 'SELECT') AS public_select,
              has_table_privilege('w360_definer', 'app.team_closed_days', 'INSERT') AS definer_insert,
              has_column_privilege('w360_definer', 'app.team_closed_days', 'day', 'SELECT') AS definer_day,
              has_column_privilege('w360_app', 'app.teams', 'own_closed_days', 'UPDATE') AS app_flag,
              has_column_privilege('public', 'app.teams', 'own_closed_days', 'UPDATE') AS public_flag`,
    );
    expect(grants).toEqual({
      app_select: true,
      app_insert: true,
      app_delete: true,
      app_update: false,
      public_select: false,
      definer_insert: false,
      definer_day: false,
      app_flag: true,
      public_flag: false,
    });
    const [step] = await fx.query<{ ordinal: number }>(
      `SELECT ordinal FROM ops.tenant_deletion_steps
        WHERE 'app.team_closed_days'::regclass = ANY (tables)`,
    );
    const [teamsStep] = await fx.query<{ ordinal: number }>(
      `SELECT ordinal FROM ops.tenant_deletion_steps WHERE 'app.teams'::regclass = ANY (tables)`,
    );
    expect(step!.ordinal).toBeLessThan(teamsStep!.ordinal);
    // Another company sees none of them, and cannot give its rows this company's team.
    const seen = await fx.dbs.app.run(authorizedTenantScope(other.tenant.id, null), (tx) =>
      tx.execute(sql`SELECT id FROM app.team_closed_days`),
    );
    expect(seen.rows).toEqual([]);
    await expect(
      fx.query(
        `INSERT INTO app.team_closed_days (id, tenant_id, team_id, day)
         VALUES (gen_random_uuid(), $1, $2, '2026-11-09')`,
        [other.tenant.id, teamId],
      ),
    ).rejects.toThrow(/team_closed_days_team_fk/);
    await expect(
      fx.query(
        `INSERT INTO app.team_closed_days (id, tenant_id, team_id, day)
         VALUES (gen_random_uuid(), $1, $2, '2026-11-08')`,
        [c.tenant.id, teamId],
      ),
    ).rejects.toThrow(/team_closed_days_day_uq/);
  });

  it('give the inbox’s timers the team’s closed days instead of the company’s, while business hours are on', async () => {
    const { c, owner } = await setup(0);
    const inbox = inboxService();
    await inbox.updateResponseTarget(owner, { minutes: 30 });
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
    const conv = await inbound(c, waId());
    const [turn] = await fx.query<{ started_at: Date }>(
      `SELECT started_at FROM app.conversation_turns WHERE conversation_id = $1 AND ended_at IS NULL`,
      [conv.id],
    );
    // The company is closed the day the customer wrote and the next (its dates).
    const today = localDay(turn!.started_at);
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    const inTwoDays = new Date(Date.UTC(y, m - 1, d + 2)).toISOString().slice(0, 10);
    await hours.addHoliday(owner, { day: today, name: 'Holiday' });
    await hours.addHoliday(owner, { day: tomorrow, name: 'Holiday' });
    const due = async () =>
      (await inbox.listConversations(owner, {})).items.find((i) => i.id === conv.id)?.replyDueAt;
    const companyDue = await due();
    expect(companyDue && localDay(new Date(companyDue))).toBe(inTwoDays);

    // A team that works on the company's holidays: due 30 minutes after the customer wrote.
    const { teamId } = await teamsService().createTeam(owner, { name: 'Holidays', closedDays: [] });
    await inbox.setTeam(owner, {
      conversationId: conv.id,
      teamId,
      expectedVersion: (await conversation(conv.id)).version,
    });
    const absolute = new Date(turn!.started_at.getTime() + 30 * 60_000).toISOString();
    expect(await due()).toBe(absolute);
    expect((await inbox.getConversation(owner, conv.id)).conversation.replyDueAt).toBe(absolute);
    expect(await inbox.waitingReplies(owner)).toEqual({
      waits: [{ dueAt: absolute, mine: false }],
      capped: false,
    });
    // Closed on the day the customer wrote only, of its own: due the next day, the company's
    // holiday, when the team works.
    await teamsService().updateTeam(owner, teamId, { name: 'Holidays', closedDays: [today] });
    const ownDue = await due();
    expect(ownDue && localDay(new Date(ownDue))).toBe(tomorrow);
    // Business hours off: absolute time for every conversation, the team's closed days unused.
    await hours.updateBusinessHours(owner, { enabled: false, days: Array(7).fill('00:00-24:00') });
    expect(await due()).toBe(absolute);
  });
});

describe('routing', () => {
  it('places conversations in the number’s team and rotates among available members', async () => {
    const { c, owner, agents } = await setup(2);
    const teams = teamsService();
    const [a, b, d] = agents as [Setup['agents'][0], Setup['agents'][0], Setup['agents'][0]];
    const { teamId } = await teams.createTeam(owner, {
      name: 'Support',
      assignment: 'round_robin',
      memberIds: [a.membershipId, b.membershipId, d.membershipId],
      channelIds: [c.channelAccountId],
    });

    // Nobody is available: the conversation waits in the team's queue.
    const first = await inbound(c, waId());
    expect(first).toMatchObject({ team_id: teamId, assigned: null });

    // Becoming available picks up the waiting conversation straight away.
    expect(await teams.setAvailability(a.ctx, { available: true })).toEqual({ routed: 1 });
    expect((await conversation(first.id)).assigned).toBe(a.membershipId);
    await teams.setAvailability(b.ctx, { available: true });
    await teams.setAvailability(d.ctx, { available: true });

    // Next in turn after a: b, d, a.
    const order = [];
    for (let i = 0; i < 3; i += 1) order.push((await inbound(c, waId())).assigned);
    expect(order).toEqual([b.membershipId, d.membershipId, a.membershipId]);

    const routed = await fx.query<{ metadata: { rule: string; assignedMembershipId: string } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'conversation.routed' AND actor_type = 'system'
        ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(routed[0]?.metadata.rule).toBe('number');

    // A reopened conversation stays with its previous assignee.
    const inbox = inboxService();
    const current = await conversation(first.id);
    await inbox.setStatus(a.ctx, {
      conversationId: first.id,
      status: 'resolved',
      expectedVersion: current.version,
    });
    const phone = await fx.query<{ wa_id: string }>(
      `SELECT i.wa_id FROM app.contact_identities i
         JOIN app.conversations cv ON cv.tenant_id = i.tenant_id AND cv.contact_id = i.contact_id
        WHERE cv.id = $1`,
      [first.id],
    );
    const reopened = await inbound(c, phone[0]!.wa_id, 'One more thing');
    expect(reopened.assigned).toBe(a.membershipId);
    expect((await conversation(first.id)).status).toBe('open');
  });

  it('respects the limit of open conversations and fills freed places from the sweep', async () => {
    const { c, owner, agents } = await setup(1);
    const teams = teamsService();
    const inbox = inboxService();
    const [a, b] = agents as [Setup['agents'][0], Setup['agents'][0]];
    await teams.createTeam(owner, {
      name: 'Support',
      assignment: 'round_robin',
      maxOpenPerMember: 1,
      memberIds: [a.membershipId, b.membershipId],
      channelIds: [c.channelAccountId],
    });
    await teams.setAvailability(a.ctx, { available: true });
    await teams.setAvailability(b.ctx, { available: true });
    const one = await inbound(c, waId());
    const two = await inbound(c, waId());
    const three = await inbound(c, waId());
    expect([one.assigned, two.assigned].sort()).toEqual([a.membershipId, b.membershipId].sort());
    expect(three.assigned).toBeNull();

    // The sweep finds nothing to do while everyone is at the limit.
    expect(await routeDueConversations(fx.dbs.app)).toBe(0);
    const holder = agents.find((x) => x.membershipId === one.assigned)!;
    await inbox.setStatus(holder.ctx, {
      conversationId: one.id,
      status: 'resolved',
      expectedVersion: (await conversation(one.id)).version,
    });
    expect(await routeDueConversations(fx.dbs.app)).toBeGreaterThanOrEqual(1);
    expect((await conversation(three.id)).assigned).toBe(holder.membershipId);
  });

  it('routes by keyword to a team before the number’s team', async () => {
    const { c, owner } = await setup(0);
    const teams = teamsService();
    const { teamId: support } = await teams.createTeam(owner, {
      name: 'Support',
      channelIds: [c.channelAccountId],
    });
    const { teamId: billing } = await teams.createTeam(owner, {
      name: 'Billing',
      routingKeywords: ['refund', 'invoice copy'],
    });
    expect((await inbound(c, waId(), 'I need a REFUND, please!')).team_id).toBe(billing);
    expect((await inbound(c, waId(), 'Can I get an invoice copy?')).team_id).toBe(billing);
    // Whole words only.
    expect((await inbound(c, waId(), 'Was it refunded?')).team_id).toBe(support);
    const [audit] = await fx.query<{ metadata: { rule: string; teamId: string } }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'conversation.routed' ORDER BY occurred_at LIMIT 1`,
      [c.tenant.id],
    );
    expect(audit?.metadata).toMatchObject({ rule: 'keyword', teamId: billing });
  });

  it('never exceeds the limit when many customers write at once', async () => {
    const { c, owner, agents } = await setup(1);
    const teams = teamsService();
    await teams.createTeam(owner, {
      name: 'Support',
      assignment: 'round_robin',
      maxOpenPerMember: 2,
      memberIds: agents.map((a) => a.membershipId),
      channelIds: [c.channelAccountId],
    });
    for (const a of agents) await teams.setAvailability(a.ctx, { available: true });
    const phones = Array.from({ length: 6 }, () => waId());
    await Promise.all(
      phones.map((p) => fx.deliver(fx.messagesBody(c, { messages: [{ waId: p, text: 'Hi' }] }))),
    );
    const rows = await fx.query<{ assigned: string | null; n: number }>(
      `SELECT assigned_membership_id AS assigned, count(*)::int AS n
         FROM app.conversations WHERE tenant_id = $1 GROUP BY 1`,
      [c.tenant.id],
    );
    const byMember = new Map(rows.map((r) => [r.assigned, r.n]));
    for (const a of agents) expect(byMember.get(a.membershipId)).toBe(2);
    expect(byMember.get(null)).toBe(2);
  });

  it('lets supervisors move conversations between teams, routing them on arrival', async () => {
    const { c, owner, agents } = await setup(0);
    const teams = teamsService();
    const inbox = inboxService();
    const a = agents[0]!;
    const { teamId: rr } = await teams.createTeam(owner, {
      name: 'Round robin',
      assignment: 'round_robin',
      memberIds: [a.membershipId],
    });
    await teams.setAvailability(a.ctx, { available: true });
    const conv = await inbound(c, waId());
    expect(conv).toMatchObject({ team_id: null, assigned: null });
    const version = (await conversation(conv.id)).version;
    await expectAppError(
      inbox.setTeam(a.ctx, { conversationId: conv.id, teamId: rr, expectedVersion: version }),
      'forbidden',
    );
    await expectAppError(
      inbox.setTeam(owner, { conversationId: conv.id, teamId: rr, expectedVersion: version + 5 }),
      'conflict',
    );
    const moved = await inbox.setTeam(owner, {
      conversationId: conv.id,
      teamId: rr,
      expectedVersion: version,
    });
    expect(moved.assignedMembershipId).toBe(a.membershipId);
    expect(await conversation(conv.id)).toMatchObject({ team_id: rr, assigned: a.membershipId });

    // Teams of another company are not visible.
    const other = await setup(0);
    const { teamId: foreign } = await teams.createTeam(other.owner, { name: 'Foreign' });
    await expectAppError(
      inbox.setTeam(owner, {
        conversationId: conv.id,
        teamId: foreign,
        expectedVersion: (await conversation(conv.id)).version,
      }),
      'validation_failed',
    );
    expect((await teams.listTeams(owner)).map((t) => t.name)).toEqual(['Round robin']);
    await expectAppError(teams.updateTeam(owner, foreign, { name: 'Taken' }), 'not_found');
  });
});

describe('availability and leaving members', () => {
  it('is set by the member, or by someone who manages assignments (audited)', async () => {
    const { c, owner, agents } = await setup(1);
    const teams = teamsService();
    const [a, b] = agents as [Setup['agents'][0], Setup['agents'][0]];
    await teams.setAvailability(a.ctx, { available: true });
    expect(await teams.getAvailability(a.ctx)).toBe(true);
    await expectAppError(
      teams.setAvailability(a.ctx, { membershipId: b.membershipId, available: true }),
      'forbidden',
    );
    await teams.setAvailability(owner, { membershipId: a.membershipId, available: false });
    expect(await teams.getAvailability(a.ctx)).toBe(false);
    const marketer = await fx.ctx(c, c.marketer);
    await expectAppError(
      teams.setAvailability(owner, { membershipId: marketer.membership.id, available: true }),
      'validation_failed',
    );
    const audit = await fx.query<{ subject_id: string }>(
      `SELECT subject_id FROM app.audit_events WHERE tenant_id = $1 AND action = 'member.availability_changed'`,
      [c.tenant.id],
    );
    expect(audit.map((r) => r.subject_id)).toEqual([a.membershipId]);
  });

  it('returns a suspended member’s conversations to the queue for others', async () => {
    const { c, owner, agents } = await setup(1);
    const teams = teamsService();
    const tenancy = createTenancyService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      jobs: fx.jobs(),
      signer: fx.signer,
      appBaseUrl: 'http://localhost:3000',
      invitationTtlHours: 72,
    });
    const [a, b] = agents as [Setup['agents'][0], Setup['agents'][0]];
    await teams.createTeam(owner, {
      name: 'Support',
      assignment: 'round_robin',
      memberIds: [a.membershipId],
      channelIds: [c.channelAccountId],
    });
    await teams.setAvailability(a.ctx, { available: true });
    const conv = await inbound(c, waId());
    expect(conv.assigned).toBe(a.membershipId);

    await tenancy.setMemberStatus(owner, { membershipId: a.membershipId, status: 'suspended' });
    expect((await conversation(conv.id)).assigned).toBeNull();
    const [availability] = await fx.query<{ available: boolean }>(
      `SELECT available FROM app.member_availability WHERE membership_id = $1`,
      [a.membershipId],
    );
    expect(availability?.available).toBe(false);
    const [released] = await fx.query<{ metadata: { conversations: number; open: number } }>(
      `SELECT metadata FROM app.audit_events WHERE tenant_id = $1 AND action = 'member.conversations_released'`,
      [c.tenant.id],
    );
    expect(released?.metadata).toEqual({ conversations: 1, open: 1 });

    // Another member joins the team and becomes available: the sweep hands the conversation over.
    await teams.updateTeam(owner, (await teams.listTeams(owner))[0]!.id, {
      name: 'Support',
      assignment: 'round_robin',
      memberIds: [b.membershipId],
      channelIds: [c.channelAccountId],
    });
    await teams.setAvailability(b.ctx, { available: true });
    expect((await conversation(conv.id)).assigned).toBe(b.membershipId);
  });
});

describe('assignment', () => {
  it('offers and accepts only members who can answer conversations (ADR-093)', async () => {
    const { c, owner, agents } = await setup(0);
    const inbox = inboxService();
    const a = agents[0]!;
    const marketer = await fx.ctx(c, c.marketer);
    const analystUser = await createUser(fx.dbs, { name: 'Ana Analyst' });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, analystUser.email, ['analyst']);
    await acceptInvitation(fx.dbs, analystUser, token);
    const analyst = await fx.ctx(c, analystUser);
    // The picker leaves out the marketer and the analyst, who cannot open the inbox.
    expect((await inbox.assignableMembers(owner)).map((m) => m.membershipId).sort()).toEqual(
      [owner.membership.id, a.membershipId].sort(),
    );
    const conv = await inbound(c, waId());
    const { version } = await conversation(conv.id);
    for (const membershipId of [marketer.membership.id, analyst.membership.id]) {
      await expectAppError(
        inbox.assign(owner, { conversationId: conv.id, membershipId, expectedVersion: version }),
        'validation_failed',
        /role can reply in the inbox/,
      );
    }
    expect(await conversation(conv.id)).toMatchObject({ assigned: null, version });
    await inbox.assign(owner, {
      conversationId: conv.id,
      membershipId: a.membershipId,
      expectedVersion: version,
    });
    expect((await conversation(conv.id)).assigned).toBe(a.membershipId);
  });
});

describe('conversation cases', () => {
  it('open on creation and reopening, close on resolve, and cannot be rewritten', async () => {
    const { c, agents } = await setup(0);
    const inbox = inboxService();
    const a = agents[0]!;
    const phone = waId();
    const conv = await inbound(c, phone);
    const cases = () =>
      fx.query<{
        opened_at: Date;
        resolved_at: Date | null;
        resolved_by_membership_id: string | null;
        assigned_membership_id: string | null;
      }>(
        `SELECT opened_at, resolved_at, resolved_by_membership_id, assigned_membership_id
           FROM app.conversation_cases WHERE conversation_id = $1 ORDER BY opened_at`,
        [conv.id],
      );
    expect(await cases()).toHaveLength(1);
    await inbox.assign(a.ctx, {
      conversationId: conv.id,
      membershipId: a.membershipId,
      expectedVersion: (await conversation(conv.id)).version,
    });
    await inbox.setStatus(a.ctx, {
      conversationId: conv.id,
      status: 'resolved',
      expectedVersion: (await conversation(conv.id)).version,
    });
    const [closed] = await cases();
    expect(closed).toMatchObject({
      resolved_by_membership_id: a.membershipId,
      assigned_membership_id: a.membershipId,
    });
    expect(closed?.resolved_at).not.toBeNull();

    await inbound(c, phone, 'Back again');
    const all = await cases();
    expect(all).toHaveLength(2);
    expect(all[1]?.resolved_at).toBeNull();

    // The runtime role (tenant-scoped) cannot rewrite a resolved case either.
    await expectAppError(
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), (tx) =>
        tx.execute(
          sql`update app.conversation_cases set resolved_at = now()
               where conversation_id = ${conv.id}::uuid and resolved_at is not null`,
        ),
      ),
      'forbidden',
    );
    await expect(
      fx.query(
        `UPDATE app.conversation_cases SET assigned_membership_id = NULL
          WHERE conversation_id = $1 AND resolved_at IS NOT NULL`,
        [conv.id],
      ),
    ).rejects.toThrow(/cannot change/);
    await expect(
      fx.query(`DELETE FROM app.conversation_cases WHERE conversation_id = $1`, [conv.id]),
    ).rejects.toThrow(/cannot be deleted/);
  });
});

describe('inbox list', () => {
  it('filters by team, number and customer, orders by longest wait and shows reply timers', async () => {
    const { c, owner, agents } = await setup(0);
    const teams = teamsService();
    const inbox = inboxService();
    const a = agents[0]!;
    await inbox.updateResponseTarget(owner, { minutes: 30 });
    const { teamId: billing } = await teams.createTeam(owner, {
      name: 'Billing',
      routingKeywords: ['invoice'],
    });
    const p1 = waId();
    const p2 = waId();
    const first = await inbound(c, p1, 'Where is my invoice?');
    const second = await inbound(c, p2, 'Hello there');
    expect(first.team_id).toBe(billing);

    const list = (input: Record<string, unknown>) =>
      inbox.listConversations(owner, { status: 'open', ...input });
    expect((await list({ team: billing })).items.map((i) => i.id)).toEqual([first.id]);
    expect((await list({ team: 'none' })).items.map((i) => i.id)).toEqual([second.id]);
    expect((await list({ channel: c.channelAccountId })).items).toHaveLength(2);
    expect((await list({ q: p2.slice(-6) })).items.map((i) => i.id)).toEqual([second.id]);
    expect((await list({ q: 'nobody by this name' })).items).toEqual([]);

    // Longest wait first; both customers are waiting.
    const waiting = await list({ order: 'waiting' });
    expect(waiting.items.map((i) => i.id)).toEqual([first.id, second.id]);
    const item = waiting.items[0]!;
    expect(item.teamName).toBe('Billing');
    expect(item.waitingSince).not.toBeNull();
    expect(new Date(item.replyDueAt!).getTime() - new Date(item.waitingSince!).getTime()).toBe(
      30 * 60_000,
    );
    expect(item.overdue).toBe(false);

    // Paging through the waiting order.
    const page1 = await list({ order: 'waiting', limit: 1 });
    expect(page1.items.map((i) => i.id)).toEqual([first.id]);
    const page2 = await list({ order: 'waiting', limit: 1, cursor: page1.nextCursor });
    expect(page2.items.map((i) => i.id)).toEqual([second.id]);

    // A member's reply ends the wait: the conversation leaves the waiting order.
    await queueTextMessage(
      { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock },
      a.ctx,
      { conversationId: first.id, text: 'Sending it now', clientKey: `key-${first.id}` },
    );
    expect((await list({ order: 'waiting' })).items.map((i) => i.id)).toEqual([second.id]);
    const detail = await inbox.getConversation(owner, first.id);
    expect(detail.conversation).toMatchObject({
      teamName: 'Billing',
      waitingSince: null,
      replyDueAt: null,
    });
  });
});

describe('saved replies', () => {
  it('are managed by supervisors and filled in for a conversation', async () => {
    const { c, owner, agents } = await setup(0);
    const replies = createSavedRepliesService({ db: fx.dbs.app, clock: systemClock });
    const a = agents[0]!;
    await expectAppError(
      replies.createSavedReply(a.ctx, { shortcut: 'hi', title: 'Hi', body: 'Hello' }),
      'forbidden',
    );
    await expectAppError(
      replies.createSavedReply(owner, { shortcut: 'bad one', title: 'x', body: 'x' }),
      'validation_failed',
      /shortcut/,
    );
    await expectAppError(
      replies.createSavedReply(owner, { shortcut: 'x', title: 'x', body: 'Hi {{surname}}' }),
      'validation_failed',
      /Unknown placeholder/,
    );
    const { id } = await replies.createSavedReply(owner, {
      shortcut: 'Hours',
      title: 'Opening hours',
      body: 'Hi {{ name }}, we are open 9 to 5. {{agent}} from {{company}}',
    });
    await expectAppError(
      replies.createSavedReply(owner, { shortcut: 'hours', title: 'Again', body: 'x' }),
      'conflict',
      /shortcut/,
    );
    expect((await replies.listSavedReplies(a.ctx)).map((r) => r.shortcut)).toEqual(['hours']);

    const conv = await inbound(c, waId());
    const [rendered] = await replies.savedRepliesFor(a.ctx, conv.id);
    expect(rendered).toMatchObject({ id, shortcut: 'hours', missing: [] });
    expect(rendered?.text).toBe(
      `Hi Priya Customer, we are open 9 to 5. ${a.ctx.user.name} from ${a.ctx.tenant.name}`,
    );

    await replies.updateSavedReply(owner, id, {
      shortcut: 'hours',
      title: 'Hours',
      body: 'Open 9 to 5',
    });
    await replies.deleteSavedReply(owner, id);
    expect(await replies.listSavedReplies(owner)).toEqual([]);
    const audit = await fx.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action LIKE 'saved_reply.%' ORDER BY occurred_at`,
      [c.tenant.id],
    );
    expect(audit.map((r) => r.action)).toEqual([
      'saved_reply.created',
      'saved_reply.updated',
      'saved_reply.deleted',
    ]);
    // Audit entries name the shortcut, never the text.
    expect(JSON.stringify(audit)).not.toContain('Open 9 to 5');
  });
});

describe('mentions', () => {
  it('notify members who can see the conversation and are cleared when they open it', async () => {
    const { c, owner, agents } = await setup(1);
    const inbox = inboxService();
    const [a, b] = agents as [Setup['agents'][0], Setup['agents'][0]];
    const conv = await inbound(c, waId());
    // Unassigned: both agents can see it.
    expect((await inbox.mentionableMembers(a.ctx, conv.id)).map((m) => m.membershipId)).toEqual(
      expect.arrayContaining([a.membershipId, b.membershipId, owner.membership.id]),
    );
    await inbox.addNote(owner, {
      conversationId: conv.id,
      body: 'Can one of you take this?',
      mentionIds: [a.membershipId, b.membershipId],
    });
    expect(await inbox.unreadMentionCount(a.ctx)).toBe(1);
    const [mention] = await inbox.listMentions(b.ctx, { unreadOnly: true });
    expect(mention).toMatchObject({ conversationId: conv.id, body: 'Can one of you take this?' });

    // Assigned to a: b can no longer see the conversation, so b's mention is hidden and b cannot
    // be mentioned there.
    await inbox.assign(a.ctx, {
      conversationId: conv.id,
      membershipId: a.membershipId,
      expectedVersion: (await conversation(conv.id)).version,
    });
    expect(await inbox.unreadMentionCount(b.ctx)).toBe(0);
    await expectAppError(
      inbox.addNote(owner, { conversationId: conv.id, body: 'b?', mentionIds: [b.membershipId] }),
      'validation_failed',
      /can see this conversation/,
    );
    const marketer = await fx.ctx(c, c.marketer);
    await expectAppError(
      inbox.addNote(owner, {
        conversationId: conv.id,
        body: 'marketing?',
        mentionIds: [marketer.membership.id],
      }),
      'validation_failed',
    );

    // Opening the conversation marks a's mention read.
    await inbox.markRead(a.ctx, conv.id);
    expect(await inbox.unreadMentionCount(a.ctx)).toBe(0);
    const detail = await inbox.getConversation(owner, conv.id);
    expect(detail.notes[0]?.mentions.map((m) => m.membershipId).sort()).toEqual(
      [a.membershipId, b.membershipId].sort(),
    );

    // Erasing the contact deletes the notes and their mentions.
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), (tx) =>
      tx.execute(
        sql`select app.erase_contact((select contact_id from app.conversations where id = ${conv.id}::uuid), false)`,
      ),
    );
    const left = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.note_mentions WHERE tenant_id = $1`,
      [c.tenant.id],
    );
    expect(left[0]?.n).toBe(0);
  });
});

describe('emailing members mentioned in a note who have not opened it (ADR-211)', () => {
  const emailDeps = (clock: Clock = systemClock) => ({ db: fx.dbs.app, clock, ...fx.notices() });
  const scopeOf = (c: Company) => authorizedTenantScope(c.tenant.id, null);
  /** The mentions of the company's note with this text. */
  const mentionsOf = (c: Company, body: string) =>
    fx.query<{ id: string; membership_id: string }>(
      `SELECT m.id, m.membership_id FROM app.note_mentions m
         JOIN app.conversation_notes n ON n.tenant_id = m.tenant_id AND n.id = m.note_id
        WHERE m.tenant_id = $1 AND n.body = $2`,
      [c.tenant.id, body],
    );
  async function mentionEmails(c: Company) {
    const rows = await fx.query<{
      id: string;
      to_address: string;
      dedupe_key: string;
      payload_ciphertext: string;
    }>(
      `SELECT id, to_address, dedupe_key, payload_ciphertext FROM ops.email_outbox
        WHERE tenant_id = $1 AND dedupe_key LIKE 'note-mention:%' ORDER BY id`,
      [c.tenant.id],
    );
    return rows.map((r) => ({
      to: r.to_address,
      dedupeKey: r.dedupe_key,
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
  /** The owner's name as the company shows it. */
  const ownerName = async (c: Company) =>
    (
      await fx.query<{ name: string }>(
        `SELECT coalesce(m.display_name, u.name) AS name
           FROM app.memberships m JOIN auth.users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND m.user_id = $2`,
        [c.tenant.id, c.owner.id],
      )
    )[0]!.name;

  it('schedules a signed job for each member mentioned but the author, and emails one who has not opened the conversation once, without the note', async () => {
    const { c, owner, agents } = await setup(1);
    const inbox = inboxService();
    const [a, b] = agents as [Setup['agents'][0], Setup['agents'][0]];
    const from = waId();
    const conv = await inbound(c, from, 'My parcel never arrived');
    const before = Date.now();
    const body = 'Refund approved for order 1042, call them back';
    await inbox.addNote(owner, {
      conversationId: conv.id,
      body,
      mentionIds: [a.membershipId, b.membershipId, owner.membership.id],
    });
    const after = Date.now();
    const mentions = await mentionsOf(c, body);
    const of = (membershipId: string) => mentions.find((m) => m.membership_id === membershipId)!.id;
    const jobs = await fx.query<{ singleton_key: string; start_after: Date; data: unknown }>(
      `SELECT singleton_key, start_after, data FROM pgboss.job
        WHERE name = $1 AND singleton_key = ANY($2::text[])`,
      [QUEUES.noteMention.name, mentions.map((m) => m.id)],
    );
    // One for each agent, none for the owner, who mentioned themselves.
    expect(jobs.map((j) => j.singleton_key).sort()).toEqual(
      [of(a.membershipId), of(b.membershipId)].sort(),
    );
    for (const job of jobs) {
      expect(fx.signer.verify(job.data)).toMatchObject({
        kind: 'note.mention',
        tenantId: c.tenant.id,
        actorUserId: null,
        ref: job.singleton_key,
      });
      expect(job.start_after.getTime()).toBeGreaterThanOrEqual(before + MENTION_EMAIL_DELAY_MS);
      expect(job.start_after.getTime()).toBeLessThanOrEqual(after + MENTION_EMAIL_DELAY_MS);
    }

    // b opened the conversation before the email was due; a did not.
    await inbox.markRead(b.ctx, conv.id);
    expect(await sendMentionEmail(emailDeps(), scopeOf(c), of(b.membershipId))).toBe('read');
    expect(await sendMentionEmail(emailDeps(), scopeOf(c), of(a.membershipId))).toBe('sent');
    // A job run again finds its email queued.
    expect(await sendMentionEmail(emailDeps(), scopeOf(c), of(a.membershipId))).toBe(
      'already_sent',
    );
    const author = await ownerName(c);
    const [company] = await fx.query<{ name: string }>(
      'SELECT name FROM app.tenants WHERE id = $1',
      [c.tenant.id],
    );
    const sent = await mentionEmails(c);
    expect(sent).toEqual([
      {
        to: a.user.email,
        dedupeKey: `note-mention:${of(a.membershipId)}`,
        kind: 'tenant.notice',
        companyName: company!.name,
        subject: `${author} mentioned you in a note`,
        lines: mentionEmailNotice({ authorName: author, unread: 1 }).lines,
        url: `http://localhost:3000/c/${c.tenant.slug}/inbox/${conv.id}`,
        actionLabel: 'Open conversation',
      },
    ]);
    // Neither the note, the customer's message nor their number is in it.
    for (const text of ['Refund approved', 'parcel', from]) {
      expect(JSON.stringify(sent)).not.toContain(text);
    }
  });

  it('emails only the newest unread mention of a member in a conversation, and no member who can no longer see it or left, nor a mention gone or a day late', async () => {
    const { c, owner, agents } = await setup(1);
    const inbox = inboxService();
    const [a, b] = agents as [Setup['agents'][0], Setup['agents'][0]];
    const conv = await inbound(c, waId());
    await inbox.addNote(owner, {
      conversationId: conv.id,
      body: 'First: can you look?',
      mentionIds: [a.membershipId],
    });
    await inbox.addNote(owner, {
      conversationId: conv.id,
      body: 'Second: any news?',
      mentionIds: [a.membershipId],
    });
    const [first] = await mentionsOf(c, 'First: can you look?');
    const [second] = await mentionsOf(c, 'Second: any news?');
    // The first mention's job leaves the email to the second's, which counts both.
    expect(await sendMentionEmail(emailDeps(), scopeOf(c), first!.id)).toBe('newer');
    expect(await sendMentionEmail(emailDeps(), scopeOf(c), second!.id)).toBe('sent');
    const author = await ownerName(c);
    expect((await mentionEmails(c)).map((e) => [e.to, e.dedupeKey, e.lines])).toEqual([
      [
        a.user.email,
        `note-mention:${second!.id}`,
        mentionEmailNotice({ authorName: author, unread: 2 }).lines,
      ],
    ]);

    // Assigned to b after the note: a, an agent, can no longer see the conversation.
    const assigned = await inbound(c, waId());
    await inbox.addNote(owner, {
      conversationId: assigned.id,
      body: 'Third: for a',
      mentionIds: [a.membershipId],
    });
    await inbox.assign(owner, {
      conversationId: assigned.id,
      membershipId: b.membershipId,
      expectedVersion: (await conversation(assigned.id)).version,
    });
    const [third] = await mentionsOf(c, 'Third: for a');
    expect(await sendMentionEmail(emailDeps(), scopeOf(c), third!.id)).toBe('cannot_see');

    // More than a day late (the company was suspended, or the worker down), then gone with its
    // note when the contact is erased.
    const erased = await inbound(c, waId());
    await inbox.addNote(owner, {
      conversationId: erased.id,
      body: 'Fourth: for b',
      mentionIds: [b.membershipId],
    });
    const [fourth] = await mentionsOf(c, 'Fourth: for b');
    const dayLater: Clock = {
      now: () => new Date(Date.now() + MENTION_EMAIL_LATE_LIMIT_MS + 60_000),
    };
    expect(await sendMentionEmail(emailDeps(dayLater), scopeOf(c), fourth!.id)).toBe('too_late');
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), (tx) =>
      tx.execute(
        sql`select app.erase_contact((select contact_id from app.conversations where id = ${erased.id}::uuid), false)`,
      ),
    );
    expect(await sendMentionEmail(emailDeps(), scopeOf(c), fourth!.id)).toBe('gone');

    // A member who left the company.
    const left = await inbound(c, waId());
    await inbox.addNote(owner, {
      conversationId: left.id,
      body: 'Fifth: for b',
      mentionIds: [b.membershipId],
    });
    const [fifth] = await mentionsOf(c, 'Fifth: for b');
    await fx.query(`UPDATE app.memberships SET status = 'removed' WHERE id = $1`, [b.membershipId]);
    expect(await sendMentionEmail(emailDeps(), scopeOf(c), fifth!.id)).toBe('cannot_see');
    expect(await mentionEmails(c)).toHaveLength(1);
  });
});

describe('mention emails for members who turned them off (ADR-215)', () => {
  it('emails nobody who turned mention emails off', async () => {
    const { c, owner, agents } = await setup(0);
    const [agent] = agents as [Setup['agents'][0]];
    const conv = await inbound(c, waId());
    await createEmailPreferencesService({ db: fx.dbs.app }).updateEmailPreferences(agent.ctx, {
      off: ['mentions'],
    });
    await inboxService().addNote(owner, {
      conversationId: conv.id,
      body: 'Quiet: for the agent',
      mentionIds: [agent.membershipId],
    });
    const [mention] = await fx.query<{ id: string }>(
      `SELECT m.id FROM app.note_mentions m
         JOIN app.conversation_notes n ON n.tenant_id = m.tenant_id AND n.id = m.note_id
        WHERE m.tenant_id = $1 AND n.body = 'Quiet: for the agent'`,
      [c.tenant.id],
    );
    expect(
      await sendMentionEmail(
        { db: fx.dbs.app, clock: systemClock, ...fx.notices() },
        authorizedTenantScope(c.tenant.id, null),
        mention!.id,
      ),
    ).toBe('opted_out');
    const [queued] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.email_outbox WHERE dedupe_key = $1`,
      [`note-mention:${mention!.id}`],
    );
    expect(queued!.n).toBe(0);
  });
});

describe('conversation transcripts (ADR-212)', () => {
  async function transcript(ctx: TenantContext, conversationId: string) {
    let text = '';
    for await (const chunk of inboxService().exportTranscript(ctx, conversationId, {})) {
      text += chunk;
    }
    return text;
  }

  it('gives owners, administrators and supervisors who can see the conversation its messages in order, audited, without notes', async () => {
    const { c, owner, agents } = await setup(0);
    const [agent] = agents as [Setup['agents'][0]];
    const from = waId();
    const conv = await inbound(c, from, 'Where is my parcel?');
    await inboxService().addNote(owner, {
      conversationId: conv.id,
      body: 'Internal: VIP customer, offer a refund',
    });
    // 1,001 replies: more than two pages of 500.
    await fx.query(
      `INSERT INTO app.messages (id, tenant_id, conversation_id, channel_account_id, direction, type,
                                 content, status, sender_type, sender_membership_id, created_at)
       SELECT gen_random_uuid(), $1, $2, $3, 'outbound', 'text',
              jsonb_build_object('text', 'Reply ' || g), 'delivered', 'agent', $4,
              now() + g * interval '1 millisecond'
         FROM generate_series(1, 1001) g`,
      [c.tenant.id, conv.id, c.channelAccountId, owner.membership.id],
    );
    const [facts] = await fx.query<{
      contact_name: string | null;
      phone: string | null;
      number: string | null;
      received_at: Date;
      timezone: string;
    }>(
      `SELECT ct.display_name AS contact_name, ct.phone_e164 AS phone,
              ca.display_phone_number AS number, t.timezone,
              (SELECT coalesce(m.provider_timestamp, m.created_at) FROM app.messages m
                WHERE m.conversation_id = cv.id AND m.direction = 'inbound') AS received_at
         FROM app.conversations cv
         JOIN app.contacts ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contact_id
         JOIN app.channel_accounts ca ON ca.tenant_id = cv.tenant_id AND ca.id = cv.channel_account_id
         JOIN app.tenants t ON t.id = cv.tenant_id
        WHERE cv.id = $1`,
      [conv.id],
    );
    const text = await transcript(owner, conv.id);
    const lines = text.split('\n');
    expect(lines.slice(0, 4)).toEqual([
      `Conversation with ${[facts!.contact_name, facts!.phone].filter(Boolean).join(' · ')}`,
      `WhatsApp number: ${facts!.number ?? 'unknown'}`,
      `Company: ${owner.tenant.name}`,
      `Times are in ${facts!.timezone}. Internal notes are not included.`,
    ]);
    expect(lines[4]!.startsWith(`Downloaded by ${c.owner.name} on `)).toBe(true);
    expect(lines[4]).toMatch(/ on \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/);
    const entries = lines.filter((line) => line.startsWith('['));
    expect(entries).toHaveLength(1_002);
    expect(entries[0]).toBe(
      `[${transcriptTime(facts!.received_at, facts!.timezone)}] ${facts!.contact_name || 'Customer'}: Where is my parcel?`,
    );
    // Every reply once, oldest first, across the pages.
    expect(entries.slice(1).map((line) => line.replace(/^\[[^\]]+\] /, ''))).toEqual(
      Array.from({ length: 1_001 }, (_, i) => `${c.owner.name}: Reply ${i + 1}`),
    );
    expect(text).not.toContain('VIP customer');
    const audit = await fx.query<{ actor_id: string; subject_id: string }>(
      `SELECT actor_id, subject_id FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'conversation.transcript_exported'`,
      [c.tenant.id],
    );
    expect(audit).toEqual([{ actor_id: c.owner.id, subject_id: conv.id }]);

    // A supervisor can download it too; an agent, who can see the conversation, cannot.
    const user = await createUser(fx.dbs, { name: 'Supervisor S' });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, ['supervisor']);
    await acceptInvitation(fx.dbs, user, token);
    expect((await transcript(await fx.ctx(c, user), conv.id)).split('\n')[4]).toMatch(
      /^Downloaded by Supervisor S on /,
    );
    await expectAppError(transcript(agent.ctx, conv.id), 'forbidden');
    // Another company's owner cannot find it, nor can anyone find an id that is not a conversation.
    const other = await setup(0);
    await expectAppError(transcript(other.owner, conv.id), 'not_found');
    await expectAppError(transcript(owner, 'not-a-uuid'), 'not_found');
    expect(
      (
        await fx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.audit_events
            WHERE action = 'conversation.transcript_exported' AND subject_id = $1`,
          [conv.id],
        )
      )[0]!.n,
    ).toBe(2);
  });
});

describe('collision warning', () => {
  it('refuses a reply once when another member replied after the member’s last seen message', async () => {
    const { c, owner, agents } = await setup(0);
    const inbox = inboxService();
    const a = agents[0]!;
    const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
    const conv = await inbound(c, waId());
    await inbox.assign(a.ctx, {
      conversationId: conv.id,
      membershipId: a.membershipId,
      expectedVersion: (await conversation(conv.id)).version,
    });
    const seen = (await inbox.getConversation(a.ctx, conv.id)).messages.at(-1)!.id;
    // A supervisor answers while the assigned agent is still writing.
    await queueTextMessage(deps, owner, {
      conversationId: conv.id,
      text: 'I have this one',
      clientKey: `owner-${conv.id}`,
    });
    await expectAppError(
      queueTextMessage(deps, a.ctx, {
        conversationId: conv.id,
        text: 'Hi, how can I help?',
        clientKey: `agent-${conv.id}`,
        afterMessageId: seen,
      }),
      'conflict',
      /replied after you opened this conversation/,
    );
    // After reading the latest messages the agent can send.
    const latest = (await inbox.getConversation(a.ctx, conv.id)).messages.at(-1)!.id;
    const sent = await queueTextMessage(deps, a.ctx, {
      conversationId: conv.id,
      text: 'Following up',
      clientKey: `agent2-${conv.id}`,
      afterMessageId: latest,
    });
    expect(sent.duplicate).toBe(false);
  });
});
