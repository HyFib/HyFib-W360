/**
 * The platform operations console's rules (ADR-054): which facts about a company make it need
 * attention, and which activity asks for a review. The thresholds are HyFib's own heuristics, not
 * Meta rules; nothing here acts on a company. Browser-safe: no I/O.
 */

import { CSV_BOM, csvLine } from '../contacts/csv';
import type { QueueSnapshot } from '../jobs/queue';
import { DEAD_LETTER_RETRY_BLOCK_TEXT, type DeadLetterRetryBlock } from './dead-letter-retries';

export const OPS_HEALTH_RULES = {
  /** Failure rates are judged only with at least this many outbound messages in 24 hours. */
  minOutbound24h: 20,
  warningFailureRate: 0.1,
  criticalFailureRate: 0.5,
} as const;

export const OPS_SIGNAL_RULES = {
  windowDays: 7,
  minOutbound: 100,
  failureRate: 0.2,
  minMarketingDelivered: 100,
  optOutRate: 0.02,
  /** Meta error 131050: the user stopped marketing messages (research M-062). */
  stoppedMarketing: 20,
  /** Meta error 131049: Meta's per-user marketing limit (research M-062). */
  perUserLimit: 100,
  complaints: 5,
} as const;

/**
 * How many rows each of the console's action lists shows on its tab, and how many its CSV gives
 * (ADR-200): the lists the platform role reads itself export up to 5,000 rows in the tab's order;
 * failures and signups, read through definer functions, as many as those return.
 */
export const OPS_LIST_ROWS = {
  signups: { shown: 200, exported: 500 },
  numberSetups: { shown: 200, exported: 5000 },
  newCompanies: { shown: 500, exported: 5000 },
  failures: { shown: 500, exported: 1000 },
  receipts: { shown: 100, exported: 5000 },
  quarantine: { shown: 100, exported: 5000 },
  deadLetters: { shown: 100, exported: 5000 },
} as const;

export const OPS_WINDOWS = {
  /** Embedded Signup sessions and new companies shown on the onboarding page. */
  onboardingDays: 30,
  /** A number whose setup has run longer than this is shown as stuck. */
  stuckSetupMinutes: 30,
  /** A receipt still waiting after this long is shown as stuck. */
  stuckReceiptMinutes: 10,
  deadLetterDays: 7,
  /** Emails failed or waiting, by kind, created in this many days. */
  emailDays: 7,
} as const;

/** What `ops.platform_ops_health` returns for one company. */
export interface CompanyHealthFacts {
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
  planStatus: string | null;
  numbersTotal: number;
  numbersActive: number;
  numbersReconnect: number;
  numbersFailed: number;
  /** The worst rating among active numbers, as Meta reported it at the last health check. */
  qualityRating: string | null;
  qualityCheckedAt: Date | null;
  accountsReconnect: number;
  outbound24h: number;
  failed24h: number;
  inbound24h: number;
  lastMessageAt: Date | null;
  endpointsFailing: number;
  endpointsAutoDisabled: number;
  storesFailed: number;
  paymentAccountsFailed: number;
  catalogSyncsFailed: number;
  flowSyncsFailed: number;
  deadLetters7d: number;
}

export type OpsSeverity = 'critical' | 'warning';

export type HealthIssueKey =
  | 'numbers_down'
  | 'account_reconnect'
  | 'quality_red'
  | 'send_failures_critical'
  | 'number_attention'
  | 'quality_yellow'
  | 'send_failures'
  | 'webhook_endpoints'
  | 'integrations'
  | 'dead_letters'
  | 'plan_past_due';

export interface HealthIssue {
  key: HealthIssueKey;
  severity: OpsSeverity;
  detail: string;
}

export type HealthLevel = 'ok' | OpsSeverity;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

/** Upper-cased rating, or null when Meta has not rated the number (NA, UNKNOWN or nothing). */
export function qualityRank(rating: string | null): 'RED' | 'YELLOW' | 'GREEN' | null {
  const upper = rating?.toUpperCase();
  return upper === 'RED' || upper === 'YELLOW' || upper === 'GREEN' ? upper : null;
}

