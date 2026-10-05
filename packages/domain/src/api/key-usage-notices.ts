import type { Clock } from '@w360/core';
import {
  and,
  apiKeyUsage,
  apiKeys,
  authorizedTenantScope,
  eq,
  sql,
  systemScope,
  tenants,
  type Database,
} from '@w360/db';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { loadEntitlements } from '../plans/entitlements';
import { DEFAULT_USAGE_WARNING_PERCENT, usagePeriod, warningThreshold } from '../plans/model';
import { deletionRecipients, formatCompanyTime } from '../tenancy/deletion';
import { apiKeyState } from './model';

/**
 * Emails about an API key's own monthly limit (ADR-098). When a key with a limit of its own
 * (ADR-097) reaches 80% of it in a usage period, and when it reaches the limit, the company's owners
 * and administrators (the roles that manage keys) are emailed once each: which key (its name and
 * public prefix, never a token), how many of its requests are used and until when the period runs.
 * The minute messaging sweep lists the counters due (ids only); each is checked again and marked in
 * the company's own scope, in the transaction that queues the emails.
 */

export type ApiKeyUsageNoticeKind = 'warning' | 'reached';

export interface ApiKeyUsageNoticeDeps {
  db: Database;
  clock: Clock;
  notices: { outbox: OutboxDeps; appBaseUrl: string };
}

export interface ApiKeyUsageNoticeSweepResult {
  warned: number;
  reached: number;
  /** Counters whose email failed; it rolled back and is due again on the next sweep. */
  failed: { tenantId: string; usageId: string; error: unknown }[];
}

/** What a notice says about a key and its period. */
export interface ApiKeyUsageFacts {
  name: string;
  keyPrefix: string;
  used: number;
  limit: number;
  periodEnd: Date;
}

/** The notice's subject and lines, with times in the company's time zone. */
export function apiKeyUsageNotice(
  kind: ApiKeyUsageNoticeKind,
  key: ApiKeyUsageFacts,
  timeZone: string,
): { subject: string; lines: string[] } {
  // One line in the subject whatever the name holds.
  const name = key.name.replace(/\s+/g, ' ').trim();
  const count = (n: number) => n.toLocaleString('en-IN');
  const until = formatCompanyTime(key.periodEnd, timeZone);
  const change =
    "Owners and administrators can raise or remove the key's limit in Settings → API keys; the company's other keys are not affected.";
  if (kind === 'warning') {
    return {
      subject: `API key “${name}” has used ${count(key.used)} of its ${count(key.limit)} requests this month`,
      lines: [
        `The API key “${name}” (${key.keyPrefix}_…) has made ${count(key.used)} of the ${count(key.limit)} requests its monthly limit allows in the period that ends on ${until}.`,
        'Once they are used up, the API refuses its requests until then.',
        change,
      ],
    };
  }
  return {
    subject: `API key “${name}” has used all ${count(key.limit)} of its requests this month`,
    lines: [
      `The API key “${name}” (${key.keyPrefix}_…) has made all ${count(key.limit)} requests its monthly limit allows. The API refuses its requests (429, reason key_quota_exceeded) until the period ends on ${until}.`,
      change,
    ],
  };
}

/**
 * Emails the company's owners and administrators about one counter, once per kind: the warning at
 * 80% of the key's limit (none when the counter reached the limit first), then the notice at the
 * limit. Nothing is sent for a key without a limit, revoked or expired, a counter of another period,
 * or a company being deleted; a counter of an earlier period is marked without an email, so that
 * the sweep stops listing it (as the company's, ADR-062). Returns what this call sent.
 */
