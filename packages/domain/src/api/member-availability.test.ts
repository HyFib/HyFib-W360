import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, type Database, type Tx } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { writeMemberAvailability } from '../inbox/teams';
import type { ApiContext } from './context';
import { apiUpdateMember, apiUpdateMemberSchema } from './members';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { API_ROUTES, apiMemberAvailabilitySchema, buildOpenApiDocument } from './openapi';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const MEMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const NOW = new Date('2026-10-07T10:00:00Z');
const BEFORE = new Date('2026-10-01T09:00:00Z');

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
const deps = { db: untouched, clock: { now: () => NOW } };

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

/**
 * A transaction holding one member and their availability, recording the locks it was asked for
 * and what was written.
 */
function memberTx(
  member: { status: string; roles: string[] } | null,
  availability: { available: boolean; changedAt: Date } | null,
) {
  const steps: unknown[] = [];
  const tx = {
    select: (fields: Record<string, unknown>) => {
      const ofMember = 'roles' in fields;
      const chain = {
        from: () => chain,
        where: () => chain,
        for: async (mode: string) => {
          steps.push([ofMember ? 'member' : 'availability', mode]);
          if (ofMember) return member ? [member] : [];
          return availability ? [availability] : [];
        },
      };
      return chain;
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const written = { ...values };
        delete written.id;
        if ('type' in values) {
          steps.push(['event', values.type, values.payload]);
          return Promise.resolve();
        }
        return {
          onConflictDoUpdate: async (conflict: { set: unknown }) => {
            steps.push(['upsert', written, conflict.set]);
          },
        };
      },
    }),
  } as unknown as Tx;
  return { tx, steps };
}

const agent = { status: 'active', roles: ['agent'] };

