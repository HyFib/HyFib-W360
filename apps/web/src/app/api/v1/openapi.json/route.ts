import { publicApiDocs } from '@/server/api-docs';

/**
 * The OpenAPI 3.1 document of the public API (no key needed; next.config sets its caching). It is
 * built once from the configured address alone and kept, with the API reference page's view of it
 * (ADR-152).
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(publicApiDocs().json, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
