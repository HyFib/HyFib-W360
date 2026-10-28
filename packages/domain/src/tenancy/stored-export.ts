import { createHash } from 'node:crypto';
import {
  AppError,
  conflict,
  isAppError,
  isDatabaseQueryError,
  notFound,
  uuidv7,
  type Clock,
  type Keyring,
} from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  authorizedTenantScope,
  isUniqueViolation,
  sql,
  systemScope,
  type CompanyExportFailureReason,
  type CompanyExportStatus,
  type Database,
  type TenantRole,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { assertCan, type TenantContext } from '../authz/context';
import { permissionsForRoles } from '../authz/permissions';
import { assertRecentSignIn } from '../authz/step-up';
import { recordAudit, type RequestMeta } from '../audit';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { takeToken } from '../messaging/rate-limit';
import type { JobQueue } from '../jobs/queue';
import type { JobSigner } from '../jobs/envelope';
import { deletionRecipients, formatCompanyTime } from './deletion';
import { CompressedParts, StoredExportTooLargeError } from './export-parts';
import { storedExportPending, takeExportLock, writeExportLines } from './export';

/**
 * Stored company exports (P5-11, ADR-415). An owner asks; a worker job writes the same export as
 * the streamed one (ADR-055: the same tables, columns and exclusions, one read-only snapshot,
 * gzip-compressed JSON Lines) into the company's own rows, a part at a time, each part sealed with
 * the keyring; owners and administrators are emailed a link to Settings → Company data (never a
 * link that downloads); an owner who signed in recently downloads it through the app until it
 * expires, when the minute sweep deletes its parts. One export of a company is read at a time
 * (the export lock), and one stored export waits or is written at a time (a unique index).
 */

/** Days a ready export is kept: a week to download it, then its copy of the company goes. */
export const STORED_EXPORT_RETENTION_DAYS = 7;
/** Runs an export may start before it is given up as interrupted. */
export const STORED_EXPORT_MAX_ATTEMPTS = 3;
/** How long a run holds its export without renewing; it renews well before. */
export const STORED_EXPORT_LEASE_SECONDS = 300;
/** A run renews its lease at least this often, between parts too. */
export const STORED_EXPORT_RENEW_SECONDS = 60;
/** Hours an export may wait for its first run (the export lock taken, the queue down). */
export const STORED_EXPORT_QUEUED_HOURS = 24;
/** Exports the page lists, newest first. */
export const STORED_EXPORT_LIST_LIMIT = 10;
/**
 * Minutes a run may take before it fails as `timed_out`: its repeatable-read snapshot holds back
 * vacuum across the whole database while it runs, so a run is bounded. A 512 MiB export (the
 * largest kept) reads and compresses in a few minutes; 30 leaves room for a slow database without
 * letting a stuck run hold the horizon for long.
 */
export const STORED_EXPORT_MAX_RUN_MINUTES = 30;
/**
 * Minutes a replaced file stays after a newer one is ready, so a download already under way can
 * finish; it is no longer offered, and the minute sweep deletes it.
 */
export const STORED_EXPORT_REPLACED_MINUTES = 30;
/**
 * Stored exports a company may ask for: 3 at once, then one every 8 hours. Each one writes up to
 * the largest file into the database (its write-ahead log and backups) and emails every owner and
 * administrator, so a loop, an owner's or a stolen fresh session's, is bounded; an owner who needs a
 * new copy, or asks again after a failure, has room. A refused request counts too.
 */
export const STORED_EXPORT_REQUEST_LIMIT = { capacity: 3, refillPerSecond: 3 / 86_400 } as const;
/**
 * Downloads of a company's stored exports: 20 at once, then one every 72 minutes. Each opens and
 * checks every part of the file; 20 lets several owners download, and retry broken downloads, the
 * same day, while bounding how often a whole-company copy leaves through one stolen session.
 */
export const STORED_EXPORT_DOWNLOAD_LIMIT = { capacity: 20, refillPerSecond: 20 / 86_400 } as const;