/** The issues a company's facts show, most severe first. */
export function healthIssues(facts: CompanyHealthFacts): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const broken = facts.numbersReconnect + facts.numbersFailed;
  if (broken > 0 && facts.numbersActive === 0) {
    issues.push({
      key: 'numbers_down',
      severity: 'critical',
      detail: `No active WhatsApp number: ${plural(broken, 'number')} to reconnect or set up again`,
    });
  } else if (broken > 0) {
    issues.push({
      key: 'number_attention',
      severity: 'warning',
      detail: `${plural(broken, 'number')} to reconnect or set up again`,
    });
  }
  if (facts.accountsReconnect > 0) {
    issues.push({
      key: 'account_reconnect',
      severity: 'critical',
      detail: `${plural(facts.accountsReconnect, 'WhatsApp account')} to reconnect`,
    });
  }
  const quality = qualityRank(facts.qualityRating);
  if (quality === 'RED') {
    issues.push({ key: 'quality_red', severity: 'critical', detail: 'A number is rated RED' });
  } else if (quality === 'YELLOW') {
    issues.push({ key: 'quality_yellow', severity: 'warning', detail: 'A number is rated YELLOW' });
  }
  if (facts.outbound24h >= OPS_HEALTH_RULES.minOutbound24h && facts.failed24h > 0) {
    const rate = facts.failed24h / facts.outbound24h;
    const detail = `${facts.failed24h} of ${facts.outbound24h} messages failed in 24 hours (${percent(facts.failed24h, facts.outbound24h)})`;
    if (rate >= OPS_HEALTH_RULES.criticalFailureRate) {
      issues.push({ key: 'send_failures_critical', severity: 'critical', detail });
    } else if (rate >= OPS_HEALTH_RULES.warningFailureRate) {
      issues.push({ key: 'send_failures', severity: 'warning', detail });
    }
  }
  const endpoints = facts.endpointsFailing + facts.endpointsAutoDisabled;
  if (endpoints > 0) {
    issues.push({
      key: 'webhook_endpoints',
      severity: 'warning',
      detail: `${plural(endpoints, 'webhook endpoint')} failing or turned off for failing`,
    });
  }
  const failedIntegrations = [
    facts.storesFailed > 0 ? plural(facts.storesFailed, 'store') : null,
    facts.paymentAccountsFailed > 0 ? 'payment account check' : null,
    facts.catalogSyncsFailed > 0 ? 'catalog sync' : null,
    facts.flowSyncsFailed > 0 ? plural(facts.flowSyncsFailed, 'Flow sync') : null,
  ].filter((part): part is string => part !== null);
  if (failedIntegrations.length > 0) {
    issues.push({
      key: 'integrations',
      severity: 'warning',
      detail: `Failed: ${failedIntegrations.join(', ')}`,
    });
  }
  if (facts.deadLetters7d > 0) {
    issues.push({
      key: 'dead_letters',
      severity: 'warning',
      detail: `${plural(facts.deadLetters7d, 'job')} dead-lettered in 7 days`,
    });
  }
  if (facts.planStatus === 'past_due') {
    issues.push({ key: 'plan_past_due', severity: 'warning', detail: 'Plan past due' });
  }
  return issues.sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));
}

function severityOrder(severity: OpsSeverity): number {
  return severity === 'critical' ? 0 : 1;
}

export function healthLevel(issues: HealthIssue[]): HealthLevel {
  if (issues.some((i) => i.severity === 'critical')) return 'critical';
  return issues.length > 0 ? 'warning' : 'ok';
}

/** What `ops.platform_ops_activity` returns for one company. */
export interface CompanyActivity {
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  outbound: number;
  outboundBySender: { agent: number; bot: number; campaign: number; api: number; system: number };
  failed: number;
  inbound: number;
  marketingSent: number;
  marketingDelivered: number;
  error131049: number;
  error131050: number;
  marketingOptOuts: number;
  complaints: number;
  webhookDeliveries: number;
  automationRuns: number;
  runsPeriodStart: Date | null;
  members: number;
  numbers: number;
}

/**
 * A company's sending and receipts in the window before the Usage tab's (ADR-157): the 7 or 30 days
 * before. The 90-day window has none: the activity function reads at most 93 days back.
 */
export interface UsagePrevious {
  outbound: number;
  inbound: number;
}

/**
 * A company's line on the console's Usage tab (ADR-153): its activity and the plan's counter of its
 * API requests, the latest period's (as `automationRuns`), with the period's start; 0 and null when
 * its keys have made no request. `previous` is the window before (ADR-157), null for 90 days.
 */
export interface CompanyUsage extends CompanyActivity {
  apiRequests: number;
  apiPeriodStart: Date | null;
  previous: UsagePrevious | null;
}

/**
 * How a count moved from the window before (ADR-157): `+25%`, `-40%`, `0%`, `none before` when it
 * was 0, and null when it is 0 in both.
 */
