import { isAppError } from '@w360/core';
import type { ConversationViewers } from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { assertTrustedOrigin, requireTenant } from '@/server/session';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string; conversationId: string }> };

const answer = (
  status: number,
  body: ({ ok: true } & Partial<ConversationViewers>) | { ok: false; message: string },
) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });

/** Runs a presence command for the member, answering an expected refusal with its message. */
async function handle(
  slug: string,
  run: (ctx: Awaited<ReturnType<typeof requireTenant>>) => Promise<Response>,
): Promise<Response> {
  try {
    await assertTrustedOrigin();
  } catch {
    return answer(403, { ok: false, message: 'Request origin not allowed.' });
  }
  const ctx = await requireTenant(slug);
  try {
    return await run(ctx);
  } catch (error) {
    if (isAppError(error))
      return answer(error.httpStatus, { ok: false, message: error.publicMessage });
    throw error;
  }
}

/**
 * The conversation page reports while it is open and visible that the member has the conversation
 * open, and hears which other members have (ADR-243). Only HyFib's own pages may call it (trusted
 * origin), with the member's session.
 */
export async function POST(_request: Request, { params }: Params) {
  const { slug, conversationId } = await params;
  return handle(slug, async (ctx) => {
    const { presence } = await getRuntime();
    return answer(200, { ok: true, ...(await presence.report(ctx, conversationId)) });
  });
}

/** The member left the conversation (the page closed or moved on). */
export async function DELETE(_request: Request, { params }: Params) {
  const { slug, conversationId } = await params;
  return handle(slug, async (ctx) => {
    const { presence } = await getRuntime();
    await presence.leave(ctx, conversationId);
    return answer(200, { ok: true });
  });
}
