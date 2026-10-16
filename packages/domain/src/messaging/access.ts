import type { Clock, Keyring } from '@w360/core';
import {
  and,
  channelAccounts,
  eq,
  inArray,
  sql,
  systemScope,
  tenants,
  whatsappAccounts,
  type Database,
  type TenantScope,
  type Tx,
} from '@w360/db';
import { recordSystemAudit } from '../audit';
import { enqueueEmail, type OutboxDeps } from '../email/outbox';
import { deletionRecipients, formatCompanyTime } from '../tenancy/deletion';
import { credentialAad } from './credentials';
import { emitTenantEvent } from './events';
import type { GraphClient, GraphResult } from './graph';

/**
 * Checking each company's WhatsApp access before sends fail (ADR-137, P2-12). The minute sweep lists
 * the connected accounts due a check (daily, or at once when Meta refused the token for a send or a
 * template sync); each is checked in its company's scope with `debug_token`, by the rules that
 * admitted the token at onboarding. A loss of access marks the account and its numbers for
 * reconnecting and emails the owners and administrators once; a check that could not be made changes
 * nothing for the company and is tried again after 30 minutes.
 */

/** The permissions HyFib's access needs: to send, and to manage the account (research M-147). */
export const REQUIRED_META_PERMISSIONS = [
  'whatsapp_business_management',
  'whatsapp_business_messaging',
] as const;

export const ACCESS_PROBLEMS = [
  'invalid',
  'other_app',
  'missing_permission',
  'account_not_shared',
] as const;
export type AccessProblem = (typeof ACCESS_PROBLEMS)[number];

/** Owners and administrators are reminded once when the access expires within this many days. */
export const ACCESS_EXPIRY_NOTICE_DAYS = 7;

/** What `debug_token` says about a token (see GraphClient.debugToken). */
export interface TokenGrant {
  appId: string;
  isValid: boolean;
  scopes: string[];
  granularScopes: { scope: string; targetIds: string[] }[];
  expiresAt: Date | null;
}

/**
 * Why Meta's description of a token does not admit it for the account, or null when it does. The
 * rules onboarding applies, in its order: valid, HyFib's app, both WhatsApp permissions, and the
 * account among the target ids Meta lists for the management permission (when it lists any).
 */
export function assessGrant(
  grant: TokenGrant,
  appId: string,
  wabaId: string,
): { problem: AccessProblem; missing: string[] } | null {
  if (!grant.isValid) return { problem: 'invalid', missing: [] };
  if (grant.appId !== appId) return { problem: 'other_app', missing: [] };
  const missing = REQUIRED_META_PERMISSIONS.filter((p) => !grant.scopes.includes(p));
  if (missing.length > 0) return { problem: 'missing_permission', missing };
  const management = grant.granularScopes.find((g) => g.scope === 'whatsapp_business_management');
  if (management && management.targetIds.length > 0 && !management.targetIds.includes(wabaId)) {
    return { problem: 'account_not_shared', missing: [] };
  }
  return null;
}

/** The required permissions missing from those Meta listed. */
export function missingPermissions(granted: readonly string[]): string[] {
  return REQUIRED_META_PERMISSIONS.filter((p) => !granted.includes(p));
}

const PERMISSION_PURPOSES: Record<string, string> = {
  whatsapp_business_messaging: 'send messages',
  whatsapp_business_management: 'manage the account, its numbers and templates',
};

/** A Meta permission of an account's access, and what it lets HyFib do when HyFib knows. */
export interface GrantedPermission {
  scope: string;
  purpose: string | null;
}

/**
 * The permissions Meta listed for an account's access when it was last checked or connected, as
 * Settings → Channels shows them (ADR-381): those HyFib's access needs first, in their order, each
 * with what it is for, then any others by name, each once.
 */
export function grantedPermissionList(scopes: readonly string[]): GrantedPermission[] {
  const given = new Set(scopes.map((scope) => scope.trim()).filter(Boolean));
  const required: readonly string[] = REQUIRED_META_PERMISSIONS;
  const ordered = [
    ...required.filter((scope) => given.has(scope)),
    ...[...given].filter((scope) => !required.includes(scope)).sort(),
  ];
  return ordered.map((scope) => ({ scope, purpose: PERMISSION_PURPOSES[scope] ?? null }));
}

