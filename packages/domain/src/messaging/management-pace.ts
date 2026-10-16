import { AppError, type Clock } from '@w360/core';
import type { QueueName } from '@w360/contracts';
import {
  and,
  eq,
  isNull,
  lte,
  or,
  whatsappAccounts,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { formatCompanyTime } from '../tenancy/deletion';
import { highestUsagePercent, type BusinessUseCaseUsage } from './usage-header';

/**
 * Pacing of WhatsApp management calls by the usage Meta reports (ADR-399). Every response's
 * `x-business-use-case-usage` header is parsed by the Graph client; the code paths that hold an
 * authorized scope for a WhatsApp account store the `whatsapp_business_management` reading for
 * that account's own WABA id (never an id the header names alone) on the account row. While Meta
 * reports minutes to regain access, the account is paused: background management work does not call
 * Graph and runs again just after the pause ends, and members' management actions say Meta is
 * limiting management requests until then instead of calling Graph. A high percentage alone pauses
 * nothing (ADR-399 explains why); a rate-limit error without the header keeps the existing retries.
 */

/** How long after a pause ends deferred work runs again (Meta gives whole minutes, M-200). */
export const MANAGEMENT_RESUME_MARGIN_MS = 30_000;

/** What a reading stores on the account. */
export interface ManagementReading {
  readAt: Date;
  /** The highest of the three percentages. */
  percent: number;
  /** Until when Meta throttles management calls, or null when it does not. */
  pausedUntil: Date | null;
}

/**
 * The reading a response's usage gives for the account whose WABA id is `wabaId`, or null when the
 * response reported none for it (another business id's entries are ignored).
 */
export function managementReading(
  usage: BusinessUseCaseUsage | undefined | null,
  wabaId: string,
  readAt: Date,
): ManagementReading | null {
  const entry = usage?.get(wabaId);
  if (!entry) return null;
  return {
    readAt,
    percent: highestUsagePercent(entry),
    pausedUntil:
      entry.regainAccessMinutes > 0
        ? new Date(readAt.getTime() + entry.regainAccessMinutes * 60_000)
        : null,
  };
}

/** The end of the account's pause, when it is still paused at `now`; otherwise null. */
export function activeManagementPause(
  pausedUntil: Date | null | undefined,
  now: Date,
): Date | null {
  return pausedUntil instanceof Date && pausedUntil.getTime() > now.getTime() ? pausedUntil : null;
}

/** When work deferred by a pause runs again. */
export function managementResumeAt(pausedUntil: Date): Date {
  return new Date(pausedUntil.getTime() + MANAGEMENT_RESUME_MARGIN_MS);
}

/** The shortest delay a deferred job is queued with, whatever the clocks say. */
export const MIN_DEFERRAL_SECONDS = 30;

/**
 * The delay, in whole seconds from now, a job deferred by a pause is queued with: until just after
 * the pause as this worker's clock sees it, and never less than `MIN_DEFERRAL_SECONDS`.
 */
export function deferralDelaySeconds(pausedUntil: Date, now: Date): number {
  const wait = Math.ceil((managementResumeAt(pausedUntil).getTime() - now.getTime()) / 1000);
  return Math.max(MIN_DEFERRAL_SECONDS, wait);
}

/** A job outcome: the account's management calls are paused until `paused`; nothing was called. */
export interface ManagementPaused {
  paused: Date;
}

export function isManagementPaused(value: unknown): value is ManagementPaused {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { paused?: unknown }).paused instanceof Date
  );
}

/**
 * Stores a reading on the account, in the company's scope, when it is for the account's current
 * WABA id and no newer reading is stored. True when stored.
 */
export async function recordManagementUsage(
  tx: Tx,
  tenantId: string,
  account: { whatsappAccountId: string; wabaId: string },
  reading: ManagementReading,
): Promise<boolean> {
  const updated = await tx
    .update(whatsappAccounts)
    .set({
      managementUsageReadAt: reading.readAt,
      managementUsagePercent: reading.percent,
      managementPausedUntil: reading.pausedUntil,
    })
    .where(
      and(
        eq(whatsappAccounts.tenantId, tenantId),
        eq(whatsappAccounts.id, account.whatsappAccountId),
        // The header's business id was matched against this id; it must still be the account's.
        eq(whatsappAccounts.wabaId, account.wabaId),
        or(
          isNull(whatsappAccounts.managementUsageReadAt),
          lte(whatsappAccounts.managementUsageReadAt, reading.readAt),
        ),
      ),
    )
    .returning({ id: whatsappAccounts.id });
  return updated.length > 0;
}

/**
 * Records the management usage a Graph response reported for the account (its own transaction in
 * the company's scope) and returns the end of the pause it sets, or null when it sets none.
 */
