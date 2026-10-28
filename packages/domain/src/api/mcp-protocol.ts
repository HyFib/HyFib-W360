import {
  MCP_INSTRUCTIONS,
  MCP_LEGACY_VERSIONS,
  MCP_MODERN_VERSION,
  MCP_SERVER_INFO,
  MCP_SUPPORTED_VERSIONS,
  MCP_TOOLS,
  type McpToolName,
} from './mcp-model';
import type { McpToolDefinition, McpToolOutcome } from './mcp-tools';

/**
 * The JSON-RPC side of the MCP endpoint (ADR-416): one JSON-RPC message per HTTP POST, answered
 * with one JSON object (or 202 with no body for a notification), never an SSE stream. Pure: the
 * caller authenticates, admits and reads the request through the REST API's pipeline, and gives the
 * tool runner bound to the verified key.
 *
 * Every rule below cites the research rows of docs/research/mcp.md (MCP-0xx) it implements.
 */

/** JSON-RPC 2.0 error codes (MCP-006). */
export const MCP_JSONRPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** Error codes the MCP specification defines in its reserved range (MCP-006). */
export const MCP_ERRORS = { headerMismatch: -32020, unsupportedProtocolVersion: -32022 } as const;

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** How long a client may keep the tool list and discovery result (MCP-009), as long as OpenAPI's. */
export const MCP_CACHE_TTL_MS = 300_000;

/** What the request log records of a message, beside what the REST pipeline records. */
export interface McpLogFields {
  mcpMethod: string | null;
  mcpVersion: string | null;
  tool?: McpToolName;
  /** The REST call a tool call is accounted as, and the status that call would have answered. */
  mirrors?: string;
  mirroredStatus?: number;
  replayed?: boolean;
  mcpRpcError?: number;
}

/** The HTTP answer to one message: status, JSON body (null: none), and what to log. */
export interface McpReply {
  status: number;
  body: Record<string, unknown> | null;
  log: McpLogFields;
  /** An unexpected error behind a tool call, for the caller to log; never sent. */
  internalError?: unknown;
}

/** What the protocol needs of the tools: their definitions and a runner bound to the key. */
export interface McpToolRunner {
  definitions: readonly McpToolDefinition[];
  call(name: McpToolName, args: Record<string, unknown>): Promise<McpToolOutcome>;
}

export interface McpMessageInput {
  /** The parsed JSON body. */
  body: unknown;
  /** A request header by its name (case-insensitive), or null. */
  header(name: string): string | null;
}

