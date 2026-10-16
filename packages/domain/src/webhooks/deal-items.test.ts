import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DEAL_STATUSES } from '@w360/db';
import { apiDealItemsSchema, toApiDealItem } from '../api/deal-item-view';
import { apiDealItemSchema, buildOpenApiDocument } from '../api/openapi';
import { MAX_DEAL_ITEMS, MAX_ITEM_QUANTITY } from '../crm/deal-items';
import { MAX_DEAL_MINOR } from '../crm/money';
import { DEFAULT_EGRESS_POLICY, createEgressClient, EgressError } from '@w360/core/egress';
import { createWebhookEgressClient, webhookEgressPolicy, WEBHOOK_USER_AGENT } from './delivery';
import { WEBHOOK_LIMITS } from './model';
import {
  buildWebhookPayload,
  dealCreatedPayloadSchema,
  dealOwnerChangedPayloadSchema,
  dealStageChangedPayloadSchema,
  dealStatusChangedPayloadSchema,
  dealUpdatedPayloadSchema,
  WebhookEventGoneError,
} from './payloads';

/**
 * Products on deals in deal webhook payloads (ADR-395): every deal event's deal gives its items as
 * GET /deals/{id}/items reads them, when the event is delivered.
 */

const TENANT = '0192a1b2-0000-7000-8000-0000000000f0';
const DEAL = '0192a1b2-0000-7000-8000-0000000000d1';
const CONTACT = '0192a1b2-0000-7000-8000-0000000000c1';
const PIPELINE = '0192a1b2-0000-7000-8000-0000000000a1';
const STAGE = '0192a1b2-0000-7000-8000-0000000000b1';
const OWNER = '0192a1b2-0000-7000-8000-0000000000e1';
const KEY = '0192a1b2-0000-7000-8000-0000000000e2';
const EVENT = '0192a1b2-0000-7000-8000-0000000000e3';
const at = new Date('2026-10-16T09:30:00.000Z');

/** Item rows as the read gives them (the product's content id and catalog joined in). */
const plateRow = {
  id: '0192a1b2-0000-7000-8000-000000000101',
  retailerId: 'PLATE-01',
  catalogId: '7781000001',
  name: 'Plate',
  quantity: 1,
  unitPriceMinor: 1_000,
  currency: 'INR',
  createdByApiKeyId: null,
  createdAt: new Date('2026-10-16T09:00:00.000Z'),
};
const mugRow = {
  id: '0192a1b2-0000-7000-8000-000000000102',
  retailerId: 'MUG-01',
  catalogId: '7781000001',
  name: 'Blue mug',
  quantity: 3,
  unitPriceMinor: 150_050,
  currency: 'INR',
  createdByApiKeyId: KEY,
  createdAt: new Date('2026-10-16T09:10:00.000Z'),
};
const plate = {
  id: plateRow.id,
  retailerId: 'PLATE-01',
  catalogId: '7781000001',
  name: 'Plate',
  quantity: 1,
  unitPriceMinor: 1_000,
  currency: 'INR',
  totalMinor: 1_000,
  createdBy: 'member',
  createdByApiKeyId: null,
  createdAt: '2026-10-16T09:00:00.000Z',
};
const mug = {
  id: mugRow.id,
  retailerId: 'MUG-01',
  catalogId: '7781000001',
  name: 'Blue mug',
  quantity: 3,
  unitPriceMinor: 150_050,
  currency: 'INR',
  totalMinor: 450_150,
  createdBy: 'api',
  createdByApiKeyId: KEY,
  createdAt: '2026-10-16T09:10:00.000Z',
};

/** The deal row the payload reads. */
const dealRow = {
  id: DEAL,
  title: 'Bulk order',
  contactId: CONTACT,
  conversationId: null,
  pipelineId: PIPELINE,
  stageId: STAGE,
  status: 'open',
  valueMinor: 451_150,
  currency: 'INR',
  ownerId: OWNER,
  expectedCloseOn: null,
  lostReason: null,
  automationId: null,
  apiKeyId: null,
  createdAt: at,
};

const DEAL_EVENT_SCHEMAS = {
  'deal.created': dealCreatedPayloadSchema,
  'deal.updated': dealUpdatedPayloadSchema,
  'deal.stage_changed': dealStageChangedPayloadSchema,
  'deal.owner_changed': dealOwnerChangedPayloadSchema,
  'deal.status_changed': dealStatusChangedPayloadSchema,
} as const;
type DealEventType = keyof typeof DEAL_EVENT_SCHEMAS;

