import { buildOpenApiDocument } from '@w360/domain';
import { getRuntime } from '@/server/runtime';

/** The OpenAPI 3.1 document of the public API (no key needed; next.config sets its caching). */
export const dynamic = 'force-dynamic';

export async function GET() {
  const runtime = await getRuntime();
  const serverUrl = new URL('/api/v1', runtime.config.APP_BASE_URL).toString();
  return new Response(JSON.stringify(buildOpenApiDocument(serverUrl)), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
