import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isAppError } from '@w360/core';
import type { Database, SQL, TenantRole, Tx } from '@w360/db';
import type { TenantContext } from '../authz/context';
import { permissionsForRoles } from '../authz/permissions';
import { fieldConditionProblem, fieldComparisonsFor } from '../campaigns/segments';
import {
  webhookFieldConditionEditable,
  webhookFieldValueEditable,
  webhookFieldValuesFromLines,
} from '../webhooks/model';
import {
  chosenContactOptionsMessage,
  createContactField,
  lockContactFieldValues,
  setContactFieldOptions,
  type ContactFieldDefinition,
} from './field-definitions';
import {
  MAX_FIELD_OPTION_LENGTH,
  MAX_FIELD_OPTIONS,
  apiFieldFilterValue,
  apiFieldValue,
  coerceFieldValue,
  fieldOptionsSchema,
  optionChanges,
  removedChosenOptions,
  sameOptions,
} from './fields';
import {
  attributePatch,
  createContactsService,
  createFieldSchema,
  sameFieldShape,
} from './service';

const tier = { label: 'Tier', type: 'choice' as const, options: ['Gold', 'Silver', 'Bronze'] };
const read = (result: { ok: true; value: unknown } | { ok: false; message: string }) =>
  result.ok ? result.value : `refused: ${result.message}`;

