import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableName, type SQL, type Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isAppError } from '@w360/core';
import type { Database } from '@w360/db';
import type { ApiContext } from '../api/context';
import { apiAddDealItem, apiRemoveDealItem } from '../api/deal-items';
import { API_DEAL_HISTORY_DETAILS, apiListDealHistory } from '../api/deals';
import type { TenantContext } from '../authz/context';
import { dealItemOperations } from '../crm/deal-items';
import { WEBHOOK_DEAL_DETAILS } from './model';
import { WEBHOOK_DEAL_DETAIL_CHANGES } from './payloads';

/**
 * deal.updated when a deal's products change (ADR-397). The database's trigger on the item
 * (migration 0308) captures one event naming `items` for each product added or removed: an
 * addition's maker is the item's own creator, a removal's the maker the transaction recorded on the
 * deal before it, so members and keys record themselves on the deal (with its version) before the
 * item changes. What the trigger captures and the endpoints' check are kept equal to the payload's
 * and Settings' lists. The capture itself runs in PostgreSQL: the integration tests (CI) cover it.
 */

const TENANT = '0192a1b2-0000-7000-8000-0000000000f0';
const DEAL = '0192a1b2-0000-7000-8000-0000000000d1';
const CONTACT = '0192a1b2-0000-7000-8000-0000000000c1';
const PIPELINE = '0192a1b2-0000-7000-8000-0000000000a1';
const STAGE = '0192a1b2-0000-7000-8000-0000000000b1';
const MEMBER = '0192a1b2-0000-7000-8000-0000000000e1';
const KEY = '0192a1b2-0000-7000-8000-0000000000e2';
const PRODUCT = '0192a1b2-0000-7000-8000-0000000000e4';
const ITEM = '0192a1b2-0000-7000-8000-000000000101';

/** One statement a transaction ran, as far as the order of writes needs it. */
interface Step {
  op: 'select' | 'insert' | 'update' | 'delete' | 'execute';
  table: string | null;
  lock: string | null;
  joined: boolean;
  set: Record<string, unknown> | null;
  values: Record<string, unknown> | null;
  where: SQL | null;
}

/**
 * A database whose transaction answers each statement with `answer` when it is awaited, recording
 * the statements in the order they ran.
 */
function recordingDb(answer: (step: Step) => unknown) {
  const steps: Step[] = [];
  const chain = (step: Step): unknown => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'then') {
            return (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
              steps.push(step);
              try {
                resolve(answer(step));
              } catch (error) {
                reject(error);
              }
            };
          }
          return (...args: unknown[]) => {
            if (property === 'from') step.table = getTableName(args[0] as Table);
            if (property === 'for') step.lock = String(args[0]);
            if (property === 'innerJoin' || property === 'leftJoin') step.joined = true;
            if (property === 'set') step.set = args[0] as Record<string, unknown>;
            if (property === 'values') step.values = args[0] as Record<string, unknown>;
            if (property === 'where') step.where = (args[0] as SQL | undefined) ?? null;
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const start = (op: Step['op'], table: Table | null) =>
    chain({
      op,
      table: table ? getTableName(table) : null,
      lock: null,
      joined: false,
      set: null,
      values: null,
      where: null,
    });
  const tx = {
    select: () => start('select', null),
    insert: (table: Table) => start('insert', table),
    update: (table: Table) => start('update', table),
    delete: (table: Table) => start('delete', table),
    execute: () => start('execute', null),
  };
  const db = {
    run: (_scope: unknown, fn: (transaction: unknown) => unknown) => fn(tx),
  } as unknown as Database;
  return { db, steps };
}

/** A company whose plan includes the CRM and Commerce, as `app.tenant_entitlements` gives it. */
const plan = {
  plan_status: 'active',
  plan_id: null,
  seats: 5,
  numbers: 1,
  teams: 1,
  live_automations: 1,
  automation_runs: 100,
  api_requests: 1_000,
  modules: ['crm', 'commerce'],
  usage_anchor: '2026-10-01T00:00:00.000Z',
  api_scopes: null,
};

/** The reads of a change of products: the deal at version 4, its contact, the product, … */
function answers(options: { removed: boolean }) {
  return (step: Step): unknown => {
    if (step.op === 'execute') return { rows: [plan] };
    if (step.op === 'select') {
      switch (step.table) {
        case 'crm_deals':
          return step.lock === 'update'
            ? [{ id: DEAL, contactId: CONTACT, pipelineId: PIPELINE, stageId: STAGE, version: 4 }]
            : [{ contactId: CONTACT }];
        case 'contacts':
          return [{ erasedAt: null }];
        case 'commerce_products':
          return [{ id: PRODUCT, name: 'Blue mug' }];
        case 'crm_deal_items':
          // The count before an addition; the item read back after a key's addition.
          return step.joined
            ? [
                {
                  id: ITEM,
                  retailerId: 'MUG-01',
                  catalogId: '7781000001',
                  name: 'Blue mug',
                  quantity: 2,
                  unitPriceMinor: 25_000,
                  currency: 'INR',
                  createdByApiKeyId: KEY,
                  createdAt: new Date('2026-10-16T12:00:00.000Z'),
                },
              ]
            : [{ count: 1 }];
        case 'crm_pipelines':
          return [{ currency: 'INR' }];
        default:
          throw new Error(`an unexpected read of ${step.table}`);
      }
    }
    if (step.op === 'delete') return options.removed ? [{ name: 'Blue mug' }] : [];
    return [];
  };
}

