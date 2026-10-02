import { describe, expect, it } from 'vitest';
import { priceListGaps, priceListLines, type PriceListPlan } from './price-list';

/** Everything a visitor needs to follow the price list (ADR-107). */
const ready = {
  shown: true,
  subscriptionsEnabled: true,
  taxBp: 1800,
  defaultTrialDays: 14,
  offeredPrices: [99_900],
};

describe('priceListGaps', () => {
  it('shows the list when it is shown, plans can be paid for, a trial is set and a version can be paid', () => {
    expect(priceListGaps(ready)).toEqual([]);
    // A tax of 0% is set, so paying is available.
    expect(priceListGaps({ ...ready, taxBp: 0 })).toEqual([]);
  });

  it('names every gap, in order', () => {
    expect(
      priceListGaps({
        shown: false,
        subscriptionsEnabled: false,
        taxBp: null,
        defaultTrialDays: null,
        offeredPrices: [],
      }),
    ).toEqual(['hidden', 'payments_off', 'no_tax', 'no_default_trial', 'nothing_payable']);
    expect(priceListGaps({ ...ready, shown: false })).toEqual(['hidden']);
    expect(priceListGaps({ ...ready, subscriptionsEnabled: false })).toEqual(['payments_off']);
    expect(priceListGaps({ ...ready, taxBp: null })).toEqual(['no_tax']);
    expect(priceListGaps({ ...ready, defaultTrialDays: null })).toEqual(['no_default_trial']);
    expect(priceListGaps({ ...ready, offeredPrices: [] })).toEqual(['nothing_payable']);
  });

  it('counts only versions one plan payment can cover with the tax', () => {
    // ₹10,000,000,000 is the most one plan payment can be; with 18% tax this price is more.
    const dear = 900_000_000_000;
    expect(priceListGaps({ ...ready, offeredPrices: [dear] })).toEqual(['nothing_payable']);
    expect(priceListGaps({ ...ready, offeredPrices: [dear, 99_900] })).toEqual([]);
    // Before a tax is set, the price alone counts.
    expect(priceListGaps({ ...ready, taxBp: null, offeredPrices: [dear] })).toEqual(['no_tax']);
  });
});

const plan: PriceListPlan = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Team',
  description: null,
  priceMinor: 99_900,
  totalMinor: 117_882,
  intervalMonths: 1,
  seatsIncluded: 2,
  numbersIncluded: 1,
  teamsMax: null,
  liveAutomationsMax: 5,
  automationRunsMonthly: 1000,
  apiRequestsMonthly: null,
  someApiScopes: false,
  modules: ['automations', 'crm'],
  seatPriceMinor: 10_000,
  seatsMax: 10,
  numberPriceMinor: 50_000,
  numbersMax: null,
  runPackSize: 500,
  runPackPriceMinor: 25_000,
  apiRequestPackSize: null,
  apiRequestPackPriceMinor: null,
};

describe('priceListLines', () => {
  it('states what the version includes and the add-ons it sells', () => {
    expect(priceListLines(plan)).toEqual({
      included: [
        '2 seats',
        '1 WhatsApp number',
        'Unlimited teams',
        '5 live automations',
        '1,000 automation runs a month',
        'Unlimited public API requests a month',
        'With Automations, CRM',
        'Without WhatsApp Flows, Commerce and stores',
      ],
      addOns: [
        'Extra seats: ₹100.00 each per month, up to 10 seats in all',
        'Extra WhatsApp numbers: ₹500.00 each per month',
        'Automation run packs: 500 more automation runs a month, ₹250.00 each per month',
      ],
    });
  });

  it('leaves out automation limits and run packs without the module, and says when the API is limited', () => {
    const lines = priceListLines({
      ...plan,
      intervalMonths: 12,
      seatsIncluded: 1,
      modules: [],
      apiRequestsMonthly: 2000,
      someApiScopes: true,
      seatPriceMinor: null,
      seatsMax: null,
      numbersMax: 3,
    });
    expect(lines.included).toEqual([
      '1 seat',
      '1 WhatsApp number',
      'Unlimited teams',
      '2,000 public API requests a month, for part of the API',
      'Without Automations, WhatsApp Flows, CRM, Commerce and stores',
    ]);
    expect(lines.addOns).toEqual([
      'Extra WhatsApp numbers: ₹500.00 each per year, up to 3 numbers in all',
    ]);
    expect(priceListLines({ ...plan, apiRequestsMonthly: 0 }).included).toContain('No public API');
  });

  it('states the API request packs a version sells, with or without automations (ADR-110)', () => {
    const withPacks = {
      ...plan,
      apiRequestsMonthly: 10_000,
      apiRequestPackSize: 5000,
      apiRequestPackPriceMinor: 40_000,
    };
    expect(priceListLines(withPacks).addOns.at(-1)).toBe(
      'API request packs: 5,000 more public API requests a month, ₹400.00 each per month',
    );
    expect(priceListLines({ ...withPacks, modules: [] }).addOns).toEqual([
      'Extra seats: ₹100.00 each per month, up to 10 seats in all',
      'Extra WhatsApp numbers: ₹500.00 each per month',
      'API request packs: 5,000 more public API requests a month, ₹400.00 each per month',
    ]);
  });
});
