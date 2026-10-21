import { describe, expect, it, vi } from 'vitest';
import { MCP_INSTRUCTIONS, MCP_SERVER_INFO, MCP_SUPPORTED_VERSIONS } from './mcp-model';
import {
  MCP_CACHE_TTL_MS,
  decodeMcpHeaderValue,
  handleMcpMessage,
  mcpOriginAllowed,
  mcpTransportError,
  type McpToolRunner,
} from './mcp-protocol';
import { mcpToolDefinitions, type McpToolOutcome } from './mcp-tools';

const MODERN = '2026-07-28';
const meta = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
};

function runner(outcome?: McpToolOutcome) {
  const call = vi.fn(
    async (): Promise<McpToolOutcome> =>
      outcome ?? { ok: true, status: 200, body: { data: [] }, replayed: false },
  );
  return { definitions: mcpToolDefinitions(), call } satisfies McpToolRunner;
}

function send(body: unknown, headers: Record<string, string> = {}, tools = runner()) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return handleMcpMessage({ body, header: (name) => lower[name.toLowerCase()] ?? null }, tools);
}

/** A modern request with the headers that mirror it. */
function modern(method: string, params: Record<string, unknown> = {}, id: string | number = 1) {
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': MODERN,
    'Mcp-Method': method,
  };
  if (typeof params.name === 'string') headers['Mcp-Name'] = params.name;
  return {
    body: { jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } },
    headers,
  };
}

const legacyHeaders = { 'MCP-Protocol-Version': '2025-11-25' };
const errorCode = (body: Record<string, unknown> | null) =>
  (body?.error as { code?: number } | undefined)?.code;
const result = (body: Record<string, unknown> | null) => body?.result as Record<string, unknown>;
const toolText = (body: Record<string, unknown> | null) =>
  JSON.parse((result(body).content as { text: string }[])[0]!.text) as Record<string, unknown>;

describe('MCP messages (ADR-416)', () => {
  it('refuses a batch: no revision it speaks allows one', async () => {
    const reply = await send([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: 'Batch requests are not supported: send one JSON-RPC message per request.',
      },
    });
  });

  it('refuses what is not a JSON-RPC 2.0 request or notification', async () => {
    for (const body of [
      'ping',
      null,
      { id: 1, method: 'ping' },
      { jsonrpc: '1.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: null, method: 'ping' },
      { jsonrpc: '2.0', id: 1.5, method: 'ping' },
    ]) {
      const reply = await send(body, legacyHeaders);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(errorCode(reply.body)).toBe(-32600);
    }
  });

  it('refuses responses, as the server sends no requests', async () => {
    const reply = await send({ jsonrpc: '2.0', id: 1, result: {} });
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({
      id: 1,
      error: {
        code: -32600,
        message: 'This server sends no requests, so it accepts no responses.',
      },
    });
  });

  it('refuses params that are not an object', async () => {
    const reply = await send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: [1] });
    expect(reply).toMatchObject({ status: 400, body: { id: 3, error: { code: -32602 } } });
  });

  it('accepts a notification with 202 and no body', async () => {
    const reply = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(reply).toMatchObject({ status: 202, body: null });
    expect(reply.log.mcpMethod).toBe('notifications/initialized');
  });
});

