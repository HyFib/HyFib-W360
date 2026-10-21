import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_LIMITS,
  checkGraph,
  secretAdjacencyProblem,
  describeHttpSave,
  headerNamesSecret,
  parseGraph,
  responseHeaderRefusal,
  withHttpSaveSource,
  type AutomationGraph,
  type HttpSave,
} from './graph';
import {
  adjacentSecrets,
  ECHO_ANYWHERE_SECRET_LENGTH,
  ECHO_LONG_SECRET_LENGTH,
  echoedSecret,
  holdsSecret,
  looseSecretValuesOf,
} from './echo';
import { webRequestSecretSchema } from './web-requests';
import {
  responseHeaderValue,
  savedValuesFrom as savedFrom,
  textualContentType,
  type SavableResponse,
} from './http';
import { advance, initialRunState, type RunState } from './interpreter';

/** The values saved (what most tests check; `savedFrom` also gives the answers left out). */
const savedValuesFrom = (...args: Parameters<typeof savedFrom>) => savedFrom(...args).values;

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
      'X-Accesskey',
      'X-Privatekey',
      'X-Monkey',
      'X-JWT',
      'X-Bearer-Info',
      'X-Pwd',
      'X-OTP-Code',
      'X-Hmac-Sig',
      'X-Auth',
      'X-OAuth-Scopes',
      'X-Authz-Scope',
      'X-Authn',
      'X-Passcode',
      'X-Hmac',
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
      'Author',
      'X-Author',
      'X-Design',
      'X-Hotpath',
      'X-Signal',
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
    expect(headerNamesSecret('X-Crm-Ref-Id', 'crm_ref')).toBe(true);
    expect(headerNamesSecret('X-Crm-Refs', 'crm_ref')).toBe(false);
    // A short secret name matches only the whole header name (an X- prefix aside).
    expect(headerNamesSecret('X-Ref', 'ref')).toBe(true);
    expect(headerNamesSecret('Ref', 'ref')).toBe(true);
    expect(headerNamesSecret('X-Request-Id', 'id')).toBe(false);
    expect(headerNamesSecret('X-Ref-Count', 'ref')).toBe(false);
    expect(headerNamesSecret('X-Order-Ref', 'order')).toBe(false);
    // A secret named with the x_ prefix still names its header.
    expect(headerNamesSecret('X-Shop-Ref', 'x_shop_ref')).toBe(true);
    expect(headerNamesSecret('Shop-Ref', 'x_shop_ref')).toBe(true);
    expect(headerNamesSecret('X-Shop-Ref-Id', 'x_shop_ref')).toBe(true);
    expect(headerNamesSecret('X-Request-Id', 'x_id')).toBe(false);
  });

  it('refuses at publish a secret touching a letter, a digit or a placeholder in a step that saves values', () => {
    const errors = (value: string, save: unknown[] = [{ from: 'status', saveAs: 'ref' }]) =>
      checkGraph(graphOf(rawGraph(save, [{ name: 'X-Probe', value }])), {
        allowedDomains: ['api.shop.example'],
        secrets: new Map([['crm_pin', 'api.shop.example']]),
      })
        .filter((i) => i.level === 'error')
        .map((i) => i.message);
    const message =
      'In the X-Probe header, put a separator (a space, -, :, =, comma, ;, / or .) between {{secret.crm_pin}} and the text or placeholder beside it, so that HyFib can recognise the secret if the server sends it back.';
    for (const value of [
      'q{{secret.crm_pin}}q',
      '{{secret.crm_pin}}{{secret.crm_pin}}',
      '%41{{secret.crm_pin}}',
      '{{secret.crm_pin}}1',
      '{{name}}{{secret.crm_pin}}',
      '{{ SECRET.crm_pin }}x',
    ]) {
      expect(errors(value), value).toContain(message);
      expect(secretAdjacencyProblem('X-Probe', value), value).toBe(message);
    }
    for (const value of [
      'Bearer {{secret.crm_pin}}',
      'pin={{secret.crm_pin}}; v=1',
      'a-{{secret.crm_pin}}-b',
      'k:{{secret.crm_pin}},{{secret.crm_pin}}/x.{{name}}',
    ]) {
      expect(errors(value), value).toEqual([]);
    }
    // A step that saves nothing from the response has nothing to hand back.
    expect(errors('q{{secret.crm_pin}}q', [])).not.toContain(message);
  });

  it('refuses new secret values shorter than four characters', () => {
    const parse = (value: string) =>
      webRequestSecretSchema.safeParse({ domain: 'api.shop.example', name: 'pin', value });
    expect(parse('482').error?.issues.map((i) => i.message)).toStrictEqual([
      'Secret values need at least 4 characters.',
    ]);
    expect(parse('').error?.issues[0]?.message).toBe('Enter the secret value.');
    expect(parse('4829').success).toBe(true);
    // Spaces around the value do not count towards the four characters.
    for (const value of ['    ', ' 48 ', '\t482\t']) {
      expect(
        parse(value).error?.issues.map((i) => i.message),
        JSON.stringify(value),
      ).toStrictEqual(['Secret values need at least 4 characters.']);
    }
    expect(parse(' 4829 ').success).toBe(true);
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

  it('leaves out a refused header and names it, even from a request written without the checks', () => {
    const headers = { 'set-cookie': 'sid=1', authorization: 'Bearer x', 'x-api-key': 'k' };
    expect(
      savedFrom(response({ headers }), [
        { from: 'header', header: 'Set-Cookie', saveAs: 'a' },
        { from: 'header', header: 'Authorization', saveAs: 'b' },
        { from: 'header', header: 'X-Api-Key', saveAs: 'c' },
        { from: 'header', header: 'X-Absent-Key', saveAs: 'd' },
      ]),
    ).toStrictEqual({
      values: {},
      dropped: {
        a: 'refused_header',
        b: 'refused_header',
        c: 'refused_header',
        d: 'refused_header',
      },
    });
  });

  it('leaves out a header the request sent a secret in, or one named like a secret, and names it', () => {
    const headers = { 'x-shop': 'Bearer s3cr3t-value', 'x-crm-ref': 'r', 'x-other': 'o' };
    const save: HttpSave[] = [
      { from: 'header', header: 'X-Shop', saveAs: 'a' },
      { from: 'header', header: 'X-Crm-Ref', saveAs: 'b' },
      { from: 'header', header: 'X-Other', saveAs: 'c' },
    ];
    expect(
      savedFrom(response({ headers }), save, {
        requestHeaders: [{ name: 'x-shop', value: 'Bearer {{secret.shop_token}}' }],
        secretNames: ['shop_token', 'crm_ref'],
      }),
    ).toStrictEqual({ values: { c: 'o' }, dropped: { a: 'secret_header', b: 'secret_header' } });
  });

  it('leaves out any value holding a secret the request carried, and names it', () => {
    const secret = 's3cr3t-value';
    expect(
      savedFrom(
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
      ),
    ).toStrictEqual({
      values: { d: 'ok' },
      dropped: { a: 'echoed_secret', b: 'echoed_secret', c: 'echoed_secret' },
    });
  });

  it('checks the whole value before clipping: a secret across the cut is not saved', () => {
    const secret = 'sk_live_AbC/9+xyZ=';
    const limit = AUTOMATION_LIMITS.answerLength;
    // Padding puts the cut inside the secret at every offset (12 of 19 characters, say).
    for (const before of [limit - 12, limit - 4, limit - 1, limit - secret.length + 1]) {
      const echoed = `${'p'.repeat(before)}${secret}`;
      const guard = { secretValues: [secret] };
      const header = savedFrom(
        response({ headers: { 'x-echo': echoed } }),
        [{ from: 'header', header: 'X-Echo', saveAs: 'h' }],
        guard,
      );
      const text = savedFrom(
        response({ headers: { 'content-type': 'text/plain' }, body: Buffer.from(echoed) }),
        [{ from: 'text', saveAs: 't' }],
        guard,
      );
      const json = savedFrom(
        response({ body: Buffer.from(JSON.stringify({ h: echoed })) }),
        [{ path: 'h', saveAs: 'j' }],
        guard,
      );
      expect([header, text, json], String(before)).toStrictEqual([
        { values: {}, dropped: { h: 'echoed_secret' } },
        { values: {}, dropped: { t: 'echoed_secret' } },
        { values: {}, dropped: { j: 'echoed_secret' } },
      ]);
    }
  });

  it('leaves out a value ending with the start of a secret after other text as a possible cut echo', () => {
    const secret = 'sk_live_AbC/9+xyZ=';
    const cut = (value: string) =>
      savedFrom(
        response({ headers: { 'x-echo': value } }),
        [{ from: 'header', header: 'X-Echo', saveAs: 'h' }],
        { secretValues: [secret] },
      ).dropped;
    expect(cut('Bearer sk_live_Ab')).toStrictEqual({ h: 'possible_cut_echo' });
    expect(cut('Bearer sk_l')).toStrictEqual({ h: 'possible_cut_echo' });
    // Fewer than four characters of a secret's start are not enough to count.
    expect(cut('Bearer sk_')).toStrictEqual({});
  });

  it('saves a value that is only the start of a secret, unless it was clipped', () => {
    const secret = 'live_test_value_one';
    const body = Buffer.from(JSON.stringify({ mode: 'live', note: 'x'.repeat(2000) }));
    expect(
      savedFrom(response({ body }), [{ path: 'mode', saveAs: 'mode' }], { secretValues: [secret] }),
    ).toStrictEqual({ values: { mode: 'live' }, dropped: {} });
    // Clipped right after the start of the secret (the whole value goes on differently): the
    // saved part ends with the secret's start, so it may be a cut echo.
    const raw = `${'x'.repeat(AUTOMATION_LIMITS.answerLength - 7)}live_teZZZ`;
    expect(echoedSecret(raw, raw.slice(0, AUTOMATION_LIMITS.answerLength), [secret])).toBe(
      'possible_cut_echo',
    );
    expect(echoedSecret(raw, raw, [secret])).toBeNull();
    expect(echoedSecret('live', 'live', [secret])).toBeNull();
  });

  it('recognises a secret echoed in ordinary encodings', () => {
    const secret = 'sk_live_AbC/9+xyZ=';
    const headers = { 'content-type': 'text/plain' };
    const echoes = [
      // JSON with "/" escaped (PHP's default) and with \u escapes.
      `{"h":"Bearer sk_live_AbC\\/9+xyZ="}`,
      `{"h":"Bearer sk_live_AbC\\u002F9\\u002BxyZ\\u003D"}`,
      // URL and form encoding.
      `h=${encodeURIComponent(`Bearer ${secret}`)}`,
      `h=Bearer+sk_live_AbC%2F9%2BxyZ%3D`,
      // XML and HTML character references.
      `<h>Bearer sk_live_AbC&#x2F;9&#43;xyZ&#61;</h>`,
      `<h>Bearer sk_live_AbC&sol;9&plus;xyZ&equals;</h>`,
      // base64 and base64url at each alignment.
      Buffer.from(`Bearer ${secret}`).toString('base64'),
      Buffer.from(`Bearer: ${secret}`).toString('base64'),
      Buffer.from(`Bearer:: ${secret}`).toString('base64url'),
      Buffer.from(secret).toString('base64'),
    ];
    for (const body of echoes) {
      expect(
        savedFrom(response({ headers, body: Buffer.from(body) }), [{ from: 'text', saveAs: 't' }], {
          secretValues: [secret],
        }),
        body,
      ).toStrictEqual({ values: {}, dropped: { t: 'echoed_secret' } });
    }
    // An encoded echo cut inside the secret is recognised too.
    const long = `${'p'.repeat(AUTOMATION_LIMITS.answerLength - 20)}{"h":"Bearer sk_live_AbC\\/9+xyZ="}`;
    expect(
      savedFrom(response({ headers, body: Buffer.from(long) }), [{ from: 'text', saveAs: 't' }], {
        secretValues: [secret],
      }).dropped,
    ).toStrictEqual({ t: 'echoed_secret' });
  });

  it('reads + as a space in a form-encoded echo, and an escape cut at the end', () => {
    // A secret with spaces, form-encoded with +.
    expect(holdsSecret('h=pass+word+1234', 'h=pass+word+1234', ['pass word 1234'])).toBe(true);
    const secret = 'sk_live_AbC/9+xyZ=';
    // The echo ends inside an escape: what precedes it still starts the secret.
    for (const cut of [
      'Bearer sk_live_AbC\\/9\\u00',
      'Bearer sk_live_AbC%2F9%2',
      'Bearer sk_live_AbC&#x2',
    ]) {
      expect(holdsSecret(cut, cut, [secret]), cut).toBe(true);
    }
    // base64url differs from base64 when the encoding holds + or /.
    const plusy = 's3cr3t?>~~value';
    expect(Buffer.from(plusy).toString('base64')).toContain('+');
    const url = `x=${Buffer.from(`>>>${plusy}`).toString('base64url')}.`;
    expect(holdsSecret(url, url, [plusy])).toBe(true);
  });

  it('finds a secret of six or seven characters anywhere, a shorter one as a whole token', () => {
    expect(ECHO_LONG_SECRET_LENGTH).toBe(8);
    expect(ECHO_ANYWHERE_SECRET_LENGTH).toBe(6);
    const echo = (value: string, secret: string) =>
      savedFrom(
        response({ headers: { 'x-echo': value } }),
        [{ from: 'header', header: 'X-Echo', saveAs: 'h' }],
        { secretValues: [secret] },
      ).dropped;
    // Six and seven characters: inside other text too.
    for (const [value, secret] of [
      ['482913', '482913'],
      ['ab482913', '482913'],
      ['q482913q', '482913'],
      ['order 14829137', '4829137'],
      ['%41482913', '482913'],
    ]) {
      expect(echo(value!, secret!), value).toStrictEqual({ h: 'echoed_secret' });
    }
    // Four and five characters: as a whole token only.
    for (const value of ['pin=4829', '{"pin":"4829"}', 'X-Pin: 4829.', 'a%204829']) {
      expect(echo(value, '4829'), value).toStrictEqual({ h: 'echoed_secret' });
    }
    for (const [value, secret] of [
      ['48290', '4829'],
      ['order 148291', '48291'],
      ['abcd4829x', '4829'],
      ['482', '4829'],
    ]) {
      expect(echo(value!, secret!), value).toStrictEqual({});
    }
    // The boundary counts only on a side where the secret's own edge is a letter or digit.
    expect(echoedSecret('x#123', 'x#123', ['#123'])).toBe('echoed_secret');
    expect(echoedSecret('x#1234', 'x#1234', ['#123'])).toBeNull();
    // The status is digits only: it is left out only when it is a short secret exactly.
    expect(
      savedFrom(response({ status: 201 }), [{ from: 'status', saveAs: 'code' }], {
        secretValues: ['20', '01', '2012'],
      }),
    ).toStrictEqual({ values: { code: '201' }, dropped: {} });
    expect(
      savedFrom(response({ status: 201 }), [{ from: 'status', saveAs: 'code' }], {
        secretValues: ['201'],
      }),
    ).toStrictEqual({ values: {}, dropped: { code: 'echoed_secret' } });
    // A long secret is found anywhere.
    expect(holdsSecret('x20123456y', 'x20123456y', ['20123456'])).toBe(true);
  });

  it('finds a short secret anywhere when the request sent it touching other text', () => {
    const pin = '4829';
    const echoes = ['q4829q', '48294829', '%414829', '１4829', '١4829'];
    for (const value of echoes) {
      // As a token it would pass; sent touching text, it counts anywhere.
      expect(echoedSecret(value, value, [pin]), value).toBeNull();
      expect(echoedSecret(value, value, [pin], [pin]), value).toBe('echoed_secret');
    }
    // Which secrets the rendered headers send touching a letter, a digit or another secret.
    expect(
      [
        ...adjacentSecrets([
          { parts: [{ text: 'q' }, { secret: 'a' }, { text: 'q' }] },
          { parts: [{ secret: 'b' }, { secret: 'c' }] },
          { parts: [{ text: '%41' }, { secret: 'd' }] },
          { parts: [{ secret: 'e' }, { text: '１' }] },
          { parts: [{ text: 'Bearer ' }, { secret: 'f' }, { text: '; v=1' }] },
          { parts: [{ secret: 'g' }] },
        ]),
      ].sort(),
    ).toStrictEqual(['a', 'b', 'c', 'd', 'e']);
    // The worker passes them on: a step published before the separator check loses the value.
    expect(
      savedFrom(
        response({ headers: { 'x-echo': 'You sent q4829q' } }),
        [{ from: 'header', header: 'X-Echo', saveAs: 'h' }],
        { secretValues: [pin], looseSecretValues: [pin] },
      ),
    ).toStrictEqual({ values: {}, dropped: { h: 'echoed_secret' } });
  });

  it('leaves out a value that is the first eight or more characters of a secret', () => {
    const secret = 'prefix_value_for_tests_only_x';
    const value = (v: string) =>
      savedFrom(
        response({ body: Buffer.from(JSON.stringify({ ref: v })) }),
        [{ path: 'ref', saveAs: 'ref' }],
        { secretValues: [secret] },
      );
    for (const prefix of [secret.slice(0, 8), secret.slice(0, 20), secret.slice(0, -1)]) {
      expect(value(prefix), prefix).toStrictEqual({
        values: {},
        dropped: { ref: 'possible_cut_echo' },
      });
    }
    // Seven characters or fewer with nothing before them are ordinary data ("live").
    expect(value(secret.slice(0, 7))).toStrictEqual({
      values: { ref: secret.slice(0, 7) },
      dropped: {},
    });
  });

  it('leaves out most of a six to ten character secret cut short, and saves "live"', () => {
    const cut = (value: string, probe: string) => echoedSecret(value, value, [probe]);
    // A bare start missing at most two characters, or after other text from four characters.
    expect(cut('Zq8vK2p', 'Zq8vK2pa')).toBe('possible_cut_echo');
    expect(cut('Zq8vK2p', 'Zq8vK2paX')).toBe('possible_cut_echo');
    expect(cut('ref=Zq8vK2', 'Zq8vK2p')).toBe('possible_cut_echo');
    expect(cut('ref=Zq8vK', 'Zq8vK2')).toBe('possible_cut_echo');
    // A bare start three or more characters short of a secret under eight characters.
    expect(cut('Zq8v', 'Zq8vK2p')).toBeNull();
    expect(cut('Zq8vK', 'Zq8vK2pa')).toBeNull();
    // A secret's first word on its own is ordinary data.
    expect(cut('live', 'live_test_value_one')).toBeNull();
  });

  it('gives the worker the values of the secrets sent touching other text', () => {
    const secrets = new Map([
      ['crm_pin', '4829'],
      ['shop_token', 'shop-token-value'],
    ]);
    expect(
      looseSecretValuesOf(
        [
          { parts: [{ text: 'q' }, { secret: 'crm_pin' }, { text: 'q' }] },
          { parts: [{ text: 'Bearer ' }, { secret: 'shop_token' }] },
          { parts: [{ text: 'x' }, { secret: 'missing' }] },
        ],
        secrets,
      ),
    ).toStrictEqual(['4829']);
    expect(
      looseSecretValuesOf([{ parts: [{ text: 'Bearer ' }, { secret: 'shop_token' }] }], secrets),
    ).toStrictEqual([]);
  });

  it('finds base64 of a secret inside JSON escapes or percent-encoding', () => {
    // Secrets whose base64 holds / (written \/ by a JSON escaper) and + (%2B in a URL).
    const slashy = 'k3y???~~valu';
    const plusy = 's3cr3t?>~~value';
    const slashed = Buffer.from(slashy).toString('base64');
    const plussed = Buffer.from(plusy).toString('base64');
    expect(slashed).toContain('/');
    expect(plussed).toContain('+');
    const cases: [string, string][] = [
      [`{"t":"${slashed.replace(/\//g, '\\/')}x"}`, slashy],
      [`t=${encodeURIComponent(plussed)}x`, plusy],
      [`t=${encodeURIComponent(slashed)}x`, slashy],
    ];
    for (const [value, secret] of cases) {
      expect(echoedSecret(value, value, [secret]), value).toBe('echoed_secret');
    }
  });

  it('saves values that merely resemble encodings of nothing secret', () => {
    const secret = 'sk_live_AbC/9+xyZ=';
    const headers = { 'content-type': 'text/plain' };
    const body = 'Order 42: 100%25 paid &amp; packed, ref c2tf.';
    expect(
      savedFrom(response({ headers, body: Buffer.from(body) }), [{ from: 'text', saveAs: 't' }], {
        secretValues: [secret],
      }),
    ).toStrictEqual({ values: { t: body }, dropped: {} });
  });
});
