import { randomInt } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, type Clock } from '@w360/core';
import { DEFAULT_EGRESS_POLICY, createEgressClient } from '@w360/core/egress';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  STARTER_FLOW_JSON,
  createContactsService,
  createFlowsService,
  createWebRequestService,
  generateFlowKeyPair,
  giveUpFlowSync,
  handleFlowEndpoint,
  processFlowKeys,
  processFlowSync,
  processSendIntent,
  type FlowWorkerDeps,
  type TenantContext,
} from '@w360/domain';
import { whatsappFlowRequest } from '../support/flow-request';
import { acceptInvitation, createUser, invite, type TestUser } from './helpers';
import {
  APP_SECRET,
  startWhatsAppFixture,
  type Company,
  type WhatsAppFixture,
} from './whatsapp-fixture';

/**
 * WhatsApp Flows against real PostgreSQL and the test-only Graph stand-in: drafts checked and sent
 * to Meta through the write-ahead worker (including a lost create response, validation errors,
 * publish, deprecate, duplicate and delete), permissions, flow keys uploaded to numbers and rotated,
 * sending a form and applying its answers, erasure, the encrypted data endpoint forwarding to a
 * local company endpoint, and company isolation.
 */
let fx: WhatsAppFixture;
let target: Server;
let port = 0;
const received: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let targetAnswer: { status: number; body: unknown } = { status: 200, body: {} };
const HOST = 'forms.shop.test';

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  target = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(targetAnswer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(targetAnswer.body));
    });
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  port = (target.address() as AddressInfo).port;
});
afterAll(async () => {
  target?.closeAllConnections();
  await new Promise((resolve) => target?.close(resolve));
  await fx?.close();
});

const APP_BASE = 'https://app.example.test';
const rate = { capacity: 1000, refillPerSecond: 1000 };
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;
const later = (ms: number): Clock => ({ now: () => new Date(Date.now() + ms) });

const flowsService = (clock: Clock = systemClock) =>
  createFlowsService({
    db: fx.dbs.app,
    clock,
    jobs: fx.jobs(),
    signer: fx.signer,
    appBaseUrl: APP_BASE,
    allowInsecureHttp: true,
  });
const workerDeps = (clock: Clock = systemClock): FlowWorkerDeps => ({
  db: fx.dbs.app,
  keyring: fx.keyring,
  graph: fx.graph,
  clock,
  appBaseUrl: APP_BASE,
});
const scopeOf = (c: Company) => authorizedTenantScope(c.tenant.id, null);
const sync = (c: Company, flowId: string, clock?: Clock) =>
  processFlowSync(workerDeps(clock), scopeOf(c), flowId);

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

async function member(c: Company, role: string): Promise<TestUser> {
  const user = await createUser(fx.dbs, { name: `A ${role}` });
  const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, [role]);
  await acceptInvitation(fx.dbs, user, token);
  return user;
}

async function flowRow(id: string) {
  const [row] = await fx.query<Record<string, unknown>>(`SELECT * FROM app.flows WHERE id = $1`, [
    id,
  ]);
  return row!;
}

const ENDPOINT_JSON = JSON.stringify({
  version: '7.1',
  data_api_version: '3.0',
  routing_model: { START: [] },
  screens: [
    {
      id: 'START',
      title: 'Book',
      terminal: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'Footer',
            label: 'Book',
            'on-click-action': { name: 'data_exchange', payload: { slot: '${form.slot}' } },
          },
        ],
      },
    },
  ],
});

/** A published flow of the company's account (created, uploaded and published through the worker). */
async function publishedFlow(
  c: Company,
  owner: TenantContext,
  json = STARTER_FLOW_JSON,
  name = 'Details',
) {
  const svc = flowsService();
  const { id } = await svc.create(owner, {
    whatsappAccountId: c.whatsappAccountId,
    name,
    categories: ['LEAD_GENERATION'],
    json,
  });
  expect(await sync(c, id)).toBe('done');
  const row = await flowRow(id);
  await svc.publish(owner, { id, expectedVersion: row.version as number });
  expect(await sync(c, id)).toBe('done');
  return id;
}

async function conversationOf(c: Company, from: string) {
  const [row] = await fx.query<{ id: string; contact_id: string }>(
    `SELECT cv.id, cv.contact_id FROM app.conversations cv
       JOIN app.contact_identities i ON i.tenant_id = cv.tenant_id AND i.contact_id = cv.contact_id
      WHERE cv.tenant_id = $1 AND i.wa_id = $2`,
    [c.tenant.id, from],
  );
  if (!row) throw new Error('conversation not created');
  return row;
}

async function sendQueued(c: Company, conversationId: string) {
  const intents = await fx.query<{ id: string; actor_user_id: string | null }>(
    `SELECT s.id, s.actor_user_id FROM app.send_intents s
       JOIN app.messages m ON m.tenant_id = s.tenant_id AND m.id = s.message_id
      WHERE m.conversation_id = $1 AND s.state = 'queued' ORDER BY s.created_at`,
    [conversationId],
  );
  const outcomes = [];
  for (const intent of intents) {
    const result = await processSendIntent(
      {
        db: fx.dbs.app,
        keyring: fx.keyring,
        graph: fx.graph,
        clock: systemClock,
        rate,
        jobs: fx.jobs(),
        signer: fx.signer,
      },
      authorizedTenantScope(c.tenant.id, intent.actor_user_id),
      intent.id,
    );
    outcomes.push(result.outcome);
  }
  return outcomes;
}

