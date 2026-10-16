import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import type { Database } from '@w360/db';
import type { ApiContext } from './context';
import { MAX_DEAL_ITEMS, MAX_ITEM_QUANTITY } from '../crm/deal-items';
import { MAX_DEAL_MINOR } from '../crm/money';
import {
  apiAddDealItem,
  apiAddDealItemSchema,
  apiListDealItems,
  apiRemoveDealItem,
  apiRemoveDealItemQuerySchema,
  toApiDealItem,
} from './deal-items';
import { API_SCOPE_INFO } from './model';
import {
  API_ROUTES,
  apiAddedDealItemSchema,
  apiDealItemSchema,
  buildOpenApiDocument,
} from './openapi';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const DEAL = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const ITEM = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const QUOTE_SYNC = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: QUOTE_SYNC, scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read. */
const untouched = {
  run: () => {
    throw new Error('read the database');
  },
} as unknown as Database;

/** A database that records the options of the transaction it was asked for, then stops it. */
function reached() {
  const runs: unknown[] = [];
  const db = {
    run: (_scope: unknown, _fn: unknown, options?: unknown) => {
      runs.push(options);
      throw new Error('reached the database');
    },
  } as unknown as Database;
  return { db, runs };
}

const deps = (db: Database) => ({ db, clock: { now: () => new Date() } });

