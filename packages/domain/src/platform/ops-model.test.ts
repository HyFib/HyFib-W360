import { describe, expect, it } from 'vitest';
import {
  OPS_SIGNAL_RULES,
  healthIssues,
  healthLevel,
  qualityRank,
  quarantineExternalIds,
  signalFlags,
  USAGE_CSV_COLUMNS,
  usageCsv,
  usageCsvFilename,
  type CompanyActivity,
  type CompanyHealthFacts,
  type CompanyUsage,
} from './ops-model';

const healthy: CompanyHealthFacts = {
  tenantId: '0192a1b2-0000-7000-8000-000000000001',
  name: 'Acme',
  slug: 'acme',
  status: 'active',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  planStatus: 'active',
  numbersTotal: 1,
  numbersActive: 1,
  numbersReconnect: 0,
  numbersFailed: 0,
  qualityRating: 'GREEN',
  qualityCheckedAt: new Date('2026-09-27T00:00:00Z'),
  accountsReconnect: 0,
  outbound24h: 100,
  failed24h: 0,
  inbound24h: 10,
  lastMessageAt: new Date('2026-09-28T09:00:00Z'),
  endpointsFailing: 0,
  endpointsAutoDisabled: 0,
  storesFailed: 0,
  paymentAccountsFailed: 0,
  catalogSyncsFailed: 0,
  flowSyncsFailed: 0,
  deadLetters7d: 0,
};

const keys = (facts: Partial<CompanyHealthFacts>) =>
  healthIssues({ ...healthy, ...facts }).map((i) => `${i.severity}:${i.key}`);

describe('company health', () => {
  it('finds nothing wrong with a working company', () => {
    expect(healthIssues(healthy)).toEqual([]);
    expect(healthLevel(healthIssues(healthy))).toBe('ok');
  });

  it('is critical when no number works and a warning when one of several does not', () => {
    expect(keys({ numbersActive: 0, numbersReconnect: 1 })).toEqual(['critical:numbers_down']);
    expect(keys({ numbersActive: 0, numbersFailed: 1 })).toEqual(['critical:numbers_down']);
    expect(keys({ numbersTotal: 2, numbersReconnect: 1 })).toEqual(['warning:number_attention']);
    // A new company still setting up its first number is not broken.
    expect(keys({ numbersTotal: 1, numbersActive: 0 })).toEqual([]);
    expect(keys({ accountsReconnect: 1 })).toEqual(['critical:account_reconnect']);
  });

  it('rates quality by the worst active number, ignoring numbers Meta has not rated', () => {
    expect(keys({ qualityRating: 'RED' })).toEqual(['critical:quality_red']);
    expect(keys({ qualityRating: 'yellow' })).toEqual(['warning:quality_yellow']);
    expect(keys({ qualityRating: 'NA' })).toEqual([]);
    expect(keys({ qualityRating: 'UNKNOWN' })).toEqual([]);
    expect(keys({ qualityRating: null })).toEqual([]);
    expect(qualityRank('green')).toBe('GREEN');
  });

  it('judges send failures only with at least 20 messages in 24 hours', () => {
    expect(keys({ outbound24h: 19, failed24h: 19 })).toEqual([]);
    expect(keys({ outbound24h: 20, failed24h: 1 })).toEqual([]);
    expect(keys({ outbound24h: 20, failed24h: 2 })).toEqual(['warning:send_failures']);
    expect(keys({ outbound24h: 20, failed24h: 9 })).toEqual(['warning:send_failures']);
    expect(keys({ outbound24h: 20, failed24h: 10 })).toEqual(['critical:send_failures_critical']);
    const [issue] = healthIssues({ ...healthy, outbound24h: 40, failed24h: 5 });
    expect(issue?.detail).toBe('5 of 40 messages failed in 24 hours (13%)');
  });

  it('warns about failing webhooks, integrations, dead letters and an unpaid plan', () => {
    expect(keys({ endpointsFailing: 1 })).toEqual(['warning:webhook_endpoints']);
    expect(keys({ endpointsAutoDisabled: 2 })).toEqual(['warning:webhook_endpoints']);
    expect(keys({ deadLetters7d: 3 })).toEqual(['warning:dead_letters']);
    expect(keys({ planStatus: 'past_due' })).toEqual(['warning:plan_past_due']);
    expect(keys({ planStatus: 'trialing' })).toEqual([]);
    const [integration] = healthIssues({
      ...healthy,
      storesFailed: 2,
      paymentAccountsFailed: 1,
      catalogSyncsFailed: 1,
      flowSyncsFailed: 1,
    });
    expect(integration?.detail).toBe(
      'Failed: 2 stores, payment account check, catalog sync, 1 Flow sync',
    );
  });

  it('lists critical issues first and takes the worst level', () => {
    const issues = healthIssues({
      ...healthy,
      deadLetters7d: 1,
      qualityRating: 'RED',
      endpointsFailing: 1,
    });
    expect(issues.map((i) => i.severity)).toEqual(['critical', 'warning', 'warning']);
    expect(healthLevel(issues)).toBe('critical');
    expect(healthLevel(healthIssues({ ...healthy, deadLetters7d: 1 }))).toBe('warning');
  });
});