describe('MCP legacy revisions without sessions (ADR-416)', () => {
  it('answers initialize with the requested legacy version, the tools capability and no session', async () => {
    for (const version of ['2025-11-25', '2025-06-18']) {
      const reply = await send({
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'c', version: '1' },
        },
      });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({
        jsonrpc: '2.0',
        id: 'init',
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        },
      });
      expect(reply.log.mcpVersion).toBe(version);
    }
  });

  it('answers an initialize for another version with its newest legacy one', async () => {
    const reply = await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {} },
    });
    expect(result(reply.body).protocolVersion).toBe('2025-11-25');
    const missing = await send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
    expect(missing).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
  });

  it('answers ping with an empty result', async () => {
    const reply = await send({ jsonrpc: '2.0', id: 7, method: 'ping' }, legacyHeaders);
    expect(reply).toMatchObject({ status: 200, body: { jsonrpc: '2.0', id: 7, result: {} } });
  });

  it('lists the tools without the modern fields', async () => {
    const reply = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, legacyHeaders);
    expect(reply.status).toBe(200);
    expect(result(reply.body)).toEqual({ tools: mcpToolDefinitions() });
  });

  it('refuses a request without the protocol version header, or with one it does not speak', async () => {
    const missing = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(missing).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
    const other = await send(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'MCP-Protocol-Version': '2025-03-26' },
    );
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({
      error: {
        code: -32022,
        data: { supported: [...MCP_SUPPORTED_VERSIONS], requested: '2025-03-26' },
      },
    });
    const modernWithoutMeta = await send(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'MCP-Protocol-Version': MODERN },
    );
    expect(modernWithoutMeta).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
  });

  it('answers an unknown method with -32601', async () => {
    const reply = await send({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, legacyHeaders);
    expect(reply).toMatchObject({ status: 200, body: { error: { code: -32601 } } });
  });

  it('calls a tool and returns its JSON as text content', async () => {
    const tools = runner({
      ok: true,
      status: 200,
      body: { data: [{ id: 'c1' }] },
      replayed: false,
    });
    const reply = await send(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'search_contacts', arguments: { name: 'Asha' } },
      },
      legacyHeaders,
      tools,
    );
    expect(tools.call).toHaveBeenCalledWith('search_contacts', { name: 'Asha' });
    expect(result(reply.body).isError).toBe(false);
    expect(result(reply.body)).not.toHaveProperty('resultType');
    expect(toolText(reply.body)).toEqual({ data: [{ id: 'c1' }] });
    expect(reply.log).toMatchObject({
      tool: 'search_contacts',
      mirrors: 'GET /api/v1/contacts',
      mirroredStatus: 200,
    });
  });
});

describe('MCP revision 2026-07-28, stateless (ADR-416)', () => {
  it('answers server/discover with versions, capabilities, identity and caching', async () => {
    const { body, headers } = modern('server/discover');
    const reply = await send(body, headers);
    expect(reply.status).toBe(200);
    expect(result(reply.body)).toEqual({
      resultType: 'complete',
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      capabilities: { tools: { listChanged: false } },
      instructions: MCP_INSTRUCTIONS,
      ttlMs: MCP_CACHE_TTL_MS,
      cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    });
  });

  it('lists the tools with resultType, ttlMs and cacheScope; a cursor is refused', async () => {
    const { body, headers } = modern('tools/list');
    const reply = await send(body, headers);
    expect(result(reply.body)).toMatchObject({
      resultType: 'complete',
      tools: mcpToolDefinitions(),
      ttlMs: MCP_CACHE_TTL_MS,
      cacheScope: 'private',
    });
    const paged = modern('tools/list', { cursor: 'x' });
    expect(errorCode((await send(paged.body, paged.headers)).body)).toBe(-32602);
  });

  it('requires the protocol version header to match the body', async () => {
    const { body, headers } = modern('tools/list');
    const missing = await send(body, { 'Mcp-Method': 'tools/list' });
    expect(missing).toMatchObject({ status: 400, body: { id: 1, error: { code: -32020 } } });
    const mismatch = await send(body, { ...headers, 'MCP-Protocol-Version': '2025-11-25' });
    expect(mismatch).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
  });

  it('refuses a version it does not speak with the versions it does', async () => {
    const body = {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/list',
      params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } },
    };
    const reply = await send(body, {
      'MCP-Protocol-Version': '2099-01-01',
      'Mcp-Method': 'tools/list',
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: {
        code: -32022,
        message: 'Unsupported protocol version',
        data: { supported: [...MCP_SUPPORTED_VERSIONS], requested: '2099-01-01' },
      },
    });
  });

  it('requires the client capabilities in _meta', async () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } },
    };
    const reply = await send(body, { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' });
    expect(reply).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
  });

  it('requires Mcp-Method, and Mcp-Name for a tool call, to match the body', async () => {
    const list = modern('tools/list');
    const noMethod = await send(list.body, { 'MCP-Protocol-Version': MODERN });
    expect(noMethod).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
    const wrongMethod = await send(list.body, { ...list.headers, 'Mcp-Method': 'tools/call' });
    expect(errorCode(wrongMethod.body)).toBe(-32020);

    const tools = runner();
    const call = modern('tools/call', { name: 'list_templates', arguments: {} });
    const noName = await send(
      call.body,
      { ...call.headers, 'Mcp-Name': undefined as never },
      tools,
    );
    expect(noName).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
    const wrongName = await send(call.body, { ...call.headers, 'Mcp-Name': 'get_contact' }, tools);
    expect(errorCode(wrongName.body)).toBe(-32020);
    const encoded = await send(
      call.body,
      {
        ...call.headers,
        'Mcp-Name': `=?base64?${Buffer.from('list_templates').toString('base64')}?=`,
      },
      tools,
    );
    expect(encoded.status).toBe(200);
    expect(tools.call).toHaveBeenCalledTimes(1);
  });

  it('compares Mcp-Method exactly: no Base64 sentinel, nothing but header-safe characters', async () => {
    const list = modern('tools/list');
    const encoded = await send(list.body, {
      ...list.headers,
      'Mcp-Method': `=?base64?${Buffer.from('tools/list').toString('base64')}?=`,
    });
    expect(encoded).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
    const unsafe = await send(list.body, { ...list.headers, 'Mcp-Method': 'tools/list\u00e9' });
    expect(unsafe).toMatchObject({
      status: 400,
      body: {
        error: {
          code: -32020,
          message: 'Header mismatch: the Mcp-Method header holds invalid characters.',
        },
      },
    });
  });

  it('logs at most 128 characters of a client-chosen method', async () => {
    const reply = await send({ jsonrpc: '2.0', method: `x${'y'.repeat(500)}` });
    expect(reply.log.mcpMethod).toHaveLength(128);
  });

  it('answers an unknown or removed method with 404 and -32601', async () => {
    for (const method of ['ping', 'resources/list']) {
      const { body, headers } = modern(method);
      const reply = await send(body, headers);
      expect(reply).toMatchObject({ status: 404, body: { error: { code: -32601 } } });
    }
  });

  it('returns tool results with resultType and the server’s identity, sends with replayed', async () => {
    const tools = runner({
      ok: true,
      status: 201,
      body: { data: { id: 'm1', status: 'queued' } },
      replayed: true,
    });
    const { body, headers } = modern('tools/call', {
      name: 'send_text_reply',
      arguments: { idempotencyKey: 'k', to: '+919876543210', text: 'Hi' },
    });
    const reply = await send(body, headers, tools);
    expect(result(reply.body)).toMatchObject({
      resultType: 'complete',
      isError: false,
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    });
    expect(toolText(reply.body)).toEqual({ data: { id: 'm1', status: 'queued' }, replayed: true });
    expect(reply.log).toMatchObject({
      tool: 'send_text_reply',
      mirrors: 'POST /api/v1/messages',
      mirroredStatus: 201,
      replayed: true,
    });
  });
});