/** What each failure reason means, for the page (codes only are stored, ADR-129). */
export const STORED_EXPORT_FAILURE_LABELS: Record<CompanyExportFailureReason, string> = {
  too_large:
    'The export is larger than 512 MiB compressed, the most HyFib stores for a company. Download the streamed export instead.',
  requester_not_allowed:
    'The owner who asked for it is no longer an owner, so it was not prepared.',
  interrupted: `It was interrupted ${STORED_EXPORT_MAX_ATTEMPTS} times, so HyFib stopped trying.`,
  timed_out: `It could not start within ${STORED_EXPORT_QUEUED_HOURS} hours, or took longer than ${STORED_EXPORT_MAX_RUN_MINUTES} minutes to prepare, so HyFib stopped trying.`,
  error: 'It failed. HyFib logged the error.',
};

/** What each status means, for the page. */
export const STORED_EXPORT_STATUS_LABELS: Record<CompanyExportStatus, string> = {
  queued: 'Waiting to start',
  running: 'Being prepared',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired and deleted',
};

/** A file size in binary units ("812 bytes", "4.2 MiB", "37 MiB"). */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('A size is a whole number of bytes');
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KiB', 'MiB', 'GiB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toString()} ${units[unit]}`;
}

/**
 * A part's associated data: its company, export, run and place in the file, and its own id, so a
 * part moved to another company, export, run or position does not open.
 */
export function companyExportPartAad(
  tenantId: string,
  exportId: string,
  attempt: number,
  seq: number,
  partId: string,
): string {
  return `company-export-part:${tenantId}:${exportId}:${attempt}:${seq}:${partId}`;
}

const TRANSIENT_SQLSTATES = new Set([
  '40001',
  '40P01',
  '57014',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);
const TRANSIENT_NODE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);

/**
 * Whether a run's error may pass if the run is tried again: a serialization failure or deadlock
 * (mapped to a retryable conflict), a cancelled statement, the server shutting down or out of
 * connections, a connection error (SQLSTATE class 08, a socket error, or a query stopped before the
 * server answered), or the pool timing out. Such a run is left to its lease (the next run takes
 * over, within the attempts limit) instead of failing the export.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  if (isAppError(error)) return error.code === 'conflict' && error.details?.retryable === true;
  if (isDatabaseQueryError(error)) {
    if (!error.code) return true;
    return TRANSIENT_SQLSTATES.has(error.code) || error.code.startsWith('08');
  }
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_NODE_CODES.has(code)) return true;
  return /^(timeout exceeded when trying to connect|Connection terminated)/.test(error.message);
}

export interface StoredExportDeps extends OutboxDeps {
  db: Database;
  clock: Clock;
  keyring: Keyring;
  jobs: JobQueue;
  signer: JobSigner;
  appBaseUrl: string;
  /** Part size, largest file and longest run; the defaults unless given (smaller in tests). */
  limits?: { partBytes?: number; maxBytes?: number; maxRunMs?: number };
}

export interface StoredExportView {
  id: string;
  status: CompanyExportStatus;
  requestedAt: Date;
  requestedByName: string | null;
  finishedAt: Date | null;
  expiresAt: Date | null;
  byteSize: number | null;
  sha256: string | null;
  failureReason: CompanyExportFailureReason | null;
  /** Ready, but a newer export is ready too: no longer offered, deleted shortly. */
  replaced: boolean;
}

type ExportRow = {
  id: string;
  status: CompanyExportStatus;
  attempts: number;
  requested_at: Date;
  finished_at: Date | null;
  expires_at: Date | null;
  byte_size: string | number | null;
  sha256: string | null;
  part_count: number | null;
  failure_reason: CompanyExportFailureReason | null;
};

const toNumber = (value: string | number | null) => (value === null ? null : Number(value));

const settingsUrl = (deps: Pick<StoredExportDeps, 'appBaseUrl'>, slug: string) =>
  `${deps.appBaseUrl}/c/${slug}/settings/data`;

/** Emails every active owner and administrator of the company (in `tx`). */
async function tellOwners(
  deps: StoredExportDeps,
  tx: Tx,
  company: { id: string; name: string; slug: string },
  subject: string,
  lines: string[],
): Promise<void> {
  for (const person of await deletionRecipients(tx, company.id)) {
    await enqueueEmail(deps, tx, {
      to: person.email,
      tenantId: company.id,
      payload: {
        kind: 'tenant.notice',
        companyName: company.name,
        subject,
        lines,
        url: settingsUrl(deps, company.slug),
        actionLabel: 'Open company data',
      },
    });
  }
}

/**
 * Asks for a stored export: owners (`tenant.export`) who signed in recently, as for the streamed
 * export. Refused while any export of the company is running or a stored export is waiting or
 * being written. Audited (`tenant.export_requested`); owners and administrators are emailed.
 */
export async function requestStoredExport(
  deps: StoredExportDeps,
  ctx: TenantContext,
  meta: RequestMeta = {},
): Promise<{ id: string }> {
  assertCan(ctx, 'tenant.export');
  const now = deps.clock.now();
  assertRecentSignIn(ctx, now);
  if (
    !(await takeToken(
      deps.db,
      `company-export:request:${ctx.tenant.id}`,
      STORED_EXPORT_REQUEST_LIMIT,
    ))
  ) {
    throw new AppError(
      'rate_limited',
      'This company has asked for several stored exports today. Try again later, or download the streamed export.',
    );
  }
  const id = uuidv7();
  try {
    await deps.db.run(ctx.scope, async (tx) => {
      // A streamed export holds the lock while it runs: one export at a time (ADR-415).
      if (!(await takeExportLock(tx, ctx.tenant.id))) {
        throw conflict('An export of this company is already running. Try again when it ends.');
      }
      if (await storedExportPending(tx)) throw pendingConflict();
      await tx.execute(
        sql`insert into app.company_exports (id, tenant_id, requested_by_membership_id)
            values (${id}::uuid, (select app.current_tenant_id()), ${ctx.membership.id}::uuid)`,
      );
      await recordAudit(
        tx,
        ctx,
        { action: 'tenant.export_requested', subjectType: 'company_export', subjectId: id },
        meta,
      );
      await tellOwners(deps, tx, ctx.tenant, 'Company data export requested', [
        `${ctx.user.name} asked for a stored export of all of ${ctx.tenant.name}'s data on ${formatCompanyTime(now, ctx.tenant.timezone)}.`,
        'You will be emailed when it is ready. Owners download it from Settings, Company data.',
        'If you did not expect this, check who has owner access in Settings, Members.',
      ]);
      await deps.jobs.enqueue(
        tx,
        QUEUES.companyExport.name,
        deps.signer.sign({
          kind: 'company.export',
          tenantId: ctx.tenant.id,
          actorUserId: ctx.user.id,
          ref: id,
        }),
        { singletonKey: id },
      );
    });
  } catch (error) {
    // Two owners asking at once: the second insert meets the first's row (ADR-415).
    if (isUniqueViolation(error, 'company_exports_active_uq')) throw pendingConflict();
    throw error;
  }
  return { id };
}