export function usageChange(current: number, previous: number): string | null {
  if (previous === 0) return current === 0 ? null : 'none before';
  const percent = Math.round(((current - previous) / previous) * 100);
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

/**
 * The console's lists staff can download as CSV: the Usage tab (ADR-154), every company's health
 * and the Signals tab (ADR-155), and every list of the Onboarding, Integrations and Queues tabs
 * (ADR-158).
 */
export const OPS_EXPORT_LISTS = [
  'usage',
  'health',
  'signals',
  'signups',
  'number-setups',
  'new-companies',
  'failures',
  'receipts',
  'quarantine',
  'emails',
  'queues',
  'dead-letters',
] as const;
export type OpsExportList = (typeof OPS_EXPORT_LISTS)[number];

export function isOpsExportList(value: string): value is OpsExportList {
  return (OPS_EXPORT_LISTS as readonly string[]).includes(value);
}

/** The platform audit log's action for an export: `platform.ops_number_setups_exported`. */
export function opsExportAction(list: OpsExportList): string {
  return `platform.ops_${list.replaceAll('-', '_')}_exported`;
}

/** The Usage tab's columns in its CSV (ADR-154). */
export const USAGE_CSV_COLUMNS = [
  'Company',
  'Address',
  'Status',
  'Sent',
  'Sent by agents',
  'Sent by automations',
  'Sent by campaigns',
  'Sent through the API',
  'Sent by the system',
  'Failed',
  'Received',
  'Webhook deliveries',
  'Automation runs',
  'Automation runs from',
  'API requests',
  'API requests from',
  'Members',
  'Numbers',
  'Sent in the window before',
  'Received in the window before',
] as const;

const csvDay = (at: Date | null) => (at ? at.toISOString().slice(0, 10) : '');
/** A time to the minute in UTC, as `2026-10-05 06:30`, which spreadsheets read as a time. */
const csvMinute = (at: Date | null) => (at ? at.toISOString().slice(0, 16).replace('T', ' ') : '');

const csvFile = (
  columns: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string => CSV_BOM + csvLine(columns) + rows.map((row) => csvLine(row)).join('');

/**
 * The Usage tab as CSV (ADR-154): a line per company in the tab's order, formula-safe (a company
 * name starting with `=`, `+`, `-` or `@` is neutralised), the counters' periods as UTC days, and
 * the window before's sending and receipts, empty for 90 days (ADR-157).
 */
export function usageCsv(rows: readonly CompanyUsage[]): string {
  return csvFile(
    USAGE_CSV_COLUMNS,
    rows.map((r) => [
      r.name,
      r.slug,
      r.status,
      r.outbound,
      r.outboundBySender.agent,
      r.outboundBySender.bot,
      r.outboundBySender.campaign,
      r.outboundBySender.api,
      r.outboundBySender.system,
      r.failed,
      r.inbound,
      r.webhookDeliveries,
      r.automationRuns,
      csvDay(r.runsPeriodStart),
      r.apiRequests,
      csvDay(r.apiPeriodStart),
      r.members,
      r.numbers,
      r.previous?.outbound ?? null,
      r.previous?.inbound ?? null,
    ]),
  );
}

/** A company's health: its facts, the issues they show and the worst issue's level. */
export interface CompanyHealth {
  facts: CompanyHealthFacts;
  issues: HealthIssue[];
  level: HealthLevel;
}

const LEVEL_ORDER: Record<HealthLevel, number> = { critical: 0, warning: 1, ok: 2 };

/** Worst first: critical, then warnings, then healthy; more issues first; then by name. */
export function byHealth(a: CompanyHealth, b: CompanyHealth): number {
  return (
    LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
    b.issues.length - a.issues.length ||
    a.facts.name.localeCompare(b.facts.name)
  );
}

/** The columns of every company's health in its CSV (ADR-155). */
export const HEALTH_CSV_COLUMNS = [
  'Company',
  'Address',
  'Status',
  'Plan status',
  'Created',
  'Health',
  'Issues',
  'WhatsApp numbers',
  'Active numbers',
  'Numbers to reconnect',
  'Numbers failed',
  'Worst quality rating',
  'Quality checked (UTC)',
  'WhatsApp accounts to reconnect',
  'Sent in 24 hours',
  'Failed in 24 hours',
  'Received in 24 hours',
  'Last message (UTC)',
  'Webhook endpoints failing',
  'Webhook endpoints turned off for failing (7 days)',
  'Stores failing',
  'Payment accounts failed',
  'Catalog syncs failed',
  'Flow syncs failed',
  'Dead letters (7 days)',
] as const;

/**
 * Every company's health as CSV (ADR-155), in the order given (worst first, `byHealth`): the
 * facts the Overview and a company's page show, its issues as the console words them, times in UTC.
 */
export function healthCsv(rows: readonly CompanyHealth[]): string {
  return csvFile(
    HEALTH_CSV_COLUMNS,
    rows.map(({ facts: f, issues, level }) => [
      f.name,
      f.slug,
      f.status,
      f.planStatus,
      csvDay(f.createdAt),
      level,
      issues.map((i) => i.detail).join('; '),
      f.numbersTotal,
      f.numbersActive,
      f.numbersReconnect,
      f.numbersFailed,
      qualityRank(f.qualityRating),
      csvMinute(f.qualityCheckedAt),
      f.accountsReconnect,
      f.outbound24h,
      f.failed24h,
      f.inbound24h,
      csvMinute(f.lastMessageAt),
      f.endpointsFailing,
      f.endpointsAutoDisabled,
      f.storesFailed,
      f.paymentAccountsFailed,
      f.catalogSyncsFailed,
      f.flowSyncsFailed,
      f.deadLetters7d,
    ]),
  );
}

/** A company's line on the Signals tab: its activity over the window, quality and signals. */
export interface CompanySignals {
  activity: CompanyActivity;
  quality: string | null;
  flags: SignalFlag[];
}

/** The Signals tab's columns in its CSV (ADR-155). */
export const SIGNALS_CSV_COLUMNS = [
  'Company',
  'Address',
  'Status',
  'Sent',
  'Failed',
  'Marketing delivered',
  'Marketing opt-outs',
  'Stopped marketing (131050)',
  'Per-user marketing limit (131049)',
  'Complaints',
  'Worst quality rating',
  'Signals',
] as const;

/** The Signals tab as CSV (ADR-155): a line per company in the tab's order, signals as worded. */
export function signalsCsv(rows: readonly CompanySignals[]): string {
  return csvFile(
    SIGNALS_CSV_COLUMNS,
    rows.map(({ activity: a, quality, flags }) => [
      a.name,
      a.slug,
      a.status,
      a.outbound,
      a.failed,
      a.marketingDelivered,
      a.marketingOptOuts,
      a.error131050,
      a.error131049,
      a.complaints,
      qualityRank(quality),
      flags.map((f) => f.detail).join('; '),
    ]),
  );
}

/**
 * `hyfib-usage-30-days-2026-10-05.csv`, `hyfib-health-2026-10-05.csv`,
 * `hyfib-dead-letters-2026-10-05.csv`: the list, its window when it has one and the UTC day of the
 * export.
 */
export function opsCsvFilename(list: OpsExportList, at: Date, days?: number): string {
  return `hyfib-${list}${days === undefined ? '' : `-${days}-days`}-${csvDay(at)}.csv`;
}

export type SignalKey =
  | 'send_failures'
  | 'marketing_opt_outs'
  | 'stopped_marketing'
  | 'per_user_limit'
  | 'complaints'
  | 'quality';

export interface SignalFlag {
  key: SignalKey;
  detail: string;
}

/** Review signals from a company's activity over the signal window and its numbers' quality. */
export function signalFlags(activity: CompanyActivity, qualityRating: string | null): SignalFlag[] {
  const rules = OPS_SIGNAL_RULES;
  const flags: SignalFlag[] = [];
  if (
    activity.outbound >= rules.minOutbound &&
    activity.failed / activity.outbound >= rules.failureRate
  ) {
    flags.push({
      key: 'send_failures',
      detail: `${activity.failed} of ${activity.outbound} messages failed (${percent(activity.failed, activity.outbound)})`,
    });
  }
  if (
    activity.marketingDelivered >= rules.minMarketingDelivered &&
    activity.marketingOptOuts / activity.marketingDelivered >= rules.optOutRate
  ) {
    flags.push({
      key: 'marketing_opt_outs',
      detail: `${activity.marketingOptOuts} marketing opt-outs for ${activity.marketingDelivered} marketing templates delivered (${percent(activity.marketingOptOuts, activity.marketingDelivered)})`,
    });
  }
  if (activity.error131050 >= rules.stoppedMarketing) {
    flags.push({
      key: 'stopped_marketing',
      detail: `${activity.error131050} sends to people who stopped marketing messages (131050)`,
    });
  }
  if (activity.error131049 >= rules.perUserLimit) {
    flags.push({
      key: 'per_user_limit',
      detail: `${activity.error131049} sends held back by Meta's per-user marketing limit (131049)`,
    });
  }
  if (activity.complaints >= rules.complaints) {
    flags.push({
      key: 'complaints',
      detail: `${plural(activity.complaints, 'number')} suppressed after complaints`,
    });
  }
  const quality = qualityRank(qualityRating);
  if (quality === 'RED' || quality === 'YELLOW') {
    flags.push({ key: 'quality', detail: `A number is rated ${quality}` });
  }
  return flags;
}

export const INTEGRATION_SOURCE_LABELS: Record<string, string> = {
  whatsapp_number: 'WhatsApp number',
  whatsapp_account: 'WhatsApp account',
  whatsapp_access_check: 'WhatsApp access check',
  whatsapp_webhooks: 'WhatsApp webhooks',
  store: 'Store',
  payment_account: 'Payment account',
  catalog_sync: 'Catalog sync',
  flow_sync: 'Flow sync',
  webhook_endpoint: 'Webhook endpoint',
};

export const INTEGRATION_STATE_LABELS: Record<string, string> = {
  needs_reconnect: 'Needs reconnecting',
  failed: 'Failed',
  sync_error: 'Sync error',
  webhook_error: 'Webhook error',
  failing: 'Failing',
  disabled: 'Turned off for failing',
  not_checked: 'Could not be checked',
  not_subscribed: 'Not subscribed',
};

export const QUARANTINE_REASON_LABELS: Record<string, string> = {
  unknown_asset: 'Unknown account or number',
  asset_mismatch: 'Number not in the account it came with',
  malformed: 'Malformed',
  unsupported_object: 'Unsupported object',
};

/** Provider ids a quarantine entry may show: account, number, field, payment and order ids. */
const QUARANTINE_ID_KEYS = ['waba', 'phoneNumberId', 'field', 'paymentId', 'orderId'];

/**
 * The provider ids of a quarantine entry that staff may see. Anything else the entry holds, and any
 * value that is not a short plain id, stays out of the console.
 */
export function quarantineExternalIds(
  value: Record<string, unknown>,
): { key: string; value: string }[] {
  return Object.entries(value)
    .filter(
      ([key, v]) =>
        QUARANTINE_ID_KEYS.includes(key) &&
        typeof v === 'string' &&
        /^[A-Za-z0-9_.-]{1,64}$/.test(v),
    )
    .map(([key, v]) => ({ key, value: v as string }));
}

export const WEBHOOK_PROVIDER_LABELS: Record<string, string> = {
  meta_whatsapp: 'Meta (WhatsApp)',
  razorpay: 'Razorpay',
};

/** The steps of a number's setup, as the Onboarding tab names them. */
export const NUMBER_SETUP_STEP_LABELS: Record<string, string> = {
  subscribe_app: 'Subscribing the app',
  register_number: 'Registering the number',
  health_check: 'Checking the number',
  done: 'Done',
};

/** An Embedded Signup session that failed, or was abandoned when it expired (ADR-054). */
export interface SignupProblem {
  sessionId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  outcome: 'failed' | 'abandoned';
  failureReason: string | null;
  startedAt: Date;
  hasActiveNumber: boolean;
}

/** A number whose setup failed, or has run for over `stuckSetupMinutes` (ADR-054). */
export interface NumberSetupProblem {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  /** The number as Meta displays it, once Meta gave it. */
  phone: string | null;
  phoneNumberId: string;
  status: string;
  step: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  stuck: boolean;
}

/** A company created in the onboarding window that has no active number (ADR-054). */
export interface CompanyWithoutNumber {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
  /** Whether one of its numbers is being set up. */
  inProgress: boolean;
}

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
  /**
   * A platform administrator's acknowledgement of this failure (ADR-141): when, by whom (null once
   * the account has no name) and the note; null while nobody has taken it.
   */
  acknowledgement: { at: Date; byName: string | null; note: string } | null;
  /**
   * The platform administrator this failure is assigned to (ADR-313): when, to whom (their account
   * and name, null once the account has none) and by whom; null while it is assigned to nobody.
   */
  assignment: {
    at: Date;
    assigneeUserId: string;
    assigneeName: string | null;
    byName: string | null;
  } | null;
}

/**
 * What Current failures lists: every failure, only those assigned to the administrator reading the
 * console (ADR-315), or only those assigned to nobody (ADR-318).
 */
export type IntegrationFailureView = 'all' | 'mine' | 'unassigned';

/**
 * The view the Integrations tab's query string names (`?failures=mine`, `?failures=unassigned`);
 * anything else is all.
 */
export function integrationFailureView(value: unknown): IntegrationFailureView {
  return value === 'mine' || value === 'unassigned' ? value : 'all';
}

/** A platform administrator a failure can be assigned to (ADR-313), by account and name. */
export interface PlatformAdministrator {
  userId: string;
  name: string | null;
  /** When the account became a platform administrator. */
  since: Date;
}

/** An administrator as the Assign list offers them (ADR-325): the account and what it reads. */
export interface PlatformAdministratorChoice {
  userId: string;
  label: string;
}

/**
 * How the Assign list names each administrator (ADR-325): by name, the reader marked "(you)", and
 * any other administrator whose name another one shares with when they became one, to the minute
 * (UTC), and their place among those still alike, so no two choices read the same. Never an email
 * address: the console shows none (ADR-054). In the order given.
 */
export function platformAdministratorChoices(
  administrators: readonly PlatformAdministrator[],
  readerUserId: string,
): PlatformAdministratorChoice[] {
  // A list option shows runs of spaces as one, so names are compared and shown that way.
  const nameOf = (a: PlatformAdministrator) =>
    a.name?.replace(/\s+/g, ' ').trim() || 'An administrator without a name';
  const shared = (a: PlatformAdministrator) =>
    administrators.some((b) => b.userId !== a.userId && nameOf(b) === nameOf(a));
  const labelled = administrators.map((a) => ({
    userId: a.userId,
    label:
      a.userId === readerUserId
        ? `${nameOf(a)} (you)`
        : shared(a)
          ? `${nameOf(a)} (administrator since ${csvMinute(a.since)} UTC)`
          : nameOf(a),
  }));
  // Names are the administrators' own, so a place is added until the label is one no other choice
  // has or could have: never a label already given, nor one another choice reads before its place.
  const plain = new Set(labelled.map((c) => c.label));
  const given = new Set<string>();
  return labelled.map((c) => {
    const alike = labelled.filter((d) => d.label === c.label).length > 1;
    let label = c.label;
    let place = 0;
    while ((alike && place === 0) || given.has(label) || (place > 0 && plain.has(label))) {
      place += 1;
      label = `${c.label} #${place}`;
    }
    given.add(label);
    return { ...c, label };
  });
}

export type ReceiptProblem = 'exhausted' | 'waiting';

export const RECEIPT_PROBLEM_LABELS: Record<ReceiptProblem, string> = {
  exhausted: 'Failed all attempts',
  waiting: 'Still waiting',
};

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
  /** Who noted that they looked at it, when, and what they noted (ADR-179). */
  acknowledgement: { at: Date; byName: string | null; note: string } | null;
}

