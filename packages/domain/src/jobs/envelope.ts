import { constantTimeEqual, hmacSha256Hex } from '@w360/core';
import { jobEnvelopeSchema, type JobEnvelope } from '@w360/contracts';

/**
 * Signed job envelopes. Producers sign {kind, tenantId, actorUserId, ref, issuedAt}; consumers
 * verify before establishing any tenant scope. The signature proves the job came from our own
 * services, and consumers still re-load the referenced row under that tenant's RLS scope, so a
 * tampered payload cannot redirect work into another company.
 *
 * Rotation (ADR-135): an envelope names the key that signed it (`kid`, derived from the key, which
 * it does not reveal), outside the signature so that releases before this one still verify it.
 * The name is not trusted: verification tries every configured key, which during a rotation is the
 * signing key and either the next key (accepted before any instance signs with it) or the previous
 * one (accepted while the worker signs the queued jobs it signed again).
 */
export interface UnsignedEnvelope {
  kind: string;
  tenantId: string | null;
  actorUserId: string | null;
  ref: string;
}

const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function canonical(e: Omit<JobEnvelope, 'sig' | 'kid'>): string {
  return JSON.stringify([e.v, e.kind, e.tenantId, e.actorUserId, e.ref, e.issuedAt]);
}

/** A job signing key's id: names the key in envelopes, logs and the console without revealing it. */
export function jobSigningKeyId(key: string): string {
  return hmacSha256Hex(key, 'w360 job signing key id').slice(0, 16);
}

/** The other key of a job signing key rotation (ADR-135): one at most. */
export interface JobSigningRotation {
  /** Accepted before any instance signs with it (the rotation's first deploy). */
  next?: string | null;
  /** Being retired: still accepted, and its queued jobs are signed again (the second deploy). */
  previous?: string | null;
}

export class JobSigner {
  /** The id of the key new envelopes are signed with. */
  readonly keyId: string;
  readonly nextKeyId: string | null;
  readonly previousKeyId: string | null;
  private readonly keys: { id: string; key: string }[];

  constructor(
    private readonly key: string,
    rotation: JobSigningRotation = {},
  ) {
    const next = rotation.next ?? null;
    const previous = rotation.previous ?? null;
    for (const k of [key, next, previous]) {
      if (k !== null && k.length < 32)
        throw new Error('Job signing key must be at least 32 characters');
    }
    if (next !== null && previous !== null)
      throw new Error('One job signing key rotation at a time: a next or a previous key, not both');
    if (next === key || previous === key)
      throw new Error('A next or previous job signing key must differ from the signing key');
    this.keyId = jobSigningKeyId(key);
    this.nextKeyId = next === null ? null : jobSigningKeyId(next);
    this.previousKeyId = previous === null ? null : jobSigningKeyId(previous);
    this.keys = [{ id: this.keyId, key }];
    if (next !== null) this.keys.push({ id: jobSigningKeyId(next), key: next });
    if (previous !== null) this.keys.push({ id: jobSigningKeyId(previous), key: previous });
  }

  sign(input: UnsignedEnvelope, issuedAt: number = Date.now()): JobEnvelope {
    const body = { v: 1 as const, ...input, issuedAt };
    return { ...body, kid: this.keyId, sig: hmacSha256Hex(this.key, canonical(body)) };
  }

  /**
   * Returns the verified envelope, naming the key that verified it, or null when malformed, forged
   * or implausibly dated.
   */
  verify(data: unknown, now: number = Date.now()): JobEnvelope | null {
    const parsed = jobEnvelopeSchema.safeParse(data);
    if (!parsed.success) return null;
    const { sig, kid: _named, ...body } = parsed.data;
    const text = canonical(body);
    let verifiedBy: string | null = null;
    for (const k of this.keys) {
      if (constantTimeEqual(sig, hmacSha256Hex(k.key, text))) verifiedBy ??= k.id;
    }
    if (verifiedBy === null) return null;
    if (body.issuedAt > now + MAX_FUTURE_SKEW_MS) return null;
    return { ...body, kid: verifiedBy, sig };
  }

  /**
   * The job's envelope signed again with the signing key, with the same contents and time; null
   * when it does not verify, so that nothing forged is ever signed (ADR-135).
   */
  resign(data: unknown, now: number = Date.now()): JobEnvelope | null {
    const envelope = this.verify(data, now);
    if (!envelope) return null;
    const { kind, tenantId, actorUserId, ref, issuedAt } = envelope;
    return this.sign({ kind, tenantId, actorUserId, ref }, issuedAt);
  }
}