/** What each deal event captured, as its trigger stores it. */
const detailOf = (type: DealEventType): Record<string, unknown> => {
  const step = { dealId: DEAL, pipelineId: PIPELINE, stageId: STAGE, changedBy: 'member' };
  switch (type) {
    case 'deal.created':
      return { dealId: DEAL, pipelineId: PIPELINE, stageId: STAGE };
    case 'deal.updated':
      return { ...step, changes: ['title'] };
    case 'deal.stage_changed':
      return { ...step, previousStageId: STAGE, previousPipelineId: null };
    case 'deal.owner_changed':
      return { ...step, ownerId: OWNER, previousOwnerId: null };
    case 'deal.status_changed':
      return { ...step, previousStatus: 'won' };
  }
};

const eventOf = (type: DealEventType, detail = detailOf(type)) =>
  ({
    id: EVENT,
    tenantId: TENANT,
    type,
    messageId: null,
    conversationId: null,
    contactId: CONTACT,
    templateId: null,
    status: type === 'deal.status_changed' ? 'open' : null,
    detail,
    contactChanges: null,
    tagsAdded: null,
    tagsRemoved: null,
    occurredAt: at,
    occurredAtExact: '2026-10-16T09:30:00.000123Z',
  }) as unknown as Parameters<typeof buildWebhookPayload>[1];

interface Read {
  where: SQL | undefined;
  orderBy: SQL[] | null;
}

/**
 * A transaction answering each read with the next rows given, keeping each read's condition and
 * order so that what was asked for can be checked.
 */
function answering(answers: unknown[][]) {
  const queue = [...answers];
  const reads: Read[] = [];
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: (where: SQL | undefined) => {
      const rows = queue.shift();
      if (!rows) throw new Error('an unexpected read');
      const read: Read = { where, orderBy: null };
      reads.push(read);
      return Object.assign(Promise.resolve(rows), {
        orderBy: (...columns: SQL[]) => {
          read.orderBy = columns;
          return Promise.resolve(rows);
        },
      });
    },
  };
  return {
    tx: { select: () => chain } as unknown as Parameters<typeof buildWebhookPayload>[0],
    reads,
    unread: () => queue.length,
  };
}

const dialect = new PgDialect();
const query = (condition: SQL | undefined) => {
  if (!condition) throw new Error('a read without a condition');
  return dialect.sqlToQuery(condition);
};

/** The deal of a body as built, as an object. */
const dealIn = (built: { data: unknown }) => (built.data as { deal: Record<string, unknown> }).deal;

