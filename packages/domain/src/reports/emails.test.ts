import { describe, expect, it } from 'vitest';
import { CSAT_SKIP_REASONS, type CsatSkipReason } from '@w360/db';
import { emailPayloadSchema, renderEmail } from '../email/templates';
import { METRIC_DEFINITIONS } from './definitions';
import {
  nextReportEmailAt,
  REPORT_EMAIL_HOUR,
  REPORT_EMAIL_LATE_LIMIT_MS,
  reportEmailPayload,
  reportEmailPeriod,
  reportEmailRows,
  reportEmailsSchema,
} from './emails';
import { resolvePeriod } from './period';
import type { Report } from './service';

const IST = 'Asia/Kolkata';
const at = (iso: string) => new Date(iso);
const ratio = (numerator = 0, denominator = 0) => ({ numerator, denominator });

/** A report with nothing in it, for the email's figures. */
function emptyReport(): Report {
  const zero = { started: 0, active: 0, completed: 0, handed_off: 0, taken_over: 0 };
  return {
    period: resolvePeriod(
      { preset: 'custom', from: '2026-10-12', to: '2026-10-18' },
      IST,
      at('2026-10-19T01:30:00Z'),
    ),
    generatedAt: at('2026-10-19T01:30:00Z'),
    messaging: {
      totals: {
        inbound: 0,
        outbound: 0,
        byMember: 0,
        byCampaign: 0,
        byOther: 0,
        canceled: 0,
        inProgress: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        unknown: 0,
      },
      rates: { sent: ratio(), delivered: ratio(), read: ratio(), failure: ratio() },
      days: [],
      failureCodes: [],
    },
    costs: {
      currency: null,
      cards: [],
      delivered: 0,
      billable: 0,
      free: 0,
      notReported: 0,
      priced: 0,
      totalMicros: 0,
      lines: [],
      unpriced: { noCurrency: 0, noRateCard: 0, otherCategory: 0, marketUnknown: 0, noPrice: 0 },
    },
    inbox: {
      targetMinutes: null,
      teamTargets: [],
      teamBusinessHours: [],
      businessHours: false,
      now: {
        open: 0,
        unassigned: 0,
        waiting: 0,
        oldestWaitSeconds: null,
        windowsClosing: 0,
        windowsClosed: 0,
        overTarget: null,
        byAssignee: [],
      },
      turns: {
        started: 0,
        answered: 0,
        resolvedWithoutReply: 0,
        waiting: 0,
        medianSeconds: null,
        p90Seconds: null,
        businessMedianSeconds: null,
        businessP90Seconds: null,
        buckets: { upTo5m: 0, upTo1h: 0, upTo24h: 0, over24h: 0 },
        withinTarget: null,
      },
      resolution: { resolved: 0, medianSeconds: null, p90Seconds: null },
      days: [],
    },
    csat: {
      enabled: false,
      surveys: 0,
      sent: 0,
      skipped: Object.fromEntries(CSAT_SKIP_REASONS.map((r) => [r, 0])) as Record<
        CsatSkipReason,
        number
      >,
      delivered: 0,
      answered: 0,
      ratings: { best: 0, middle: 0, worst: 0 },
      responseRate: ratio(),
      score: ratio(),
      days: [],
    },
    automations: {
      totals: { ...zero, stopped: 0, failed: 0 },
      shares: {
        completed: ratio(),
        handed_off: ratio(),
        taken_over: ratio(),
        stopped: ratio(),
        failed: ratio(),
      },
      failures: [],
      automations: [],
      days: [],
    },
    deals: {
      won: [],
      lost: [],
      winRate: ratio(),
      medianSecondsToWin: null,
      pipelines: [],
      days: [],
    },
    agents: [],
    campaigns: { rows: [], truncated: false },
    definitions: [...METRIC_DEFINITIONS],
  };
}

