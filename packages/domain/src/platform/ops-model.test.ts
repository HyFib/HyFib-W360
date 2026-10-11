import { describe, expect, it } from 'vitest';
import {
  DEAD_LETTERS_CSV_COLUMNS,
  EMAILS_CSV_COLUMNS,
  FAILURE_COMPANIES_CSV_COLUMNS,
  FAILURE_REASONS_CSV_COLUMNS,
  FAILURES_CSV_COLUMNS,
  HEALTH_CSV_COLUMNS,
  NEW_COMPANIES_CSV_COLUMNS,
  NUMBER_SETUPS_CSV_COLUMNS,
  OPS_EXPORT_LISTS,
  OPS_SIGNAL_RULES,
  OPS_LIST_ROWS,
  OPS_COMPANY_PAGE_ROWS,
  opsCompanyPage,
  QUARANTINE_CSV_COLUMNS,
  QUEUES_CSV_COLUMNS,
  RECEIPTS_CSV_COLUMNS,
  SIGNALS_CSV_COLUMNS,
  SIGNUPS_CSV_COLUMNS,
  USAGE_CSV_COLUMNS,
  byHealth,
  deadLettersCsv,
  emailsCsv,
  failureCompaniesCsv,
  failureReasonsCsv,
  failuresCsv,
  healthCsv,
  healthIssues,
  healthLevel,
  isOpsExportList,
  newCompaniesCsv,
  numberSetupsCsv,
  opsCsvFilename,
  opsExportAction,
  platformAdministratorChoices,
  qualityRank,
  quarantineCsv,
  quarantineExternalIds,
  queuesCsv,
  receiptsCsv,
  signalFlags,
  signalsCsv,
  signupsCsv,
  usageChange,
  usageCsv,
  type CompanyActivity,
  type CompanyHealth,
  type CompanyHealthFacts,
  type CompanyUsage,
  type DeadLetterLine,
  type QueueRow,
} from './ops-model';
import {
  failureCompanyYear,
  failureReasonYearMonths,
  type FailureReasonYear,
} from './failure-reasons';

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

