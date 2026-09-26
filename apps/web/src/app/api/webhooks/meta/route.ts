import type { NextRequest } from 'next/server';
import { resolveClientIp, toError } from '@w360/core';
import {
  RAW_WEBHOOK_LIMIT_BYTES,
  recordSecurityEvent,
  storeWebhookReceipt,
  takeToken,
  verifyMetaChallenge,
  verifyMetaSignature,
} from '@w360/domain';
import { getRuntime } from '@/server/runtime';

/**
 * Meta WhatsApp webhook endpoint.
 * GET  verification handshake (hub.mode / hub.verify_token / hub.challenge).
 * POST events: the raw body (bounded) is verified against X-Hub-Signature-256 with the app secret
 *      (current or previous during rotation) and stored durably, encrypted, BEFORE we answer 200.
 *      Processing happens in workers; a storage failure returns 500 so Meta retries.
 * The company is never taken from the request: workers attribute events through verified asset
 * bindings only.
 */
export const dynamic = 'force-dynamic';

async function readLimited(request: Request, limit: number): Promise<Buffer | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function GET(request: NextRequest) {
  const runtime = await getRuntime();
  if (!runtime.meta) return new Response('Not found', { status: 404 });
  const challenge = verifyMetaChallenge(
    request.nextUrl.searchParams,
    runtime.meta.webhookVerifyToken,
  );
  if (!challenge) return new Response('Forbidden', { status: 403 });
  return new Response(challenge, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function POST(request: NextRequest) {
  const runtime = await getRuntime();
  if (!runtime.meta) return new Response(null, { status: 404 });
  const body = await readLimited(request, RAW_WEBHOOK_LIMIT_BYTES);
  if (!body) return new Response(null, { status: 413 });

  const signature = request.headers.get('x-hub-signature-256');
  if (!verifyMetaSignature(body, signature, runtime.meta.webhookSecrets)) {
    // Bounded so a flood of forged requests cannot flood the security log.
    const record = await takeToken(runtime.db, 'security:webhook-invalid-signature', {
      capacity: 20,
      refillPerSecond: 0.2,
    }).catch(() => false);
    if (record) {
      await recordSecurityEvent(
        runtime.db,
        {
          eventType: 'webhook.invalid_signature',
          severity: 'warning',
          details: { provider: 'meta_whatsapp', bytes: body.length, signed: Boolean(signature) },
        },
        {
          ipAddress: resolveClientIp(
            request.headers.get('x-forwarded-for'),
            request.headers.get('x-real-ip'),
            runtime.trustedProxies,
          ),
          userAgent: request.headers.get('user-agent'),
        },
      ).catch((error: unknown) =>
        runtime.logger.warn({ err: toError(error).message }, 'security event not recorded'),
      );
    }
    return new Response(null, { status: 401 });
  }

  try {
    await storeWebhookReceipt(
      { db: runtime.db, keyring: runtime.keyring, jobs: runtime.jobs, signer: runtime.signer },
      { provider: 'meta_whatsapp', rawBody: body },
    );
  } catch (error) {
    runtime.logger.error({ err: toError(error) }, 'webhook receipt could not be stored');
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
}