describe('products on deals in deal webhook payloads (ADR-395)', () => {
  it('describe items on every deal event as the API describes them, before who made the change', () => {
    // One description: the API's item, the same object, so the two cannot drift apart.
    expect(apiDealItemsSchema.element).toBe(apiDealItemSchema);
    for (const [type, schema] of Object.entries(DEAL_EVENT_SCHEMAS)) {
      const deal = schema.shape.data.shape.deal.shape;
      expect(deal.items.element, type).toBe(apiDealItemSchema);
      // Where the payload's own members end, changedBy and apiKeyId stay last (ADR-277).
      expect(Object.keys(deal).slice(-3), type).toEqual(['items', 'changedBy', 'apiKeyId']);
      expect(deal.items.description, type).toContain('exactly as GET /deals/{id}/items lists them');
      expect(deal.items.description, type).toContain(`at most ${MAX_DEAL_ITEMS}`);
      expect(deal.items.description, type).toContain('An erased contact’s deal keeps its products');
      // A change of products sends deal.updated since ADR-397.
      expect(deal.items.description, type).toContain(
        'Each product added or removed sends deal.updated naming `items` in its changes',
      );
      expect(deal.items.description, type).not.toContain('sends no event');
      expect(deal.items.description, type).toContain(
        'Bodies delivered before deal events carried products have no items',
      );
    }
  });

  it('accept no items, items in any order up to the most a deal lists, and nothing else', () => {
    const items = apiDealItemsSchema;
    expect(items.safeParse([]).success).toBe(true);
    expect(items.safeParse([plate, mug]).success).toBe(true);
    expect(items.safeParse([mug, plate]).success).toBe(true);
    // The largest item a deal can hold.
    const largest = toApiDealItem({
      ...mugRow,
      quantity: MAX_ITEM_QUANTITY,
      unitPriceMinor: MAX_DEAL_MINOR / MAX_ITEM_QUANTITY,
    });
    expect(largest.totalMinor).toBe(MAX_DEAL_MINOR);
    expect(items.safeParse([largest]).success).toBe(true);
    const many = (n: number) => Array.from({ length: n }, () => plate);
    expect(items.safeParse(many(MAX_DEAL_ITEMS)).success).toBe(true);
    expect(items.safeParse(many(MAX_DEAL_ITEMS + 1)).success).toBe(false);
    for (const change of [
      { quantity: 0 },
      { quantity: MAX_ITEM_QUANTITY + 1 },
      { quantity: 1.5 },
      { unitPriceMinor: -1 },
      { unitPriceMinor: 10.5 },
      { totalMinor: undefined },
      { createdBy: 'automation' },
      { createdByApiKeyId: 'key-1' },
      { createdAt: '16/10/2026' },
      { retailerId: undefined },
      { id: 'item-1' },
    ]) {
      expect(items.safeParse([{ ...plate, ...change }]).success, JSON.stringify(change)).toBe(
        false,
      );
    }
    expect(items.safeParse(null).success).toBe(false);
    // Required in every deal event's deal: a body without them is not described.
    const deal = {
      id: DEAL,
      title: 'Bulk order',
      pipelineId: PIPELINE,
      stageId: STAGE,
      status: 'open',
      previousStageId: null,
      previousPipelineId: null,
      previousStatus: null,
      previousOwnerId: null,
      valueMinor: 451_150,
      currency: 'INR',
      ownerId: OWNER,
      expectedCloseOn: null,
      lostReason: null,
      createdBy: 'member',
      createdAt: at.toISOString(),
      items: [plate, mug],
      changedBy: 'member',
      apiKeyId: null,
    };
    const body = {
      id: EVENT,
      type: 'deal.created',
      createdAt: '2026-10-16T09:30:00.000Z',
      createdAtExact: '2026-10-16T09:30:00.000123Z',
      data: { deal, conversation: null, contact: { id: CONTACT, phone: null, name: null } },
    };
    expect(dealCreatedPayloadSchema.safeParse(body).success).toBe(true);
    const { items: _left, ...withoutItems } = deal;
    expect(
      dealCreatedPayloadSchema.safeParse({ ...body, data: { ...body.data, deal: withoutItems } })
        .success,
    ).toBe(false);
  });

  it('build every deal event with the deal’s items as read when delivered, in the order read', async () => {
    for (const type of Object.keys(DEAL_EVENT_SCHEMAS) as DealEventType[]) {
      const reads = answering([
        [dealRow],
        [plateRow, mugRow],
        [{ phone: '+919876543210', name: 'Asha', erasedAt: null }],
      ]);
      const built = await buildWebhookPayload(reads.tx, eventOf(type), 'endpoint');
      expect(dealIn(built).items, type).toEqual([plate, mug]);
      expect(DEAL_EVENT_SCHEMAS[type].safeParse(built).success, type).toBe(true);
      expect(reads.unread(), type).toBe(0);
      // The items read: the deal's, of the event's company, in the order they were added.
      const items = reads.reads[1]!;
      const { sql: text, params } = query(items.where);
      expect(text, type).toBe(
        '("app"."crm_deal_items"."tenant_id" = $1 and "app"."crm_deal_items"."deal_id" = $2)',
      );
      expect(params, type).toEqual([TENANT, DEAL]);
      expect(dialect.sqlToQuery(sql.join(items.orderBy ?? [], sql`, `)).sql, type).toBe(
        '"app"."crm_deal_items"."created_at" asc, "app"."crm_deal_items"."id" asc',
      );
    }
    // Read in another order, given in that order: the read's order is the payload's.
    const reversed = answering([
      [dealRow],
      [mugRow, plateRow],
      [{ phone: '+919876543210', name: 'Asha', erasedAt: null }],
    ]);
    expect(
      dealIn(await buildWebhookPayload(reversed.tx, eventOf('deal.created'), 'endpoint')).items,
    ).toEqual([mug, plate]);
  });

  it('give a deal without products no items, and an erased contact’s deal its products', async () => {
    const none = answering([
      [dealRow],
      [],
      [{ phone: '+919876543210', name: 'Asha', erasedAt: null }],
    ]);
    const built = await buildWebhookPayload(none.tx, eventOf('deal.updated'), 'endpoint');
    expect(dealIn(built).items).toEqual([]);
    expect(dealUpdatedPayloadSchema.safeParse(built).success).toBe(true);
    // Erasure retitles the deal and blanks the contact; it keeps the products, which are sent.
    const erased = answering([
      [{ ...dealRow, title: 'Deal (contact erased)' }],
      [plateRow],
      [{ phone: '+919876543210', name: 'Asha', erasedAt: at }],
    ]);
    const forgotten = await buildWebhookPayload(erased.tx, eventOf('deal.updated'), 'endpoint');
    expect(dealIn(forgotten)).toMatchObject({ title: 'Deal (contact erased)', items: [plate] });
    expect((forgotten.data as { contact: unknown }).contact).toEqual({
      id: CONTACT,
      phone: null,
      name: null,
    });
  });

  it('read no items for a deal that is gone, nor for an id that is not one', async () => {
    const gone = answering([[]]);
    await expect(
      buildWebhookPayload(gone.tx, eventOf('deal.created'), 'endpoint'),
    ).rejects.toBeInstanceOf(WebhookEventGoneError);
    expect(gone.reads).toHaveLength(1);
    for (const dealId of ['deal-1', null, 7]) {
      const unread = answering([]);
      await expect(
        buildWebhookPayload(
          unread.tx,
          eventOf('deal.created', { ...detailOf('deal.created'), dealId }),
          'endpoint',
        ),
        String(dealId),
      ).rejects.toBeInstanceOf(WebhookEventGoneError);
      expect(unread.reads, String(dealId)).toHaveLength(0);
    }
  });

  it('keep a deal’s status and the rest of its event as before', async () => {
    for (const status of DEAL_STATUSES) {
      const reads = answering([
        [{ ...dealRow, status }],
        [mugRow],
        [{ phone: '+919876543210', name: 'Asha', erasedAt: null }],
      ]);
      const built = await buildWebhookPayload(reads.tx, eventOf('deal.stage_changed'), 'endpoint');
      expect(dealIn(built), status).toMatchObject({
        status,
        previousStageId: STAGE,
        items: [mug],
        changedBy: 'member',
        apiKeyId: null,
      });
    }
  });

  it('are described in the OpenAPI document for every deal event, with no decision numbers', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1') as unknown as {
      webhooks: Record<string, { post: { description: string } }>;
      components: { schemas: Record<string, unknown> };
    };
    const schemas = doc.components.schemas as Record<
      string,
      { properties: { data: { properties: { deal: DealSchema } } } }
    >;
    type DealSchema = {
      required?: string[];
      properties: Record<
        string,
        { type?: string; maxItems?: number; description?: string; items?: { required?: string[] } }
      >;
    };
    for (const name of [
      'WebhookDealCreated',
      'WebhookDealUpdated',
      'WebhookDealStageChanged',
      'WebhookDealOwnerChanged',
      'WebhookDealStatusChanged',
    ]) {
      const deal = schemas[name]!.properties.data.properties.deal;
      expect(deal.required, name).toContain('items');
      const items = deal.properties.items!;
      expect(items.type, name).toBe('array');
      expect(items.maxItems, name).toBe(MAX_DEAL_ITEMS);
      expect(items.items?.required, name).toEqual([
        'id',
        'retailerId',
        'catalogId',
        'name',
        'quantity',
        'unitPriceMinor',
        'currency',
        'totalMinor',
        'createdBy',
        'createdByApiKeyId',
        'createdAt',
      ]);
      expect(JSON.stringify(schemas[name]), name).not.toMatch(/ADR-\d/);
    }
    expect(doc.webhooks['deal.created']!.post.description).toContain(
      "Every deal event's deal.items lists the deal's products when the event is delivered, as GET /deals/{id}/items gives them",
    );
    // Since ADR-397 a change of products sends deal.updated naming items.
    expect(doc.webhooks['deal.created']!.post.description).toContain(
      "each product added or removed sends deal.updated naming items, so a receiver keeping products in step takes them from that event's deal.items",
    );
    expect(doc.webhooks['deal.updated']!.post.description).toContain(
      'Each product a member or an API key adds to or removes from the deal sends an event of its own whose changes names items alone, never the product, its price or its quantity',
    );
    for (const type of Object.keys(DEAL_EVENT_SCHEMAS)) {
      expect(doc.webhooks[type]!.post.description, type).not.toMatch(/products alone sends no/);
    }
    for (const type of Object.keys(DEAL_EVENT_SCHEMAS)) {
      expect(JSON.stringify(doc.webhooks[type]), type).not.toMatch(/ADR-\d/);
    }
  });

  describe('a change of products (ADR-397)', () => {
    /** A deal.updated as the item's trigger captures it (migration 0308). */
    const productChange = (by: Record<string, unknown>) =>
      eventOf('deal.updated', {
        dealId: DEAL,
        stageId: STAGE,
        pipelineId: PIPELINE,
        changes: ['items'],
        changedFields: [],
        ...by,
      });

    it('give `items` alone with no keys, who made the change as captured and the products as read when delivered', async () => {
      // A key added the mug: the products are read when the event is delivered, so a plate a
      // member added meanwhile is in them too.
      const reads = answering([
        [dealRow],
        [plateRow, mugRow],
        [{ phone: '+919876543210', name: 'Asha', erasedAt: null }],
      ]);
      const built = await buildWebhookPayload(
        reads.tx,
        productChange({ changedBy: 'api', apiKeyId: KEY }),
        'endpoint',
      );
      expect(dealUpdatedPayloadSchema.safeParse(built).success).toBe(true);
      const data = built.data as { changes: unknown; changedFields: unknown };
      expect(data.changes).toEqual(['items']);
      expect(data.changedFields).toEqual([]);
      expect(dealIn(built)).toMatchObject({
        changedBy: 'api',
        apiKeyId: KEY,
        items: [plate, mug],
      });
      // A member's removal, and one recorded without its maker, as captured.
      for (const [changedBy, apiKeyId] of [
        ['member', null],
        [null, null],
      ] as const) {
        const again = answering([
          [dealRow],
          [],
          [{ phone: '+919876543210', name: 'Asha', erasedAt: null }],
        ]);
        const body = await buildWebhookPayload(
          again.tx,
          productChange({ changedBy, apiKeyId }),
          'endpoint',
        );
        expect(dealUpdatedPayloadSchema.safeParse(body).success, String(changedBy)).toBe(true);
        expect(dealIn(body), String(changedBy)).toMatchObject({ changedBy, apiKeyId, items: [] });
      }
      // A worker that did not know `items` gave no change at all, which the payload's description
      // refuses: that is why workers learnt `items` a release before migration 0308 captured it.
      expect(
        dealUpdatedPayloadSchema.safeParse({ ...built, data: { ...data, changes: [] } }).success,
      ).toBe(false);
    });
  });

  describe('the largest deal event body', () => {
    // The character that takes the most bytes in a JSON body per character a column counts: a
    // control character, written as a six-byte escape (\u0001). A four-byte emoji takes fewer.
    const worst = (n: number) => '\u0001'.repeat(n);

    /** A deal.updated of a lost deal, each text at its column's most, with `names`-long names. */
    async function largestBody(names: number) {
      const reads = answering([
        [
          {
            ...dealRow,
            // crm_deals: a title of 120 characters, a lost reason of 200.
            title: worst(120),
            status: 'lost',
            lostReason: worst(200),
            valueMinor: MAX_DEAL_MINOR,
            expectedCloseOn: '2026-12-31',
            conversationId: '0192a1b2-0000-7000-8000-0000000000c9',
            apiKeyId: KEY,
          },
        ],
        // 50 items (ADR-375), each with the longest name (crm_deal_items: 500; product names hold
        // 200) and content id (100), the longest Meta catalog id, a key's id and the largest total.
        Array.from({ length: MAX_DEAL_ITEMS }, (_, n) => ({
          ...mugRow,
          id: `0192a1b2-0000-7000-8000-${String(n).padStart(12, '0')}`,
          retailerId: worst(100),
          catalogId: '9'.repeat(32),
          name: worst(names),
          quantity: MAX_ITEM_QUANTITY,
          unitPriceMinor: MAX_DEAL_MINOR / MAX_ITEM_QUANTITY,
          createdByApiKeyId: KEY,
        })),
        // contacts: a name of 200 characters, the longest E.164 number.
        [{ phone: '+123456789012345', name: worst(200), erasedAt: null }],
      ]);
      const built = await buildWebhookPayload(
        reads.tx,
        eventOf('deal.updated', {
          ...detailOf('deal.updated'),
          changedBy: 'api',
          apiKeyId: KEY,
          changes: ['title', 'valueMinor', 'expectedCloseOn', 'fields'],
          // 50 custom fields (ADR-373) with the longest keys.
          changedFields: Array.from({ length: 50 }, (_, n) =>
            `k${String(n).padStart(2, '0')}`.padEnd(40, 'x'),
          ),
        }),
        'endpoint',
      );
      expect(dealUpdatedPayloadSchema.safeParse(built).success).toBe(true);
      expect(reads.unread()).toBe(0);
      // Serialised as the delivery serialises it.
      return JSON.stringify(built);
    }

    it('fits the webhook request limit with room to spare, though not the 64 KiB of other requests', async () => {
      expect(WEBHOOK_LIMITS.requestBytes).toBe(256 * 1024);
      expect(Buffer.byteLength(JSON.stringify(worst(1)))).toBe(2 + 6);
      expect(Buffer.byteLength(JSON.stringify('😀'))).toBeLessThan(2 + 6);
      const largest = Buffer.byteLength(await largestBody(500));
      // 202,667 bytes: under the limit by more than 48 KiB.
      expect(largest).toBeGreaterThan(190_000);
      expect(largest).toBeLessThan(WEBHOOK_LIMITS.requestBytes - 48 * 1024);
      // With the 200 characters a catalog product's name holds (112,667 bytes), still beyond the
      // default limit.
      expect(Buffer.byteLength(await largestBody(200))).toBeGreaterThan(
        DEFAULT_EGRESS_POLICY.maxRequestBytes,
      );
    });

    it('is accepted by the webhook egress client, which keeps every other limit of the worker’s (stopping at the name lookup)', async () => {
      const policy = { ...DEFAULT_EGRESS_POLICY, allowLoopbackForTests: true, timeoutMs: 2_000 };
      expect(webhookEgressPolicy(policy)).toEqual({
        ...policy,
        maxRequestBytes: WEBHOOK_LIMITS.requestBytes,
      });
      // The size is checked before the address is looked up: a body the client takes reaches the
      // lookup, which fails here on purpose, so nothing is sent; a larger one is refused as too
      // large. No test sends a body over 64 KiB over a real connection.
      const lookups: string[] = [];
      const client = createWebhookEgressClient(policy, {
        resolve: async (host) => {
          lookups.push(host);
          throw new Error('no lookups in unit tests');
        },
      });
      const send = (body: string) =>
        client
          .request({
            method: 'POST',
            url: 'https://hooks.example.com/w360',
            headers: { 'content-type': 'application/json', 'user-agent': WEBHOOK_USER_AGENT },
            body,
          })
          .then(
            () => 'sent',
            (error: unknown) =>
              error instanceof EgressError && error.code === 'request_too_large'
                ? 'too_large'
                : 'looked_up',
          );
      expect(await send(await largestBody(500))).toBe('looked_up');
      expect(await send('x'.repeat(WEBHOOK_LIMITS.requestBytes))).toBe('looked_up');
      expect(await send('x'.repeat(WEBHOOK_LIMITS.requestBytes + 1))).toBe('too_large');
      expect(lookups).toEqual(['hooks.example.com', 'hooks.example.com']);
      // The client says the limit it sends with, which deliveries require of their client.
      expect(client.maxRequestBytes).toBe(WEBHOOK_LIMITS.requestBytes);
      expect(WEBHOOK_LIMITS.requestBytes).toBe(256 * 1024);
      // Other callers keep the default: the same body is too large for them.
      const other = createEgressClient(policy, {
        resolve: async () => {
          throw new Error('no lookups in unit tests');
        },
      });
      await expect(
        other.request({
          method: 'POST',
          url: 'https://hooks.example.com/w360',
          headers: {},
          body: await largestBody(500),
        }),
      ).rejects.toMatchObject({ code: 'request_too_large' });
    });
  });
});