/** The writes a transaction made, in order. */
const writes = (steps: Step[]) =>
  steps.filter((s) => s.op !== 'select' && s.op !== 'execute').map((s) => `${s.op} ${s.table}`);

const member = {
  tenant: { id: TENANT, status: 'active' },
  membership: { id: MEMBER },
  permissions: new Set(['crm.write', 'commerce.read']),
  rolePermissions: new Set(['crm.write', 'commerce.read']),
  scope: {},
} as unknown as TenantContext;

const key = {
  tenant: { id: TENANT, status: 'active' },
  key: { id: KEY, scopes: new Set(['deals.write', 'orders.read']) },
  planScopes: null,
  scope: {},
  requestId: 'request-1',
} as unknown as ApiContext;

const clock = { now: () => new Date('2026-10-16T12:00:00.000Z') };

async function refusalCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return error.code;
  }
  throw new Error('expected a refusal');
}

describe('a change of a deal’s products as deal.updated (ADR-397)', () => {
  it('records the member on the deal, with its version, before a product is added or removed, then the timeline', async () => {
    const added = recordingDb(answers({ removed: true }));
    const result = await dealItemOperations({ db: added.db, clock }).addDealItem(member, {
      dealId: DEAL,
      expectedVersion: 4,
      productId: PRODUCT,
      quantity: 2,
      unitPrice: '250',
    });
    expect(result.version).toBe(5);
    expect(writes(added.steps)).toEqual([
      'update crm_deals',
      'insert crm_deal_items',
      'insert crm_activities',
    ]);
    const [mark, item] = added.steps.filter((s) => s.op === 'update' || s.op === 'insert');
    expect(mark?.set).toMatchObject({ version: 5, changedBy: 'member', changedByApiKeyId: null });
    // The item names the member who added it: the addition's maker in its event.
    expect(item?.values).toMatchObject({ createdByMembershipId: MEMBER, dealId: DEAL });
    expect(item?.values).not.toHaveProperty('createdByApiKeyId');

    const removed = recordingDb(answers({ removed: true }));
    expect(
      await dealItemOperations({ db: removed.db, clock }).removeDealItem(member, {
        dealId: DEAL,
        expectedVersion: 4,
        itemId: ITEM,
      }),
    ).toEqual({ version: 5 });
    expect(writes(removed.steps)).toEqual([
      'update crm_deals',
      'delete crm_deal_items',
      'insert crm_activities',
    ]);
    expect(removed.steps.find((s) => s.op === 'update')?.set).toMatchObject({
      version: 5,
      changedBy: 'member',
      changedByApiKeyId: null,
    });
    const [entry] = removed.steps.filter((s) => s.op === 'insert');
    expect(entry?.values).toMatchObject({
      kind: 'deal_updated',
      actorMembershipId: MEMBER,
      data: { fields: ['products'], productRemoved: 'Blue mug' },
    });

    // A product already removed is refused after the mark, which the transaction then rolls back;
    // no timeline entry is written.
    const gone = recordingDb(answers({ removed: false }));
    expect(
      await refusalCode(
        dealItemOperations({ db: gone.db, clock }).removeDealItem(member, {
          dealId: DEAL,
          expectedVersion: 4,
          itemId: ITEM,
        }),
      ),
    ).toBe('not_found');
    expect(writes(gone.steps)).toEqual(['update crm_deals', 'delete crm_deal_items']);
  });

  it('records the key on the deal, with its version, before a product is added or removed, then the timeline and the audit', async () => {
    const added = recordingDb(answers({ removed: true }));
    const response = await apiAddDealItem(
      { db: added.db, clock },
      key,
      DEAL,
      { retailerId: 'MUG-01', quantity: 2, unitPriceMinor: 25_000, expectedVersion: 4 },
      null,
    );
    expect(response).toMatchObject({ status: 201, body: { data: { id: ITEM, dealVersion: 5 } } });
    expect(writes(added.steps)).toEqual([
      'update crm_deals',
      'insert crm_deal_items',
      'insert crm_activities',
      'insert audit_events',
    ]);
    const [mark, item] = added.steps.filter((s) => s.op === 'update' || s.op === 'insert');
    expect(mark?.set).toMatchObject({ version: 5, changedBy: 'api', changedByApiKeyId: KEY });
    expect(item?.values).toMatchObject({ createdByApiKeyId: KEY, dealId: DEAL });
    expect(item?.values).not.toHaveProperty('createdByMembershipId');

    const removed = recordingDb(answers({ removed: true }));
    expect(
      await apiRemoveDealItem({ db: removed.db, clock }, key, DEAL, ITEM, {
        expectedVersion: '4',
      }),
    ).toEqual({ id: ITEM, deleted: true, dealVersion: 5 });
    expect(writes(removed.steps)).toEqual([
      'update crm_deals',
      'delete crm_deal_items',
      'insert crm_activities',
      'insert audit_events',
    ]);
    expect(removed.steps.find((s) => s.op === 'update')?.set).toMatchObject({
      version: 5,
      changedBy: 'api',
      changedByApiKeyId: KEY,
    });

    const gone = recordingDb(answers({ removed: false }));
    expect(await refusalCode(apiRemoveDealItem({ db: gone.db, clock }, key, DEAL, ITEM, {}))).toBe(
      'not_found',
    );
    expect(writes(gone.steps)).toEqual(['update crm_deals', 'delete crm_deal_items']);
  });

  it('is captured as migration 0308 says: `items` alone, the endpoints’ details as Settings offers them, nothing read without an endpoint, by the role making the change', () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL('../../../db/migrations/0308_webhook_deal_item_events.sql', import.meta.url),
      ),
      'utf8',
    );
    // The endpoints' check takes the details Settings and the API offer, no more.
    const listed = /deal_details <@ ARRAY\[([^\]]*)\]::text\[\]/.exec(migration)?.[1];
    expect(listed?.split(',').map((name) => name.trim().replace(/^'|'$/g, ''))).toEqual([
      ...WEBHOOK_DEAL_DETAILS,
    ]);
    expect(migration).toContain(
      `cardinality(deal_details) BETWEEN 1 AND ${WEBHOOK_DEAL_DETAILS.length}`,
    );
    expect([...WEBHOOK_DEAL_DETAILS]).toEqual([...WEBHOOK_DEAL_DETAIL_CHANGES]);
    // The trigger names `items`, the payload's last detail, with no field keys.
    expect(WEBHOOK_DEAL_DETAIL_CHANGES.at(-1)).toBe('items');
    expect(migration).toContain(`'changes', jsonb_build_array('items')`);
    expect(migration).toContain(`'changedFields', '[]'::jsonb`);
    // On every product added or removed, one row at a time.
    expect(migration).toContain(
      'CREATE TRIGGER crm_deal_items_webhook AFTER INSERT OR DELETE ON app.crm_deal_items\n  FOR EACH ROW EXECUTE FUNCTION app.webhook_capture_deal_item();',
    );
    // The role making the change runs it (not a definer function), its search path pinned, and
    // nobody else may.
    const header = migration.slice(
      migration.indexOf('CREATE FUNCTION app.webhook_capture_deal_item()'),
      migration.indexOf('AS $$'),
    );
    expect(header).toContain('LANGUAGE plpgsql');
    expect(header).toContain('SET search_path = pg_catalog, pg_temp');
    expect(header).not.toContain('SECURITY DEFINER');
    expect(migration).toContain(
      'REVOKE EXECUTE ON FUNCTION app.webhook_capture_deal_item() FROM PUBLIC;',
    );
    expect(migration).not.toMatch(/^\s*GRANT /m);
    // No deal is read before an active endpoint is known to take deal.updated (a company being
    // deleted has none left when its items go, and the definer role may not read a deal).
    const subscribed = migration.indexOf(`app.webhook_subscribed(v_tenant, 'deal.updated')`);
    expect(subscribed).toBeGreaterThan(0);
    expect(subscribed).toBeLessThan(migration.indexOf('FROM app.crm_deals d'));
    // An addition's maker is the item's creator; a removal's, only what this transaction recorded.
    expect(migration).toContain(
      `CASE WHEN NEW.created_by_api_key_id IS NOT NULL THEN 'api' ELSE 'member' END`,
    );
    expect(migration).toContain('ELSIF v_changed_xact = pg_catalog.pg_current_xact_id() THEN');
  });

  it('are in the API’s deal history: its timeline filter keeps every entry naming a detail it gives, products among them', async () => {
    const reads = recordingDb((step) => {
      if (step.op === 'execute') return { rows: [plan] };
      if (step.table === 'crm_deals') return [{ id: DEAL }];
      if (step.table === 'crm_activities') return [];
      throw new Error(`an unexpected read of ${step.table}`);
    });
    const reader = {
      tenant: { id: TENANT, status: 'active' },
      key: { id: KEY, scopes: new Set(['deals.read']) },
      planScopes: null,
      scope: {},
    } as unknown as ApiContext;
    expect(await apiListDealHistory({ db: reads.db }, reader, DEAL, {})).toEqual({
      data: [],
      nextCursor: null,
    });
    const timeline = reads.steps.find((s) => s.table === 'crm_activities');
    if (!timeline?.where) throw new Error('the timeline was read without a condition');
    const { sql: condition } = new PgDialect().sqlToQuery(timeline.where);
    // The names a `deal_updated` entry must hold one of: exactly the timeline's names of the
    // details the history gives, so an entry naming products alone is given (ADR-397).
    const names = /\?\| array\[([^\]]*)\]/.exec(condition)?.[1];
    expect(names?.split(',').map((name) => name.trim().replace(/^'|'$/g, ''))).toEqual(
      Object.keys(API_DEAL_HISTORY_DETAILS),
    );
    expect(Object.keys(API_DEAL_HISTORY_DETAILS)).toContain('products');
  });
});
