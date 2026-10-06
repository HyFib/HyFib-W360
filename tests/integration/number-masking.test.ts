import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import {
  createConsentService,
  createContactsService,
  createCrmService,
  createInboxService,
  createTenancyService,
  maskPhoneNumber,
  resolveTenantContext,
  type TenantContext,
} from '@w360/domain';
import type { TestUser } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Hiding customers' numbers from chosen roles (W-044, ADR-226) against real PostgreSQL: owners and
 * administrators choose the roles, the member's context leaves out `contacts.view_numbers` for a
 * member whose every role is masked, and contacts, search, the inbox, the CRM, the suppression list
 * and contact exports give such a member numbers masked; members of other roles, owners and
 * administrators see them whole. Showing numbers to a role again needs a recent sign-in.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx?.close();
});

const contacts = () => createContactsService({ db: fx.dbs.app, clock: systemClock });
const consent = () => createConsentService({ db: fx.dbs.app, clock: systemClock });
const inbox = () => createInboxService({ db: fx.dbs.app, clock: systemClock });
const crm = () =>
  createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
const tenancy = () =>
  createTenancyService({
    db: fx.dbs.app,
    clock: systemClock,
    keyring: fx.keyring,
    jobs: fx.jobs(),
    signer: fx.signer,
    appBaseUrl: 'http://localhost:3000',
    invitationTtlHours: 72,
  });

const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;

/** The member's context as a browser session that started `minutesAgo` minutes ago. */
function signedIn(c: Company, user: TestUser, minutesAgo: number): Promise<TenantContext> {
  return resolveTenantContext(
    { db: fx.dbs.app, clock: systemClock, mfaGracePeriodHours: 72 },
    {
      userId: user.id,
      sessionId: `sess_${user.id}`,
      sessionCreatedAt: new Date(Date.now() - minutesAgo * 60_000),
      tenantSlug: c.tenant.slug,
      correlationId: uuidv7(),
    },
  );
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, message: error.publicMessage };
  }
  throw new Error('expected a refusal');
}

async function text(stream: AsyncIterable<string>) {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}

