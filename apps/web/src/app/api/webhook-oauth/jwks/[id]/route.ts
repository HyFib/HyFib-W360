import { webhookOAuthPublicJwks } from '@w360/domain';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/**
 * The JWKS URL of a webhook OAuth client that signs with a key pair (ADR-370): the public key in use
 * and the next one, as a JWK Set (RFC 7517), for the company's authorization server to fetch. It is
 * public and holds only public keys; the id names neither the company nor the endpoint. Cache
 * headers are set in next.config.ts.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = await getRuntime();
  const set = await webhookOAuthPublicJwks(db, id);
  if (!set) {
    return Response.json(
      { error: { code: 'not_found', message: 'No such key set.' } },
      { status: 404 },
    );
  }
  return Response.json(set);
}