const quiet: CompanyActivity = {
  tenantId: healthy.tenantId,
  name: 'Acme',
  slug: 'acme',
  status: 'active',
  outbound: 0,
  outboundBySender: { agent: 0, bot: 0, campaign: 0, api: 0, system: 0 },
  failed: 0,
  inbound: 0,
  marketingSent: 0,
  marketingDelivered: 0,
  error131049: 0,
  error131050: 0,
  marketingOptOuts: 0,
  complaints: 0,
  webhookDeliveries: 0,
  automationRuns: 0,
  runsPeriodStart: null,
  members: 1,
  numbers: 1,
};

const flags = (activity: Partial<CompanyActivity>, quality: string | null = 'GREEN') =>
  signalFlags({ ...quiet, ...activity }, quality).map((f) => f.key);

describe('review signals', () => {
  const r = OPS_SIGNAL_RULES;

  it('flags send failures only with enough messages', () => {
    expect(flags({ outbound: r.minOutbound - 1, failed: r.minOutbound - 1 })).toEqual([]);
    expect(flags({ outbound: 100, failed: 19 })).toEqual([]);
    expect(flags({ outbound: 100, failed: 20 })).toEqual(['send_failures']);
  });

  it('flags marketing opt-outs against marketing templates delivered', () => {
    expect(flags({ marketingDelivered: 99, marketingOptOuts: 50 })).toEqual([]);
    expect(flags({ marketingDelivered: 100, marketingOptOuts: 1 })).toEqual([]);
    expect(flags({ marketingDelivered: 100, marketingOptOuts: 2 })).toEqual(['marketing_opt_outs']);
  });

  it("flags Meta's marketing errors, complaints and low quality at their thresholds", () => {
    expect(flags({ error131050: r.stoppedMarketing - 1 })).toEqual([]);
    expect(flags({ error131050: r.stoppedMarketing })).toEqual(['stopped_marketing']);
    expect(flags({ error131049: r.perUserLimit - 1 })).toEqual([]);
    expect(flags({ error131049: r.perUserLimit })).toEqual(['per_user_limit']);
    expect(flags({ complaints: r.complaints - 1 })).toEqual([]);
    expect(flags({ complaints: r.complaints })).toEqual(['complaints']);
    expect(flags({}, 'RED')).toEqual(['quality']);
    expect(flags({}, 'YELLOW')).toEqual(['quality']);
    expect(flags({}, 'NA')).toEqual([]);
  });

  it('explains each flag in words', () => {
    const [flag] = signalFlags({ ...quiet, error131050: 25 }, null);
    expect(flag?.detail).toBe('25 sends to people who stopped marketing messages (131050)');
  });
});

describe('quarantine ids', () => {
  it('shows only allow-listed provider ids with plain values', () => {
    expect(
      quarantineExternalIds({
        waba: '102290129340398',
        phoneNumberId: '106540352242922',
        paymentId: 'pay_E2EUnknown0001',
        orderId: null,
        from: '919876500001',
        field: 'Hi +91 98765 00001, your code is 1234',
        text: 'Is my parcel out yet?',
      }),
    ).toEqual([
      { key: 'waba', value: '102290129340398' },
      { key: 'phoneNumberId', value: '106540352242922' },
      { key: 'paymentId', value: 'pay_E2EUnknown0001' },
    ]);
    expect(quarantineExternalIds({ field: 'x'.repeat(65) })).toEqual([]);
    expect(quarantineExternalIds({ field: 'messages' })).toEqual([
      { key: 'field', value: 'messages' },
    ]);
  });
});

describe('the Usage tab as CSV (ADR-154)', () => {
  const busy: CompanyUsage = {
    ...quiet,
    name: '=HYPERLINK("https://example.com")',
    outbound: 5,
    outboundBySender: { agent: 1, bot: 1, campaign: 2, api: 1, system: 0 },
    failed: 1,
    inbound: 3,
    webhookDeliveries: 4,
    automationRuns: 7,
    runsPeriodStart: new Date('2026-09-01T00:00:00Z'),
    members: 2,
    apiRequests: 42,
    apiPeriodStart: new Date('2026-09-15T05:30:00Z'),
  };
  const idle: CompanyUsage = {
    ...quiet,
    name: 'Quiet, Ltd',
    slug: 'quiet',
    status: 'suspended',
    apiRequests: 0,
    apiPeriodStart: null,
  };

  it('writes the tab’s columns and a line per company, formula-safe, periods as UTC days', () => {
    const csv = usageCsv([busy, idle]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      USAGE_CSV_COLUMNS.join(','),
      `"'=HYPERLINK(""https://example.com"")",acme,active,5,1,1,2,1,0,1,3,4,7,2026-09-01,42,2026-09-15,2,1`,
      '"Quiet, Ltd",quiet,suspended,0,0,0,0,0,0,0,0,0,0,,0,,1,1',
      '',
    ]);
    expect(USAGE_CSV_COLUMNS).toHaveLength(18);
    expect(usageCsv([])).toBe(`\uFEFF${USAGE_CSV_COLUMNS.join(',')}\r\n`);
  });

  it('names the file by its window and the UTC day it was made', () => {
    expect(usageCsvFilename(30, new Date('2026-10-05T23:30:00Z'))).toBe(
      'hyfib-usage-30-days-2026-10-05.csv',
    );
    expect(usageCsvFilename(7, new Date('2026-10-06T00:00:00Z'))).toBe(
      'hyfib-usage-7-days-2026-10-06.csv',
    );
  });
});