describe('the onboarding, integrations and queues lists as CSV (ADR-158)', () => {
  const at = (iso: string) => new Date(iso);
  const lines = (csv: string) => {
    expect(csv.startsWith('\uFEFF')).toBe(true);
    return csv.slice(1).split('\r\n');
  };

  it('writes the Onboarding tab’s three lists as the tab shows them', () => {
    expect(
      lines(
        signupsCsv([
          {
            sessionId: 's1',
            tenantId: 't1',
            tenantName: '=Acme',
            tenantSlug: 'acme',
            outcome: 'failed',
            failureReason: 'Meta did not return a WhatsApp Business Account, try again.',
            startedAt: at('2026-10-05T06:30:59Z'),
            hasActiveNumber: false,
          },
          {
            sessionId: 's2',
            tenantId: 't2',
            tenantName: 'Beta',
            tenantSlug: 'beta',
            outcome: 'abandoned',
            failureReason: null,
            startedAt: at('2026-10-04T23:05:00Z'),
            hasActiveNumber: true,
          },
        ]),
      ),
    ).toEqual([
      SIGNUPS_CSV_COLUMNS.join(','),
      `'=Acme,acme,Failed,"Meta did not return a WhatsApp Business Account, try again.",2026-10-05 06:30,No`,
      'Beta,beta,Abandoned,,2026-10-04 23:05,Yes',
      '',
    ]);
    const setup = {
      id: 'n1',
      tenantId: 't1',
      tenantName: 'Acme',
      tenantSlug: 'acme',
      phone: '+91 90000 22222',
      phoneNumberId: '123',
      status: 'failed',
      step: 'register_number',
      error: 'Meta refused the PIN.',
      createdAt: at('2026-10-05T06:00:00Z'),
      updatedAt: at('2026-10-05T07:00:00Z'),
      stuck: false,
    };
    expect(
      lines(
        numberSetupsCsv([
          setup,
          {
            ...setup,
            tenantName: 'Beta',
            tenantSlug: 'beta',
            phone: null,
            phoneNumberId: '1098765432',
            status: 'onboarding',
            step: 'mystery_step',
            error: null,
            updatedAt: at('2026-10-05T06:00:00Z'),
            stuck: true,
          },
          { ...setup, phone: '+919000033333', step: null, error: 'Gone' },
        ]),
      ),
    ).toEqual([
      NUMBER_SETUPS_CSV_COLUMNS.join(','),
      // A display number with spaces is not a plain E.164 number, so it is neutralised.
      "Acme,acme,'+91 90000 22222,Failed,Registering the number,Meta refused the PIN.,2026-10-05 07:00",
      'Beta,beta,1098765432,Stuck,mystery_step,,2026-10-05 06:00',
      'Acme,acme,+919000033333,Failed,,Gone,2026-10-05 07:00',
      '',
    ]);
    expect(
      lines(
        newCompaniesCsv([
          {
            id: 'c1',
            name: 'New, Ltd',
            slug: 'new',
            status: 'active',
            createdAt: at('2026-10-01T10:20:30Z'),
            inProgress: true,
          },
          {
            id: 'c2',
            name: 'Quiet',
            slug: 'quiet',
            status: 'suspended',
            createdAt: at('2026-09-30T00:00:00Z'),
            inProgress: false,
          },
        ]),
      ),
    ).toEqual([
      NEW_COMPANIES_CSV_COLUMNS.join(','),
      '"New, Ltd",new,active,2026-10-01 10:20,Yes',
      'Quiet,quiet,suspended,2026-09-30 00:00,No',
      '',
    ]);
  });

  it('writes current failures with an acknowledgement’s time but neither who made it nor the note, and no assignment', () => {
    const failure = {
      tenantId: 't1',
      tenantName: 'Acme',
      tenantSlug: 'acme',
      source: 'webhook_endpoint',
      subjectId: 'f1',
      label: 'hooks.example.com',
      state: 'failing',
      error: null,
      since: at('2026-10-05T05:00:00Z'),
      acknowledgement: {
        at: at('2026-10-05T06:15:00Z'),
        byName: 'Priya Admin',
        note: 'Called the shop; their server is down until noon.',
      },
      // Assignments stay on the console (ADR-313).
      assignment: {
        at: at('2026-10-05T06:20:00Z'),
        assigneeUserId: 'u-ravi',
        assigneeName: 'Ravi Ops',
        byName: 'Priya Admin',
      },
    };
    const csv = failuresCsv([
      failure,
      {
        ...failure,
        tenantName: 'Beta',
        tenantSlug: 'beta',
        source: 'whatsapp_number',
        label: '+91 90000 11111',
        state: 'needs_reconnect',
        error: '-Meta rejected the stored token.',
        since: null,
        acknowledgement: null,
        assignment: null,
      },
      { ...failure, source: 'fax_line', label: null, state: 'jammed', error: 'Out of paper' },
    ]);
    expect(lines(csv)).toEqual([
      FAILURES_CSV_COLUMNS.join(','),
      'Acme,acme,Webhook endpoint,hooks.example.com,Failing,,2026-10-05 05:00,2026-10-05 06:15',
      "Beta,beta,WhatsApp number,'+91 90000 11111,Needs reconnecting,'-Meta rejected the stored token.,,",
      // A source or state without a label is written as stored.
      'Acme,acme,fax_line,,jammed,Out of paper,2026-10-05 05:00,2026-10-05 06:15',
      '',
    ]);
    expect(csv).not.toContain('Priya');
    expect(csv).not.toContain('server is down');
    expect(csv).not.toContain('Ravi');
    expect(csv).not.toContain('06:20');
  });

  it('writes receipts (when one was acknowledged, never who or the note), quarantine entries and email counts as the Integrations tab words them', () => {
    const receipt = {
      id: 'r1',
      provider: 'meta_whatsapp',
      receivedAt: at('2026-10-05T01:02:03Z'),
      status: 'failed',
      attempts: 12,
      lastError: 'boom, again',
      problem: 'exhausted' as const,
      retryable: true,
      alertedAt: at('2026-10-05T01:30:00Z'),
      acknowledgement: {
        at: at('2026-10-05T02:10:40Z'),
        byName: 'Asha Ops',
        note: 'Razorpay sent a malformed body; ignoring it.',
      },
    };
    expect(
      lines(
        receiptsCsv([
          receipt,
          {
            ...receipt,
            id: 'r2',
            provider: 'razorpay',
            receivedAt: at('2026-09-20T00:00:00Z'),
            status: 'processing',
            lastError: null,
            retryable: false,
            alertedAt: null,
            acknowledgement: null,
          },
          {
            ...receipt,
            id: 'r3',
            provider: 'shopify',
            receivedAt: at('2026-10-05T07:00:00Z'),
            status: 'processing',
            attempts: 3,
            lastError: null,
            problem: 'waiting',
            retryable: false,
            alertedAt: null,
            acknowledgement: null,
          },
        ]),
      ),
    ).toEqual([
      RECEIPTS_CSV_COLUMNS.join(','),
      '2026-10-05 01:02,r1,Meta (WhatsApp),Failed all attempts,12,"boom, again",2026-10-05 01:30,Can be retried,2026-10-05 02:10',
      '2026-09-20 00:00,r2,Razorpay,Failed all attempts: its worker stopped during the last one,12,,,Body erased,',
      '2026-10-05 07:00,r3,shopify,Still waiting,3,,,Retried by the sweep,',
      '',
    ]);
    expect(RECEIPTS_CSV_COLUMNS.at(-1)).toBe('Acknowledged (UTC)');
    for (const left of ['Asha', 'malformed', 'ignoring']) {
      expect(receiptsCsv([receipt])).not.toContain(left);
    }
    expect(
      lines(
        quarantineCsv([
          {
            id: 'q1',
            receiptId: 'r9',
            provider: 'meta_whatsapp',
            reason: 'unknown_asset',
            externalIds: [
              { key: 'waba', value: '8123' },
              { key: 'phoneNumberId', value: '8456' },
            ],
            createdAt: at('2026-10-05T02:00:00Z'),
            alertedAt: at('2026-10-05T02:15:00Z'),
            retryable: true,
            acknowledgement: {
              at: at('2026-10-05T03:20:30Z'),
              byName: 'Asha Ops',
              note: 'Waiting on the company to reconnect the number.',
            },
          },
          {
            id: 'q2',
            receiptId: 'r10',
            provider: 'razorpay',
            reason: 'mystery',
            externalIds: [],
            createdAt: at('2026-09-01T00:00:00Z'),
            alertedAt: null,
            retryable: false,
            acknowledgement: null,
          },
        ]),
      ),
    ).toEqual([
      QUARANTINE_CSV_COLUMNS.join(','),
      '2026-10-05 02:00,r9,Meta (WhatsApp),Unknown account or number,waba: 8123; phoneNumberId: 8456,2026-10-05 02:15,Yes,2026-10-05 03:20',
      '2026-09-01 00:00,r10,Razorpay,mystery,,,No,',
      '',
    ]);
    // When a quarantine entry was acknowledged, never who or the note (ADR-199).
    expect(QUARANTINE_CSV_COLUMNS.at(-1)).toBe('Acknowledged (UTC)');
    expect(
      lines(
        emailsCsv([
          { kind: 'invitation', failed: 2, stuck: 0 },
          { kind: 'password_reset', failed: 0, stuck: 3 },
        ]),
      ),
    ).toEqual([EMAILS_CSV_COLUMNS.join(','), 'invitation,2,0', 'password_reset,0,3', '']);
  });

  it('writes each queue’s policy, counts, wait in whole minutes, when a late one was acknowledged (never who or the note) and dead letters', () => {
    const checkedAt = at('2026-10-05T07:05:30Z');
    const store: QueueRow = {
      name: 'commerce.store',
      policy: { retryLimit: 5, hasDeadLetter: true, maxWaitMinutes: 60 },
      counts: { name: 'commerce.store', ready: 4, deferred: 1, active: 2, failed: 3, total: 10 },
      deadLetters: { last24h: 1, last7d: 2 },
      wait: {
        waiting: 4,
        oldestWaitingSince: at('2026-10-05T05:00:00Z'),
        oldestWaitMs: 125 * 60_000 + 59_999,
        limitMinutes: 60,
        lateSince: at('2026-10-05T06:00:00Z'),
        alertedAt: at('2026-10-05T06:01:00Z'),
        checkedAt,
        acknowledgement: {
          at: at('2026-10-05T06:20:40Z'),
          byName: 'Asha Ops',
          note: 'Shopify is rate limiting us; waiting it out.',
        },
      },
    };
    const quiet: QueueRow = {
      name: 'billing.auto-recharge',
      policy: { retryLimit: 0, hasDeadLetter: false, maxWaitMinutes: 15 },
      counts: {
        name: 'billing.auto-recharge',
        ready: 0,
        deferred: 0,
        active: 0,
        failed: 0,
        total: 0,
      },
      deadLetters: { last24h: 0, last7d: 0 },
      wait: {
        waiting: 0,
        oldestWaitingSince: null,
        oldestWaitMs: null,
        limitMinutes: 15,
        lateSince: null,
        alertedAt: null,
        checkedAt,
        acknowledgement: null,
      },
    };
    const gone: QueueRow = {
      name: 'it.gone',
      policy: null,
      counts: null,
      deadLetters: { last24h: 0, last7d: 1 },
      wait: null,
    };
    // A wait the worker's clock put a few seconds in the future reads as none.
    const skewed: QueueRow = {
      ...store,
      name: 'commerce.sync',
      wait: {
        ...store.wait!,
        oldestWaitMs: -5_000,
        lateSince: null,
        alertedAt: null,
        acknowledgement: null,
      },
    };
    expect(lines(queuesCsv([store, quiet, gone, skewed]))).toEqual([
      QUEUES_CSV_COLUMNS.join(','),
      'commerce.store,Yes,5,Yes,60,Yes,4,1,2,3,125,2026-10-05 06:00,2026-10-05 06:01,2026-10-05 06:20,2026-10-05 07:05,1,2',
      'billing.auto-recharge,Yes,0,No,15,Yes,0,0,0,0,,,,,2026-10-05 07:05,0,0',
      'it.gone,No,,,,No,,,,,,,,,,0,1',
      'commerce.sync,Yes,5,Yes,60,Yes,4,1,2,3,0,,,,2026-10-05 07:05,1,2',
      '',
    ]);
    expect(QUEUES_CSV_COLUMNS.indexOf('Acknowledged (UTC)')).toBe(
      QUEUES_CSV_COLUMNS.indexOf('Staff emailed (UTC)') + 1,
    );
    const file = queuesCsv([store]);
    for (const left of ['Asha', 'Shopify', 'rate limiting']) expect(file).not.toContain(left);
  });

  it('writes dead letters with what became of each job and when one was acknowledged, never who retried or acknowledged it or the note', () => {
    const letter: DeadLetterLine = {
      id: 'd1',
      sourceQueue: 'template.submit',
      failedAt: at('2026-10-05T03:00:00Z'),
      verified: true,
      tenantId: 't1',
      tenantName: 'Acme',
      tenantSlug: 'acme',
      ref: 'tpl-1',
      errorName: 'AppError',
      errorCode: 'provider_rejected',
      retries: 5,
      alertedAt: at('2026-10-05T03:10:00Z'),
      retriedAt: at('2026-10-05T04:00:00Z'),
      retriedByName: 'Priya Admin',
      settledAt: null,
      settledEnded: null,
      retryable: false,
      retryableUntil: at('2026-10-08T03:00:00Z'),
      retryBlock: 'retried',
      acknowledgedAt: at('2026-10-05T05:00:00Z'),
      acknowledgedByName: 'Ravi Ops',
      acknowledgement: 'Template fixed upstream; the retry went through.',
    };
    const fresh = {
      ...letter,
      retriedAt: null,
      retriedByName: null,
      alertedAt: null,
      acknowledgedAt: null,
      acknowledgedByName: null,
      acknowledgement: null,
    };
    const csv = deadLettersCsv([
      letter,
      {
        ...fresh,
        id: 'd2',
        settledAt: at('2026-10-05T03:01:00Z'),
        settledEnded: true,
        retryBlock: 'settled',
      },
      {
        ...fresh,
        id: 'd3',
        settledAt: at('2026-10-05T03:01:00Z'),
        settledEnded: false,
        retryBlock: 'settled',
      },
      {
        ...fresh,
        id: 'd4',
        retryable: true,
        retryBlock: null,
        retryableUntil: at('2026-10-06T03:00:00Z'),
      },
      {
        ...fresh,
        id: 'd5',
        verified: false,
        tenantId: null,
        tenantName: null,
        tenantSlug: null,
        ref: null,
        errorName: null,
        errorCode: null,
        retries: null,
        retryBlock: 'unverified',
      },
      { ...fresh, id: 'd6', tenantId: null, tenantName: null, tenantSlug: null, retryBlock: null },
    ]);
    expect(lines(csv)).toEqual([
      DEAD_LETTERS_CSV_COLUMNS.join(','),
      '2026-10-05 03:00,d1,template.submit,Yes,Acme,acme,tpl-1,AppError,provider_rejected,5,2026-10-05 03:10,2026-10-05 04:00,,Retried,,2026-10-05 05:00',
      '2026-10-05 03:00,d2,template.submit,Yes,Acme,acme,tpl-1,AppError,provider_rejected,5,,,2026-10-05 03:01,"Work ended for its company, which can start it again",,',
      '2026-10-05 03:00,d3,template.submit,Yes,Acme,acme,tpl-1,AppError,provider_rejected,5,,,2026-10-05 03:01,Nothing left to end: the work had finished or was started again,,',
      '2026-10-05 03:00,d4,template.submit,Yes,Acme,acme,tpl-1,AppError,provider_rejected,5,,,,Can be retried,2026-10-06 03:00,',
      '2026-10-05 03:00,d5,template.submit,No,,,,,,,,,,"Its signature did not verify, so the worker would refuse it again",,',
      // A platform job without a company, and nothing the console says about its retry.
      '2026-10-05 03:00,d6,template.submit,Yes,,,tpl-1,AppError,provider_rejected,5,,,,,,',
      '',
    ]);
    for (const left of ['Priya', 'Ravi', 'Template fixed upstream']) {
      expect(csv).not.toContain(left);
    }
  });

  it('heads each file with its columns, one for each value of a line', () => {
    expect(
      [
        SIGNUPS_CSV_COLUMNS,
        NUMBER_SETUPS_CSV_COLUMNS,
        NEW_COMPANIES_CSV_COLUMNS,
        FAILURES_CSV_COLUMNS,
        RECEIPTS_CSV_COLUMNS,
        QUARANTINE_CSV_COLUMNS,
        EMAILS_CSV_COLUMNS,
        QUEUES_CSV_COLUMNS,
        DEAD_LETTERS_CSV_COLUMNS,
      ].map((columns) => columns.join(',')),
    ).toEqual([
      'Company,Address,Outcome,Reason,Started (UTC),Active number now',
      'Company,Address,Number,State,Step,Error,Since (UTC)',
      'Company,Address,Status,Created (UTC),Number being set up',
      'Company,Address,What,Label,State,Error,Since (UTC),Acknowledged (UTC)',
      'Received (UTC),Receipt,From,Problem,Attempts,Last error,Staff emailed (UTC),Retry,Acknowledged (UTC)',
      'Quarantined (UTC),Receipt,From,Reason,Provider ids,Staff emailed (UTC),Receipt can be retried,Acknowledged (UTC)',
      'Kind,Failed,Waiting',
      'Queue,Declared by this release,Retries,Dead-lettered after its retries,Wait limit (minutes),' +
        'In the database,Ready,Deferred,Active,Failed,Oldest wait (minutes),Late since (UTC),' +
        'Staff emailed (UTC),Acknowledged (UTC),Waits checked (UTC),Dead letters (24 hours),Dead letters (7 days)',
      'Failed (UTC),Dead letter,Queue,Signature verified,Company,Address,Reference,Error,' +
        'Error code,Retries,Staff emailed (UTC),Retried (UTC),Work settled (UTC),Retry,' +
        'Can be retried until (UTC),Acknowledged (UTC)',
    ]);
  });

  it('names each list’s audit action and file, all within the audit log’s action pattern', () => {
    expect(OPS_EXPORT_LISTS.every(isOpsExportList)).toBe(true);
    expect(['dead_letters', 'onboarding', 'keys'].some(isOpsExportList)).toBe(false);
    expect(OPS_EXPORT_LISTS.map(opsExportAction)).toEqual([
      'platform.ops_usage_exported',
      'platform.ops_health_exported',
      'platform.ops_signals_exported',
      'platform.ops_signups_exported',
      'platform.ops_number_setups_exported',
      'platform.ops_new_companies_exported',
      'platform.ops_failures_exported',
      'platform.ops_receipts_exported',
      'platform.ops_quarantine_exported',
      'platform.ops_emails_exported',
      'platform.ops_queues_exported',
      'platform.ops_dead_letters_exported',
      'platform.ops_failure_reasons_exported',
      'platform.ops_failure_companies_exported',
    ]);
    // ops.platform_audit_events checks every action against this pattern.
    for (const list of OPS_EXPORT_LISTS) {
      expect(opsExportAction(list)).toMatch(/^[a-z][a-z0-9_.]{2,99}$/);
    }
    expect(opsCsvFilename('dead-letters', at('2026-10-05T23:59:59Z'))).toBe(
      'hyfib-dead-letters-2026-10-05.csv',
    );
    expect(opsCsvFilename('signups', at('2026-10-05T00:00:00Z'), 30)).toBe(
      'hyfib-signups-30-days-2026-10-05.csv',
    );
    // The year's lists have no window: their file says the day only (ADR-365).
    expect(opsCsvFilename('failure-companies', at('2026-10-10T08:00:00Z'))).toBe(
      'hyfib-failure-companies-2026-10-10.csv',
    );
  });
});