export async function noteManagementUsage(
  deps: { db: Database; clock: Clock },
  scope: TenantScope,
  account: { whatsappAccountId: string; wabaId: string },
  result: { usage?: BusinessUseCaseUsage },
): Promise<Date | null> {
  const reading = managementReading(result.usage, account.wabaId, deps.clock.now());
  if (!reading) return null;
  await deps.db.run(scope, (tx) => recordManagementUsage(tx, scope.tenantId, account, reading));
  return reading.pausedUntil;
}

/** The answer to a member's management action while the account is paused (an honest 503). */
export function managementPausedError(pausedUntil: Date, timeZone: string): AppError {
  return new AppError(
    'provider_unavailable',
    `Meta is limiting management requests for this WhatsApp account until ${formatCompanyTime(pausedUntil, timeZone)}. Try again after that.`,
    { details: { pausedUntil: pausedUntil.toISOString() } },
  );
}

/** Refuses a member's management action while the account is paused. */
export function assertManagementOpen(
  pausedUntil: Date | null | undefined,
  now: Date,
  timeZone: string,
): void {
  const until = activeManagementPause(pausedUntil, now);
  if (until) throw managementPausedError(until, timeZone);
}

/** The singleton key of the job a paused job queues for after the pause: `paused:<its job id>`. */
export function pausedJobKey(currentJobId: string): string {
  return `paused:${currentJobId}`;
}

/**
 * Queues a job again to run just after the pause ends, signed as before, and gives when it should
 * start by this worker's clock, or null when nothing was queued (the caller then fails the job, so
 * pg-boss retries it rather than the deferral being lost). Its singleton key is derived from the
 * deferring job's id (`pausedJobKey`): stable across retries of that job, so one deferral is queued
 * for it, and never the key the running job holds. The start is given to pg-boss as a delay in
 * seconds, which it adds to the database's own now, and is at least `MIN_DEFERRAL_SECONDS`: the
 * pause is judged on the worker's clock, so a worker behind the database that still sees the pause
 * when the deferred job starts defers it once more, by the time left on its own clock and at least
 * 30 seconds, never to a time the database already considers past (ADR-399).
 */
export async function deferPausedJob(
  deps: { jobs: JobQueue; signer: JobSigner; clock: Clock },
  queue: QueueName,
  job: { kind: string; tenantId: string; actorUserId: string | null; ref: string },
  pausedUntil: Date,
  currentJobId: string,
): Promise<Date | null> {
  const now = deps.clock.now();
  const delay = deferralDelaySeconds(pausedUntil, now);
  const queued = await deps.jobs.enqueue(null, queue, deps.signer.sign(job), {
    singletonKey: pausedJobKey(currentJobId),
    startAfter: delay,
  });
  return queued === null ? null : new Date(now.getTime() + delay * 1000);
}

/**
 * Whether a response is Meta refusing the call for now (`retryable`, such as a rate limit) while its
 * own header paused the account: such a call is deferred like the rest of the job, not counted as a
 * failure. A permanent or credential refusal stays a failure; a response that may have done its work
 * (`unknown`) is handled as before.
 */
export function refusedForPause(
  result: { ok: boolean; kind?: string },
  pausedUntil: Date | null,
): pausedUntil is Date {
  return pausedUntil !== null && result.ok === false && result.kind === 'retryable';
}

/** Thrown by a paced call made after a response paused the account; caught by `untilPaused`. */
export class ManagementPauseSignal extends Error {
  constructor(readonly until: Date) {
    super('Meta is limiting management requests for this WhatsApp account');
    this.name = 'ManagementPauseSignal';
  }
}

/**
 * Graph calls of one job for one account: each response's usage is recorded, and once a response
 * pauses the account the job's next call is not made (`ManagementPauseSignal`); a response refused
 * as retryable that itself paused the account signals at once, so the job defers instead of
 * spending a retry or recording a failure. The jobs' steps are
 * resumable, so the deferred job carries on from there after the pause.
 */
export function pacedManagementCalls(
  deps: { db: Database; clock: Clock },
  scope: TenantScope,
  account: { whatsappAccountId: string; wabaId: string },
) {
  let pausedUntil: Date | null = null;
  return async function call<R extends { ok: boolean; usage?: BusinessUseCaseUsage }>(
    request: () => Promise<R>,
  ): Promise<R> {
    if (pausedUntil) throw new ManagementPauseSignal(pausedUntil);
    const result = await request();
    pausedUntil = await noteManagementUsage(deps, scope, account, result);
    // Refused for now by the response that paused the account: deferred, not a failure.
    if (refusedForPause(result as { ok: boolean; kind?: string }, pausedUntil)) {
      throw new ManagementPauseSignal(pausedUntil);
    }
    return result;
  };
}

/** Runs a job's paced work; a pause it met becomes the job's `paused` outcome. */
export async function untilPaused<T>(work: () => Promise<T>): Promise<T | ManagementPaused> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ManagementPauseSignal) return { paused: error.until };
    throw error;
  }
}
