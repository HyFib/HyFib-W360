import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, type Clock } from '@w360/core';
import {
  DEFAULT_EGRESS_POLICY,
  createEgressClient,
  type EgressClient,
  type EgressResponse,
} from '@w360/core/egress';
import { authorizedTenantScope } from '@w360/db';
import {
  HTTP_WAIT_MINUTES,
  advanceAutomationRun,
  applyAutomationRetention,
  createAutomationService,
  createContactsService,
  createWebRequestService,
  findDueHttpCalls,
  httpSecretAad,
  processHttpCall,
  processSendIntent,
  type AutomationTrigger,
  type TenantContext,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * The automation HTTP step against real PostgreSQL, the egress client and a local target server
 * (reached through the loopback allowance that exists for tests only): the call is written ahead,
 * made once with the company's secret, and its result steers the run; refusals, errors, timeouts
 * and results after the deadline; cancellation, the sweep, erasure, the settings and isolation.
 */
let fx: WhatsAppFixture;
let target: Server;
let port = 0;
const received: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  target = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.url?.startsWith('/orders/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { status: 'shipped', eta: 3 } }));
      } else if (req.url === '/down') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'maintenance' }));
      } else if (req.url === '/receipt') {
        // A plain-text answer with headers to save (ADR-406): one repeated, one a cookie.
        res.setHeader('x-request-id', 'req-7781');
        res.setHeader('x-late-ref', 'late-1');
        res.setHeader('x-trace', ['first', 'second']);
        res.setHeader('set-cookie', ['sid=abc; HttpOnly']);
        res.writeHead(201, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Receipt R-55 noted.\n');
      } else if (req.url === '/echo') {
        // A server that echoes the request back as text, the secret's header included.
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`You sent ${String(req.headers.authorization ?? '')}`);
      } else if (req.url === '/probe') {
        // Echoes the request's X-Probe header back in X-Echo.
        res.setHeader('x-echo', String(req.headers['x-probe'] ?? ''));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      } else if (req.url === '/hang') {
        // Never answers: the client's deadline ends the exchange.
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  port = (target.address() as AddressInfo).port;
});

afterAll(async () => {
  target?.closeAllConnections();
  target?.close();
  await fx?.close();
});

const rate = { capacity: 1000, refillPerSecond: 1000 };
const waId = () => `91${randomInt(7_000_000_000, 9_999_999_999)}`;
const later = (ms: number): Clock => ({ now: () => new Date(Date.now() + ms) });
const pastDeadline = later(HTTP_WAIT_MINUTES * 60_000 + 5_000);
const HOST = 'api.shop.test';
const TOKEN = 'shop-token-3f9a7c';

/** The egress client, pinned to the local target (names resolve to 127.0.0.1). */
const egress = (timeoutMs = 2_000) =>
  createEgressClient(
    { ...DEFAULT_EGRESS_POLICY, allowLoopbackForTests: true, timeoutMs },
    { resolve: async () => [{ address: '127.0.0.1', family: 4 }] },
  );

function httpDeps(client: EgressClient = egress(), clock: Clock = systemClock) {
  return {
    db: fx.dbs.app,
    clock,
    keyring: fx.keyring,
    jobs: fx.jobs(),
    signer: fx.signer,
    egress: client,
    timeoutMs: 2_000,
  };
}

const webRequests = () =>
  createWebRequestService({ db: fx.dbs.app, clock: systemClock, keyring: fx.keyring });
const automations = () =>
  createAutomationService({
    db: fx.dbs.app,
    clock: systemClock,
    jobs: fx.jobs(),
    signer: fx.signer,
    allowInsecureHttp: true,
  });

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

const keyword = (...keywords: string[]): AutomationTrigger => ({
  type: 'keyword',
  keywords,
  match: 'contains',
  hours: 'any',
  cooldownMinutes: 0,
});

/** Calls the shop's API (optionally after asking for an order number) and tells the result. */
function orderGraph(path: string, options: { ask?: boolean; headers?: unknown[] } = {}) {
  const call = {
    id: 'call',
    type: 'http_request',
    method: 'POST',
    url: `http://${HOST}:${port}${path}`,
    headers: options.headers ?? [
      { name: 'Authorization', value: 'Bearer {{secret.shop_token}}' },
      { name: 'X-Customer', value: '{{name}}' },
    ],
    body: options.ask
      ? '{"order": "{{answer.order_no}}", "customer": "{{name}}"}'
      : '{"customer": "{{name}}"}',
    save: [{ path: 'data.status', saveAs: 'status' }],
    next: 'tell',
    failureNext: 'sorry',
  };
  const ask = {
    id: 'ask',
    type: 'ask_text',
    text: 'What is your order number?',
    saveAs: 'order_no',
    format: 'number',
    retryText: null,
    retries: 0,
    invalidNext: null,
    timeoutMinutes: 30,
    timeoutNext: null,
    next: 'call',
  };
  return {
    version: 1,
    start: options.ask ? 'ask' : 'call',
    nodes: [
      ...(options.ask ? [ask] : []),
      call,
      { id: 'tell', type: 'send_text', text: 'Your order is {{answer.status}}.', next: null },
      { id: 'sorry', type: 'send_text', text: 'We could not check that now.', next: 'agent' },
      { id: 'agent', type: 'handoff', teamId: null },
    ],
  };
}

async function publish(owner: TenantContext, graph: unknown, trigger = keyword('order')) {
  const svc = automations();
  const name = `Orders ${randomInt(1e6)}`;
  const { id } = await svc.createAutomation(owner, { name });
  const saved = await svc.updateAutomation(owner, {
    id,
    expectedVersion: 0,
    name,
    description: null,
    channelAccountId: null,
    trigger,
    graph,
  });
  return svc.publishAutomation(owner, { id, expectedVersion: saved.version, note: null });
}

interface Setup {
  c: Company;
  owner: TenantContext;
  domainId: string;
  secretId: string;
}

