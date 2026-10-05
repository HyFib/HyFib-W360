import { describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '@w360/core';
import { JobSigner, jobSigningKeyId } from './envelope';

const signer = new JobSigner('k'.repeat(40));
const tenantA = '0195f0a0-0000-7000-8000-00000000000a';
const tenantB = '0195f0a0-0000-7000-8000-00000000000b';

describe('JobSigner', () => {
  it('verifies an untouched envelope', () => {
    const env = signer.sign({
      kind: 'email.send',
      tenantId: tenantA,
      actorUserId: 'u1',
      ref: 'r1',
    });
    expect(signer.verify(env)).toEqual(env);
  });

  it('rejects an envelope whose tenant was swapped', () => {
    const env = signer.sign({
      kind: 'message.send',
      tenantId: tenantA,
      actorUserId: 'u1',
      ref: 'r1',
    });
    expect(signer.verify({ ...env, tenantId: tenantB })).toBeNull();
  });

  it('rejects envelopes signed with another key, malformed data and far-future timestamps', () => {
    const other = new JobSigner('x'.repeat(40));
    const env = other.sign({ kind: 'email.send', tenantId: null, actorUserId: null, ref: 'r1' });
    expect(signer.verify(env)).toBeNull();
    expect(signer.verify({ hello: 'world' })).toBeNull();
    const future = signer.sign(
      { kind: 'email.send', tenantId: null, actorUserId: null, ref: 'r1' },
      Date.now() + 3600_000,
    );
    expect(signer.verify(future)).toBeNull();
  });
});

describe('job signing key rotation (ADR-135)', () => {
  const OLD = 'o'.repeat(40);
  const NEW = 'n'.repeat(40);
  const input = { kind: 'crm.reminder', tenantId: tenantA, actorUserId: 'u1', ref: 'task-1' };

  it('names the signing key by an id derived from it, which does not reveal it', () => {
    const env = new JobSigner(OLD).sign(input);
    expect(env.kid).toBe(jobSigningKeyId(OLD));
    expect(env.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(jobSigningKeyId(NEW)).not.toBe(env.kid);
    expect(new JobSigner(OLD).keyId).toBe(env.kid);
  });

  it('signs what releases before key ids verify: the key id is outside the signature', () => {
    const env = new JobSigner(OLD).sign(input, 1_790_000_000_000);
    const before = JSON.stringify([
      1,
      input.kind,
      input.tenantId,
      input.actorUserId,
      input.ref,
      1_790_000_000_000,
    ]);
    expect(env.sig).toBe(hmacSha256Hex(OLD, before));
    // An envelope from before key ids verifies, and verification names the key that signed it.
    const { kid: _kid, ...unnamed } = env;
    expect(new JobSigner(OLD).verify(unnamed)).toEqual(env);
  });

  it('does not trust the key an envelope names: every configured key is tried', () => {
    const env = new JobSigner(OLD).sign(input);
    const rotating = new JobSigner(NEW, { previous: OLD });
    // Named after the signing key, signed with the previous one: verified, and named truly.
    expect(rotating.verify({ ...env, kid: rotating.keyId })?.kid).toBe(jobSigningKeyId(OLD));
    // Signed with a key that is not configured, naming one that is: refused.
    const forged = new JobSigner('f'.repeat(40)).sign(input);
    expect(rotating.verify({ ...forged, kid: rotating.keyId })).toBeNull();
    expect(rotating.verify({ ...forged, kid: jobSigningKeyId(OLD) })).toBeNull();
  });

  it('accepts the next key before signing with it, then the previous key after the swap', () => {
    const oldEnvelope = new JobSigner(OLD).sign(input);
    const newEnvelope = new JobSigner(NEW).sign(input);
    // Step 1: every instance accepts the new key and still signs with the old one.
    const step1 = new JobSigner(OLD, { next: NEW });
    expect(step1.verify(newEnvelope)?.kid).toBe(jobSigningKeyId(NEW));
    expect(step1.verify(oldEnvelope)?.kid).toBe(jobSigningKeyId(OLD));
    expect(step1.sign(input).kid).toBe(jobSigningKeyId(OLD));
    expect([step1.keyId, step1.nextKeyId, step1.previousKeyId]).toEqual([
      jobSigningKeyId(OLD),
      jobSigningKeyId(NEW),
      null,
    ]);
    // Step 2: the new key signs and the old one is still accepted.
    const step2 = new JobSigner(NEW, { previous: OLD });
    expect(step2.verify(oldEnvelope)?.kid).toBe(jobSigningKeyId(OLD));
    expect(step2.verify(newEnvelope)?.kid).toBe(jobSigningKeyId(NEW));
    expect(step2.sign(input).kid).toBe(jobSigningKeyId(NEW));
    expect([step2.keyId, step2.nextKeyId, step2.previousKeyId]).toEqual([
      jobSigningKeyId(NEW),
      null,
      jobSigningKeyId(OLD),
    ]);
    // Step 3: the old key is gone, and what it signed is refused.
    const step3 = new JobSigner(NEW);
    expect(step3.verify(oldEnvelope)).toBeNull();
    expect(step3.verify(newEnvelope)).not.toBeNull();
  });

  it('signs a verified envelope again with the same contents and time, and nothing forged', () => {
    const issuedAt = Date.now() - 86_400_000;
    const oldEnvelope = new JobSigner(OLD).sign(input, issuedAt);
    const step2 = new JobSigner(NEW, { previous: OLD });
    const again = step2.resign(oldEnvelope);
    expect(again).toEqual({ v: 1, ...input, issuedAt, kid: jobSigningKeyId(NEW), sig: again?.sig });
    expect(new JobSigner(NEW).verify(again)).toEqual(again);
    expect(step2.resign({ ...oldEnvelope, ref: 'task-2' })).toBeNull();
    expect(step2.resign(new JobSigner('f'.repeat(40)).sign(input))).toBeNull();
    expect(step2.resign({ hello: 'world' })).toBeNull();
  });

  it('refuses a rotation with both a next and a previous key, or with the signing key again', () => {
    expect(() => new JobSigner(NEW, { next: 'x'.repeat(40), previous: OLD })).toThrow(
      /one job signing key rotation at a time/i,
    );
    expect(() => new JobSigner(NEW, { previous: NEW })).toThrow(/must differ/);
    expect(() => new JobSigner(NEW, { next: NEW })).toThrow(/must differ/);
    expect(() => new JobSigner(NEW, { previous: 'short' })).toThrow(/at least 32/);
    expect(() => new JobSigner(NEW, { next: 'short' })).toThrow(/at least 32/);
    expect(new JobSigner(NEW, { next: null, previous: null }).previousKeyId).toBeNull();
  });
});
