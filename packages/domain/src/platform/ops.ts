import { z } from 'zod';
import { notFound, uuidv7, type Clock } from '@w360/core';
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
  platformAlerts,
  platformAuditEvents,
  queueWaits,
  securityEvents,
  sql,
  tenants,
  users,
  webhookQuarantine,
  webhookReceipts,
  type Tx,
} from '@w360/db';
import type { PlatformDatabase } from '@w360/db/platform';
import { keyringOverview, parseSealedValueCounts, type KeyringOverview } from '../keyring/reseal';
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
  type CompanyActivity,
  type CompanyHealthFacts,
  type HealthIssue,
  type HealthLevel,
  type SignalFlag,
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
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Webhook bodies are erased 7 days after they were received (ops.apply_webhook_retention). */
const RECEIPT_BODY_DAYS = 7;
export const USAGE_WINDOWS = [7, 30, 90] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

type Row = Record<string, unknown>;
const num = (value: unknown) => Number(value ?? 0);
const date = (value: unknown) => (value instanceof Date ? value : null);
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

export interface CompanyHealth {
  facts: CompanyHealthFacts;
  issues: HealthIssue[];
  level: HealthLevel;
}

function assess(facts: CompanyHealthFacts): CompanyHealth {
  const issues = healthIssues(facts);
  return { facts, issues, level: healthLevel(issues) };
}

const levelOrder: Record<HealthLevel, number> = { critical: 0, warning: 1, ok: 2 };

export interface IntegrationFailure {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  source: string;
  subjectId: string;
  label: string | null;
  state: string;
  error: string | null;
  since: Date | null;
}

export type ReceiptProblem = 'exhausted' | 'waiting';

/**
 * How long a queue's jobs waited when the worker last checked (ADR-096): jobs pg-boss would hand to
 * a worker, the oldest one's wait then, the queue's limit, and whether it is late.
 */
export interface QueueWait {
  waiting: number;
  oldestWaitingSince: Date | null;
  /** The oldest job's wait when the worker checked, in milliseconds (null when none waited). */
  oldestWaitMs: number | null;
  limitMinutes: number;
  lateSince: Date | null;
  /** When platform staff were emailed that it was late (ADR-096). */
  alertedAt: Date | null;
  checkedAt: Date;
}

/**
 * One queue: its declared retry policy and wait limit (null when this release does not declare it),
 * counts, and how long its jobs waited at the last check.
 */
export interface QueueRow {
  name: string;
  policy: { retryLimit: number; hasDeadLetter: boolean; maxWaitMinutes: number } | null;
  counts: QueueSnapshot | null;
  deadLetters: { last24h: number; last7d: number };
  wait: QueueWait | null;
}

