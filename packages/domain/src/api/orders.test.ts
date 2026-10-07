import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, ORDER_STATUSES, type Database } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { ORDER_REFERENCE_RE } from '../commerce/model';
import type { ApiContext } from './context';
import { API_SCOPE_INFO } from './model';
import { API_ROUTES, apiOrderSchema, buildOpenApiDocument } from './openapi';
import {
  apiGetOrder,
  apiListOrders,
  apiOrderListQuerySchema,
  apiUpdateOrder,
  apiUpdateOrderSchema,
} from './orders';

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
      // Who made each order's latest change (ADR-271).
      '`statusChangedBy` says who made an order’s latest status change',
      'so an integration can tell the orders it changed last from those members or payments did',
    ]) {
      expect(list.description).toContain(words);
    }
    expect(list.responses['403']?.description).toContain(
      'reading or changing orders (reason not_in_plan)',
    );

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
      'statusChangedBy',
      'statusChangedByApiKeyId',
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
    // Who made the latest change: a member (never which), a key by its id, or the Payment Link.
    const changer = apiOrderSchema.shape.statusChangedBy;
    expect(changer.unwrap().options).toEqual(['member', 'api', 'payment_link']);
    expect(changer.safeParse(null).success).toBe(true);
    expect(changer.description).toContain('never which member');
    expect(changer.description).toContain('Null while the order is as the customer sent it');
    const key = apiOrderSchema.shape.statusChangedByApiKeyId;
    expect(key.safeParse(null).success).toBe(true);
    expect(key.safeParse('key-1').success).toBe(false);
    expect(key.description).toContain('when statusChangedBy is api');
    // Ids only: no number or payment details anywhere in it.
    expect(JSON.stringify(schema)).not.toMatch(
      /"(phone|contactName|paymentLink\w*|shortUrl|paymentId)"/,
    );
  });
});

describe('changing WhatsApp orders through the API (ADR-168)', () => {
  const deps = (db: Database) => ({ db, clock: { now: () => new Date() } });

  it('need orders.write, a writing scope the database accepts, granted with inbox.reply', () => {
    expect(API_SCOPES).toContain('orders.write');
    expect(API_SCOPE_INFO['orders.write']).toMatchObject({
      label: 'Confirm, fulfil and cancel WhatsApp orders',
      permission: 'inbox.reply',
      writes: true,
    });
    for (const words of ['as members do', 'Never payments', 'Payment Links', 'Commerce']) {
      expect(API_SCOPE_INFO['orders.write'].description).toContain(words);
    }
    // Members change an order with inbox.reply and commerce.read: every role with the first has
    // the second, and owners and administrators, who create keys, have both.
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      if (permissions.has('inbox.reply')) expect(permissions.has('commerce.read'), role).toBe(true);
    }
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('inbox.reply')).toBe(true);
    }
  });

  it('take a status members can choose and, if wanted, the status expected, nothing else', () => {
    const parse = (input: unknown) => apiUpdateOrderSchema.safeParse(input);
    for (const status of ['confirmed', 'fulfilled', 'cancelled']) {
      expect(parse({ status }).success, status).toBe(true);
      for (const expectedStatus of ORDER_STATUSES) {
        expect(parse({ status, expectedStatus }).success, expectedStatus).toBe(true);
      }
    }
    for (const input of [
      {},
      { status: 'received' },
      { status: 'awaiting_payment' },
      { status: 'paid' },
      { status: 'shipped' },
      { status: 'Confirmed' },
      { status: 'confirmed', expectedStatus: 'shipped' },
      { status: 'confirmed', expectedStatus: null },
      { status: 'cancelled', reason: 'Out of stock' },
      { status: 'fulfilled', expectedVersion: 2 },
      { status: 'fulfilled', note: 'Shipped' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('refuse a key without orders.write, a suspended company and a bad request before reading anything', async () => {
    const change = (scopes: string[], input: unknown, id = TENANT, status = 'active') =>
      refusal(apiUpdateOrder(deps(untouched), ctx(scopes, status), id, input));
    expect(await change(['orders.read'], { status: 'confirmed' })).toEqual([
      'forbidden',
      'This API key does not have the orders.write scope.',
      [],
    ]);
    for (const status of ['suspended', 'restricted']) {
      expect((await change(['orders.write'], { status: 'confirmed' }, TENANT, status))[0]).toBe(
        'tenant_suspended',
      );
    }
    expect((await change(['orders.write'], { status: 'confirmed' }, 'not-an-id'))[0]).toBe(
      'not_found',
    );
    expect((await change(['orders.write'], { status: 'paid' }))[2]).toEqual(['status']);
    expect((await change(['orders.write'], { status: 'cancelled', why: 'x' }))[0]).toBe(
      'validation_failed',
    );
  });

  it('change the order in one read committed transaction', async () => {
    const { db, runs } = reached();
    await expect(
      apiUpdateOrder(deps(db), ctx(['orders.write']), TENANT, { status: 'fulfilled' }),
    ).rejects.toThrow('reached the database');
    expect(runs).toEqual([undefined]);
  });

  it('is described: the scope, the moves, refusals, payments, the event and retries', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(API_ROUTES).toContainEqual(['patch', '/orders/{id}']);
    const op = doc.paths['/orders/{id}']?.patch as {
      operationId: string;
      description: string;
      requestBody: unknown;
      responses: Record<string, { content?: unknown }>;
    };
    expect(op.operationId).toBe('updateOrder');
    expect(op.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateOrder' } } },
    });
    expect(op.responses['200']?.content).toEqual(
      (doc.paths['/orders/{id}']?.get as { responses: Record<string, { content?: unknown }> })
        .responses['200']?.content,
    );
    expect(Object.keys(op.responses)).toEqual(
      expect.arrayContaining(['200', '403', '404', '409', '422', '423', '429']),
    );
    for (const words of [
      'Scope: `orders.write`.',
      'a received order is confirmed or cancelled, a confirmed one fulfilled or cancelled, a paid one fulfilled',
      '(403, reason not_in_plan)',
      '`order.status_changed` webhook event follows',
      '(409, naming the order’s status, changing nothing)',
      'an order not in `expectedStatus`',
      'members cancel its Payment Link in the app first',
      'Nothing is sent to the customer.',
      'whatever `expectedStatus` says, so a retry is safe without an `Idempotency-Key`',
    ]) {
      expect(op.description).toContain(words);
    }
    const schema = doc.components.schemas.UpdateOrder as {
      properties: { status: { enum: string[] }; expectedStatus: { enum: string[] } };
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties)).toEqual(['status', 'expectedStatus']);
    expect(schema.properties.status.enum).toEqual(['confirmed', 'fulfilled', 'cancelled']);
    expect(schema.properties.expectedStatus.enum).toEqual([...ORDER_STATUSES]);
    expect(schema.required).toEqual(['status']);
    expect(schema.additionalProperties).toBe(false);
  });
});
