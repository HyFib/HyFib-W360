import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { forbidden, notFound, uuidv7, type Clock } from '@w360/core';
import { ALL_QUEUES, queueMaxWaitMinutes } from '@w360/contracts';
import {
  and,
  channelAccounts,
  deadLetters,
  desc,
  emailOutbox,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  platformAdmins,
  platformAlerts,
  platformAuditEvents,
  queueWaits,
  securityEvents,
  sql,
  tenants,
  usageCounters,
  users,
  webhookQuarantine,
  webhookReceipts,
  type Tx,
} from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { keyringOverview, parseSealedValueCounts, type KeyringOverview } from '../keyring/reseal';
import {
  jobSigningOverview,
  parseJobSigningKeyCounts,
  type JobSigningOverview,
} from '../jobs/resign';
import { MAX_RECEIPT_ATTEMPTS } from '../messaging/receipts';
import type { QueueInspector, QueueSnapshot } from '../jobs/queue';
import { QUEUE_CHECK_FRESH_MINUTES } from './queue-waits';
import { deadLetterRetryBlock, deadLetterRetryableUntil } from './dead-letter-retries';
import { parseInput } from '../validation';
import {
  OPS_SIGNAL_RULES,
  OPS_WINDOWS,
  healthIssues,
  healthLevel,
  quarantineExternalIds,
  signalFlags,
  byHealth,
  deadLettersCsv,
  emailsCsv,
  failuresCsv,
  healthCsv,
  newCompaniesCsv,
  numberSetupsCsv,
  opsCsvFilename,
  opsExportAction,
  quarantineCsv,
  queuesCsv,
  receiptsCsv,
  signalsCsv,
  signupsCsv,
  usageCsv,
  type CompanyActivity,
  type CompanyHealth,
  type CompanyHealthFacts,
  type CompanySignals,
  type CompanyUsage,
  type CompanyWithoutNumber,
  type EmailDeliveryCount,
  type IntegrationFailure,
  type NumberSetupProblem,
  type OpsExportList,
  type QueueRow,
  type QueueWait,
  type ReceiptNeedingAttention,
  type ReceiptProblem,
  type SignupProblem,
} from './ops-model';
import type { PlatformActor } from './service';

/**
 * The platform operations console (ADR-054). Reads counts, states, codes, labels and times through
 * narrow definer functions and the few ops tables platform staff could already read; never
 * message content, contact details, payloads, email addresses, secrets or full URLs. The two
 * repairs (retrying a webhook receipt, resolving a quarantine entry) are written to the platform
 * audit log in the same transaction.
 */
export interface PlatformOpsDeps {
  platformDb: PlatformDatabase;
  queues: QueueInspector;
  clock: Clock;
  /** The configured encryption key ids (ADR-134); never the keys. */
  keyring: { readonly currentKeyId: string; readonly keyIds: readonly string[] };
  /** The configured job signing key ids (ADR-135); never the keys. */
  jobSigning: {
    readonly keyId: string;
    readonly nextKeyId: string | null;
    readonly previousKeyId: string | null;
  };
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Webhook bodies are erased 7 days after they were received (ops.apply_webhook_retention). */
const RECEIPT_BODY_DAYS = 7;
export const USAGE_WINDOWS = [7, 30, 90] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];
/**
 * The windows the Usage tab compares with the window before (ADR-157): twice 90 days is beyond the
 * 93 days the activity function reads back.
 */
export const USAGE_COMPARED_WINDOWS: readonly UsageWindow[] = [7, 30];

type Row = Record<string, unknown>;
const num = (value: unknown) => Number(value ?? 0);
// A timestamp the definer functions return: drizzle hands raw query results over as PostgreSQL's
// text, which a Date parses (the driver gives Dates only to typed selects).
const date = (value: unknown) =>
  value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
const text = (value: unknown) => (typeof value === 'string' ? value : null);

function toHealthFacts(r: Row): CompanyHealthFacts {
  return {
    tenantId: String(r.tenant_id),
    name: String(r.tenant_name),
    slug: String(r.tenant_slug),
    status: String(r.tenant_status),
    createdAt: date(r.created_at) ?? new Date(0),
    planStatus: text(r.plan_status),
    numbersTotal: num(r.numbers_total),
    numbersActive: num(r.numbers_active),
    numbersReconnect: num(r.numbers_reconnect),
    numbersFailed: num(r.numbers_failed),
    qualityRating: text(r.quality_rating),
    qualityCheckedAt: date(r.quality_checked_at),
    accountsReconnect: num(r.accounts_reconnect),
    outbound24h: num(r.outbound_24h),
    failed24h: num(r.failed_24h),
    inbound24h: num(r.inbound_24h),
    lastMessageAt: date(r.last_message_at),
    endpointsFailing: num(r.endpoints_failing),
    endpointsAutoDisabled: num(r.endpoints_auto_disabled),
    storesFailed: num(r.stores_failed),
    paymentAccountsFailed: num(r.payment_accounts_failed),
    catalogSyncsFailed: num(r.catalog_syncs_failed),
    flowSyncsFailed: num(r.flow_syncs_failed),
    deadLetters7d: num(r.dead_letters_7d),
  };
}

function toActivity(r: Row): CompanyActivity {
  return {
    tenantId: String(r.tenant_id),
    name: String(r.tenant_name),
    slug: String(r.tenant_slug),
    status: String(r.tenant_status),
    outbound: num(r.outbound),
    outboundBySender: {
      agent: num(r.outbound_agent),
      bot: num(r.outbound_bot),
      campaign: num(r.outbound_campaign),
      api: num(r.outbound_api),
      system: num(r.outbound_system),
    },
    failed: num(r.failed),
    inbound: num(r.inbound),
    marketingSent: num(r.marketing_sent),
    marketingDelivered: num(r.marketing_delivered),
    error131049: num(r.error_131049),
    error131050: num(r.error_131050),
    marketingOptOuts: num(r.marketing_opt_outs),
    complaints: num(r.complaints),
    webhookDeliveries: num(r.webhook_deliveries),
    automationRuns: num(r.automation_runs),
    runsPeriodStart: date(r.runs_period_start),
    members: num(r.members),
    numbers: num(r.numbers),
  };
}

