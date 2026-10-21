import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring, isAppError } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  authorizedTenantScope,
  COMPANY_EXPORT_FAILURE_REASONS,
  COMPANY_EXPORT_STATUSES,
  type Database,
} from '@w360/db';
import type { TenantContext } from '../authz/context';
import { permissionsForRoles } from '../authz/permissions';
import { EXPORT_EXCLUDED_TABLES } from './export-spec';
import {
  STORED_EXPORT_FAILURE_LABELS,
  STORED_EXPORT_LEASE_SECONDS,
  STORED_EXPORT_MAX_ATTEMPTS,
  STORED_EXPORT_RENEW_SECONDS,
  STORED_EXPORT_RETENTION_DAYS,
  STORED_EXPORT_STATUS_LABELS,
  companyExportPartAad,
  formatByteSize,
  listStoredExports,
  openStoredExport,
  readParts,
  requestStoredExport,
  requesterMayExport,
} from './stored-export';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const OTHER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const EXPORT_ID = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const now = new Date('2026-10-21T10:00:00Z');
const clock = { now: () => now };

/** A context with the given roles, signed in at `signedInAt`. */
function ctx(roles: string[], signedInAt: Date | null = now): TenantContext {
  const permissions = permissionsForRoles(roles as never);
  return {
    tenant: { id: TENANT, status: 'active', name: 'Acme', slug: 'acme', timezone: 'UTC' },
    user: { id: 'u1', name: 'Asha' },
    membership: { id: 'm1', roles },
    permissions,
    rolePermissions: permissions,
    mfa: { required: false, satisfied: true, graceEndsAt: null, blocking: false },
    signedInAt,
    scope: authorizedTenantScope(TENANT, 'u1'),
  } as unknown as TenantContext;
}

/** A database every call to which fails the test: refusals must come before any read. */
const untouched = {
  run: () => {
    throw new Error('the database was used');
  },
} as unknown as Database;
const deps = () =>
  ({
    db: untouched,
    clock,
    keyring: new Keyring({ primaryKeyId: 'k', keys: { k: randomBytes(32) } }),
    jobs: {} as never,
    signer: {} as never,
    appBaseUrl: 'https://app.example.com',
  }) as Parameters<typeof requestStoredExport>[0];

async function refusal(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return isAppError(error) ? error.code : `not an app error: ${String(error)}`;
  }
}

describe('stored exports: limits and wording (ADR-415)', () => {
  it('keeps a ready export 7 days, tries a run 3 times and renews a 5-minute lease every minute', () => {
    expect(STORED_EXPORT_RETENTION_DAYS).toBe(7);
    expect(STORED_EXPORT_MAX_ATTEMPTS).toBe(3);
    expect(STORED_EXPORT_LEASE_SECONDS).toBe(300);
    expect(STORED_EXPORT_RENEW_SECONDS).toBe(60);
    expect(STORED_EXPORT_RENEW_SECONDS * 3).toBeLessThan(STORED_EXPORT_LEASE_SECONDS);
  });

  it('labels every status and failure reason the database allows', () => {
    expect(Object.keys(STORED_EXPORT_STATUS_LABELS).sort()).toEqual(
      [...COMPANY_EXPORT_STATUSES].sort(),
    );
    expect(Object.keys(STORED_EXPORT_FAILURE_LABELS).sort()).toEqual(
      [...COMPANY_EXPORT_FAILURE_REASONS].sort(),
    );
    for (const label of Object.values(STORED_EXPORT_FAILURE_LABELS)) {
      expect(label).toMatch(/\.$/);
    }
  });

  it('writes sizes in binary units', () => {
    expect(formatByteSize(0)).toBe('0 bytes');
    expect(formatByteSize(1)).toBe('1 byte');
    expect(formatByteSize(1023)).toBe('1023 bytes');
    expect(formatByteSize(1024)).toBe('1.0 KiB');
    expect(formatByteSize(4_404_019)).toBe('4.2 MiB');
    expect(formatByteSize(38_797_312)).toBe('37 MiB');
    expect(formatByteSize(1_073_741_824)).toBe('1.0 GiB');
    expect(() => formatByteSize(-1)).toThrow();
  });

  it('seals each part for its company and part, so a part moved elsewhere does not open', () => {
    const keyring = new Keyring({ primaryKeyId: 'k', keys: { k: randomBytes(32) } });
    expect(companyExportPartAad(TENANT, EXPORT_ID)).toBe(
      `company-export-part:${TENANT}:${EXPORT_ID}`,
    );
    const sealed = keyring.encrypt(Buffer.from('part'), companyExportPartAad(TENANT, EXPORT_ID));
    expect(keyring.decrypt(sealed, companyExportPartAad(TENANT, EXPORT_ID)).toString()).toBe(
      'part',
    );
    expect(() => keyring.decrypt(sealed, companyExportPartAad(OTHER, EXPORT_ID))).toThrow();
    expect(() => keyring.decrypt(sealed, companyExportPartAad(TENANT, OTHER))).toThrow();
  });

  it('runs as a long, exclusive, retried job with a dead letter', () => {
    expect(QUEUES.companyExport).toMatchObject({
      name: 'company.export',
      policy: 'exclusive',
      deadLetter: 'dead-letter',
    });
    expect(QUEUES.companyExport.retryLimit).toBeGreaterThan(0);
    expect(QUEUES.companyExport.expireInSeconds).toBeGreaterThanOrEqual(3600);
  });

  it('leaves its own tables out of the export, with reasons', () => {
    expect(EXPORT_EXCLUDED_TABLES['app.company_exports']).toMatch(/ADR-415/);
    expect(EXPORT_EXCLUDED_TABLES['app.company_export_parts']).toMatch(/ADR-415/);
  });
});

