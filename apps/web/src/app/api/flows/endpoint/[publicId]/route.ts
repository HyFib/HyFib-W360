import type { NextRequest } from 'next/server';
import { toError } from '@w360/core';
import { handleFlowEndpoint } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { readLimitedBody } from '@/server/webhook-body';

/**
 * The WhatsApp Flows data endpoint (the flow's endpoint_uri at Meta). WhatsApp signs each request
 * with the app secret and encrypts it with the WhatsApp account's key; the domain handler checks
 * both, answers health checks itself and forwards the rest to the company's endpoint (flows/
 * endpoint.ts). Answers are base64 text; errors use WhatsApp's status codes (432, 421, 427).
 * Nothing from the request is logged except codes and ids.
 */
export const dynamic = 'force-dynamic';

/** Flow requests are small JSON documents; anything larger is refused before it is read in full. */
const FLOW_REQUEST_LIMIT_BYTES = 1024 * 1024;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const { publicId } = await params;
  const runtime = await getRuntime();
  if (!runtime.flowEndpoint) return new Response(null, { status: 404 });
  const body = await readLimitedBody(request, FLOW_REQUEST_LIMIT_BYTES);
  if (!body) return new Response(null, { status: 413 });
  try {
    const result = await handleFlowEndpoint(runtime.flowEndpoint, {
      publicId,
      rawBody: body,
      signature: request.headers.get('x-hub-signature-256'),
    });
    const level = result.status >= 500 ? 'warn' : 'info';
    runtime.logger[level]({ ...result.log, status: result.status }, 'flow endpoint request');
    return new Response(result.body, {
      status: result.status,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (error) {
    runtime.logger.error({ err: toError(error) }, 'flow endpoint request failed');
    return new Response(null, { status: 500 });
  }
}
