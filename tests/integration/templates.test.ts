import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7, type Clock } from '@w360/core';
import { authorizedTenantScope, type TenantScope } from '@w360/db';
import {
  createConsentService,
  createContactsService,
  createTemplatesService,
  findTemplateSyncsDue,
  processSendIntent,
  processTemplateDelete,
  processTemplateSubmit,
  queueTemplateMessage,
  syncTemplates,
  TEMPLATE_SYNC_PRIORITY,
  type TemplateDefinition,
  type TemplatesService,
} from '@w360/domain';
import type { TemplateFixture } from '../support/graph-stand-in';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Template lifecycle and template sends against real PostgreSQL and the Graph stand-in:
 * write-ahead submission (including a lost create response), Graph listing as the source of truth,
 * deletion, webhook-triggered syncs, and consent/suppression enforcement at queue and send time.
 */
let fx: WhatsAppFixture;
let templates: TemplatesService;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  templates = createTemplatesService({
    db: fx.dbs.app,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
  });
});

afterAll(async () => {
  await fx.close();
});

beforeEach(() => {
  fx.standIn.state.sendQueue = [];
  fx.standIn.state.templateCreateQueue = [];
  fx.standIn.state.rejectExtraTemplateFields = false;
});

const workerDeps = (clock: Clock = systemClock) => ({
  db: fx.dbs.app,
  keyring: fx.keyring,
  graph: fx.graph,
  clock,
  jobs: fx.jobs(),
  signer: fx.signer,
});
const scopeOf = (c: Company): TenantScope => authorizedTenantScope(c.tenant.id, null);

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

const orderUpdate: TemplateDefinition = {
  category: 'UTILITY',
  header: { type: 'text', text: 'Order {{1}}', example: 'A-1001' },
  body: { text: 'Hi {{1}}, your order {{2}} is on its way.', examples: ['Asha', 'A-1001'] },
  footer: 'Reply STOP to opt out',
  buttons: [
    { type: 'URL', text: 'Help centre', url: 'https://example.test/help' },
    { type: 'PHONE_NUMBER', text: 'Call us', phoneNumber: '+919876500000' },
  ],
};

const promo: TemplateDefinition = {
  category: 'MARKETING',
  header: { type: 'none' },
  body: { text: 'Hello {{1}}, our festive sale starts today.', examples: ['Asha'] },
  footer: null,
  buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }],
};

async function templateRow(id: string) {
  const [row] = await fx.query<{
    status: string;
    provider_template_id: string | null;
    submit_error: string | null;
    origin: string;
    quality_score: string | null;
    rejection_reason: string | null;
  }>(
    'SELECT status, provider_template_id, submit_error, origin, quality_score, rejection_reason FROM app.message_templates WHERE id = $1',
    [id],
  );
  return row!;
}

async function approveAtMeta(c: Company, name: string, extra: Record<string, unknown> = {}) {
  const t = fx.standIn.state.templates.get(c.wabaId)!.find((x) => x.name === name)!;
  Object.assign(t, { status: 'APPROVED', ...extra });
}

async function draftSubmitApprove(c: Company, name: string, def: TemplateDefinition) {
  const owner = await fx.ctx(c, c.owner);
  const { id } = await templates.createDraft(owner, {
    whatsappAccountId: c.whatsappAccountId,
    name,
    language: 'en',
    definition: def,
  });
  await templates.submitTemplate(owner, id);
  expect(await processTemplateSubmit(workerDeps(), scopeOf(c), id)).toBe('done');
  await approveAtMeta(c, name);
  await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
  expect((await templateRow(id)).status).toBe('approved');
  return id;
}

