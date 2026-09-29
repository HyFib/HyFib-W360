import type { Clock } from '@w360/core';
import {
  and,
  apiKeys,
  authorizedTenantScope,
  eq,
  sql,
  systemScope,
  tenants,
  users,
  type Database,
} from '@w360/db';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { deletionRecipients, formatCompanyTime } from '../tenancy/deletion';
import { API_KEY_LIMITS, API_KEY_REMINDER_DAYS, apiKeyExpiresSoon } from './model';

/**
 * Reminders before API keys expire (ADR-067). When a company's usable key expires within
 * API_KEY_REMINDER_DAYS days and was not rotated, the company's owners and administrators (the
 * roles that manage keys) are emailed once: which key (its name and public prefix, never a token),
 * when it expires, who created it, when it was last used, and how to rotate it. The minute messaging
 * sweep lists the keys due (ids only); each is checked again and marked in the company's own scope,
 * in the transaction that queues the emails.
 */

export interface ApiKeyReminderDeps {
  db: Database;
  clock: Clock;
  notices: { outbox: OutboxDeps; appBaseUrl: string };
}

export interface ApiKeyReminderSweepResult {
  reminded: number;
  /** Keys whose reminder failed; it rolled back and is due again on the next sweep. */
  failed: { tenantId: string; keyId: string; error: unknown }[];
}

/** What the reminder says about a key. */
export interface ApiKeyReminderFacts {
  name: string;
  keyPrefix: string;
  expiresAt: Date;
  createdAt: Date;
  /** The name of the member who created the key. */
  createdBy: string | null;
  lastUsedAt: Date | null;
}

/** The reminder's subject and lines, with times in the company's time zone. */
export function apiKeyReminderNotice(
  key: ApiKeyReminderFacts,
  timeZone: string,
): { subject: string; lines: string[] } {
  // One line in the subject whatever the name holds.
  const name = key.name.replace(/\s+/g, ' ').trim();
  const day = (at: Date) =>
    new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone }).format(at);
  const used = key.lastUsedAt
    ? `last used on ${formatCompanyTime(key.lastUsedAt, timeZone)}`
    : 'has not been used';
  return {
    subject: `API key “${name}” expires on ${day(key.expiresAt)}`,
    lines: [
      `The API key “${name}” (${key.keyPrefix}_…) expires on ${formatCompanyTime(key.expiresAt, timeZone)}. From then on the API refuses requests made with it.`,
      `It was created${key.createdBy ? ` by ${key.createdBy}` : ''} on ${day(key.createdAt)} and ${used}.`,
      `To keep an integration working, rotate the key in Settings → API keys: the new key has the same name, scopes and expiry period, and the old key can keep working for up to ${API_KEY_LIMITS.rotationOverlapHours} hours while you switch.`,
      'If nothing uses the key any more, let it expire or revoke it.',
    ],
  };
}

/**
 * Reminds the company's owners and administrators that a key expires soon, once (see
 * `apiKeyExpiresSoon`): nothing is sent for a key that was reminded, revoked, rotated, has expired
 * or no longer expires soon, or for a company being deleted. Returns whether this call sent it.
 */
export async function remindApiKeyExpiry(
  deps: ApiKeyReminderDeps,
  tenantId: string,
  keyId: string,
): Promise<boolean> {
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
      return false;
    }
    // Explicit columns: the runtime role cannot read the token hash.
    const [key] = await tx
      .select({
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        createdByUserId: apiKeys.createdByUserId,
        createdAt: apiKeys.createdAt,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        replacedByKeyId: apiKeys.replacedByKeyId,
        expiryRemindedAt: apiKeys.expiryRemindedAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)))
      .for('update');
    if (!key?.expiresAt || key.expiryRemindedAt || !apiKeyExpiresSoon(key, now)) return false;
    await tx
      .update(apiKeys)
      .set({ expiryRemindedAt: now })
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)));
    const [creator] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, key.createdByUserId));
    const notice = apiKeyReminderNotice(
      { ...key, expiresAt: key.expiresAt, createdBy: creator?.name ?? null },
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
    return true;
  });
}

/**
 * The minute sweep's reminders: lists the keys due (read only, across companies, through a definer
 * function) and reminds each in its company's scope. One key's failure does not hold up the others.
 */
export async function remindExpiringApiKeys(
  deps: ApiKeyReminderDeps,
  limit = 100,
): Promise<ApiKeyReminderSweepResult> {
  const due = await deps.db.run(
    systemScope,
    (tx) =>
      tx.execute<{ tenant_id: string; key_id: string }>(
        sql`select tenant_id, key_id
              from ops.api_key_expiry_reminders_due(${limit}::int, ${API_KEY_REMINDER_DAYS}::int)`,
      ),
    { accessMode: 'read only' },
  );
  const result: ApiKeyReminderSweepResult = { reminded: 0, failed: [] };
  for (const { tenant_id: tenantId, key_id: keyId } of due.rows) {
    try {
      if (await remindApiKeyExpiry(deps, tenantId, keyId)) result.reminded += 1;
    } catch (error) {
      result.failed.push({ tenantId, keyId, error });
    }
  }
  return result;
}
