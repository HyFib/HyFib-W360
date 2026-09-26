export const dynamic = 'force-dynamic';

/** Liveness: the process is up and serving requests. No dependency checks. */
export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
