import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { TenantRole, Tx } from '@w360/db';
import type { TenantContext } from '../authz/context';
import { permissionsForRoles } from '../authz/permissions';
import { validDate } from '../contacts/fields';
import {
  FIELD_COMPARISONS,
  NAME_COMPARISONS,
  assertCanUseDefinition,
  checkSegmentDefinition,
  comparisonTakesValue,
  fieldComparisonsFor,
  fieldConditionProblem,
  readsStoreOrders,
  segmentConditionsSql,
  segmentDefinitionSchema,
  type SegmentDefinition,
} from './segments';

/** Conditions without a campaign never read the database. */
const noTx = undefined as unknown as Tx;

describe('field conditions (segments and contact searches, ADR-117)', () => {
  it('offers each type of field its own comparisons, in segments’ order', () => {
    expect(fieldComparisonsFor('text')).toEqual([
      'is_set',
      'is_not_set',
      'equals',
      'not_equals',
      'contains',
    ]);
    expect(fieldComparisonsFor('number')).toEqual([
      'is_set',
      'is_not_set',
      'equals',
      'not_equals',
      'greater_than',
      'less_than',
    ]);
    expect(fieldComparisonsFor('date')).toEqual([
      'is_set',
      'is_not_set',
      'equals',
      'before',
      'after',
    ]);
    expect(fieldComparisonsFor('boolean')).toEqual(['is_set', 'is_not_set', 'is_true', 'is_false']);
    expect(FIELD_COMPARISONS.filter((op) => !comparisonTakesValue(op))).toEqual([
      'is_set',
      'is_not_set',
      'is_true',
      'is_false',
    ]);
  });

  it('names what keeps a condition from applying: the comparison, a missing value, a number or a date', () => {
    expect(fieldConditionProblem('text', 'greater_than', 'a')).toBe('comparison');
    expect(fieldConditionProblem('boolean', 'equals', 'true')).toBe('comparison');
    expect(fieldConditionProblem('date', 'not_equals', '2026-01-01')).toBe('comparison');
    expect(fieldConditionProblem('text', 'equals', undefined)).toBe('value_missing');
    expect(fieldConditionProblem('number', 'less_than', '')).toBe('value_missing');
    expect(fieldConditionProblem('number', 'greater_than', 'three')).toBe('not_number');
    expect(fieldConditionProblem('number', 'greater_than', '1234567890123456')).toBe('not_number');
    expect(fieldConditionProblem('number', 'greater_than', '1.1234567')).toBe('not_number');
    expect(fieldConditionProblem('date', 'before', '2026-02-30')).toBe('not_date');
    expect(fieldConditionProblem('date', 'after', '26-02-01')).toBe('not_date');
    // What applies.
    expect(fieldConditionProblem('number', 'greater_than', '-3.5')).toBeNull();
    expect(fieldConditionProblem('date', 'equals', '2024-02-29')).toBeNull();
    expect(fieldConditionProblem('text', 'contains', '50%')).toBeNull();
    expect(fieldConditionProblem('boolean', 'is_true', undefined)).toBeNull();
    expect(fieldConditionProblem('text', 'is_not_set', undefined)).toBeNull();
  });

  it('takes only dates that exist', () => {
    expect(['2024-02-29', '2026-12-31', '1990-04-01'].map(validDate)).toEqual([true, true, true]);
    expect(
      ['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-01', ' 2026-01-01'].map(validDate),
    ).toEqual([false, false, false, false, false]);
  });

  it('refuses a segment whose creation day or date comparison does not exist, in members’ words', async () => {
    const fields = new Map([['birthday', 'date' as const]]);
    const check = (conditions: SegmentDefinition['conditions']) =>
      checkSegmentDefinition(noTx, 'tenant', { match: 'all', conditions }, fields);
    expect(await check([{ type: 'created', op: 'before', date: '2026-02-30' }])).toBe(
      'Enter a date written as YYYY-MM-DD.',
    );
    expect(
      await check([{ type: 'field', key: 'birthday', op: 'after', value: '1990-13-01' }]),
    ).toBe('Enter a date written as YYYY-MM-DD.');
    expect(await check([{ type: 'field', key: 'birthday', op: 'contains', value: '1990' }])).toBe(
      'That comparison does not apply to date fields.',
    );
    expect(await check([{ type: 'field', key: 'birthday', op: 'equals' }])).toBe(
      'Enter a value to compare with.',
    );
    expect(await check([{ type: 'field', key: 'missing', op: 'is_set' }])).toBe(
      'A condition uses a custom field that does not exist.',
    );
    expect(await check([{ type: 'created', op: 'after', date: '2024-02-29' }])).toBeNull();
  });
});

