import type { NextRequest } from 'next/server';
import { handleMcpOtherMethod, handleMcpPost } from '@/server/mcp';

/**
 * The hosted MCP server over the public API (ADR-416): the stateless JSON subset of the Streamable
 * HTTP transport. POST carries one JSON-RPC message; GET, DELETE and OPTIONS are refused with 405.
 */
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return handleMcpPost(request);
}

export function GET(request: NextRequest) {
  return handleMcpOtherMethod(request);
}

export function DELETE(request: NextRequest) {
  return handleMcpOtherMethod(request);
}

export function OPTIONS(request: NextRequest) {
  return handleMcpOtherMethod(request);
}
