import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizedTenantScope, sql } from '@w360/db';
import { createEmailPreferencesService } from '@w360/domain';
import { startWhatsAppFixture, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Members' choice of notice emails (ADR-215) against real PostgreSQL: the service, the definer
 * function that changes only the signed-in member's own membership, the kinds the column allows,
 * and the runtime role's lack of a direct update. Each notice's own test checks that it skips a
 * member who turned its kind off.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const optOuts = async (membershipId: string) =>
  (
    await fx.query<{ email_opt_outs: string[] }>(
      'SELECT email_opt_outs FROM app.memberships WHERE id = $1',
      [membershipId],
    )
  )[0]!.email_opt_outs;

describe('members’ choice of notice emails (ADR-215)', () => {
  it('lets a member turn off the kinds shown to them, for themselves only, audited', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const svc = createEmailPreferencesService({ db: fx.dbs.app });
    expect((await svc.getEmailPreferences(owner)).map((p) => [p.kind, p.email])).toEqual([
      ['mentions', true],
      ['campaign_approvals', true],
      ['campaign_reviews', true],
      ['campaign_pauses', true],
      ['campaign_completions', true],
    ]);
    expect(await svc.getEmailPreferences(agent)).toEqual([
      {
        kind: 'mentions',
        label: 'Mentions in notes',
        description: expect.stringContaining('10 minutes later') as unknown as string,
        email: true,
      },
    ]);
    // A kind not shown to the agent is left as it is.
    expect(
      await svc.updateEmailPreferences(
        agent,
        { off: ['mentions', 'campaign_approvals'] },
        { ipAddress: '203.0.113.9' },
      ),
    ).toEqual(['mentions']);
    expect((await svc.getEmailPreferences(agent))[0]).toMatchObject({
      kind: 'mentions',
      email: false,
    });
    expect(await optOuts(agent.membership.id)).toEqual(['mentions']);
    expect(await optOuts(owner.membership.id)).toEqual([]);
    // Kinds not shown keep their setting, say one turned off under an earlier role.
    await fx.query(
      `UPDATE app.memberships SET email_opt_outs = '{campaign_pauses,mentions}' WHERE id = $1`,
      [agent.membership.id],
    );
    expect(await svc.updateEmailPreferences(agent, { off: [] })).toEqual(['campaign_pauses']);
    const audit = await fx.query<{
      actor_id: string;
      subject_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_id, subject_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'membership.email_preferences_updated' ORDER BY id`,
      [c.tenant.id],
    );
    expect(audit).toEqual([
      { actor_id: c.agent.id, subject_id: agent.membership.id, metadata: { off: ['mentions'] } },
      {
        actor_id: c.agent.id,
        subject_id: agent.membership.id,
        metadata: { off: ['campaign_pauses'] },
      },
    ]);
  });

  it('changes only the signed-in member’s own active membership, and only to the kinds allowed', async () => {
    const c = await fx.company();
    const set = (userId: string | null, kinds: string[]) =>
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, userId), async (tx) => {
        const res = await tx.execute<{ opt_outs: string[] }>(
          sql`select app.set_own_email_opt_outs(${sql.param(kinds)}::text[]) as opt_outs`,
        );
        return res.rows[0]!.opt_outs;
      });
    // Sorted and without repeats, on the membership of the user the scope names.
    expect(await set(c.marketer.id, ['mentions', 'campaign_pauses', 'mentions'])).toEqual([
      'campaign_pauses',
      'mentions',
    ]);
    const [marketer] = await fx.query<{ id: string }>(
      'SELECT id FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
      [c.tenant.id, c.marketer.id],
    );
    expect(await optOuts(marketer!.id)).toEqual(['campaign_pauses', 'mentions']);
    // Nobody signed in, someone who is not a member, a suspended member: refused.
    await expect(set(null, [])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(set(c.owner.id.replace(/.$/, 'x'), [])).rejects.toMatchObject({
      code: 'not_found',
    });
    await fx.query(
      `UPDATE app.memberships SET status = 'suspended' WHERE tenant_id = $1 AND user_id = $2`,
      [c.tenant.id, c.marketer.id],
    );
    await expect(set(c.marketer.id, [])).rejects.toMatchObject({ code: 'not_found' });
    expect(await optOuts(marketer!.id)).toEqual(['campaign_pauses', 'mentions']);
    // Only the listed kinds: security emails cannot be turned off.
    await expect(set(c.owner.id, ['security'])).rejects.toMatchObject({
      code: '23514',
      constraint: 'memberships_email_opt_outs_check',
    });
    // The runtime role cannot change a membership itself.
    await expect(
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), (tx) =>
        tx.execute(
          sql`update app.memberships set email_opt_outs = '{mentions}' where tenant_id = ${c.tenant.id}::uuid`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Nothing runs it but the runtime role.
    const [grants] = await fx.query<{ public: boolean; owner: string }>(
      `SELECT has_function_privilege('public', 'app.set_own_email_opt_outs(text[])', 'EXECUTE') AS public,
              pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p WHERE p.oid = 'app.set_own_email_opt_outs(text[])'::regprocedure`,
    );
    expect(grants).toEqual({ public: false, owner: 'w360_definer' });
  });
});