describe('name conditions (ADR-143)', () => {
  const check = (conditions: SegmentDefinition['conditions']) =>
    checkSegmentDefinition(noTx, 'tenant', { match: 'all', conditions }, new Map());

  it('compares a name as a text field’s value is compared', () => {
    expect([...NAME_COMPARISONS]).toEqual(fieldComparisonsFor('text'));
  });

  it('needs the name to compare with for equals, not_equals and contains, in members’ words', async () => {
    for (const op of ['equals', 'not_equals', 'contains'] as const) {
      expect(await check([{ type: 'name', op }])).toBe('Enter a name to compare with.');
      expect(await check([{ type: 'name', op, value: '' }])).toBe('Enter a name to compare with.');
      expect(await check([{ type: 'name', op, value: 'Asha' }])).toBeNull();
    }
    expect(await check([{ type: 'name', op: 'is_set' }])).toBeNull();
    expect(await check([{ type: 'name', op: 'is_not_set' }])).toBeNull();
  });

  it('reads a definition’s name conditions trimmed, up to 200 characters, with the comparisons that apply', () => {
    const parse = (condition: Record<string, unknown>) =>
      segmentDefinitionSchema.safeParse({ conditions: [condition] });
    expect(parse({ type: 'name', op: 'contains', value: '  Asha  ' }).data?.conditions).toEqual([
      { type: 'name', op: 'contains', value: 'Asha' },
    ]);
    expect(parse({ type: 'name', op: 'equals', value: ` ${'x'.repeat(200)} ` }).success).toBe(true);
    expect(parse({ type: 'name', op: 'equals', value: 'x'.repeat(201) }).success).toBe(false);
    expect(parse({ type: 'name', op: 'greater_than', value: 'a' }).success).toBe(false);
    expect(parse({ type: 'name', op: 'is_true' }).success).toBe(false);
  });
});

