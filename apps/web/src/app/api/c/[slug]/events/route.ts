import type { NextRequest } from 'next/server';
import { isAppError, toError } from '@w360/core';
import {
  can,
  currentEventCursor,
  decodeEventCursor,
  eventVisibleTo,
  readTenantEvents,
  resolveTenantContext,
  type TenantContext,
  type TenantEventRow,
} from '@w360/domain';
import { getRuntime } from '@/server/runtime';

/**
 * Live updates for one company.
 * - Server-Sent Events by default; `?mode=poll` returns one JSON page (fallback when a network path
 *   breaks streaming).
 * - Resumes from `Last-Event-ID` (or `?cursor=`) using durable cursors over the company event log,
 *   so reconnects never lose events; a new stream starts "now".
 * - Membership and session are re-verified every 30 seconds; a revoked member's stream ends.
 * - Events carry only ids and types; clients re-fetch data through authorised pages.
 */
export const dynamic = 'force-dynamic';

const REVALIDATE_MS = 30_000;
const POLL_MS = 5_000;
const HEARTBEAT_MS = 20_000;
const MAX_STREAM_MS = 10 * 60_000;

type Runtime = Awaited<ReturnType<typeof getRuntime>>;

async function authorise(
  runtime: Runtime,
  request: NextRequest,
  slug: string,
): Promise<TenantContext | null> {
  const session = await runtime.auth.api.getSession({ headers: request.headers });
  if (!session?.user.emailVerified) return null;
  try {
    return await resolveTenantContext(
      {
        db: runtime.db,
        clock: runtime.clock,
        mfaGracePeriodHours: runtime.config.MFA_GRACE_PERIOD_HOURS,
      },
      {
        userId: session.user.id,
        sessionId: session.session.id,
        tenantSlug: slug,
        correlationId: crypto.randomUUID(),
      },
    );
  } catch (error) {
    if (isAppError(error) && (error.code === 'not_found' || error.code === 'forbidden'))
      return null;
    throw error;
  }
}

function accessOf(ctx: TenantContext) {
  return {
    readAll: can(ctx, 'inbox.read_all'),
    readAssigned: can(ctx, 'inbox.read_assigned'),
    channelsRead: can(ctx, 'channels.read'),
    membershipId: ctx.membership.id,
  };
}

function publicEvent(e: TenantEventRow) {
  return { type: e.type, conversationId: e.conversationId, at: e.createdAt };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const runtime = await getRuntime();
  const initial = await authorise(runtime, request, slug);
  if (!initial) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  let ctx: TenantContext = initial;

  const requested =
    request.headers.get('last-event-id') ?? request.nextUrl.searchParams.get('cursor');
  let cursor: string;
  try {
    if (requested) decodeEventCursor(requested);
    cursor = requested ?? (await currentEventCursor(runtime.db, ctx.scope));
  } catch {
    return new Response('Invalid cursor', {
      status: 400,
      headers: { 'cache-control': 'no-store' },
    });
  }

  if (request.nextUrl.searchParams.get('mode') === 'poll') {
    const page = await readTenantEvents(runtime.db, ctx.scope, cursor);
    const access = accessOf(ctx);
    return Response.json(
      {
        events: page.events.filter((e) => eventVisibleTo(access, e)).map(publicEvent),
        cursor: page.cursor,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  const encoder = new TextEncoder();
  let closed = false;
  let wake: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      const tenantId = ctx.tenant.id;
      const unsubscribe = runtime.events.subscribe(tenantId, () => wake?.());
      const stop = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        wake?.();
      };
      request.signal.addEventListener('abort', stop);

      void (async () => {
        const started = Date.now();
        let lastCheck = Date.now();
        let lastWrite = Date.now();
        send('retry: 3000\n\n');
        try {
          while (!closed) {
            if (Date.now() - lastCheck > REVALIDATE_MS) {
              const refreshed = await authorise(runtime, request, slug);
              if (!refreshed || refreshed.tenant.id !== tenantId) {
                send('event: revoked\ndata: {}\n\n');
                break;
              }
              ctx = refreshed;
              lastCheck = Date.now();
            }
            const page = await readTenantEvents(runtime.db, ctx.scope, cursor);
            const access = accessOf(ctx);
            for (const e of page.events) {
              if (!eventVisibleTo(access, e)) continue;
              send(`id: ${e.cursor}\nevent: update\ndata: ${JSON.stringify(publicEvent(e))}\n\n`);
              lastWrite = Date.now();
            }
            cursor = page.cursor;
            if (page.events.length >= 200) continue;
            if (Date.now() - started > MAX_STREAM_MS) break;
            if (Date.now() - lastWrite > HEARTBEAT_MS) {
              // Comment line keeps intermediaries from closing an idle stream; also advances the
              // client's resume point past filtered events.
              send(`id: ${cursor}\n: keep-alive\n\n`);
              lastWrite = Date.now();
            }
            await new Promise<void>((resolve) => {
              const timer = setTimeout(done, POLL_MS);
              function done() {
                clearTimeout(timer);
                wake = null;
                resolve();
              }
              wake = done;
            });
          }
        } catch (error) {
          runtime.logger.warn({ err: toError(error).message }, 'event stream ended with error');
        } finally {
          stop();
          try {
            controller.close();
          } catch {
            // Already closed by the client.
          }
        }
      })();
    },
    cancel() {
      closed = true;
      wake?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