export interface ReceiptNeedingAttention {
  id: string;
  provider: string;
  receivedAt: Date;
  status: string;
  attempts: number;
  lastError: string | null;
  problem: ReceiptProblem;
  /** Whether the body is still kept, so a retry can process it (checked again when retrying). */
  retryable: boolean;
  /** When platform staff were emailed that it used all its attempts (ADR-091). */
  alertedAt: Date | null;
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
    return result.rows.map((r) => ({
      tenantId: String(r.tenant_id),
      tenantName: String(r.tenant_name),
      tenantSlug: String(r.tenant_slug),
      source: String(r.source),
      subjectId: String(r.subject_id),
      label: text(r.label),
      state: String(r.state),
      error: text(r.error),
      since: date(r.since),
    }));
  }

  /** The last check of each queue's waits, by queue (ADR-096). */
  async function queueWaitsByName(tx: Tx): Promise<Map<string, QueueWait>> {
    const rows = await tx.select().from(queueWaits);
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
      const attention = data.companies
        .filter((c) => c.level !== 'ok')
        .sort(
          (a, b) =>
            levelOrder[a.level] - levelOrder[b.level] ||
            b.issues.length - a.issues.length ||
            a.facts.name.localeCompare(b.facts.name),
        );
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
      const stuckBefore = new Date(now.getTime() - OPS_WINDOWS.stuckSetupMinutes * MINUTE_MS);
      return platformDb.run(actor.userId, async (tx) => {
        const sessions = await tx.execute<Row>(
          sql`select * from ops.platform_ops_signup_sessions(${since.toISOString()}::timestamptz, 200)`,
        );
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
        const created = await tx
          .select({
            id: tenants.id,
            name: tenants.name,
            slug: tenants.slug,
            status: tenants.status,
            createdAt: tenants.createdAt,
            active: sql<boolean>`exists (select 1 from ${channelAccounts} c
              where c.tenant_id = ${tenants.id} and c.status = 'active')`,
            inProgress: sql<boolean>`exists (select 1 from ${channelAccounts} c
              where c.tenant_id = ${tenants.id} and c.status = 'onboarding')`,
          })
          .from(tenants)
          .where(and(gte(tenants.createdAt, since), sql`${tenants.status} <> 'deleted'`))
          .orderBy(desc(tenants.createdAt))
          .limit(500);
        return {
          since,
          sessions: sessions.rows.map((r) => ({
            tenantId: String(r.tenant_id),
            tenantName: String(r.tenant_name),
            tenantSlug: String(r.tenant_slug),
            sessionId: String(r.session_id),
            outcome: String(r.outcome) as 'failed' | 'abandoned',
            failureReason: text(r.failure_reason),
            startedAt: date(r.started_at) ?? now,
            hasActiveNumber: r.has_active_number === true,
          })),
          numbers: numbers.map((n) => ({
            ...n,
            stuck: n.status === 'onboarding',
          })),
          createdCompanies: created.length,
          connectedCompanies: created.filter((c) => c.active).length,
          stalled: created.filter((c) => !c.active),
        };
      });
    },

    /** Current integration failures, platform webhook receipts, quarantine and email delivery. */
    async integrations(actor: PlatformActor) {
      const now = clock.now();
      const since7d = new Date(now.getTime() - 7 * DAY_MS);
      const stuckBefore = new Date(now.getTime() - 15 * MINUTE_MS);
      return platformDb.run(actor.userId, async (tx) => {
        const failures = await integrationFailures(tx, 500);
        const receipts = await receiptsNeedingAttention(tx, now);
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
        // Counts only: an SMTP error can quote the address it refused.
        const emails = await tx
          .select({
            kind: emailOutbox.kind,
            failed: sql<number>`count(*) filter (where ${emailOutbox.status} = 'failed')::int`,
            stuck: sql<number>`count(*) filter (where ${emailOutbox.status} in ('pending', 'sending')
              and ${emailOutbox.nextAttemptAt} < ${stuckBefore})::int`,
          })
          .from(emailOutbox)
          .where(gte(emailOutbox.createdAt, since7d))
          .groupBy(emailOutbox.kind)
          .orderBy(emailOutbox.kind);
        // When platform staff were last emailed about work that failed for good (ADR-091).
        const [alerts] = await tx
          .select({ lastSentAt: platformAlerts.lastSentAt })
          .from(platformAlerts)
          .where(eq(platformAlerts.kind, 'failures'));
        return {
          failures,
          receipts,
          lastFailureAlertAt: alerts?.lastSentAt ?? null,
          quarantine: quarantine.map((q) => ({
            ...q,
            externalIds: quarantineExternalIds(q.externalIds),
            retryable: q.receiptStatus === 'quarantined' && q.receivedAt.getTime() > bodyKeptAfter,
          })),
          emails: emails
            .map((e) => ({ kind: e.kind, failed: num(e.failed), stuck: num(e.stuck) }))
            .filter((e) => e.failed > 0 || e.stuck > 0),
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
     * Queue counts from pg-boss, how long jobs waited at the worker's last check (ADR-096) and dead
     * letters recorded by the worker.
     */
    async queues(actor: PlatformActor) {
      const now = clock.now();
      const snapshot = await inspector.snapshot();
      const byName = new Map<string, QueueSnapshot>(snapshot.map((q) => [q.name, q]));
      return platformDb.run(actor.userId, async (tx) => {
        const counts = await deadLetterCountsByQueue(tx, now);
        const waits = await queueWaitsByName(tx);
        const [alerts] = await tx
          .select({ lastSentAt: platformAlerts.lastSentAt })
          .from(platformAlerts)
          .where(eq(platformAlerts.kind, 'queues'));
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
          })
          .from(deadLetters)
          .leftJoin(tenants, eq(tenants.id, deadLetters.tenantId))
          .leftJoin(users, eq(users.id, deadLetters.retriedByUserId))
          .orderBy(desc(deadLetters.failedAt))
          .limit(100);
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
        const check = queueCheck(waits, now);
        return {
          queues: rows,
          deadLetters: recent.map((d) => {
            const retryBlock = deadLetterRetryBlock(d, now);
            return {
              ...d,
              retryableUntil: deadLetterRetryableUntil(d.sourceQueue, d.failedAt),
              retryBlock,
              retryable: retryBlock === null,
            };
          }),
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
      return platformDb.run(actor.userId, async (tx) => {
        const activity = await activitySince(tx, since, null);
        const quality = new Map(
          (await healthFacts(tx, null)).map((f) => [f.tenantId, f.qualityRating] as const),
        );
        const rows: { activity: CompanyActivity; quality: string | null; flags: SignalFlag[] }[] =
          activity
            .map((a) => {
              const rating = quality.get(a.tenantId) ?? null;
              return { activity: a, quality: rating, flags: signalFlags(a, rating) };
            })
            .filter(
              (r) =>
                r.flags.length > 0 || r.activity.outbound > 0 || r.activity.marketingOptOuts > 0,
            )
            .sort(
              (a, b) =>
                b.flags.length - a.flags.length ||
                b.activity.outbound - a.activity.outbound ||
                a.activity.name.localeCompare(b.activity.name),
            );
        return { since, rows, security: await securityEventCounts(tx, now) };
      });
    },

    /** Usage per company over the last `days` days, busiest first, with totals. */
    async usage(actor: PlatformActor, days: number) {
      const window: UsageWindow = (USAGE_WINDOWS as readonly number[]).includes(days)
        ? (days as UsageWindow)
        : 30;
      const since = new Date(clock.now().getTime() - window * DAY_MS);
      return platformDb.run(actor.userId, async (tx) => {
        const rows = await activitySince(tx, since, null);
        const sum = (pick: (a: CompanyActivity) => number) =>
          rows.reduce((total, a) => total + pick(a), 0);
        return {
          days: window,
          since,
          rows,
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
