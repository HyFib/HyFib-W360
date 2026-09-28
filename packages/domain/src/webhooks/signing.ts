import { constantTimeEqual, hmacSha256Hex } from '@w360/core';

/** The HMAC-SHA256 of "<timestamp>.<body>" with an endpoint secret, as hex (ADR-053). */
export function webhookSignature(secret: string, timestamp: number, body: string): string {
  return hmacSha256Hex(secret, `${timestamp}.${body}`);
}

/**
 * The `W360-Signature` header: the time in Unix seconds and one `v1` signature per secret (two for
 * 24 hours after a rotation).
 */
export function webhookSignatureHeader(secrets: string[], timestamp: number, body: string): string {
  return [
    `t=${timestamp}`,
    ...secrets.map((secret) => `v1=${webhookSignature(secret, timestamp, body)}`),
  ].join(',');
}

/**
 * Checks a `W360-Signature` header as a receiver should: one `v1` value matches the secret and the
 * time is within the tolerance (5 minutes by default) of the receiver's clock.
 */
export function verifyWebhookSignature(input: {
  header: string;
  secret: string;
  body: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): boolean {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of input.header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && value) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(input.nowSeconds - timestamp) > (input.toleranceSeconds ?? 300)) return false;
  const expected = webhookSignature(input.secret, timestamp, input.body);
  return signatures.some((signature) => constantTimeEqual(signature, expected));
}
