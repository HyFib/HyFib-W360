import { describe, expect, it } from 'vitest';
import { JobSigner } from './envelope';

const signer = new JobSigner('k'.repeat(40));
const tenantA = '0195f0a0-0000-7000-8000-00000000000a';
const tenantB = '0195f0a0-0000-7000-8000-00000000000b';

describe('JobSigner', () => {
  it('verifies an untouched envelope', () => {
    const env = signer.sign({ kind: 'email.send', tenantId: tenantA, actorUserId: 'u1', ref: 'r1' });
    expect(signer.verify(env)).toEqual(env);
  });

  it('rejects an envelope whose tenant was swapped', () => {
    const env = signer.sign({ kind: 'message.send', tenantId: tenantA, actorUserId: 'u1', ref: 'r1' });
    expect(signer.verify({ ...env, tenantId: tenantB })).toBeNull();
  });

  it('rejects envelopes signed with another key, malformed data and far-future timestamps', () => {
    const other = new JobSigner('x'.repeat(40));
    const env = other.sign({ kind: 'email.send', tenantId: null, actorUserId: null, ref: 'r1' });
    expect(signer.verify(env)).toBeNull();
    expect(signer.verify({ hello: 'world' })).toBeNull();
    const future = signer.sign({ kind: 'email.send', tenantId: null, actorUserId: null, ref: 'r1' }, Date.now() + 3600_000);
    expect(signer.verify(future)).toBeNull();
  });
});