/** The customer completes a form: an nfm_reply message with the token and answers (M-166). */
function completion(c: Company, from: string, responseJson: string) {
  return fx.messagesBody(c, {
    messages: [
      {
        waId: from,
        type: 'interactive',
        // A few seconds after the form was sent (webhook timestamps are whole seconds).
        timestamp: Math.floor(Date.now() / 1000) + 5,
        extra: {
          interactive: {
            type: 'nfm_reply',
            nfm_reply: { name: 'flow', body: 'Sent', response_json: responseJson },
          },
        },
      },
    ],
  });
}

describe('flows at Meta', () => {
  it('sends drafts to Meta, shows its validation errors, publishes, deprecates, duplicates and deletes', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    const agent = await fx.ctx(c, c.agent);
    const supervisor = await fx.ctx(c, await member(c, 'supervisor'));
    const svc = flowsService();

    await expectAppError(svc.list(agent), 'forbidden');
    await expectAppError(
      svc.create(supervisor, {
        whatsappAccountId: c.whatsappAccountId,
        name: 'x',
        categories: ['OTHER'],
        json: STARTER_FLOW_JSON,
      }),
      'forbidden',
    );
    await expectAppError(
      svc.create(marketer, {
        whatsappAccountId: c.whatsappAccountId,
        name: 'Bad',
        categories: ['OTHER'],
        json: '{"screens": []}',
      }),
      'validation_failed',
      /version/,
    );
    const { id } = await svc.create(marketer, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'Lead form',
      categories: ['LEAD_GENERATION'],
      json: STARTER_FLOW_JSON,
    });
    await expectAppError(
      svc.create(marketer, {
        whatsappAccountId: c.whatsappAccountId,
        name: 'lead FORM',
        categories: ['OTHER'],
        json: STARTER_FLOW_JSON,
      }),
      'validation_failed',
      /has this name/,
    );
    expect(await flowRow(id)).toMatchObject({
      sync_op: 'create',
      sync_state: 'queued',
      meta_flow_id: null,
    });

    // The worker creates it at Meta with a recognisable name and uploads the JSON as written.
    expect(await sync(c, id)).toBe('done');
    let row = await flowRow(id);
    expect(row).toMatchObject({
      sync_state: 'idle',
      sync_op: null,
      meta_status: 'DRAFT',
      validation_errors: [],
    });
    const remote = fx.standIn.state.flows.get(row.meta_flow_id as string)!;
    expect(remote.name).toMatch(/^Lead form \(w360 [a-z2-7]{8}\)$/);
    expect(remote.json).toBe(STARTER_FLOW_JSON);
    expect(remote.endpointUri).toBeNull();
    expect(row.preview_url).toMatch(/^https:\/\/business\.facebook\.com\//);
    const detail = await svc.get(supervisor, id);
    expect(detail).toMatchObject({
      canEdit: false,
      canPublish: false,
      flow: { unsentChanges: false },
    });

    // Meta's validation errors are kept and block publishing until fixed.
    fx.standIn.state.flowUploadErrors.push([
      {
        error: 'INVALID_PROPERTY',
        error_type: 'JSON_SCHEMA_ERROR',
        message: 'The property "x" cannot be specified.',
        line_start: 9,
        line_end: 9,
        column_start: 3,
        column_end: 8,
      },
    ]);
    const changed = STARTER_FLOW_JSON.replace('"Your details"', '"About you"');
    await svc.updateDraft(marketer, {
      id,
      expectedVersion: row.version as number,
      name: 'Lead form',
      categories: ['LEAD_GENERATION'],
      json: changed,
    });
    // One operation at a time: another change waits until Meta has the last one.
    row = await flowRow(id);
    await expectAppError(
      svc.updateDraft(marketer, {
        id,
        expectedVersion: row.version as number,
        name: 'Lead form',
        categories: ['LEAD_GENERATION'],
        json: STARTER_FLOW_JSON,
      }),
      'conflict',
      /still processing/,
    );
    expect(await sync(c, id)).toBe('done');
    row = await flowRow(id);
    expect(row.validation_errors).toEqual([
      {
        error: 'INVALID_PROPERTY',
        errorType: 'JSON_SCHEMA_ERROR',
        message: 'The property "x" cannot be specified.',
        lineStart: 9,
        lineEnd: 9,
        columnStart: 3,
        columnEnd: 8,
      },
    ]);
    expect(remote.json).toBe(changed);
    await expectAppError(
      svc.publish(owner, { id, expectedVersion: row.version as number }),
      'conflict',
      /problems Meta found/,
    );
    await expectAppError(
      svc.publish(marketer, { id, expectedVersion: row.version as number }),
      'forbidden',
    );
    await svc.updateDraft(marketer, {
      id,
      expectedVersion: row.version as number,
      name: 'Lead form',
      categories: ['LEAD_GENERATION'],
      json: STARTER_FLOW_JSON,
    });
    expect(await sync(c, id)).toBe('done');
    row = await flowRow(id);
    expect(row.validation_errors).toEqual([]);

    // Publishing is irreversible: the draft can no longer change; a new draft can be made from it.
    await svc.publish(owner, { id, expectedVersion: row.version as number });
    expect(await sync(c, id)).toBe('done');
    row = await flowRow(id);
    expect(row.meta_status).toBe('PUBLISHED');
    expect(remote.status).toBe('PUBLISHED');
    await expectAppError(
      svc.updateDraft(owner, {
        id,
        expectedVersion: row.version as number,
        name: 'Lead form',
        categories: ['OTHER'],
        json: STARTER_FLOW_JSON,
      }),
      'conflict',
      /new draft/,
    );
    const copy = await svc.duplicate(marketer, { id });
    expect(await flowRow(copy.id)).toMatchObject({
      derived_from_flow_id: id,
      sync_op: 'create',
      flow_json: STARTER_FLOW_JSON,
    });

    await svc.deprecate(owner, { id, expectedVersion: row.version as number });
    expect(await sync(c, id)).toBe('done');
    row = await flowRow(id);
    expect(row.meta_status).toBe('DEPRECATED');
    await svc.setArchived(marketer, { id, expectedVersion: row.version as number }, true);
    expect((await svc.list(marketer)).map((f) => f.id)).toEqual([copy.id]);

    // Deleting a draft deletes it at Meta too.
    expect(await sync(c, copy.id)).toBe('done');
    const copyRow = await flowRow(copy.id);
    const copyMetaId = copyRow.meta_flow_id as string;
    expect(fx.standIn.state.flows.has(copyMetaId)).toBe(true);
    await svc.remove(marketer, { id: copy.id, expectedVersion: copyRow.version as number });
    expect(await sync(c, copy.id)).toBe('done');
    expect(fx.standIn.state.flows.has(copyMetaId)).toBe(false);
    expect(await flowRow(copy.id)).toMatchObject({ meta_flow_id: null, meta_status: null });
    expect((await flowRow(copy.id)).archived_at).not.toBeNull();

    // A restored draft is sent to Meta again by saving it, even unchanged; saving a draft Meta
    // already has changes nothing.
    let restored = await flowRow(copy.id);
    await svc.setArchived(
      marketer,
      { id: copy.id, expectedVersion: restored.version as number },
      false,
    );
    restored = await flowRow(copy.id);
    const draftInput = {
      id: copy.id,
      name: restored.name as string,
      categories: restored.categories as string[],
      json: restored.flow_json as string,
    };
    expect(
      await svc.updateDraft(marketer, {
        ...draftInput,
        expectedVersion: restored.version as number,
      }),
    ).toEqual({ version: (restored.version as number) + 1, syncing: true });
    expect(await flowRow(copy.id)).toMatchObject({ sync_op: 'create', sync_state: 'queued' });
    expect(await sync(c, copy.id)).toBe('done');
    restored = await flowRow(copy.id);
    expect(restored.meta_status).toBe('DRAFT');
    expect(
      await svc.updateDraft(marketer, {
        ...draftInput,
        expectedVersion: restored.version as number,
      }),
    ).toEqual({ version: restored.version, syncing: false });
    expect(await flowRow(copy.id)).toMatchObject({ sync_op: null, sync_state: 'idle' });

    const audit = await fx.query<{ action: string }>(
      `SELECT action FROM app.audit_events WHERE tenant_id = $1 AND action LIKE 'flow.%' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'flow.created',
      'flow.updated',
      'flow.updated',
      'flow.publish_requested',
      'flow.created',
      'flow.deprecate_requested',
      'flow.archived',
      'flow.deleted',
      'flow.restored',
    ]);
  });

  it('recovers from a lost create response without making a second flow, and reports refusals', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = flowsService();
    const { id } = await svc.create(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'Survey',
      categories: ['SURVEY'],
      json: STARTER_FLOW_JSON,
    });
    fx.standIn.state.flowCreateQueue.push({ kind: 'create_then_drop' });
    expect(await sync(c, id)).toBe('retry');
    expect(await sync(c, id)).toBe('done');
    const created = [...fx.standIn.state.flows.values()].filter((f) => f.wabaId === c.wabaId);
    expect(created.length).toBe(1);
    expect((await flowRow(id)).meta_flow_id).toBe(created[0]!.id);

    // A refusal fails the operation with Meta's message; trying again succeeds.
    const second = await svc.create(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'Contact',
      categories: ['CONTACT_US'],
      json: STARTER_FLOW_JSON,
    });
    fx.standIn.state.flowCreateQueue.push({
      kind: 'error',
      status: 400,
      code: 100,
      message: 'Invalid parameter',
    });
    expect(await sync(c, second.id)).toBe('done');
    let row = await flowRow(second.id);
    expect(row).toMatchObject({ sync_state: 'failed', sync_op: 'create' });
    expect(row.sync_error).toMatch(/Meta did not accept the change: Invalid parameter/);
    await svc.retry(owner, { id: second.id, expectedVersion: row.version as number });
    expect(await sync(c, second.id)).toBe('done');
    expect(await flowRow(second.id)).toMatchObject({ sync_state: 'idle', meta_status: 'DRAFT' });

    // Publishing a flow Meta already shows as published does not publish it again.
    row = await flowRow(id);
    await svc.publish(owner, { id, expectedVersion: row.version as number });
    fx.standIn.state.flows.get(row.meta_flow_id as string)!.status = 'PUBLISHED';
    const before = fx.standIn.state.requests.length;
    expect(await sync(c, id)).toBe('done');
    expect(fx.standIn.state.requests.slice(before).some((r) => r.path.endsWith('/publish'))).toBe(
      false,
    );

    // An operation left waiting for over 30 minutes is failed by the sweep instead of repeated.
    row = await flowRow(second.id);
    await svc.refresh(owner, { id: second.id, expectedVersion: row.version as number });
    await giveUpFlowSync({ db: fx.dbs.app, clock: later(31 * 60_000) }, scopeOf(c), second.id);
    expect(await flowRow(second.id)).toMatchObject({
      sync_state: 'failed',
      sync_error:
        'This did not finish within 30 minutes (Meta did not answer, or the company was suspended). Try again.',
    });
    expect(await sync(c, second.id)).toBe('skipped');
  });
});

describe('flow keys', () => {
  it('uploads the account key to each number, checks it, and rotates it with a grace period', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = flowsService();
    await svc.setupKeys(owner, { whatsappAccountId: c.whatsappAccountId });
    expect(await processFlowKeys(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    const status = await svc.keyStatus(owner, c.whatsappAccountId);
    expect(status.active?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(status.numbers).toEqual([
      expect.objectContaining({
        id: c.channelAccountId,
        uploadState: 'uploaded',
        signatureStatus: 'VALID',
        errorCode: null,
      }),
    ]);
    const uploaded = fx.standIn.state.businessKeys.get(c.phoneNumberId)!;
    expect(uploaded.pem).toContain('BEGIN PUBLIC KEY');
    // The private key is stored only encrypted.
    const [stored] = await fx.query<{ private_key_ciphertext: string; public_key_pem: string }>(
      `SELECT private_key_ciphertext, public_key_pem FROM app.flow_keys WHERE tenant_id = $1 AND state = 'active'`,
      [c.tenant.id],
    );
    expect(stored!.private_key_ciphertext).toMatch(/^v1:/);
    expect(stored!.private_key_ciphertext).not.toContain('PRIVATE KEY');
    // Form fields travel with CRLF line breaks; the key itself is the same.
    expect(stored!.public_key_pem.replace(/\s+/g, '')).toBe(uploaded.pem.replace(/\s+/g, ''));

    // A key Meta reports as mismatched is shown as such.
    fx.standIn.state.keySignatureStatus = 'MISMATCH';
    await svc.rotateKey(owner, { whatsappAccountId: c.whatsappAccountId });
    expect(await processFlowKeys(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    fx.standIn.state.keySignatureStatus = 'VALID';
    const rotated = await svc.keyStatus(owner, c.whatsappAccountId);
    expect(rotated.previous).toBe(true);
    expect(rotated.active!.fingerprint).not.toBe(status.active!.fingerprint);
    expect(rotated.numbers[0]).toMatchObject({
      signatureStatus: 'MISMATCH',
      errorCode: 'signature_mismatch',
    });

    // After the grace period the replaced key is retired and its private key deleted.
    expect(
      await processFlowKeys(workerDeps(later(25 * 3_600_000)), scopeOf(c), c.whatsappAccountId),
    ).toBe('done');
    const retired = await fx.query<{ state: string; private_key_ciphertext: string | null }>(
      `SELECT state, private_key_ciphertext FROM app.flow_keys WHERE tenant_id = $1 ORDER BY created_at`,
      [c.tenant.id],
    );
    expect(retired).toEqual([
      { state: 'retired', private_key_ciphertext: null },
      { state: 'active', private_key_ciphertext: expect.stringMatching(/^v1:/) },
    ]);
    await expectAppError(
      svc.rotateKey(await fx.ctx(c, c.marketer), { whatsappAccountId: c.whatsappAccountId }),
      'forbidden',
    );
  });
});

describe('sending forms and applying answers', () => {
  it('sends a published form in the service window and applies the answers to the contact', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const svc = flowsService();
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).createField(owner, {
      label: 'City',
      type: 'text',
    });
    const flowId = await publishedFlow(
      c,
      owner,
      STARTER_FLOW_JSON.replace(
        '"email": "${form.email}"',
        '"email": "${form.email}", "city": "Pune"',
      ),
    );
    let row = await flowRow(flowId);
    await svc.updateSettings(owner, {
      id: flowId,
      expectedVersion: row.version as number,
      mapping: [
        { key: 'full_name', target: 'name' },
        { key: 'email', target: 'email' },
        { key: 'city', target: 'field:city' },
      ],
      endpointUrl: '',
      endpointSecretName: '',
    });

    const priya = waId();
    await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: priya, text: 'I want to sign up' }] }),
    );
    const conv = await conversationOf(c, priya);
    expect(await svc.sendable(agent, conv.id)).toEqual([]);
    const sendable = await svc.sendable(owner, conv.id);
    expect(sendable).toEqual([{ id: flowId, name: 'Details', mode: 'published' }]);
    const sent = await svc.send(owner, {
      conversationId: conv.id,
      flowId,
      mode: 'published',
      header: '',
      body: 'Please share your details',
      footer: '',
      cta: 'Open form',
      clientKey: 'flow-send-0001',
    });
    expect(await sendQueued(c, conv.id)).toEqual(['accepted']);
    const request = fx.standIn.state.requests.filter((r) => r.path.endsWith('/messages')).pop()!;
    const [send] = await fx.query<{ token: string; mode: string }>(
      `SELECT token, mode FROM app.flow_sends WHERE message_id = $1`,
      [sent.messageId],
    );
    row = await flowRow(flowId);
    expect(request.body).toMatchObject({
      to: priya,
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: 'Please share your details' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_id: row.meta_flow_id,
            flow_cta: 'Open form',
            mode: 'published',
            flow_token: send!.token,
            flow_action: 'navigate',
          },
        },
      },
    });
    // A repeated submit (same client key) sends nothing twice.
    expect(
      (
        await svc.send(owner, {
          conversationId: conv.id,
          flowId,
          mode: 'published',
          header: '',
          body: 'x',
          footer: '',
          cta: 'Open',
          clientKey: 'flow-send-0001',
        })
      ).duplicate,
    ).toBe(true);

    // The customer completes it: answers are kept (without the token) and applied field by field.
    // The city holds half an emoji, as an escape: it is kept and applied with U+FFFD in its place
    // (ADR-131); jsonb refused the half before (22P02).
    await fx.deliver(
      completion(
        c,
        priya,
        JSON.stringify({
          flow_token: send!.token,
          full_name: 'Priya Sharma',
          email: 'PRIYA@Example.test',
          city: 'Pune\ud83d',
        }),
      ),
    );
    const [response] = await fx.query<{
      answers: Record<string, unknown>;
      applied: unknown[];
      flow_id: string;
    }>(`SELECT answers, applied, flow_id FROM app.flow_responses WHERE tenant_id = $1`, [
      c.tenant.id,
    ]);
    expect(response).toEqual({
      flow_id: flowId,
      answers: { full_name: 'Priya Sharma', email: 'PRIYA@Example.test', city: 'Pune\ufffd' },
      applied: [
        { key: 'full_name', target: 'name', outcome: 'applied' },
        { key: 'email', target: 'email', outcome: 'applied' },
        { key: 'city', target: 'field:city', outcome: 'applied' },
      ],
    });
    const [contact] = await fx.query<{
      display_name: string;
      email: string;
      attributes: Record<string, unknown>;
    }>(`SELECT display_name, email, attributes FROM app.contacts WHERE id = $1`, [conv.contact_id]);
    expect(contact).toEqual({
      display_name: 'Priya Sharma',
      // Stored as entered, like the contacts service does.
      email: 'PRIYA@Example.test',
      attributes: { city: 'Pune\ufffd' },
    });
    const [message] = await fx.query<{ content: Record<string, unknown>; preview: string }>(
      `SELECT m.content, cv.last_message_preview AS preview FROM app.messages m
         JOIN app.conversations cv ON cv.id = m.conversation_id
        WHERE m.conversation_id = $1 AND m.direction = 'inbound' ORDER BY m.created_at DESC LIMIT 1`,
      [conv.id],
    );
    expect(message!.content).toEqual({
      interactiveType: 'nfm_reply',
      reply: null,
      flow: {
        body: 'Sent',
        answers: { full_name: 'Priya Sharma', email: 'PRIYA@Example.test', city: 'Pune\ufffd' },
        tooLarge: false,
      },
    });
    expect(JSON.stringify(message!.content)).not.toContain(send!.token);
    expect(message!.preview).toBe('[Form submitted]');
    const [completed] = await fx.query<{ completed_at: Date | null }>(
      `SELECT completed_at FROM app.flow_sends WHERE token = $1`,
      [send!.token],
    );
    expect(completed!.completed_at).not.toBeNull();

    // Answers that do not fit are listed, not applied; an unknown token is kept without a flow.
    await fx.deliver(
      completion(
        c,
        priya,
        JSON.stringify({ flow_token: send!.token, full_name: '', email: 'not an email' }),
      ),
    );
    await fx.deliver(completion(c, priya, JSON.stringify({ flow_token: 'unused', note: 'hello' })));
    const all = await fx.query<{ flow_id: string | null; applied: unknown[] }>(
      `SELECT flow_id, applied FROM app.flow_responses WHERE tenant_id = $1 ORDER BY received_at, created_at`,
      [c.tenant.id],
    );
    expect(all.slice(1)).toEqual([
      {
        flow_id: flowId,
        applied: [
          { key: 'full_name', target: 'name', outcome: 'missing' },
          {
            key: 'email',
            target: 'email',
            outcome: 'invalid',
            message: 'The email address is not valid.',
          },
          { key: 'city', target: 'field:city', outcome: 'missing' },
        ],
      },
      { flow_id: null, applied: [] },
    ]);
    const page = await svc.responses(owner, flowId);
    expect(page.withAnswers).toBe(true);
    expect(page.responses.length).toBe(2);
    const analyst = await fx.ctx(c, await member(c, 'analyst'));
    const hidden = await svc.responses(analyst, flowId);
    expect(hidden.withAnswers).toBe(false);
    expect(hidden.responses[0]).not.toHaveProperty('answers');

    // The token names the contact the form was sent to: completed by anyone else, it changes nobody.
    const arjun = waId();
    await fx.deliver(
      completion(
        c,
        arjun,
        JSON.stringify({
          flow_token: send!.token,
          full_name: 'Not Priya',
          email: 'x@example.test',
        }),
      ),
    );
    const misdirected = await fx.query<{ applied: unknown[] }>(
      `SELECT applied FROM app.flow_responses WHERE tenant_id = $1 AND contact_id <> $2`,
      [c.tenant.id, conv.contact_id],
    );
    expect(misdirected).toEqual([
      {
        applied: [
          {
            key: '*',
            target: '*',
            outcome: 'skipped',
            message: 'The form was sent to another contact, so the answers were not applied.',
          },
        ],
      },
    ]);
    const names = await fx.query<{ display_name: string | null; email: string | null }>(
      `SELECT display_name, email FROM app.contacts WHERE tenant_id = $1 ORDER BY created_at`,
      [c.tenant.id],
    );
    expect(names.map((n) => n.display_name)).not.toContain('Not Priya');
    expect(names.map((n) => n.email)).not.toContain('x@example.test');

    // Forms are replies: never once the service window has closed, and drafts only for testers.
    const late = createFlowsService({
      db: fx.dbs.app,
      clock: later(25 * 3_600_000),
      jobs: fx.jobs(),
      signer: fx.signer,
      appBaseUrl: APP_BASE,
      allowInsecureHttp: true,
    });
    await expectAppError(
      late.send(owner, {
        conversationId: conv.id,
        flowId,
        mode: 'published',
        header: '',
        body: 'Again',
        footer: '',
        cta: 'Open',
        clientKey: 'flow-send-0002',
      }),
      'precondition_failed',
      /window has closed/,
    );
    await expectAppError(
      svc.send(agent, {
        conversationId: conv.id,
        flowId,
        mode: 'draft',
        header: '',
        body: 'Test',
        footer: '',
        cta: 'Open',
        clientKey: 'flow-send-0003',
      }),
      'forbidden',
    );
  });

  it('erases answers with the contact and stops their forms from working', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = flowsService();
    const flowId = await publishedFlow(c, owner);
    const priya = waId();
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: priya, text: 'Hi' }] }));
    const conv = await conversationOf(c, priya);
    const { messageId } = await svc.send(owner, {
      conversationId: conv.id,
      flowId,
      mode: 'published',
      header: '',
      body: 'Details please',
      footer: '',
      cta: 'Open',
      clientKey: 'erase-send-01',
    });
    const [send] = await fx.query<{ token: string }>(
      `SELECT token FROM app.flow_sends WHERE message_id = $1`,
      [messageId],
    );
    await fx.deliver(
      completion(c, priya, JSON.stringify({ flow_token: send!.token, full_name: 'Priya' })),
    );
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).eraseContact(owner, {
      contactId: conv.contact_id,
      suppress: false,
    });
    expect(
      await fx.query(`SELECT id FROM app.flow_responses WHERE contact_id = $1`, [conv.contact_id]),
    ).toEqual([]);
    const [expired] = await fx.query<{ live: boolean }>(
      `SELECT expires_at > now() AS live FROM app.flow_sends WHERE token = $1`,
      [send!.token],
    );
    expect(expired!.live).toBe(false);
  });
});

// The data endpoint -------------------------------------------------------------------------------

const egress = () =>
  createEgressClient(
    { ...DEFAULT_EGRESS_POLICY, allowLoopbackForTests: true, timeoutMs: 2_000 },
    { resolve: async () => [{ address: '127.0.0.1', family: 4 }] },
  );
const endpointDeps = (clock: Clock = systemClock) => ({
  db: fx.dbs.app,
  keyring: fx.keyring,
  clock,
  appSecrets: [APP_SECRET],
  egress: egress(),
});

/** Encrypts and signs a request the way WhatsApp does, with the fixture's app secret. */
const whatsappRequest = (publicKeyPem: string, body: unknown, secret = APP_SECRET) =>
  whatsappFlowRequest(publicKeyPem, body, secret);

describe('flow data endpoint', () => {
  it('checks the signature, key and token, answers health checks, and forwards to the company endpoint', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const svc = flowsService();
    const webRequests = createWebRequestService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
    });
    const domain = await webRequests.addDomain(owner, { domain: HOST });
    await webRequests.saveSecret(owner, {
      name: 'forms_key',
      domain: HOST,
      value: 'secret-for-forms',
    });

    const { id } = await svc.create(owner, {
      whatsappAccountId: c.whatsappAccountId,
      name: 'Booking',
      categories: ['APPOINTMENT_BOOKING'],
      json: ENDPOINT_JSON,
    });
    expect(await sync(c, id)).toBe('done');
    let row = await flowRow(id);
    const remote = fx.standIn.state.flows.get(row.meta_flow_id as string)!;
    expect(remote.endpointUri).toBe(`${APP_BASE}/api/flows/endpoint/${row.public_id as string}`);
    // Publishing a flow that fetches data needs the endpoint and the key on every number.
    await expectAppError(
      svc.publish(owner, { id, expectedVersion: row.version as number }),
      'conflict',
      /endpoint address/,
    );
    await expectAppError(
      svc.updateSettings(owner, {
        id,
        expectedVersion: row.version as number,
        mapping: [],
        endpointUrl: 'http://elsewhere.test/x',
        endpointSecretName: '',
      }),
      'validation_failed',
      /not an allowed domain/,
    );
    await svc.updateSettings(owner, {
      id,
      expectedVersion: row.version as number,
      mapping: [],
      endpointUrl: `http://${HOST}:${port}/flows`,
      endpointSecretName: 'forms_key',
    });
    row = await flowRow(id);
    await expectAppError(
      svc.publish(owner, { id, expectedVersion: row.version as number }),
      'conflict',
      /encryption key/,
    );
    expect(await processFlowKeys(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    await svc.publish(owner, { id, expectedVersion: row.version as number });
    expect(await sync(c, id)).toBe('done');
    const publicId = (await flowRow(id)).public_id as string;
    const pem = fx.standIn.state.businessKeys.get(c.phoneNumberId)!.pem;
    const call = (
      body: unknown,
      options: { secret?: string; key?: string; publicId?: string; clock?: Clock } = {},
    ) => {
      const req = whatsappRequest(options.key ?? pem, body, options.secret);
      return handleFlowEndpoint(endpointDeps(options.clock), {
        publicId: options.publicId ?? publicId,
        rawBody: req.rawBody,
        signature: req.signature,
      }).then((res) => ({
        ...res,
        answer: res.status === 200 || res.status === 427 ? req.open(res.body) : null,
      }));
    };

    // Signature, unknown flow and a key WhatsApp should refresh.
    expect((await call({ action: 'ping' }, { secret: 'wrong-secret' })).status).toBe(432);
    expect((await call({ action: 'ping' }, { publicId: 'aaaaaaaaaaaaaaaa' })).status).toBe(404);
    expect(
      (await call({ action: 'ping' }, { key: generateFlowKeyPair().publicKeyPem })).status,
    ).toBe(421);
    // Health check and error notifications are answered by HyFib.
    expect(await call({ version: '3.0', action: 'ping' })).toMatchObject({
      status: 200,
      answer: { data: { status: 'active' } },
    });
    expect(
      await call({
        version: '3.0',
        action: 'data_exchange',
        flow_token: 'x',
        data: { error: 'timeout', error_message: 'x' },
      }),
    ).toMatchObject({
      status: 200,
      answer: { data: { acknowledged: true } },
    });
    expect(
      await call({ version: '3.0', action: 'INIT', flow_token: 'not-issued-by-hyfib' }),
    ).toMatchObject({
      status: 427,
      answer: { error_msg: 'This form is no longer available.' },
    });
    expect(received).toEqual([]);

    // A form sent from HyFib: its requests are forwarded with the secret and the answer returned.
    const priya = waId();
    await fx.deliver(fx.messagesBody(c, { messages: [{ waId: priya, text: 'Book me' }] }));
    const conv = await conversationOf(c, priya);
    const { messageId } = await svc.send(owner, {
      conversationId: conv.id,
      flowId: id,
      mode: 'published',
      header: '',
      body: 'Book a slot',
      footer: '',
      cta: 'Book',
      clientKey: 'endpoint-send-01',
    });
    const [send] = await fx.query<{ token: string }>(
      `SELECT token FROM app.flow_sends WHERE message_id = $1`,
      [messageId],
    );
    targetAnswer = { status: 200, body: { screen: 'START', data: { slots: ['10:00', '11:00'] } } };
    const forwarded = await call({ version: '3.0', action: 'INIT', flow_token: send!.token });
    expect(forwarded).toMatchObject({
      status: 200,
      answer: { screen: 'START', data: { slots: ['10:00', '11:00'] } },
      log: { outcome: 'forwarded' },
    });
    expect(received.at(-1)!.headers.authorization).toBe('Bearer secret-for-forms');
    expect(received.at(-1)!.body).toMatchObject({
      version: '3.0',
      action: 'INIT',
      screen: null,
      data: {},
      flow_token: send!.token,
      flow: { id, name: 'Booking' },
      contact: { id: conv.contact_id, phone: `+${priya}` },
    });
    // The company may refuse the token itself; failures and missing settings are 500s.
    targetAnswer = { status: 427, body: { error_msg: 'That slot is gone.' } };
    expect(
      await call({
        version: '3.0',
        action: 'data_exchange',
        screen: 'START',
        data: { slot: '10:00' },
        flow_token: send!.token,
      }),
    ).toMatchObject({
      status: 427,
      answer: { error_msg: 'That slot is gone.' },
    });
    targetAnswer = { status: 500, body: { oops: true } };
    expect(
      await call({ version: '3.0', action: 'data_exchange', flow_token: send!.token }),
    ).toMatchObject({ status: 500, log: { outcome: 'endpoint_failed', detail: '500' } });
    // A secret moved to another domain after the settings were saved is not sent to this one.
    await webRequests.addDomain(owner, { domain: 'partner.example' });
    await webRequests.saveSecret(owner, {
      name: 'forms_key',
      domain: 'partner.example',
      value: 'for-the-partner-only',
    });
    const forwardedSoFar = received.length;
    expect(await call({ version: '3.0', action: 'INIT', flow_token: send!.token })).toMatchObject({
      status: 500,
      log: { outcome: 'endpoint_secret_domain_mismatch' },
    });
    expect(received).toHaveLength(forwardedSoFar);
    targetAnswer = { status: 200, body: {} };
    await webRequests.removeDomain(owner, { id: domain.id });
    expect(await call({ version: '3.0', action: 'INIT', flow_token: send!.token })).toMatchObject({
      status: 500,
      log: { outcome: 'endpoint_domain_not_allowed' },
    });

    // Expired tokens and suspended companies are refused.
    expect(
      await call(
        { version: '3.0', action: 'INIT', flow_token: send!.token },
        { clock: later(31 * 86_400_000) },
      ),
    ).toMatchObject({ status: 427 });
    await fx.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [c.tenant.id]);
    expect(await call({ version: '3.0', action: 'INIT', flow_token: send!.token })).toMatchObject({
      status: 427,
      answer: { error_msg: 'This form is not available right now.' },
    });
    expect((await call({ version: '3.0', action: 'ping' })).status).toBe(200);
    await fx.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [c.tenant.id]);

    // During a rotation the previous key still works; the new key works at once.
    await svc.rotateKey(owner, { whatsappAccountId: c.whatsappAccountId });
    expect(await processFlowKeys(workerDeps(), scopeOf(c), c.whatsappAccountId)).toBe('done');
    const fresh = fx.standIn.state.businessKeys.get(c.phoneNumberId)!.pem;
    expect(fresh).not.toBe(pem);
    expect((await call({ action: 'ping' })).status).toBe(200);
    expect((await call({ action: 'ping' }, { key: fresh })).status).toBe(200);
  });
});