describe('conditions on store orders (ADR-231)', () => {
  const STORE = '0192a4c6-7a10-7000-8000-000000000001';
  const parse = (condition: Record<string, unknown>) =>
    segmentDefinitionSchema.safeParse({ conditions: [condition] });
  /** A transaction whose only read finds these stores. */
  const storesTx = (ids: string[]) =>
    ({
      select: () => ({ from: () => ({ where: async () => ids.map((id) => ({ id })) }) }),
    }) as unknown as Tx;
  const check = (conditions: SegmentDefinition['conditions'], tx: Tx = noTx) =>
    checkSegmentDefinition(tx, 'tenant', { match: 'all', conditions }, new Map());

  it('reads order counts and spend within their bounds, a store and a period optional', () => {
    expect(parse({ type: 'orders', op: 'at_least', count: 2 }).data?.conditions).toEqual([
      { type: 'orders', op: 'at_least', count: 2 },
    ]);
    expect(
      parse({ type: 'orders', op: 'fewer_than', count: '1', days: '90', storeId: STORE }).data
        ?.conditions,
    ).toEqual([{ type: 'orders', op: 'fewer_than', count: 1, days: 90, storeId: STORE }]);
    for (const wrong of [
      { type: 'orders', op: 'at_least', count: 0 },
      { type: 'orders', op: 'at_least', count: 10_001 },
      { type: 'orders', op: 'at_least', count: 1.5 },
      { type: 'orders', op: 'at_least', count: 1, days: 0 },
      { type: 'orders', op: 'at_least', count: 1, days: 3651 },
      { type: 'orders', op: 'more_than', count: 1 },
      { type: 'orders', op: 'at_least', count: 1, storeId: 'store' },
      { type: 'spend', op: 'at_least', currency: 'inr', amountMinor: 100 },
      { type: 'spend', op: 'at_least', currency: 'INR', amountMinor: -1 },
      { type: 'spend', op: 'at_least', currency: 'INR', amountMinor: 1.5 },
      { type: 'spend', op: 'fewer_than', currency: 'INR', amountMinor: 1 },
    ]) {
      expect(parse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
    expect(
      parse({ type: 'spend', op: 'less_than', currency: 'INR', amountMinor: 250_000 }).success,
    ).toBe(true);
  });

  it('refuses a currency HyFib does not know and a store the company does not have', async () => {
    expect(
      await check([{ type: 'spend', op: 'at_least', currency: 'XQZ', amountMinor: 100 }]),
    ).toBe('Choose a currency HyFib knows.');
    expect(
      await check([{ type: 'spend', op: 'at_least', currency: 'INR', amountMinor: 100 }]),
    ).toBeNull();
    const inStore = [
      { type: 'orders' as const, op: 'at_least' as const, count: 1, storeId: STORE },
    ];
    expect(await check(inStore, storesTx([]))).toBe(
      'A condition refers to a store that is no longer connected.',
    );
    expect(await check(inStore, storesTx([STORE]))).toBeNull();
    const spentInStore = [
      {
        type: 'spend' as const,
        op: 'at_least' as const,
        currency: 'INR',
        amountMinor: 1,
        storeId: STORE,
      },
    ];
    expect(await check(spentInStore, storesTx([]))).toBe(
      'A condition refers to a store that is no longer connected.',
    );
  });

  it('needs access to store orders to use them', () => {
    const ctxOf = (roles: TenantRole[]) =>
      ({ permissions: permissionsForRoles(roles) }) as unknown as TenantContext;
    const orders: SegmentDefinition = {
      match: 'any',
      conditions: [
        { type: 'tag', op: 'has', tag: 'vip' },
        { type: 'spend', op: 'at_least', currency: 'INR', amountMinor: 1 },
      ],
    };
    const tags: SegmentDefinition = {
      match: 'all',
      conditions: [{ type: 'tag', op: 'has', tag: 'vip' }],
    };
    expect(readsStoreOrders(orders)).toBe(true);
    expect(readsStoreOrders(tags)).toBe(false);
    expect(() => assertCanUseDefinition(ctxOf(['marketer']), orders)).not.toThrow();
    expect(() => assertCanUseDefinition(ctxOf(['analyst']), orders)).toThrow(
      expect.objectContaining({ code: 'forbidden' }),
    );
    expect(() => assertCanUseDefinition(ctxOf(['analyst']), tags)).not.toThrow();
  });

  it('counts the orders that count, by number, with every value a parameter', () => {
    const render = (condition: SegmentDefinition['conditions'][number]) =>
      new PgDialect().sqlToQuery(
        segmentConditionsSql({ match: 'all', conditions: [condition] }, 'Asia/Kolkata', new Map()),
      );
    const placed = render({ type: 'orders', op: 'at_least', count: 3, days: 30, storeId: STORE });
    expect(placed.sql).toContain('o.tenant_id = "app"."contacts"."tenant_id"');
    expect(placed.sql).toContain('o.customer_phone = "app"."contacts"."phone_e164"');
    expect(placed.sql).toContain('and o.store_id = $1::uuid');
    expect(placed.sql).toContain('and o.placed_at > now() - make_interval(days => $2)');
    expect(placed.sql).toContain('not o.test and o.deleted_at is null and o.cancelled_at is null');
    expect(placed.sql).toContain(
      "o.status not in ('cancelled', 'refunded', 'failed', 'trash', 'checkout-draft')",
    );
    expect(placed.sql).toContain(
      "coalesce(o.financial_status, '') not in ('refunded', 'voided', 'expired')",
    );
    expect(placed.sql).toMatch(
      /\(select count\(\*\) from app\.commerce_store_orders o[\s\S]*\) >= \$\d/,
    );
    expect(placed.params).toEqual([STORE, 30, 3]);
    expect(placed.sql).not.toContain(STORE);
    const anyTime = render({ type: 'orders', op: 'fewer_than', count: 1 });
    expect(anyTime.sql).not.toContain('store_id');
    expect(anyTime.sql).not.toContain('placed_at');
    expect(anyTime.sql).toMatch(/\) < \$1\)/);
    const spent = render({ type: 'spend', op: 'less_than', currency: 'INR', amountMinor: 500_000 });
    expect(spent.sql).toContain('coalesce(sum(o.total_minor), 0)');
    expect(spent.sql).toMatch(/and o\.currency = \$1\) < \$2/);
    expect(spent.params).toEqual(['INR', 500_000]);
    const enough = render({
      type: 'spend',
      op: 'at_least',
      currency: 'INR',
      amountMinor: 1,
      days: 7,
    });
    expect(enough.sql).toMatch(/and o\.currency = \$2\) >= \$3/);
    expect(enough.params).toEqual([7, 'INR', 1]);
  });
});
