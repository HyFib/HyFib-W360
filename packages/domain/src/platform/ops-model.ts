/**
 * The platform operations console's rules (ADR-054): which facts about a company make it need
 * attention, and which activity asks for a review. The thresholds are HyFib's own heuristics, not
 * Meta rules; nothing here acts on a company. Browser-safe: no I/O.
 */

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

export const OPS_WINDOWS = {
  /** Embedded Signup sessions and new companies shown on the onboarding page. */
  onboardingDays: 30,
  /** A number whose setup has run longer than this is shown as stuck. */
  stuckSetupMinutes: 30,
  /** A receipt still waiting after this long is shown as stuck. */
  stuckReceiptMinutes: 10,
  deadLetterDays: 7,
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
