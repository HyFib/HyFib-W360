import { constantTimeEqual, hmacSha256Hex } from '@w360/core';

/**
 * Verifies Meta's `X-Hub-Signature-256: sha256=<hex>` header: HMAC-SHA256 of the raw request body
 * keyed with the app secret, compared in constant time. During app-secret rotation both the current
 * and the previous secret are accepted.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | null,
  secrets: string[],
): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const provided = header.slice('sha256='.length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  let valid = false;
  for (const secret of secrets) {
    if (!secret) continue;
    // Evaluate every secret so timing does not reveal which one matched.
    if (constantTimeEqual(provided, hmacSha256Hex(secret, rawBody))) valid = true;
  }
  return valid;
}

/** GET verification handshake (`hub.mode=subscribe`, matching `hub.verify_token`). */
export function verifyMetaChallenge(params: URLSearchParams, verifyToken: string): string | null {
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  if (mode !== 'subscribe' || !token || !challenge) return null;
  if (!constantTimeEqual(token, verifyToken)) return null;
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(challenge)) return null;
  return challenge;
}
