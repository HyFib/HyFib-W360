import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import {
  apiContactChanges,
  apiErrorResponse,
  apiGetContact,
  apiRecordConsent,
  apiUpdateContact,
  authenticateApiToken,
  createApiKeysService,
  createAutomationService,
  createConsentService,
  createContactMergeService,
  createContactsService,
  createCrmService,
  queueTextMessage,
  type ApiContext,
  type AutomationTrigger,
  type TenantContext,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Merging two contacts (H-019, ADR-224) against real PostgreSQL: everything of the merged contact
 * moves to the kept one (identities, conversations, consent history, tags, field values, CRM deals,
 * tasks and timeline, campaign rows, automation runs), the stricter consent stands, the merged
 * contact is deleted with a record of the merge, and the refusals hold under the function's own
 * checks. Also: a customer WhatsApp names by user id and by number no longer fails the receipt, and
 * a reply goes to the identity that has a number. For keys (ADR-225): a merged contact's id answers
 * 404 naming the contact it belongs to now, and the change feed lists the contacts merged into each
 * contact it reads.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx?.close();
});

const contactsSvc = () => createContactsService({ db: fx.dbs.app, clock: systemClock });
const consentSvc = () => createConsentService({ db: fx.dbs.app, clock: systemClock });
const merges = () => createContactMergeService({ db: fx.dbs.app, clock: systemClock });
const crm = () =>
  createCrmService({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
const automations = () =>
  createAutomationService({
    db: fx.dbs.app,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
  });
const outbound = () => ({ db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock });

const phone = () => `+91${randomInt(7_000_000_000, 9_999_999_999)}`;

/** A key of the company with the contact scopes, and the context a request with it gets. */
async function contactsKey(c: Company): Promise<ApiContext> {
  const created = await createApiKeysService({ db: fx.dbs.app, clock: systemClock }).create(
    await fx.ctx(c, c.owner),
    { name: 'Contact sync', scopes: ['contacts.read', 'contacts.write'], expiresInDays: 0 },
  );
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

/** The API error a call answers with, as the client receives it. */
async function apiRefusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const { status, body } = apiErrorResponse(error, 'req');
    return { status, ...body.error };
  }
  throw new Error('expected a refusal');
}
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;
const userId = () => `IN.${randomBytes(8).toString('hex')}`;

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

interface MetaBody {
  entry: {
    changes: {
      value: { messages: Record<string, unknown>[]; contacts: Record<string, unknown>[] };
    }[];
  }[];
}

/** A customer writing with their WhatsApp user id, and their number when `wa` is given. */
async function writesByUserId(c: Company, input: { user: string; wa?: string; text?: string }) {
  const body = fx.messagesBody(c, {
    messages: [{ text: input.text ?? 'Hello', ...(input.wa ? { waId: input.wa } : {}) }],
  }) as MetaBody;
  const value = body.entry[0]!.changes[0]!.value;
  if (!input.wa) value.messages[0]!.from = input.user;
  value.contacts[0]!.user_id = input.user;
  return fx.deliver(body);
}

async function contactOf(c: Company, key: { bsuid: string } | { waId: string }) {
  const [row] = await fx.query<{ contact_id: string }>(
    'bsuid' in key
      ? 'SELECT contact_id FROM app.contact_identities WHERE tenant_id = $1 AND bsuid = $2'
      : 'SELECT contact_id FROM app.contact_identities WHERE tenant_id = $1 AND wa_id = $2',
    [c.tenant.id, 'bsuid' in key ? key.bsuid : key.waId],
  );
  if (!row) throw new Error('no such identity');
  return row.contact_id;
}

const rowsOf = (table: string, column: string, contactId: string) =>
  fx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.${table} WHERE ${column} = $1`, [
    contactId,
  ]);

const keyword = (...keywords: string[]): AutomationTrigger => ({
  type: 'keyword',
  keywords,
  match: 'contains',
  hours: 'any',
  cooldownMinutes: 0,
});

async function publish(owner: TenantContext, name: string, trigger: AutomationTrigger) {
  const svc = automations();
  const { id } = await svc.createAutomation(owner, { name });
  const saved = await svc.updateAutomation(owner, {
    id,
    expectedVersion: 0,
    name,
    description: null,
    channelAccountId: null,
    trigger,
    graph: {
      version: 1,
      start: 'hi',
      nodes: [{ id: 'hi', type: 'send_text', text: 'Hi there', next: null }],
    },
  });
  await svc.publishAutomation(owner, { id, expectedVersion: saved.version, note: null });
  return id;
}

/** A draft campaign with one row per contact, in the given states. */
async function campaign(c: Company, rows: { contactId: string; state: string; skip?: string }[]) {
  const id = uuidv7();
  await fx.query(
    `INSERT INTO app.campaigns (id, tenant_id, name, timezone) VALUES ($1, $2, 'Diwali', 'Asia/Kolkata')`,
    [id, c.tenant.id],
  );
  for (const r of rows) {
    await fx.query(
      `INSERT INTO app.campaign_recipients (id, tenant_id, campaign_id, contact_id, state, skip_reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv7(), c.tenant.id, id, r.contactId, r.state, r.skip ?? null],
    );
  }
  return id;
}

