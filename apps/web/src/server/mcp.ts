import 'server-only';
import type { NextRequest } from 'next/server';
import { toError } from '@w360/core';
import {
  handleMcpMessage,
  mcpOriginAllowed,
  mcpRpcError,
  mcpToolDefinitions,
  mcpTransportError,
  runMcpTool,
} from '@w360/domain';
import { handleApiRequest } from './api';
import { getRuntime } from './runtime';

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };

/**
 * The `Origin` check every request to the MCP endpoint gets first (ADR-416, MCP-014): a browser
 * page of another site is refused with 403 before authentication, so it is neither counted nor
 * logged as an API request. No CORS headers are ever sent.
 */
async function refusedOrigin(request: NextRequest): Promise<Response | null> {
  const { config } = await getRuntime();
  if (mcpOriginAllowed(request.headers.get('origin'), config.APP_BASE_URL)) return null;
  return new Response(
    JSON.stringify(
      mcpRpcError(
        undefined,
        403,
        'Requests from this origin are not accepted by the MCP endpoint.',
      ),
    ),
    { status: 403, headers: jsonHeaders },
  );
}

/**
 * POST to the MCP endpoint (ADR-416): after the Origin check, the request goes through the REST
 * API's pipeline exactly as a REST request does (key, addresses, rate limits, the plan's monthly
 * requests, 64 KB JSON body, request log; the NUL refusal moves into the tools' schemas), and its
 * one JSON-RPC message is answered by the domain's protocol with tools bound to the verified key's
 * context. An unexpected tool failure is logged with `mcp.mirroredStatus` 500 on the request line
 * and its own `mcp tool call failed` error line.
 */
export async function handleMcpPost(request: NextRequest): Promise<Response> {
  const refused = await refusedOrigin(request);
  if (refused) return refused;
  return handleApiRequest(
    request,
    async ({ ctx, runtime, body }) => {
      const reply = await handleMcpMessage(
        { body, header: (name) => request.headers.get(name) },
        {
          definitions: mcpToolDefinitions(),
          call: (name, args) => runMcpTool(runtime.outbound, ctx, name, args),
        },
      );
      if (reply.internalError !== undefined) {
        runtime.logger.error(
          {
            requestId: ctx.requestId,
            tool: reply.log.tool,
            tenantId: ctx.tenant.id,
            apiKeyId: ctx.key.id,
            err: toError(reply.internalError),
          },
          'mcp tool call failed',
        );
      }
      return { status: reply.status, json: reply.body, log: { mcp: reply.log } };
    },
    // Tool arguments are checked for the NUL character by their schemas (a tool error naming the
    // path), so the pipeline's whole-body check is skipped; nothing else of a message is stored.
    { json: true, errorBody: mcpTransportError, nulCheck: false },
  );
}

/**
 * Any other method (ADR-416, MCP-011): the endpoint offers no SSE stream and no sessions, so GET
 * and DELETE (and OPTIONS, so no CORS preflight succeeds) get 405, after the Origin check.
 */
export async function handleMcpOtherMethod(request: NextRequest): Promise<Response> {
  const refused = await refusedOrigin(request);
  if (refused) return refused;
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}