async function healthFacts(tx: Tx, tenantId: string | null): Promise<CompanyHealthFacts[]> {
  const result = await tx.execute<Row>(
    sql`select * from ops.platform_ops_health(${tenantId}::uuid)`,
  );
  return result.rows.map(toHealthFacts);
}

async function activitySince(
  tx: Tx,
  since: Date,
  tenantId: string | null,
): Promise<CompanyActivity[]> {
  const result = await tx.execute<Row>(
    sql`select * from ops.platform_ops_activity(${since.toISOString()}::timestamptz, ${tenantId}::uuid)`,
  );
  return result.rows.map(toActivity);
}

/**
 * Each company's latest API request counter (ADR-153): the plan counts every request its keys make
 * (ADR-061), one row per company and usage period, which the platform role reads (0023's policy).
 */
async function latestApiRequests(
  tx: Tx,
): Promise<Map<string, { used: number; periodStart: Date }>> {
  const counters = await tx
    .selectDistinctOn([usageCounters.tenantId], {
      tenantId: usageCounters.tenantId,
      used: usageCounters.used,
      periodStart: usageCounters.periodStart,
    })
    .from(usageCounters)
    .where(eq(usageCounters.metric, 'api_requests'))
    .orderBy(usageCounters.tenantId, desc(usageCounters.periodStart));
  return new Map(counters.map((c) => [c.tenantId, { used: c.used, periodStart: c.periodStart }]));
}

/**
 * Each company's activity over a window with its plan's API request counter (ADR-153) and, for the
 * 7- and 30-day windows, its sending and receipts in the window before (ADR-157). The window before
 * is the activity since twice as far back less the window's, both read in one statement: the
 * function is STABLE, so both calls see the statement's snapshot and the difference is exact.
 */
async function usageRows(tx: Tx, window: UsageWindow, now: Date): Promise<CompanyUsage[]> {
  const since = new Date(now.getTime() - window * DAY_MS);
  const api = await latestApiRequests(tx);
  const withApi = (a: CompanyActivity, previous: CompanyUsage['previous']): CompanyUsage => ({
    ...a,
    apiRequests: api.get(a.tenantId)?.used ?? 0,
    apiPeriodStart: api.get(a.tenantId)?.periodStart ?? null,
    previous,
  });
  if (!USAGE_COMPARED_WINDOWS.includes(window)) {
    return (await activitySince(tx, since, null)).map((a) => withApi(a, null));
  }
  const before = new Date(now.getTime() - 2 * window * DAY_MS);
  const result = await tx.execute<Row>(sql`
    select w.*, b.outbound as outbound_since_before, b.inbound as inbound_since_before
      from ops.platform_ops_activity(${since.toISOString()}::timestamptz, null::uuid) w
      join ops.platform_ops_activity(${before.toISOString()}::timestamptz, null::uuid) b
        on b.tenant_id = w.tenant_id
     order by w.outbound desc, w.tenant_name, w.tenant_id`);
  return result.rows.map((r) => {
    const a = toActivity(r);
    return withApi(a, {
      outbound: num(r.outbound_since_before) - a.outbound,
      inbound: num(r.inbound_since_before) - a.inbound,
    });
  });
}

const usageWindow = (days: number): UsageWindow =>
  (USAGE_WINDOWS as readonly number[]).includes(days) ? (days as UsageWindow) : 30;

function assess(facts: CompanyHealthFacts): CompanyHealth {
  const issues = healthIssues(facts);
  return { facts, issues, level: healthLevel(issues) };
}

/**
 * The Signals tab's lines (ADR-054): each company with a signal or sending in the window, the most
 * signals first, then the most sent, then by name.
 */
async function signalRows(tx: Tx, since: Date): Promise<CompanySignals[]> {
  const activity = await activitySince(tx, since, null);
  const quality = new Map(
    (await healthFacts(tx, null)).map((f) => [f.tenantId, f.qualityRating] as const),
  );
  return activity
    .map((a) => {
      const rating = quality.get(a.tenantId) ?? null;
      return { activity: a, quality: rating, flags: signalFlags(a, rating) };
    })
    .filter((r) => r.flags.length > 0 || r.activity.outbound > 0 || r.activity.marketingOptOuts > 0)
    .sort(
      (a, b) =>
        b.flags.length - a.flags.length ||
        b.activity.outbound - a.activity.outbound ||
        a.activity.name.localeCompare(b.activity.name),
    );
}

export interface EventCount {
  type: string;
  provider: string | null;
  severity: string;
  last24h: number;
  last7d: number;
}

async function securityEventCounts(tx: Tx, now: Date): Promise<EventCount[]> {
  const since7d = new Date(now.getTime() - 7 * DAY_MS);
  const since24h = new Date(now.getTime() - DAY_MS);
  // Only the provider name from the details (it names which signature failed); nothing else.
  const provider = sql<
    string | null
  >`case when ${securityEvents.details}->>'provider' ~ '^[a-z_]{1,40}$'
    then ${securityEvents.details}->>'provider' end`;
  const rows = await tx
    .select({
      type: securityEvents.eventType,
      provider,
      severity: securityEvents.severity,
      last24h: sql<number>`count(*) filter (where ${securityEvents.occurredAt} >= ${since24h})::int`,
      last7d: sql<number>`count(*)::int`,
    })
    .from(securityEvents)
    .where(gte(securityEvents.occurredAt, since7d))
    .groupBy(securityEvents.eventType, provider, securityEvents.severity)
    .orderBy(securityEvents.eventType);
  return rows.map((r) => ({ ...r, last24h: num(r.last24h), last7d: num(r.last7d) }));
}

