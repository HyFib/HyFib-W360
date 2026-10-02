import { describe, expect, it } from 'vitest';
import { NOTICE_LINE_MAX, emailPayloadSchema, renderEmail } from '../email/templates';
import {
  planChangeNotice,
  subscriptionCancelNotice,
  type PlanChangeFacts,
  type SubscriptionCancelFacts,
} from './change-notices';

const base: PlanChangeFacts = {
  companyName: 'Acme Traders',
  status: 'active',
  planName: 'Growth',
  trialEndsAt: null,
  periodStart: new Date('2026-09-30T18:30:00Z'),
  periodEnd: new Date('2026-10-30T18:30:00Z'),
  extraSeats: 0,
  extraNumbers: 0,
  runPacks: 0,
  apiRequestPacks: 0,
  changedAt: new Date('2026-09-30T20:00:00Z'),
  reason: 'Invoice INV-1001 paid by bank transfer',
  timeZone: 'Asia/Kolkata',
};

describe('the email about a plan HyFib staff set (ADR-100)', () => {
  it('tells a paid period in the company’s time zone, with HyFib’s reason', () => {
    expect(planChangeNotice(base)).toEqual({
      subject: 'HyFib changed your plan',
      lines: [
        'HyFib changed the plan of Acme Traders on 1 Oct 2026.',
        'It is now on the Growth plan, for the paid period from 1 Oct 2026 to 31 Oct 2026.',
        "HyFib's reason: Invoice INV-1001 paid by bank transfer",
        'The plan card in Billing shows the limits that apply and what the company used this month.',
      ],
    });
    expect(planChangeNotice({ ...base, timeZone: 'Europe/London' }).lines[1]).toBe(
      'It is now on the Growth plan, for the paid period from 30 Sept 2026 to 30 Oct 2026.',
    );
  });

  it('tells a trial, complimentary access and an ended plan', () => {
    const trial = planChangeNotice({
      ...base,
      status: 'trialing',
      periodStart: null,
      periodEnd: null,
      trialEndsAt: new Date('2026-10-14T18:30:00Z'),
    });
    expect(trial.lines[1]).toBe('It is now on a trial of the Growth plan until 15 Oct 2026.');
    const free = planChangeNotice({
      ...base,
      status: 'complimentary',
      planName: null,
      periodStart: null,
      periodEnd: null,
    });
    expect(free.lines[1]).toBe(
      'It now has complimentary access from HyFib: no limits and every module.',
    );
    const ended = planChangeNotice({ ...base, status: 'canceled', extraSeats: 2 });
    expect(ended.lines[1]).toBe(
      'HyFib ended the Growth plan: sending messages, campaigns and automations is paused until the company is put on a plan again. Its data is kept, and members can still review and export it.',
    );
    // An ended plan's add-ons are not offered as included.
    expect(ended.lines.join(' ')).not.toContain('extra seat');
  });

  it('lists the add-ons, each counted', () => {
    expect(planChangeNotice({ ...base, extraSeats: 1 }).lines[2]).toBe(
      'It includes 1 extra seat on top of the plan.',
    );
    expect(
      planChangeNotice({ ...base, extraSeats: 2, extraNumbers: 1, runPacks: 1_200 }).lines[2],
    ).toBe(
      'It includes 2 extra seats, 1 extra WhatsApp number and 1,200 automation run packs on top of the plan.',
    );
    expect(planChangeNotice({ ...base, extraNumbers: 3, runPacks: 1 }).lines[2]).toBe(
      'It includes 3 extra WhatsApp numbers and 1 automation run pack on top of the plan.',
    );
    expect(planChangeNotice({ ...base, runPacks: 1, apiRequestPacks: 2 }).lines[2]).toBe(
      'It includes 1 automation run pack and 2 API request packs on top of the plan.',
    );
    expect(planChangeNotice({ ...base, apiRequestPacks: 1 }).lines[2]).toBe(
      'It includes 1 API request pack on top of the plan.',
    );
  });

  it('keeps a long reason within the notice’s lines, and a state without its dates is an error', () => {
    const reason = `${'Renewed after the quarterly review with the customer '.repeat(9)}end`;
    expect(reason.length).toBeGreaterThan(450);
    const { lines } = planChangeNotice({ ...base, reason });
    const told = lines.filter((l) => !l.startsWith('HyFib changed') && !l.startsWith('It '));
    expect(told.every((l) => l.length <= NOTICE_LINE_MAX.billing)).toBe(true);
    expect(told.slice(0, -1).join(' ')).toBe(`HyFib's reason: ${reason}`);
    expect(() => planChangeNotice({ ...base, periodEnd: null })).toThrow(/no period end/);
  });

  it('renders as a billing notice linking Billing, with the company’s name escaped', () => {
    const notice = planChangeNotice({ ...base, companyName: '<Acme> & Co' });
    const url = 'https://app.example.test/c/acme/billing';
    const payload = {
      kind: 'billing.notice' as const,
      companyName: '<Acme> & Co',
      subject: notice.subject,
      lines: notice.lines,
      url,
    };
    expect(emailPayloadSchema.safeParse(payload).success).toBe(true);
    const email = renderEmail(payload);
    expect(email.subject).toBe('HyFib changed your plan · <Acme> & Co');
    expect(email.html).toContain('HyFib changed the plan of &lt;Acme&gt; &amp; Co');
    expect(email.html).not.toContain('<Acme>');
    expect(email.html).toContain(`href="${url}"`);
  });
});

