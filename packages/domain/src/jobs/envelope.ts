import { constantTimeEqual, hmacSha256Hex } from '@w360/core';
import { jobEnvelopeSchema, type JobEnvelope } from '@w360/contracts';

/**
 * Signed job envelopes. Producers sign {kind, tenantId, actorUserId, ref, issuedAt}; consumers
 * verify before establishing any tenant scope. The signature proves the job came from our own
 * services, and consumers still re-load the referenced row under that tenant's RLS scope, so a
 * tampered payload cannot redirect work into another company.
 */
export interface UnsignedEnvelope {
  kind: string;
  tenantId: string | null;
  actorUserId: string | null;
  ref: string;
}

const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function canonical(e: Omit<JobEnvelope, 'sig'>): string {
  return JSON.stringify([e.v, e.kind, e.tenantId, e.actorUserId, e.ref, e.issuedAt]);
}

export class JobSigner {
  constructor(private readonly key: string) {
    if (key.length < 32) throw new Error('Job signing key must be at least 32 characters');
  }

  sign(input: UnsignedEnvelope, issuedAt: number = Date.now()): JobEnvelope {
    const body = { v: 1 as const, ...input, issuedAt };
    return { ...body, sig: hmacSha256Hex(this.key, canonical(body)) };
  }

  /** Returns the verified envelope or null when malformed, forged or implausibly dated. */
  verify(data: unknown, now: number = Date.now()): JobEnvelope | null {
    const parsed = jobEnvelopeSchema.safeParse(data);
    if (!parsed.success) return null;
    const envelope = parsed.data;
    const { sig, ...body } = envelope;
    const expected = hmacSha256Hex(this.key, canonical(body));
    if (!constantTimeEqual(sig, expected)) return null;
    if (envelope.issuedAt > now + MAX_FUTURE_SKEW_MS) return null;
    return envelope;
  }
}