const pendingConflict = () =>
  conflict('A stored export of this company is already being prepared. Wait until it is ready.');

/** The company's latest stored exports, newest first (`tenant.export`). */
export async function listStoredExports(
  deps: Pick<StoredExportDeps, 'db'>,
  ctx: TenantContext,
): Promise<StoredExportView[]> {
  assertCan(ctx, 'tenant.export');
  return deps.db.run(
    ctx.scope,
    async (tx) => {
      const res = await tx.execute<
        ExportRow & { requested_by_name: string | null; replaced: boolean }
      >(
        sql`select e.id, e.status, e.attempts, e.requested_at, e.finished_at, e.expires_at,
                   e.byte_size, e.sha256, e.part_count, e.failure_reason, u.name as requested_by_name,
                   (e.status = 'ready' and exists (
                     select 1 from app.company_exports n
                      where n.status = 'ready' and n.finished_at > e.finished_at)) as replaced
              from app.company_exports e
              left join app.memberships m on m.tenant_id = e.tenant_id
                   and m.id = e.requested_by_membership_id
              left join auth.users u on u.id = m.user_id
             order by e.requested_at desc, e.id desc
             limit ${STORED_EXPORT_LIST_LIMIT}`,
      );
      return res.rows.map((row) => ({
        id: row.id,
        status: row.status,
        requestedAt: new Date(row.requested_at),
        requestedByName: row.requested_by_name,
        finishedAt: row.finished_at ? new Date(row.finished_at) : null,
        expiresAt: row.expires_at ? new Date(row.expires_at) : null,
        byteSize: toNumber(row.byte_size),
        sha256: row.sha256,
        failureReason: row.failure_reason,
        replaced: row.replaced,
      }));
    },
    { accessMode: 'read only' },
  );
}