describe('hiding customers’ numbers (ADR-226)', () => {
  it('masks numbers for the roles the company chooses, wherever their members read them', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    // A customer writes in: a contact with their number and a conversation, given to the agent.
    const wa = waId();
    const phone = `+${wa}`;
    const masked = maskPhoneNumber(phone);
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: wa, text: 'Hi there' }] }));
    const [row] = await fx.query<{ contact_id: string; id: string; version: number }>(
      `SELECT cv.contact_id, cv.id, cv.version FROM app.conversations cv WHERE cv.tenant_id = $1`,
      [c.tenant.id],
    );
    const contactId = row!.contact_id;
    const agentBefore = await fx.ctx(c, c.agent);
    expect(agentBefore.permissions.has('contacts.view_numbers')).toBe(true);
    await inbox().assign(owner, {
      conversationId: row!.id,
      membershipId: agentBefore.membership.id,
      expectedVersion: row!.version,
    });

    // The owner masks agents and marketers; supervisors and analysts are not chosen.
    await tenancy().updateNumberMasking(owner, { maskedNumberRoles: ['marketer', 'agent'] });
    const [tenant] = await fx.query<{ masked_number_roles: string[] }>(
      'SELECT masked_number_roles FROM app.tenants WHERE id = $1',
      [c.tenant.id],
    );
    expect(tenant!.masked_number_roles).toEqual(['agent', 'marketer']);
    const [audit] = await fx.query<{ metadata: unknown }>(
      `SELECT metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'tenant.number_masking_updated'`,
      [c.tenant.id],
    );
    expect(audit!.metadata).toEqual({ maskedNumberRoles: ['agent', 'marketer'], previous: [] });

    const agent = await fx.ctx(c, c.agent);
    const marketer = await fx.ctx(c, c.marketer);
    const ownerNow = await fx.ctx(c, c.owner);
    expect(agent.tenant.maskedNumberRoles).toEqual(['agent', 'marketer']);
    expect(agent.permissions.has('contacts.view_numbers')).toBe(false);
    expect(marketer.permissions.has('contacts.view_numbers')).toBe(false);
    expect(ownerNow.permissions.has('contacts.view_numbers')).toBe(true);

    // Contacts: the list, the contact and its WhatsApp identity.
    const listed = async (ctx: TenantContext, q?: string) =>
      (await contacts().listContacts(ctx, q ? { q } : {})).items.map((i) => i.phoneE164);
    expect(await listed(ownerNow)).toEqual([phone]);
    expect(await listed(agent)).toEqual([masked]);
    const seen = await contacts().getContact(agent, contactId);
    expect(seen.contact.phoneE164).toBe(masked);
    expect(seen.identities.map((i) => i.waId)).toEqual([maskPhoneNumber(wa)]);
    expect(JSON.stringify(seen)).not.toContain(wa);
    expect((await contacts().getContact(ownerNow, contactId)).contact.phoneE164).toBe(phone);

    // Search: part of a number finds nothing for a masked member, the whole number finds it.
    const part = wa.slice(4, 10);
    expect(await listed(ownerNow, part)).toEqual([phone]);
    expect(await listed(agent, part)).toEqual([]);
    expect(await listed(agent, wa)).toEqual([masked]);
    expect(await listed(agent, phone)).toEqual([masked]);

    // The inbox: the list, the conversation and the transcript.
    const items = (await inbox().listConversations(agent, {})).items;
    expect(items.map((i) => i.contactPhone)).toEqual([masked]);
    expect((await inbox().listConversations(agent, { q: part })).items).toEqual([]);
    const thread = await inbox().getConversation(agent, row!.id);
    expect(thread.conversation.contactPhone).toBe(masked);
    expect((await inbox().getConversation(ownerNow, row!.id)).conversation.contactPhone).toBe(
      phone,
    );

    // The CRM: a deal about the contact, on the contact's panel.
    const svc = crm();
    const { id: pipelineId } = await svc.createPipeline(ownerNow, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New'],
    });
    const [pipeline] = (await svc.listPipelines(ownerNow)).filter((p) => p.id === pipelineId);
    await svc.createDeal(ownerNow, {
      contactId,
      pipelineId,
      stageId: pipeline!.stages[0]!.id,
      title: 'Annual plan',
    });
    const panel = await svc.contactCrm(agent, contactId);
    expect(panel.contact.phone).toBe(masked);
    expect(panel.deals.map((d) => d.contact.phone)).toEqual([masked]);
    expect(JSON.stringify(panel)).not.toContain(wa);
    expect((await svc.contactCrm(ownerNow, contactId)).contact.phone).toBe(phone);

    // The suppression list, and the contact's entry on it.
    await consent().addSuppression(ownerNow, { phone, reason: 'manual' });
    expect((await consent().listSuppressions(agent)).items.map((s) => s.phoneE164)).toEqual([
      masked,
    ]);
    expect(
      (await consent().suppressionsForContact(agent, contactId)).map((s) => s.phoneE164),
    ).toEqual([masked]);
    expect(
      (await consent().suppressionsForContact(ownerNow, contactId)).map((s) => s.phoneE164),
    ).toEqual([phone]);

    // A contact export by a masked marketer keeps the number masked; the owner's is whole.
    const marketerFile = await text(contacts().exportContacts(marketer, {}));
    expect(marketerFile).toContain(masked);
    expect(marketerFile).not.toContain(wa);
    expect(await text(contacts().exportContacts(ownerNow, {}))).toContain(phone);
  });

  it('keeps a number a masked member cannot see, and lets them add one they type', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = contacts();
    const withNumber = await svc.createContact(owner, {
      displayName: 'Asha',
      phone: `+${waId()}`,
    });
    // A contact without a number, as one known only by WhatsApp user id or a store is.
    const withoutNumber = { id: uuidv7() };
    await fx.query(
      `INSERT INTO app.contacts (id, tenant_id, display_name, source) VALUES ($1, $2, 'Bala', 'manual')`,
      [withoutNumber.id, c.tenant.id],
    );
    await tenancy().updateNumberMasking(owner, { maskedNumberRoles: ['agent'] });
    const agent = await fx.ctx(c, c.agent);
    expect(await refusal(svc.updateContact(agent, withNumber.id, { phone: `+${waId()}` }))).toEqual(
      {
        code: 'forbidden',
        message:
          "Your company hides customers' phone numbers from your role, so this is unavailable. Ask an owner or administrator.",
      },
    );
    // Other details still change.
    await svc.updateContact(agent, withNumber.id, { displayName: 'Asha Rao' });
    const typed = `+${waId()}`;
    await svc.updateContact(agent, withoutNumber.id, { phone: typed });
    const [stored] = await fx.query<{ phone_e164: string }>(
      'SELECT phone_e164 FROM app.contacts WHERE id = $1',
      [withoutNumber.id],
    );
    expect(stored!.phone_e164).toBe(typed);
    expect((await svc.getContact(agent, withoutNumber.id)).contact.phoneE164).toBe(
      maskPhoneNumber(typed),
    );
  });

  it('is changed by owners and administrators only, and showing numbers again needs a recent sign-in', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    for (const user of [c.agent, c.marketer]) {
      expect(
        (
          await refusal(
            tenancy().updateNumberMasking(await fx.ctx(c, user), { maskedNumberRoles: ['agent'] }),
          )
        ).code,
      ).toBe('forbidden');
    }
    expect(
      (await refusal(tenancy().updateNumberMasking(owner, { maskedNumberRoles: ['admin'] }))).code,
    ).toBe('validation_failed');
    // Masking needs no recent sign-in; unmasking does.
    const stale = await signedIn(c, c.owner, 90);
    await tenancy().updateNumberMasking(stale, { maskedNumberRoles: ['agent', 'analyst'] });
    const staleAgain = await signedIn(c, c.owner, 90);
    expect(
      (await refusal(tenancy().updateNumberMasking(staleAgain, { maskedNumberRoles: ['analyst'] })))
        .code,
    ).toBe('step_up_required');
    await tenancy().updateNumberMasking(await fx.ctx(c, c.owner), {
      maskedNumberRoles: ['analyst'],
    });
    expect((await fx.ctx(c, c.agent)).permissions.has('contacts.view_numbers')).toBe(true);
    // The database keeps only the roles a company can mask, once each.
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.tenants SET masked_number_roles = ARRAY['owner'] WHERE id = $1`,
        [c.tenant.id],
      ),
    ).rejects.toThrow(/tenants_masked_number_roles/);
    await expect(
      fx.dbs.adminPool.query(
        `UPDATE app.tenants SET masked_number_roles = ARRAY['agent', NULL] WHERE id = $1`,
        [c.tenant.id],
      ),
    ).rejects.toThrow(/tenants_masked_number_roles/);
  });
});
