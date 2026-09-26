import { sql, systemScope } from '@w360/db';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/** Readiness: configuration loads and the database answers within the statement timeout. */
export async function GET(): Promise<Response> {
  const started = Date.now();
  try {
    const runtime = await getRuntime();
    await runtime.db.run(systemScope, (tx) => tx.execute(sql`select 1`), {
      accessMode: 'read only',
    });
    return Response.json(
      { status: 'ready', dbLatencyMs: Date.now() - started },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
