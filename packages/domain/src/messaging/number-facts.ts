import type { Clock, Keyring } from '@w360/core';
import {
  and,
  channelAccounts,
  eq,
  sql,
  whatsappAccounts,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { checkWhatsAppAccess, graphFailureText, type AccessCheckDeps } from './access';
import { credentialAad } from './credentials';
import { emitTenantEvent } from './events';
import type { GraphClient, GraphFailureKind, GraphResult } from './graph';
import {
  activeManagementPause,
  isManagementPaused,
  pacedManagementCalls,
  untilPaused,
} from './management-pace';
import { messagingLimitRefusalMetadata } from './messaging-limit';

/**
 * A WhatsApp number's facts from Meta (`GET /{phone-number-id}`): its display number, verified
 * name, quality rating, name status, code verification status and messaging limit. They are read
 * by one function (`readNumberFacts`) and stored by one (`numberFactsColumns`) both in the last
 * step of a number's setup and in the daily refresh of each active number (ADR-402), which runs
 * in the access check's job once Meta admits the account's token (ADR-137).
 */

type PhoneNumberRead = Awaited<ReturnType<GraphClient['getPhoneNumber']>>;
/** What Meta reports about a number, as `GraphClient.getPhoneNumber` parses it. */
export type PhoneNumberFacts = Extract<PhoneNumberRead, { ok: true }>['data'];
type Failure = Extract<GraphResult<never>, { ok: false }>;
/** The paced Graph calls of one job for one account (ADR-399). */
type ManagementCall = ReturnType<typeof pacedManagementCalls>;

/**
 * The read: `ok` with the facts, and the first read's refusal when the limit was refused and the
 * read without it succeeded (ADR-398); otherwise the failure of the last read made.
 */
export type NumberFactsRead =
  | { ok: true; facts: PhoneNumberFacts; limitRefusal: Failure | null }
  | { ok: false; failure: Failure };

/**
 * Reads a number's facts with the messaging limit field. Which node gives the limit is unconfirmed
 * (research M-059, M-199), and Graph may refuse a field in more than one way (code 100, 200, 3, or
 * 10, which HyFib reads as lost access), so a read that asked for it and was refused as permanent
 * or as lost access, whatever the code, is made once more without it; only when that read succeeds
 * are the facts given without a limit, with the refusal (ADR-398). Retryable and unknown failures
 * get no second read. Both reads are paced: when the first response paused the account the second
 * is not made (`call` throws `ManagementPauseSignal`), so ADR-398's rule applies whole after the
 * pause (ADR-399).
 */
export async function readNumberFacts(
  graph: Pick<GraphClient, 'getPhoneNumber'>,
  call: ManagementCall,
  phoneNumberId: string,
  token: string,
): Promise<NumberFactsRead> {
  const asked = await call(() => graph.getPhoneNumber(phoneNumberId, token));
  if (asked.ok) return { ok: true, facts: asked.data, limitRefusal: null };
  if (asked.kind !== 'permanent' && asked.kind !== 'auth') return { ok: false, failure: asked };
  const plain = await call(() =>
    graph.getPhoneNumber(phoneNumberId, token, { messagingLimit: false }),
  );
  return plain.ok
    ? { ok: true, facts: plain.data, limitRefusal: asked }
    : { ok: false, failure: plain };
}

/**
 * What a completed read stores on the number: its facts, and the time as both the health's and
 * the limit's check (a read without the limit after a refusal stores none, ADR-398). Never the
 * number's status.
 */
export function numberFactsColumns(facts: PhoneNumberFacts, checkedAt: Date) {
  return {
    displayPhoneNumber: facts.displayPhoneNumber,
    verifiedName: facts.verifiedName,
    qualityRating: facts.qualityRating,
    nameStatus: facts.nameStatus,
    codeVerificationStatus: facts.codeVerificationStatus,
    messagingLimit: facts.messagingLimit,
    messagingLimitCheckedAt: checkedAt,
    healthCheckedAt: checkedAt,
  } satisfies Partial<typeof channelAccounts.$inferInsert>;
}

/**
 * What Channels says under its numbers when one is active: when HyFib reads the facts it shows and
 * what "Checked" is (ADR-402).
 */
export const NUMBER_FACTS_NOTE =
  'HyFib reads each active number’s quality rating, messaging limit and name from Meta about once a day, with the daily check of its account’s access, but not while the account needs reconnecting or Meta is limiting management requests. “Checked” is when HyFib last read them; a name, display number or status Meta left out of that answer keeps the value from an earlier read.';

/**
 * What a refresh stores (ADR-402): as `numberFactsColumns`, except that a name, display number or
 * status Meta left out (or gave in a form HyFib does not keep, such as a display number longer than
 * its column) keeps the value stored before, so a partial answer does not wipe them each day; they
 * change rarely, and Channels says such a value may come from an earlier read. The quality rating
 * and the messaging limit are time-sensitive and are never kept: an answer without the rating
 * stores none (unknown), as setup does, and one without the limit stores "not reported by Meta"
 * (ADR-398), since an older value beside the new "Checked" time would show what Meta no longer
 * reported. `attemptedAt` is when the read started. Setup stores `numberFactsColumns` unchanged.
 */
export function refreshedFactsColumns(facts: PhoneNumberFacts, checkedAt: Date, attemptedAt: Date) {
  const columns: Partial<typeof channelAccounts.$inferInsert> = {
    qualityRating: facts.qualityRating,
    messagingLimit: facts.messagingLimit,
    messagingLimitCheckedAt: checkedAt,
    healthCheckedAt: checkedAt,
    factsAttemptedAt: attemptedAt,
  };
  for (const key of [
    'displayPhoneNumber',
    'verifiedName',
    'nameStatus',
    'codeVerificationStatus',
  ] as const) {
    const fact = facts[key];
    if (fact !== null) columns[key] = fact;
  }
  return columns;
}

/**
 * A number's facts are refreshed when they were last read this long ago or more, and a number is
 * tried again this long after its last refresh read, whatever its outcome. Shorter than the daily
 * access check's 24 hours, so every daily check refreshes them, and long enough that the other
 * checks (asked after a refused send, or every 30 minutes while a webhook subscription is not
 * confirmed) neither read them again nor retry a number whose reads fail.
 */
export const NUMBER_FACTS_REFRESH_AFTER_MS = 20 * 60 * 60_000;

/**
 * No number's read starts once the job has run this long: the access check's job expires after 120
 * seconds, and a number's two reads can take up to 60 (the worker's Graph timeout is 30 seconds).
 * Numbers left are the stalest at the next check, which reads them first.
 */
export const NUMBER_FACTS_BUDGET_MS = 40_000;

/**
 * Whether an active number's facts are due a refresh: never read, never asked for the limit (a
 * number set up before ADR-398), or last read `NUMBER_FACTS_REFRESH_AFTER_MS` ago or more; and
 * not tried by a refresh within that time (a number whose reads fail is tried once a window).
 */
export function numberFactsDue(
  number: {
    healthCheckedAt: Date | null;
    messagingLimitCheckedAt: Date | null;
    factsAttemptedAt: Date | null;
  },
  now: Date,
): boolean {
  const old = (at: Date | null) =>
    at === null || now.getTime() - at.getTime() >= NUMBER_FACTS_REFRESH_AFTER_MS;
  const stale = number.messagingLimitCheckedAt === null || old(number.healthCheckedAt);
  return stale && old(number.factsAttemptedAt);
}

/**
 * Whether a refresh that got the facts without the limit after Meta refused it is audited: only
 * when it changes what Channels shows, from a limit or from nothing (never asked) to "not reported
 * by Meta". A number already stored without a limit is not audited again each day.
 */
export function limitRefusalAuditDue(previous: {
  messagingLimit: string | null;
  messagingLimitCheckedAt: Date | null;
}): boolean {
  return previous.messagingLimitCheckedAt === null || previous.messagingLimit !== null;
}

export interface NumberFactsDeps {
  db: Database;
  keyring: Keyring;
  graph: Pick<GraphClient, 'getPhoneNumber'>;
  clock: Clock;
}

/**
 * One number's refresh: `refreshed` (its facts stored, `limitRefused` when without the limit after
 * a refusal); `failed` (Meta's answer was a failure: nothing stored but the attempt, the number and
 * its account unchanged, and `attemptError` when recording the attempt threw); `store_failed`
 * (storing the read threw: nothing stored, the error kept for the worker's log, and `attemptError`
 * when recording the attempt threw too); `skipped` (the number or its account changed during the read, or setup read
 * it more recently: nothing stored).
 */
export type NumberRefreshResult =
  | { channelAccountId: string; state: 'refreshed'; limitRefused: boolean }
  | {
      channelAccountId: string;
      state: 'failed';
      kind: GraphFailureKind;
      error: string;
      attemptError?: unknown;
    }
  | { channelAccountId: string; state: 'store_failed'; error: unknown; attemptError?: unknown }
  | { channelAccountId: string; state: 'skipped' };

/**
 * An account's refresh: `done` (each due number read, or the time ran out with `left` numbers
 * unread); `skipped` (the account is not connected); `paused` (Meta throttles the account's
 * management calls: no read is made, or none after the response that paused it; `left` are read by
 * the next check).
 */
export interface NumberFactsRefresh {
  outcome: 'done' | 'skipped' | 'paused';
  numbers: NumberRefreshResult[];
  left: number;
  pausedUntil?: Date;
}

/**
 * Refreshes the facts of an account's active numbers that are due (ADR-402), in the company's scope,
 * stalest first. A failure is the number's result only: it never changes the number's or the
 * account's status (losing access stays the access check's decision, ADR-137) and stores nothing
 * but the attempt, so "Checked" keeps the time of the last read that completed; a number whose
 * read could not be stored does not stop the others. `startedAt` is when the job started (for the
 * time budget).
 */
export async function refreshNumberFacts(
  deps: NumberFactsDeps,
  scope: TenantScope,
  whatsappAccountId: string,
  startedAt: Date = deps.clock.now(),
): Promise<NumberFactsRefresh> {
  const tenantId = scope.tenantId;
  const loaded = await deps.db.run(
    scope,
    async (tx) => {
      const [account] = await tx
        .select({
          wabaId: whatsappAccounts.wabaId,
          status: whatsappAccounts.status,
          credential: whatsappAccounts.credentialCiphertext,
          managementPausedUntil: whatsappAccounts.managementPausedUntil,
        })
        .from(whatsappAccounts)
        .where(
          and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, whatsappAccountId)),
        );
      if (!account) return null;
      const numbers = await tx
        .select({
          id: channelAccounts.id,
          phoneNumberId: channelAccounts.phoneNumberId,
          healthCheckedAt: channelAccounts.healthCheckedAt,
          messagingLimitCheckedAt: channelAccounts.messagingLimitCheckedAt,
          factsAttemptedAt: channelAccounts.factsAttemptedAt,
        })
        .from(channelAccounts)
        .where(
          and(
            eq(channelAccounts.tenantId, tenantId),
            eq(channelAccounts.whatsappAccountId, whatsappAccountId),
            eq(channelAccounts.status, 'active'),
          ),
        )
        .orderBy(sql`${channelAccounts.healthCheckedAt} asc nulls first`, channelAccounts.id);
      return { account, numbers };
    },
    { accessMode: 'read only' },
  );
  if (!loaded || loaded.account.status !== 'connected' || !loaded.account.credential) {
    return { outcome: 'skipped', numbers: [], left: 0 };
  }
  const now = deps.clock.now();
  const due = loaded.numbers.filter((n) => numberFactsDue(n, now));
  // While Meta throttles the account's management calls nothing is asked (ADR-399).
  const pausedUntil = activeManagementPause(loaded.account.managementPausedUntil, now);
  if (pausedUntil) return { outcome: 'paused', numbers: [], left: due.length, pausedUntil };
  if (due.length === 0) return { outcome: 'done', numbers: [], left: 0 };

  const token = deps.keyring.decryptString(
    loaded.account.credential,
    credentialAad(tenantId, whatsappAccountId),
  );
  const call = pacedManagementCalls(deps, scope, {
    whatsappAccountId,
    wabaId: loaded.account.wabaId,
  });
  const numbers: NumberRefreshResult[] = [];
  const ran = await untilPaused(async () => {
    for (const number of due) {
      if (deps.clock.now().getTime() - startedAt.getTime() >= NUMBER_FACTS_BUDGET_MS) return;
      const readAt = deps.clock.now();
      // A pause stops the loop here (`ManagementPauseSignal`), before anything is recorded.
      const read = await readNumberFacts(deps.graph, call, number.phoneNumberId, token);
      const target = { scope, whatsappAccountId, channelAccountId: number.id, readAt };
      try {
        numbers.push(await storeNumberFacts(deps, target, read));
      } catch (error) {
        // One number that cannot be stored never stops the others; its attempt is still recorded,
        // so it is not read first again at every check.
        const failed: NumberRefreshResult = {
          channelAccountId: number.id,
          state: 'store_failed',
          error,
        };
        try {
          await deps.db.run(scope, (tx) => recordAttempt(tx, target));
        } catch (attemptError) {
          failed.attemptError = attemptError;
        }
        numbers.push(failed);
      }
      // Recording an attempt failed: the database is most likely out of reach, so the next
      // numbers' reads would be thrown away unrecorded. They are left for the next check.
      const last = numbers[numbers.length - 1];
      if (last && 'attemptError' in last && last.attemptError !== undefined) return;
    }
  });
  const left = due.length - numbers.length;
  if (isManagementPaused(ran)) return { outcome: 'paused', numbers, left, pausedUntil: ran.paused };
  return { outcome: 'done', numbers, left };
}

