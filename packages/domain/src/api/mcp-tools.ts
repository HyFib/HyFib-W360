import { z } from 'zod';
import { sha256Hex } from '@w360/core';
import type { OutboundDeps } from '../messaging/outbound';
import { parseInput } from '../validation';
import { apiGetCampaign, apiListCampaigns, apiCampaignListQuerySchema } from './campaigns';
import { assertAnyScope, type ApiContext } from './context';
import {
  apiConversationListQuerySchema,
  apiListConversationMessages,
  apiListConversations,
  apiMessageListQuerySchema,
} from './conversations';
import { apiErrorResponse, type ApiErrorBody } from './errors';
import type { IdempotencyInput } from './idempotency';
import { MCP_TOOLS, type McpToolInfo, type McpToolName } from './mcp-model';
import { IDEMPOTENCY_KEY_RE } from './model';
import {
  apiContactListQuerySchema,
  apiGetContact,
  apiListContacts,
  apiListTemplates,
  apiSendMessageSchema,
  apiSendTemplate,
  apiSendText,
  apiSendTextSchema,
} from './resources';

/**
 * The tools of the MCP server (ADR-416): each mirrors one REST call of the public API and calls the
 * same domain service with the same input, so it needs the same scopes, is refused with the same
 * errors and writes the same audit rows. Tenant scope comes only from the verified key's context.
 */

const idField = (what: string) =>
  z.uuid({ error: `Give the id of the ${what}` }).describe(`The ${what}’s id.`);

/** A send's `Idempotency-Key`, given as an argument: the header's rule and message (ADR-052). */
const idempotencyKeyField = z
  .string({ error: 'Give an idempotencyKey (for example a UUID)' })
  .regex(IDEMPOTENCY_KEY_RE, 'The idempotencyKey must be 1 to 255 visible ASCII characters.')
  .describe(
    'A new value (for example a UUID) for each new message. A retry with the same key and arguments returns the first answer without sending again; the same key with other arguments is refused. Keys are kept for 24 hours per API key.',
  );

const noArguments = z.object({}).strict();

interface McpTool {
  info: McpToolInfo;
  /** The arguments, checked before the service runs; also the tool's JSON Schema. */
  input: z.ZodType;
  run(
    deps: OutboundDeps,
    ctx: ApiContext,
    args: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown>; replayed: boolean }>;
}

const read = (body: Record<string, unknown>) => ({ status: 200, body, replayed: false });

/** Everything of `args` except `names`. */
function without(args: Record<string, unknown>, ...names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !names.includes(key)));
}

/** JSON with object keys sorted, so the same arguments hash alike whatever order they came in. */
export function mcpCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(mcpCanonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${mcpCanonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The idempotency key of a send tool and the hash of its request. The hash names the tool, so a
 * key once used with a REST request (whose hash is its method, path and body) is refused for a
 * tool send and the other way round, never replayed across the two.
 */
export function mcpToolIdempotency(
  tool: McpToolName,
  key: string,
  request: Record<string, unknown>,
): IdempotencyInput {
  return { key, requestHash: sha256Hex(`MCP ${tool}\n${mcpCanonicalJson(request)}`) };
}

const TOOL_RUNS: Record<McpToolName, Omit<McpTool, 'info'>> = {
  search_contacts: {
    input: apiContactListQuerySchema,
    run: async (deps, ctx, args) => read({ ...(await apiListContacts(deps, ctx, args)) }),
  },
  get_contact: {
    input: z.object({ contactId: idField('contact') }).strict(),
    run: async (deps, ctx, args) =>
      read({ data: await apiGetContact(deps, ctx, String(args.contactId)) }),
  },
  list_conversations: {
    input: apiConversationListQuerySchema,
    run: async (deps, ctx, args) => read({ ...(await apiListConversations(deps, ctx, args)) }),
  },
  list_conversation_messages: {
    input: apiMessageListQuerySchema.extend({ conversationId: idField('conversation') }),
    run: async (deps, ctx, args) =>
      read({
        ...(await apiListConversationMessages(
          deps,
          ctx,
          String(args.conversationId),
          without(args, 'conversationId'),
        )),
      }),
  },
  list_templates: {
    input: noArguments,
    run: async (deps, ctx) => read(await apiListTemplates(deps, ctx)),
  },
  list_campaigns: {
    input: apiCampaignListQuerySchema,
    run: async (deps, ctx, args) => read({ ...(await apiListCampaigns(deps, ctx, args)) }),
  },
  get_campaign: {
    input: z.object({ campaignId: idField('campaign') }).strict(),
    run: async (deps, ctx, args) =>
      read({ data: await apiGetCampaign(deps, ctx, String(args.campaignId)) }),
  },
  send_text_reply: {
    input: apiSendTextSchema.omit({ type: true }).extend({ idempotencyKey: idempotencyKeyField }),
    run: (deps, ctx, args) => {
      const request = { type: 'text', ...without(args, 'idempotencyKey') };
      const idempotency = mcpToolIdempotency(
        'send_text_reply',
        String(args.idempotencyKey),
        request,
      );
      return apiSendText(deps, ctx, request, idempotency);
    },
  },
  send_template: {
    input: apiSendMessageSchema
      .omit({ type: true })
      .extend({ idempotencyKey: idempotencyKeyField }),
    run: (deps, ctx, args) => {
      const request = { type: 'template', ...without(args, 'idempotencyKey') };
      const idempotency = mcpToolIdempotency('send_template', String(args.idempotencyKey), request);
      return apiSendTemplate(deps, ctx, request, idempotency);
    },
  },
};

const TOOLS: ReadonlyMap<string, McpTool> = new Map(
  MCP_TOOLS.map((info) => [info.name, { info, ...TOOL_RUNS[info.name] }]),
);

/** A tool as `tools/list` describes it (MCP-009): JSON Schema from the REST API's zod schemas. */
export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown> & { type: 'object' };
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

function inputSchemaOf(schema: z.ZodType): McpToolDefinition['inputSchema'] {
  // Without `$schema` the dialect is JSON Schema 2020-12 (MCP-009), which zod writes.
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'throw',
  }) as Record<string, unknown>;
  if (rest.type !== 'object') throw new Error('A tool’s input schema must be an object');
  return rest as McpToolDefinition['inputSchema'];
}