describe('flow isolation', () => {
  it("keeps one company's flows, keys and answers from another", async () => {
    const a = await fx.company();
    const b = await fx.company();
    const ownerA = await fx.ctx(a, a.owner);
    const ownerB = await fx.ctx(b, b.owner);
    const svc = flowsService();
    const flowId = await publishedFlow(a, ownerA);
    const row = await flowRow(flowId);
    expect(await svc.list(ownerB)).toEqual([]);
    await expectAppError(svc.get(ownerB, flowId), 'not_found');
    await expectAppError(
      svc.publish(ownerB, { id: flowId, expectedVersion: row.version as number }),
      'not_found',
    );
    await expectAppError(svc.duplicate(ownerB, { id: flowId }), 'not_found');
    await expectAppError(
      svc.create(ownerB, {
        whatsappAccountId: a.whatsappAccountId,
        name: 'Theirs',
        categories: ['OTHER'],
        json: STARTER_FLOW_JSON,
      }),
      'validation_failed',
      /connected WhatsApp account/,
    );
    await expectAppError(
      svc.setupKeys(ownerB, { whatsappAccountId: a.whatsappAccountId }),
      'validation_failed',
    );
    // B's customer cannot be sent A's form.
    const customer = waId();
    await fx.deliver(fx.messagesBody(b, { messages: [{ waId: customer, text: 'Hi' }] }));
    const conv = await conversationOf(b, customer);
    expect(await svc.sendable(ownerB, conv.id)).toEqual([]);
    await expectAppError(
      svc.send(ownerB, {
        conversationId: conv.id,
        flowId,
        mode: 'published',
        header: '',
        body: 'x',
        footer: '',
        cta: 'Open',
        clientKey: 'isolation-01',
      }),
      'validation_failed',
    );
    const counts = await fx.dbs.app.run(authorizedTenantScope(b.tenant.id, b.owner.id), (tx) =>
      tx.execute<{ flows: number; keys: number; sends: number; responses: number }>(sql`
        select (select count(*) from app.flows)::int as flows,
               (select count(*) from app.flow_keys)::int as keys,
               (select count(*) from app.flow_sends)::int as sends,
               (select count(*) from app.flow_responses)::int as responses`),
    );
    expect(counts.rows[0]).toEqual({ flows: 0, keys: 0, sends: 0, responses: 0 });
  });
});
