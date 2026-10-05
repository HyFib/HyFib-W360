import { describe, expect, it } from 'vitest';
import { systemClock } from '@w360/core';
import type { Database } from '@w360/db';
import type { TenantContext } from '../authz/context';
import {
  limitNotices,
  limitNoticesFor,
  limitNoticeText,
  type LimitNoticeAudience,
  type LimitNoticeFacts,
} from './limit-notices';

const END = new Date('2026-11-04T19:00:00Z');
const BILLING: LimitNoticeAudience = { billing: true, automations: false, developer: false };
const MARKETER: LimitNoticeAudience = { billing: false, automations: true, developer: false };
const DEVELOPER: LimitNoticeAudience = { billing: false, automations: false, developer: true };
const AGENT: LimitNoticeAudience = { billing: false, automations: false, developer: false };

const facts = (
  used: { runs: number; api: number },
  limits: { runs: number | null; api: number | null } = { runs: 10, api: 5 },
  automationsInPlan = true,
  warningPercent = 80,
): LimitNoticeFacts => ({
  automationsInPlan,
  limits: { automationRuns: limits.runs, apiRequests: limits.api },
  used: { automationRuns: used.runs, apiRequests: used.api },
  periodEnd: END,
  warningPercent,
});

describe('which monthly limits a member is told of (ADR-140)', () => {
  it('tells members who read billing from 80% of a limit, rounded up, and at the limit', () => {
    expect(limitNoticesFor(BILLING, facts({ runs: 7, api: 3 }))).toEqual([]);
    expect(limitNoticesFor(BILLING, facts({ runs: 8, api: 4 }))).toEqual([
      {
        metric: 'automation_runs',
        state: 'nearly',
        used: 8,
        limit: 10,
        periodEnd: END,
        forBilling: true,
      },
      {
        metric: 'api_requests',
        state: 'nearly',
        used: 4,
        limit: 5,
        periodEnd: END,
        forBilling: true,
      },
    ]);
    // 80% of 11 is 8.8: nearly used up from 9.
    expect(limitNoticesFor(BILLING, facts({ runs: 8, api: 0 }, { runs: 11, api: 5 }))).toEqual([]);
    expect(
      limitNoticesFor(BILLING, facts({ runs: 9, api: 0 }, { runs: 11, api: 5 })).map(
        (n) => n.state,
      ),
    ).toEqual(['nearly']);
    expect(limitNoticesFor(BILLING, facts({ runs: 10, api: 5 }))).toEqual([
      {
        metric: 'automation_runs',
        state: 'used_up',
        used: 10,
        limit: 10,
        periodEnd: END,
        forBilling: true,
      },
      {
        metric: 'api_requests',
        state: 'used_up',
        used: 5,
        limit: 5,
        periodEnd: END,
        forBilling: true,
      },
    ]);
  });

  it('tells the members whose work stops only once a limit is used up', () => {
    expect(limitNoticesFor(MARKETER, facts({ runs: 9, api: 4 }))).toEqual([]);
    expect(limitNoticesFor(MARKETER, facts({ runs: 10, api: 5 }))).toEqual([
      {
        metric: 'automation_runs',
        state: 'used_up',
        used: 10,
        limit: 10,
        periodEnd: END,
        forBilling: false,
      },
    ]);
    expect(limitNoticesFor(DEVELOPER, facts({ runs: 9, api: 4 }))).toEqual([]);
    expect(limitNoticesFor(DEVELOPER, facts({ runs: 10, api: 5 }))).toEqual([
      {
        metric: 'api_requests',
        state: 'used_up',
        used: 5,
        limit: 5,
        periodEnd: END,
        forBilling: false,
      },
    ]);
    expect(limitNoticesFor(AGENT, facts({ runs: 10, api: 5 }))).toEqual([]);
  });

  it('says nothing of a limit that does not apply', () => {
    // No limit; none allowed (0: the API or the runs are not in the plan); automations not in it.
    expect(
      limitNoticesFor(BILLING, facts({ runs: 900, api: 900 }, { runs: null, api: null })),
    ).toEqual([]);
    expect(limitNoticesFor(BILLING, facts({ runs: 0, api: 0 }, { runs: 0, api: 0 }))).toEqual([]);
    expect(
      limitNoticesFor(BILLING, facts({ runs: 10, api: 0 }, { runs: 10, api: null }, false)),
    ).toEqual([]);
  });

  it('gives no early notice for a limit whose 80% is the limit itself, and counts beyond it', () => {
    expect(limitNoticesFor(BILLING, facts({ runs: 3, api: 3 }, { runs: 4, api: 4 }))).toEqual([]);
    // A limit lowered below what was already used: used up, with what was used.
    expect(limitNoticesFor(BILLING, facts({ runs: 0, api: 7 }, { runs: 10, api: 4 }))).toEqual([
      {
        metric: 'api_requests',
        state: 'used_up',
        used: 7,
        limit: 4,
        periodEnd: END,
        forBilling: true,
      },
    ]);
  });

  it('tells members who read billing from the share of a limit the company chose (ADR-144)', () => {
    const at = (runs: number, percent: number) =>
      limitNoticesFor(BILLING, facts({ runs, api: 0 }, { runs: 20, api: 5 }, true, percent)).map(
        (n) => [n.metric, n.state],
      );
    expect(at(9, 50)).toEqual([]);
    expect(at(10, 50)).toEqual([['automation_runs', 'nearly']]);
    expect(at(15, 80)).toEqual([]);
    expect(at(16, 80)).toEqual([['automation_runs', 'nearly']]);
    expect(at(18, 95)).toEqual([]);
    expect(at(19, 95)).toEqual([['automation_runs', 'nearly']]);
    expect(at(20, 95)).toEqual([['automation_runs', 'used_up']]);
    // Members whose work stops are still told only once a limit is used up.
    expect(
      limitNoticesFor(MARKETER, facts({ runs: 19, api: 0 }, { runs: 20, api: 5 }, true, 50)),
    ).toEqual([]);
  });
});