describe('the year’s failed sends by reason and by company as CSV (ADR-365)', () => {
  const lines = (csv: string) => {
    expect(csv.startsWith('\uFEFF')).toBe(true);
    return csv.slice(1).split('\r\n');
  };
  // 2025-10-10 to 2026-10-09: 22 days of the first month, 9 of the last, 365 in all.
  const months = failureReasonYearMonths('2026-10-10');
  const monthHeads = [
    '2025-10 (22 days)',
    '2025-11',
    '2025-12',
    '2026-01',
    '2026-02',
    '2026-03',
    '2026-04',
    '2026-05',
    '2026-06',
    '2026-07',
    '2026-08',
    '2026-09',
    '2026-10 (9 days)',
  ];
  /** Thirteen months' counts, all 0 but those given by index. */
  const year = (counts: Record<number, number>) =>
    Array.from({ length: 13 }, (_, at) => counts[at] ?? 0);

  it('writes a line per reason as the card names it, its code, share and months, and the days counted', () => {
    const reasons: FailureReasonYear = {
      reasons: {
        reasons: [
          { code: '131049', failed: 6, codes: 1, share: 0.5 },
          { code: '', failed: 3, codes: 1, share: 1 / 4 },
          { code: '131999', failed: 1, codes: 1, share: 1 / 12 },
          { code: null, failed: 2, codes: 2, share: 1 / 6 },
        ],
        failed: 12,
      },
      uncounted: 4,
      months,
      byMonth: [year({ 0: 1, 5: 5 }), year({ 12: 3 }), year({ 6: 1 }), year({ 0: 1, 12: 1 })],
    };
    expect(FAILURE_REASONS_CSV_COLUMNS).toEqual([
      'Reason',
      'Code',
      'Codes',
      'Failed',
      'Share of the failed',
    ]);
    expect(lines(failureReasonsCsv(reasons))).toEqual([
      ['Reason,Code,Codes,Failed,Share of the failed', ...monthHeads, 'Days counted'].join(','),
      'Meta limited marketing messages to this customer. Wait at least 24 hours before trying again.,131049,1,6,0.5,1,0,0,0,0,5,0,0,0,0,0,0,0,361',
      // Failures without a code, a code HyFib does not describe and the rest: as the card says.
      'Failed without a code,None,1,3,0.25,0,0,0,0,0,0,0,0,0,0,0,0,3,361',
      'Not described here,131999,1,1,0.083333,0,0,0,0,0,0,1,0,0,0,0,0,0,361',
      '2 other codes,,2,2,0.166667,1,0,0,0,0,0,0,0,0,0,0,0,1,361',
      '',
    ]);
    // Nothing failed: the columns alone.
    expect(
      lines(failureReasonsCsv({ ...reasons, reasons: { reasons: [], failed: 0 }, byMonth: [] })),
    ).toEqual([
      ['Reason,Code,Codes,Failed,Share of the failed', ...monthHeads, 'Days counted'].join(','),
      '',
    ]);
    // A month of which the year holds one day says so: the year ending on the 1st.
    const ending = failureReasonsCsv({
      reasons: { reasons: [], failed: 0 },
      uncounted: 0,
      months: failureReasonYearMonths('2026-10-02'),
      byMonth: [],
    });
    expect(lines(ending)[0]).toMatch(
      /,2025-10 \(30 days\),.*,2026-09,2026-10 \(1 day\),Days counted$/,
    );
  });

  it('writes a line per company with its sends and their share failed, its months failed then sent, the rest last, formula-safe', () => {
    const row = (
      place: number,
      month: string,
      failed: number,
      sent: number,
      company: { name: string; slug: string } | null,
    ) => ({
      place,
      tenantId: company ? `tenant-${place}` : null,
      name: company?.name ?? null,
      slug: company?.slug ?? null,
      companies: company ? 1 : 3,
      month,
      failed,
      sent,
    });
    const formula = { name: '=HYPERLINK("https://example.com")', slug: 'acme' };
    const quiet = { name: 'Quiet, Ltd', slug: 'quiet' };
    const companies = failureCompanyYear(
      [
        row(1, '2025-10', 1, 50, formula),
        row(1, '2026-03', 5, 100, formula),
        // A company whose sends are gone, as when its deletion has removed them: no share.
        row(2, '2026-03', 2, 0, quiet),
        row(9, '2026-10', 1, 10, null),
      ],
      '2026-10-10',
      4,
    );
    expect(FAILURE_COMPANIES_CSV_COLUMNS).toEqual([
      'Company',
      'Address',
      'Companies',
      'Failed',
      'Share of the failed',
      'Sent',
      'Share of its sends failed',
    ]);
    expect(lines(failureCompaniesCsv(companies))).toEqual([
      [
        'Company,Address,Companies,Failed,Share of the failed,Sent,Share of its sends failed',
        ...monthHeads.map((head) => `${head} failed`),
        ...monthHeads.map((head) => `${head} sent`),
        'Days counted',
      ].join(','),
      `"'=HYPERLINK(""https://example.com"")",acme,1,6,0.666667,150,0.04,1,0,0,0,0,5,0,0,0,0,0,0,0,50,0,0,0,0,100,0,0,0,0,0,0,0,361`,
      '"Quiet, Ltd",quiet,1,2,0.222222,0,,0,0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,361',
      '3 other companies,,3,1,0.111111,10,0.1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,10,361',
      '',
    ]);
    // A rest of one company says so.
    expect(
      lines(
        failureCompaniesCsv(
          failureCompanyYear(
            [{ ...row(9, '2026-10', 1, 10, null), companies: 1 }],
            '2026-10-10',
            0,
          ),
        ),
      )[1],
    ).toMatch(/^1 other company,,1,1,1,10,0\.1,/);
  });
});