/** A company that allows the shop's API and keeps its token as a secret. */
async function setup(): Promise<Setup> {
  const c = await fx.company();
  const owner = await fx.ctx(c, c.owner);
  const { id: domainId } = await webRequests().addDomain(owner, { domain: HOST });
  const { id: secretId } = await webRequests().saveSecret(owner, {
    name: 'shop_token',
    domain: HOST,
    value: TOKEN,
  });
  return { c, owner, domainId, secretId };
}

async function inbound(c: Company, from: string, text: string) {
  await fx.deliver(fx.messagesBody(c, { messages: [{ waId: from, text }] }));
  const [row] = await fx.query<{ id: string }>(
    `SELECT cv.id FROM app.conversations cv
       JOIN app.contact_identities i ON i.tenant_id = cv.tenant_id AND i.contact_id = cv.contact_id
      WHERE cv.tenant_id = $1 AND i.wa_id = $2`,
    [c.tenant.id, from],
  );
  if (!row) throw new Error('conversation not created');
  return row.id;
}

interface RunRow {
  id: string;
  status: string;
  end_reason: string | null;
  waiting_for: string | null;
  http_call_count: number;
  variables: Record<string, string>;
}

async function onlyRun(conversationId: string) {
  const runs = await fx.query<RunRow & Record<string, unknown>>(
    `SELECT id, status, end_reason, waiting_for, http_call_count, variables
       FROM app.automation_runs WHERE conversation_id = $1 ORDER BY started_at, id`,
    [conversationId],
  );
  expect(runs).toHaveLength(1);
  return runs[0] as RunRow;
}

interface CallRow {
  id: string;
  state: string;
  method: string;
  host: string;
  path: string;
  status_code: number | null;
  error_code: string | null;
  duration_ms: number | null;
  saved_values: Record<string, string>;
  request_ciphertext: string | null;
  node_visit: number;
}

async function callsOf(runId: string) {
  return fx.query<CallRow & Record<string, unknown>>(
    `SELECT id, state, method, host, path, status_code, error_code, duration_ms, saved_values,
            request_ciphertext, node_visit
       FROM app.automation_http_calls WHERE run_id = $1 ORDER BY created_at, id`,
    [runId],
  );
}

/** The answers a call left out for safety, by name and reason (migration 0319, ADR-406). */
async function droppedOf(callId: string) {
  const [row] = await fx.query<{ dropped_values: Record<string, string> }>(
    `SELECT dropped_values FROM app.automation_http_calls WHERE id = $1`,
    [callId],
  );
  return row?.dropped_values;
}

async function onlyCall(runId: string) {
  const calls = await callsOf(runId);
  expect(calls).toHaveLength(1);
  return calls[0] as CallRow;
}