describe('choice-type custom contact fields (ADR-407)', () => {
  it('define a choice with 1 to 50 options, each trimmed, at most 80 characters, none twice', () => {
    expect(fieldOptionsSchema.parse(['  Gold ', 'Silver'])).toEqual(['Gold', 'Silver']);
    expect(MAX_FIELD_OPTIONS).toBe(50);
    expect(MAX_FIELD_OPTION_LENGTH).toBe(80);
    expect(
      fieldOptionsSchema.safeParse(Array.from({ length: 50 }, (_, i) => `o${i}`)).success,
    ).toBe(true);
    expect(fieldOptionsSchema.safeParse(['x'.repeat(80)]).success).toBe(true);
    for (const bad of [
      [],
      Array.from({ length: 51 }, (_, i) => `o${i}`),
      ['x'.repeat(81)],
      ['   '],
      ['Gold', 'gold'],
      ['Gold', ' GOLD '],
      ['Go\nld'],
      ['Go\rld'],
      ['Go\u0007ld'],
      ['Go\u0085ld'],
      'Gold',
    ]) {
      expect(fieldOptionsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const twice = fieldOptionsSchema.safeParse(['Gold', 'Silver', 'gold']);
    expect(twice.success).toBe(false);
    expect(twice.error?.issues[0]).toMatchObject({ path: [2], message: '“gold” is listed twice.' });
  });

  it('add a field from Settings: a choice needs options, and no other type takes any', () => {
    expect(createFieldSchema.parse({ label: 'Tier', type: 'choice', options: ['Gold'] })).toEqual({
      label: 'Tier',
      type: 'choice',
      options: ['Gold'],
    });
    expect(createFieldSchema.parse({ label: 'City', type: 'text' })).toEqual({
      label: 'City',
      type: 'text',
    });
    expect(createFieldSchema.safeParse({ label: 'Tier', type: 'choice' }).success).toBe(false);
    expect(
      createFieldSchema.safeParse({ label: 'City', type: 'text', options: ['Pune'] }).success,
    ).toBe(false);
    expect(createFieldSchema.safeParse({ label: 'Tier', type: 'list' }).success).toBe(false);
  });

  it('take one of the options from forms, CSV files, bulk edits, automations and Flows whatever the case, stored as written', () => {
    expect(read(coerceFieldValue(tier, 'Gold'))).toBe('Gold');
    expect(read(coerceFieldValue(tier, '  gold '))).toBe('Gold');
    expect(read(coerceFieldValue(tier, 'SILVER'))).toBe('Silver');
    expect(read(coerceFieldValue(tier, ''))).toBeNull();
    expect(read(coerceFieldValue(tier, '   '))).toBeNull();
    expect(read(coerceFieldValue(tier, 'Platinum'))).toBe(
      'refused: Tier must be one of its options.',
    );
    expect(read(coerceFieldValue(tier, 'Gol'))).toBe('refused: Tier must be one of its options.');
    expect(read(coerceFieldValue({ ...tier, options: null }, 'Gold'))).toBe(
      'refused: Tier must be one of its options.',
    );
  });

  it('take one of the options through the API exactly as written; null or empty removes it', () => {
    expect(read(apiFieldValue(tier, 'Gold'))).toBe('Gold');
    expect(read(apiFieldValue(tier, ' Gold '))).toBe('Gold');
    expect(read(apiFieldValue(tier, null))).toBeNull();
    expect(read(apiFieldValue(tier, ''))).toBeNull();
    expect(read(apiFieldValue(tier, '  '))).toBeNull();
    const refused =
      'refused: Tier takes one of its options, written as GET /contact-fields lists them.';
    for (const bad of ['gold', 'GOLD', 'Platinum', 1, true, ['Gold'], { value: 'Gold' }]) {
      expect(read(apiFieldValue(tier, bad)), JSON.stringify(bad)).toBe(refused);
    }
  });

  it('find contacts by an option through the API whatever its case, refusing a value that is none', () => {
    expect(read(apiFieldFilterValue(tier, 'gold'))).toBe('Gold');
    expect(read(apiFieldFilterValue(tier, 'Bronze'))).toBe('Bronze');
    expect(read(apiFieldFilterValue(tier, 'Platinum'))).toBe(
      'refused: Tier must be one of its options.',
    );
    expect(read(apiFieldFilterValue(tier, ' '))).toBe('refused: Give a value of Tier to find.');
  });

  it('compare a choice in segments as text is compared: equals and not, set or not', () => {
    expect(fieldComparisonsFor('choice')).toEqual(['is_set', 'is_not_set', 'equals', 'not_equals']);
    expect(fieldConditionProblem('choice', 'equals', 'gold')).toBeNull();
    // A value that is no option is no error: it matches nobody, so saved segments keep reading.
    expect(fieldConditionProblem('choice', 'equals', 'Platinum')).toBeNull();
    expect(fieldConditionProblem('choice', 'equals', '')).toBe('value_missing');
    expect(fieldConditionProblem('choice', 'contains', 'go')).toBe('comparison');
    expect(fieldConditionProblem('choice', 'greater_than', '1')).toBe('comparison');
    expect(fieldConditionProblem('choice', 'is_true', undefined)).toBe('comparison');
    expect(fieldConditionProblem('choice', 'is_set', undefined)).toBeNull();
  });

  it('tick a choice field’s options in Settings → Webhooks, keeping a value that is none apart', () => {
    expect(webhookFieldValueEditable('choice', 'Gold', tier.options)).toBe(true);
    expect(webhookFieldValueEditable('choice', 'gold', tier.options)).toBe(false);
    expect(webhookFieldValueEditable('choice', 'Platinum', tier.options)).toBe(false);
    expect(webhookFieldValueEditable('choice', 'Gold')).toBe(false);
    expect(webhookFieldValueEditable('choice', true, tier.options)).toBe(false);
    expect(
      webhookFieldConditionEditable('choice', { key: 't', value: 'Silver' }, tier.options),
    ).toBe(true);
    expect(
      webhookFieldConditionEditable('choice', { key: 't', contains: 'Silver' }, tier.options),
    ).toBe(false);
    expect(webhookFieldConditionEditable('choice', { key: 't', atLeast: 1 }, tier.options)).toBe(
      false,
    );
    expect(webhookFieldValuesFromLines(tier, 'gold\n\nbronze')).toEqual({
      ok: true,
      values: ['Gold', 'Bronze'],
    });
    expect(webhookFieldValuesFromLines(tier, 'Platinum')).toEqual({
      ok: false,
      message: 'Tier must be one of its options.',
    });
  });

  it('change options only while every option contacts have chosen stays as written', () => {
    expect(sameOptions(['Gold', 'Silver'], ['Gold', 'Silver'])).toBe(true);
    expect(sameOptions(['Gold', 'Silver'], ['Silver', 'Gold'])).toBe(false);
    expect(sameOptions(['Gold'], ['gold'])).toBe(false);
    expect(sameOptions(['Gold'], ['Gold', 'Silver'])).toBe(false);
    expect(removedChosenOptions(['Gold', 'Silver', 'Bronze'], ['Gold'], ['Silver'])).toEqual([
      'Silver',
    ]);
    expect(removedChosenOptions(['Gold', 'Silver'], ['gold', 'Silver'], ['Gold'])).toEqual([
      'Gold',
    ]);
    expect(removedChosenOptions(['Gold', 'Silver'], ['Silver', 'Gold', 'New'], ['Gold'])).toEqual(
      [],
    );
    expect(removedChosenOptions(['Gold', 'Silver'], ['Gold'], [])).toEqual([]);
    expect(optionChanges(['Gold', 'Silver'], ['Silver', 'Platinum', 'Bronze'])).toEqual({
      added: 2,
      removed: 1,
    });
    expect(optionChanges(['Gold'], ['Gold'])).toEqual({ added: 0, removed: 0 });
    expect(chosenContactOptionsMessage(['Silver'])).toBe(
      'Contacts have “Silver” chosen, so it cannot be removed or renamed. Change those contacts first.',
    );
    expect(chosenContactOptionsMessage(['Gold', 'Silver'])).toBe(
      'Contacts have “Gold”, “Silver” chosen, so they cannot be removed or renamed. Change those contacts first.',
    );
  });
});

/** A transaction that answers the statements a change of options makes, and records them. */
function fakeTx(state: {
  field: ContactFieldDefinition | null;
  used: string[];
  updated?: boolean;
}) {
  const dialect = new PgDialect();
  const log = {
    locks: [] as string[],
    params: [] as unknown[][],
    updates: [] as string[][],
    order: [] as string[],
  };
  const chain = (kind: string, result: () => unknown[]) => {
    const builder: Record<string, unknown> = {};
    for (const step of ['from', 'where', 'orderBy']) builder[step] = () => builder;
    builder.set = (values: { options: string[] }) => {
      log.updates.push(values.options);
      return builder;
    };
    builder.returning = () => Promise.resolve(result());
    builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      log.order.push(kind);
      return Promise.resolve(result()).then(resolve, reject);
    };
    return builder;
  };
  const tx = {
    execute: async (query: SQL) => {
      log.order.push('lock');
      const compiled = dialect.sqlToQuery(query);
      log.locks.push(compiled.sql);
      log.params.push(compiled.params);
      return { rows: [] };
    },
    select: () => chain('select', () => (state.field ? [state.field] : [])),
    selectDistinct: () => chain('used', () => state.used.map((value) => ({ value }))),
    update: () =>
      chain('update', () =>
        state.field && state.updated !== false
          ? [{ ...state.field, options: log.updates.at(-1) ?? null }]
          : [],
      ),
    insert: () => ({
      values: (row: ContactFieldDefinition) => ({
        onConflictDoNothing: () => ({ returning: async () => [{ ...row, createdAt: new Date() }] }),
      }),
    }),
  };
  return { tx: tx as unknown as Tx, log };
}

const field = (overrides: Partial<ContactFieldDefinition> = {}): ContactFieldDefinition => ({
  id: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01',
  key: 'tier',
  label: 'Tier',
  type: 'choice',
  options: ['Gold', 'Silver', 'Bronze'],
  createdAt: new Date('2026-10-21T09:00:00Z'),
  ...overrides,
});

const code = (fn: () => Promise<unknown>) =>
  fn().then(
    () => 'done',
    (error: unknown) => (isAppError(error) ? `${error.code}: ${error.message}` : String(error)),
  );

describe('changing a choice field’s options (ADR-407)', () => {
  it('takes the company’s contact-field lock exclusively, before reading the field', async () => {
    const { tx, log } = fakeTx({ field: field(), used: [] });
    await setContactFieldOptions(tx, 't1', { id: field().id }, ['Gold', 'Silver']);
    expect(log.order[0]).toBe('lock');
    expect(log.locks[0]).toContain('pg_advisory_xact_lock(');
    expect(log.locks[0]).not.toContain('shared');
  });

  it('writes of values take the same company’s lock shared', async () => {
    const shared = fakeTx({ field: null, used: [] });
    await lockContactFieldValues(shared.tx, 't1');
    expect(shared.log.locks[0]).toContain('pg_advisory_xact_lock_shared(');
    const exclusive = fakeTx({ field: null, used: [] });
    await setContactFieldOptions(exclusive.tx, 't1', { id: field().id }, ['Gold']);
    expect(shared.log.params[0]).toEqual(['contact-fields:t1']);
    expect(exclusive.log.params[0]).toEqual(['contact-fields:t1']);
  });

  it('adds, reorders and removes options no contact has chosen, counting them', async () => {
    const { tx, log } = fakeTx({ field: field(), used: ['Gold'] });
    const result = await setContactFieldOptions(tx, 't1', { id: field().id }, [
      'Silver',
      'Gold',
      'Platinum',
    ]);
    expect(result).toMatchObject({ changed: true, added: 1, removed: 1 });
    expect(result?.field.options).toEqual(['Silver', 'Gold', 'Platinum']);
    expect(log.updates).toEqual([['Silver', 'Gold', 'Platinum']]);
  });

  it('changes nothing for the same list, without reading values', async () => {
    const { tx, log } = fakeTx({ field: field(), used: ['Gold'] });
    const result = await setContactFieldOptions(tx, 't1', { id: field().id }, [
      'Gold',
      'Silver',
      'Bronze',
    ]);
    expect(result).toMatchObject({ changed: false, added: 0, removed: 0 });
    expect(log.updates).toEqual([]);
    expect(log.order).not.toContain('used');
  });

  it('refuses to remove or rename an option a contact has chosen, naming it', async () => {
    for (const next of [
      ['Gold', 'Bronze'],
      ['Gold', 'silver', 'Bronze'],
      ['Gold', 'Silver '],
    ]) {
      const trimmed = next.map((o) => o.trim());
      const { tx, log } = fakeTx({ field: field(), used: ['Silver'] });
      const outcome = await code(() =>
        setContactFieldOptions(tx, 't1', { id: field().id }, trimmed),
      );
      if (trimmed.includes('Silver')) {
        expect(outcome).toBe('done');
        continue;
      }
      expect(outcome).toBe(
        'conflict: Contacts have “Silver” chosen, so it cannot be removed or renamed. Change those contacts first.',
      );
      expect(log.updates).toEqual([]);
    }
  });

  it('is not found for a field the company does not have, and refused for another type', async () => {
    expect(
      await setContactFieldOptions(fakeTx({ field: null, used: [] }).tx, 't1', { key: 'x' }, ['A']),
    ).toBeNull();
    expect(
      await code(() =>
        setContactFieldOptions(
          fakeTx({ field: field({ type: 'text', options: null }), used: [] }).tx,
          't1',
          { key: 'tier' },
          ['A'],
        ),
      ),
    ).toBe('validation_failed: Only choice fields have options.');
    // Deleted between the read and the change: not found either.
    expect(
      await setContactFieldOptions(
        fakeTx({ field: field(), used: [], updated: false }).tx,
        't1',
        { id: field().id },
        ['Gold'],
      ),
    ).toBeNull();
  });

  it('stores a new choice field’s options, and none for another type', async () => {
    const choice = await createContactField(fakeTx({ field: null, used: [] }).tx, 't1', {
      label: 'Tier',
      type: 'choice',
      options: ['Gold', 'Silver'],
    });
    expect(choice.options).toEqual(['Gold', 'Silver']);
    const text = await createContactField(fakeTx({ field: null, used: [] }).tx, 't1', {
      label: 'City',
      type: 'text',
      options: ['ignored'],
    });
    expect(text.options).toBeNull();
  });
});

const ctxOf = (roles: TenantRole[]) =>
  ({
    tenant: { id: 't', status: 'active' },
    membership: { id: 'm' },
    user: { id: 'u' },
    permissions: permissionsForRoles(roles),
    rolePermissions: permissionsForRoles(roles),
    plan: { modules: new Set() },
    mfa: { blocking: false },
  }) as unknown as TenantContext;

const unreachableDb = {
  run: () => {
    throw new Error('the database was reached');
  },
} as unknown as Database;

describe('an import whose fields change while it reads the file (ADR-407)', () => {
  const row = {
    id: 'f1',
    key: 'tier',
    label: 'Tier',
    type: 'choice' as const,
    options: ['Gold', 'Silver'],
  };
  it('goes on only while each mapped field takes the values it read them against', () => {
    expect(sameFieldShape(row, { ...row, label: 'Level' })).toBe(true);
    expect(sameFieldShape(row, { ...row, options: ['Gold', 'Silver'] })).toBe(true);
    expect(sameFieldShape(row, { ...row, options: ['Gold'] })).toBe(false);
    expect(sameFieldShape(row, { ...row, options: ['Silver', 'Gold'] })).toBe(false);
    expect(sameFieldShape(row, { ...row, options: ['gold', 'Silver'] })).toBe(false);
    expect(sameFieldShape(row, { ...row, id: 'f2' })).toBe(false);
    const text = { ...row, type: 'text' as const, options: null };
    expect(sameFieldShape(text, { ...text })).toBe(true);
    expect(sameFieldShape(text, row)).toBe(false);
    // Deleted and added again with the same key as another type: another field, and another id.
    expect(sameFieldShape(text, { ...text, type: 'number' })).toBe(false);
    expect(sameFieldShape(row, { ...row, options: null })).toBe(false);
  });
});

describe('the patch an import writes over a locked contact (ADR-407)', () => {
  it('sets the values given and removes those given empty, as mergeAttributes would', () => {
    expect(attributePatch({ city: 'Pune', tier: 'Gold' }, { city: 'Delhi' })).toEqual({
      set: { city: 'Delhi' },
      removed: [],
    });
    expect(attributePatch({ city: 'Pune' }, { tier: 'Gold', city: null })).toEqual({
      set: { tier: 'Gold' },
      removed: ['city'],
    });
  });

  it('changes nothing for values the contact already has, or keys it has no value for', () => {
    expect(attributePatch({ city: 'Pune', n: 3, vip: true }, { city: 'Pune', n: 3 })).toBeNull();
    expect(attributePatch({ vip: false }, { vip: false, tier: null })).toBeNull();
    expect(attributePatch({}, {})).toBeNull();
    // Values compare by type: the number 3 is not the text "3".
    expect(attributePatch({ n: '3' }, { n: 3 })).toEqual({ set: { n: 3 }, removed: [] });
  });
});

describe('changing options in Settings → Messaging (ADR-407)', () => {
  const service = createContactsService({ db: unreachableDb, clock: { now: () => new Date() } });
  const id = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';

  it('is for members who manage the company’s settings, checked before anything is read', async () => {
    for (const role of ['agent', 'analyst', 'supervisor'] as TenantRole[]) {
      expect(await code(() => service.setFieldOptions(ctxOf([role]), id, ['Gold']))).toMatch(
        /^forbidden/,
      );
    }
    for (const role of ['owner', 'admin'] as TenantRole[]) {
      expect(await code(() => service.setFieldOptions(ctxOf([role]), id, ['Gold']))).toBe(
        'Error: the database was reached',
      );
    }
  });

  it('refuses bad options and ids no field can have before anything is read', async () => {
    const owner = ctxOf(['owner']);
    for (const bad of [[], ['A', 'a'], 'Gold', ['x'.repeat(81)]]) {
      expect(await code(() => service.setFieldOptions(owner, id, bad))).toMatch(
        /^validation_failed/,
      );
    }
    expect(await code(() => service.setFieldOptions(owner, 'nope', ['Gold']))).toMatch(
      /^not_found/,
    );
  });
});