describe('MCP tool errors and protocol errors (ADR-416)', () => {
  it('reports a REST refusal as a tool error with the same status, code and message', async () => {
    const body = {
      error: { code: 'forbidden', message: 'This API key does not have the contacts.read scope.' },
      requestId: 'req-9',
    };
    const tools = runner({
      ok: false,
      internal: false,
      status: 403,
      body,
      invalidArguments: false,
    });
    const { body: request, headers } = modern('tools/call', {
      name: 'get_contact',
      arguments: { contactId: 'x' },
    });
    const reply = await send(request, headers, tools);
    expect(reply.status).toBe(200);
    expect(result(reply.body).isError).toBe(true);
    expect(toolText(reply.body)).toEqual({ status: 403, ...body });
    expect(reply.log.mirroredStatus).toBe(403);
  });

  it('reports an unexpected error as -32603 with the generic message, keeping the cause apart', async () => {
    const cause = new Error('secret detail');
    const tools = runner({
      ok: false,
      internal: true,
      status: 500,
      body: {
        error: { code: 'internal', message: 'Something went wrong. Retry later.' },
        requestId: 'r',
      },
      cause,
    });
    const { body, headers } = modern('tools/call', { name: 'list_templates', arguments: {} });
    const reply = await send(body, headers, tools);
    expect(reply.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32603,
        message: 'Something went wrong. Retry later.',
        data: { requestId: 'r' },
      },
    });
    expect(JSON.stringify(reply.body)).not.toContain('secret detail');
    expect(reply.internalError).toBe(cause);
    expect(reply.log).toMatchObject({ tool: 'list_templates', mirroredStatus: 500 });
  });

  it('reports an unknown tool and malformed tool params as protocol errors without calling', async () => {
    const tools = runner();
    const unknown = await send(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drop_tables' } },
      legacyHeaders,
      tools,
    );
    expect(unknown.body).toMatchObject({
      error: { code: -32602, message: 'Unknown tool: drop_tables' },
    });
    const noName = await send(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} },
      legacyHeaders,
      tools,
    );
    expect(noName).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
    const badArgs = await send(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_templates', arguments: [] },
      },
      legacyHeaders,
      tools,
    );
    expect(badArgs).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
    expect(tools.call).not.toHaveBeenCalled();
  });

  it('never takes a tenant from arguments: they reach the tool runner untouched, bound to the key', async () => {
    const tools = runner();
    await send(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_templates', arguments: { tenantId: 'other' } },
      },
      legacyHeaders,
      tools,
    );
    // The runner is bound to the verified key; the tool's strict schema refuses `tenantId`.
    expect(tools.call).toHaveBeenCalledWith('list_templates', { tenantId: 'other' });
  });
});