/**
 * Why Meta no longer accepts HyFib's access, as a clause ("Meta no longer accepts HyFib's access to
 * the account: <reason>"). A problem recorded before the checks (null) is a token Meta refused.
 */
export function accessProblemReason(
  problem: AccessProblem | null,
  missing: readonly string[],
): string {
  switch (problem) {
    case 'invalid':
      return 'Meta reports that the access token is no longer valid';
    case 'other_app':
      return 'Meta reports that the access token belongs to another app';
    case 'missing_permission': {
      if (missing.length === 0) return 'a WhatsApp permission was removed';
      const purposes = missing.map((p) => `to ${PERMISSION_PURPOSES[p] ?? p}`);
      return missing.length === 1
        ? `the permission ${purposes[0]} (${missing[0]}) was removed`
        : `the permissions ${purposes.join(' and ')} (${missing.join(', ')}) were removed`;
    }
    case 'account_not_shared':
      return 'Meta no longer lists the account among those shared with HyFib’s app';
    case null:
      return 'Meta refused HyFib’s access token';
  }
}

/** How an account is named to the company: its name, or its id. */
export function accountLabel(account: { name: string | null; wabaId: string }): string {
  return account.name?.trim() || `WhatsApp Business Account ${account.wabaId}`;
}

/** The message on each number of an account that lost its access. */
export function lostAccessNumberError(reason: string): string {
  return `Meta no longer accepts HyFib’s access to this number’s WhatsApp Business Account: ${reason}. Reconnect WhatsApp.`.slice(
    0,
    1000,
  );
}

const RECONNECT_STEPS =
  'To reconnect, open Settings → Channels, choose Connect WhatsApp and pick the same account and one of its numbers in Meta’s window. HyFib then checks the account’s other numbers with the new access.';