describe('how many rows the console’s lists export (ADR-200)', () => {
  it('exports at least the rows each tab shows, up to 5,000, or what the definer functions return', () => {
    for (const [list, rows] of Object.entries(OPS_LIST_ROWS)) {
      expect(rows.exported, list).toBeGreaterThanOrEqual(rows.shown);
    }
    expect(OPS_LIST_ROWS).toEqual({
      signups: { shown: 200, exported: 500 },
      numberSetups: { shown: 200, exported: 5000 },
      newCompanies: { shown: 500, exported: 5000 },
      failures: { shown: 500, exported: 1000 },
      receipts: { shown: 100, exported: 5000 },
      quarantine: { shown: 100, exported: 5000 },
      deadLetters: { shown: 100, exported: 5000 },
    });
  });
});

describe('the administrators the Assign list offers (ADR-325)', () => {
  const at = (iso: string) => new Date(iso);
  it('names each by name, the reader as "you", in the order given', () => {
    expect(
      platformAdministratorChoices(
        [
          { userId: 'u-asha', name: 'Asha Ops', since: at('2026-10-01T09:30:00Z') },
          { userId: 'u-ravi', name: ' Ravi\t Ops ', since: at('2026-10-02T09:30:00Z') },
          { userId: 'u-anon', name: null, since: at('2026-10-03T09:30:00Z') },
        ],
        'u-ravi',
      ),
    ).toEqual([
      { userId: 'u-asha', label: 'Asha Ops' },
      { userId: 'u-ravi', label: 'Ravi Ops (you)' },
      { userId: 'u-anon', label: 'An administrator without a name' },
    ]);
  });

  it('tells apart administrators who share a name by when they became one, then by place', () => {
    const choices = platformAdministratorChoices(
      [
        { userId: 'u-1', name: 'Anil  Staff', since: at('2026-10-01T09:30:59Z') },
        { userId: 'u-2', name: 'Anil Staff', since: at('2026-10-05T14:05:00Z') },
        { userId: 'u-3', name: 'Anil Staff', since: at('2026-10-05T14:05:30Z') },
        { userId: 'u-me', name: 'Anil Staff', since: at('2026-10-06T08:00:00Z') },
        { userId: 'u-x', name: '', since: at('2026-10-06T08:00:00Z') },
        { userId: 'u-y', name: null, since: at('2026-10-07T08:00:00Z') },
      ],
      'u-me',
    );
    expect(choices).toEqual([
      { userId: 'u-1', label: 'Anil Staff (administrator since 2026-10-01 09:30 UTC)' },
      { userId: 'u-2', label: 'Anil Staff (administrator since 2026-10-05 14:05 UTC) #1' },
      { userId: 'u-3', label: 'Anil Staff (administrator since 2026-10-05 14:05 UTC) #2' },
      { userId: 'u-me', label: 'Anil Staff (you)' },
      {
        userId: 'u-x',
        label: 'An administrator without a name (administrator since 2026-10-06 08:00 UTC)',
      },
      {
        userId: 'u-y',
        label: 'An administrator without a name (administrator since 2026-10-07 08:00 UTC)',
      },
    ]);
    expect(new Set(choices.map((c) => c.label)).size).toBe(choices.length);
  });

  it('never gives two the same label, whatever names administrators choose', () => {
    const since = at('2026-10-01T09:30:00Z');
    const choices = platformAdministratorChoices(
      [
        { userId: 'u-me', name: 'Asha', since },
        { userId: 'u-b', name: 'Asha (you)', since },
        { userId: 'u-c', name: 'Asha (you) #1', since },
        { userId: 'u-d', name: 'Ravi #1', since },
        { userId: 'u-e', name: 'Ravi', since },
        { userId: 'u-f', name: 'Ravi', since },
      ],
      'u-me',
    );
    expect(choices.map((c) => c.label)).toEqual([
      'Asha (you) #2',
      'Asha (you) #3',
      'Asha (you) #1',
      'Ravi #1',
      'Ravi (administrator since 2026-10-01 09:30 UTC) #1',
      'Ravi (administrator since 2026-10-01 09:30 UTC) #2',
    ]);
    expect(new Set(choices.map((c) => c.label)).size).toBe(choices.length);
  });
});

