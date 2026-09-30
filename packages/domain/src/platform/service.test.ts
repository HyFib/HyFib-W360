import { describe, expect, it } from 'vitest';
import type { Database } from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { createPlatformService, type PlatformActor } from './service';

describe('a company deletion HyFib staff schedule (ADR-090)', () => {
  // The checks below happen before any query: a database that is reached fails the test.
  const unreachable: PlatformDatabase = {
    run: async () => {
      throw new Error('the database was reached');
    },
    close: async () => undefined,
  };
  const service = createPlatformService({
    db: {} as Database,
    platformDb: unreachable,
    clock: { now: () => new Date() },
  });
  const tenantId = '01890000-0000-7000-8000-000000000001';
  const reason = 'Your service ended under clause 9 of the terms.';
  const operator: PlatformActor = {
    userId: 'usr_operator',
    role: 'platform_operator',
    correlationId: 'corr-1',
  };
  const owner: PlatformActor = { ...operator, userId: 'usr_owner', role: 'platform_owner' };

  it('refuses platform operators before the database', async () => {
    await expect(
      service.scheduleTenantDeletion(operator, { tenantId, confirm: 'acme', reason }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      service.cancelTenantDeletion(operator, { tenantId, reason }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('needs the company, its address typed and a reason of 10 to 1,000 characters', async () => {
    for (const input of [
      { tenantId, confirm: 'acme', reason: 'Too short' },
      { tenantId, confirm: 'acme', reason: `  ${'x'.repeat(8)}  ` },
      { tenantId, confirm: 'acme', reason: 'x'.repeat(1001) },
      { tenantId, confirm: '   ', reason },
      { tenantId, confirm: 'x'.repeat(65), reason },
      { tenantId: 'not-a-uuid', confirm: 'acme', reason },
    ]) {
      await expect(service.scheduleTenantDeletion(owner, input)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    }
    for (const input of [
      { tenantId, reason: 'Too short' },
      { tenantId, reason: 'x'.repeat(1001) },
      { tenantId: 'not-a-uuid', reason },
      { tenantId },
    ]) {
      await expect(service.cancelTenantDeletion(owner, input)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    }
    // Valid input reaches the database, which checks everything again.
    await expect(
      service.scheduleTenantDeletion(owner, { tenantId, confirm: 'acme', reason }),
    ).rejects.toThrow('the database was reached');
    await expect(
      service.cancelTenantDeletion(owner, { tenantId, reason: 'x'.repeat(1000) }),
    ).rejects.toThrow('the database was reached');
  });
});
