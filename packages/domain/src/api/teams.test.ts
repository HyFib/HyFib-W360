import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, type Database } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { INBOX_WORKER_ROLES } from '../inbox/routing';
import { droppedTeamMembers } from '../inbox/teams';
import type { ApiContext } from './context';
import { apiListTeams } from './members';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { API_ROUTES, apiTeamSettingsSchema, buildOpenApiDocument } from './openapi';
import {
  apiCreateTeam,
  apiCreateTeamSchema,
  apiDeleteTeam,
  apiGetTeam,
  apiUpdateTeam,
  apiDaysToTexts,
  apiUpdateTeamSchema,
  sameTeamSettings,
  teamSettingsOf,
  toApiTeamHours,
  toApiTeamSettings,
} from './teams';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const TEAM = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const AGENT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const SUPERVISOR = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';
const NUMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f05';

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read or written. */
const untouched = {
  run: () => {
    throw new Error('used the database');
  },
} as unknown as Database;
const deps = { db: untouched, clock: { now: () => new Date('2026-10-07T10:00:00Z') } };

/** A database that records the options of the transaction it was asked for, then stops it. */
function reached() {
  const runs: unknown[] = [];
  const db = {
    run: (_scope: unknown, _fn: unknown, options?: unknown) => {
      runs.push(options);
      throw new Error('reached the database');
    },
  } as unknown as Database;
  return { db, runs };
}

