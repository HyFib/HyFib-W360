import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock, type Clock } from '@w360/core';
import {
  createInboxService,
  createPresenceService,
  purgeConversationViewers,
  type TenantContext,
} from '@w360/domain';
import { acceptInvitation, createUser, invite } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Members who have a conversation open (ADR-243) against real PostgreSQL: the one row per member
 * and conversation moved forward by each report, the 45-second window, the inbox's visibility rule
 * for the member reporting and for those named, leaving, row-level security between companies, and
 * the worker's purge through its definer function. Reports are given their time instead of waiting.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const at = (when: Date): Clock => ({ now: () => when });
const presence = (when: Date) => createPresenceService({ db: fx.dbs.app, clock: at(when) });
const later = (from: Date, seconds: number) => new Date(from.getTime() + seconds * 1000);
const inbox = () => createInboxService({ db: fx.dbs.app, clock: systemClock });

/** A member of the company with one role, named for the assertions. */
async function member(c: Company, name: string, role: string): Promise<TenantContext> {
  const user = await createUser(fx.dbs, { name });
  const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(fx.dbs, user, token);
  return fx.ctx(c, user);
}

/** A customer writes; the conversation their message opened. */
async function conversation(c: Company, waId: string) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId, text: 'Is anyone there?' }] }));
  const [row] = await fx.query<{ id: string; version: number }>(
    `SELECT id, version FROM app.conversations WHERE tenant_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [c.tenant.id],
  );
  return row!;
}

const viewerRows = async (tenantId: string) =>
  fx.query<{ membership_id: string; conversation_id: string; seen_at: Date }>(
    `SELECT membership_id, conversation_id, seen_at FROM app.conversation_viewers
      WHERE tenant_id = $1 ORDER BY seen_at, membership_id`,
    [tenantId],
  );

describe('members who have a conversation open (ADR-243)', () => {
  it('names the other members reported within 45 seconds, by name, and keeps one row per member', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const supervisor = await member(c, 'Presence supervisor', 'supervisor');
    const conv = await conversation(c, '919845200001');
    const t0 = new Date();

    expect(await presence(t0).report(owner, conv.id)).toEqual({ names: [], total: 0 });
    expect(await presence(later(t0, 5)).report(agent, conv.id)).toEqual({
      names: ['Owner'],
      total: 1,
    });
    expect(await presence(later(t0, 10)).report(supervisor, conv.id)).toEqual({
      names: ['Agent', 'Owner'],
      total: 2,
    });
    // The owner's second report moves their row forward rather than adding one.
    expect(await presence(later(t0, 20)).report(owner, conv.id)).toEqual({
      names: ['Agent', 'Presence supervisor'],
      total: 2,
    });
    const rows = await viewerRows(c.tenant.id);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.membership_id === owner.membership.id)?.seen_at).toEqual(
      later(t0, 20),
    );

    // Exactly 45 seconds after the agent's report, the agent no longer has it open.
    expect(await presence(later(t0, 50)).report(owner, conv.id)).toEqual({
      names: ['Presence supervisor'],
      total: 1,
    });
    expect(await presence(later(t0, 49.999)).report(supervisor, conv.id)).toEqual({
      names: ['Agent', 'Owner'],
      total: 2,
    });
  });

  it('names only active members who can see the conversation, and only to members who can see it', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const otherAgent = await member(c, 'Second agent', 'agent');
    const supervisor = await member(c, 'Presence supervisor', 'supervisor');
    const marketer = await fx.ctx(c, c.marketer);
    const conv = await conversation(c, '919845200002');
    const t0 = new Date();

    // Unassigned: every member with inbox access sees it; the marketer has none.
    await presence(t0).report(agent, conv.id);
    await presence(t0).report(otherAgent, conv.id);
    await presence(t0).report(supervisor, conv.id);
    await expect(presence(t0).report(marketer, conv.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await presence(later(t0, 1)).report(owner, conv.id)).toEqual({
      names: ['Agent', 'Presence supervisor', 'Second agent'],
      total: 3,
    });

    // Assigned to the first agent: the second agent can no longer see it, report it or be named.
    await inbox().assign(owner, {
      conversationId: conv.id,
      membershipId: agent.membership.id,
      expectedVersion: conv.version,
    });
    await expect(presence(later(t0, 2)).report(otherAgent, conv.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await presence(later(t0, 3)).report(owner, conv.id)).toEqual({
      names: ['Agent', 'Presence supervisor'],
      total: 2,
    });

    // A suspended member is not named, though their report is recent.
    await fx.query(
      `UPDATE app.memberships SET status = 'suspended' WHERE tenant_id = $1 AND id = $2`,
      [c.tenant.id, supervisor.membership.id],
    );
    expect(await presence(later(t0, 4)).report(agent, conv.id)).toEqual({
      names: ['Owner'],
      total: 1,
    });

    // A conversation of another company, or one that does not exist, is not found.
    const other = await fx.company();
    const otherConv = await conversation(other, '919845200003');
    await expect(presence(t0).report(owner, otherConv.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(presence(t0).report(owner, 'not-a-conversation')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await viewerRows(other.tenant.id)).toEqual([]);
  });

  it('forgets a member who left, and only them', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const first = await conversation(c, '919845200004');
    const second = await conversation(c, '919845200005');
    const t0 = new Date();
    await presence(t0).report(owner, first.id);
    await presence(t0).report(owner, second.id);
    expect(await presence(t0).report(agent, first.id)).toEqual({ names: ['Owner'], total: 1 });

    await presence(t0).leave(owner, first.id);
    expect(await presence(later(t0, 1)).report(agent, first.id)).toEqual({ names: [], total: 0 });
    expect(await presence(later(t0, 1)).report(agent, second.id)).toEqual({
      names: ['Owner'],
      total: 1,
    });
    // The agent's row and the owner's row in the other conversation stay.
    expect(
      (await viewerRows(c.tenant.id)).map((r) => [r.membership_id, r.conversation_id]),
    ).toEqual(
      expect.arrayContaining([
        [owner.membership.id, second.id],
        [agent.membership.id, first.id],
        [agent.membership.id, second.id],
      ]),
    );
    expect(await viewerRows(c.tenant.id)).toHaveLength(3);
    // Leaving needs no inbox permission: it deletes only the member's own row.
    const marketer = await fx.ctx(c, c.marketer);
    await presence(t0).leave(marketer, first.id);
    expect(await viewerRows(c.tenant.id)).toHaveLength(3);
  });

  it('is purged by the worker an hour after the last report, oldest first, and only then', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const conv = await conversation(c, '919845200006');
    const now = new Date();
    // Reports three hours, two hours and a minute ago.
    await presence(later(now, -3 * 3600)).report(owner, conv.id);
    await presence(later(now, -2 * 3600)).report(agent, conv.id);
    const fresh = await member(c, 'Presence supervisor', 'supervisor');
    await presence(later(now, -60)).report(fresh, conv.id);

    expect(await purgeConversationViewers(fx.dbs.app, 1)).toBe(1);
    expect((await viewerRows(c.tenant.id)).map((r) => r.membership_id)).toEqual([
      agent.membership.id,
      fresh.membership.id,
    ]);
    expect(await purgeConversationViewers(fx.dbs.app)).toBeGreaterThanOrEqual(1);
    expect((await viewerRows(c.tenant.id)).map((r) => r.membership_id)).toEqual([
      fresh.membership.id,
    ]);
    // Nothing older than an hour is left.
    expect(await purgeConversationViewers(fx.dbs.app)).toBe(0);
  });

  it('is the worker’s alone: the runtime role cannot read or delete other companies’ rows', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const conv = await conversation(c, '919845200007');
    await presence(new Date()).report(owner, conv.id);
    const client = await fx.dbs.appPool.connect();
    try {
      // Without a company scope, row-level security shows and deletes nothing.
      expect((await client.query('SELECT id FROM app.conversation_viewers')).rows).toEqual([]);
      expect((await client.query('DELETE FROM app.conversation_viewers')).rowCount).toBe(0);
    } finally {
      client.release();
    }
    expect(await viewerRows(c.tenant.id)).toHaveLength(1);
  });
});