/** An open quarantine entry, with only the provider ids staff may see (`quarantineExternalIds`). */
export interface QuarantineEntry {
  id: string;
  receiptId: string;
  provider: string;
  reason: string;
  externalIds: { key: string; value: string }[];
  createdAt: Date;
  /** When platform staff were emailed about it (ADR-091). */
  alertedAt: Date | null;
  /** Whether its receipt can be processed again: quarantined, with its body still kept. */
  retryable: boolean;
  /** Who noted that they looked at it, when, and what they noted (ADR-199). */
  acknowledgement: { at: Date; byName: string | null; note: string } | null;
}

/** One kind of email's failed and waiting counts over `emailDays` (counts only). */
export interface EmailDeliveryCount {
  kind: string;
  failed: number;
  /** Due for over 15 minutes and not sent. */
  stuck: number;
}

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
  /** Who noted that they looked at it while it is late, when, and what they noted (ADR-177). */
  acknowledgement: { at: Date; byName: string | null; note: string } | null;
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

/** A dead letter the Queues tab lists (ADR-054), and whether its job can be retried (ADR-108). */
export interface DeadLetterLine {
  id: string;
  sourceQueue: string;
  failedAt: Date;
  verified: boolean;
  /** The job's company, set only when its signature verified. */
  tenantId: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
  ref: string | null;
  errorName: string | null;
  errorCode: string | null;
  retries: number | null;
  /** When platform staff were emailed about it (ADR-091). */
  alertedAt: Date | null;
  retriedAt: Date | null;
  /** Who retried it, for the console only: the CSV leaves it out. */
  retriedByName: string | null;
  /** When the sweep settled its work for its company, and whether that ended it (ADR-111). */
  settledAt: Date | null;
  settledEnded: boolean | null;
  retryable: boolean;
  retryableUntil: Date | null;
  retryBlock: DeadLetterRetryBlock | null;
  /** When an administrator acknowledged it (ADR-169); who and the note stay in the console. */
  acknowledgedAt: Date | null;
  acknowledgedByName: string | null;
  acknowledgement: string | null;
}