describe('template drafts and submission', () => {
  let c: Company;
  beforeAll(async () => {
    c = await fx.company();
  });

  it('validates variables, examples and buttons before saving', async () => {
    const owner = await fx.ctx(c, c.owner);
    const base = { whatsappAccountId: c.whatsappAccountId, language: 'en' };
    await expectAppError(
      templates.createDraft(owner, {
        ...base,
        name: 'gap',
        definition: { ...promo, body: { text: 'Hi {{1}} and {{3}}', examples: ['a', 'b'] } },
      }),
      'validation_failed',
      /without gaps/,
    );
    await expectAppError(
      templates.createDraft(owner, {
        ...base,
        name: 'no_example',
        definition: { ...promo, body: { text: 'Hi {{1}}', examples: [] } },
      }),
      'validation_failed',
      /example/,
    );
    await expectAppError(
      templates.createDraft(owner, {
        ...base,
        name: 'dynamic_url',
        definition: {
          ...promo,
          buttons: [{ type: 'URL', text: 'Open', url: 'https://example.test/{{1}}' }],
        },
      }),
      'validation_failed',
      /not supported/,
    );
    await expectAppError(
      templates.createDraft(owner, { ...base, name: 'Bad Name', definition: promo }),
      'validation_failed',
    );
    const agent = await fx.ctx(c, c.agent);
    await expectAppError(
      templates.createDraft(agent, { ...base, name: 'agent_draft', definition: promo }),
      'forbidden',
    );
  });

  it('submits write-ahead, records Meta’s answer and follows the review through sync', async () => {
    const owner = await fx.ctx(c, c.owner);
    const { id } = await templates.createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'order_update',
      language: 'en',
      definition: orderUpdate,
    });
    await expectAppError(
      templates.createDraft(owner, {
        whatsappAccountId: c.whatsappAccountId,
        name: 'order_update',
        language: 'en',
        definition: orderUpdate,
      }),
      'conflict',
    );
    await templates.submitTemplate(owner, id);
    expect((await templateRow(id)).status).toBe('submitting');
    await expectAppError(templates.submitTemplate(owner, id), 'precondition_failed');
    expect(await processTemplateSubmit(workerDeps(), scopeOf(c), id)).toBe('done');
    const submitted = await templateRow(id);
    expect(submitted.status).toBe('pending');
    expect(submitted.provider_template_id).toMatch(/^\d+$/);
    // The create request carried Meta's component format.
    const create = fx.standIn.state.requests
      .filter((r) => r.method === 'POST' && r.path.endsWith('/message_templates'))
      .at(-1)!;
    expect(create.body).toMatchObject({
      name: 'order_update',
      language: 'en',
      category: 'UTILITY',
      components: [
        {
          type: 'HEADER',
          format: 'TEXT',
          text: 'Order {{1}}',
          example: { header_text: ['A-1001'] },
        },
        { type: 'BODY', example: { body_text: [['Asha', 'A-1001']] } },
        { type: 'FOOTER', text: 'Reply STOP to opt out' },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'URL', text: 'Help centre', url: 'https://example.test/help' },
            { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '919876500000' },
          ],
        },
      ],
    });
    await approveAtMeta(c, 'order_update', { quality_score: { score: 'GREEN', date: 1 } });
    await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
    expect(await templateRow(id)).toMatchObject({ status: 'approved', quality_score: 'GREEN' });
    const detail = await templates.getTemplate(owner, id);
    expect(detail.history.map((h) => h.status)).toEqual(['approved', 'pending', 'submitting']);
    expect(detail.sendable).toBe(true);
  });

  it('records a rejection by Meta as a failed submission and keeps the reason', async () => {
    const owner = await fx.ctx(c, c.owner);
    const { id } = await templates.createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'rejected_one',
      language: 'en',
      definition: promo,
    });
    await templates.submitTemplate(owner, id);
    fx.standIn.state.templateCreateQueue.push({
      kind: 'error',
      status: 400,
      code: 100,
      message: 'Invalid parameter: body text',
    });
    await processTemplateSubmit(workerDeps(), scopeOf(c), id);
    expect(await templateRow(id)).toMatchObject({ status: 'submit_failed' });
    expect((await templateRow(id)).submit_error).toMatch(/Invalid parameter/);
    // A failed draft can be edited and submitted again.
    const { template } = await templates.getTemplate(owner, id);
    await expectAppError(
      templates.updateDraft(owner, id, {
        expectedVersion: template.version + 1,
        definition: promo,
      }),
      'conflict',
    );
    await templates.updateDraft(owner, id, {
      expectedVersion: template.version,
      definition: { ...promo, footer: 'Tap Stop promotions to opt out' },
    });
    await templates.submitTemplate(owner, id);
    await processTemplateSubmit(workerDeps(), scopeOf(c), id);
    expect((await templateRow(id)).status).toBe('pending');
  });

  it('reconciles a lost create response by name, and fails a submission Meta never received', async () => {
    const owner = await fx.ctx(c, c.owner);
    const lost = await templates.createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'lost_response',
      language: 'en',
      definition: promo,
    });
    await templates.submitTemplate(owner, lost.id);
    fx.standIn.state.templateCreateQueue.push({ kind: 'create_then_drop' });
    await processTemplateSubmit(workerDeps(), scopeOf(c), lost.id);
    expect(await templateRow(lost.id)).toMatchObject({
      status: 'submitting',
      provider_template_id: null,
    });
    expect((await templateRow(lost.id)).submit_error).toMatch(/Waiting for Meta/);
    await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
    const adopted = await templateRow(lost.id);
    expect(adopted.status).toBe('pending');
    expect(adopted.provider_template_id).not.toBeNull();
    expect(adopted.submit_error).toBeNull();
    expect(
      fx.standIn.state.templates.get(c.wabaId)!.filter((t) => t.name === 'lost_response'),
    ).toHaveLength(1);

    const never = await templates.createDraft(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'never_arrived',
      language: 'en',
      definition: promo,
    });
    await templates.submitTemplate(owner, never.id);
    fx.standIn.state.templateCreateQueue.push({ kind: 'drop_connection' });
    await processTemplateSubmit(workerDeps(), scopeOf(c), never.id);
    expect((await templateRow(never.id)).status).toBe('submitting');
    // Within the confirmation window the sync waits; after it, the submission is failed.
    await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
    expect((await templateRow(never.id)).status).toBe('submitting');
    const later: Clock = { now: () => new Date(Date.now() + 11 * 60_000) };
    await syncTemplates(workerDeps(later), scopeOf(c), c.whatsappAccountId);
    expect(await templateRow(never.id)).toMatchObject({ status: 'submit_failed' });
    expect(fx.standIn.state.templates.get(c.wabaId)!.some((t) => t.name === 'never_arrived')).toBe(
      false,
    );
  });
});