describe('what a notice says (ADR-140)', () => {
  it('says what stops, until when in the company’s time, and whom to ask', () => {
    const runs = limitNoticeText(
      {
        metric: 'automation_runs',
        state: 'used_up',
        used: 10000,
        limit: 10000,
        periodEnd: END,
        forBilling: true,
      },
      'Asia/Kolkata',
    );
    expect(runs).toEqual({
      tone: 'danger',
      title: "This month's automation runs are used up",
      body: 'Your company has used all 10,000 automation runs of this month. Automations do not start from customer messages, store events or the API until 5 Nov 2026, 12:30 am; runs in progress continue. Ask HyFib for more automation runs or a larger plan.',
    });
    const api = limitNoticeText(
      {
        metric: 'api_requests',
        state: 'used_up',
        used: 50000,
        limit: 50000,
        periodEnd: END,
        forBilling: false,
      },
      'UTC',
    );
    expect(api).toEqual({
      tone: 'danger',
      title: "This month's API requests are used up",
      body: 'Your company has used all 50,000 API requests of this month. The public API refuses requests (429, reason quota_exceeded) until 4 Nov 2026, 7:00 pm; the app itself, automations and outgoing webhooks are not affected. A member who manages billing can ask HyFib for more.',
    });
  });

  it('says how much is used before the limit and what happens at it', () => {
    expect(
      limitNoticeText(
        {
          metric: 'api_requests',
          state: 'nearly',
          used: 40000,
          limit: 50000,
          periodEnd: END,
          forBilling: true,
        },
        'Asia/Kolkata',
      ),
    ).toEqual({
      tone: 'warning',
      title: "This month's API requests are nearly used up",
      body: 'Your company has used 40,000 of its 50,000 API requests for this month. At 50,000, the public API refuses requests until 5 Nov 2026, 12:30 am; the app itself is not affected. Ask HyFib for more API requests or a larger plan.',
    });
    expect(
      limitNoticeText(
        {
          metric: 'automation_runs',
          state: 'nearly',
          used: 1234567,
          limit: 1500000,
          periodEnd: END,
          forBilling: true,
        },
        'Asia/Kolkata',
      ),
    ).toEqual({
      tone: 'warning',
      title: "This month's automation runs are nearly used up",
      body: 'Your company has used 12,34,567 of its 15,00,000 automation runs for this month. At 15,00,000, automations stop starting from customer messages, store events and the API until 5 Nov 2026, 12:30 am; runs in progress continue. Ask HyFib for more automation runs or a larger plan.',
    });
  });
});

describe('reading the counts (ADR-140)', () => {
  const ctx = (status: string, permissions: string[]) =>
    ({
      tenant: { id: 'tenant', status },
      scope: {},
      permissions: new Set(['tenant.read', ...permissions]),
      rolePermissions: new Set(['tenant.read', ...permissions]),
      mfa: { blocking: false },
    }) as unknown as TenantContext;
  const db = {
    run: async () => {
      throw new Error('read the counts');
    },
  } as unknown as Database;
  const deps = { db, clock: systemClock };

  it('reads nothing for a member who would get no notice, or while the company is not active', async () => {
    await expect(limitNotices(deps, ctx('active', ['inbox.reply']))).resolves.toEqual([]);
    await expect(limitNotices(deps, ctx('suspended', ['billing.read']))).resolves.toEqual([]);
    await expect(
      limitNotices(deps, ctx('pending_deletion', ['automations.read'])),
    ).resolves.toEqual([]);
    for (const permission of ['billing.read', 'automations.read', 'developer.manage']) {
      await expect(limitNotices(deps, ctx('active', [permission]))).rejects.toThrow(
        'read the counts',
      );
    }
  });
});