/*
 * The Onboarding, Integrations and Queues tabs' lists as CSV (ADR-158): each list's lines in the
 * tab's order with what the tab shows, through the same writer as the other lists (ADR-154). Who
 * acknowledged a failure or retried a job, and the notes staff wrote, are left out: they stay in the
 * console and the platform audit log.
 */

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

/** A wait in whole minutes, none when nothing waited; a worker's clock a little ahead reads as 0. */
const waitMinutes = (ms: number | null) =>
  ms === null ? null : Math.floor(Math.max(ms, 0) / 60_000);

export const SIGNUPS_CSV_COLUMNS = [
  'Company',
  'Address',
  'Outcome',
  'Reason',
  'Started (UTC)',
  'Active number now',
] as const;

/** Signups that failed or were abandoned in the Onboarding tab's window. */
export function signupsCsv(rows: readonly SignupProblem[]): string {
  return csvFile(
    SIGNUPS_CSV_COLUMNS,
    rows.map((s) => [
      s.tenantName,
      s.tenantSlug,
      s.outcome === 'failed' ? 'Failed' : 'Abandoned',
      s.failureReason,
      csvMinute(s.startedAt),
      yesNo(s.hasActiveNumber),
    ]),
  );
}

export const NUMBER_SETUPS_CSV_COLUMNS = [
  'Company',
  'Address',
  'Number',
  'State',
  'Step',
  'Error',
  'Since (UTC)',
] as const;