/** The code, message and paths of a refusal. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, error.publicMessage, (error.issues ?? []).map((i) => i.path)];
  }
  throw new Error('expected a refusal');
}

const settings = {
  name: 'Support',
  description: 'Orders and returns',
  assignment: 'round_robin' as const,
  maxOpenPerMember: 5,
  routingKeywords: ['refund', 'order status'],
  firstResponseTargetMinutes: 20,
  businessHours: null,
  memberIds: [AGENT, SUPERVISOR],
  channelIds: [NUMBER],
};

describe('managing teams through the API (ADR-287)', () => {
  it('needs teams.manage, a writing scope the database accepts, granted with inbox.supervise', () => {
    expect(API_SCOPES).toContain('teams.manage');
    // After the CRM scopes and before webhooks.manage, in the order the database's checks list them.
    expect(API_SCOPE_KEYS.indexOf('teams.manage')).toBe(API_SCOPE_KEYS.indexOf('notes.write') + 1);
    expect(API_SCOPE_KEYS.indexOf('webhooks.manage')).toBeGreaterThan(
      API_SCOPE_KEYS.indexOf('teams.manage'),
    );
    expect(API_SCOPE_INFO['teams.manage']).toMatchObject({
      label: 'Manage teams',
      permission: 'inbox.supervise',
      writes: true,
    });
    for (const words of [
      "Read the company's teams with their settings, members and numbers",
      'how they give out conversations, their routing keywords, members and numbers',
      'Settings → Teams',
      'recorded in the audit log as done by the key',
      "A deleted team's conversations leave it and keep their assignees.",
    ]) {
      expect(API_SCOPE_INFO['teams.manage'].description).toContain(words);
    }
    // Owners and administrators, who create keys, supervise the inbox.
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('inbox.supervise')).toBe(true);
    }
  });

  it('adds a team from a name and its settings, normalized as Settings saves them', () => {
    const parsed = apiCreateTeamSchema.parse({
      name: ' Support ',
      routingKeywords: ['Refund', 'refund ', ' Order  Status'],
      memberIds: [AGENT],
    });
    expect(teamSettingsOf(parsed)).toEqual({
      name: 'Support',
      description: null,
      assignment: 'manual',
      maxOpenPerMember: null,
      routingKeywords: ['refund', 'order status'],
      firstResponseTargetMinutes: null,
      businessHours: null,
      memberIds: [AGENT],
      channelIds: [],
    });
    for (const description of ['', null]) {
      expect(teamSettingsOf(apiCreateTeamSchema.parse({ ...settings, description }))).toEqual({
        ...settings,
        description: null,
      });
    }
    for (const [input, path] of [
      [{}, 'name'],
      [{ name: ' ' }, 'name'],
      [{ name: 'x'.repeat(81) }, 'name'],
      [{ name: 'Support', description: 'x'.repeat(301) }, 'description'],
      [{ name: 'Support', assignment: 'random' }, 'assignment'],
      [{ name: 'Support', maxOpenPerMember: 0 }, 'maxOpenPerMember'],
      [{ name: 'Support', maxOpenPerMember: 501 }, 'maxOpenPerMember'],
      [{ name: 'Support', maxOpenPerMember: 2.5 }, 'maxOpenPerMember'],
      [{ name: 'Support', maxOpenPerMember: '5' }, 'maxOpenPerMember'],
      [{ name: 'Support', firstResponseTargetMinutes: 0 }, 'firstResponseTargetMinutes'],
      [{ name: 'Support', firstResponseTargetMinutes: 1441 }, 'firstResponseTargetMinutes'],
      [{ name: 'Support', firstResponseTargetMinutes: 7.5 }, 'firstResponseTargetMinutes'],
      [{ name: 'Support', firstResponseTargetMinutes: '15' }, 'firstResponseTargetMinutes'],
      [{ name: 'Support', routingKeywords: 'refund, order' }, 'routingKeywords'],
      [{ name: 'Support', memberIds: ['agent'] }, 'memberIds.0'],
      [{ name: 'Support', memberIds: Array.from({ length: 201 }, () => AGENT) }, 'memberIds'],
      [{ name: 'Support', channelIds: Array.from({ length: 51 }, () => NUMBER) }, 'channelIds'],
      [{ name: 'Support', lastAssignedMembershipId: AGENT }, ''],
    ] as const) {
      const result = apiCreateTeamSchema.safeParse(input);
      expect(result.success, JSON.stringify(input)).toBe(false);
      expect(
        result.error?.issues.map((i) => i.path.join('.')),
        JSON.stringify(input),
      ).toContain(path);
    }
    // Keywords Settings would refuse are refused by name.
    for (const routingKeywords of [
      ['x'.repeat(41)],
      Array.from({ length: 21 }, (_, i) => `keyword ${i}`),
    ]) {
      let paths: string[] = [];
      try {
        teamSettingsOf(apiCreateTeamSchema.parse({ name: 'Support', routingKeywords }));
      } catch (error) {
        paths = isAppError(error) ? (error.issues ?? []).map((i) => i.path) : [];
      }
      expect(paths).toEqual(['routingKeywords']);
    }
  });

  it('changes any settings given, at least one, and nothing else', () => {
    for (const input of [
      { name: 'Care' },
      { description: null },
      { maxOpenPerMember: null },
      { firstResponseTargetMinutes: null },
      { firstResponseTargetMinutes: 1440 },
      { memberIds: [] },
      { channelIds: [NUMBER], assignment: 'manual' },
    ]) {
      expect(apiUpdateTeamSchema.safeParse(input).success, JSON.stringify(input)).toBe(true);
    }
    const empty = apiUpdateTeamSchema.safeParse({});
    expect(empty.success ? null : empty.error.issues.map((i) => i.message)).toEqual([
      'Give at least one setting to change.',
    ]);
    for (const input of [{ id: TEAM }, { name: 'Care', openConversations: 0 }, { name: null }]) {
      expect(apiUpdateTeamSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('takes a team as unchanged only when every setting is, members and numbers in any order', () => {
    expect(sameTeamSettings(settings, { ...settings })).toBe(true);
    expect(
      sameTeamSettings(settings, {
        ...settings,
        memberIds: [SUPERVISOR, AGENT],
        channelIds: [NUMBER, NUMBER],
      }),
    ).toBe(true);
    for (const change of [
      { name: 'Care' },
      { description: null },
      { assignment: 'manual' as const },
      { maxOpenPerMember: null },
      { firstResponseTargetMinutes: null },
      { firstResponseTargetMinutes: 21 },
      { businessHours: [{ weekday: 1, opens: 540, closes: 1020 }] },
      { routingKeywords: ['order status', 'refund'] },
      { routingKeywords: ['refund'] },
      { routingKeywords: ['refund', 'order status', 'returns'] },
      { memberIds: [AGENT] },
      { memberIds: [AGENT, TEAM] },
      { memberIds: [AGENT, AGENT] },
      { memberIds: [AGENT, SUPERVISOR, TEAM] },
      { channelIds: [] },
    ]) {
      expect(sameTeamSettings(settings, { ...settings, ...change }), JSON.stringify(change)).toBe(
        false,
      );
    }
  });

  it('gives a team its settings, members and numbers by id, and times', () => {
    const team = {
      id: TEAM,
      ...settings,
      createdAt: new Date('2026-10-01T09:00:00Z'),
      updatedAt: new Date('2026-10-07T10:00:00Z'),
    };
    const given = toApiTeamSettings(team);
    expect(given).toEqual({
      id: TEAM,
      ...settings,
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-07T10:00:00.000Z',
    });
    expect(apiTeamSettingsSchema.safeParse(given).success).toBe(true);
  });

  it('refuses before touching anything: the scope, a suspended company, an unknown id, a bad body', async () => {
    const missing = ['forbidden', 'This API key does not have the teams.manage scope.', []];
    const reader = ctx(['conversations.read', 'conversations.write']);
    expect(await refusal(apiCreateTeam(deps, reader, { name: 'Support' }, null))).toEqual(missing);
    expect(await refusal(apiGetTeam(deps, reader, TEAM))).toEqual(missing);
    expect(await refusal(apiUpdateTeam(deps, reader, TEAM, { name: 'Care' }))).toEqual(missing);
    expect(await refusal(apiDeleteTeam(deps, reader, TEAM))).toEqual(missing);
    for (const status of ['suspended', 'restricted']) {
      const manager = ctx(['teams.manage'], status);
      for (const write of [
        () => apiCreateTeam(deps, manager, { name: 'Support' }, null),
        () => apiUpdateTeam(deps, manager, TEAM, { name: 'Care' }),
        () => apiDeleteTeam(deps, manager, TEAM),
      ]) {
        expect((await refusal(write()))[0]).toBe('tenant_suspended');
      }
    }
    const manager = ctx(['teams.manage']);
    for (const call of [
      () => apiGetTeam(deps, manager, 'support'),
      () => apiUpdateTeam(deps, manager, 'support', { name: 'Care' }),
      () => apiDeleteTeam(deps, manager, 'support'),
    ]) {
      expect(await refusal(call())).toEqual(['not_found', 'Team not found.', []]);
    }
    expect((await refusal(apiCreateTeam(deps, manager, { name: '' }, null)))[2]).toEqual(['name']);
    expect((await refusal(apiUpdateTeam(deps, manager, TEAM, {})))[0]).toBe('validation_failed');
  });

  it('reads teams with teams.manage too, in read-only transactions, while the company is suspended', async () => {
    for (const status of ['active', 'suspended']) {
      const { db, runs } = reached();
      await expect(apiGetTeam({ db }, ctx(['teams.manage'], status), TEAM)).rejects.toThrow(
        'reached the database',
      );
      await expect(apiListTeams({ db }, ctx(['teams.manage'], status), {})).rejects.toThrow(
        'reached the database',
      );
      expect(runs).toEqual([{ accessMode: 'read only' }, { accessMode: 'read only' }]);
    }
    expect(await refusal(apiListTeams({ db: untouched }, ctx(['deals.read']), {}))).toEqual([
      'forbidden',
      'This API key does not have the conversations.read scope.',
      [],
    ]);
  });

  it('are described: the scope, the checks, what replaces and what a deletion does', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, { required?: string[]; properties?: object }> };
    };
    for (const route of [
      ['post', '/teams'],
      ['get', '/teams/{id}'],
      ['patch', '/teams/{id}'],
      ['delete', '/teams/{id}'],
    ]) {
      expect(API_ROUTES).toContainEqual(route);
    }
    type Operation = { operationId: string; description: string; responses: object };
    const path = (p: string, method: string) => doc.paths[p]?.[method] as Operation;
    expect(path('/teams', 'get').description).toContain(
      'Scope: `conversations.read` or `teams.manage`.',
    );
    const create = path('/teams', 'post');
    expect(create.operationId).toBe('createTeam');
    expect(Object.keys(create.responses)).toEqual(
      expect.arrayContaining(['201', '409', '412', '422', '423']),
    );
    for (const words of [
      'Scope: `teams.manage`.',
      'a name unique among the company’s teams ignoring case (409 otherwise)',
      '422 naming `memberIds` otherwise',
      'a number named here leaves the team it was in',
      '412 at the limit: delete one first',
      'Waiting conversations are routed again',
      'a retry answers the first response',
    ]) {
      expect(create.description).toContain(words);
    }
    expect(path('/teams/{id}', 'get').operationId).toBe('getTeam');
    const update = path('/teams/{id}', 'patch');
    expect(update.operationId).toBe('updateTeam');
    for (const words of [
      'the settings given change and the rest stay as they are',
      '`memberIds` and `channelIds` replace the team’s lists',
      'answers it as it is, with no audit entry, so a retry needs no `Idempotency-Key`',
    ]) {
      expect(update.description).toContain(words);
    }
    const remove = path('/teams/{id}', 'delete');
    expect(remove.operationId).toBe('deleteTeam');
    for (const words of [
      'its conversations leave the team and keep their assignees',
      '`conversations` counts the conversations that left it',
      'A team already deleted answers 404.',
    ]) {
      expect(remove.description).toContain(words);
    }
    expect(doc.components.schemas.CreateTeam?.required).toEqual(['name']);
    expect(doc.components.schemas.UpdateTeam?.required ?? []).toEqual([]);
    expect(Object.keys(doc.components.schemas.TeamSettings?.properties ?? {})).toEqual([
      'id',
      'name',
      'description',
      'assignment',
      'maxOpenPerMember',
      'routingKeywords',
      'firstResponseTargetMinutes',
      'businessHours',
      'memberIds',
      'channelIds',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('keep the place of members who cannot answer conversations now when a team is saved', () => {
    // Settings and keys list and choose only members who answer conversations, so a save takes
    // away only their places and those of removed members: a member suspended or given another
    // role keeps theirs and is back in the team when they can answer conversations again.
    const render = (memberIds: string[]) => {
      const { sql: text, params } = new PgDialect().sqlToQuery(
        droppedTeamMembers(TENANT, TEAM, memberIds)!,
      );
      return [text.replace(/\s+/g, ' '), params];
    };
    const gone = (first: number) =>
      `exists (select 1 from "app"."memberships" where ("app"."memberships"."tenant_id" = "app"."team_members"."tenant_id" and "app"."memberships"."id" = "app"."team_members"."membership_id" and (("app"."memberships"."status" = $${first} and "app"."memberships"."roles" && $${first + 1}::text[]) or "app"."memberships"."status" = $${first + 2})))`;
    expect(render([AGENT, SUPERVISOR])).toEqual([
      `("app"."team_members"."tenant_id" = $1 and "app"."team_members"."team_id" = $2 and "app"."team_members"."membership_id" not in ($3, $4) and ${gone(5)})`,
      [TENANT, TEAM, AGENT, SUPERVISOR, 'active', [...INBOX_WORKER_ROLES], 'removed'],
    ]);
    // A team saved without members keeps the places of members who cannot answer conversations.
    expect(render([])).toEqual([
      `("app"."team_members"."tenant_id" = $1 and "app"."team_members"."team_id" = $2 and ${gone(3)})`,
      [TENANT, TEAM, 'active', [...INBOX_WORKER_ROLES], 'removed'],
    ]);
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { description: string }>>;
    };
    expect(doc.paths['/teams/{id}']?.patch?.description).toContain(
      'members who cannot answer conversations now (suspended, or given another role) are never in `memberIds` and keep their place in the team',
    );
  });
});

describe('a team’s own business hours through the API (ADR-389)', () => {
  const week = [
    [
      { opens: '09:00', closes: '13:00' },
      { opens: '14:00', closes: '18:00' },
    ],
    [],
    [],
    [],
    [{ opens: '22:00', closes: '24:00' }],
    [],
    [],
  ];

  it('takes a week of ranges, checked day by day as Settings checks it, and gives it back', () => {
    const parsed = teamSettingsOf(
      apiCreateTeamSchema.parse({ name: 'Night', businessHours: week }),
    );
    expect(parsed.businessHours).toEqual([
      { weekday: 1, opens: 540, closes: 780 },
      { weekday: 1, opens: 840, closes: 1080 },
      { weekday: 5, opens: 1320, closes: 1440 },
    ]);
    expect(toApiTeamHours(parsed.businessHours)).toEqual(week);
    expect(toApiTeamHours(null)).toBeNull();
    expect(apiDaysToTexts(week)).toEqual([
      '09:00-13:00, 14:00-18:00',
      '',
      '',
      '',
      '22:00-24:00',
      '',
      '',
    ]);
    expect(
      teamSettingsOf(apiCreateTeamSchema.parse({ name: 'Night', businessHours: null }))
        .businessHours,
    ).toBeNull();
    const given = toApiTeamSettings({
      id: TEAM,
      ...settings,
      businessHours: parsed.businessHours,
      createdAt: new Date('2026-10-01T09:00:00Z'),
      updatedAt: new Date('2026-10-07T10:00:00Z'),
    });
    expect(given.businessHours).toEqual(week);
    expect(apiTeamSettingsSchema.safeParse(given).success).toBe(true);
  });

  it('refuses a week Settings would refuse, naming the day', () => {
    const day = (ranges: { opens: string; closes: string }[], index = 2) =>
      week.map((d, i) => (i === index ? ranges : d));
    for (const [businessHours, path] of [
      [week.slice(0, 6), 'businessHours'],
      [day([{ opens: '9:00am', closes: '17:00' }]), 'businessHours.2.0.opens'],
      [day([{ opens: '09:00', closes: '24:01' }]), 'businessHours.2.0.closes'],
      [
        day(Array.from({ length: 5 }, () => ({ opens: '09:00', closes: '10:00' }))),
        'businessHours.2',
      ],
      [day([{ opens: '09:00', closes: '10:00', extra: '1' } as never]), 'businessHours.2.0'],
    ] as const) {
      const result = apiCreateTeamSchema.safeParse({ name: 'Night', businessHours });
      expect(result.success, JSON.stringify(businessHours)).toBe(false);
      expect(result.error?.issues.map((i) => i.path.join('.'))).toContain(path);
    }
    // Ranges that end before they start, overlap or close the whole week are refused by the
    // checks Settings uses, naming the day.
    const settingsChecks = (businessHours: unknown) => {
      try {
        teamSettingsOf(apiCreateTeamSchema.parse({ name: 'Night', businessHours }));
      } catch (error) {
        if (!isAppError(error)) throw error;
        return [error.publicMessage, (error.issues ?? []).map((i) => i.path)];
      }
      throw new Error('expected a refusal');
    };
    expect(settingsChecks(day([{ opens: '18:00', closes: '09:00' }]))).toEqual([
      'Wednesday: A range must end after it starts; use 24:00 for midnight (got “18:00-09:00”).',
      ['businessHours.2'],
    ]);
    expect(
      settingsChecks(
        day([
          { opens: '09:00', closes: '12:00' },
          { opens: '11:00', closes: '13:00' },
        ]),
      ),
    ).toEqual(['Wednesday: Time ranges on the same day must not overlap.', ['businessHours.2']]);
    expect(settingsChecks(week.map(() => []))).toEqual([
      'Add at least one opening time for the team, or let it use the company’s business hours.',
      ['businessHours'],
    ]);
  });

  it('changes a team’s hours only when given, and null gives it the company’s again', () => {
    expect(apiUpdateTeamSchema.safeParse({ businessHours: null }).success).toBe(true);
    expect(apiUpdateTeamSchema.safeParse({ businessHours: week }).success).toBe(true);
    const own = teamSettingsOf(apiCreateTeamSchema.parse({ ...settings, businessHours: week }));
    expect(sameTeamSettings(own, { ...own })).toBe(true);
    // The same week in another order, or written differently, is no change.
    expect(
      sameTeamSettings(own, {
        ...own,
        businessHours: [...(own.businessHours ?? [])].reverse(),
      }),
    ).toBe(true);
    expect(sameTeamSettings(own, { ...own, businessHours: null })).toBe(false);
    expect(sameTeamSettings({ ...own, businessHours: null }, { ...own, businessHours: null })).toBe(
      true,
    );
    expect(
      sameTeamSettings(own, {
        ...own,
        businessHours: [{ weekday: 1, opens: 540, closes: 780 }],
      }),
    ).toBe(false);
  });

  it('are described without naming decisions', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const schemas = doc.components.schemas;
    for (const name of ['CreateTeam', 'UpdateTeam', 'TeamSettings']) {
      const text = JSON.stringify(schemas[name]?.properties?.businessHours ?? null);
      expect(text, name).toContain('company’s closed days');
      expect(text, name).not.toMatch(/ADR-\d/);
    }
  });
});