const scopeNote = (info: McpToolInfo) =>
  `Needs the ${info.scopes.join(' or ')} scope${info.scopes.length > 1 ? ' (either)' : ''}.`;

let definitions: readonly McpToolDefinition[] | null = null;

/** The tools in their fixed order, built once. */
export function mcpToolDefinitions(): readonly McpToolDefinition[] {
  definitions ??= MCP_TOOLS.map((info) => {
    const tool = TOOLS.get(info.name);
    if (!tool) throw new Error(`No runner for the MCP tool ${info.name}`);
    return {
      name: info.name,
      title: info.title,
      description: `${info.description} ${scopeNote(info)}`,
      inputSchema: inputSchemaOf(tool.input),
      // Hints only (MCP-009): reads change nothing; a send is additive, and repeats nothing for
      // the same idempotency key; every tool reaches only the company's own data in HyFib, but a
      // send reaches a WhatsApp user outside it.
      annotations: {
        title: info.title,
        readOnlyHint: !info.sends,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: info.sends,
      },
    };
  });
  return definitions;
}

/** Whether `name` is one of the tools. */
export function isMcpToolName(name: string): name is McpToolName {
  return TOOLS.has(name);
}

/** What a tool call came to: the REST call's answer, or its error as the REST API words it. */
export type McpToolOutcome =
  | { ok: true; status: number; body: Record<string, unknown>; replayed: boolean }
  | {
      ok: false;
      internal: false;
      status: number;
      body: ApiErrorBody;
      /** The arguments failed the tool's schema (before the service ran). */
      invalidArguments: boolean;
    }
  | { ok: false; internal: true; status: 500; body: ApiErrorBody; cause: unknown };

/**
 * Runs a tool for the key: its scopes first (as the REST call checks them first), then its
 * arguments against the tool's schema, then the domain service the REST call runs. Errors become
 * the REST API's error body (`apiErrorResponse`): an unexpected one only as its generic message,
 * with the cause kept for the caller to log.
 */
export async function runMcpTool(
  deps: OutboundDeps,
  ctx: ApiContext,
  name: McpToolName,
  args: Record<string, unknown>,
): Promise<McpToolOutcome> {
  const tool = TOOLS.get(name);
  if (!tool) throw new Error(`No MCP tool ${name}`);
  let invalidArguments = false;
  try {
    assertAnyScope(ctx, tool.info.scopes);
    // Also refuses text with the NUL character, naming its path (the endpoint skips the pipeline's
    // whole-body check so this is a tool error the model can correct).
    invalidArguments = true;
    parseInput(tool.input, args);
    invalidArguments = false;
    const result = await tool.run(deps, ctx, args);
    return { ok: true, status: result.status, body: result.body, replayed: result.replayed };
  } catch (error) {
    const mapped = apiErrorResponse(error, ctx.requestId);
    if (mapped.internal) {
      return { ok: false, internal: true, status: 500, body: mapped.body, cause: error };
    }
    return {
      ok: false,
      internal: false,
      status: mapped.status,
      body: mapped.body,
      invalidArguments,
    };
  }
}