export async function noticeApiKeyUsage(
  deps: ApiKeyUsageNoticeDeps,
  tenantId: string,
  usageId: string,
): Promise<ApiKeyUsageNoticeKind | null> {
  const scope = authorizedTenantScope(tenantId, null);
  return deps.db.run(scope, async (tx) => {
    const now = deps.clock.now();
    const [company] = await tx
      .select({
        name: tenants.name,
        slug: tenants.slug,
        timezone: tenants.timezone,
        status: tenants.status,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!company || company.status === 'pending_deletion' || company.status === 'deleted') {
      return null;
    }
    const [usage] = await tx
      .select({
        apiKeyId: apiKeyUsage.apiKeyId,
        periodStart: apiKeyUsage.periodStart,
        used: apiKeyUsage.used,
        warnedAt: apiKeyUsage.warnedAt,
        notifiedAt: apiKeyUsage.notifiedAt,
      })
      .from(apiKeyUsage)
      .where(and(eq(apiKeyUsage.tenantId, tenantId), eq(apiKeyUsage.id, usageId)))
      .for('update');
    if (!usage || usage.notifiedAt) return null;
    const [key] = await tx
      .select({
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        limit: apiKeys.monthlyRequestLimit,
        revokedAt: apiKeys.revokedAt,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, usage.apiKeyId)));
    if (!key || key.limit === null || apiKeyState(key, now) !== 'active') return null;
    // Only the current period's counter: one left from an earlier period is not news, and is
    // marked so that the sweep does not list it again. One of a later period (counted by a server
    // whose clock is ahead) waits until it is current.
    const period = usagePeriod((await loadEntitlements(tx, tenantId)).usageAnchor, now);
    if (usage.periodStart.getTime() < period.start.getTime()) {
      await tx
        .update(apiKeyUsage)
        .set({ notifiedAt: now })
        .where(and(eq(apiKeyUsage.tenantId, tenantId), eq(apiKeyUsage.id, usageId)));
      return null;
    }
    if (usage.periodStart.getTime() !== period.start.getTime()) return null;
    // A key's own limit warns at 80%, whatever the company chose for its limits (ADR-144).
    const threshold = warningThreshold(key.limit, DEFAULT_USAGE_WARNING_PERCENT);
    const kind: ApiKeyUsageNoticeKind | null =
      usage.used >= key.limit
        ? 'reached'
        : threshold !== null && usage.used >= threshold && !usage.warnedAt
          ? 'warning'
          : null;
    if (!kind) return null;
    await tx
      .update(apiKeyUsage)
      .set(kind === 'reached' ? { notifiedAt: now } : { warnedAt: now })
      .where(and(eq(apiKeyUsage.tenantId, tenantId), eq(apiKeyUsage.id, usageId)));
    const notice = apiKeyUsageNotice(
      kind,
      {
        name: key.name,
        keyPrefix: key.keyPrefix,
        used: usage.used,
        limit: key.limit,
        periodEnd: period.end,
      },
      company.timezone,
    );
    const url = new URL(`/c/${company.slug}/settings/api-keys`, deps.notices.appBaseUrl).toString();
    for (const person of await deletionRecipients(tx, tenantId)) {
      await enqueueEmail(deps.notices.outbox, tx, {
        to: person.email,
        tenantId,
        payload: {
          kind: 'tenant.notice',
          companyName: company.name,
          subject: notice.subject,
          lines: notice.lines,
          url,
          actionLabel: 'Open API keys',
        },
      });
    }
    return kind;
  });
}

/**
 * The minute sweep's notices: lists the counters due (read only, across companies, through a
 * definer function) and emails about each in its company's scope. One counter's failure does not
 * hold up the others.
 */
export async function noticeApiKeyUsageDue(
  deps: ApiKeyUsageNoticeDeps,
  limit = 100,
): Promise<ApiKeyUsageNoticeSweepResult> {
  const due = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; usage_id: string }>(
        sql`select tenant_id, usage_id from ops.api_key_usage_notices_due(${limit}::int)`,
      ),
    { accessMode: 'read only' },
  );
  const result: ApiKeyUsageNoticeSweepResult = { warned: 0, reached: 0, failed: [] };
  for (const { tenant_id: tenantId, usage_id: usageId } of due.rows) {
    try {
      const sent = await noticeApiKeyUsage(deps, tenantId, usageId);
      if (sent === 'warning') result.warned += 1;
      if (sent === 'reached') result.reached += 1;
    } catch (error) {
      result.failed.push({ tenantId, usageId, error });
    }
  }
  return result;
}