/** Number setups that failed or are stuck. */
export function numberSetupsCsv(rows: readonly NumberSetupProblem[]): string {
  return csvFile(
    NUMBER_SETUPS_CSV_COLUMNS,
    rows.map((n) => [
      n.tenantName,
      n.tenantSlug,
      n.phone ?? n.phoneNumberId,
      n.stuck ? 'Stuck' : 'Failed',
      n.step === null ? null : (NUMBER_SETUP_STEP_LABELS[n.step] ?? n.step),
      n.error,
      csvMinute(n.updatedAt),
    ]),
  );
}

export const NEW_COMPANIES_CSV_COLUMNS = [
  'Company',
  'Address',
  'Status',
  'Created (UTC)',
  'Number being set up',
] as const;

/** Companies created in the Onboarding tab's window without an active number. */
export function newCompaniesCsv(rows: readonly CompanyWithoutNumber[]): string {
  return csvFile(
    NEW_COMPANIES_CSV_COLUMNS,
    rows.map((c) => [c.name, c.slug, c.status, csvMinute(c.createdAt), yesNo(c.inProgress)]),
  );
}

export const FAILURES_CSV_COLUMNS = [
  'Company',
  'Address',
  'What',
  'Label',
  'State',
  'Error',
  'Since (UTC)',
  'Acknowledged (UTC)',
] as const;

