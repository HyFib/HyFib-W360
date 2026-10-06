import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '@w360/core';
import { authorizedTenantScope } from '@w360/db';
import {
  can,
  createContactsService,
  createInboxService,
  createSetupChecklistService,
  createTemplatesService,
  findTemplateStarter,
  processTemplateSubmit,
  starterDraft,
  syncTemplates,
  type TenantContext,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * The setup checklist (ADR-233) against real PostgreSQL: each step worked out from the company's
 * own data in its scope (an active number, an approved template, a contact that is not erased,
 * teammates or a pending invitation, a first-response target), and each shown only to members who
 * can read its data.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx.close();
});

const service = () => createSetupChecklistService({ db: fx.dbs.app, clock: systemClock });
const done = async (ctx: TenantContext) =>
  Object.fromEntries(
    (await service().checklist(ctx, { numbersConnectable: true })).map((s) => [s.key, s.done]),
  );

/** A starter (ADR-232) created, submitted and approved through the Graph stand-in, then synced. */
async function approvedStarter(c: Company) {
  const owner = await fx.ctx(c, c.owner);
  const templateDeps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
  const templates = createTemplatesService(templateDeps);
  const draft = starterDraft(findTemplateStarter('order_confirmation')!, {
    marketingOptOutKeywords: [],
  });
  const name = `${draft.name}_${Date.now().toString(36)}`;
  const { id } = await templates.createDraft(owner, {
    whatsappAccountId: c.whatsappAccountId,
    name,
    language: 'en',
    definition: draft.definition,
  });
  await templates.submitTemplate(owner, id);
  const graphDeps = { ...templateDeps, keyring: fx.keyring, graph: fx.graph };
  const scope = authorizedTenantScope(c.tenant.id, null);
  expect(await processTemplateSubmit(graphDeps, scope, id)).toBe('done');
  const t = fx.standIn.state.templates.get(c.wabaId)?.find((x) => x.name === name);
  if (!t) throw new Error('template not at the stand-in');
  t.status = 'APPROVED';
  await syncTemplates(graphDeps, scope, c.whatsappAccountId);
}

describe('the setup checklist (ADR-233)', () => {
  it('is worked out from the company’s own data', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    // The company's number is active and its owner invited teammates who joined.
    expect(await done(owner)).toEqual({
      two_factor: owner.user.twoFactorEnabled,
      number: true,
      template: false,
      contacts: false,
      team: true,
      response_target: false,
    });

    // An erased contact is not a contact; one that is not erased is.
    const contacts = createContactsService({ db: fx.dbs.app, clock: systemClock });
    const gone = await contacts.createContact(owner, {
      displayName: 'Gone',
      phone: '+919800000101',
    });
    await contacts.eraseContact(owner, { contactId: gone.id, suppress: false });
    expect((await done(owner)).contacts).toBe(false);
    await contacts.createContact(owner, { displayName: 'Asha', phone: '+919800000102' });
    expect((await done(owner)).contacts).toBe(true);

    await createInboxService({ db: fx.dbs.app, clock: systemClock }).updateResponseTarget(owner, {
      minutes: 30,
    });
    expect((await done(owner)).response_target).toBe(true);

    // A draft is not enough: Meta must approve a template.
    await approvedStarter(c);
    expect((await done(owner)).template).toBe(true);

    // A number that needs reconnecting is no longer active, and the step says so.
    await fx.query(`UPDATE app.channel_accounts SET status = 'needs_reconnect' WHERE id = $1`, [
      c.channelAccountId,
    ]);
    const steps = await service().checklist(owner, { numbersConnectable: true });
    expect(steps.find((s) => s.key === 'number')).toMatchObject({
      done: false,
      note: 'A number needs reconnecting: see Settings → Channels.',
    });

    // Another company's data never counts.
    const other = await fx.company();
    expect((await done(await fx.ctx(other, other.owner))).contacts).toBe(false);
  });

  it('shows each member only the steps whose data they can read', async () => {
    const c = await fx.company();
    for (const user of [c.owner, c.agent, c.marketer]) {
      const ctx = await fx.ctx(c, user);
      const keys = (await service().checklist(ctx, { numbersConnectable: true })).map((s) => s.key);
      const expected = [
        'two_factor',
        ...(can(ctx, 'channels.read') ? ['number'] : []),
        ...(can(ctx, 'templates.read') ? ['template'] : []),
        ...(can(ctx, 'contacts.read') ? ['contacts'] : []),
        ...(can(ctx, 'members.read') ? ['team'] : []),
        ...(can(ctx, 'tenant.settings.manage') ? ['response_target'] : []),
      ];
      expect(keys).toEqual(expected);
    }
    // An agent never sees the owners' settings steps.
    const agent = await fx.ctx(c, c.agent);
    expect(can(agent, 'tenant.settings.manage')).toBe(false);
  });

  it('counts a pending invitation as a team, but not an expired one', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    // Only the owner stays active.
    await fx.query(
      `UPDATE app.memberships SET status = 'suspended' WHERE tenant_id = $1 AND id <> $2`,
      [c.tenant.id, owner.membership.id],
    );
    await fx.query(`DELETE FROM app.invitations WHERE tenant_id = $1`, [c.tenant.id]);
    expect((await done(owner)).team).toBe(false);
    await fx.query(
      `INSERT INTO app.invitations (id, tenant_id, email, roles, token_hash, expires_at,
         invited_by_user_id)
       VALUES (gen_random_uuid(), $1, 'late@example.test', '{agent}', md5(random()::text),
         now() - interval '1 day', $2)`,
      [c.tenant.id, owner.user.id],
    );
    expect((await done(owner)).team).toBe(false);
    await fx.query(
      `INSERT INTO app.invitations (id, tenant_id, email, roles, token_hash, expires_at,
         invited_by_user_id)
       VALUES (gen_random_uuid(), $1, 'soon@example.test', '{agent}', md5(random()::text),
         now() + interval '1 day', $2)`,
      [c.tenant.id, owner.user.id],
    );
    expect((await done(owner)).team).toBe(true);
  });
});