describe('merging contacts (ADR-224)', () => {
  it('moves the merged contact’s records to the kept contact and deletes it', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const contacts = contactsSvc();
    await contacts.createField(owner, { label: 'City', type: 'text' });
    await contacts.createField(owner, { label: 'Tier', type: 'text' });
    const keptPhone = phone();
    const { id: keep } = await contacts.createContact(owner, {
      displayName: 'Asha Rao',
      phone: keptPhone,
      email: 'asha@example.com',
      tags: ['vip'],
      attributes: { city: 'Pune' },
    });

    // The same person writes by WhatsApp user id only: a second contact, without a number. An
    // automation answers twice (one run stopped, one still running).
    await publish(owner, 'Greeting', keyword('menu'));
    const bsuid = userId();
    await writesByUserId(c, { user: bsuid, text: 'menu please' });
    const merge = await contactOf(c, { bsuid });
    const [firstRun] = await fx.query<{ id: string }>(
      'SELECT id FROM app.automation_runs WHERE contact_id = $1',
      [merge],
    );
    await automations().stopRun(owner, firstRun!.id);
    await writesByUserId(c, { user: bsuid, text: 'menu again' });
    await contacts.updateContact(owner, merge, {
      displayName: 'Priya Customer',
      attributes: { city: 'Mumbai', tier: 'gold' },
    });
    await contacts.addTags(owner, merge, ['store', 'vip']);
    const consent = consentSvc();
    await consent.recordConsent(owner, { contactId: keep, purpose: 'marketing', action: 'opt_in' });
    await consent.recordConsent(owner, {
      contactId: merge,
      purpose: 'marketing',
      action: 'opt_out',
    });
    await consent.recordConsent(owner, { contactId: merge, purpose: 'utility', action: 'opt_in' });

    // CRM: a deal with a note and a task, and a note about the contact.
    const svc = crm();
    const { id: pipelineId } = await svc.createPipeline(owner, {
      name: 'Sales',
      currency: 'INR',
      stages: ['New'],
    });
    const [pipeline] = (await svc.listPipelines(owner)).filter((p) => p.id === pipelineId);
    const { id: dealId } = await svc.createDeal(owner, {
      contactId: merge,
      pipelineId,
      stageId: pipeline!.stages[0]!.id,
      title: 'Annual plan',
    });
    await svc.addNote(owner, { dealId, body: 'Wants a quote.' });
    await svc.addNote(owner, { contactId: merge, body: 'Prefers WhatsApp.' });
    await svc.createTask(owner, {
      title: 'Send the quote',
      dealId,
      assigneeMembershipId: owner.membership.id,
      dueAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    // Campaigns: one sent to the merged contact where the kept one was skipped, one waiting for
    // both, one only the merged contact was in.
    const sentToMerged = await campaign(c, [
      { contactId: keep, state: 'skipped', skip: 'no_marketing_opt_in' },
      { contactId: merge, state: 'queued' },
    ]);
    const waitingForBoth = await campaign(c, [
      { contactId: keep, state: 'pending' },
      { contactId: merge, state: 'pending' },
    ]);
    const onlyMerged = await campaign(c, [
      { contactId: merge, state: 'skipped', skip: 'no_phone' },
    ]);

    // An endpoint taking contact and consent events, so the merge's own events are visible.
    await fx.query(
      `INSERT INTO app.webhook_endpoints (id, tenant_id, url, event_types, secret_ciphertext,
         created_by_user_id)
       VALUES ($1, $2, 'https://hooks.example.test/w360', ARRAY['contact.updated', 'consent.changed'],
         'not-a-secret', $3)`,
      [uuidv7(), c.tenant.id, c.owner.id],
    );
    const eventsBefore = await fx.query<{ id: string }>(
      'SELECT id FROM app.webhook_events WHERE tenant_id = $1',
      [c.tenant.id],
    );

    // The review shows what will happen.
    const preview = await merges().previewMerge(owner, keep, merge);
    expect(preview.plan).toMatchObject({
      refusals: [],
      displayName: 'Asha Rao',
      phoneE164: keptPhone,
      email: 'asha@example.com',
      attributes: { city: 'Pune', tier: 'gold' },
      droppedAttributes: ['city'],
      droppedName: 'Priya Customer',
      tags: ['store', 'vip'],
      consent: {
        marketing: { result: 'opted_out', carriedOptOut: true },
        utility: { result: null, optInNotCarried: true },
      },
    });
    expect(preview.merge.counts).toMatchObject({
      consentEvents: 2,
      deals: 1,
      tasks: 1,
      notes: 4,
      campaignSends: 3,
      automationRuns: 2,
    });
    expect(preview.merge.identities).toEqual([
      expect.objectContaining({ waId: null, hasBsuid: true }),
    ]);

    const summary = await merges().mergeContacts(owner, {
      keepContactId: keep,
      mergeContactId: merge,
    });
    expect(summary).toEqual({
      identities: 1,
      conversations: 1,
      consentEvents: 2,
      tags: 1,
      deals: 1,
      tasks: 1,
      notes: 4,
      orders: 0,
      storeMessages: 0,
      campaignSends: 2,
      automationRuns: 2,
      flowSends: 0,
      flowAnswers: 0,
      conversationSources: 0,
      optOutsCarried: ['marketing'],
    });

    // The merged contact is gone, with a record of the merge and an audit entry.
    expect(await fx.query('SELECT 1 FROM app.contacts WHERE id = $1', [merge])).toEqual([]);
    expect(await merges().mergedInto(owner, merge)).toEqual({
      keptContactId: keep,
      mergedAt: expect.any(Date),
    });
    const [record] = await fx.query<{ merged_by_user_id: string; summary: unknown }>(
      'SELECT merged_by_user_id, summary FROM app.contact_merges WHERE merged_contact_id = $1',
      [merge],
    );
    expect(record).toEqual({ merged_by_user_id: c.owner.id, summary });
    const [audit] = await fx.query<{ subject_id: string; metadata: Record<string, unknown> }>(
      `SELECT subject_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'contact.merged'`,
      [c.tenant.id],
    );
    expect(audit).toEqual({ subject_id: keep, metadata: { mergedContactId: merge, ...summary } });

    // The kept contact keeps its own details and takes the gaps; identities, conversations,
    // consent history, tags, CRM records, runs and campaign rows are its own now.
    const [kept] = await fx.query<{
      display_name: string;
      phone_e164: string;
      email: string;
      attributes: unknown;
    }>('SELECT display_name, phone_e164, email, attributes FROM app.contacts WHERE id = $1', [
      keep,
    ]);
    expect(kept).toEqual({
      display_name: 'Asha Rao',
      phone_e164: keptPhone,
      email: 'asha@example.com',
      attributes: { city: 'Pune', tier: 'gold' },
    });
    expect(await contactOf(c, { bsuid })).toBe(keep);
    for (const [table, n] of [
      ['contact_identities', 1],
      ['conversations', 1],
      ['crm_deals', 1],
      ['crm_tasks', 1],
      ['crm_activities', 4],
      ['automation_runs', 2],
      ['campaign_recipients', 3],
    ] as const) {
      expect(await rowsOf(table, 'contact_id', keep), table).toEqual([{ n }]);
    }
    const tags = await fx.query<{ tag: string }>(
      'SELECT tag FROM app.contact_tags WHERE contact_id = $1 ORDER BY tag',
      [keep],
    );
    expect(tags.map((t) => t.tag)).toEqual(['store', 'vip']);
    const runs = await fx.query<{ status: string }>(
      'SELECT status FROM app.automation_runs WHERE contact_id = $1 ORDER BY started_at',
      [keep],
    );
    expect(runs.map((r) => r.status)).toEqual(['stopped', 'running']);
    const recipients = await fx.query<{ campaign_id: string; state: string }>(
      'SELECT campaign_id, state FROM app.campaign_recipients WHERE contact_id = $1',
      [keep],
    );
    expect(Object.fromEntries(recipients.map((r) => [r.campaign_id, r.state]))).toEqual({
      [sentToMerged]: 'queued',
      [waitingForBoth]: 'pending',
      [onlyMerged]: 'skipped',
    });

    // Consent: the merged contact's history moved whole; its opt-out stands as a merge event, and
    // its utility opt-in did not carry over.
    const history = await fx.query<{ purpose: string; action: string; source: string }>(
      `SELECT purpose, action, source FROM app.consent_events WHERE contact_id = $1
        ORDER BY occurred_at, id`,
      [keep],
    );
    expect(history).toEqual([
      { purpose: 'marketing', action: 'opt_in', source: 'agent' },
      { purpose: 'marketing', action: 'opt_out', source: 'agent' },
      { purpose: 'utility', action: 'opt_in', source: 'agent' },
      { purpose: 'marketing', action: 'opt_out', source: 'merge' },
    ]);
    const states = await fx.query<{ purpose: string; status: string }>(
      'SELECT purpose, status FROM app.contact_consents WHERE contact_id = $1 ORDER BY purpose',
      [keep],
    );
    expect(states).toEqual([{ purpose: 'marketing', status: 'opted_out' }]);

    // Webhooks: the kept contact changed and its consent changed; nothing names the deleted one.
    const events = await fx.query<{
      type: string;
      contact_id: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT type, contact_id, detail FROM app.webhook_events
        WHERE tenant_id = $1 AND NOT (id = ANY ($2::uuid[])) ORDER BY type`,
      [c.tenant.id, eventsBefore.map((e) => e.id)],
    );
    expect(events.map((e) => [e.type, e.contact_id])).toEqual([
      ['consent.changed', keep],
      ['contact.updated', keep],
    ]);
    expect(events[0]!.detail).toMatchObject({
      purpose: 'marketing',
      action: 'opt_out',
      source: 'merge',
    });

    // The customer writing again by user id reaches the kept contact's conversation.
    await writesByUserId(c, { user: bsuid, text: 'Still there?' });
    expect(await rowsOf('conversations', 'contact_id', keep)).toEqual([{ n: 1 }]);
  });

  it('refuses contacts that cannot be merged, under its own checks', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const contacts = contactsSvc();
    const svc = merges();
    const withPhone = (await contacts.createContact(owner, { displayName: 'A', phone: phone() }))
      .id;
    const otherPhone = (await contacts.createContact(owner, { displayName: 'B', phone: phone() }))
      .id;
    const merge = (input: { keep: string; merge: string }, ctx = owner) =>
      svc.mergeContacts(ctx, { keepContactId: input.keep, mergeContactId: input.merge });

    // Owners and administrators only.
    await expectAppError(
      merge({ keep: withPhone, merge: otherPhone }, await fx.ctx(c, c.agent)),
      'forbidden',
    );
    await expectAppError(
      merge({ keep: withPhone, merge: otherPhone }, await fx.ctx(c, c.marketer)),
      'forbidden',
    );
    // The same contact twice, a contact of no one, another company's contact.
    await expectAppError(merge({ keep: withPhone, merge: withPhone }), 'conflict', /into itself/);
    await expectAppError(merge({ keep: withPhone, merge: uuidv7() }), 'not_found');
    const d = await fx.company();
    const theirs = (
      await contacts.createContact(await fx.ctx(d, d.owner), { displayName: 'D', phone: phone() })
    ).id;
    await expectAppError(merge({ keep: withPhone, merge: theirs }), 'not_found');
    await expectAppError(svc.previewMerge(owner, withPhone, theirs), 'not_found');
    // Two numbers.
    await expectAppError(
      merge({ keep: withPhone, merge: otherPhone }),
      'precondition_failed',
      /Both contacts have a phone number/,
    );

    // Conversations of both on the same company number.
    const first = userId();
    const second = userId();
    await writesByUserId(c, { user: first });
    await writesByUserId(c, { user: second });
    const byFirst = await contactOf(c, { bsuid: first });
    const bySecond = await contactOf(c, { bsuid: second });
    expect((await svc.previewMerge(owner, byFirst, bySecond)).plan.refusals).toEqual([
      { code: 'same_number', channelName: expect.anything() },
    ]);
    await expectAppError(
      merge({ keep: byFirst, merge: bySecond }),
      'precondition_failed',
      /conversation on the same WhatsApp number/,
    );

    // A message to the merged contact being sent: the merge waits for its answer.
    const sending = userId();
    await writesByUserId(c, { user: sending });
    const bySending = await contactOf(c, { bsuid: sending });
    const [conv] = await fx.query<{ id: string }>(
      'SELECT id FROM app.conversations WHERE contact_id = $1',
      [bySending],
    );
    const [inbound] = await fx.query<{ id: string }>(
      'SELECT id FROM app.messages WHERE conversation_id = $1',
      [conv!.id],
    );
    const intent = uuidv7();
    await fx.query(
      `INSERT INTO app.send_intents (id, tenant_id, message_id, channel_account_id, request, state,
         lease_until)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, 'sending', now() + interval '1 minute')`,
      [intent, c.tenant.id, inbound!.id, c.channelAccountId],
    );
    await expectAppError(merge({ keep: withPhone, merge: bySending }), 'conflict', /being sent/);
    await fx.query(
      `UPDATE app.send_intents SET state = 'accepted', lease_until = NULL WHERE id = $1`,
      [intent],
    );

    // A campaign sent to both.
    const both = userId();
    await writesByUserId(c, { user: both });
    const byBoth = await contactOf(c, { bsuid: both });
    const sentTwice = await campaign(c, [
      { contactId: withPhone, state: 'queued' },
      { contactId: byBoth, state: 'queued' },
    ]);
    await expectAppError(
      merge({ keep: withPhone, merge: byBoth }),
      'precondition_failed',
      /sent the same campaign/,
    );
    await fx.query('DELETE FROM app.campaign_recipients WHERE campaign_id = $1', [sentTwice]);

    // Fifty-one tags between them.
    await contacts.addTags(
      owner,
      withPhone,
      Array.from({ length: 26 }, (_, i) => `a${i}`),
    );
    await contacts.addTags(
      owner,
      byBoth,
      Array.from({ length: 25 }, (_, i) => `b${i}`),
    );
    await expectAppError(
      merge({ keep: withPhone, merge: byBoth }),
      'precondition_failed',
      /more than 50 tags/,
    );

    // An erased contact.
    await contacts.eraseContact(owner, { contactId: bySecond, suppress: false });
    await expectAppError(merge({ keep: withPhone, merge: bySecond }), 'conflict', /erased/);

    // Nothing was merged or deleted by the refusals.
    expect(
      await fx.query('SELECT 1 FROM app.contact_merges WHERE tenant_id = $1', [c.tenant.id]),
    ).toEqual([]);
    for (const id of [withPhone, otherPhone, byFirst, bySecond, bySending, byBoth]) {
      expect(await fx.query('SELECT 1 FROM app.contacts WHERE id = $1', [id]), id).toHaveLength(1);
    }
  });

  it('joins a customer known by number and by user id, and replies to the number', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const second = await fx.addNumber(c);
    // The customer wrote to one number by phone, then to another by user id only: two contacts.
    const wa = waId();
    const bsuid = userId();
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: wa, text: 'Hi' }] }));
    await writesByUserId(second, { user: bsuid, text: 'Hi again' });
    const byNumber = await contactOf(c, { waId: wa });
    const byUser = await contactOf(c, { bsuid });
    expect(byUser).not.toBe(byNumber);

    // A message naming both the user id and the number: before, taking the number for the user
    // id's identity broke the unique index and failed the whole receipt. The number's identity
    // keeps it, and the message joins the contact the user id names.
    expect(await writesByUserId(second, { user: bsuid, wa, text: 'Both' })).toMatchObject({
      outcome: 'processed',
    });
    const identities = await fx.query<{
      contact_id: string;
      wa_id: string | null;
      bsuid: string | null;
    }>(
      `SELECT contact_id, wa_id, bsuid FROM app.contact_identities WHERE tenant_id = $1
        ORDER BY created_at, id`,
      [c.tenant.id],
    );
    expect(identities).toEqual([
      { contact_id: byNumber, wa_id: wa, bsuid: null },
      { contact_id: byUser, wa_id: null, bsuid },
    ]);

    await merges().mergeContacts(owner, { keepContactId: byNumber, mergeContactId: byUser });
    // After the merge both identities are the kept contact's, and the same message still passes.
    expect(await writesByUserId(second, { user: bsuid, wa, text: 'Both again' })).toMatchObject({
      outcome: 'processed',
    });
    const threads = await fx.query<{ id: string; channel_account_id: string }>(
      'SELECT id, channel_account_id FROM app.conversations WHERE contact_id = $1',
      [byNumber],
    );
    expect(threads).toHaveLength(2);

    // A reply in the conversation that came by user id goes to the number of the other identity.
    const viaUser = threads.find((t) => t.channel_account_id === second.channelAccountId)!;
    const { messageId } = await queueTextMessage(outbound(), owner, {
      conversationId: viaUser.id,
      text: 'How can we help?',
      clientKey: `k${randomInt(1e9)}xxxxxxxx`,
    });
    const [intent] = await fx.query<{ request: { to?: string } }>(
      'SELECT request FROM app.send_intents WHERE message_id = $1',
      [messageId],
    );
    expect(intent!.request.to).toBe(wa);
  });

  it('follows earlier merges into the contact kept last', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const contacts = contactsSvc();
    const kept = (await contacts.createContact(owner, { displayName: 'Kept', phone: phone() })).id;
    const users = [userId(), userId()];
    // Two contacts by user id on two numbers of the company, each merged in turn.
    const other = await fx.addNumber(c);
    await writesByUserId(c, { user: users[0]! });
    await writesByUserId(other, { user: users[1]! });
    const first = await contactOf(c, { bsuid: users[0]! });
    const second = await contactOf(c, { bsuid: users[1]! });
    await merges().mergeContacts(owner, { keepContactId: first, mergeContactId: second });
    expect(await merges().mergedInto(owner, second)).toMatchObject({ keptContactId: first });
    await merges().mergeContacts(owner, { keepContactId: kept, mergeContactId: first });
    // Both earlier contacts now lead to the contact kept last.
    expect(await merges().mergedInto(owner, second)).toMatchObject({ keptContactId: kept });
    expect(await merges().mergedInto(owner, first)).toMatchObject({ keptContactId: kept });
    expect(await rowsOf('contact_identities', 'contact_id', kept)).toEqual([{ n: 2 }]);
    // A member of another company cannot see the merges.
    const d = await fx.company();
    expect(await merges().mergedInto(await fx.ctx(d, d.owner), second)).toBeNull();

    // Keys (ADR-225): a merged contact is not found, and the refusal names the contact it belongs
    // to now, through the later merge too; nothing is changed or recorded for it.
    const key = await contactsKey(c);
    const consentBefore = await rowsOf('consent_events', 'contact_id', kept);
    const merged = {
      status: 404,
      code: 'not_found',
      message: 'This contact was merged into another contact.',
      reason: 'contact_merged',
      mergedInto: kept,
    };
    for (const id of [first, second]) {
      expect(await apiRefusal(apiGetContact(outbound(), key, id)), id).toEqual(merged);
      expect(
        await apiRefusal(apiUpdateContact(outbound(), key, id, { name: 'Renamed' })),
        id,
      ).toEqual(merged);
      expect(
        await apiRefusal(
          apiRecordConsent(outbound(), key, id, {
            purpose: 'marketing',
            action: 'opt_out',
            evidence: 'Asked by phone',
          }),
        ),
        id,
      ).toEqual(merged);
    }
    expect(await rowsOf('consent_events', 'contact_id', kept)).toEqual(consentBefore);
    // Another company's key, and an id that never was a contact: plainly not found.
    for (const [ctx, id] of [
      [await contactsKey(d), second],
      [key, uuidv7()],
    ] as const) {
      expect(await apiRefusal(apiGetContact(outbound(), ctx, id))).toEqual({
        status: 404,
        code: 'not_found',
        message: 'Contact not found.',
      });
    }
    // The change feed reads the kept contact, naming both merged contacts, oldest merge first;
    // the merged contacts are not read.
    const feed = await apiContactChanges({ db: fx.dbs.app, keyring: fx.keyring }, key, {
      limit: 100,
    });
    expect(feed.data.map((ch) => [ch.id, ch.mergedContactIds])).toEqual([[kept, [second, first]]]);
    // Erasing the kept contact keeps the records of the merges, which hold no personal data.
    await contacts.eraseContact(owner, { contactId: kept, suppress: false });
    expect(
      await fx.query('SELECT 1 FROM app.contact_merges WHERE kept_contact_id = $1', [kept]),
    ).toHaveLength(2);
  });
});