/** Current failures, an acknowledgement by its time only (ADR-141). */
export function failuresCsv(rows: readonly IntegrationFailure[]): string {
  return csvFile(
    FAILURES_CSV_COLUMNS,
    rows.map((f) => [
      f.tenantName,
      f.tenantSlug,
      INTEGRATION_SOURCE_LABELS[f.source] ?? f.source,
      f.label,
      INTEGRATION_STATE_LABELS[f.state] ?? f.state,
      f.error,
      csvMinute(f.since),
      csvMinute(f.acknowledgement?.at ?? null),
    ]),
  );
}

export const RECEIPTS_CSV_COLUMNS = [
  'Received (UTC)',
  'Receipt',
  'From',
  'Problem',
  'Attempts',
  'Last error',
  'Staff emailed (UTC)',
  'Retry',
  'Acknowledged (UTC)',
] as const;

/**
 * Meta and Razorpay receipts that failed all their attempts or have waited too long, and when one
 * was acknowledged (never who or the note, ADR-179).
 */
export function receiptsCsv(rows: readonly ReceiptNeedingAttention[]): string {
  return csvFile(
    RECEIPTS_CSV_COLUMNS,
    rows.map((r) => [
      csvMinute(r.receivedAt),
      r.id,
      WEBHOOK_PROVIDER_LABELS[r.provider] ?? r.provider,
      r.problem === 'exhausted' && r.status === 'processing'
        ? `${RECEIPT_PROBLEM_LABELS.exhausted}: its worker stopped during the last one`
        : RECEIPT_PROBLEM_LABELS[r.problem],
      r.attempts,
      r.lastError,
      csvMinute(r.alertedAt),
      r.retryable
        ? 'Can be retried'
        : r.problem === 'waiting'
          ? 'Retried by the sweep'
          : 'Body erased',
      csvMinute(r.acknowledgement?.at ?? null),
    ]),
  );
}

export const QUARANTINE_CSV_COLUMNS = [
  'Quarantined (UTC)',
  'Receipt',
  'From',
  'Reason',
  'Provider ids',
  'Staff emailed (UTC)',
  'Receipt can be retried',
  'Acknowledged (UTC)',
] as const;

/**
 * Open quarantine entries with the provider ids staff may see, and when one was acknowledged (never
 * who or the note, ADR-199).
 */