const retrySchema = z.object({
  receiptId: z.uuid(),
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(2000),
});

const deadLetterRetrySchema = z.object({
  deadLetterId: z.uuid(),
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(2000),
});

/**
 * A late queue the console lists, named by the time it fell behind as the page shows it, and what
 * the administrator noted about it (ADR-177).
 */
const lateQueueAcknowledgeSchema = z.object({
  queue: z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/, 'Choose a queue from the list'),
  lateSince: z.iso.datetime({ offset: true, message: 'Reload the page and try again' }),
  note: z
    .string()
    .trim()
    .min(10, 'Write a note of at least 10 characters')
    .max(500, 'Write a note of at most 500 characters'),
});

/** A dead letter the console lists and what the administrator noted about it (ADR-169). */
const deadLetterAcknowledgeSchema = z.object({
  deadLetterId: z.uuid(),
  note: z
    .string()
    .trim()
    .min(10, 'Write a note of at least 10 characters')
    .max(500, 'Write a note of at most 500 characters'),
});

/** The administrator who acknowledged a dead letter, beside the one who retried it. */
const acknowledgers = alias(users, 'acknowledgers');

/** A failure the console lists, by its integration and state, and what the administrator noted. */
const acknowledgeSchema = z.object({
  source: z.string().trim().min(1).max(40),
  subjectId: z.uuid(),
  state: z.string().trim().min(1).max(40),
  note: z
    .string()
    .trim()
    .min(10, 'Write a note of at least 10 characters')
    .max(500, 'Write a note of at most 500 characters'),
});

const resolveSchema = z.object({
  quarantineId: z.uuid(),
  resolution: z
    .string()
    .trim()
    .min(10, 'Describe the resolution in at least 10 characters')
    .max(1000),
});