describe('stored exports: who may ask and download (ADR-415)', () => {
  it('lets owners only ask, list and download, refused before anything is read', async () => {
    for (const roles of [
      ['admin'],
      ['agent'],
      ['supervisor'],
      ['marketer'],
      ['analyst'],
      ['billing'],
    ]) {
      expect(await refusal(requestStoredExport(deps(), ctx(roles))), roles[0]).toBe('forbidden');
      expect(await refusal(listStoredExports(deps(), ctx(roles))), roles[0]).toBe('forbidden');
      expect(await refusal(openStoredExport(deps(), ctx(roles), EXPORT_ID)), roles[0]).toBe(
        'forbidden',
      );
    }
  });

  it('needs a recent sign-in to ask and to download, refused before anything is read', async () => {
    const stale = new Date(now.getTime() - 16 * 60_000);
    for (const signedInAt of [stale, null]) {
      expect(await refusal(requestStoredExport(deps(), ctx(['owner'], signedInAt)))).toBe(
        'step_up_required',
      );
      expect(await refusal(openStoredExport(deps(), ctx(['owner'], signedInAt), EXPORT_ID))).toBe(
        'step_up_required',
      );
    }
  });

  it('does not look up an export id that is not a UUID', async () => {
    for (const id of ['', 'x', '../export', `${EXPORT_ID}'`]) {
      expect(await refusal(openStoredExport(deps(), ctx(['owner']), id)), id).toBe('not_found');
    }
  });

  it('prepares an export only for a requester who is still an active owner', () => {
    expect(requesterMayExport({ roles: ['owner'], status: 'active', userName: 'A' })).toBe(true);
    expect(requesterMayExport({ roles: ['agent', 'owner'], status: 'active', userName: 'A' })).toBe(
      true,
    );
    expect(requesterMayExport({ roles: ['admin'], status: 'active', userName: 'A' })).toBe(false);
    expect(requesterMayExport({ roles: ['owner'], status: 'suspended', userName: 'A' })).toBe(
      false,
    );
    expect(requesterMayExport({ roles: ['owner'], status: 'removed', userName: 'A' })).toBe(false);
    expect(requesterMayExport(null)).toBe(false);
  });
});

describe('reading a stored export back (ADR-415)', () => {
  const keyring = new Keyring({ primaryKeyId: 'k', keys: { k: randomBytes(32) } });
  const scope = authorizedTenantScope(TENANT, 'u1');

  /** A database that answers each part's read from `parts` (by seq), as the company's rows. */
  function partsDb(parts: ({ id: string; byte_size: number; ciphertext: string } | null)[]) {
    let seq = 0;
    return {
      run: async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: async () => ({ rows: parts[seq++] ? [parts[seq - 1]] : [] }),
        }),
    } as unknown as Database;
  }

  function seal(chunks: Buffer[]) {
    return chunks.map((bytes, i) => {
      const id = `0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f${(10 + i).toString()}`;
      return {
        id,
        byte_size: bytes.length,
        ciphertext: keyring.encrypt(bytes, companyExportPartAad(TENANT, id)),
      };
    });
  }

  async function read(
    parts: ({ id: string; byte_size: number; ciphertext: string } | null)[],
    file: { byteSize: number; sha256: string },
  ) {
    const out: Buffer[] = [];
    for await (const bytes of readParts({ db: partsDb(parts), keyring }, scope, TENANT, {
      id: EXPORT_ID,
      attempt: 1,
      partCount: parts.length,
      ...file,
    })) {
      out.push(Buffer.from(bytes));
    }
    return Buffer.concat(out);
  }

  const chunks = [randomBytes(100), randomBytes(100), randomBytes(37)];
  const whole = Buffer.concat(chunks);
  const sha256 = createHash('sha256').update(whole).digest('hex');

  it('gives the parts in order when every part opens and the file matches its record', async () => {
    expect(await read(seal(chunks), { byteSize: whole.length, sha256 })).toEqual(whole);
  });

  it('stops on a missing part, a part of another company or of the wrong size', async () => {
    const sealed = seal(chunks);
    await expect(
      read([sealed[0]!, null, sealed[2]!], { byteSize: whole.length, sha256 }),
    ).rejects.toThrow(/missing/);
    const foreign = {
      ...sealed[1]!,
      ciphertext: keyring.encrypt(chunks[1]!, companyExportPartAad(OTHER, sealed[1]!.id)),
    };
    await expect(
      read([sealed[0]!, foreign, sealed[2]!], { byteSize: whole.length, sha256 }),
    ).rejects.toThrow();
    await expect(
      read([sealed[0]!, { ...sealed[1]!, byte_size: 99 }, sealed[2]!], {
        byteSize: whole.length,
        sha256,
      }),
    ).rejects.toThrow(/wrong size/);
  });

  it('stops when the whole file differs from its recorded size or SHA-256', async () => {
    await expect(read(seal(chunks), { byteSize: whole.length + 1, sha256 })).rejects.toThrow(
      /does not match/,
    );
    await expect(
      read(seal(chunks), { byteSize: whole.length, sha256: '0'.repeat(64) }),
    ).rejects.toThrow(/does not match/);
  });
});