export interface StoredExportDownload {
  filename: string;
  byteSize: number;
  sha256: string;
  /** The file's bytes, a part at a time, each read in its own short transaction and checked. */
  parts: AsyncGenerator<Uint8Array, void, undefined>;
}

/**
 * Opens a ready stored export for download: owners (`tenant.export`) who signed in recently, of
 * the company's own exports only (another company's id is not found). Audited
 * (`tenant.export_downloaded`); owners and administrators are emailed, as for every export. The
 * parts are opened as they are read; a part missing, of the wrong size or failing the keyring's
 * check, or a file whose size or SHA-256 differs from the recorded one, stops the download with an
 * error before the last part is sent (the client is left with an incomplete file, never a wrong
 * one). A replaced file is no longer offered. At most `STORED_EXPORT_DOWNLOAD_LIMIT` downloads a
 * company a day.
 */
export async function openStoredExport(
  deps: StoredExportDeps,
  ctx: TenantContext,
  exportId: string,
  meta: RequestMeta = {},
): Promise<StoredExportDownload> {
  assertCan(ctx, 'tenant.export');
  const now = deps.clock.now();
  assertRecentSignIn(ctx, now);
  if (!UUID_RE.test(exportId)) throw notFound('Export');
  if (
    !(await takeToken(
      deps.db,
      `company-export:download:${ctx.tenant.id}`,
      STORED_EXPORT_DOWNLOAD_LIMIT,
    ))
  ) {
    throw new AppError(
      'rate_limited',
      'The stored exports of this company have been downloaded many times today. Try again later.',
    );
  }
  const row = await deps.db.run(ctx.scope, async (tx) => {
    const res = await tx.execute<ExportRow>(
      sql`select id, status, attempts, requested_at, finished_at, expires_at, byte_size, sha256,
                 part_count, failure_reason
            from app.company_exports e
           where id = ${exportId}::uuid and status = 'ready' and expires_at > now()
             and not exists (select 1 from app.company_exports n
                              where n.status = 'ready' and n.finished_at > e.finished_at)`,
    );
    const found = res.rows[0];
    if (!found) return null;
    await recordAudit(
      tx,
      ctx,
      { action: 'tenant.export_downloaded', subjectType: 'company_export', subjectId: exportId },
      meta,
    );
    await tellOwners(deps, tx, ctx.tenant, 'Company data export downloaded', [
      `${ctx.user.name} downloaded the stored export of ${ctx.tenant.name}'s data on ${formatCompanyTime(now, ctx.tenant.timezone)}.`,
      'If you did not expect this, check who has owner access in Settings, Members.',
    ]);
    return found;
  });
  if (!row || row.byte_size === null || row.sha256 === null || row.part_count === null) {
    throw notFound('Export');
  }
  const byteSize = Number(row.byte_size);
  const date = new Date(row.finished_at ?? row.requested_at).toISOString().slice(0, 10);
  return {
    filename: `hyfib-w360-${ctx.tenant.slug}-${date}.jsonl.gz`,
    byteSize,
    sha256: row.sha256,
    parts: readParts(deps, ctx.scope, ctx.tenant.id, {
      id: row.id,
      attempt: row.attempts,
      partCount: row.part_count,
      byteSize,
      sha256: row.sha256,
    }),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads and opens a ready export's parts in order, checking each and the whole file. */
export async function* readParts(
  deps: Pick<StoredExportDeps, 'db' | 'keyring'>,
  scope: TenantScope,
  tenantId: string,
  file: { id: string; attempt: number; partCount: number; byteSize: number; sha256: string },
): AsyncGenerator<Uint8Array, void, undefined> {
  const hash = createHash('sha256');
  let total = 0;
  for (let seq = 0; seq < file.partCount; seq += 1) {
    const part = await deps.db.run(
      scope,
      async (tx) => {
        const res = await tx.execute<{ id: string; byte_size: number; ciphertext: string }>(
          sql`select p.id, p.byte_size, p.ciphertext
                from app.company_export_parts p
                join app.company_exports e on e.tenant_id = p.tenant_id and e.id = p.export_id
               where p.export_id = ${file.id}::uuid and p.attempt = ${file.attempt}
                 and p.seq = ${seq} and e.status = 'ready' and e.attempts = ${file.attempt}`,
        );
        return res.rows[0] ?? null;
      },
      { accessMode: 'read only' },
    );
    if (!part) throw new Error('A part of the stored export is missing (it may have expired)');
    const bytes = deps.keyring.decrypt(
      part.ciphertext,
      companyExportPartAad(tenantId, file.id, file.attempt, seq, part.id),
    );
    if (bytes.length !== part.byte_size) {
      throw new Error('A part of the stored export has the wrong size');
    }
    total += bytes.length;
    hash.update(bytes);
    // The whole file is checked before its last part is sent, so a wrong file is never complete.
    if (
      seq === file.partCount - 1 &&
      (total !== file.byteSize || hash.digest('hex') !== file.sha256)
    ) {
      throw new Error('The stored export does not match its recorded size and SHA-256');
    }
    yield bytes;
  }
}

export type StoredExportRunOutcome =
  | { outcome: 'missing' | 'finished' | 'busy' | 'locked' | 'lost_lease' }
  | { outcome: 'ready'; byteSize: number; partCount: number; attempt: number }
  | {
      outcome: 'failed';
      reason: CompanyExportFailureReason;
      /** The error that failed it, for the worker's log (never stored). */
      error: unknown;
    };

/** The run passed `STORED_EXPORT_MAX_RUN_MINUTES`. */
class RunTooLongError extends Error {
  constructor() {
    super('The stored export run took too long');
    this.name = 'RunTooLongError';
  }
}

/** The run lost its export: another run took it over, or the export was deleted. */
class LostLeaseError extends Error {
  constructor() {
    super('The stored export run lost its lease');
    this.name = 'LostLeaseError';
  }
}

interface RunState {
  export: ExportRow & { lease_live: boolean; queued_too_long: boolean };
  requester: { roles: TenantRole[]; status: string; userName: string } | null;
  company: { id: string; name: string; slug: string; timezone: string };
}

async function loadRunState(
  deps: Pick<StoredExportDeps, 'db'>,
  scope: TenantScope,
  exportId: string,
): Promise<RunState | null> {
  return deps.db.run(
    scope,
    async (tx) => {
      const res = await tx.execute<
        ExportRow & {
          lease_live: boolean;
          queued_too_long: boolean;
          roles: TenantRole[] | null;
          member_status: string | null;
          user_name: string | null;
          tenant_name: string;
          slug: string;
          timezone: string;
        }
      >(
        sql`select e.id, e.status, e.attempts, e.requested_at, e.finished_at, e.expires_at,
                   e.byte_size, e.sha256, e.part_count, e.failure_reason,
                   coalesce(e.lease_until > now(), false) as lease_live,
                   e.requested_at < now() - make_interval(hours => ${STORED_EXPORT_QUEUED_HOURS})
                     as queued_too_long,
                   m.roles, m.status as member_status, u.name as user_name,
                   t.name as tenant_name, t.slug, t.timezone
              from app.company_exports e
              join app.tenants t on t.id = e.tenant_id
              left join app.memberships m on m.tenant_id = e.tenant_id
                   and m.id = e.requested_by_membership_id
              left join auth.users u on u.id = m.user_id
             where e.id = ${exportId}::uuid`,
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        export: row,
        requester:
          row.roles && row.member_status
            ? { roles: row.roles, status: row.member_status, userName: row.user_name ?? '' }
            : null,
        company: {
          id: scope.tenantId,
          name: row.tenant_name,
          slug: row.slug,
          timezone: row.timezone,
        },
      };
    },
    { accessMode: 'read only' },
  );
}

/** Whether the requester may still export: an active member whose roles give `tenant.export`. */
export function requesterMayExport(requester: RunState['requester']): boolean {
  return (
    requester !== null &&
    requester.status === 'active' &&
    permissionsForRoles(requester.roles).has('tenant.export')
  );
}

/**
 * Fails the export with a reason code (and a database error's SQLSTATE), deletes its parts and
 * tells the owners and administrators. Only a run that still holds it (`attempt`), or, for an
 * export never started, while it waits.
 */
async function failExport(
  deps: StoredExportDeps,
  scope: TenantScope,
  company: RunState['company'],
  exportId: string,
  fence: { attempt: number } | 'queued',
  reason: CompanyExportFailureReason,
  error: unknown,
): Promise<boolean> {
  const code =
    isDatabaseQueryError(error) && error.code && /^[0-9A-Z]{5}$/.test(error.code)
      ? error.code
      : null;
  return deps.db.run(scope, async (tx) => {
    const guard =
      fence === 'queued'
        ? sql`status = 'queued'`
        : sql`status = 'running' and attempts = ${fence.attempt}`;
    const res = await tx.execute<{ requested_at: Date }>(
      sql`update app.company_exports
             set status = 'failed', lease_until = null, finished_at = now(), deleted_at = now(),
                 failure_reason = ${reason}, failure_code = ${code}
           where id = ${exportId}::uuid and ${guard}
       returning requested_at`,
    );
    const failed = res.rows[0];
    if (!failed) return false;
    await tx.execute(sql`delete from app.company_export_parts where export_id = ${exportId}::uuid`);
    await tellOwners(deps, tx, company, 'Company data export failed', [
      `The stored export of ${company.name}'s data asked for on ${formatCompanyTime(new Date(failed.requested_at), company.timezone)} could not be prepared.`,
      STORED_EXPORT_FAILURE_LABELS[reason],
      'An owner can ask for a new one, or download the streamed export, in Settings, Company data.',
    ]);
    return true;
  });
}

/**
 * One run of a stored export (the `company.export` job). The company comes from the verified job,
 * the export from its own row in that company. A run:
 *
 * 1. leaves an export that is finished, or held by a live run, alone;
 * 2. fails one waiting more than `STORED_EXPORT_QUEUED_HOURS`, or whose owner is no longer one;
 * 3. opens the company's read-only snapshot and takes the export lock (if another export holds
 *    it, the export keeps waiting and the minute sweep signals it again);
 * 4. claims it (`attempts` + 1, a lease from the database's now); past
 *    `STORED_EXPORT_MAX_ATTEMPTS` it fails as interrupted;
 * 5. writes the export's lines through `CompressedParts`, each part sealed and inserted only while
 *    this run still holds the export, renewing the lease;
 * 6. marks it ready with its size, SHA-256 and expiry, deletes earlier runs' parts and emails the
 *    owners and administrators a link to Settings → Company data.
 *
 * A failure is recorded with a code and the export's parts deleted; the error is returned for the
 * log.
 */
export async function runStoredExport(
  deps: StoredExportDeps,
  scope: TenantScope,
  exportId: string,
): Promise<StoredExportRunOutcome> {
  const state = await loadRunState(deps, scope, exportId);
  if (!state) return { outcome: 'missing' };
  const { export: row, company } = state;
  if (row.status === 'ready' || row.status === 'failed' || row.status === 'expired') {
    return { outcome: 'finished' };
  }
  if (row.status === 'running' && row.lease_live) return { outcome: 'busy' };
  if (row.status === 'queued' && row.queued_too_long) {
    const failed = await failExport(deps, scope, company, exportId, 'queued', 'timed_out', null);
    return failed ? { outcome: 'failed', reason: 'timed_out', error: null } : { outcome: 'busy' };
  }
  if (!requesterMayExport(state.requester)) {
    const fence = row.status === 'queued' ? 'queued' : { attempt: row.attempts };
    const failed = await failExport(
      deps,
      scope,
      company,
      exportId,
      fence,
      'requester_not_allowed',
      null,
    );
    return failed
      ? { outcome: 'failed', reason: 'requester_not_allowed', error: null }
      : { outcome: 'busy' };
  }

  return deps.db.run(
    scope,
    async (snapshot): Promise<StoredExportRunOutcome> => {
      if (!(await takeExportLock(snapshot, scope.tenantId))) return { outcome: 'locked' };
      const attempt = await claim(deps, scope, exportId);
      if (attempt === null) return { outcome: 'busy' };
      if (attempt > STORED_EXPORT_MAX_ATTEMPTS) {
        const failed = await failExport(
          deps,
          scope,
          company,
          exportId,
          { attempt },
          'interrupted',
          null,
        );
        return failed
          ? { outcome: 'failed', reason: 'interrupted', error: null }
          : { outcome: 'lost_lease' };
      }
      return writeStoredExport(deps, scope, snapshot, company, exportId, attempt);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** Takes the export for a new run; null when it is finished or a live run holds it. */
async function claim(
  deps: Pick<StoredExportDeps, 'db'>,
  scope: TenantScope,
  exportId: string,
): Promise<number | null> {
  return deps.db.run(scope, async (tx) => {
    const res = await tx.execute<{ attempts: number }>(
      sql`update app.company_exports
             set status = 'running', attempts = least(attempts + 1, 10),
                 lease_until = now() + make_interval(secs => ${STORED_EXPORT_LEASE_SECONDS}),
                 started_at = coalesce(started_at, now())
           where id = ${exportId}::uuid
             and (status = 'queued' or (status = 'running' and lease_until <= now()))
       returning attempts`,
    );
    const attempt = res.rows[0]?.attempts ?? null;
    if (attempt !== null) {
      // Earlier runs are dead (this run holds the export lock they read under), so their parts go
      // now: an export holds at most one run's parts (ADR-415).
      await tx.execute(
        sql`delete from app.company_export_parts
             where export_id = ${exportId}::uuid and attempt <> ${attempt}`,
      );
    }
    return attempt;
  });
}

async function writeStoredExport(
  deps: StoredExportDeps,
  scope: TenantScope,
  snapshot: Tx,
  company: RunState['company'],
  exportId: string,
  attempt: number,
): Promise<StoredExportRunOutcome> {
  const leaseFence = sql`id = ${exportId}::uuid and status = 'running' and attempts = ${attempt}`;
  let lastRenewal = deps.clock.now().getTime();
  const renew = async (tx: Tx) => {
    const res = await tx.execute(
      sql`update app.company_exports
             set lease_until = now() + make_interval(secs => ${STORED_EXPORT_LEASE_SECONDS})
           where ${leaseFence}`,
    );
    if (res.rowCount !== 1) throw new LostLeaseError();
    lastRenewal = deps.clock.now().getTime();
  };
  const file = new CompressedParts(async (seq, bytes) => {
    await deps.db.run(scope, async (tx) => {
      const partId = uuidv7();
      const sealed = deps.keyring.encrypt(
        bytes,
        companyExportPartAad(scope.tenantId, exportId, attempt, seq, partId),
      );
      const res = await tx.execute(
        sql`insert into app.company_export_parts
                   (id, tenant_id, export_id, attempt, seq, byte_size, ciphertext)
            select ${partId}::uuid, e.tenant_id, e.id, ${attempt}::smallint, ${seq}::integer,
                   ${bytes.length}::integer, ${sealed}::text
              from app.company_exports e
             where e.id = ${exportId}::uuid and e.status = 'running'
               and e.attempts = ${attempt}`,
      );
      if (res.rowCount !== 1) throw new LostLeaseError();
      await renew(tx);
    });
  }, deps.limits);

  const startedAt = deps.clock.now().getTime();
  const maxRunMs = deps.limits?.maxRunMs ?? STORED_EXPORT_MAX_RUN_MINUTES * 60_000;
  try {
    const exportedAt = deps.clock.now();
    await writeExportLines(snapshot, company, exportedAt, async (chunk) => {
      const now = deps.clock.now().getTime();
      if (now - startedAt > maxRunMs) throw new RunTooLongError();
      if (now - lastRenewal >= STORED_EXPORT_RENEW_SECONDS * 1000) {
        await deps.db.run(scope, renew);
      }
      await file.write(chunk);
    });
    const done = await file.finish();
    const ready = await deps.db.run(scope, async (tx) => {
      const res = await tx.execute<{ requested_at: Date; expires_at: Date }>(
        sql`update app.company_exports
               set status = 'ready', lease_until = null, finished_at = now(),
                   expires_at = now() + make_interval(days => ${STORED_EXPORT_RETENTION_DAYS}),
                   byte_size = ${done.byteSize}, sha256 = ${done.sha256},
                   part_count = ${done.partCount}
             where ${leaseFence}
         returning requested_at, expires_at`,
      );
      const marked = res.rows[0];
      if (!marked) throw new LostLeaseError();
      // One ready file per company: an older ready file is no longer offered and expires shortly,
      // so a download under way can finish; the minute sweep deletes it (ADR-415).
      await tx.execute(
        sql`update app.company_exports
               set expires_at = least(expires_at,
                     now() + make_interval(mins => ${STORED_EXPORT_REPLACED_MINUTES}))
             where status = 'ready' and id <> ${exportId}::uuid`,
      );
      await tellOwners(deps, tx, company, 'Company data export ready', [
        `The stored export of ${company.name}'s data asked for on ${formatCompanyTime(new Date(marked.requested_at), company.timezone)} is ready.`,
        `Owners can download it from Settings, Company data, after signing in, until ${formatCompanyTime(new Date(marked.expires_at), company.timezone)}, or until a newer stored export is ready. Then it is deleted.`,
      ]);
      return true;
    });
    return ready
      ? { outcome: 'ready', byteSize: done.byteSize, partCount: done.partCount, attempt }
      : { outcome: 'lost_lease' };
  } catch (error) {
    file.destroy();
    if (error instanceof LostLeaseError) return { outcome: 'lost_lease' };
    // A transient error leaves the export to its lease: the next run takes over (ADR-415).
    if (isTransientDatabaseError(error)) throw error;
    const reason: CompanyExportFailureReason =
      error instanceof StoredExportTooLargeError
        ? 'too_large'
        : error instanceof RunTooLongError
          ? 'timed_out'
          : 'error';
    const failed = await failExport(deps, scope, company, exportId, { attempt }, reason, error);
    return failed ? { outcome: 'failed', reason, error } : { outcome: 'lost_lease' };
  }
}

/**
 * Deletes an expired export's parts and records it as expired (idempotent: an export already
 * expired only has any part left deleted). In the company's scope; the company and export come from
 * the sweep's database function.
 */
export async function expireStoredExport(
  deps: Pick<StoredExportDeps, 'db'>,
  tenantId: string,
  exportId: string,
): Promise<boolean> {
  return deps.db.run(authorizedTenantScope(tenantId, null), async (tx) => {
    const res = await tx.execute(
      sql`update app.company_exports set status = 'expired', deleted_at = now()
           where id = ${exportId}::uuid and status = 'ready' and expires_at <= now()`,
    );
    await tx.execute(
      sql`delete from app.company_export_parts p
           using app.company_exports e
           where e.tenant_id = p.tenant_id and e.id = p.export_id and p.export_id = ${exportId}::uuid
             and e.status in ('expired', 'failed')`,
    );
    return res.rowCount === 1;
  });
}

export interface StoredExportSweepResult {
  expired: number;
  signalled: number;
  failed: { tenantId: string; exportId: string; error: unknown }[];
}

/**
 * The minute sweep's part (ADR-415): expires ready exports past their expiry, and signals again
 * exports still waiting (their job lost, retried out, or finding the export lock taken) and running
 * exports whose lease ran out (a crashed run), so no export is stuck: the run decides, in the
 * company's scope, whether to start, take over or give up. Companies and exports come from
 * `ops.company_exports_due`, ids only.
 */
export async function sweepStoredExports(
  deps: Pick<StoredExportDeps, 'db' | 'jobs' | 'signer'>,
  limit = 100,
): Promise<StoredExportSweepResult> {
  const due = await deps.db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; id: string; action: 'expire' | 'signal' }>(
        sql`select tenant_id, id, action from ops.company_exports_due(${limit})`,
      );
      return res.rows;
    },
    { accessMode: 'read only' },
  );
  const result: StoredExportSweepResult = { expired: 0, signalled: 0, failed: [] };
  for (const item of due) {
    try {
      if (item.action === 'expire') {
        if (await expireStoredExport(deps, item.tenant_id, item.id)) result.expired += 1;
      } else {
        await deps.jobs.enqueue(
          null,
          QUEUES.companyExport.name,
          deps.signer.sign({
            kind: 'company.export',
            tenantId: item.tenant_id,
            actorUserId: null,
            ref: item.id,
          }),
          { singletonKey: item.id },
        );
        result.signalled += 1;
      }
    } catch (error) {
      result.failed.push({ tenantId: item.tenant_id, exportId: item.id, error });
    }
  }
  return result;
}