describe('template sync', () => {
  it('adopts templates created elsewhere, pages through the listing and notices deletions', async () => {
    const c = await fx.company();
    const list: TemplateFixture[] = Array.from({ length: 105 }, (_, i) => ({
      id: String(7_000_000_000 + i),
      name: `external_${String(i).padStart(3, '0')}`,
      language: 'en_US',
      status: 'APPROVED',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: `Message ${i}` }],
    }));
    list.push({
      id: '7000000999',
      name: 'image_header',
      language: 'en_US',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        { type: 'HEADER', format: 'IMAGE' },
        { type: 'BODY', text: 'Look!' },
      ],
    });
    fx.standIn.state.templates.set(c.wabaId, list);
    fx.standIn.state.rejectExtraTemplateFields = true; // exercises the default-fields fallback
    await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
    const rows = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.message_templates WHERE tenant_id = $1 AND origin = 'synced'`,
      [c.tenant.id],
    );
    expect(rows[0]!.n).toBe(106);
    const owner = await fx.ctx(c, c.owner);
    const listed = await templates.listTemplates(owner);
    const image = listed.find((t) => t.name === 'image_header')!;
    expect(image.sendable).toBe(false);
    // A photo header is sent only through the API, which gives the file (ADR-201).
    expect(image.unsupportedReason).toBe(
      'This template has a photo header: HyFib sends such templates only through the API, which gives a link to the file.',
    );
    expect(listed.find((t) => t.name === 'external_000')!.sendable).toBe(true);

    fx.standIn.state.templates.set(c.wabaId, list.slice(1));
    await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
    const [gone] = await fx.query<{ status: string }>(
      `SELECT status FROM app.message_templates WHERE tenant_id = $1 AND name = 'external_000'`,
      [c.tenant.id],
    );
    expect(gone!.status).toBe('deleted');
  });

  it('turns template webhooks into sync requests only through a verified account binding', async () => {
    const c = await fx.company();
    await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
    // Whether the account asks for a sync since its last one, as `ops.template_sync_due` reads it.
    const syncRequested = async () => {
      const [row] = await fx.query<{ requested: boolean }>(
        `SELECT coalesce(templates_sync_requested_at >= templates_synced_at, false) AS requested
           FROM app.whatsapp_accounts WHERE id = $1`,
        [c.whatsappAccountId],
      );
      return row!.requested;
    };
    expect(await syncRequested()).toBe(false);
    const result = await fx.deliver(
      fx.fieldBody(c.wabaId, 'message_template_status_update', {
        event: 'APPROVED',
        message_template_id: 1,
      }),
    );
    expect(result.outcome).toBe('processed');
    expect(await syncRequested()).toBe(true);
    // The sweep lists the accounts asked for first (ADR-178), so this one is found although the
    // suite's shared database holds hundreds of connected accounts that never synced, and the
    // worker queues its sync ahead of routine ones.
    const due = await findTemplateSyncsDue(fx.dbs.app, 500);
    expect(due.find((d) => d.whatsappAccountId === c.whatsappAccountId)).toEqual({
      tenantId: c.tenant.id,
      whatsappAccountId: c.whatsappAccountId,
      requested: true,
    });
    const firstRoutine = due.findIndex((d) => !d.requested);
    if (firstRoutine !== -1) expect(due.slice(firstRoutine).some((d) => d.requested)).toBe(false);
    const unknown = await fx.deliver(fx.fieldBody('123456789012', 'template_category_update', {}));
    expect(unknown.outcome).toBe('quarantined');
    // Suspended companies are left out of the sweep until they are reactivated.
    await fx.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [c.tenant.id]);
    expect(
      (await findTemplateSyncsDue(fx.dbs.app, 500)).some(
        (d) => d.whatsappAccountId === c.whatsappAccountId,
      ),
    ).toBe(false);
    await fx.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [c.tenant.id]);
  });

  it('queues a refresh a member asks for ahead of the sweep’s routine syncs, and lists it first in the sweep (ADR-178)', async () => {
    const c = await fx.company();
    await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
    const jobOf = async () =>
      fx.query<{ priority: number }>(
        `SELECT priority FROM pgboss.job
          WHERE name = 'template.sync' AND singleton_key = $1 AND state = 'created'`,
        [`sync:${c.whatsappAccountId}`],
      );
    expect(await jobOf()).toEqual([]);
    await templates.requestSync(await fx.ctx(c, c.owner), c.whatsappAccountId);
    expect(await jobOf()).toEqual([{ priority: 10 }]);
    const due = await findTemplateSyncsDue(fx.dbs.app, 500);
    const index = due.findIndex((d) => d.whatsappAccountId === c.whatsappAccountId);
    expect(due[index]?.requested).toBe(true);
    expect(due.slice(0, index).every((d) => d.requested)).toBe(true);
    // Once a sync has started after the request, it is no longer asked for.
    await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
    expect(
      (await findTemplateSyncsDue(fx.dbs.app, 500)).some(
        (d) => d.whatsappAccountId === c.whatsappAccountId,
      ),
    ).toBe(false);
  });

  it('raises a routine sync still waiting to the priority of a refresh it stands for, and never lowers one (ADR-178)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await syncTemplates(workerDeps(), scopeOf(c), c.whatsappAccountId);
    const key = `sync:${c.whatsappAccountId}`;
    const waiting = async () =>
      fx.query<{ priority: number }>(
        `SELECT priority FROM pgboss.job
          WHERE name = 'template.sync' AND singleton_key = $1 AND state < 'active'`,
        [key],
      );
    // The sweep queued a routine sync, which no worker has taken yet.
    await fx.jobs().enqueue(
      null,
      'template.sync',
      fx.signer.sign({
        kind: 'template.sync',
        tenantId: c.tenant.id,
        actorUserId: null,
        ref: c.whatsappAccountId,
      }),
      { singletonKey: key, priority: TEMPLATE_SYNC_PRIORITY.routine },
    );
    expect(await waiting()).toEqual([{ priority: TEMPLATE_SYNC_PRIORITY.routine }]);
    // The refresh's own job collapses into it, which now goes first, still one sync.
    await templates.requestSync(owner, c.whatsappAccountId);
    expect(await waiting()).toEqual([{ priority: TEMPLATE_SYNC_PRIORITY.requested }]);
    // A priority above the refresh's is kept.
    await fx.query(
      `UPDATE pgboss.job SET priority = 20 WHERE name = 'template.sync' AND singleton_key = $1`,
      [key],
    );
    await templates.requestSync(owner, c.whatsappAccountId);
    expect(await waiting()).toEqual([{ priority: 20 }]);
  });

  it('deletes a template at Meta and marks it deleted', async () => {
    const c = await fx.company();
    const id = await draftSubmitApprove(c, 'to_delete', promo);
    const marketer = await fx.ctx(c, c.marketer);
    const agent = await fx.ctx(c, c.agent);
    await expectAppError(templates.deleteTemplate(agent, id), 'forbidden');
    await templates.deleteTemplate(marketer, id);
    expect((await templateRow(id)).status).toBe('pending_deletion');
    expect(await processTemplateDelete(workerDeps(), scopeOf(c), id)).toBe('done');
    expect((await templateRow(id)).status).toBe('deleted');
    expect(fx.standIn.state.templates.get(c.wabaId)!.some((t) => t.name === 'to_delete')).toBe(
      false,
    );
    const del = fx.standIn.state.requests.filter((r) => r.method === 'DELETE').at(-1)!;
    expect(del.query).toMatchObject({ name: 'to_delete' });
  });
});

describe('template sends', () => {
  let c: Company;
  let promoId: string;
  let utilityId: string;
  beforeAll(async () => {
    c = await fx.company();
    promoId = await draftSubmitApprove(c, 'festive_sale', promo);
    utilityId = await draftSubmitApprove(c, 'order_update', orderUpdate);
  });

  const send = (
    ctxUser: 'agent' | 'marketer' | 'owner',
    contactId: string,
    templateId: string,
    params: { header?: string[]; body?: string[] },
  ) =>
    fx.ctx(c, c[ctxUser]).then((ctx) =>
      queueTemplateMessage(
        { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock },
        ctx,
        {
          contactId,
          channelAccountId: c.channelAccountId,
          templateId,
          params: { header: params.header ?? [], body: params.body ?? [] },
          clientKey: `ck_${uuidv7()}`,
        },
      ),
    );

  async function dispatch(messageId: string) {
    const [intent] = await fx.query<{ id: string }>(
      'SELECT id FROM app.send_intents WHERE message_id = $1',
      [messageId],
    );
    return processSendIntent(
      { ...workerDeps(), rate: { capacity: 100, refillPerSecond: 100 } },
      scopeOf(c),
      intent!.id,
    );
  }

  async function newContact(phone: string) {
    const ctx = await fx.ctx(c, c.agent);
    return (
      await createContactsService({ db: fx.dbs.app, clock: systemClock }).createContact(ctx, {
        phone,
      })
    ).id;
  }

  it('sends an approved utility template outside the service window with the documented request shape', async () => {
    const contactId = await newContact('+919855500001');
    fx.standIn.state.waIdFor.set('919855500001', '919855500099');
    const queued = await send('agent', contactId, utilityId, {
      header: ['A-2002'],
      body: ['Asha', 'A-2002'],
    });
    expect(await dispatch(queued.messageId)).toMatchObject({ outcome: 'accepted' });
    const request = fx.standIn.state.requests.filter((r) => r.path.endsWith('/messages')).at(-1)!;
    expect(request.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919855500001',
      type: 'template',
      template: {
        name: 'order_update',
        language: { policy: 'deterministic', code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'A-2002' }] },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Asha' },
              { type: 'text', text: 'A-2002' },
            ],
          },
        ],
      },
    });
    const [message] = await fx.query<{
      content: { rendered: { body: string } };
      template_id: string;
    }>('SELECT content, template_id FROM app.messages WHERE id = $1', [queued.messageId]);
    expect(message!.content.rendered.body).toBe('Hi Asha, your order A-2002 is on its way.');
    expect(message!.template_id).toBe(utilityId);
    // Meta resolved the number to a different WhatsApp id: replies from it join this contact.
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: '919855500099', text: 'Thanks!' }] }));
    const [identity] = await fx.query<{ contact_id: string }>(
      'SELECT contact_id FROM app.contact_identities WHERE tenant_id = $1 AND wa_id = $2',
      [c.tenant.id, '919855500099'],
    );
    expect(identity!.contact_id).toBe(contactId);
    const contacts = await fx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.contacts WHERE tenant_id = $1',
      [c.tenant.id],
    );
    expect(contacts[0]!.n).toBe(1);
  });

  it("clips the conversation's preview of a template without splitting an emoji (ADR-133)", async () => {
    // "Hi " and 196 characters put the emoji's two halves at the 200th and 201st code units.
    const contactId = await newContact('+919855500077');
    await send('agent', contactId, utilityId, {
      header: ['A-2003'],
      body: [`${'x'.repeat(196)}😀`, 'A-2003'],
    });
    const [conv] = await fx.query<{ last_message_preview: string }>(
      'SELECT last_message_preview FROM app.conversations WHERE tenant_id = $1 AND contact_id = $2',
      [c.tenant.id, contactId],
    );
    expect(conv!.last_message_preview).toBe(`Hi ${'x'.repeat(196)}`);
  });

  it('requires campaign permission and a marketing opt-in for marketing templates', async () => {
    const contactId = await newContact('+919855500002');
    await expectAppError(send('agent', contactId, promoId, { body: ['Asha'] }), 'forbidden');
    await expectAppError(
      send('marketer', contactId, promoId, { body: ['Asha'] }),
      'precondition_failed',
      /not opted in/,
    );
    await expectAppError(send('marketer', contactId, promoId, { body: [] }), 'validation_failed');
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    await consent.recordConsent(await fx.ctx(c, c.agent), {
      contactId,
      purpose: 'marketing',
      action: 'opt_in',
      note: 'Asked at the store counter',
    });
    const queued = await send('marketer', contactId, promoId, { body: ['Asha'] });
    expect(await dispatch(queued.messageId)).toMatchObject({ outcome: 'accepted' });
  });

  it('honours an opt-out or suppression recorded after queueing, before dispatch', async () => {
    const contactId = await newContact('+919855500003');
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    const agent = await fx.ctx(c, c.agent);
    await consent.recordConsent(agent, { contactId, purpose: 'marketing', action: 'opt_in' });
    const queued = await send('marketer', contactId, promoId, { body: ['Ravi'] });
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: '919855500003', text: 'STOP' }] }));
    const before = fx.standIn.state.requests.length;
    expect(await dispatch(queued.messageId)).toMatchObject({ outcome: 'failed' });
    expect(fx.standIn.state.requests.length).toBe(before);
    const [row] = await fx.query<{ status: string; error_code: string }>(
      'SELECT status, error_code FROM app.messages WHERE id = $1',
      [queued.messageId],
    );
    expect(row).toEqual({ status: 'failed', error_code: 'opted_out' });

    const other = await newContact('+919855500004');
    const utility = await send('agent', other, utilityId, {
      header: ['A-1'],
      body: ['Mala', 'A-1'],
    });
    await consent.addSuppression(agent, { phone: '+919855500004', reason: 'legal' });
    expect(await dispatch(utility.messageId)).toMatchObject({ outcome: 'failed' });
    const [blocked] = await fx.query<{ error_code: string }>(
      'SELECT error_code FROM app.messages WHERE id = $1',
      [utility.messageId],
    );
    expect(blocked!.error_code).toBe('suppressed');
    await expectAppError(
      send('agent', other, utilityId, { header: ['A-1'], body: ['Mala', 'A-1'] }),
      'precondition_failed',
      /suppression/,
    );
  });

  it('records Meta’s marketing opt-out and template pauses reported on sends', async () => {
    const contactId = await newContact('+919855500005');
    const consent = createConsentService({ db: fx.dbs.app, clock: systemClock });
    await consent.recordConsent(await fx.ctx(c, c.agent), {
      contactId,
      purpose: 'marketing',
      action: 'opt_in',
    });
    const queued = await send('marketer', contactId, promoId, { body: ['Kiran'] });
    await dispatch(queued.messageId);
    const [msg] = await fx.query<{ external_message_id: string }>(
      'SELECT external_message_id FROM app.messages WHERE id = $1',
      [queued.messageId],
    );
    await fx.deliver(
      fx.messagesBody(c, {
        statuses: [
          {
            id: msg!.external_message_id,
            status: 'failed',
            timestamp: String(Math.floor(Date.now() / 1000)),
            recipient_id: '919855500005',
            errors: [{ code: 131050, title: 'User has stopped marketing messages' }],
          },
        ],
      }),
    );
    const [state] = await fx.query<{ status: string }>(
      `SELECT status FROM app.contact_consents WHERE tenant_id = $1 AND contact_id = $2 AND purpose = 'marketing'`,
      [c.tenant.id, contactId],
    );
    expect(state!.status).toBe('opted_out');

    const other = await newContact('+919855500006');
    const utility = await send('agent', other, utilityId, {
      header: ['A-9'],
      body: ['Nia', 'A-9'],
    });
    fx.standIn.state.sendQueue.push({
      kind: 'error',
      status: 400,
      code: 132015,
      message: 'Template is paused',
    });
    expect(await dispatch(utility.messageId)).toMatchObject({ outcome: 'failed' });
    expect((await templateRow(utilityId)).status).toBe('paused');
    await expectAppError(
      send('agent', other, utilityId, { header: ['A-9'], body: ['Nia', 'A-9'] }),
      'precondition_failed',
      /approved/,
    );
  });

  it('keeps templates and their sends inside the company', async () => {
    const other = await fx.company();
    const ctx = await fx.ctx(other, other.owner);
    await expectAppError(templates.getTemplate(ctx, promoId), 'not_found');
    await expectAppError(templates.submitTemplate(ctx, promoId), 'not_found');
    const contactId = await newContact('+919855500007');
    await expectAppError(
      queueTemplateMessage(
        { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock },
        ctx,
        {
          contactId,
          channelAccountId: c.channelAccountId,
          templateId: promoId,
          params: { header: [], body: ['x'] },
          clientKey: `ck_${uuidv7()}`,
        },
      ),
      'not_found',
    );
  });
});