export function quarantineCsv(rows: readonly QuarantineEntry[]): string {
  return csvFile(
    QUARANTINE_CSV_COLUMNS,
    rows.map((q) => [
      csvMinute(q.createdAt),
      q.receiptId,
      WEBHOOK_PROVIDER_LABELS[q.provider] ?? q.provider,
      QUARANTINE_REASON_LABELS[q.reason] ?? q.reason,
      q.externalIds.map((e) => `${e.key}: ${e.value}`).join('; '),
      csvMinute(q.alertedAt),
      yesNo(q.retryable),
      csvMinute(q.acknowledgement?.at ?? null),
    ]),
  );
}

export const EMAILS_CSV_COLUMNS = ['Kind', 'Failed', 'Waiting'] as const;

/** Failed and waiting emails by kind: counts only, as an SMTP error can quote an address. */
export function emailsCsv(rows: readonly EmailDeliveryCount[]): string {
  return csvFile(
    EMAILS_CSV_COLUMNS,
    rows.map((e) => [e.kind, e.failed, e.stuck]),
  );
}

export const QUEUES_CSV_COLUMNS = [
  'Queue',
  'Declared by this release',
  'Retries',
  'Dead-lettered after its retries',
  'Wait limit (minutes)',
  'In the database',
  'Ready',
  'Deferred',
  'Active',
  'Failed',
  'Oldest wait (minutes)',
  'Late since (UTC)',
  'Staff emailed (UTC)',
  'Acknowledged (UTC)',
  'Waits checked (UTC)',
  'Dead letters (24 hours)',
  'Dead letters (7 days)',
] as const;

/**
 * Each queue's policy, pg-boss's counts, the oldest wait at the worker's last check in whole
 * minutes (empty when none waited or the queue was not checked), when a late queue was
 * acknowledged (never who or the note, ADR-177) and its dead letters.
 */
export function queuesCsv(rows: readonly QueueRow[]): string {
  return csvFile(
    QUEUES_CSV_COLUMNS,
    rows.map((q) => [
      q.name,
      yesNo(q.policy !== null),
      q.policy?.retryLimit ?? null,
      q.policy ? yesNo(q.policy.hasDeadLetter) : null,
      q.policy?.maxWaitMinutes ?? null,
      yesNo(q.counts !== null),
      q.counts?.ready ?? null,
      q.counts?.deferred ?? null,
      q.counts?.active ?? null,
      q.counts?.failed ?? null,
      q.wait ? waitMinutes(q.wait.oldestWaitMs) : null,
      csvMinute(q.wait?.lateSince ?? null),
      csvMinute(q.wait?.alertedAt ?? null),
      csvMinute(q.wait?.acknowledgement?.at ?? null),
      csvMinute(q.wait?.checkedAt ?? null),
      q.deadLetters.last24h,
      q.deadLetters.last7d,
    ]),
  );
}

export const DEAD_LETTERS_CSV_COLUMNS = [
  'Failed (UTC)',
  'Dead letter',
  'Queue',
  'Signature verified',
  'Company',
  'Address',
  'Reference',
  'Error',
  'Error code',
  'Retries',
  'Staff emailed (UTC)',
  'Retried (UTC)',
  'Work settled (UTC)',
  'Retry',
  'Can be retried until (UTC)',
  'Acknowledged (UTC)',
] as const;

/** What became of a dead letter's job, or whether it can be retried, as the Queues tab says. */
function deadLetterRetry(d: DeadLetterLine): string | null {
  if (d.retriedAt !== null) return 'Retried';
  if (d.settledAt !== null) {
    return d.settledEnded
      ? 'Work ended for its company, which can start it again'
      : 'Nothing left to end: the work had finished or was started again';
  }
  if (d.retryable) return 'Can be retried';
  return d.retryBlock === null ? null : DEAD_LETTER_RETRY_BLOCK_TEXT[d.retryBlock];
}

/** Recent dead letters: the company only through a verified signature, errors by name and code. */
export function deadLettersCsv(rows: readonly DeadLetterLine[]): string {
  return csvFile(
    DEAD_LETTERS_CSV_COLUMNS,
    rows.map((d) => [
      csvMinute(d.failedAt),
      d.id,
      d.sourceQueue,
      yesNo(d.verified),
      d.tenantName,
      d.tenantSlug,
      d.ref,
      d.errorName,
      d.errorCode,
      d.retries,
      csvMinute(d.alertedAt),
      csvMinute(d.retriedAt),
      csvMinute(d.settledAt),
      deadLetterRetry(d),
      d.retryable ? csvMinute(d.retryableUntil) : null,
      csvMinute(d.acknowledgedAt),
    ]),
  );
}