describe("setting members' availability (ADR-289)", () => {
  it('needs availability.write, a writing scope the database accepts, granted with inbox.assign', () => {
    expect(API_SCOPES).toContain('availability.write');
    // After teams.manage and before webhooks.manage, in the order the database's checks list them.
    expect(API_SCOPE_KEYS.indexOf('availability.write')).toBe(
      API_SCOPE_KEYS.indexOf('teams.manage') + 1,
    );
    expect(API_SCOPE_KEYS.indexOf('webhooks.manage')).toBe(
      API_SCOPE_KEYS.indexOf('availability.write') + 1,
    );
    expect(API_SCOPE_INFO['availability.write']).toMatchObject({
      label: "Set members' availability",
      permission: 'inbox.assign',
      writes: true,
    });
    for (const words of [
      "Set whether each of the company's members takes the conversations routing gives out",
      'as members who assign conversations switch it in Settings → Teams',
      'recorded in the audit log as done by the key',
      'Only active members whose role answers conversations are made available',
      'making one available routes waiting conversations again',
    ]) {
      expect(API_SCOPE_INFO['availability.write'].description).toContain(words);
    }
    // Owners and administrators, who create keys, assign conversations.
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('inbox.assign')).toBe(true);
    }
  });

  it('takes whether the member is available, and nothing else', () => {
    for (const available of [true, false]) {
      expect(apiUpdateMemberSchema.parse({ available })).toEqual({ available });
    }
    for (const input of [{}, { available: 'yes' }, { available: true, teamIds: [] }, null]) {
      expect(apiUpdateMemberSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('refuses before touching anything: the scope, a suspended company, an unknown id, a bad body', async () => {
    expect(
      await refusal(
        apiUpdateMember(deps, ctx(['conversations.write', 'teams.manage']), MEMBER, {
          available: true,
        }),
      ),
    ).toEqual(['forbidden', 'This API key does not have the availability.write scope.', []]);
    for (const status of ['suspended', 'restricted']) {
      expect(
        (
          await refusal(
            apiUpdateMember(deps, ctx(['availability.write'], status), MEMBER, {
              available: false,
            }),
          )
        )[0],
      ).toBe('tenant_suspended');
    }
    const key = ctx(['availability.write']);
    expect(await refusal(apiUpdateMember(deps, key, 'agent', { available: true }))).toEqual([
      'not_found',
      'Member not found.',
      [],
    ]);
    expect((await refusal(apiUpdateMember(deps, key, MEMBER, { available: 'yes' })))[2]).toEqual([
      'available',
    ]);
  });

  it('makes only a member who answers conversations available, with their row locked for share', async () => {
    const made = memberTx(agent, null);
    expect(await writeMemberAvailability(made.tx, TENANT, MEMBER, true, NOW)).toEqual({
      changed: true,
      changedAt: NOW,
    });
    expect(made.steps).toEqual([
      ['member', 'share'],
      [
        'upsert',
        { tenantId: TENANT, membershipId: MEMBER, available: true, changedAt: NOW },
        { available: true, changedAt: NOW },
      ],
      ['event', 'member.availability', { membershipId: MEMBER, available: true }],
    ]);
    for (const member of [
      { status: 'suspended', roles: ['agent'] },
      { status: 'removed', roles: ['agent'] },
      { status: 'active', roles: ['marketer'] },
    ]) {
      const refused = memberTx(member, null);
      expect(await refusal(writeMemberAvailability(refused.tx, TENANT, MEMBER, true, NOW))).toEqual(
        [
          'validation_failed',
          'Only active members whose role can reply in the inbox can take conversations.',
          [],
        ],
      );
      expect(refused.steps).toEqual([['member', 'share']]);
      // Any of the company's members can be made unavailable.
      const off = memberTx(member, null);
      expect((await writeMemberAvailability(off.tx, TENANT, MEMBER, false, NOW)).changed).toBe(
        true,
      );
      expect(off.steps.at(-1)).toEqual([
        'event',
        'member.availability',
        { membershipId: MEMBER, available: false },
      ]);
    }
    const missing = memberTx(null, null);
    expect(
      (await refusal(writeMemberAvailability(missing.tx, TENANT, MEMBER, false, NOW)))[0],
    ).toBe('not_found');
  });

  it('leaves a member already so as they are when asked to, and writes every time otherwise', async () => {
    for (const [current, available] of [
      [{ available: true, changedAt: BEFORE }, true],
      [{ available: false, changedAt: BEFORE }, false],
      [null, false],
    ] as const) {
      const kept = memberTx(agent, current);
      expect(
        await writeMemberAvailability(kept.tx, TENANT, MEMBER, available, NOW, {
          keepUnchanged: true,
        }),
      ).toEqual({ changed: false, changedAt: current ? BEFORE : null });
      expect(kept.steps).toEqual([
        ['member', 'share'],
        ['availability', 'update'],
      ]);
    }
    const flipped = memberTx(agent, { available: false, changedAt: BEFORE });
    expect(
      await writeMemberAvailability(flipped.tx, TENANT, MEMBER, true, NOW, { keepUnchanged: true }),
    ).toEqual({ changed: true, changedAt: NOW });
    const never = memberTx(agent, null);
    expect(
      (
        await writeMemberAvailability(never.tx, TENANT, MEMBER, true, NOW, {
          keepUnchanged: true,
        })
      ).changed,
    ).toBe(true);
    // Settings writes every time, as before.
    const again = memberTx(agent, { available: true, changedAt: BEFORE });
    expect((await writeMemberAvailability(again.tx, TENANT, MEMBER, true, NOW)).changed).toBe(true);
    expect(again.steps.map((s) => (s as unknown[])[0])).toEqual(['member', 'upsert', 'event']);
  });

  it('is described: the scope, who can be made available, routing and retries', () => {
    expect(API_ROUTES).toContainEqual(['patch', '/members/{id}']);
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { operationId: string; description: string }>>;
    };
    const operation = doc.paths['/members/{id}']?.patch;
    expect(operation?.operationId).toBe('updateMember');
    for (const words of [
      'Scope: `availability.write`.',
      'the conversations they have stay with them',
      'Only an active member whose role answers conversations is made available (422 otherwise',
      'any of the company’s members can be made unavailable',
      'Making a member available routes waiting conversations again',
      'so a retry needs no `Idempotency-Key`',
    ]) {
      expect(operation?.description).toContain(words);
    }
    expect(
      apiMemberAvailabilitySchema.safeParse({
        id: MEMBER,
        available: true,
        changedAt: NOW.toISOString(),
      }).success,
    ).toBe(true);
    expect(
      apiMemberAvailabilitySchema.safeParse({ id: MEMBER, available: false, changedAt: null })
        .success,
    ).toBe(true);
  });
});