/** The code, message and paths of a refusal. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return [error.code, error.publicMessage, (error.issues ?? []).map((i) => i.path)];
  }
  throw new Error('expected a refusal');
}

const item = { retailerId: 'MUG-01', quantity: 2, unitPriceMinor: 25_000 };

describe('products on deals through the API (ADR-378)', () => {
  it('are read with deals.read, added with deals.write and orders.read, removed with deals.write', () => {
    expect(API_SCOPE_INFO['deals.read'].description).toContain('the products listed on each deal');
    for (const words of [
      'remove products listed on them',
      "With the scope that reads WhatsApp orders, also list products of the company's catalogs on deals",
    ]) {
      expect(API_SCOPE_INFO['deals.write'].description).toContain(words);
    }
  });

  it('take a content id, a quantity, a unit price in minor units, a catalog and a version', () => {
    const parse = (input: unknown) => apiAddDealItemSchema.safeParse(input);
    expect(parse(item).success && parse(item).data).toEqual(item);
    for (const input of [
      { ...item, catalogId: '1234567890' },
      { ...item, expectedVersion: 3 },
      { ...item, quantity: 1, unitPriceMinor: 0 },
      { ...item, quantity: MAX_ITEM_QUANTITY },
      { ...item, unitPriceMinor: MAX_DEAL_MINOR },
      { ...item, retailerId: 'x'.repeat(100) },
      // Content ids are kept exactly as Meta keeps them.
      { ...item, retailerId: ' MUG 01 ' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(true);
    }
    for (const input of [
      { quantity: 2, unitPriceMinor: 25_000 },
      { retailerId: 'MUG-01', unitPriceMinor: 25_000 },
      { retailerId: 'MUG-01', quantity: 2 },
      { ...item, retailerId: '' },
      { ...item, retailerId: 'x'.repeat(101) },
      { ...item, catalogId: 'summer' },
      { ...item, catalogId: '1'.repeat(33) },
      { ...item, quantity: 0 },
      { ...item, quantity: MAX_ITEM_QUANTITY + 1 },
      { ...item, quantity: 1.5 },
      { ...item, quantity: '2' },
      { ...item, unitPriceMinor: -1 },
      { ...item, unitPriceMinor: 2.5 },
      { ...item, unitPriceMinor: MAX_DEAL_MINOR + 1 },
      { ...item, unitPriceMinor: '250.00' },
      { ...item, expectedVersion: 0 },
      { ...item, productId: ITEM },
      { ...item, name: 'Mug' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('take an expected version, and nothing else, when one is removed', () => {
    const parse = (input: unknown) => apiRemoveDealItemQuerySchema.safeParse(input);
    expect(parse({}).success && parse({}).data).toEqual({});
    expect(parse({ expectedVersion: '4' }).success && parse({ expectedVersion: '4' }).data).toEqual(
      { expectedVersion: 4 },
    );
    for (const input of [{ expectedVersion: '0' }, { expectedVersion: 'x' }, { force: 'true' }]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('refuse keys without the scopes, suspended companies and bad requests before anything is read', async () => {
    expect(await refusal(apiListDealItems({ db: untouched }, ctx(['orders.read']), DEAL))).toEqual([
      'forbidden',
      'This API key does not have the deals.read scope.',
      [],
    ]);
    expect(
      await refusal(apiAddDealItem(deps(untouched), ctx(['deals.write']), DEAL, item, null)),
    ).toEqual(['forbidden', 'This API key does not have the orders.read scope.', []]);
    expect(
      await refusal(apiAddDealItem(deps(untouched), ctx(['orders.read']), DEAL, item, null)),
    ).toEqual(['forbidden', 'This API key does not have the deals.write scope.', []]);
    expect(
      await refusal(apiRemoveDealItem(deps(untouched), ctx(['deals.read']), DEAL, ITEM, {})),
    ).toEqual(['forbidden', 'This API key does not have the deals.write scope.', []]);
    for (const status of ['suspended', 'restricted']) {
      const writer = ctx(['deals.write', 'orders.read'], status);
      expect((await refusal(apiAddDealItem(deps(untouched), writer, DEAL, item, null)))[0]).toBe(
        'tenant_suspended',
      );
      expect((await refusal(apiRemoveDealItem(deps(untouched), writer, DEAL, ITEM, {})))[0]).toBe(
        'tenant_suspended',
      );
    }
    const writer = ctx(['deals.write', 'orders.read']);
    // Ids that are not ids are not found.
    expect((await refusal(apiListDealItems({ db: untouched }, ctx(['deals.read']), 'x')))[0]).toBe(
      'not_found',
    );
    expect((await refusal(apiAddDealItem(deps(untouched), writer, 'x', item, null)))[0]).toBe(
      'not_found',
    );
    expect((await refusal(apiRemoveDealItem(deps(untouched), writer, DEAL, 'x', {})))[0]).toBe(
      'not_found',
    );
    expect(
      (
        await refusal(apiAddDealItem(deps(untouched), writer, DEAL, { ...item, quantity: 0 }, null))
      )[2],
    ).toEqual(['quantity']);
    expect(
      (
        await refusal(
          apiRemoveDealItem(deps(untouched), writer, DEAL, ITEM, { expectedVersion: '0' }),
        )
      )[2],
    ).toEqual(['expectedVersion']);
    // A total beyond what a deal can be worth is refused without a read.
    expect(
      await refusal(
        apiAddDealItem(
          deps(untouched),
          writer,
          DEAL,
          { ...item, quantity: 2, unitPriceMinor: MAX_DEAL_MINOR },
          null,
        ),
      ),
    ).toEqual([
      'validation_failed',
      'The quantity times the unit price is more than a deal can be worth.',
      ['quantity'],
    ]);
  });

  it('are read in a reading transaction, also while the company is suspended, and changed in a writing one', async () => {
    const list = reached();
    await expect(
      apiListDealItems({ db: list.db }, ctx(['deals.read'], 'suspended'), DEAL),
    ).rejects.toThrow('reached the database');
    expect(list.runs).toEqual([{ accessMode: 'read only' }]);
    const writer = ctx(['deals.write', 'orders.read']);
    const add = reached();
    await expect(apiAddDealItem(deps(add.db), writer, DEAL, item, null)).rejects.toThrow(
      'reached the database',
    );
    const remove = reached();
    await expect(apiRemoveDealItem(deps(remove.db), writer, DEAL, ITEM, {})).rejects.toThrow(
      'reached the database',
    );
    expect([...add.runs, ...remove.runs]).toEqual([undefined, undefined]);
  });

  it('give each product with its exact total and who added it', () => {
    const row = {
      id: ITEM,
      retailerId: 'MUG-01',
      catalogId: '1234567890',
      name: 'Blue mug',
      quantity: MAX_ITEM_QUANTITY,
      unitPriceMinor: 10_000_000_000,
      currency: 'INR',
      createdByApiKeyId: QUOTE_SYNC,
      createdAt: new Date('2026-10-16T05:30:00Z'),
    };
    const byKey = toApiDealItem(row);
    expect(byKey).toEqual({
      id: ITEM,
      retailerId: 'MUG-01',
      catalogId: '1234567890',
      name: 'Blue mug',
      quantity: MAX_ITEM_QUANTITY,
      unitPriceMinor: 10_000_000_000,
      currency: 'INR',
      totalMinor: MAX_DEAL_MINOR,
      createdBy: 'api',
      createdByApiKeyId: QUOTE_SYNC,
      createdAt: '2026-10-16T05:30:00.000Z',
    });
    expect(apiDealItemSchema.safeParse(byKey).success).toBe(true);
    const byMember = toApiDealItem({
      ...row,
      quantity: 3,
      unitPriceMinor: 333,
      createdByApiKeyId: null,
    });
    expect([byMember.totalMinor, byMember.createdBy, byMember.createdByApiKeyId]).toEqual([
      999,
      'member',
      null,
    ]);
    expect(apiAddedDealItemSchema.safeParse({ ...byMember, dealVersion: 7 }).success).toBe(true);
    expect(apiAddedDealItemSchema.safeParse(byMember).success).toBe(false);
  });

  it('are described: the scopes, the catalogs, the refusals, the version and what is not sent', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: {
        schemas: Record<
          string,
          {
            properties: Record<string, unknown>;
            required: string[];
            additionalProperties?: boolean;
          }
        >;
      };
    };
    for (const route of [
      ['get', '/deals/{id}/items'],
      ['post', '/deals/{id}/items'],
      ['delete', '/deals/{id}/items/{itemId}'],
    ] as const) {
      expect(API_ROUTES).toContainEqual(route);
    }
    type Operation = {
      operationId: string;
      description: string;
      parameters: { name?: string; $ref?: string; in?: string }[];
      responses: Record<string, unknown>;
    };
    const list = doc.paths['/deals/{id}/items']?.get as Operation;
    const add = doc.paths['/deals/{id}/items']?.post as Operation;
    const remove = doc.paths['/deals/{id}/items/{itemId}']?.delete as Operation;
    expect([list.operationId, add.operationId, remove.operationId]).toEqual([
      'listDealItems',
      'addDealItem',
      'removeDealItem',
    ]);
    expect(remove.parameters.map((p) => p.name ?? p.$ref)).toEqual([
      '#/components/parameters/Id',
      'itemId',
      'expectedVersion',
    ]);
    expect(Object.keys(add.responses)).toEqual([
      '201',
      '400',
      '401',
      '403',
      '404',
      '409',
      '415',
      '422',
      '423',
      '429',
      '500',
    ]);
    expect(Object.keys(list.responses)).toEqual(['200', '401', '403', '404', '429', '500']);
    for (const words of [
      'Scope: `deals.read`.',
      `in the order they were added (at most ${MAX_DEAL_ITEMS})`,
      'keeps its own currency',
      '(403, reason not_in_plan)',
    ]) {
      expect(list.description).toContain(words);
    }
    for (const words of [
      'Scopes: `deals.write` and `orders.read`.',
      'named by its content id (`catalogId` picks the catalog when more than one has it)',
      'the catalog’s price is never assumed',
      `when the deal already lists ${MAX_DEAL_ITEMS} products`,
      'with 409 on an erased contact’s deal',
      'Needs the CRM and Commerce in the company’s plan',
      'no deal event is sent, as when members add one, and the deal’s history leaves it out',
      'PATCH /deals/{id} sets it',
    ]) {
      expect(add.description).toContain(words);
    }
    for (const words of ['Scope: `deals.write`.', 'A product already removed answers 404']) {
      expect(remove.description).toContain(words);
    }
    const schemas = doc.components.schemas;
    expect(schemas.DealItem?.required.sort()).toEqual(
      [
        'catalogId',
        'createdAt',
        'createdBy',
        'createdByApiKeyId',
        'currency',
        'id',
        'name',
        'quantity',
        'retailerId',
        'totalMinor',
        'unitPriceMinor',
      ].sort(),
    );
    expect(schemas.AddedDealItem?.required).toContain('dealVersion');
    expect(Object.keys(schemas.AddDealItem?.properties ?? {})).toEqual([
      'retailerId',
      'catalogId',
      'quantity',
      'unitPriceMinor',
      'expectedVersion',
    ]);
    expect(schemas.AddDealItem?.required.sort()).toEqual(
      ['quantity', 'retailerId', 'unitPriceMinor'].sort(),
    );
    expect(schemas.AddDealItem?.additionalProperties).toBe(false);
  });
});