export function createPlatformOpsService(deps: PlatformOpsDeps) {
  const { platformDb, queues: inspector, clock } = deps;

  async function receiptsNeedingAttention(tx: Tx, now: Date): Promise<ReceiptNeedingAttention[]> {
    const waitingBefore = new Date(now.getTime() - OPS_WINDOWS.stuckReceiptMinutes * MINUTE_MS);
    // One rule for a receipt that used all its attempts, shared with the alerts and the retry
    // (migration 0068): failed its last attempt, or its worker stopped during it.
    const exhausted = sql<boolean>`ops.webhook_receipt_exhausted(${webhookReceipts.status}, ${webhookReceipts.attempts}, ${webhookReceipts.leaseUntil})`;
    const rows = await tx
      .select({
        id: webhookReceipts.id,
        provider: webhookReceipts.provider,
        receivedAt: webhookReceipts.receivedAt,
        status: webhookReceipts.status,
        attempts: webhookReceipts.attempts,
        lastError: webhookReceipts.lastError,
        exhausted,
        alertedAt: webhookReceipts.exhaustedAlertedAt,
      })
      .from(webhookReceipts)
      .where(
        or(
          and(
            inArray(webhookReceipts.status, ['failed', 'processing']),
            gte(webhookReceipts.attempts, MAX_RECEIPT_ATTEMPTS),
            exhausted,
          ),
          and(
            inArray(webhookReceipts.status, ['pending', 'processing', 'failed']),
            lt(webhookReceipts.attempts, MAX_RECEIPT_ATTEMPTS),
            lt(webhookReceipts.receivedAt, waitingBefore),
          ),
        ),
      )
      .orderBy(desc(webhookReceipts.receivedAt))
      .limit(100);
    const bodyKeptAfter = now.getTime() - RECEIPT_BODY_DAYS * DAY_MS;
    return rows.map(({ exhausted: usedUp, ...r }) => {
      const problem: ReceiptProblem = usedUp ? 'exhausted' : 'waiting';
      return {
        ...r,
        problem,
        retryable: problem === 'exhausted' && r.receivedAt.getTime() > bodyKeptAfter,
      };
    });
  }

  async function integrationFailures(tx: Tx, limit: number): Promise<IntegrationFailure[]> {
    const result = await tx.execute<Row>(
      sql`select * from ops.platform_ops_integration_failures(${limit})`,
    );
    return result.rows.map((r) => {
      const acknowledgedAt = date(r.acknowledged_at);
      return {
        tenantId: String(r.tenant_id),
        tenantName: String(r.tenant_name),
        tenantSlug: String(r.tenant_slug),
        source: String(r.source),
        subjectId: String(r.subject_id),
        label: text(r.label),
        state: String(r.state),
        error: text(r.error),
        since: date(r.since),
        acknowledgement: acknowledgedAt
          ? {
              at: acknowledgedAt,
              byName: text(r.acknowledged_by_name),
              note: String(r.acknowledgement),
            }
          : null,
      };
    });
  }

  /**
   * The last check of each queue's waits, by queue (ADR-096), with the acknowledgement of a late
   * queue and the name of the administrator who made it (ADR-177).
   */
  async function queueWaitsByName(tx: Tx): Promise<Map<string, QueueWait>> {
    const rows = await tx
      .select({
        queue: queueWaits.queue,
        waiting: queueWaits.waiting,
        oldestWaitingSince: queueWaits.oldestWaitingSince,
        limitMinutes: queueWaits.limitMinutes,
        lateSince: queueWaits.lateSince,
        alertedAt: queueWaits.alertedAt,
        checkedAt: queueWaits.checkedAt,
        acknowledgedAt: queueWaits.acknowledgedAt,
        acknowledgedByName: acknowledgers.name,
        acknowledgement: queueWaits.acknowledgement,
      })
      .from(queueWaits)
      .leftJoin(acknowledgers, eq(acknowledgers.id, queueWaits.acknowledgedByUserId));
    return new Map(
      rows.map((r) => [
        r.queue,
        {
          waiting: r.waiting,
          oldestWaitingSince: r.oldestWaitingSince,
          oldestWaitMs: r.oldestWaitingSince
            ? r.checkedAt.getTime() - r.oldestWaitingSince.getTime()
            : null,
          limitMinutes: r.limitMinutes,
          lateSince: r.lateSince,
          alertedAt: r.alertedAt,
          checkedAt: r.checkedAt,
          acknowledgement:
            r.acknowledgedAt && r.acknowledgement
              ? { at: r.acknowledgedAt, byName: r.acknowledgedByName, note: r.acknowledgement }
              : null,
        },
      ]),
    );
  }

  /** When the worker last checked the declared queues, and whether that check is still fresh. */
  function queueCheck(waits: Map<string, QueueWait>, now: Date) {
    const times = ALL_QUEUES.map((q) => waits.get(q.name)?.checkedAt.getTime()).filter(
      (t): t is number => t !== undefined,
    );
    const checkedAt = times.length > 0 ? new Date(Math.max(...times)) : null;
    const fresh =
      checkedAt !== null &&
      now.getTime() - checkedAt.getTime() <= QUEUE_CHECK_FRESH_MINUTES * MINUTE_MS;
    const late = ALL_QUEUES.filter((q) => waits.get(q.name)?.lateSince).length;
    return { checkedAt, fresh, late };
  }

  async function deadLetterCountsByQueue(tx: Tx, now: Date) {
    const since24h = new Date(now.getTime() - DAY_MS);
    const since7d = new Date(now.getTime() - OPS_WINDOWS.deadLetterDays * DAY_MS);
    const rows = await tx
      .select({
        queue: deadLetters.sourceQueue,
        last24h: sql<number>`count(*) filter (where ${deadLetters.failedAt} >= ${since24h})::int`,
        last7d: sql<number>`count(*)::int`,
      })
      .from(deadLetters)
      .where(gte(deadLetters.failedAt, since7d))
      .groupBy(deadLetters.sourceQueue);
    return new Map(rows.map((r) => [r.queue, { last24h: num(r.last24h), last7d: num(r.last7d) }]));
  }

  /** Embedded Signup sessions since a time that failed or were abandoned, newest first. */
  async function signupProblems(tx: Tx, since: Date, now: Date): Promise<SignupProblem[]> {
    const sessions = await tx.execute<Row>(
      sql`select * from ops.platform_ops_signup_sessions(${since.toISOString()}::timestamptz, 200)`,
    );
    return sessions.rows.map((r) => ({
      tenantId: String(r.tenant_id),
      tenantName: String(r.tenant_name),
      tenantSlug: String(r.tenant_slug),
      sessionId: String(r.session_id),
      outcome: String(r.outcome) as 'failed' | 'abandoned',
      failureReason: text(r.failure_reason),
      startedAt: date(r.started_at) ?? now,
      hasActiveNumber: r.has_active_number === true,
    }));
  }

  /** Number setups that failed, or have run for over `stuckSetupMinutes`, latest change first. */
  async function numberSetupProblems(tx: Tx, now: Date): Promise<NumberSetupProblem[]> {
    const stuckBefore = new Date(now.getTime() - OPS_WINDOWS.stuckSetupMinutes * MINUTE_MS);
    const numbers = await tx
      .select({
        id: channelAccounts.id,
        tenantId: channelAccounts.tenantId,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        phone: channelAccounts.displayPhoneNumber,
        phoneNumberId: channelAccounts.phoneNumberId,
        status: channelAccounts.status,
        step: channelAccounts.onboardingStep,
        error: channelAccounts.onboardingError,
        createdAt: channelAccounts.createdAt,
        updatedAt: channelAccounts.updatedAt,
      })
      .from(channelAccounts)
      .innerJoin(tenants, eq(tenants.id, channelAccounts.tenantId))
      .where(
        and(
          sql`${tenants.status} <> 'deleted'`,
          or(
            eq(channelAccounts.status, 'failed'),
            and(
              eq(channelAccounts.status, 'onboarding'),
              lt(channelAccounts.createdAt, stuckBefore),
            ),
          ),
        ),
      )
      .orderBy(desc(channelAccounts.updatedAt))
      .limit(200);
    return numbers.map((n) => ({ ...n, stuck: n.status === 'onboarding' }));
  }

  /** Companies created since a time, newest first, with whether each has an active number. */
  async function companiesCreatedSince(
    tx: Tx,
    since: Date,
  ): Promise<(CompanyWithoutNumber & { active: boolean })[]> {
    return tx
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        status: tenants.status,
        createdAt: tenants.createdAt,
        // The company by its table's name: in a select from one table, drizzle writes the columns
        // of SQL fields without their table, so `${tenants.id}` here would read the number's own id.
        active: sql<boolean>`exists (select 1 from ${channelAccounts} c
          where c.tenant_id = ${tenants}.id and c.status = 'active')`,
        inProgress: sql<boolean>`exists (select 1 from ${channelAccounts} c
          where c.tenant_id = ${tenants}.id and c.status = 'onboarding')`,
      })
      .from(tenants)
      .where(and(gte(tenants.createdAt, since), sql`${tenants.status} <> 'deleted'`))
      .orderBy(desc(tenants.createdAt))
      .limit(500);
  }

  /** Open quarantine entries, newest first, with the provider ids staff may see. */
  async function openQuarantine(tx: Tx, now: Date) {
    const quarantine = await tx
      .select({
        id: webhookQuarantine.id,
        receiptId: webhookQuarantine.receiptId,
        provider: webhookQuarantine.provider,
        reason: webhookQuarantine.reason,
        externalIds: webhookQuarantine.externalIds,
        createdAt: webhookQuarantine.createdAt,
        alertedAt: webhookQuarantine.alertedAt,
        receiptStatus: webhookReceipts.status,
        receivedAt: webhookReceipts.receivedAt,
      })
      .from(webhookQuarantine)
      .innerJoin(webhookReceipts, eq(webhookReceipts.id, webhookQuarantine.receiptId))
      .where(isNull(webhookQuarantine.resolvedAt))
      .orderBy(desc(webhookQuarantine.createdAt))
      .limit(100);
    const bodyKeptAfter = now.getTime() - RECEIPT_BODY_DAYS * DAY_MS;
    return quarantine.map((q) => ({
      ...q,
      externalIds: quarantineExternalIds(q.externalIds),
      retryable: q.receiptStatus === 'quarantined' && q.receivedAt.getTime() > bodyKeptAfter,
    }));
  }

  /** Failed and waiting emails by kind over `emailDays`; counts only. */
  async function emailDelivery(tx: Tx, now: Date): Promise<EmailDeliveryCount[]> {
    const since = new Date(now.getTime() - OPS_WINDOWS.emailDays * DAY_MS);
    const stuckBefore = new Date(now.getTime() - 15 * MINUTE_MS);
    // Counts only: an SMTP error can quote the address it refused.
    const emails = await tx
      .select({
        kind: emailOutbox.kind,
        failed: sql<number>`count(*) filter (where ${emailOutbox.status} = 'failed')::int`,
        stuck: sql<number>`count(*) filter (where ${emailOutbox.status} in ('pending', 'sending')
          and ${emailOutbox.nextAttemptAt} < ${stuckBefore})::int`,
      })
      .from(emailOutbox)
      .where(gte(emailOutbox.createdAt, since))
      .groupBy(emailOutbox.kind)
      .orderBy(emailOutbox.kind);
    return emails
      .map((e) => ({ kind: e.kind, failed: num(e.failed), stuck: num(e.stuck) }))
      .filter((e) => e.failed > 0 || e.stuck > 0);
  }

  /**
   * Every declared queue with its policy, pg-boss's counts, its dead letters and its wait at the
   * last check, then any queue this release does not declare that has dead letters.
   */
  async function queueRows(
    tx: Tx,
    now: Date,
    snapshot: QueueSnapshot[],
    waits: Map<string, QueueWait>,
  ): Promise<QueueRow[]> {
    const byName = new Map<string, QueueSnapshot>(snapshot.map((q) => [q.name, q]));
    const counts = await deadLetterCountsByQueue(tx, now);
    const known = new Set(ALL_QUEUES.map((q) => q.name));
    const rows: QueueRow[] = ALL_QUEUES.map((definition) => ({
      name: definition.name,
      policy: {
        retryLimit: definition.retryLimit,
        hasDeadLetter: Boolean(definition.deadLetter),
        maxWaitMinutes: queueMaxWaitMinutes(definition),
      },
      counts: byName.get(definition.name) ?? null,
      deadLetters: counts.get(definition.name) ?? { last24h: 0, last7d: 0 },
      wait: waits.get(definition.name) ?? null,
    }));
    // Dead letters from a queue this release does not declare still show, with no policy.
    for (const [name, c] of counts) {
      if (!known.has(name)) {
        rows.push({
          name,
          policy: null,
          counts: byName.get(name) ?? null,
          deadLetters: c,
          wait: null,
        });
      }
    }
    return rows;
  }

  /** The latest dead letters with what keeps each from a retry (ADR-108). */
  async function recentDeadLetters(tx: Tx, now: Date) {
    const recent = await tx
      .select({
        id: deadLetters.id,
        sourceQueue: deadLetters.sourceQueue,
        sourceJobId: deadLetters.sourceJobId,
        kind: deadLetters.kind,
        tenantId: deadLetters.tenantId,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        ref: deadLetters.ref,
        verified: deadLetters.verified,
        retries: deadLetters.retries,
        errorName: deadLetters.errorName,
        errorCode: deadLetters.errorCode,
        firstQueuedAt: deadLetters.firstQueuedAt,
        failedAt: deadLetters.failedAt,
        alertedAt: deadLetters.alertedAt,
        tenantStatus: tenants.status,
        retriedAt: deadLetters.retriedAt,
        retriedByName: users.name,
        settledAt: deadLetters.settledAt,
        settledEnded: deadLetters.settledEnded,
        acknowledgedAt: deadLetters.acknowledgedAt,
        acknowledgedByName: acknowledgers.name,
        acknowledgement: deadLetters.acknowledgement,
      })
      .from(deadLetters)
      .leftJoin(tenants, eq(tenants.id, deadLetters.tenantId))
      .leftJoin(users, eq(users.id, deadLetters.retriedByUserId))
      .leftJoin(acknowledgers, eq(acknowledgers.id, deadLetters.acknowledgedByUserId))
      .orderBy(desc(deadLetters.failedAt))
      .limit(100);
    return recent.map((d) => {
      const retryBlock = deadLetterRetryBlock(d, now);
      return {
        ...d,
        retryableUntil: deadLetterRetryableUntil(d.sourceQueue, d.failedAt),
        retryBlock,
        retryable: retryBlock === null,
      };
    });
  }

  /**
   * One of the console's lists as a CSV body, read in the caller's transaction with the tab's own
   * read: the Usage tab over its window (ADR-154), every company's health worst first or the Signals
   * tab (ADR-155), and the lists of the Onboarding, Integrations and Queues tabs (ADR-158). Lines
   * per company count as companies, other lines as rows.
   */
  async function exportFile(
    tx: Tx,
    list: OpsExportList,
    days: number,
    now: Date,
  ): Promise<{ window?: number; counted: { companies: number } | { rows: number }; body: string }> {
    const onboardingSince = new Date(now.getTime() - OPS_WINDOWS.onboardingDays * DAY_MS);
    switch (list) {
      case 'usage': {
        const window = usageWindow(days);
        const rows = await usageRows(tx, window, now);
        return { window, counted: { companies: rows.length }, body: usageCsv(rows) };
      }
      case 'health': {
        const rows = (await healthFacts(tx, null)).map(assess).sort(byHealth);
        return { counted: { companies: rows.length }, body: healthCsv(rows) };
      }
      case 'signals': {
        const window = OPS_SIGNAL_RULES.windowDays;
        const rows = await signalRows(tx, new Date(now.getTime() - window * DAY_MS));
        return { window, counted: { companies: rows.length }, body: signalsCsv(rows) };
      }
      case 'signups': {
        const rows = await signupProblems(tx, onboardingSince, now);
        return {
          window: OPS_WINDOWS.onboardingDays,
          counted: { rows: rows.length },
          body: signupsCsv(rows),
        };
      }
      case 'number-setups': {
        const rows = await numberSetupProblems(tx, now);
        return { counted: { rows: rows.length }, body: numberSetupsCsv(rows) };
      }
      case 'new-companies': {
        const rows = (await companiesCreatedSince(tx, onboardingSince)).filter((c) => !c.active);
        return {
          window: OPS_WINDOWS.onboardingDays,
          counted: { companies: rows.length },
          body: newCompaniesCsv(rows),
        };
      }
      case 'failures': {
        const rows = await integrationFailures(tx, 500);
        return { counted: { rows: rows.length }, body: failuresCsv(rows) };
      }
      case 'receipts': {
        const rows = await receiptsNeedingAttention(tx, now);
        return { counted: { rows: rows.length }, body: receiptsCsv(rows) };
      }
      case 'quarantine': {
        const rows = await openQuarantine(tx, now);
        return { counted: { rows: rows.length }, body: quarantineCsv(rows) };
      }
      case 'emails': {
        const rows = await emailDelivery(tx, now);
        return {
          window: OPS_WINDOWS.emailDays,
          counted: { rows: rows.length },
          body: emailsCsv(rows),
        };
      }
      case 'queues': {
        // pg-boss's counts, as the Queues tab reads them (through pg-boss's own connection).
        const snapshot = await inspector.snapshot();
        const rows = await queueRows(tx, now, snapshot, await queueWaitsByName(tx));
        return { counted: { rows: rows.length }, body: queuesCsv(rows) };
      }
      case 'dead-letters': {
        const rows = await recentDeadLetters(tx, now);
        return { counted: { rows: rows.length }, body: deadLettersCsv(rows) };
      }
    }
  }

  return {
    /** Totals and the companies needing attention, most severe first. */
    async overview(actor: PlatformActor) {
      const now = clock.now();
      const snapshot = await inspector.snapshot();
      const data = await platformDb.run(actor.userId, async (tx) => {
        const companies = (await healthFacts(tx, null)).map(assess);
        const failures = await integrationFailures(tx, 1000);
        const receipts = await receiptsNeedingAttention(tx, now);
        const [openQuarantine] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(webhookQuarantine)
          .where(isNull(webhookQuarantine.resolvedAt));
        const deadLetterCounts = await deadLetterCountsByQueue(tx, now);
        const queueWaitCheck = queueCheck(await queueWaitsByName(tx), now);
        const signups = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from ops.platform_ops_signup_sessions(${new Date(
            now.getTime() - 7 * DAY_MS,
          ).toISOString()}::timestamptz, 500)`,
        );
        return {
          companies,
          failures: failures.length,
          receipts: receipts.length,
          openQuarantine: num(openQuarantine?.n),
          deadLetters24h: [...deadLetterCounts.values()].reduce((s, c) => s + c.last24h, 0),
          deadLetters7d: [...deadLetterCounts.values()].reduce((s, c) => s + c.last7d, 0),
          failedSignups7d: num(signups.rows[0]?.n),
          queueWaitCheck,
        };
      });
      const attention = data.companies.filter((c) => c.level !== 'ok').sort(byHealth);
      return {
        companies: data.companies.length,
        activeCompanies: data.companies.filter((c) => c.facts.status === 'active').length,
        critical: attention.filter((c) => c.level === 'critical').length,
        warning: attention.filter((c) => c.level === 'warning').length,
        attention,
        integrationFailures: data.failures,
        receiptsNeedingAttention: data.receipts,
        openQuarantine: data.openQuarantine,
        deadLetters24h: data.deadLetters24h,
        deadLetters7d: data.deadLetters7d,
        failedSignups7d: data.failedSignups7d,
        readyJobs: snapshot.reduce((s, q) => s + q.ready, 0),
        failedJobs: snapshot.reduce((s, q) => s + q.failed, 0),
        /** Queues late at the worker's last check, and when that was (ADR-096). */
        lateQueues: data.queueWaitCheck.late,
        queuesCheckedAt: data.queueWaitCheck.checkedAt,
        queueCheckFresh: data.queueWaitCheck.fresh,
      };
    },

    /** One company's health and its activity over the last 30 days (null when unknown). */
    async companyHealth(actor: PlatformActor, tenantId: string) {
      if (!z.uuid().safeParse(tenantId).success) return null;
      const now = clock.now();
      return platformDb.run(actor.userId, async (tx) => {
        const [facts] = await healthFacts(tx, tenantId);
        if (!facts) return null;
        const [activity] = await activitySince(tx, new Date(now.getTime() - 30 * DAY_MS), tenantId);
        return { health: assess(facts), activity: activity ?? null };
      });
    },

    /** Signup sessions that failed or were abandoned, stuck number setups and stalled companies. */
    async onboarding(actor: PlatformActor) {
      const now = clock.now();
      const since = new Date(now.getTime() - OPS_WINDOWS.onboardingDays * DAY_MS);
      return platformDb.run(actor.userId, async (tx) => {
        const sessions = await signupProblems(tx, since, now);
        const numbers = await numberSetupProblems(tx, now);
        const created = await companiesCreatedSince(tx, since);
        return {
          since,
          sessions,
          numbers,
          createdCompanies: created.length,
          connectedCompanies: created.filter((c) => c.active).length,
          stalled: created.filter((c) => !c.active),
        };
      });
    },

    /** Current integration failures, platform webhook receipts, quarantine and email delivery. */
    async integrations(actor: PlatformActor) {
      const now = clock.now();
      return platformDb.run(actor.userId, async (tx) => {
        const failures = await integrationFailures(tx, 500);
        const receipts = await receiptsNeedingAttention(tx, now);
        const quarantine = await openQuarantine(tx, now);
        const emails = await emailDelivery(tx, now);
        // When platform staff were last emailed about work that failed for good (ADR-091) and about
        // companies' failing integrations (ADR-139).
        const alerts = await tx
          .select({ kind: platformAlerts.kind, lastSentAt: platformAlerts.lastSentAt })
          .from(platformAlerts)
          .where(inArray(platformAlerts.kind, ['failures', 'integrations']));
        const lastSent = (kind: string) => alerts.find((a) => a.kind === kind)?.lastSentAt ?? null;
        return {
          failures,
          receipts,
          lastFailureAlertAt: lastSent('failures'),
          lastIntegrationAlertAt: lastSent('integrations'),
          quarantine,
          emails,
        };
      });
    },

    /**
     * The encryption keyring (ADR-134): the configured key ids and how many stored values of each
     * kind each key sealed (`ops.sealed_value_counts`, counts only), so staff see when a key other
     * than the primary seals nothing and can be removed.
     */
    async keyring(actor: PlatformActor): Promise<KeyringOverview> {
      const counts = await platformDb.run(actor.userId, (tx) =>
        tx.execute<{ kind: string; key_id: string | null; sealed: string }>(
          sql`select kind, key_id, sealed from ops.sealed_value_counts()`,
        ),
      );
      return keyringOverview(deps.keyring, parseSealedValueCounts(counts.rows));
    },

    /**
     * Job signing (ADR-135): the configured key ids and how many jobs that can still run name each
     * (`ops.job_signing_key_counts`, counts only), so staff see when a previous key signs nothing
     * left and can be removed.
     */
    async jobSigning(actor: PlatformActor): Promise<JobSigningOverview> {
      const counts = await platformDb.run(actor.userId, (tx) =>
        tx.execute<{ key_id: string | null; state: string; jobs: string }>(
          sql`select key_id, state, jobs from ops.job_signing_key_counts()`,
        ),
      );
      return jobSigningOverview(deps.jobSigning, parseJobSigningKeyCounts(counts.rows));
    },

    /**
     * Queue counts from pg-boss, how long jobs waited at the worker's last check (ADR-096) and dead
     * letters recorded by the worker.
     */
    async queues(actor: PlatformActor) {
      const now = clock.now();
      const snapshot = await inspector.snapshot();
      return platformDb.run(actor.userId, async (tx) => {
        const waits = await queueWaitsByName(tx);
        const [alerts] = await tx
          .select({ lastSentAt: platformAlerts.lastSentAt })
          .from(platformAlerts)
          .where(eq(platformAlerts.kind, 'queues'));
        const rows = await queueRows(tx, now, snapshot, waits);
        const check = queueCheck(waits, now);
        return {
          queues: rows,
          deadLetters: await recentDeadLetters(tx, now),
          waitsCheckedAt: check.checkedAt,
          waitsFresh: check.fresh,
          lastQueueAlertAt: alerts?.lastSentAt ?? null,
        };
      });
    },

    /** Review signals over the signal window, flagged companies first, and security events. */
    async signals(actor: PlatformActor) {
      const now = clock.now();
      const since = new Date(now.getTime() - OPS_SIGNAL_RULES.windowDays * DAY_MS);
      return platformDb.run(actor.userId, async (tx) => ({
        since,
        rows: await signalRows(tx, since),
        security: await securityEventCounts(tx, now),
      }));
    },

    /** Usage per company over the last `days` days, busiest first, with totals. */
    async usage(actor: PlatformActor, days: number) {
      const window = usageWindow(days);
      const now = clock.now();
      const since = new Date(now.getTime() - window * DAY_MS);
      return platformDb.run(actor.userId, async (tx) => {
        const rows = await usageRows(tx, window, now);
        const sum = (pick: (a: CompanyUsage) => number) =>
          rows.reduce((total, a) => total + pick(a), 0);
        return {
          days: window,
          since,
          rows,
          /** The window before's sending and receipts (ADR-157), null for 90 days. */
          previous: USAGE_COMPARED_WINDOWS.includes(window)
            ? {
                outbound: sum((a) => a.previous?.outbound ?? 0),
                inbound: sum((a) => a.previous?.inbound ?? 0),
              }
            : null,
          totals: {
            outbound: sum((a) => a.outbound),
            inbound: sum((a) => a.inbound),
            campaign: sum((a) => a.outboundBySender.campaign),
            api: sum((a) => a.outboundBySender.api),
            bot: sum((a) => a.outboundBySender.bot),
            webhookDeliveries: sum((a) => a.webhookDeliveries),
            automationRuns: sum((a) => a.automationRuns),
            members: sum((a) => a.members),
            numbers: sum((a) => a.numbers),
          },
        };
      });
    },

    /**
     * One of the console's lists as CSV: the Usage tab for a window (ADR-154), every company's
     * health or the Signals tab (ADR-155), or a list of the Onboarding, Integrations or Queues tab
     * (ADR-158). The export is written to the platform audit log (the list, its window and how many
     * companies or rows) in the transaction that reads the rows, before the file is returned, so no
     * file leaves without its entry.
     */
    async exportList(
      actor: PlatformActor,
      list: OpsExportList,
      days: number,
    ): Promise<{ filename: string; body: string }> {
      const now = clock.now();
      return platformDb.run(actor.userId, async (tx) => {
        // Refused to anyone who is not a platform administrator before any list is read, as the
        // definer functions refuse, whether or not the list's read goes through one (ADR-158).
        const [admin] = await tx
          .select({ userId: platformAdmins.userId })
          .from(platformAdmins)
          .where(eq(platformAdmins.userId, actor.userId));
        if (!admin) throw forbidden('Only platform administrators can export the console’s lists.');
        const file = await exportFile(tx, list, days, now);
        await tx.insert(platformAuditEvents).values({
          id: uuidv7(),
          actorUserId: actor.userId,
          action: opsExportAction(list),
          result: 'success',
          correlationId: actor.correlationId,
          metadata:
            file.window === undefined ? file.counted : { days: file.window, ...file.counted },
        });
        return { filename: opsCsvFilename(list, now, file.window), body: file.body };
      });
    },

    /**
     * Sends a failed or quarantined Meta or Razorpay receipt back to processing (the sweep picks it
     * up; processing is idempotent). Audited in the same transaction by the definer function.
     */
    async retryReceipt(actor: PlatformActor, input: unknown): Promise<{ previousStatus: string }> {
      const data = parseInput(retrySchema, input);
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<{ previous: string }>(
          sql`select ops.platform_retry_webhook_receipt(${data.receiptId}::uuid, ${data.reason}, ${actor.correlationId}) as previous`,
        );
        return { previousStatus: String(result.rows[0]?.previous) };
      });
    },

    /**
     * Sends a dead letter's job back to its queue for one more attempt, as pg-boss's own retry does
     * (ADR-108). The definer function checks the administrator, the dead letter, the company and
     * pg-boss's job again, and marks and audits the retry in the same transaction.
     */
    async retryDeadLetter(actor: PlatformActor, input: unknown): Promise<{ queue: string }> {
      const data = parseInput(deadLetterRetrySchema, input);
      return platformDb.run(actor.userId, async (tx) => {
        const result = await tx.execute<{ queue: string }>(
          sql`select ops.platform_retry_dead_letter(${data.deadLetterId}::uuid, ${data.reason}, ${actor.correlationId}) as queue`,
        );
        return { queue: String(result.rows[0]?.queue) };
      });
    },

    /**
     * Records that a platform administrator looked at a dead letter, with a note, replacing an
     * earlier acknowledgement of it (ADR-169). The definer function checks the administrator, the
     * note and the dead letter, and audits it in the same transaction.
     */
    async acknowledgeDeadLetter(actor: PlatformActor, input: unknown): Promise<void> {
      const data = parseInput(deadLetterAcknowledgeSchema, input);
      await platformDb.run(actor.userId, async (tx) => {
        await tx.execute(
          sql`select ops.platform_acknowledge_dead_letter(${data.deadLetterId}::uuid, ${data.note}, ${actor.correlationId})`,
        );
      });
    },

    /**
     * Records that a platform administrator looked at a queue that is late now, with a note,
     * replacing an earlier one (ADR-177). The definer function checks the administrator, the note
     * and that the queue is still late since the time the page showed, and audits it in the same
     * transaction.
     */
    async acknowledgeLateQueue(actor: PlatformActor, input: unknown): Promise<void> {
      const data = parseInput(lateQueueAcknowledgeSchema, input);
      await platformDb.run(actor.userId, async (tx) => {
        await tx.execute(
          sql`select ops.platform_acknowledge_late_queue(${data.queue}, ${data.lateSince}::timestamptz, ${data.note}, ${actor.correlationId})`,
        );
      });
    },

    /**
     * Records that a platform administrator is handling a failure the console lists now, with a
     * note, replacing an earlier acknowledgement of it (ADR-141). The definer function checks the
     * administrator and that the failure is still listed, and audits it in the same transaction.
     */
    async acknowledgeFailure(actor: PlatformActor, input: unknown): Promise<void> {
      const data = parseInput(acknowledgeSchema, input);
      await platformDb.run(actor.userId, async (tx) => {
        await tx.execute(
          sql`select ops.platform_acknowledge_integration_failure(${data.source}, ${data.subjectId}::uuid, ${data.state}, ${data.note}, ${actor.correlationId})`,
        );
      });
    },

    /** Records how a quarantine entry was resolved; audited in the same transaction. */
    async resolveQuarantine(actor: PlatformActor, input: unknown): Promise<void> {
      const data = parseInput(resolveSchema, input);
      await platformDb.run(actor.userId, async (tx) => {
        const [entry] = await tx
          .update(webhookQuarantine)
          .set({ resolvedAt: clock.now(), resolution: data.resolution })
          .where(
            and(eq(webhookQuarantine.id, data.quarantineId), isNull(webhookQuarantine.resolvedAt)),
          )
          .returning({
            receiptId: webhookQuarantine.receiptId,
            provider: webhookQuarantine.provider,
            reason: webhookQuarantine.reason,
          });
        if (!entry) throw notFound('Open quarantine entry');
        await tx.insert(platformAuditEvents).values({
          id: uuidv7(),
          actorUserId: actor.userId,
          action: 'platform.webhook_quarantine_resolved',
          reason: data.resolution,
          result: 'success',
          correlationId: actor.correlationId,
          metadata: {
            quarantineId: data.quarantineId,
            receiptId: entry.receiptId,
            provider: entry.provider,
            reason: entry.reason,
          },
        });
      });
    },
  };
}

/**
 * Quarantine entries keep provider ids only (a WhatsApp Business Account, a phone number id, a
 * webhook field, a Razorpay payment or order id); anything else is left out of the page.
 */
export type PlatformOpsService = ReturnType<typeof createPlatformOpsService>;
