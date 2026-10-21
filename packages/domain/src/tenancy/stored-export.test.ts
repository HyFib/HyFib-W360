import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError, DatabaseQueryError, Keyring, isAppError } from '@w360/core';
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
  STORED_EXPORT_DOWNLOAD_LIMIT,
  STORED_EXPORT_FAILURE_LABELS,
  STORED_EXPORT_LEASE_SECONDS,
  STORED_EXPORT_MAX_ATTEMPTS,
  STORED_EXPORT_MAX_RUN_MINUTES,
  STORED_EXPORT_RENEW_SECONDS,
  STORED_EXPORT_REPLACED_MINUTES,
  STORED_EXPORT_REQUEST_LIMIT,
  STORED_EXPORT_RETENTION_DAYS,
  STORED_EXPORT_STATUS_LABELS,
  companyExportPartAad,
  formatByteSize,
  isTransientDatabaseError,
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

  it('bounds a run to 30 minutes, within its job’s hour, and keeps a replaced file 30 minutes', () => {
    expect(STORED_EXPORT_MAX_RUN_MINUTES).toBe(30);
    expect(STORED_EXPORT_MAX_RUN_MINUTES * 60).toBeLessThan(QUEUES.companyExport.expireInSeconds);
    expect(STORED_EXPORT_REPLACED_MINUTES).toBe(30);
  });

  it('lets a company ask 3 times and download 20 times a day', () => {
    expect(STORED_EXPORT_REQUEST_LIMIT.capacity).toBe(3);
    expect(STORED_EXPORT_REQUEST_LIMIT.refillPerSecond * 86_400).toBeCloseTo(3, 10);
    expect(STORED_EXPORT_DOWNLOAD_LIMIT.capacity).toBe(20);
    expect(STORED_EXPORT_DOWNLOAD_LIMIT.refillPerSecond * 86_400).toBeCloseTo(20, 10);
  });

  it('leaves a run to its lease on a transient database error, and fails it on any other', () => {
    const transient = [
      new AppError('conflict', 'retry', { details: { retryable: true } }),
      new DatabaseQueryError({ code: '40001' }),
      new DatabaseQueryError({ code: '40P01' }),
      new DatabaseQueryError({ code: '57014' }),
      new DatabaseQueryError({ code: '57P01' }),
      new DatabaseQueryError({ code: '53300' }),
      new DatabaseQueryError({ code: '08006' }),
      new DatabaseQueryError({ stoppedBy: 'Error' }),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      new Error('timeout exceeded when trying to connect'),
      new Error('Connection terminated unexpectedly'),
    ];
    for (const error of transient)
      expect(isTransientDatabaseError(error), String(error)).toBe(true);
    const permanent = [
      new AppError('conflict', 'A record with the same unique value already exists.'),
      new AppError('forbidden', 'no'),
      new DatabaseQueryError({ code: '23505' }),
      new DatabaseQueryError({ code: '42501' }),
      new DatabaseQueryError({ code: '22P02' }),
      new Error('boom'),
      'not an error',
      null,
    ];
    for (const error of permanent) {
      expect(isTransientDatabaseError(error), String(error)).toBe(false);
    }
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

  it('seals each part for its company, export, run and place, so a moved part does not open', () => {
    const keyring = new Keyring({ primaryKeyId: 'k', keys: { k: randomBytes(32) } });
    const PART = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';
    expect(companyExportPartAad(TENANT, EXPORT_ID, 2, 7, PART)).toBe(
      `company-export-part:${TENANT}:${EXPORT_ID}:2:7:${PART}`,
    );
    const sealed = keyring.encrypt(
      Buffer.from('part'),
      companyExportPartAad(TENANT, EXPORT_ID, 2, 7, PART),
    );
    expect(
      keyring.decrypt(sealed, companyExportPartAad(TENANT, EXPORT_ID, 2, 7, PART)).toString(),
    ).toBe('part');
    for (const moved of [
      companyExportPartAad(OTHER, EXPORT_ID, 2, 7, PART),
      companyExportPartAad(TENANT, OTHER, 2, 7, PART),
      companyExportPartAad(TENANT, EXPORT_ID, 1, 7, PART),
      companyExportPartAad(TENANT, EXPORT_ID, 2, 6, PART),
      companyExportPartAad(TENANT, EXPORT_ID, 2, 7, OTHER),
    ]) {
      expect(() => keyring.decrypt(sealed, moved), moved).toThrow();
    }
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

  it('limits asking and downloading per company, checked after the owner and the step-up', async () => {
    // A database whose token bucket is empty: the only statement is the bucket's, in the system
    // scope, and nothing of the company is read or written.
    const calls: string[] = [];
    const empty = {
      run: async (scope: { kind: string }, fn: (tx: unknown) => Promise<unknown>) => {
        calls.push(scope.kind);
        return fn({ execute: async () => ({ rows: [] }) });
      },
    } as unknown as Database;
    const limited = { ...deps(), db: empty };
    const asked = await requestStoredExport(limited, ctx(['owner'])).catch((e: unknown) => e);
    expect(isAppError(asked) && asked.code).toBe('rate_limited');
    expect(isAppError(asked) && asked.publicMessage).toMatch(/streamed export/);
    expect(calls).toEqual(['system']);
    calls.length = 0;
    const opened = await openStoredExport(limited, ctx(['owner']), EXPORT_ID).catch(
      (e: unknown) => e,
    );
    expect(isAppError(opened) && opened.code).toBe('rate_limited');
    expect(calls).toEqual(['system']);
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
        ciphertext: keyring.encrypt(bytes, companyExportPartAad(TENANT, EXPORT_ID, 1, i, id)),
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
      ciphertext: keyring.encrypt(
        chunks[1]!,
        companyExportPartAad(OTHER, EXPORT_ID, 1, 1, sealed[1]!.id),
      ),
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

  it('stops on parts in the wrong order, or of another run', async () => {
    const sealed = seal(chunks);
    await expect(
      read([sealed[1]!, sealed[0]!, sealed[2]!], { byteSize: whole.length, sha256 }),
    ).rejects.toThrow();
    const otherRun = {
      ...sealed[2]!,
      ciphertext: keyring.encrypt(
        chunks[2]!,
        companyExportPartAad(TENANT, EXPORT_ID, 2, 2, sealed[2]!.id),
      ),
    };
    await expect(
      read([sealed[0]!, sealed[1]!, otherRun], { byteSize: whole.length, sha256 }),
    ).rejects.toThrow();
  });

  it('checks the whole file before sending its last part, so a wrong file is never complete', async () => {
    for (const file of [
      { byteSize: whole.length + 1, sha256 },
      { byteSize: whole.length, sha256: '0'.repeat(64) },
    ]) {
      const sent: Buffer[] = [];
      const reading = (async () => {
        for await (const bytes of readParts({ db: partsDb(seal(chunks)), keyring }, scope, TENANT, {
          id: EXPORT_ID,
          attempt: 1,
          partCount: chunks.length,
          ...file,
        })) {
          sent.push(Buffer.from(bytes));
        }
      })();
      await expect(reading).rejects.toThrow(/does not match/);
      expect(sent).toHaveLength(chunks.length - 1);
    }
  });
});
