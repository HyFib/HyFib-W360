import { describe, expect, it } from 'vitest';
import {
  HEALTH_CSV_COLUMNS,
  OPS_SIGNAL_RULES,
  SIGNALS_CSV_COLUMNS,
  USAGE_CSV_COLUMNS,
  byHealth,
  healthCsv,
  healthIssues,
  healthLevel,
  isOpsExportList,
  opsCsvFilename,
  qualityRank,
  quarantineExternalIds,
  signalFlags,
  signalsCsv,
  usageChange,
  usageCsv,
  type CompanyActivity,
  type CompanyHealth,
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
    previous: { outbound: 9, inbound: 0 },
  };
  const idle: CompanyUsage = {
    ...quiet,
    name: 'Quiet, Ltd',
    slug: 'quiet',
    status: 'suspended',
    apiRequests: 0,
    apiPeriodStart: null,
    previous: null,
  };

  it('writes the tab’s columns and a line per company, formula-safe, periods as UTC days', () => {
    const csv = usageCsv([busy, idle]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      USAGE_CSV_COLUMNS.join(','),
      `"'=HYPERLINK(""https://example.com"")",acme,active,5,1,1,2,1,0,1,3,4,7,2026-09-01,42,2026-09-15,2,1,9,0`,
      // No window before (90 days): its two columns stay empty.
      '"Quiet, Ltd",quiet,suspended,0,0,0,0,0,0,0,0,0,0,,0,,1,1,,',
      '',
    ]);
    expect(USAGE_CSV_COLUMNS).toHaveLength(20);
    expect(usageCsv([])).toBe(`\uFEFF${USAGE_CSV_COLUMNS.join(',')}\r\n`);
  });

  it('names the file by its window and the UTC day it was made', () => {
    expect(opsCsvFilename('usage', new Date('2026-10-05T23:30:00Z'), 30)).toBe(
      'hyfib-usage-30-days-2026-10-05.csv',
    );
    expect(opsCsvFilename('usage', new Date('2026-10-06T00:00:00Z'), 7)).toBe(
      'hyfib-usage-7-days-2026-10-06.csv',
    );
  });
});

describe('usage against the window before (ADR-157)', () => {
  it('says how a count moved, rounded, and nothing when it is 0 in both', () => {
    expect(usageChange(125, 100)).toBe('+25%');
    expect(usageChange(60, 100)).toBe('-40%');
    expect(usageChange(0, 3)).toBe('-100%');
    expect(usageChange(1001, 1000)).toBe('0%');
    expect(usageChange(999, 1000)).toBe('0%');
    expect(usageChange(2, 3)).toBe('-33%');
    expect(usageChange(5, 0)).toBe('none before');
    expect(usageChange(0, 0)).toBeNull();
  });
});

describe('the health and signals lists as CSV (ADR-155)', () => {
  const assess = (facts: Partial<CompanyHealthFacts>): CompanyHealth => {
    const all = { ...healthy, ...facts };
    const issues = healthIssues(all);
    return { facts: all, issues, level: healthLevel(issues) };
  };

  it('orders companies worst first, then by how many issues, then by name', () => {
    const fine = assess({ name: 'Able' });
    const alsoFine = assess({ name: 'Baker' });
    const warned = assess({ name: 'Cobalt', deadLetters7d: 1 });
    // Two warnings come before one, whatever the names.
    const twice = assess({ name: 'Delta', deadLetters7d: 1, endpointsFailing: 1 });
    const critical = assess({ name: 'Echo', accountsReconnect: 1 });
    expect(
      [alsoFine, warned, fine, critical, twice].sort(byHealth).map((c) => c.facts.name),
    ).toEqual(['Echo', 'Delta', 'Cobalt', 'Able', 'Baker']);
  });

  it('writes every company’s facts, level and issues, formula-safe, times to the minute in UTC', () => {
    const sick = assess({
      name: '+Sick',
      slug: 'sick',
      status: 'restricted',
      planStatus: 'past_due',
      numbersTotal: 3,
      numbersActive: 0,
      numbersReconnect: 2,
      numbersFailed: 1,
      qualityRating: 'yellow',
      qualityCheckedAt: new Date('2026-10-04T08:15:42Z'),
      accountsReconnect: 1,
      outbound24h: 7,
      failed24h: 4,
      inbound24h: 5,
      lastMessageAt: new Date('2026-10-05T06:30:59Z'),
      endpointsFailing: 2,
      endpointsAutoDisabled: 1,
      storesFailed: 3,
      paymentAccountsFailed: 4,
      catalogSyncsFailed: 5,
      flowSyncsFailed: 6,
      deadLetters7d: 8,
    });
    const fresh = assess({
      name: 'New, Ltd',
      slug: 'new',
      planStatus: null,
      numbersTotal: 0,
      numbersActive: 0,
      qualityRating: 'UNKNOWN',
      qualityCheckedAt: null,
      outbound24h: 0,
      inbound24h: 0,
      lastMessageAt: null,
    });
    const csv = healthCsv([sick, fresh]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      HEALTH_CSV_COLUMNS.join(','),
      // The issues hold commas, so the cell is quoted.
      `'+Sick,sick,restricted,past_due,2026-09-01,critical,"No active WhatsApp number: 3 numbers to reconnect or set up again; 1 WhatsApp account to reconnect; A number is rated YELLOW; 3 webhook endpoints failing or turned off for failing; Failed: 3 stores, payment account check, catalog sync, 6 Flow syncs; 8 jobs dead-lettered in 7 days; Plan past due",3,0,2,1,YELLOW,2026-10-04 08:15,1,7,4,5,2026-10-05 06:30,2,1,3,4,5,6,8`,
      '"New, Ltd",new,active,,2026-09-01,ok,,0,0,0,0,,,0,0,0,0,,0,0,0,0,0,0,0',
      '',
    ]);
    expect(HEALTH_CSV_COLUMNS).toHaveLength(25);
    expect(healthCsv([])).toBe(`\uFEFF${HEALTH_CSV_COLUMNS.join(',')}\r\n`);
  });

  it('writes the Signals tab’s lines with their signals in words', () => {
    const loud: CompanyActivity = {
      ...quiet,
      name: '@Loud',
      slug: 'loud',
      outbound: 120,
      failed: 30,
      marketingDelivered: 200,
      marketingOptOuts: 9,
      error131050: 21,
      error131049: 3,
      complaints: 5,
    };
    const csv = signalsCsv([
      { activity: loud, quality: 'red', flags: signalFlags(loud, 'red') },
      { activity: { ...quiet, outbound: 4 }, quality: null, flags: [] },
    ]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.slice(1).split('\r\n')).toEqual([
      SIGNALS_CSV_COLUMNS.join(','),
      "'@Loud,loud,active,120,30,200,9,21,3,5,RED,30 of 120 messages failed (25%); 9 marketing opt-outs for 200 marketing templates delivered (5%); 21 sends to people who stopped marketing messages (131050); 5 numbers suppressed after complaints; A number is rated RED",
      'Acme,acme,active,4,0,0,0,0,0,0,,',
      '',
    ]);
    expect(SIGNALS_CSV_COLUMNS).toHaveLength(12);
  });

  it('names the lists it exports and their files', () => {
    expect(['usage', 'health', 'signals', 'onboarding', ''].map(isOpsExportList)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(opsCsvFilename('health', new Date('2026-10-05T23:59:59Z'))).toBe(
      'hyfib-health-2026-10-05.csv',
    );
    expect(opsCsvFilename('signals', new Date('2026-10-05T00:00:00Z'), 7)).toBe(
      'hyfib-signals-7-days-2026-10-05.csv',
    );
  });
});
