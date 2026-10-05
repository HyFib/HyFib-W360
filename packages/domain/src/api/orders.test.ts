import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, ORDER_STATUSES, type Database } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { ORDER_REFERENCE_RE } from '../commerce/model';
import type { ApiContext } from './context';
import { API_SCOPE_INFO } from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';
import { apiGetOrder, apiListOrders, apiOrderListQuerySchema } from './orders';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const OTHER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: 'k', scopes: new Set(scopes) },
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

describe('WhatsApp orders through the API (ADR-167)', () => {
  it('are read with orders.read, a reading scope the database accepts, granted with commerce.read', () => {
    expect(API_SCOPES).toContain('orders.read');
    expect(API_SCOPE_INFO['orders.read']).toMatchObject({
      label: 'Read WhatsApp orders',
      permission: 'commerce.read',
      writes: false,
    });
    for (const words of ['Never Payment Links or payment ids', 'Commerce']) {
      expect(API_SCOPE_INFO['orders.read'].description).toContain(words);
    }
    // Only owners and administrators create keys, and both read orders in the app.
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('commerce.read')).toBe(true);
    }
  });

  it('take a page, a status, a contact, a conversation, a reference and a time, nothing else', () => {
    const parse = (input: unknown) => apiOrderListQuerySchema.safeParse(input);
    const parsed = parse({});
    expect(parsed.success && [parsed.data.limit, parsed.data.cursor]).toEqual([50, undefined]);
    for (const status of ORDER_STATUSES) expect(parse({ status }).success).toBe(true);
    for (const input of [
      { limit: '100', cursor: 'abc' },
      { contactId: TENANT, conversationId: OTHER },
      { reference: 'K7M2QX9P' },
      { updatedSince: '2026-10-01T00:00:00+05:30' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(true);
    }
    for (const input of [
      { limit: '101' },
      { limit: '0' },
      { status: 'shipped' },
      { contactId: 'someone' },
      { conversationId: 'chat' },
      { reference: 'k7m2qx9p' },
      { reference: 'K7M2QX9I' },
      { reference: 'K7M2QX9' },
      { updatedSince: 'yesterday' },
      { channelId: TENANT },
      { direction: 'inbound' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('need orders.read and refuse bad requests before reading anything', async () => {
    const missing = ['forbidden', 'This API key does not have the orders.read scope.', []];
    expect(
      await refusal(apiListOrders({ db: untouched }, ctx(['conversations.read']), {})),
    ).toEqual(missing);
    expect(await refusal(apiGetOrder({ db: untouched }, ctx(['contacts.read']), TENANT))).toEqual(
      missing,
    );
    expect(
      (await refusal(apiListOrders({ db: untouched }, ctx(['orders.read']), { limit: '500' })))[2],
    ).toEqual(['limit']);
    expect(
      (await refusal(apiListOrders({ db: untouched }, ctx(['orders.read']), { cursor: 'x' })))[0],
    ).toBe('validation_failed');
    expect(
      (await refusal(apiGetOrder({ db: untouched }, ctx(['orders.read']), 'not-an-id')))[0],
    ).toBe('not_found');
  });

  it('read in a read-only transaction, while the company is suspended too', async () => {
    for (const status of ['active', 'suspended', 'restricted']) {
      const { db, runs } = reached();
      await expect(apiListOrders({ db }, ctx(['orders.read'], status), {})).rejects.toThrow(
        'reached the database',
      );
      await expect(apiGetOrder({ db }, ctx(['orders.read'], status), TENANT)).rejects.toThrow(
        'reached the database',
      );
      expect(runs).toEqual([{ accessMode: 'read only' }, { accessMode: 'read only' }]);
    }
  });

  it('are described: the scope, Commerce, pages, filters, money and what is never sent', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown>; responses?: unknown };
    };
    expect(API_ROUTES).toContainEqual(['get', '/orders']);
    expect(API_ROUTES).toContainEqual(['get', '/orders/{id}']);
    const list = doc.paths['/orders']?.get as {
      operationId: string;
      description: string;
      parameters: { name?: string; schema?: { pattern?: string; enum?: string[] } }[];
      responses: Record<string, { description?: string; content?: unknown }>;
    };
    expect(list.operationId).toBe('listOrders');
    expect(list.parameters.map((p) => p.name)).toEqual([
      'limit',
      'cursor',
      'status',
      'contactId',
      'conversationId',
      'reference',
      'updatedSince',
    ]);
    const param = (name: string) => list.parameters.find((p) => p.name === name)?.schema;
    expect(param('status')?.enum).toEqual([...ORDER_STATUSES]);
    expect(param('reference')?.pattern).toBe(ORDER_REFERENCE_RE.source);
    expect(Object.keys(list.responses)).toEqual(
      expect.arrayContaining(['200', '401', '403', '422', '429']),
    );
    expect(Object.keys(list.responses)).not.toContain('404');
    for (const words of [
      'Scope: `orders.read`.',
      'newest first by when they were received',
      'pages never skip or repeat an order',
      '(403, reason not_in_plan)',
      'integers in the currency’s minor units',
      'Payment Links and Razorpay’s payment ids are never read here',
      'without the note',
      '`updatedSince` a little before your previous pass began',
    ]) {
      expect(list.description).toContain(words);
    }
    expect(list.responses['403']?.description).toContain('reading orders (reason not_in_plan)');

    const one = doc.paths['/orders/{id}']?.get as {
      operationId: string;
      description: string;
      responses: Record<string, unknown>;
    };
    expect(one.operationId).toBe('getOrder');
    expect(one.description).toContain('Scope: `orders.read`.');
    expect(Object.keys(one.responses)).toEqual(expect.arrayContaining(['200', '403', '404']));

    const schema = doc.components.schemas.Order as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual([
      'id',
      'reference',
      'status',
      'statusChangedAt',
      'conversationId',
      'contactId',
      'channelId',
      'messageId',
      'catalogId',
      'currency',
      'subtotalMinor',
      'itemCount',
      'droppedItems',
      'customerNote',
      'items',
      'receivedAt',
      'paidAt',
      'updatedAt',
    ]);
    expect(schema.required).toEqual(Object.keys(schema.properties));
    // Ids only: no number or payment details anywhere in it.
    expect(JSON.stringify(schema)).not.toMatch(
      /"(phone|contactName|paymentLink\w*|shortUrl|paymentId)"/,
    );
  });
});