describe('when report emails go out (ADR-376)', () => {
  it('weekly: at 07:00 on the Monday after the week, in the company’s time zone', () => {
    expect(REPORT_EMAIL_HOUR).toBe(7);
    // Wednesday 14 October → Monday 19 October 07:00 IST.
    expect(nextReportEmailAt('weekly', IST, at('2026-10-14T10:00:00Z'))).toEqual(
      at('2026-10-19T01:30:00Z'),
    );
    // Sunday night and a minute before the time: the same Monday.
    expect(nextReportEmailAt('weekly', IST, at('2026-10-18T17:30:00Z'))).toEqual(
      at('2026-10-19T01:30:00Z'),
    );
    expect(nextReportEmailAt('weekly', IST, at('2026-10-19T01:29:00Z'))).toEqual(
      at('2026-10-19T01:30:00Z'),
    );
    // At the time itself or after it: the Monday after.
    expect(nextReportEmailAt('weekly', IST, at('2026-10-19T01:30:00Z'))).toEqual(
      at('2026-10-26T01:30:00Z'),
    );
    expect(nextReportEmailAt('weekly', IST, at('2026-10-19T09:00:00Z'))).toEqual(
      at('2026-10-26T01:30:00Z'),
    );
  });

  it('monthly: at 07:00 on the first of the month after, across a year', () => {
    expect(nextReportEmailAt('monthly', IST, at('2026-10-14T10:00:00Z'))).toEqual(
      at('2026-11-01T01:30:00Z'),
    );
    expect(nextReportEmailAt('monthly', IST, at('2026-11-01T01:30:00Z'))).toEqual(
      at('2026-12-01T01:30:00Z'),
    );
    expect(nextReportEmailAt('monthly', IST, at('2026-12-15T10:00:00Z'))).toEqual(
      at('2027-01-01T01:30:00Z'),
    );
    // Before the time on the first: that day.
    expect(nextReportEmailAt('monthly', IST, at('2026-11-01T00:00:00Z'))).toEqual(
      at('2026-11-01T01:30:00Z'),
    );
  });

  it('keep 07:00 local time across daylight-saving changes', () => {
    // London moves to summer time on 29 March 2026.
    expect(nextReportEmailAt('weekly', 'Europe/London', at('2026-03-18T12:00:00Z'))).toEqual(
      at('2026-03-23T07:00:00Z'),
    );
    expect(nextReportEmailAt('weekly', 'Europe/London', at('2026-03-23T07:00:00Z'))).toEqual(
      at('2026-03-30T06:00:00Z'),
    );
    // New York leaves summer time on 1 November 2026, before 07:00.
    expect(nextReportEmailAt('monthly', 'America/New_York', at('2026-09-20T12:00:00Z'))).toEqual(
      at('2026-10-01T11:00:00Z'),
    );
    expect(nextReportEmailAt('monthly', 'America/New_York', at('2026-10-01T11:00:00Z'))).toEqual(
      at('2026-11-01T12:00:00Z'),
    );
  });

  it('report the whole week or month before the day they are due', () => {
    expect(reportEmailPeriod('weekly', IST, at('2026-10-19T01:30:00Z'))).toEqual({
      from: '2026-10-12',
      to: '2026-10-18',
    });
    // A late email still reports the week of its due day.
    expect(reportEmailPeriod('weekly', IST, at('2026-10-21T09:00:00Z'))).toEqual({
      from: '2026-10-12',
      to: '2026-10-18',
    });
    expect(reportEmailPeriod('monthly', IST, at('2026-11-01T01:30:00Z'))).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(reportEmailPeriod('monthly', IST, at('2027-01-01T01:30:00Z'))).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(reportEmailPeriod('monthly', IST, at('2028-03-01T01:30:00Z'))).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    // The company moved to Los Angeles after the email was scheduled for 07:00 in India: that
    // instant is Sunday evening there, so the whole week before is the one that ended on the 11th.
    expect(reportEmailPeriod('weekly', 'America/Los_Angeles', at('2026-10-19T01:30:00Z'))).toEqual({
      from: '2026-10-05',
      to: '2026-10-11',
    });
    expect(REPORT_EMAIL_LATE_LIMIT_MS).toBe(72 * 3_600_000);
  });

  it('take a yes or no for each of the weekly and monthly emails', () => {
    expect(reportEmailsSchema.parse({ weekly: true, monthly: false })).toEqual({
      weekly: true,
      monthly: false,
    });
    for (const bad of [{ weekly: true }, { weekly: 'yes', monthly: false }, {}, null]) {
      expect(reportEmailsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('what a report email says', () => {
  it('gives messages, replies and resolutions even in an empty period, and nothing else', () => {
    expect(reportEmailRows(emptyReport())).toEqual([
      { label: 'Customer messages', value: '0' },
      { label: 'Messages sent', value: '0' },
      { label: 'Delivered', value: '— (0 of 0 sent)' },
      { label: 'Read', value: '— (0 of 0 delivered)' },
      { label: 'Failed', value: '— (0 of 0)' },
      {
        label: 'Reply turns',
        value: '0 (0 answered, 0 resolved without a reply, 0 still waiting)',
      },
      { label: 'First response time (median)', value: '—' },
      { label: 'Resolution time (median)', value: '— (0 resolved)' },
    ]);
  });

  it('adds the target, CSAT, automations, closed deals and Meta charges when there are some', () => {
    const report = emptyReport();
    report.messaging.totals = { ...report.messaging.totals, inbound: 1234, outbound: 400 };
    report.messaging.rates = {
      sent: ratio(395, 400),
      delivered: ratio(390, 400),
      read: ratio(242, 390),
      failure: ratio(5, 400),
    };
    report.inbox.targetMinutes = 30;
    report.inbox.businessHours = true;
    report.inbox.turns = {
      ...report.inbox.turns,
      started: 120,
      answered: 110,
      resolvedWithoutReply: 6,
      waiting: 4,
      medianSeconds: 754,
      withinTarget: ratio(94, 110),
    };
    report.inbox.resolution = { resolved: 98, medianSeconds: 7500, p90Seconds: null };
    report.csat = { ...report.csat, enabled: true, score: ratio(44, 50) };
    report.automations.totals = {
      started: 300,
      active: 5,
      completed: 250,
      handed_off: 30,
      taken_over: 0,
      stopped: 5,
      failed: 10,
    };
    report.deals.won = [
      { currency: 'INR', deals: 3, valueMinor: 12_000_000 },
      { currency: 'USD', deals: 1, valueMinor: 50_000 },
    ];
    report.deals.lost = [{ currency: 'INR', deals: 2, valueMinor: 0 }];
    report.deals.winRate = ratio(4, 6);
    report.costs = {
      ...report.costs,
      currency: 'INR',
      cards: [{ id: 'card', effectiveFrom: at('2026-01-01T00:00:00Z') }],
      totalMicros: 1_234_560_000,
      priced: 380,
      billable: 385,
    };
    expect(reportEmailRows(report)).toEqual([
      { label: 'Customer messages', value: '1,234' },
      { label: 'Messages sent', value: '400' },
      { label: 'Delivered', value: '97.5% (390 of 400 sent)' },
      { label: 'Read', value: 'at least 62.1% (242 of 390 delivered)' },
      { label: 'Failed', value: '1.3% (5 of 400)' },
      {
        label: 'Reply turns',
        value: '120 (110 answered, 6 resolved without a reply, 4 still waiting)',
      },
      { label: 'First response time (median)', value: '13 min' },
      {
        label: 'Answered within target',
        value: '85.5% (94 of 110 within 30 min of business hours)',
      },
      { label: 'Resolution time (median)', value: '2 h 5 min (98 resolved)' },
      { label: 'CSAT', value: '88% (44 of 50 answers)' },
      {
        label: 'Automation runs',
        value: '300 (250 completed, 30 handed off, 5 stopped, 10 failed, 5 still running)',
      },
      { label: 'Deals won', value: '4 (₹1,20,000.00 + $500.00)' },
      { label: 'Deals lost', value: '2 (₹0.00)' },
      { label: 'Win rate', value: '66.7% (4 of 6 closed)' },
      {
        label: 'Estimated Meta charges',
        value: '₹1,234.56 (380 priced of 385 billable delivered messages)',
      },
    ]);
    // Teams with their own targets (ADR-377): each conversation against its team's or the
    // company's, even when the company has none.
    report.inbox.teamTargets = [{ teamId: 'team', name: 'Returns', minutes: 15 }];
    const within = () => reportEmailRows(report).find((r) => r.label === 'Answered within target');
    expect(within()?.value).toBe(
      '85.5% (94 of 110 within their team’s or the company’s target in business hours)',
    );
    report.inbox.targetMinutes = null;
    report.inbox.businessHours = false;
    expect(within()?.value).toBe('85.5% (94 of 110 within their team’s or the company’s target)');
    report.inbox.teamTargets = [];
    report.inbox.targetMinutes = 30;
    report.inbox.businessHours = true;
    // Teams with their own business hours (ADR-389): each conversation in its team's or the
    // company's hours, with one target or several; none while business hours are off.
    report.inbox.teamBusinessHours = [{ teamId: 'team', name: 'Night shift' }];
    expect(within()?.value).toBe(
      '85.5% (94 of 110 within 30 min in their team’s or the company’s business hours)',
    );
    report.inbox.teamTargets = [{ teamId: 'team', name: 'Returns', minutes: 15 }];
    expect(within()?.value).toBe(
      '85.5% (94 of 110 within their team’s or the company’s target in their team’s or the company’s business hours)',
    );
    report.inbox.businessHours = false;
    expect(within()?.value).toBe('85.5% (94 of 110 within their team’s or the company’s target)');
    report.inbox.teamTargets = [];
    report.inbox.teamBusinessHours = [];
    report.inbox.businessHours = true;
    // Without business hours the target counts absolute time; CSAT surveys sent before CSAT was
    // turned off still count.
    report.inbox.businessHours = false;
    report.csat = { ...report.csat, enabled: false, surveys: 3 };
    const rows = reportEmailRows(report);
    expect(rows.find((r) => r.label === 'Answered within target')?.value).toBe(
      '85.5% (94 of 110 within 30 min)',
    );
    expect(rows.some((r) => r.label === 'CSAT')).toBe(true);
    // A currency without a rate card in force prices nothing: no charges row.
    report.costs = { ...report.costs, cards: [] };
    expect(reportEmailRows(report).some((r) => r.label === 'Estimated Meta charges')).toBe(false);
    // Deals lost but none won: the won row says so rather than naming no amount.
    report.deals.won = [];
    report.deals.winRate = ratio(0, 2);
    expect(reportEmailRows(report).find((r) => r.label === 'Deals won')?.value).toBe(
      '0 (no value)',
    );
  });

  it('cuts amounts in many currencies to the longest value an email row takes', () => {
    const report = emptyReport();
    report.deals.won = Array.from({ length: 30 }, (_, i) => ({
      currency: i % 2 ? 'INR' : 'USD',
      deals: 1,
      valueMinor: 100_000_000 + i,
    }));
    report.deals.winRate = ratio(30, 30);
    const won = reportEmailRows(report).find((r) => r.label === 'Deals won');
    expect(won?.value.length).toBe(200);
  });

  it('names the period, what the numbers count and how to stop the email', () => {
    const report = emptyReport();
    const payload = reportEmailPayload({
      frequency: 'weekly',
      companyName: 'Acme',
      timezone: IST,
      period: { from: '2026-10-12', to: '2026-10-18' },
      report,
      url: 'https://app.example.test/c/acme/reports?preset=custom&from=2026-10-12&to=2026-10-18',
    });
    expect(emailPayloadSchema.parse(payload)).toEqual(payload);
    expect(payload).toMatchObject({
      kind: 'reports.summary',
      title: 'Weekly report',
      period: '12 Oct 2026 – 18 Oct 2026',
      timezone: IST,
    });
    expect(payload.notes).toHaveLength(2);
    expect(payload.notes[1]).toContain('weekly report email on the Reports page');
    const email = renderEmail(payload);
    expect(email.subject).toBe('Weekly report, 12 Oct 2026 – 18 Oct 2026 · Acme');
    expect(email.text).toContain('Customer messages: 0\nMessages sent: 0');
    expect(email.text).toContain(`in calendar days of ${IST}.`);
    expect(email.text.endsWith(payload.url)).toBe(true);

    report.costs = {
      ...report.costs,
      currency: 'INR',
      cards: [{ id: 'card', effectiveFrom: at('2026-01-01T00:00:00Z') }],
    };
    const monthly = reportEmailPayload({
      frequency: 'monthly',
      companyName: 'Acme',
      timezone: IST,
      period: { from: '2026-10-01', to: '2026-10-31' },
      report,
      url: 'https://app.example.test/c/acme/reports',
    });
    expect(monthly.title).toBe('Monthly report');
    expect(monthly.notes).toHaveLength(3);
    expect(monthly.notes[1]).toContain('not Meta’s invoice');
    expect(monthly.notes[2]).toContain('monthly report email');
  });

  it('escapes everything it shows in the HTML', () => {
    const email = renderEmail({
      kind: 'reports.summary',
      companyName: 'A<b>',
      title: 'Weekly report',
      period: '12 Oct 2026 – 18 Oct 2026',
      timezone: IST,
      rows: [{ label: '<script>x</script>', value: '1 & 2' }],
      notes: ['"quoted"'],
      url: 'https://app.example.test/c/acme/reports?a=1&b=2',
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(email.html).toContain('1 &amp; 2');
    expect(email.html).toContain('&quot;quoted&quot;');
    expect(email.html).toContain('A&lt;b&gt;');
    expect(email.html).toContain('href="https://app.example.test/c/acme/reports?a=1&amp;b=2"');
  });
});
