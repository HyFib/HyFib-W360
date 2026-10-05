import { describe, expect, it } from 'vitest';
import { planChangeUnavailable } from './plan-choices';

/** A company on a trial that may change its plan or add-ons (ADR-105, ADR-106). */
const free = {
  companyStatus: 'active',
  planStatus: 'trialing' as const,
  live: undefined,
  subscriptionsEnabled: true,
  taxBp: 1800,
};

describe('planChangeUnavailable', () => {
  it('allows a trial, a lapsed plan and a restricted company without a live subscription', () => {
    expect(planChangeUnavailable(free)).toBeNull();
    for (const planStatus of ['past_due', 'expired', 'canceled'] as const) {
      expect(planChangeUnavailable({ ...free, planStatus }), planStatus).toBeNull();
    }
    expect(planChangeUnavailable({ ...free, companyStatus: 'restricted' })).toBeNull();
    // A tax of 0% is set, so paying is available.
    expect(planChangeUnavailable({ ...free, taxBp: 0 })).toBeNull();
  });

  it('refuses a company being deleted or suspended before anything else', () => {
    const blocked = {
      ...free,
      planStatus: 'active' as const,
      subscriptionsEnabled: false,
      taxBp: null,
    };
    expect(planChangeUnavailable({ ...blocked, companyStatus: 'pending_deletion' })).toBe(
      'deleting',
    );
    expect(planChangeUnavailable({ ...blocked, companyStatus: 'deleted' })).toBe('deleting');
    expect(planChangeUnavailable({ ...blocked, companyStatus: 'suspended' })).toBe('suspended');
  });

  it('needs Razorpay subscriptions and the tax on plan prices', () => {
    expect(planChangeUnavailable({ ...free, subscriptionsEnabled: false })).toBe('not_offered');
    expect(planChangeUnavailable({ ...free, taxBp: null })).toBe('not_offered');
    expect(
      planChangeUnavailable({ ...free, planStatus: 'complimentary', subscriptionsEnabled: false }),
    ).toBe('not_offered');
  });

  it('refuses complimentary access, a live subscription and a paid period', () => {
    expect(planChangeUnavailable({ ...free, planStatus: 'complimentary' })).toBe('complimentary');
    expect(planChangeUnavailable({ ...free, planStatus: 'active' })).toBe('paid_period');
    const live = (status: string, startsAt: Date | null = null, paidCount = 0) => ({
      ...free,
      live: { status, startsAt, paidCount },
    });
    expect(planChangeUnavailable(live('creating'))).toBe('payment_started');
    expect(planChangeUnavailable(live('created'))).toBe('payment_started');
    // Authorised to be charged from the trial's end, not charged yet (ADR-102).
    expect(planChangeUnavailable(live('authenticated', new Date()))).toBe('paying_from_trial_end');
    expect(planChangeUnavailable(live('active', new Date(), 1))).toBe('subscribed');
    for (const status of ['authenticated', 'active', 'pending', 'halted', 'paused']) {
      expect(planChangeUnavailable(live(status)), status).toBe('subscribed');
    }
    // A live subscription is named before the paid period it pays for.
    expect(planChangeUnavailable({ ...live('active', null, 2), planStatus: 'active' })).toBe(
      'subscribed',
    );
  });
});