describe('pages of the console’s company lists (ADR-331)', () => {
  const companies = (n: number) => Array.from({ length: n }, (_, i) => `company ${i + 1}`);

  it('shows 100 companies a page, in the list’s order, saying which and of how many', () => {
    expect(OPS_COMPANY_PAGE_ROWS).toBe(100);
    const list = companies(250);
    expect(opsCompanyPage(list, 1)).toMatchObject({
      page: 1,
      pages: 3,
      total: 250,
      first: 1,
      last: 100,
    });
    expect(opsCompanyPage(list, 1).rows).toEqual(list.slice(0, 100));
    const second = opsCompanyPage(list, 2);
    expect(second).toMatchObject({ page: 2, pages: 3, first: 101, last: 200 });
    expect(second.rows[0]).toBe('company 101');
    const third = opsCompanyPage(list, 3);
    expect(third).toMatchObject({ page: 3, pages: 3, first: 201, last: 250 });
    expect(third.rows).toHaveLength(50);
    // Exactly a page's worth is one page.
    expect(opsCompanyPage(companies(100), 1)).toMatchObject({ pages: 1, first: 1, last: 100 });
    expect(opsCompanyPage(companies(101), 2)).toMatchObject({ pages: 2, first: 101, last: 101 });
  });

  it('shows the nearest page for one out of range, and the first for anything but a whole number', () => {
    const list = companies(250);
    expect(opsCompanyPage(list, 9).page).toBe(3);
    // Whole numbers too large to count exactly are still past the last page.
    expect(opsCompanyPage(list, 2 ** 60)).toMatchObject({ page: 3, first: 201, last: 250 });
    expect(opsCompanyPage(list, 0).page).toBe(1);
    expect(opsCompanyPage(list, -2).page).toBe(1);
    for (const odd of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(opsCompanyPage(list, odd).page, String(odd)).toBe(1);
    }
    // No companies: one empty page.
    expect(opsCompanyPage([], 4)).toEqual({
      rows: [],
      page: 1,
      pages: 1,
      total: 0,
      first: 0,
      last: 0,
    });
  });
});