interface RefreshTarget {
  scope: TenantScope;
  whatsappAccountId: string;
  channelAccountId: string;
  /** When the number's read started. */
  readAt: Date;
}

/** Records a refresh read of a number that is still active, whatever its outcome. */
async function recordAttempt(tx: Tx, target: RefreshTarget): Promise<void> {
  await tx
    .update(channelAccounts)
    .set({ factsAttemptedAt: target.readAt })
    .where(
      and(
        eq(channelAccounts.tenantId, target.scope.tenantId),
        eq(channelAccounts.id, target.channelAccountId),
        eq(channelAccounts.status, 'active'),
      ),
    );
}

/**
 * Stores one number's read, when the number is still active on the still connected account and
 * setup has not read it since this read started (a setup finishing meanwhile keeps its newer read).
 * A failed read stores only the attempt.
 */
async function storeNumberFacts(
  deps: NumberFactsDeps,
  target: RefreshTarget,
  read: NumberFactsRead,
): Promise<NumberRefreshResult> {
  const { scope, whatsappAccountId, channelAccountId, readAt } = target;
  if (!read.ok) {
    const failed: NumberRefreshResult = {
      channelAccountId,
      state: 'failed',
      kind: read.failure.kind,
      error: graphFailureText(read.failure),
    };
    try {
      await deps.db.run(scope, (tx) => recordAttempt(tx, target));
    } catch (attemptError) {
      // Meta's failure stays the number's result; the attempt's error goes with it.
      failed.attemptError = attemptError;
    }
    return failed;
  }
  const tenantId = scope.tenantId;
  const checkedAt = deps.clock.now();
  return deps.db.run(scope, async (tx) => {
    const where = and(
      eq(channelAccounts.tenantId, tenantId),
      eq(channelAccounts.id, channelAccountId),
    );
    // The number as it is now: a disconnection or a lost access during the read wins.
    const [current] = await tx
      .select({
        status: channelAccounts.status,
        whatsappAccountId: channelAccounts.whatsappAccountId,
        messagingLimit: channelAccounts.messagingLimit,
        messagingLimitCheckedAt: channelAccounts.messagingLimitCheckedAt,
        healthCheckedAt: channelAccounts.healthCheckedAt,
      })
      .from(channelAccounts)
      .where(where)
      .for('update');
    if (
      !current ||
      current.status !== 'active' ||
      current.whatsappAccountId !== whatsappAccountId ||
      (current.healthCheckedAt !== null && current.healthCheckedAt > readAt)
    ) {
      return { channelAccountId, state: 'skipped' as const };
    }
    const [account] = await tx
      .select({ status: whatsappAccounts.status })
      .from(whatsappAccounts)
      .where(
        and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, whatsappAccountId)),
      );
    if (account?.status !== 'connected') return { channelAccountId, state: 'skipped' as const };
    await tx
      .update(channelAccounts)
      .set(refreshedFactsColumns(read.facts, checkedAt, readAt))
      .where(where);
    if (read.limitRefusal && limitRefusalAuditDue(current)) {
      // Channels now says "not reported by Meta"; the audit says why, as ADR-398's does.
      await recordSystemAudit(tx, tenantId, {
        action: 'channel.messaging_limit_refused',
        subjectType: 'channel',
        subjectId: channelAccountId,
        result: 'failure',
        metadata: messagingLimitRefusalMetadata(read.limitRefusal),
      });
    }
    await emitTenantEvent(tx, tenantId, {
      type: 'channel.updated',
      payload: { channelAccountId },
    });
    return {
      channelAccountId,
      state: 'refreshed' as const,
      limitRefused: read.limitRefusal !== null,
    };
  });
}

/**
 * The access check's job (ADR-137, ADR-138), then, once Meta admits the token (`healthy`), the
 * refresh of the account's active numbers' facts in the same job (ADR-402). The refresh never
 * changes the access check's outcome, which is stored before it starts; an error it throws (the
 * database) is given back as `numbersError` for the worker to log, so the job is not retried for it
 * (a retry would ask Meta for the access again) and the next check refreshes the numbers.
 */
export async function checkAccessAndRefreshNumbers(
  deps: AccessCheckDeps,
  scope: TenantScope,
  whatsappAccountId: string,
): Promise<{
  access: Awaited<ReturnType<typeof checkWhatsAppAccess>>;
  numbers: NumberFactsRefresh | null;
  numbersError?: unknown;
}> {
  const startedAt = deps.clock.now();
  const access = await checkWhatsAppAccess(deps, scope, whatsappAccountId);
  if (access.outcome !== 'healthy') return { access, numbers: null };
  try {
    return { access, numbers: await refreshNumberFacts(deps, scope, whatsappAccountId, startedAt) };
  } catch (error) {
    return { access, numbers: null, numbersError: error };
  }
}