async function stepLog(runId: string) {
  return fx.query<{
    outcome: string;
    node_id: string | null;
    branch: string | null;
    detail: string | null;
  }>(
    `SELECT outcome, node_id, branch, detail FROM app.automation_run_steps WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
}

async function botTexts(conversationId: string) {
  const rows = await fx.query<{ content: { text?: string } }>(
    `SELECT content FROM app.messages
      WHERE conversation_id = $1 AND sender_type = 'bot' ORDER BY created_at, id`,
    [conversationId],
  );
  return rows.map((r) => r.content.text ?? null);
}

/** Sends every queued message of the conversation through the send worker and the stand-in. */
async function sendQueued(c: Company, conversationId: string) {
  const intents = await fx.query<{ id: string; actor_user_id: string | null }>(
    `SELECT s.id, s.actor_user_id FROM app.send_intents s
       JOIN app.messages m ON m.tenant_id = s.tenant_id AND m.id = s.message_id
      WHERE m.conversation_id = $1 AND s.state = 'queued' ORDER BY s.created_at`,
    [conversationId],
  );
  for (const intent of intents) {
    await processSendIntent(
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
  }
}

/** Advances a run (sending its messages) until it waits or ends. */
async function drive(c: Company, conversationId: string, runId: string, clock = systemClock) {
  for (let i = 0; i < 50; i += 1) {
    const result = await advanceAutomationRun(
      { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock, keyring: fx.keyring },
      authorizedTenantScope(c.tenant.id, null),
      runId,
      null,
    );
    // A question is sent before the run can take its answer (runs wait for Meta to accept).
    await sendQueued(c, conversationId);
    if (result.outcome !== 'sending') return result.outcome;
  }
  throw new Error('the run did not settle');
}

/** A new customer whose run now waits for its call. */
async function waitingAtCall(s: Setup, deliverClock: Clock = systemClock) {
  const from = waId();
  await fx.deliver(
    fx.messagesBody(s.c, { messages: [{ waId: from, text: 'order' }] }),
    deliverClock,
  );
  const [row] = await fx.query<{ id: string }>(
    `SELECT cv.id FROM app.conversations cv
       JOIN app.contact_identities i ON i.tenant_id = cv.tenant_id AND i.contact_id = cv.contact_id
      WHERE cv.tenant_id = $1 AND i.wa_id = $2`,
    [s.c.tenant.id, from],
  );
  const conv = row!.id;
  const run = await onlyRun(conv);
  expect(await drive(s.c, conv, run.id, deliverClock)).toBe('waiting');
  expect(await onlyRun(conv)).toMatchObject({ status: 'waiting', waiting_for: 'http' });
  return { from, conv, run, call: await onlyCall(run.id) };
}

const scopeOf = (s: Setup) => authorizedTenantScope(s.c.tenant.id, null);

/** Moves an ended run back in time (ended runs are guarded; the retention setting allows it). */
async function backdateRun(runId: string, days: number) {
  const client = await fx.dbs.adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('w360.allow_retention_purge', 'on', true)`);
    await client.query(
      `UPDATE app.automation_runs SET started_at = started_at - make_interval(days => $2),
              ended_at = ended_at - make_interval(days => $2) WHERE id = $1`,
      [runId, days],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('automation HTTP step', () => {
  it('calls the company API once with its secret and continues with the saved values', async () => {
    const s = await setup();
    await publish(s.owner, orderGraph('/orders/{{answer.order_no}}', { ask: true }));
    const from = waId();
    const conv = await inbound(s.c, from, 'order please');
    const run = await onlyRun(conv);
    expect(await drive(s.c, conv, run.id)).toBe('waiting');
    await inbound(s.c, from, '4217');
    expect(await drive(s.c, conv, run.id)).toBe('waiting');

    // Written ahead: the call is recorded (queued, the request encrypted) and the run waits for it.
    expect(await onlyRun(conv)).toMatchObject({
      status: 'waiting',
      waiting_for: 'http',
      http_call_count: 1,
    });
    const queued = await onlyCall(run.id);
    expect(queued).toMatchObject({
      state: 'queued',
      method: 'POST',
      host: HOST,
      // The path as written: the customer's order number is only in the encrypted request.
      path: '/orders/{{answer.order_no}}',
      status_code: null,
    });
    expect(queued.request_ciphertext).not.toBeNull();
    expect(queued.request_ciphertext).not.toContain('4217');
    expect(queued.request_ciphertext).not.toContain(TOKEN);
    // Nothing is sent by the step itself.
    const before = received.length;
    expect(await drive(s.c, conv, run.id)).toBe('not_due');
    expect(received.length).toBe(before);

    expect(await processHttpCall(httpDeps(), scopeOf(s), queued.id)).toBe('succeeded');
    expect(received.length).toBe(before + 1);
    const request = received.at(-1)!;
    expect(request).toMatchObject({ method: 'POST', url: '/orders/4217' });
    expect(JSON.parse(request.body)).toEqual({ order: '4217', customer: 'Priya Customer' });
    expect(request.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'x-customer': 'Priya Customer',
      host: `${HOST}:${port}`,
      'content-type': 'application/json',
    });
    const done = await onlyCall(run.id);
    expect(done).toMatchObject({
      state: 'succeeded',
      status_code: 200,
      error_code: null,
      saved_values: { status: 'shipped' },
      request_ciphertext: null,
    });
    expect(done.duration_ms).not.toBeNull();
    // A retried job finds nothing to do: the call is never sent twice.
    expect(await processHttpCall(httpDeps(), scopeOf(s), queued.id)).toBe('idle');
    expect(received.length).toBe(before + 1);

    expect(await drive(s.c, conv, run.id)).toBe('ended');
    expect(await onlyRun(conv)).toMatchObject({
      status: 'completed',
      variables: { order_no: '4217', status: 'shipped' },
    });
    expect(await botTexts(conv)).toEqual(['What is your order number?', 'Your order is shipped.']);
    expect((await stepLog(run.id)).filter((l) => l.node_id === 'call')).toEqual([
      { outcome: 'requested', node_id: 'call', branch: null, detail: null },
      { outcome: 'responded', node_id: 'call', branch: 'success', detail: '200' },
    ]);
  });

  it('sends a form body URL-encoded, as form fields (ADR-236)', async () => {
    const s = await setup();
    const graph = orderGraph('/orders/{{answer.order_no}}', { ask: true });
    const formGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'call'
          ? {
              ...n,
              bodyFormat: 'form',
              body: 'order={{answer.order_no}}&customer={{name}}&channel=whats%20app',
            }
          : n,
      ),
    };
    await publish(s.owner, formGraph);
    const from = waId();
    const conv = await inbound(s.c, from, 'order please');
    const run = await onlyRun(conv);
    expect(await drive(s.c, conv, run.id)).toBe('waiting');
    await inbound(s.c, from, '4217');
    expect(await drive(s.c, conv, run.id)).toBe('waiting');
    const queued = await onlyCall(run.id);
    const before = received.length;
    expect(await processHttpCall(httpDeps(), scopeOf(s), queued.id)).toBe('succeeded');
    expect(received.length).toBe(before + 1);
    const request = received.at(-1)!;
    expect(request).toMatchObject({ method: 'POST', url: '/orders/4217' });
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request.body).toBe('order=4217&customer=Priya%20Customer&channel=whats%20app');
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      order: '4217',
      customer: 'Priya Customer',
      channel: 'whats app',
    });
    expect(await drive(s.c, conv, run.id)).toBe('ended');
    expect(await botTexts(conv)).toEqual(['What is your order number?', 'Your order is shipped.']);
  });

  it("saves an answer longer than a field's 500 characters to a contact field without splitting an emoji (ADR-131, ADR-133)", async () => {
    // The answer is clipped to a field's 500 characters where the cut falls between the two halves
    // of an emoji: jsonb refused the half left (22P02, ADR-131), and since ADR-133 the clip stops
    // before the emoji instead of leaving U+FFFD in its place.
    const s = await setup();
    await createContactsService({ db: fx.dbs.app, clock: systemClock }).createField(s.owner, {
      label: 'City',
      key: 'city',
      type: 'text',
    });
    await publish(s.owner, {
      version: 1,
      start: 'ask',
      nodes: [
        {
          id: 'ask',
          type: 'ask_text',
          text: 'Which city?',
          saveAs: 'city',
          format: 'any',
          retryText: null,
          retries: 0,
          invalidNext: null,
          timeoutMinutes: 30,
          timeoutNext: null,
          next: 'set',
        },
        {
          id: 'set',
          type: 'update_contact',
          action: { kind: 'set_field', field: 'city', value: '{{answer.city}}' },
          next: 'done',
        },
        { id: 'done', type: 'send_text', text: 'Thanks.', next: null },
      ],
    });
    const from = waId();
    const conv = await inbound(s.c, from, 'order please');
    const run = await onlyRun(conv);
    expect(await drive(s.c, conv, run.id)).toBe('waiting');
    await inbound(s.c, from, `${'x'.repeat(499)}😀`);
    expect(await drive(s.c, conv, run.id)).toBe('ended');
    const [contact] = await fx.query<{ attributes: Record<string, unknown> }>(
      `SELECT c.attributes FROM app.contacts c
         JOIN app.conversations cv ON cv.tenant_id = c.tenant_id AND cv.contact_id = c.id
        WHERE cv.id = $1`,
      [conv],
    );
    expect(contact?.attributes).toEqual({ city: 'x'.repeat(499) });
  });

  it('saves a header, the body as text and the status for a later step (ADR-406)', async () => {
    const s = await setup();
    const graph = orderGraph('/receipt');
    const receiptGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'call'
          ? {
              ...n,
              save: [
                { from: 'header', header: 'X-Request-ID', saveAs: 'ref' },
                { from: 'header', header: 'X-Trace', saveAs: 'trace' },
                { from: 'text', saveAs: 'note' },
                { from: 'status', saveAs: 'code' },
                // A JSON path into a text body finds nothing; the others still save.
                { path: 'data.status', saveAs: 'status' },
              ],
            }
          : n.id === 'tell'
            ? {
                ...n,
                text: '{{answer.code}} {{answer.ref}} [{{answer.trace}}] {{answer.note}}',
              }
            : n,
      ),
    };
    await publish(s.owner, receiptGraph);
    const { conv, run, call } = await waitingAtCall(s);
    expect(await processHttpCall(httpDeps(), scopeOf(s), call.id)).toBe('succeeded');
    const done = await onlyCall(run.id);
    expect(done).toMatchObject({ state: 'succeeded', status_code: 201 });
    expect(done.saved_values).toStrictEqual({
      ref: 'req-7781',
      trace: 'first, second',
      note: 'Receipt R-55 noted.',
      code: '201',
    });
    expect(await drive(s.c, conv, run.id)).toBe('ended');
    expect((await onlyRun(conv)).variables).toStrictEqual({
      ref: 'req-7781',
      trace: 'first, second',
      note: 'Receipt R-55 noted.',
      code: '201',
    });
    expect(await botTexts(conv)).toEqual(['201 req-7781 [first, second] Receipt R-55 noted.']);
  });

  it('refuses to save a cookie or a secret’s header, and never saves an echoed secret (ADR-406)', async () => {
    const s = await setup();
    const svc = automations();
    const withSave = (path: string, save: unknown[]) => {
      const graph = orderGraph(path);
      return {
        ...graph,
        nodes: graph.nodes.map((n) => (n.id === 'call' ? { ...n, save } : n)),
      };
    };
    // A cookie is refused when the draft is saved.
    const name = `Cookies ${randomInt(1e6)}`;
    const { id } = await svc.createAutomation(s.owner, { name });
    await expectAppError(
      svc.updateAutomation(s.owner, {
        id,
        expectedVersion: 0,
        name,
        description: null,
        channelAccountId: null,
        trigger: keyword('order'),
        graph: withSave('/receipt', [{ from: 'header', header: 'Set-Cookie', saveAs: 'sid' }]),
      }),
      'validation_failed',
      /Set-Cookie header can carry credentials or a session/,
    );
    await expectAppError(
      publish(
        s.owner,
        withSave('/receipt', [{ from: 'header', header: 'Shop-Token', saveAs: 'status' }]),
      ),
      'validation_failed',
      /Shop-Token header can carry credentials/,
    );
    // A header the step sends its secret in is refused when it is published.
    const echoes = orderGraph('/receipt', {
      headers: [{ name: 'X-Shop', value: 'Bearer {{secret.shop_token}}' }],
    });
    await expectAppError(
      publish(s.owner, {
        ...echoes,
        nodes: echoes.nodes.map((n) =>
          n.id === 'call'
            ? { ...n, save: [{ from: 'header', header: 'X-Shop', saveAs: 'status' }] }
            : n,
        ),
      }),
      'precondition_failed',
      /This step sends a secret in the X-Shop header/,
    );

    // A server echoing the request: the text holding the secret is not saved; the status is.
    await publish(
      s.owner,
      withSave('/echo', [
        { from: 'text', saveAs: 'status' },
        { from: 'status', saveAs: 'code' },
      ]),
    );
    const { run, call } = await waitingAtCall(s);
    expect(await processHttpCall(httpDeps(), scopeOf(s), call.id)).toBe('succeeded');
    const done = await onlyCall(run.id);
    expect(done.saved_values).toStrictEqual({ code: '200' });
    expect(JSON.stringify(done.saved_values)).not.toContain(TOKEN);
    // The answer left out is named with its reason, never its value, and the run page gets it.
    expect(await droppedOf(call.id)).toStrictEqual({ status: 'echoed_secret' });
    const view = await automations().getRun(s.owner, run.id);
    expect(view.httpCalls.map((c) => c.droppedValues)).toStrictEqual([{ status: 'echoed_secret' }]);
  });

  it('refuses at publish a header named like a company secret (ADR-406)', async () => {
    const s = await setup();
    const graph = orderGraph('/receipt');
    await webRequests().saveSecret(s.owner, { name: 'crm_ref', domain: HOST, value: 'crm-9f' });
    await expectAppError(
      publish(s.owner, {
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === 'call'
            ? { ...n, save: [{ from: 'header', header: 'X-Crm-Ref', saveAs: 'status' }] }
            : n,
        ),
      }),
      'precondition_failed',
      /X-Crm-Ref header is named like the secret “crm_ref”/,
    );
  });

  it('refuses at publish a secret touching other text in a step that saves values (ADR-406)', async () => {
    const s = await setup();
    const graph = orderGraph('/probe', {
      headers: [{ name: 'X-Probe', value: 'q{{secret.shop_token}}q' }],
    });
    await expectAppError(
      publish(s.owner, {
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === 'call'
            ? { ...n, save: [{ from: 'header', header: 'X-Echo', saveAs: 'status' }] }
            : n,
        ),
      }),
      'precondition_failed',
      /put a separator/,
    );
  });

  it('drops the echo of a short secret a step published before the separator check sent beside text (ADR-406)', async () => {
    const s = await setup();
    await webRequests().saveSecret(s.owner, { name: 'crm_pin', domain: HOST, value: '4829' });
    const withProbe = (probe: string) => {
      const graph = orderGraph('/probe', { headers: [{ name: 'X-Probe', value: probe }] });
      return {
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === 'call'
            ? { ...n, save: [{ from: 'header', header: 'X-Echo', saveAs: 'status' }] }
            : n,
        ),
      };
    };
    // Published as allowed now, then given a version written as a step could be before the check.
    await publish(s.owner, withProbe('pin {{secret.crm_pin}}'));
    const client = await fx.dbs.adminPool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO app.automation_versions (id, tenant_id, automation_id, kind, number, trigger,
                graph, channel_account_id, definition_sha256, note, created_by_membership_id)
         SELECT gen_random_uuid(), v.tenant_id, v.automation_id, 'published', v.number + 1,
                v.trigger, $2::jsonb, v.channel_account_id,
                encode(sha256(convert_to($2::text, 'UTF8')), 'hex'),
                'written before the separator check', v.created_by_membership_id
           FROM app.automation_versions v
           JOIN app.automations a ON a.tenant_id = v.tenant_id AND a.active_version_id = v.id
          WHERE a.tenant_id = $1 AND a.status = 'active'
         RETURNING id`,
        [s.c.tenant.id, JSON.stringify(withProbe('q{{secret.crm_pin}}q'))],
      );
      expect(inserted.rows).toHaveLength(1);
      await client.query(
        `UPDATE app.automations SET active_version_id = $2 WHERE tenant_id = $1 AND status = 'active'`,
        [s.c.tenant.id, inserted.rows[0]!.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const { run, call } = await waitingAtCall(s);
    expect(await processHttpCall(httpDeps(), scopeOf(s), call.id)).toBe('succeeded');
    // The server received the secret beside the letters and echoed it; as a token it would pass.
    expect(received.at(-1)?.headers['x-probe']).toBe('q4829q');
    const done = await onlyCall(run.id);
    expect(done.saved_values).toStrictEqual({});
    expect(await droppedOf(call.id)).toStrictEqual({ status: 'echoed_secret' });
  });

  it('does not save a header named like a secret added after publishing, and says so (ADR-406)', async () => {
    const s = await setup();
    const graph = orderGraph('/receipt');
    await publish(s.owner, {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'call'
          ? {
              ...n,
              save: [
                { from: 'header', header: 'X-Late-Ref', saveAs: 'status' },
                { from: 'status', saveAs: 'code' },
              ],
            }
          : n,
      ),
    });
    const { run, call } = await waitingAtCall(s);
    // The secret arrives between publishing and the call: the worker reads the current names.
    await webRequests().saveSecret(s.owner, {
      name: 'late_ref',
      domain: HOST,
      value: 'late-ref-77aa',
    });
    expect(await processHttpCall(httpDeps(), scopeOf(s), call.id)).toBe('succeeded');
    const done = await onlyCall(run.id);
    expect(done.saved_values).toStrictEqual({ code: '201' });
    expect(await droppedOf(call.id)).toStrictEqual({ status: 'secret_header' });
  });

  it('takes the failure branch on an error status, a removed domain or a missing secret', async () => {
    const s = await setup();
    await publish(s.owner, orderGraph('/down'));

    // An error status: the call failed with a known reply.
    const down = await waitingAtCall(s);
    expect(await processHttpCall(httpDeps(), scopeOf(s), down.call.id)).toBe('failed');
    expect(await onlyCall(down.run.id)).toMatchObject({
      state: 'failed',
      status_code: 503,
      saved_values: {},
      request_ciphertext: null,
    });
    expect(await drive(s.c, down.conv, down.run.id)).toBe('ended');
    expect(await onlyRun(down.conv)).toMatchObject({
      status: 'handed_off',
      end_reason: 'handoff_node',
    });
    expect(await botTexts(down.conv)).toEqual(['We could not check that now.']);
    expect(await stepLog(down.run.id)).toContainEqual({
      outcome: 'responded',
      node_id: 'call',
      branch: 'failure',
      detail: '503',
    });

    // The company's current rules apply when the call is made: nothing is sent.
    const before = received.length;
    const noSecret = await waitingAtCall(s);
    await webRequests().deleteSecret(s.owner, { id: s.secretId });
    expect(await processHttpCall(httpDeps(), scopeOf(s), noSecret.call.id)).toBe('failed');
    expect(await onlyCall(noSecret.run.id)).toMatchObject({
      state: 'failed',
      error_code: 'secret_missing',
      request_ciphertext: null,
    });
    const noDomain = await waitingAtCall(s);
    await webRequests().removeDomain(s.owner, { id: s.domainId });
    expect(await processHttpCall(httpDeps(), scopeOf(s), noDomain.call.id)).toBe('failed');
    expect(await onlyCall(noDomain.run.id)).toMatchObject({
      state: 'failed',
      error_code: 'domain_not_allowed',
    });
    expect(received.length).toBe(before);
    expect(await drive(s.c, noDomain.conv, noDomain.run.id)).toBe('ended');
    expect(await stepLog(noDomain.run.id)).toContainEqual({
      outcome: 'responded',
      node_id: 'call',
      branch: 'failure',
      detail: 'domain_not_allowed',
    });
  });

  it('only sends a secret to the domain it was saved for', async () => {
    const s = await setup();
    await publish(s.owner, orderGraph('/orders/1'));
    const call = await waitingAtCall(s);
    // An administrator moves the secret to another allowed domain after the step was published.
    await webRequests().addDomain(s.owner, { domain: 'hooks.partner.test' });
    await webRequests().saveSecret(s.owner, {
      name: 'shop_token',
      domain: 'hooks.partner.test',
      value: 'partner-key',
    });
    const before = received.length;
    expect(await processHttpCall(httpDeps(), scopeOf(s), call.call.id)).toBe('failed');
    expect(await onlyCall(call.run.id)).toMatchObject({ error_code: 'secret_domain_mismatch' });
    expect(received.length).toBe(before);
    // And the publish check refuses a step that sends it elsewhere.
    await expectAppError(
      publish(s.owner, orderGraph('/orders/2'), keyword('status')),
      'precondition_failed',
      /secret “shop_token” can only be sent to hooks\.partner\.test/,
    );
    await expectAppError(
      publish(
        s.owner,
        {
          ...orderGraph('/x'),
          nodes: orderGraph('/x').nodes.map((n) =>
            n.id === 'call' ? { ...n, url: 'https://evil.test/x' } : n,
          ),
        },
        keyword('evil'),
      ),
      'precondition_failed',
      /evil\.test is not an allowed domain/,
    );
  });

  it('never repeats a call that may have been sent: it becomes unknown at the deadline', async () => {
    const s = await setup();
    await publish(s.owner, orderGraph('/orders/9'));

    // The worker dies after claiming the call: it stays in flight.
    const crashed = await waitingAtCall(s);
    const dying: EgressClient = {
      request: async () => {
        throw new Error('worker process died');
      },
    };
    await expect(processHttpCall(httpDeps(dying), scopeOf(s), crashed.call.id)).rejects.toThrow(
      'worker process died',
    );
    expect((await onlyCall(crashed.run.id)).state).toBe('in_flight');
    // The database refuses to queue it again, whoever tries.
    await expect(
      fx.query(
        `UPDATE app.automation_http_calls SET state = 'queued', started_at = NULL,
                  lease_until = NULL WHERE id = $1`,
        [crashed.call.id],
      ),
    ).rejects.toThrow(/never queued again/);
    // The job's retry does not send it again.
    const before = received.length;
    expect(await processHttpCall(httpDeps(), scopeOf(s), crashed.call.id)).toBe('idle');
    expect(received.length).toBe(before);
    // Before the deadline the run keeps waiting; at the deadline the outcome is unknown.
    expect(await drive(s.c, crashed.conv, crashed.run.id)).toBe('not_due');
    expect(await drive(s.c, crashed.conv, crashed.run.id, pastDeadline)).toBe('ended');
    expect(await onlyCall(crashed.run.id)).toMatchObject({
      state: 'unknown',
      error_code: 'no_result',
      request_ciphertext: null,
    });
    expect(await stepLog(crashed.run.id)).toContainEqual({
      outcome: 'responded',
      node_id: 'call',
      branch: 'failure',
      detail: 'no_result',
    });
    expect(await onlyRun(crashed.conv)).toMatchObject({ status: 'handed_off' });

    // A response that arrives after the deadline does not change the outcome.
    const slow = await waitingAtCall(s);
    let started!: () => void;
    const requested = new Promise<void>((resolve) => (started = resolve));
    let respond!: (response: EgressResponse) => void;
    const held: EgressClient = {
      request: () => {
        started();
        return new Promise<EgressResponse>((resolve) => (respond = resolve));
      },
    };
    const pending = processHttpCall(httpDeps(held), scopeOf(s), slow.call.id);
    await requested;
    expect((await onlyCall(slow.run.id)).state).toBe('in_flight');
    expect(await drive(s.c, slow.conv, slow.run.id, pastDeadline)).toBe('ended');
    respond({
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ data: { status: 'shipped' } })),
      address: '127.0.0.1',
      durationMs: 5,
    });
    expect(await pending).toBe('unknown');
    expect(await onlyCall(slow.run.id)).toMatchObject({
      state: 'unknown',
      status_code: null,
      saved_values: {},
    });
    expect(await botTexts(slow.conv)).toEqual(['We could not check that now.']);
  });

  it('records a timeout as unknown and a call not started at the deadline as cancelled', async () => {
    const s = await setup();
    await publish(s.owner, orderGraph('/hang'));
    const hung = await waitingAtCall(s);
    expect(await processHttpCall(httpDeps(egress(300)), scopeOf(s), hung.call.id)).toBe('unknown');
    expect(await onlyCall(hung.run.id)).toMatchObject({
      state: 'unknown',
      error_code: 'timeout',
      saved_values: {},
    });
    expect(await drive(s.c, hung.conv, hung.run.id)).toBe('ended');
    expect(await stepLog(hung.run.id)).toContainEqual({
      outcome: 'responded',
      node_id: 'call',
      branch: 'failure',
      detail: 'timeout',
    });

    // The worker never got to it: at the deadline it is cancelled, and never sent afterwards.
    const idle = await waitingAtCall(s);
    expect(await drive(s.c, idle.conv, idle.run.id, pastDeadline)).toBe('ended');
    expect(await onlyCall(idle.run.id)).toMatchObject({
      state: 'canceled',
      error_code: 'not_started',
      request_ciphertext: null,
    });
    const before = received.length;
    expect(await processHttpCall(httpDeps(), scopeOf(s), idle.call.id)).toBe('idle');
    expect(received.length).toBe(before);

    // A job that runs after the deadline (it waited, for example while the company was suspended)
    // does not send the call late; the run takes its failure branch.
    const late = await waitingAtCall(s);
    expect(await processHttpCall(httpDeps(egress(), pastDeadline), scopeOf(s), late.call.id)).toBe(
      'canceled',
    );
    expect(await onlyCall(late.run.id)).toMatchObject({
      state: 'canceled',
      error_code: 'not_started',
    });
    expect(received.length).toBe(before);
    expect(await drive(s.c, late.conv, late.run.id, pastDeadline)).toBe('ended');
    expect(await stepLog(late.run.id)).toContainEqual({
      outcome: 'responded',
      node_id: 'call',
      branch: 'failure',
      detail: 'not_started',
    });
  });

  it('settles open calls when a member takes the conversation over', async () => {
    const s = await setup();
    await publish(s.owner, orderGraph('/orders/5'));
    const waiting = await waitingAtCall(s);
    await automations().takeOver(s.owner, waiting.conv);
    expect(await onlyRun(waiting.conv)).toMatchObject({
      status: 'taken_over',
      end_reason: 'take_over',
    });
    expect(await onlyCall(waiting.run.id)).toMatchObject({
      state: 'canceled',
      error_code: 'run_ended',
      request_ciphertext: null,
    });
    const before = received.length;
    expect(await processHttpCall(httpDeps(), scopeOf(s), waiting.call.id)).toBe('idle');
    expect(received.length).toBe(before);

    // A call left in flight by a worker that died: no runner is left to settle it, so ending the
    // run makes its outcome unknown and erases the stored request.
    const crashed = await waitingAtCall(s);
    const dying: EgressClient = {
      request: async () => {
        throw new Error('worker process died');
      },
    };
    await expect(processHttpCall(httpDeps(dying), scopeOf(s), crashed.call.id)).rejects.toThrow(
      'worker process died',
    );
    await automations().takeOver(s.owner, crashed.conv);
    expect(await onlyCall(crashed.run.id)).toMatchObject({
      state: 'unknown',
      error_code: 'run_ended_in_flight',
      request_ciphertext: null,
    });
    expect(await processHttpCall(httpDeps(), scopeOf(s), crashed.call.id)).toBe('idle');
    expect(received.length).toBe(before);
  });

  it('finds queued calls whose job was lost', async () => {
    const s = await setup();
    await publish(s.owner, orderGraph('/orders/6'));
    // Recorded a minute ago, and still queued: its job was lost.
    const lost = await waitingAtCall(s, later(-60_000));
    const fresh = await waitingAtCall(s);
    const due = await findDueHttpCalls(fx.dbs.app, 500);
    expect(due).toContainEqual({ tenantId: s.c.tenant.id, callId: lost.call.id });
    expect(due).not.toContainEqual({ tenantId: s.c.tenant.id, callId: fresh.call.id });
    expect(await processHttpCall(httpDeps(), scopeOf(s), lost.call.id)).toBe('succeeded');
    expect(await findDueHttpCalls(fx.dbs.app, 500)).not.toContainEqual({
      tenantId: s.c.tenant.id,
      callId: lost.call.id,
    });
    // A result recorded before the runner looks wins, even when the runner looks after the deadline.
    expect(await drive(s.c, lost.conv, lost.run.id, pastDeadline)).toBe('ended');
    expect(await stepLog(lost.run.id)).toContainEqual({
      outcome: 'responded',
      node_id: 'call',
      branch: 'success',
      detail: '200',
    });
    expect(await onlyRun(lost.conv)).toMatchObject({
      status: 'completed',
      variables: { status: 'shipped' },
    });
  });

  it('retention clears saved values after 30 days and deletes calls with their run', async () => {
    const s = await setup();
    await publish(s.owner, orderGraph('/orders/3'));
    const done = await waitingAtCall(s);
    expect(await processHttpCall(httpDeps(), scopeOf(s), done.call.id)).toBe('succeeded');
    expect(await drive(s.c, done.conv, done.run.id)).toBe('ended');
    expect((await onlyCall(done.run.id)).saved_values).toEqual({ status: 'shipped' });
    // A finished call is final.
    await expect(
      fx.query(
        `UPDATE app.automation_http_calls SET saved_values = '{"status": "x"}' WHERE id = $1`,
        [done.call.id],
      ),
    ).rejects.toThrow(/cannot change/);

    await backdateRun(done.run.id, 31);
    await applyAutomationRetention(fx.dbs.app);
    expect(await onlyCall(done.run.id)).toMatchObject({
      state: 'succeeded',
      status_code: 200,
      saved_values: {},
    });
    await backdateRun(done.run.id, 150);
    await applyAutomationRetention(fx.dbs.app);
    expect(await callsOf(done.run.id)).toEqual([]);
  });

  it('erasure clears saved values, cancels calls not made and keeps no late result', async () => {
    const s = await setup();
    await publish(s.owner, orderGraph('/orders/7'));
    const contacts = createContactsService({ db: fx.dbs.app, clock: systemClock });
    const contactOf = async (conv: string) => {
      const [row] = await fx.query<{ contact_id: string }>(
        `SELECT contact_id FROM app.conversations WHERE id = $1`,
        [conv],
      );
      return row!.contact_id;
    };

    // Completed with a saved value.
    const done = await waitingAtCall(s);
    expect(await processHttpCall(httpDeps(), scopeOf(s), done.call.id)).toBe('succeeded');
    expect(await drive(s.c, done.conv, done.run.id)).toBe('ended');
    expect((await onlyCall(done.run.id)).saved_values).toEqual({ status: 'shipped' });
    // Still queued.
    const queued = await waitingAtCall(s);
    // In flight while the contact is erased.
    const flying = await waitingAtCall(s);
    let started!: () => void;
    const requested = new Promise<void>((resolve) => (started = resolve));
    let respond!: (response: EgressResponse) => void;
    const held: EgressClient = {
      request: () => {
        started();
        return new Promise<EgressResponse>((resolve) => (respond = resolve));
      },
    };
    const pending = processHttpCall(httpDeps(held), scopeOf(s), flying.call.id);
    await requested;

    for (const conv of [done.conv, queued.conv, flying.conv]) {
      await contacts.eraseContact(s.owner, { contactId: await contactOf(conv), suppress: false });
    }
    expect(await onlyCall(flying.run.id)).toMatchObject({
      state: 'unknown',
      error_code: 'contact_erased',
      request_ciphertext: null,
    });
    expect(await onlyCall(done.run.id)).toMatchObject({ state: 'succeeded', saved_values: {} });
    expect(await onlyCall(queued.run.id)).toMatchObject({
      state: 'canceled',
      error_code: 'contact_erased',
      request_ciphertext: null,
    });
    expect(await onlyRun(queued.conv)).toMatchObject({
      status: 'stopped',
      end_reason: 'contact_erased',
    });
    expect(await processHttpCall(httpDeps(), scopeOf(s), queued.call.id)).toBe('idle');

    respond({
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ data: { status: 'shipped' } })),
      address: '127.0.0.1',
      durationMs: 5,
    });
    expect(await pending).toBe('unknown');
    // The request was made before the erasure; its result is not kept.
    expect(await onlyCall(flying.run.id)).toMatchObject({
      state: 'unknown',
      status_code: null,
      saved_values: {},
      request_ciphertext: null,
    });
    expect(await onlyRun(flying.conv)).toMatchObject({ status: 'stopped', variables: {} });
  });
});

describe('web request settings', () => {
  it('are managed by administrators, audited, and never return secret values', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const marketer = await fx.ctx(c, c.marketer);
    const agent = await fx.ctx(c, c.agent);
    const svc = webRequests();

    await expectAppError(svc.addDomain(marketer, { domain: HOST }), 'forbidden');
    await expectAppError(svc.settings(agent), 'forbidden');
    const { id: domainId } = await svc.addDomain(owner, { domain: ' API.Shop.TEST. ' });
    await expectAppError(svc.addDomain(owner, { domain: HOST }), 'conflict', /already allowed/);
    await expectAppError(svc.addDomain(owner, { domain: 'https://x.test/' }), 'validation_failed');
    await expectAppError(svc.addDomain(owner, { domain: 'localhost' }), 'validation_failed');
    await svc.addDomain(owner, { domain: '*.partner.test' });

    await expectAppError(
      svc.saveSecret(owner, { name: 'shop_token', domain: 'other.test', value: 'xxxx-value' }),
      'validation_failed',
      /allowed domains/,
    );
    await expectAppError(
      svc.saveSecret(owner, { name: 'Shop-Token', domain: HOST, value: 'xxxx-value' }),
      'validation_failed',
    );
    await expectAppError(
      svc.saveSecret(owner, { name: 'shop_token', domain: HOST, value: 'a\r\nb' }),
      'validation_failed',
    );
    await expectAppError(
      svc.saveSecret(marketer, { name: 'shop_token', domain: HOST, value: 'xxxx-value' }),
      'forbidden',
    );
    const created = await svc.saveSecret(owner, { name: 'shop_token', domain: HOST, value: TOKEN });
    expect(created.created).toBe(true);
    const updated = await svc.saveSecret(owner, {
      name: 'shop_token',
      domain: HOST,
      value: 'rotated-token-77',
    });
    expect(updated).toEqual({ id: created.id, created: false });

    const view = await svc.settings(marketer);
    expect(view.canManage).toBe(false);
    expect(view.domains.map((d) => d.domain)).toEqual(['*.partner.test', HOST]);
    expect(view.secrets).toEqual([
      expect.objectContaining({
        id: created.id,
        name: 'shop_token',
        domain: HOST,
        domainAllowed: true,
        version: 2,
      }),
    ]);
    expect(JSON.stringify(view)).not.toContain('rotated-token-77');
    expect(JSON.stringify(view)).not.toContain(TOKEN);

    // Encrypted and bound to its row: the ciphertext does not open under another row's binding.
    const [row] = await fx.query<{ value_ciphertext: string }>(
      `SELECT value_ciphertext FROM app.http_secrets WHERE id = $1`,
      [created.id],
    );
    expect(row!.value_ciphertext).not.toContain('rotated-token-77');
    expect(
      fx.keyring.decryptString(row!.value_ciphertext, httpSecretAad(c.tenant.id, created.id)),
    ).toBe('rotated-token-77');
    expect(() =>
      fx.keyring.decryptString(row!.value_ciphertext, httpSecretAad(c.tenant.id, domainId)),
    ).toThrow();

    // Removing the domain leaves the secret unusable, and says so.
    await svc.removeDomain(owner, { id: domainId });
    expect((await svc.settings(owner)).secrets[0]).toMatchObject({ domainAllowed: false });
    await svc.deleteSecret(owner, { id: created.id });
    expect((await svc.settings(owner)).secrets).toEqual([]);

    const audit = await fx.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action LIKE 'http.%' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'http.domain_added',
      'http.domain_added',
      'http.secret_created',
      'http.secret_updated',
      'http.domain_removed',
      'http.secret_deleted',
    ]);
    expect(audit[2]?.metadata).toEqual({ name: 'shop_token', domain: HOST });
    expect(JSON.stringify(audit)).not.toContain('rotated-token-77');
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
  });

  it('are isolated between companies, like the calls', async () => {
    const a = await setup();
    await publish(a.owner, orderGraph('/orders/8'));
    const call = await waitingAtCall(a);
    const b = await fx.company();
    const ownerB = await fx.ctx(b, b.owner);
    const svc = webRequests();

    const viewB = await svc.settings(ownerB);
    expect(viewB.domains).toEqual([]);
    expect(viewB.secrets).toEqual([]);
    await expectAppError(svc.removeDomain(ownerB, { id: a.domainId }), 'not_found');
    await expectAppError(svc.deleteSecret(ownerB, { id: a.secretId }), 'not_found');
    // B's scope cannot claim A's call, and B's rules never apply to it.
    const before = received.length;
    expect(
      await processHttpCall(httpDeps(), authorizedTenantScope(b.tenant.id, null), call.call.id),
    ).toBe('idle');
    expect(received.length).toBe(before);
    expect((await onlyCall(call.run.id)).state).toBe('queued');
    // B allowing the same host does not let B's automations use A's secret.
    await svc.addDomain(ownerB, { domain: HOST });
    await expectAppError(
      publish(ownerB, orderGraph('/orders/8')),
      'precondition_failed',
      /secret “shop_token” does not exist/,
    );
  });
});