function listNumbers(numbers: readonly string[]): string {
  if (numbers.length <= 1) return numbers[0] ?? '';
  return `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

/** The email to owners and administrators when an account loses its access. */
export function accessLostNotice(facts: { account: string; reason: string; numbers: string[] }): {
  subject: string;
  lines: string[];
} {
  // One line in the subject whatever the name holds.
  const account = facts.account.replace(/\s+/g, ' ').trim();
  return {
    subject: `Reconnect WhatsApp: Meta no longer accepts HyFib’s access to ${account}`,
    lines: [
      `Meta no longer accepts HyFib’s access to ${account}: ${facts.reason}.`,
      facts.numbers.length > 0
        ? `Until it is reconnected, ${listNumbers(facts.numbers)} cannot send messages, templates or campaigns from HyFib.`
        : 'Until it is reconnected, none of its numbers can send messages from HyFib.',
      RECONNECT_STEPS,
      'If HyFib’s access was removed on purpose, disconnect the numbers on the same page.',
    ],
  };
}

/** The reminder to owners and administrators that an account's access expires soon. */
export function accessExpiryNotice(facts: {
  account: string;
  numbers: string[];
  expiresAt: Date;
  timeZone: string;
}): { subject: string; lines: string[] } {
  const account = facts.account.replace(/\s+/g, ' ').trim();
  const day = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeZone: facts.timeZone,
  }).format(facts.expiresAt);
  return {
    subject: `HyFib’s access to ${account} expires on ${day}`,
    lines: [
      `Meta reports that HyFib’s access to ${account} expires on ${formatCompanyTime(facts.expiresAt, facts.timeZone)}.`,
      facts.numbers.length > 0
        ? `From then on ${listNumbers(facts.numbers)} cannot send messages from HyFib until the account is reconnected.`
        : 'From then on its numbers cannot send messages from HyFib until the account is reconnected.',
      `${RECONNECT_STEPS} Reconnecting gives HyFib a new access token.`,
    ],
  };
}

/** The email to owners and administrators when HyFib's app could not be subscribed again (ADR-138). */
export function webhooksMissingNotice(facts: { account: string; numbers: string[] }): {
  subject: string;
  lines: string[];
} {
  const account = facts.account.replace(/\s+/g, ' ').trim();
  return {
    subject: `WhatsApp messages for ${account} are not reaching HyFib`,
    lines: [
      `Meta no longer lists HyFib’s app among the apps that receive ${account}’s WhatsApp messages and updates, and subscribing it again failed.`,
      facts.numbers.length > 0
        ? `Until it is subscribed again, messages customers send to ${listNumbers(facts.numbers)} do not reach HyFib.`
        : 'Until it is subscribed again, messages customers send to its numbers do not reach HyFib.',
      'HyFib tries again every 30 minutes. Connecting the same account again in Settings → Channels also subscribes it.',
    ],
  };
}

/**
 * The email to owners and administrators once HyFib's app receives an account's updates again: at
 * once when the check subscribed it again, or after they were told it could not be (ADR-138).
 */
export function webhooksRestoredNotice(facts: {
  account: string;
  restoredAt: Date;
  missingSince: Date | null;
  timeZone: string;
}): { subject: string; lines: string[] } {
  const account = facts.account.replace(/\s+/g, ' ').trim();
  const restored = formatCompanyTime(facts.restoredAt, facts.timeZone);
  if (!facts.missingSince) {
    return {
      subject: `HyFib was not receiving WhatsApp updates for ${account}`,
      lines: [
        `Meta no longer listed HyFib’s app among the apps that receive ${account}’s WhatsApp messages and updates, so HyFib subscribed it again on ${restored}.`,
        'Messages, delivery updates and template updates that Meta sent before then may not have reached HyFib, so some conversations may be missing from the inbox.',
        'If HyFib should no longer receive this account’s messages, disconnect its numbers in Settings → Channels.',
      ],
    };
  }
  return {
    subject: `WhatsApp messages for ${account} reach HyFib again`,
    lines: [
      `HyFib receives ${account}’s WhatsApp messages and updates again since ${restored}.`,
      `Messages and updates that Meta sent while HyFib’s app was not subscribed (at least since ${formatCompanyTime(facts.missingSince, facts.timeZone)}) may not have reached HyFib, so some conversations may be missing from the inbox.`,
    ],
  };
}

/** Whether an expiry Meta reports for a healthy token is due its reminder. */
export function accessExpiresSoon(expiresAt: Date | null, now: Date): boolean {
  if (!expiresAt) return false;
  const left = expiresAt.getTime() - now.getTime();
  return left > 0 && left <= ACCESS_EXPIRY_NOTICE_DAYS * 86_400_000;
}

export interface AccessCheckDeps {
  db: Database;
  keyring: Keyring;
  graph: GraphClient;
  clock: Clock;
  meta: { appId: string; appSecret: string };
  notices: { outbox: OutboxDeps; appBaseUrl: string };
}

/**
 * `healthy`: Meta admits the token. `lost`: it no longer does; the account needs reconnecting.
 * `not_checked`: the request failed; nothing changed for the company. `skipped`: the account is not
 * connected (any more), or was reconnected with another token during the check.
 */
export type AccessCheckOutcome = 'healthy' | 'lost' | 'not_checked' | 'skipped';

/**
 * The account's webhook subscription, checked once Meta admits the token (ADR-138): `subscribed`:
 * Meta lists HyFib's app; `restored`: it did not, and subscribing it again succeeded; `missing`: it
 * did not, and subscribing it again failed; `not_checked`: the listing failed or was not understood.
 */
export type SubscriptionFinding =
  | { state: 'subscribed' }
  | { state: 'restored' }
  | { state: 'missing'; error: string }
  | { state: 'not_checked'; error: string };

/** A failed request as stored: its kind, code and title, never the token or the URL. */
function failureText(result: Extract<GraphResult<unknown>, { ok: false }>): string {
  return `${result.kind}${result.code !== undefined ? ` ${result.code}` : ''}: ${result.title}`.slice(
    0,
    300,
  );
}

/** Lists the account's subscribed apps and subscribes HyFib's app again when it is not among them. */
async function checkSubscription(
  deps: AccessCheckDeps,
  wabaId: string,
  token: string,
): Promise<SubscriptionFinding> {
  const listed = await deps.graph.listSubscribedApps(wabaId, token);
  if (!listed.ok) return { state: 'not_checked', error: failureText(listed) };
  if (listed.data.appIds.includes(deps.meta.appId)) return { state: 'subscribed' };
  // An app whose id could not be read, or a page that follows, may be HyFib's: only a complete list
  // tells that it is missing.
  if (!listed.data.complete) return { state: 'not_checked', error: 'unknown: incomplete_app_list' };
  // The call onboarding makes; a disconnection racing it changes nothing, since disconnecting does
  // not unsubscribe the app at Meta.
  const restored = await deps.graph.subscribeApp(wabaId, token);
  return restored.ok ? { state: 'restored' } : { state: 'missing', error: failureText(restored) };
}

/** What a finding stores on the account. */
function subscriptionChanges(finding: SubscriptionFinding, missingSince: Date | null, at: Date) {
  switch (finding.state) {
    case 'subscribed':
      return { webhooksCheckedAt: at, webhooksCheckError: null, webhooksMissingSince: null };
    case 'restored':
      return {
        webhooksCheckedAt: at,
        webhooksRestoredAt: at,
        webhooksCheckError: null,
        webhooksMissingSince: null,
      };
    case 'missing':
      return { webhooksCheckError: finding.error, webhooksMissingSince: missingSince ?? at };
    case 'not_checked':
      return { webhooksCheckError: finding.error };
  }
}

/** Checks one account's access in its company's scope (the job of the minute sweep's signal). */
export async function checkWhatsAppAccess(
  deps: AccessCheckDeps,
  scope: TenantScope,
  whatsappAccountId: string,
): Promise<{ outcome: AccessCheckOutcome; error?: string; webhooks?: SubscriptionFinding }> {
  const tenantId = scope.tenantId;
  const where = and(
    eq(whatsappAccounts.tenantId, tenantId),
    eq(whatsappAccounts.id, whatsappAccountId),
  );
  const aad = credentialAad(tenantId, whatsappAccountId);
  const startedAt = deps.clock.now();
  const [account] = await deps.db.run(
    scope,
    (tx) =>
      tx
        .select({
          wabaId: whatsappAccounts.wabaId,
          status: whatsappAccounts.status,
          credential: whatsappAccounts.credentialCiphertext,
        })
        .from(whatsappAccounts)
        .where(where),
    { accessMode: 'read only' },
  );
  if (!account || account.status !== 'connected' || !account.credential)
    return { outcome: 'skipped' };
  const token = deps.keyring.decryptString(account.credential, aad);
  const debug = await deps.graph.debugToken(token, deps.meta.appId, deps.meta.appSecret);
  // The webhook subscription is checked only with a token Meta admits (ADR-138).
  const subscription =
    debug.ok && !assessGrant(debug.data, deps.meta.appId, account.wabaId)
      ? await checkSubscription(deps, account.wabaId, token)
      : null;

  return deps.db.run(scope, async (tx) => {
    // The account as it is now: a disconnection or a reconnection during the check wins.
    const [current] = await tx
      .select({
        wabaId: whatsappAccounts.wabaId,
        name: whatsappAccounts.name,
        status: whatsappAccounts.status,
        credential: whatsappAccounts.credentialCiphertext,
        expiryRemindedAt: whatsappAccounts.tokenExpiryRemindedAt,
        webhooksMissingSince: whatsappAccounts.webhooksMissingSince,
      })
      .from(whatsappAccounts)
      .where(where)
      .for('update');
    if (
      !current ||
      current.status !== 'connected' ||
      !current.credential ||
      deps.keyring.decryptString(current.credential, aad) !== token
    ) {
      return { outcome: 'skipped' as const };
    }
    if (!debug.ok) {
      const error = failureText(debug);
      await tx
        .update(whatsappAccounts)
        .set({ tokenCheckAttemptedAt: startedAt, tokenCheckError: error })
        .where(where);
      return { outcome: 'not_checked' as const, error };
    }
    const grant = debug.data;
    const verdict = assessGrant(grant, deps.meta.appId, current.wabaId);
    // Meta's permissions and expiry describe the token only when it is a valid token of HyFib's app.
    const described =
      grant.isValid && grant.appId === deps.meta.appId
        ? { grantedScopes: grant.scopes.slice(0, 50), tokenExpiresAt: grant.expiresAt }
        : {};
    const checked = {
      tokenCheckedAt: startedAt,
      tokenCheckAttemptedAt: startedAt,
      tokenCheckError: null,
      ...described,
    };
    const company = await companyFacts(tx, tenantId);
    const label = accountLabel(current);

    if (!verdict) {
      const remind =
        !current.expiryRemindedAt && accessExpiresSoon(grant.expiresAt, deps.clock.now());
      await tx
        .update(whatsappAccounts)
        .set({
          ...checked,
          ...(subscription
            ? subscriptionChanges(subscription, current.webhooksMissingSince, startedAt)
            : {}),
          ...(remind ? { tokenExpiryRemindedAt: deps.clock.now() } : {}),
        })
        .where(where);
      if (remind && grant.expiresAt && company) {
        const numbers = await numbersOf(tx, tenantId, whatsappAccountId, ['active', 'onboarding']);
        const notice = accessExpiryNotice({
          account: label,
          numbers: numbers.map((n) => n.label),
          expiresAt: grant.expiresAt,
          timeZone: company.timezone,
        });
        await emailManagers(deps, tx, tenantId, company, notice);
      }
      if (subscription) {
        await reportSubscription(deps, tx, {
          tenantId,
          whatsappAccountId,
          company,
          label,
          finding: subscription,
          missingSince: current.webhooksMissingSince,
          at: startedAt,
        });
      }
      return { outcome: 'healthy' as const, ...(subscription ? { webhooks: subscription } : {}) };
    }

    // A loss of access: the account and its numbers that send or are being set up need reconnecting.
    const numbers = await numbersOf(tx, tenantId, whatsappAccountId, ['active', 'onboarding']);
    const reason = accessProblemReason(verdict.problem, verdict.missing);
    await tx
      .update(whatsappAccounts)
      .set({
        ...checked,
        status: 'needs_reconnect',
        tokenProblem: verdict.problem,
        tokenProblemAt: startedAt,
      })
      .where(where);
    if (numbers.length > 0) {
      await tx
        .update(channelAccounts)
        .set({ status: 'needs_reconnect', onboardingError: lostAccessNumberError(reason) })
        .where(
          and(
            eq(channelAccounts.tenantId, tenantId),
            inArray(
              channelAccounts.id,
              numbers.map((n) => n.id),
            ),
          ),
        );
    }
    await recordSystemAudit(tx, tenantId, {
      action: 'whatsapp.access_lost',
      subjectType: 'whatsapp_account',
      subjectId: whatsappAccountId,
      result: 'failure',
      metadata: {
        problem: verdict.problem,
        missing: verdict.missing,
        numbers: numbers.length,
        code: grant.errorCode,
      },
    });
    for (const number of numbers) {
      await emitTenantEvent(tx, tenantId, {
        type: 'channel.updated',
        payload: { channelAccountId: number.id },
      });
    }
    if (company) {
      const notice = accessLostNotice({
        account: label,
        reason,
        numbers: numbers.map((n) => n.label),
      });
      await emailManagers(deps, tx, tenantId, company, notice);
    }
    return { outcome: 'lost' as const };
  });
}

/**
 * What a subscription finding tells the company (ADR-138): a restoration is audited and the owners
 * and administrators are emailed; so is the first failure to subscribe HyFib's app again, and the
 * subscription found again after that.
 */
async function reportSubscription(
  deps: AccessCheckDeps,
  tx: Tx,
  facts: {
    tenantId: string;
    whatsappAccountId: string;
    company: CompanyFacts | null;
    label: string;
    finding: SubscriptionFinding;
    missingSince: Date | null;
    at: Date;
  },
): Promise<void> {
  const { tenantId, whatsappAccountId, company, finding, missingSince } = facts;
  if (finding.state === 'restored') {
    await recordSystemAudit(tx, tenantId, {
      action: 'whatsapp.webhooks_restored',
      subjectType: 'whatsapp_account',
      subjectId: whatsappAccountId,
      result: 'success',
      metadata: { missingSince: missingSince?.toISOString() ?? null },
    });
  }
  if (finding.state === 'missing' && !missingSince) {
    await recordSystemAudit(tx, tenantId, {
      action: 'whatsapp.webhooks_missing',
      subjectType: 'whatsapp_account',
      subjectId: whatsappAccountId,
      result: 'failure',
      metadata: { error: finding.error },
    });
  }
  if (!company) return;
  if (finding.state === 'restored' || (finding.state === 'subscribed' && missingSince)) {
    const notice = webhooksRestoredNotice({
      account: facts.label,
      restoredAt: facts.at,
      missingSince,
      timeZone: company.timezone,
    });
    await emailManagers(deps, tx, tenantId, company, notice);
  } else if (finding.state === 'missing' && !missingSince) {
    const numbers = await numbersOf(tx, tenantId, whatsappAccountId, ['active', 'onboarding']);
    const notice = webhooksMissingNotice({
      account: facts.label,
      numbers: numbers.map((n) => n.label),
    });
    await emailManagers(deps, tx, tenantId, company, notice);
  }
}

interface CompanyFacts {
  name: string;
  slug: string;
  timezone: string;
}

/** The company's name, address and time zone; null while it is being deleted (no emails then). */
async function companyFacts(tx: Tx, tenantId: string): Promise<CompanyFacts | null> {
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
  return company;
}

async function numbersOf(
  tx: Tx,
  tenantId: string,
  whatsappAccountId: string,
  statuses: ('active' | 'onboarding')[],
): Promise<{ id: string; label: string }[]> {
  const rows = await tx
    .select({
      id: channelAccounts.id,
      phoneNumberId: channelAccounts.phoneNumberId,
      displayPhoneNumber: channelAccounts.displayPhoneNumber,
    })
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, tenantId),
        eq(channelAccounts.whatsappAccountId, whatsappAccountId),
        inArray(channelAccounts.status, statuses),
      ),
    )
    .orderBy(channelAccounts.createdAt, channelAccounts.id)
    .for('update');
  return rows.map((r) => ({
    id: r.id,
    label: r.displayPhoneNumber ?? `number ${r.phoneNumberId}`,
  }));
}

/** Emails the company's owners and administrators (the roles that can reconnect) a notice. */
async function emailManagers(
  deps: AccessCheckDeps,
  tx: Tx,
  tenantId: string,
  company: CompanyFacts,
  notice: { subject: string; lines: string[] },
): Promise<void> {
  const url = new URL(`/c/${company.slug}/settings/channels`, deps.notices.appBaseUrl).toString();
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
        actionLabel: 'Open Channels',
      },
    });
  }
}

/** The accounts due a check, across companies (ids only, through a definer function). */
export async function findAccessChecksDue(
  db: Database,
  limit = 100,
): Promise<{ tenantId: string; whatsappAccountId: string }[]> {
  return db.run(
    systemScope,
    async (tx) => {
      const res = await tx.execute<{ tenant_id: string; whatsapp_account_id: string }>(
        sql`select tenant_id, whatsapp_account_id from ops.whatsapp_access_checks_due(${limit}::int)`,
      );
      return res.rows.map((r) => ({
        tenantId: r.tenant_id,
        whatsappAccountId: r.whatsapp_account_id,
      }));
    },
    { accessMode: 'read only' },
  );
}

/**
 * Asks for a check of a connected account's access at once: Meta refused its token for a send or a
 * template sync, so the check finds out whether the account lost its access.
 */
export async function requestAccessCheck(
  tx: Tx,
  tenantId: string,
  whatsappAccountId: string,
  at: Date,
): Promise<void> {
  await tx
    .update(whatsappAccounts)
    .set({ tokenCheckRequestedAt: at })
    .where(
      and(
        eq(whatsappAccounts.tenantId, tenantId),
        eq(whatsappAccounts.id, whatsappAccountId),
        eq(whatsappAccounts.status, 'connected'),
      ),
    );
}
