import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_LIMITS,
  checkGraph,
  describeHttpSave,
  headerNamesSecret,
  parseGraph,
  responseHeaderRefusal,
  withHttpSaveSource,
  type AutomationGraph,
  type HttpSave,
} from './graph';
import {
  responseHeaderValue,
  savedValuesFrom,
  textualContentType,
  type SavableResponse,
} from './http';
import { advance, initialRunState, type RunState } from './interpreter';

/** ADR-406: an HTTP step saves values from a JSON path, a header, the body as text or the status. */

const callNode = (save: unknown[], headers: unknown[] = []) => ({
  id: 'call',
  type: 'http_request',
  method: 'GET',
  url: 'https://api.shop.example/orders',
  headers,
  body: null,
  save,
  next: 'tell',
  failureNext: null,
});

const rawGraph = (save: unknown[], headers: unknown[] = []) => ({
  version: 1,
  start: 'call',
  nodes: [
    callNode(save, headers),
    { id: 'tell', type: 'send_text', text: 'Ref {{answer.ref}}.', next: null },
  ],
});

function graphOf(input: unknown): AutomationGraph {
  const parsed = parseGraph(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.graph;
}

function savesOf(graph: AutomationGraph): HttpSave[] {
  const node = graph.nodes.find((n) => n.type === 'http_request');
  if (node?.type !== 'http_request') throw new Error('no http step');
  return node.save;
}

const parseMessages = (input: unknown): string[] => {
  const parsed = parseGraph(input);
  return parsed.ok ? [] : parsed.issues.map((i) => i.message);
};

const response = (over: Partial<SavableResponse> = {}): SavableResponse => ({
  status: 200,
  headers: {},
  body: Buffer.alloc(0),
  ...over,
});

describe('saved value sources in the graph (ADR-406)', () => {
  it('reads a stored {path, saveAs} as a JSON path and gives it back unchanged', () => {
    const save = [{ path: 'data.status', saveAs: 'ref' }];
    const graph = graphOf(rawGraph(save));
    // No `from` is added: a stored graph, its versions and its exports read as before.
    expect(savesOf(graph)).toStrictEqual(save);
    expect(JSON.stringify(graph)).toBe(JSON.stringify(rawGraph(save)));
  });

  it('keeps each source with only the fields it uses', () => {
    const graph = graphOf(
      rawGraph([
        { from: 'json', path: 'data.id', saveAs: 'a' },
        { from: 'header', header: 'X-Request-Id', saveAs: 'b', path: 'stray' },
        { from: 'text', saveAs: 'c', header: 'stray' },
        { from: 'status', saveAs: 'd', path: 'stray' },
      ]),
    );
    expect(savesOf(graph)).toStrictEqual([
      { from: 'json', path: 'data.id', saveAs: 'a' },
      { from: 'header', header: 'X-Request-Id', saveAs: 'b' },
      { from: 'text', saveAs: 'c' },
      { from: 'status', saveAs: 'd' },
    ]);
  });

  it('refuses a bad path, a missing or bad header name and an unknown source', () => {
    expect(parseMessages(rawGraph([{ path: 'a..b', saveAs: 'ref' }]))).toContain(
      'Use a path such as data.order.status.',
    );
    expect(parseMessages(rawGraph([{ saveAs: 'ref' }]))).toContain(
      'Use a path such as data.order.status.',
    );
    expect(parseMessages(rawGraph([{ from: 'header', saveAs: 'ref' }]))).toContain(
      'Enter a header name.',
    );
    expect(parseMessages(rawGraph([{ from: 'header', header: 'X Id', saveAs: 'ref' }]))).toContain(
      'Header names use letters, digits and - (at most 60).',
    );
    expect(parseGraph(rawGraph([{ from: 'cookie', saveAs: 'ref' }])).ok).toBe(false);
    // A status or text source needs no path.
    expect(parseGraph(rawGraph([{ from: 'status', saveAs: 'ref' }])).ok).toBe(true);
    expect(parseGraph(rawGraph([{ from: 'text', saveAs: 'ref' }])).ok).toBe(true);
  });

  it('refuses headers that carry credentials or session state when the graph is saved', () => {
    for (const name of [
      'Set-Cookie',
      'set-cookie',
      'Set-Cookie2',
      'Cookie',
      'Authorization',
      'WWW-Authenticate',
      'Proxy-Authenticate',
      'Authentication-Info',
      'X-Api-Key',
      'X-ApiKey',
      'Api-Key',
      'X-Auth-Token',
      'X-Access-Token',
      'X-Session-Id',
      'X-CSRF-Token',
      'X-XSRF-TOKEN',
      'X-Client-Secret',
      'X-Password',
      'X-Amz-Security-Token',
      'X-Signature',
      'X-Credentials',
      'X-Functions-Key',
    ]) {
      const message = `The ${name} header can carry credentials or a session, so HyFib does not save it.`;
      expect(responseHeaderRefusal(name), name).toBe(message);
      expect(parseMessages(rawGraph([{ from: 'header', header: name, saveAs: 'ref' }]))).toContain(
        message,
      );
    }
    for (const name of [
      'X-Request-Id',
      'Location',
      'ETag',
      'X-RateLimit-Remaining',
      'Content-Type',
      'Keep-Alive',
      'X-Monkey',
    ]) {
      expect(responseHeaderRefusal(name), name).toBeNull();
    }
  });

  it('refuses at publish a header the step sends a secret in, or one named like a secret', () => {
    const errors = (graph: AutomationGraph) =>
      checkGraph(graph, {
        allowedDomains: ['api.shop.example'],
        secrets: new Map([
          ['shop_token', 'api.shop.example'],
          ['crm_ref', 'api.shop.example'],
        ]),
      })
        .filter((i) => i.level === 'error')
        .map((i) => i.message);
    const sendsSecret = [{ name: 'X-Shop', value: 'Bearer {{ secret.shop_token }}' }];
    expect(
      errors(graphOf(rawGraph([{ from: 'header', header: 'x-shop', saveAs: 'ref' }], sendsSecret))),
    ).toContain(
      'This step sends a secret in the x-shop header, so HyFib does not save that header from the response.',
    );
    // A header the step sends without a secret may be saved.
    expect(
      errors(
        graphOf(
          rawGraph(
            [{ from: 'header', header: 'X-Shop', saveAs: 'ref' }],
            [{ name: 'X-Shop', value: 'plain' }],
          ),
        ),
      ),
    ).toEqual([]);
    expect(
      errors(graphOf(rawGraph([{ from: 'header', header: 'X-Crm-Ref', saveAs: 'ref' }]))),
    ).toContain(
      'The X-Crm-Ref header is named like the secret “crm_ref”, so HyFib does not save it.',
    );
    expect(
      errors(graphOf(rawGraph([{ from: 'header', header: 'X-Crm-Reference', saveAs: 'ref' }]))),
    ).toEqual([]);
    expect(headerNamesSecret('Crm-Ref', 'crm_ref')).toBe(true);
    expect(headerNamesSecret('X-Crm-Refs', 'crm_ref')).toBe(false);
  });

  it('a value saved by any source is an answer later steps can use', () => {
    for (const item of [
      { from: 'header', header: 'X-Request-Id', saveAs: 'ref' },
      { from: 'text', saveAs: 'ref' },
      { from: 'status', saveAs: 'ref' },
    ]) {
      const graph = graphOf(rawGraph([item]));
      const issues = checkGraph(graph, { allowedDomains: ['api.shop.example'] });
      expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    }
  });

  it('changes a value’s source in the editor, keeping its name', () => {
    const old: HttpSave = { path: 'data.id', saveAs: 'ref' };
    expect(withHttpSaveSource(old, 'header')).toStrictEqual({
      from: 'header',
      header: 'X-Request-Id',
      saveAs: 'ref',
    });
    expect(withHttpSaveSource(old, 'status')).toStrictEqual({ from: 'status', saveAs: 'ref' });
    expect(withHttpSaveSource(old, 'text')).toStrictEqual({ from: 'text', saveAs: 'ref' });
    expect(withHttpSaveSource(old, 'json')).toStrictEqual({
      from: 'json',
      path: 'data.id',
      saveAs: 'ref',
    });
    expect(withHttpSaveSource({ from: 'status', saveAs: 'ref' }, 'json')).toStrictEqual({
      from: 'json',
      path: 'data.status',
      saveAs: 'ref',
    });
    expect(
      withHttpSaveSource({ from: 'header', header: 'ETag', saveAs: 'ref' }, 'header'),
    ).toStrictEqual({ from: 'header', header: 'ETag', saveAs: 'ref' });
    // Anything the select does not offer is a JSON path.
    expect(withHttpSaveSource({ from: 'text', saveAs: 'ref' }, 'bogus')).toMatchObject({
      from: 'json',
    });
    expect(describeHttpSave(old)).toBe('data.id');
    expect(describeHttpSave({ from: 'header', header: 'ETag', saveAs: 'e' })).toBe(
      'the ETag header',
    );
    expect(describeHttpSave({ from: 'text', saveAs: 'e' })).toBe('the body as text');
    expect(describeHttpSave({ from: 'status', saveAs: 'e' })).toBe('the status code');
  });

  it('carries the sources in the request effect and saves the values the worker found', () => {
    const graph = graphOf(
      rawGraph([
        { path: 'data.id', saveAs: 'id' },
        { from: 'header', header: 'X-Request-Id', saveAs: 'ref' },
        { from: 'status', saveAs: 'code' },
      ]),
    );
    const now = new Date('2026-10-21T10:00:00Z');
    const facts = {
      contactName: 'Asha',
      companyName: 'Acme',
      tags: new Set<string>(),
      conversationTags: new Set<string>(),
      fields: {},
      businessOpen: true,
    };
    const run = (state: RunState, event: Parameters<typeof advance>[0]['event']) =>
      advance({ graph, state, event, facts, runId: 'r', now });
    const calling = run(initialRunState(graph), { kind: 'continue' });
    expect(calling.effects[0]).toMatchObject({
      kind: 'http_request',
      save: [
        { path: 'data.id', saveAs: 'id' },
        { from: 'header', header: 'X-Request-Id', saveAs: 'ref' },
        { from: 'status', saveAs: 'code' },
      ],
    });
    const done = run(calling.state, {
      kind: 'http_result',
      ok: true,
      values: { ref: 'abc-1', code: '201' },
      detail: '201',
    });
    expect(done.state.variables).toStrictEqual({ ref: 'abc-1', code: '201' });
    expect(run(done.state, { kind: 'continue' }).effects).toEqual([
      { kind: 'send_text', text: 'Ref abc-1.' },
    ]);
  });
});

describe('values saved from a response (ADR-406)', () => {
  it('keeps saving JSON paths as before, old items included', () => {
    const body = Buffer.from(JSON.stringify({ data: { id: 7, ok: true, name: 'A' } }));
    expect(
      savedValuesFrom(response({ body }), [
        { path: 'data.id', saveAs: 'id' },
        { from: 'json', path: 'data.ok', saveAs: 'ok' },
        { path: 'data.missing', saveAs: 'gone' },
      ]),
    ).toStrictEqual({ id: '7', ok: 'true' });
  });

  it('saves a header by name, case-insensitively, and leaves out one the response lacks', () => {
    const headers = { 'x-request-id': 'req-42', etag: '"v1"' };
    expect(
      savedValuesFrom(response({ headers }), [
        { from: 'header', header: 'X-Request-ID', saveAs: 'ref' },
        { from: 'header', header: 'ETag', saveAs: 'tag' },
        { from: 'header', header: 'X-Absent', saveAs: 'none' },
      ]),
    ).toStrictEqual({ ref: 'req-42', tag: '"v1"' });
  });

  it('joins a header given several times with a comma and a space, in order', () => {
    expect(responseHeaderValue({ 'x-trace': 'a, b' }, 'X-Trace')).toBe('a, b');
    // Names differing only in case (not from Node, but possible in a stand-in) join the same way.
    expect(responseHeaderValue({ 'X-Trace': 'a', 'x-trace': 'b' }, 'x-trace')).toBe('a, b');
    expect(responseHeaderValue({}, 'x-trace')).toBeNull();
    expect(
      savedValuesFrom(response({ headers: { 'X-Trace': 'a', 'x-trace': 'b' } }), [
        { from: 'header', header: 'X-Trace', saveAs: 't' },
      ]),
    ).toStrictEqual({ t: 'a, b' });
  });

  it('clips a header value as answers are clipped', () => {
    const long = 'h'.repeat(AUTOMATION_LIMITS.answerLength + 50);
    const saved = savedValuesFrom(response({ headers: { 'x-long': long } }), [
      { from: 'header', header: 'X-Long', saveAs: 'v' },
    ]);
    expect(saved.v).toHaveLength(AUTOMATION_LIMITS.answerLength);
  });

  it('saves the body as text only for textual content types in UTF-8', () => {
    for (const type of [
      'text/plain',
      'text/plain; charset=utf-8',
      'text/csv;charset="UTF-8"',
      'text/html; charset=us-ascii',
      'application/json',
      'application/problem+json',
      'application/xml',
      'application/soap+xml; charset=utf8',
    ]) {
      expect(textualContentType(type), type).toBe(true);
    }
    for (const type of [
      null,
      '',
      'image/png',
      'application/octet-stream',
      'application/pdf',
      'text/plain; charset=iso-8859-1',
      'application/jsonp',
      'multipart/form-data; boundary=x',
      'application/x-www-form-urlencoded',
    ]) {
      expect(textualContentType(type), String(type)).toBe(false);
    }
    const body = Buffer.from('  Order 42 is packed.\n');
    const save: HttpSave[] = [{ from: 'text', saveAs: 'note' }];
    expect(
      savedValuesFrom(response({ body, headers: { 'content-type': 'text/plain' } }), save),
    ).toStrictEqual({ note: 'Order 42 is packed.' });
    expect(
      savedValuesFrom(response({ body, headers: { 'content-type': 'image/png' } }), save),
    ).toStrictEqual({});
    expect(savedValuesFrom(response({ body }), save)).toStrictEqual({});
    expect(
      savedValuesFrom(
        response({ body: Buffer.from(' \n '), headers: { 'content-type': 'text/plain' } }),
        save,
      ),
    ).toStrictEqual({});
  });

  it('decodes text as UTF-8, drops a byte order mark and clips it', () => {
    const headers = { 'content-type': 'text/plain; charset=utf-8' };
    const save: HttpSave[] = [{ from: 'text', saveAs: 'note' }];
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('பிரியா')]);
    expect(savedValuesFrom(response({ body: bom, headers }), save)).toStrictEqual({
      note: 'பிரியா',
    });
    const invalid = Buffer.from([0x61, 0xff, 0x62]);
    expect(savedValuesFrom(response({ body: invalid, headers }), save)).toStrictEqual({
      note: 'a�b',
    });
    // Clipped without splitting an emoji.
    const long = Buffer.from(`${'x'.repeat(AUTOMATION_LIMITS.answerLength - 1)}😀 and more`);
    expect(savedValuesFrom(response({ body: long, headers }), save)).toStrictEqual({
      note: 'x'.repeat(AUTOMATION_LIMITS.answerLength - 1),
    });
  });

  it('saves the status code', () => {
    expect(
      savedValuesFrom(response({ status: 201 }), [{ from: 'status', saveAs: 'code' }]),
    ).toStrictEqual({ code: '201' });
  });

  it('still saves a header, the text and the status when the body is not JSON', () => {
    const saved = savedValuesFrom(
      response({
        status: 202,
        headers: { 'content-type': 'text/plain', 'x-request-id': 'r1' },
        body: Buffer.from('queued'),
      }),
      [
        { path: 'data.id', saveAs: 'id' },
        { from: 'header', header: 'X-Request-Id', saveAs: 'ref' },
        { from: 'text', saveAs: 'note' },
        { from: 'status', saveAs: 'code' },
      ],
    );
    expect(saved).toStrictEqual({ ref: 'r1', note: 'queued', code: '202' });
  });

  it('never saves a refused header, even from a request written without the checks', () => {
    const headers = { 'set-cookie': 'sid=1', authorization: 'Bearer x', 'x-api-key': 'k' };
    expect(
      savedValuesFrom(response({ headers }), [
        { from: 'header', header: 'Set-Cookie', saveAs: 'a' },
        { from: 'header', header: 'Authorization', saveAs: 'b' },
        { from: 'header', header: 'X-Api-Key', saveAs: 'c' },
      ]),
    ).toStrictEqual({});
  });

  it('never saves a header the request sent a secret in, or one named like a secret', () => {
    const headers = { 'x-shop': 'Bearer s3cr3t-value', 'x-crm-ref': 'r', 'x-other': 'o' };
    const save: HttpSave[] = [
      { from: 'header', header: 'X-Shop', saveAs: 'a' },
      { from: 'header', header: 'X-Crm-Ref', saveAs: 'b' },
      { from: 'header', header: 'X-Other', saveAs: 'c' },
    ];
    expect(
      savedValuesFrom(response({ headers }), save, {
        requestHeaders: [{ name: 'x-shop', value: 'Bearer {{secret.shop_token}}' }],
        secretNames: ['shop_token', 'crm_ref'],
      }),
    ).toStrictEqual({ c: 'o' });
  });

  it('leaves out any value holding a secret the request carried', () => {
    const secret = 's3cr3t-value';
    const saved = savedValuesFrom(
      response({
        headers: { 'content-type': 'application/json', 'x-echo': `got ${secret}` },
        body: Buffer.from(JSON.stringify({ echo: secret, id: 'ok' })),
      }),
      [
        { from: 'header', header: 'X-Echo', saveAs: 'a' },
        { from: 'text', saveAs: 'b' },
        { path: 'echo', saveAs: 'c' },
        { path: 'id', saveAs: 'd' },
      ],
      { secretValues: [secret, ''] },
    );
    expect(saved).toStrictEqual({ d: 'ok' });
  });
});