describe('MCP invalid arguments by revision (ADR-416)', () => {
  const invalid: McpToolOutcome = {
    ok: false,
    internal: false,
    invalidArguments: true,
    status: 422,
    body: {
      error: {
        code: 'validation_failed',
        message: 'Give the id of the contact',
        issues: [{ path: 'contactId', message: 'Give the id of the contact' }],
      },
      requestId: 'r2',
    },
  };
  const callIn = (version: string, tools: ReturnType<typeof runner>) =>
    send(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'get_contact', arguments: {} },
      },
      { 'MCP-Protocol-Version': version },
      tools,
    );

  it('makes them a protocol error for 2025-06-18, as that revision lists them', async () => {
    const reply = await callIn('2025-06-18', runner(invalid));
    expect(reply.body).toEqual({
      jsonrpc: '2.0',
      id: 5,
      error: {
        code: -32602,
        message: 'Invalid params: Give the id of the contact',
        data: {
          issues: [{ path: 'contactId', message: 'Give the id of the contact' }],
          requestId: 'r2',
        },
      },
    });
  });

  it('keeps them a tool error for 2025-11-25, and service refusals a tool error in both', async () => {
    const newer = await callIn('2025-11-25', runner(invalid));
    expect(result(newer.body).isError).toBe(true);
    const refusal = await callIn('2025-06-18', runner({ ...invalid, invalidArguments: false }));
    expect(result(refusal.body).isError).toBe(true);
  });
});

describe('MCP transport rules (ADR-416)', () => {
  const app = 'https://app.hyfib.example';

  it('accepts no Origin or the app’s own, and refuses any other', () => {
    expect(mcpOriginAllowed(null, app)).toBe(true);
    expect(mcpOriginAllowed('https://app.hyfib.example', app)).toBe(true);
    expect(mcpOriginAllowed('https://app.hyfib.example', `${app}/`)).toBe(true);
    for (const origin of [
      'https://evil.example',
      'http://app.hyfib.example',
      'https://app.hyfib.example:8443',
      'null',
      '',
    ]) {
      expect(mcpOriginAllowed(origin, app), origin).toBe(false);
    }
  });

  it('wraps a pipeline refusal as a JSON-RPC error without id, keeping the REST words', () => {
    expect(
      mcpTransportError(429, {
        error: {
          code: 'rate_limited',
          message: 'Too many requests. Slow down.',
          reason: 'quota_exceeded',
        },
        requestId: 'r1',
      }),
    ).toEqual({
      jsonrpc: '2.0',
      error: {
        code: 429,
        message: 'Too many requests. Slow down.',
        data: { code: 'rate_limited', reason: 'quota_exceeded', requestId: 'r1' },
      },
    });
  });

  it('makes a body that is not JSON a parse error, and names the request once its id is read', () => {
    const body = {
      error: { code: 'bad_request', message: 'The body is not valid JSON.' },
      requestId: 'r3',
    };
    expect(mcpTransportError(400, body, { invalidJson: true, parsed: undefined })).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32700,
        message: 'The body is not valid JSON.',
        data: { code: 'bad_request', requestId: 'r3' },
      },
    });
    const later = mcpTransportError(500, body, {
      invalidJson: false,
      parsed: { jsonrpc: '2.0', id: 'q-1', method: 'tools/list' },
    });
    expect(later).toMatchObject({ id: 'q-1', error: { code: 500 } });
    expect(
      mcpTransportError(500, body, { invalidJson: false, parsed: { id: null } }),
    ).not.toHaveProperty('id');
  });

  it('decodes header values: plain ASCII, the Base64 sentinel, and refuses the rest', () => {
    expect(decodeMcpHeaderValue('get_contact')).toBe('get_contact');
    expect(decodeMcpHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界');
    expect(decodeMcpHeaderValue('=?base64?not base64?=')).toBeNull();
    expect(decodeMcpHeaderValue('café')).toBeNull();
  });
});