const cancelled: SubscriptionCancelFacts = {
  companyName: 'Acme Traders',
  planName: 'Growth',
  cancelledAt: new Date('2026-09-30T20:00:00Z'),
  plan: { kind: 'paid', periodEnd: new Date('2026-10-30T18:30:00Z') },
  reason: 'Customer asked by phone, ticket 882',
  timeZone: 'Asia/Kolkata',
};

describe('the email about a plan subscription HyFib staff cancelled (ADR-101)', () => {
  it('tells that nothing more is charged, the period paid in the company’s time zone and the reason', () => {
    expect(subscriptionCancelNotice(cancelled)).toEqual({
      subject: 'HyFib cancelled your plan subscription',
      lines: [
        'HyFib cancelled the Razorpay subscription for the Growth plan of Acme Traders on 1 Oct 2026, so nothing more is charged.',
        'The period it paid runs until 31 Oct 2026; the plan then ends, and Billing shows how to continue.',
        "HyFib's reason: Customer asked by phone, ticket 882",
      ],
    });
    expect(subscriptionCancelNotice({ ...cancelled, timeZone: 'Europe/London' }).lines).toEqual([
      'HyFib cancelled the Razorpay subscription for the Growth plan of Acme Traders on 30 Sept 2026, so nothing more is charged.',
      'The period it paid runs until 30 Oct 2026; the plan then ends, and Billing shows how to continue.',
      "HyFib's reason: Customer asked by phone, ticket 882",
    ]);
  });

  it('tells the grace days after the last period paid, or that the plan is not changed', () => {
    const grace = subscriptionCancelNotice({
      ...cancelled,
      plan: {
        kind: 'grace',
        periodEnd: new Date('2026-09-25T18:30:00Z'),
        graceEndsAt: new Date('2026-10-02T18:30:00Z'),
      },
    });
    expect(grace.lines[1]).toBe(
      'Its last paid period ended on 26 Sept 2026, and the plan ends when its grace days end on 3 Oct 2026; Billing shows how to continue.',
    );
    const unchanged = subscriptionCancelNotice({
      ...cancelled,
      plan: { kind: 'unchanged' },
      reason: '  ',
    });
    // A blank reason is left out.
    expect(unchanged.lines).toEqual([
      'HyFib cancelled the Razorpay subscription for the Growth plan of Acme Traders on 1 Oct 2026, so nothing more is charged.',
      'This does not change the company’s plan; the plan card in Billing shows it.',
    ]);
    expect(subscriptionCancelNotice({ ...cancelled, reason: null }).lines).toHaveLength(2);
  });

  it('tells the trial the payments were to start after, going on or over (ADR-102)', () => {
    const trialEndsAt = new Date('2026-10-14T18:30:00Z');
    expect(
      subscriptionCancelNotice({
        ...cancelled,
        plan: { kind: 'trial', trialEndsAt, ended: false },
      }).lines[1],
    ).toBe(
      'Its payments were to start when the trial ends on 15 Oct 2026. The trial goes on until then; Billing shows how to continue after it.',
    );
    expect(
      subscriptionCancelNotice({
        ...cancelled,
        plan: { kind: 'trial', trialEndsAt, ended: true },
        timeZone: 'Europe/London',
      }).lines[1],
    ).toBe(
      'Its payments were to start when the trial ended on 14 Oct 2026, so the trial is over; Billing shows how to continue.',
    );
  });

  it('keeps a long reason and the longest names within a billing notice', () => {
    const reason = `${'Cancelled at the customer’s request after the call '.repeat(9)}end`;
    expect(reason.length).toBeGreaterThan(450);
    const companyName = 'A'.repeat(120);
    const notice = subscriptionCancelNotice({
      ...cancelled,
      companyName,
      planName: 'P'.repeat(80),
      reason,
    });
    expect(notice.lines.slice(2).join(' ')).toBe(`HyFib's reason: ${reason}`);
    const payload = {
      kind: 'billing.notice' as const,
      companyName,
      subject: notice.subject,
      lines: notice.lines,
      url: 'https://app.example.test/c/acme/billing',
    };
    expect(emailPayloadSchema.safeParse(payload).success).toBe(true);
    expect(renderEmail(payload).subject).toBe(
      `HyFib cancelled your plan subscription · ${companyName}`,
    );
  });
});