type JsonObject = Record<string, unknown>;
type RequestId = string | number;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A JSON-RPC error response; without an id when the request's could not be read (MCP-006). */
export function mcpRpcError(
  id: RequestId | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonObject {
  return {
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

const rpcResult = (id: RequestId, result: JsonObject): JsonObject => ({
  jsonrpc: '2.0',
  id,
  result,
});

/** Whether a header value holds only what header values may: visible ASCII, space and tab. */
const isHeaderSafe = (value: string) => /^[\x20-\x7e\t]*$/.test(value);

/**
 * A header value that may use the Base64 sentinel (MCP-013: `Mcp-Name` and `Mcp-Param-*` only):
 * visible ASCII, space and tab; a value in `=?base64?…?=` decoded from UTF-8. Null for a value with
 * other characters or broken Base64.
 */
export function decodeMcpHeaderValue(value: string): string | null {
  if (!isHeaderSafe(value)) return null;
  const encoded = /^=\?base64\?(.*)\?=$/.exec(value)?.[1];
  if (encoded === undefined) return value;
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  return Buffer.from(encoded, 'base64').toString('utf8');
}

/**
 * Whether a request's `Origin` is acceptable (MCP-014): none (MCP clients are not browsers), or the
 * app's own origin. Any other origin, including `null`, is refused with 403 before anything else.
 */
export function mcpOriginAllowed(origin: string | null, appBaseUrl: string): boolean {
  if (origin === null) return true;
  return origin === new URL(appBaseUrl).origin;
}

/**
 * A refusal of the REST pipeline (authentication, rate limit, quota, plan, body) as the MCP endpoint
 * sends it: the same HTTP status and headers, with a JSON-RPC error response without an id
 * (MCP-010). Its code is the HTTP status, an application-defined code outside the range JSON-RPC
 * reserves (MCP-006); the REST error's code, reason and request id are its data.
 */
export function mcpTransportError(
  status: number,
  body: { error: { code: string; message: string; reason?: string }; requestId: string },
  request: { invalidJson: boolean; parsed: unknown } = { invalidJson: false, parsed: undefined },
): JsonObject {
  // A body that is not JSON is JSON-RPC's parse error (MCP-006), still with HTTP 400.
  const code = request.invalidJson ? MCP_JSONRPC.parseError : status;
  // Once the body was read, the error names the request it answers, when its id can be read.
  const parsed = isObject(request.parsed) ? request.parsed.id : undefined;
  const id =
    typeof parsed === 'string' || (typeof parsed === 'number' && Number.isInteger(parsed))
      ? parsed
      : undefined;
  return mcpRpcError(id, code, body.error.message, {
    code: body.error.code,
    ...(body.error.reason ? { reason: body.error.reason } : {}),
    requestId: body.requestId,
  });
}

/** `requested` against the versions the server speaks (MCP-012). */
const unsupportedVersion = (id: RequestId, requested: string) =>
  mcpRpcError(id, MCP_ERRORS.unsupportedProtocolVersion, 'Unsupported protocol version', {
    supported: [...MCP_SUPPORTED_VERSIONS],
    requested,
  });

const capabilities = { tools: { listChanged: false } };

/**
 * Answers one JSON-RPC message (MCP-010, MCP-011). A batch (an array) is refused: no revision the
 * endpoint speaks allows one (MCP-015). Responses are refused too, as the server sends no requests.
 */
export async function handleMcpMessage(
  input: McpMessageInput,
  tools: McpToolRunner,
): Promise<McpReply> {
  const log: McpLogFields = { mcpMethod: null, mcpVersion: null };
  const reply = (status: number, body: JsonObject | null): McpReply => {
    const error = body && isObject(body.error) ? body.error.code : undefined;
    return { status, body, log: typeof error === 'number' ? { ...log, mcpRpcError: error } : log };
  };
  const { body } = input;
  if (Array.isArray(body)) {
    return reply(
      400,
      mcpRpcError(
        undefined,
        MCP_JSONRPC.invalidRequest,
        'Batch requests are not supported: send one JSON-RPC message per request.',
      ),
    );
  }
  if (!isObject(body)) {
    return reply(
      400,
      mcpRpcError(
        undefined,
        MCP_JSONRPC.invalidRequest,
        'Send one JSON-RPC message as a JSON object.',
      ),
    );
  }
  const hasId = Object.hasOwn(body, 'id');
  const id: RequestId | undefined =
    typeof body.id === 'string' || (typeof body.id === 'number' && Number.isInteger(body.id))
      ? body.id
      : undefined;
  if (body.jsonrpc !== '2.0') {
    return reply(
      400,
      mcpRpcError(
        id,
        MCP_JSONRPC.invalidRequest,
        'Send a JSON-RPC 2.0 message ("jsonrpc": "2.0").',
      ),
    );
  }
  if (typeof body.method !== 'string') {
    const isResponse = Object.hasOwn(body, 'result') || Object.hasOwn(body, 'error');
    return reply(
      400,
      mcpRpcError(
        id,
        MCP_JSONRPC.invalidRequest,
        isResponse
          ? 'This server sends no requests, so it accepts no responses.'
          : 'Give the method.',
      ),
    );
  }
  const method = body.method;
  // A client-chosen string: logged at most 128 characters long.
  log.mcpMethod = method.slice(0, 128);
  // A request id is a string or an integer, never null (MCP-006).
  if (hasId && id === undefined) {
    return reply(
      400,
      mcpRpcError(undefined, MCP_JSONRPC.invalidRequest, 'The id must be a string or an integer.'),
    );
  }
  if (body.params !== undefined && !isObject(body.params)) {
    return reply(
      400,
      mcpRpcError(id, MCP_JSONRPC.invalidParams, 'Invalid params: give an object.'),
    );
  }
  const params: JsonObject = body.params ?? {};
  // A notification gets 202 with no body (MCP-010); none needs doing here.
  if (id === undefined) return reply(202, null);

  if (method === 'initialize') return reply(...initialize(id, params, log));

  const meta = isObject(params._meta) ? params._meta : null;
  if (meta && Object.hasOwn(meta, META_VERSION)) {
    return modernRequest(id, method, params, meta, input, tools, log, reply);
  }
  return legacyRequest(id, method, params, input, tools, log, reply);
}

type Reply = (status: number, body: JsonObject | null) => McpReply;

/**
 * The legacy handshake (MCP-005): the requested version when it is one of ours, else the newest
 * legacy one, which the client may refuse. No session id is minted (MCP-011).
 */
function initialize(id: RequestId, params: JsonObject, log: McpLogFields): [number, JsonObject] {
  const requested = params.protocolVersion;
  if (typeof requested !== 'string') {
    return [
      400,
      mcpRpcError(id, MCP_JSONRPC.invalidParams, 'Invalid params: give the protocolVersion.'),
    ];
  }
  const version = (MCP_LEGACY_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_LEGACY_VERSIONS[0];
  log.mcpVersion = version;
  return [
    200,
    rpcResult(id, {
      protocolVersion: version,
      capabilities,
      serverInfo: MCP_SERVER_INFO,
      instructions: MCP_INSTRUCTIONS,
    }),
  ];
}

/**
 * A request of the modern revision (MCP-002, MCP-012, MCP-013): its version in `_meta` and the
 * `MCP-Protocol-Version` header, which must match; `Mcp-Method` (and `Mcp-Name` for tools/call)
 * matching the body; the client's capabilities given. Every result carries `resultType` and the
 * server's identity.
 */
async function modernRequest(
  id: RequestId,
  method: string,
  params: JsonObject,
  meta: JsonObject,
  input: McpMessageInput,
  tools: McpToolRunner,
  log: McpLogFields,
  reply: Reply,
): Promise<McpReply> {
  const version = meta[META_VERSION];
  if (typeof version !== 'string') {
    return reply(
      400,
      mcpRpcError(
        id,
        MCP_JSONRPC.invalidParams,
        `Invalid params: _meta ${META_VERSION} is not a string.`,
      ),
    );
  }
  const header = input.header('mcp-protocol-version');
  if (header === null) {
    return reply(
      400,
      mcpRpcError(
        id,
        MCP_ERRORS.headerMismatch,
        'Header mismatch: the MCP-Protocol-Version header is missing.',
      ),
    );
  }
  if (header !== version) {
    return reply(
      400,
      mcpRpcError(
        id,
        MCP_ERRORS.headerMismatch,
        `Header mismatch: MCP-Protocol-Version header value '${header}' does not match body value '${version}'.`,
      ),
    );
  }
  // Legacy versions are spoken after `initialize` only, never with per-request metadata.
  if (version !== MCP_MODERN_VERSION) return reply(400, unsupportedVersion(id, version));
  log.mcpVersion = version;
  if (!isObject(meta[META_CAPABILITIES])) {
    return reply(
      400,
      mcpRpcError(
        id,
        MCP_JSONRPC.invalidParams,
        `Invalid params: _meta ${META_CAPABILITIES} is required.`,
      ),
    );
  }
  // `Mcp-Method` is compared exactly: the Base64 sentinel is for `Mcp-Name` only (MCP-013).
  const mismatch = headerMismatch('Mcp-Method', input.header('mcp-method'), method, false);
  if (mismatch) return reply(400, mcpRpcError(id, MCP_ERRORS.headerMismatch, mismatch));
  if (method === 'tools/call' && typeof params.name === 'string') {
    const nameMismatch = headerMismatch('Mcp-Name', input.header('mcp-name'), params.name, true);
    if (nameMismatch) return reply(400, mcpRpcError(id, MCP_ERRORS.headerMismatch, nameMismatch));
  } else if (method === 'tools/call' && input.header('mcp-name') === null) {
    return reply(
      400,
      mcpRpcError(
        id,
        MCP_ERRORS.headerMismatch,
        'Header mismatch: the Mcp-Name header is missing.',
      ),
    );
  }
  const modern = (result: JsonObject) =>
    rpcResult(id, {
      resultType: 'complete',
      ...result,
      _meta: { [META_SERVER_INFO]: MCP_SERVER_INFO },
    });
  switch (method) {
    case 'server/discover':
      return reply(
        200,
        modern({
          supportedVersions: [...MCP_SUPPORTED_VERSIONS],
          capabilities,
          instructions: MCP_INSTRUCTIONS,
          ttlMs: MCP_CACHE_TTL_MS,
          cacheScope: 'private',
        }),
      );
    case 'tools/list':
      if (params.cursor !== undefined) return reply(200, unknownCursor(id));
      return reply(
        200,
        modern({ tools: tools.definitions, ttlMs: MCP_CACHE_TTL_MS, cacheScope: 'private' }),
      );
    case 'tools/call':
      return callTool(id, params, tools, log, reply, modern);
    default:
      // An unknown method is 404 with -32601 in this revision (MCP-012).
      return reply(404, mcpRpcError(id, MCP_JSONRPC.methodNotFound, 'Method not found'));
  }
}

/**
 * The refusal when a mirrored header is missing, holds invalid characters or differs from the body
 * (MCP-013); `sentinel` says whether the header may use the Base64 sentinel.
 */
function headerMismatch(
  name: string,
  value: string | null,
  body: string,
  sentinel: boolean,
): string | null {
  if (value === null) return `Header mismatch: the ${name} header is missing.`;
  const decoded = sentinel ? decodeMcpHeaderValue(value) : isHeaderSafe(value) ? value : null;
  if (decoded === null) return `Header mismatch: the ${name} header holds invalid characters.`;
  if (decoded !== body) {
    return `Header mismatch: ${name} header value '${value.slice(0, 128)}' does not match body value '${body.slice(0, 128)}'.`;
  }
  return null;
}

/**
 * A request after the legacy handshake (MCP-005, MCP-012): no session, so the version comes from
 * the `MCP-Protocol-Version` header alone. Without the header a server would assume 2025-03-26,
 * which this one does not speak, so the request is refused.
 */
async function legacyRequest(
  id: RequestId,
  method: string,
  params: JsonObject,
  input: McpMessageInput,
  tools: McpToolRunner,
  log: McpLogFields,
  reply: Reply,
): Promise<McpReply> {
  const version = input.header('mcp-protocol-version');
  if (version === null) {
    return reply(
      400,
      mcpRpcError(
        id,
        MCP_ERRORS.headerMismatch,
        `Header mismatch: the MCP-Protocol-Version header is missing. Send ${MCP_SUPPORTED_VERSIONS.join(', ')}.`,
      ),
    );
  }
  if (version === MCP_MODERN_VERSION) {
    return reply(
      400,
      mcpRpcError(
        id,
        MCP_JSONRPC.invalidParams,
        `Invalid params: _meta ${META_VERSION} and ${META_CAPABILITIES} are required.`,
      ),
    );
  }
  if (!(MCP_LEGACY_VERSIONS as readonly string[]).includes(version)) {
    return reply(400, unsupportedVersion(id, version));
  }
  log.mcpVersion = version;
  const legacy = (result: JsonObject) => rpcResult(id, result);
  switch (method) {
    case 'ping':
      return reply(200, legacy({}));
    case 'tools/list':
      if (params.cursor !== undefined) return reply(200, unknownCursor(id));
      return reply(200, legacy({ tools: tools.definitions }));
    case 'tools/call':
      return callTool(id, params, tools, log, reply, legacy);
    default:
      return reply(200, mcpRpcError(id, MCP_JSONRPC.methodNotFound, 'Method not found'));
  }
}

const unknownCursor = (id: RequestId) =>
  mcpRpcError(
    id,
    MCP_JSONRPC.invalidParams,
    'Invalid params: the tool list has one page and no cursor.',
  );

/**
 * A tool call (MCP-008): an unknown tool or malformed params are protocol errors; everything the
 * REST call would refuse is a tool error (`isError: true`) whose text is the REST error body with
 * its status, so the model can correct itself. An unexpected error is a protocol error with the
 * REST API's generic message only.
 */
async function callTool(
  id: RequestId,
  params: JsonObject,
  tools: McpToolRunner,
  log: McpLogFields,
  reply: Reply,
  result: (body: JsonObject) => JsonObject,
): Promise<McpReply> {
  const name = params.name;
  if (typeof name !== 'string') {
    return reply(
      400,
      mcpRpcError(id, MCP_JSONRPC.invalidParams, 'Invalid params: give the tool name.'),
    );
  }
  const info = MCP_TOOLS.find((tool) => tool.name === name);
  if (!info) {
    return reply(
      200,
      mcpRpcError(id, MCP_JSONRPC.invalidParams, `Unknown tool: ${name.slice(0, 128)}`),
    );
  }
  const args = params.arguments;
  if (args !== undefined && !isObject(args)) {
    return reply(
      400,
      mcpRpcError(
        id,
        MCP_JSONRPC.invalidParams,
        'Invalid params: give the arguments as an object.',
      ),
    );
  }
  log.tool = info.name;
  log.mirrors = info.mirrors;
  const outcome = await tools.call(info.name, args ?? {});
  log.mirroredStatus = outcome.status;
  if (outcome.ok) {
    log.replayed = outcome.replayed;
    const answer = info.sends ? { ...outcome.body, replayed: outcome.replayed } : outcome.body;
    return reply(
      200,
      result({ content: [{ type: 'text', text: JSON.stringify(answer) }], isError: false }),
    );
  }
  if (outcome.internal) {
    return {
      ...reply(
        200,
        mcpRpcError(id, MCP_JSONRPC.internalError, outcome.body.error.message, {
          requestId: outcome.body.requestId,
        }),
      ),
      internalError: outcome.cause,
    };
  }
  // 2025-06-18 lists invalid arguments among protocol errors; 2025-11-25 and later make them tool
  // errors (MCP-008). Refusals of the service itself stay tool errors in every revision.
  if (outcome.invalidArguments && log.mcpVersion === '2025-06-18') {
    return reply(
      200,
      mcpRpcError(id, MCP_JSONRPC.invalidParams, `Invalid params: ${outcome.body.error.message}`, {
        ...(outcome.body.error.issues ? { issues: outcome.body.error.issues } : {}),
        requestId: outcome.body.requestId,
      }),
    );
  }
  return reply(
    200,
    result({
      content: [
        { type: 'text', text: JSON.stringify({ status: outcome.status, ...outcome.body }) },
      ],
      isError: true,
    }),
  );
}
