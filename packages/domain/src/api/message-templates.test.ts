import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import type { Database, SQL, Tx } from '@w360/db';
import { toMetaComponents, type TemplateDefinition } from '../templates/definition';
import { encodeKeysetCursor } from '../validation';
import type { ApiContext } from './context';
import {
  MESSAGE_TEMPLATE_HISTORY,
  apiGetMessageTemplate,
  apiListMessageTemplates,
  apiMessageTemplateListQuerySchema,
  toApiMessageTemplate,
} from './message-templates';
import { API_SCOPE_INFO } from './model';
import {
  API_ROUTES,
  apiMessageTemplateDetailSchema,
  apiMessageTemplateSchema,
  buildOpenApiDocument,
} from './openapi';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const TEMPLATE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const ACCOUNT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const OTHER_ACCOUNT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';
const NUMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f05';
const OTHER_NUMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f06';
const CREATED = new Date('2026-10-01T09:00:00.000Z');
const UPDATED = new Date('2026-10-07T10:00:00.000Z');

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read. */
const untouched = {
  run: () => {
    throw new Error('used the database');
  },
} as unknown as Database;

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

const definition: TemplateDefinition = {
  category: 'UTILITY',
  header: { type: 'text', text: 'Order {{1}}', example: 'A-1' },
  body: { text: 'Hi {{1}}, your order {{2}} has shipped.', examples: ['Asha', 'A-1'] },
  footer: 'Reply STOP to opt out',
  buttons: [{ type: 'URL', text: 'Track', url: 'https://shop.example/t/{{1}}', example: 'A-1' }],
};

type Row = Parameters<typeof toApiMessageTemplate>[0] & { cursorAt: string };

const row = (overrides: Partial<Row> = {}): Row => ({
  id: TEMPLATE,
  whatsappAccountId: ACCOUNT,
  name: 'order_shipped',
  language: 'en',
  category: 'UTILITY',
  status: 'approved',
  components: toMetaComponents(definition),
  rejectionReason: null,
  qualityScore: 'GREEN',
  submitError: null,
  origin: 'local',
  createdByUserId: 'member-user',
  createdByApiKeyId: null,
  version: 3,
  submittedAt: CREATED,
  editState: null,
  editComponents: null,
  editError: null,
  editRequestedAt: null,
  lastSyncedAt: UPDATED,
  createdAt: CREATED,
  updatedAt: UPDATED,
  cursorAt: '2026-10-01T09:00:00.000123Z',
  ...overrides,
});

const numbers = [
  { id: NUMBER, phone: '+91 80 4567 8901', whatsappAccountId: ACCOUNT },
  { id: OTHER_NUMBER, phone: '+91 80 4567 8902', whatsappAccountId: OTHER_ACCOUNT },
];

/** SQL as text with its parameters inline. */
const text = (query: SQL) => {
  const { sql, params } = new PgDialect().sqlToQuery(query);
  return sql.replace(/\$(\d+)/g, (_, n: string) => JSON.stringify(params[Number(n) - 1]));
};

/**
 * A database whose reads answer, in order, with `answers`, recording the transaction's options and
 * each read's conditions, order and limit. A read beyond them fails the test.
 */
function reading(answers: unknown[][]) {
  const queue = [...answers];
  type Read = { where: string; order?: string[]; limit?: number };
  const seen: { options?: unknown; reads: Read[] } = { reads: [] };
  const next = () => {
    const rows = queue.shift();
    if (!rows) throw new Error('an unexpected read');
    return rows;
  };
  const select = () => {
    const read: Read = { where: '' };
    seen.reads.push(read);
    const chain = {
      from: () => chain,
      where: (condition: SQL) => {
        read.where = text(condition);
        // Answered when awaited here; a read that goes on to its order and limit answers there.
        return {
          ...chain,
          then: (resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) => {
            try {
              resolve(next());
            } catch (error) {
              reject(error);
            }
          },
        };
      },
      orderBy: (...order: SQL[]) => {
        read.order = order.map(text);
        return chain;
      },
      limit: (n: number) => {
        read.limit = n;
        return Promise.resolve(next());
      },
    };
    return chain;
  };
  const db = {
    run: (_scope: unknown, fn: (tx: Tx) => Promise<unknown>, options?: unknown) => {
      seen.options = options;
      return fn({ select } as unknown as Tx);
    },
  } as unknown as Database;
  return { db, seen, unread: () => queue.length };
}

describe('message templates of every status through the API (ADR-294)', () => {
  it('reads with templates.read, which says so, and refuses any other key before reading', async () => {
    expect(API_SCOPE_INFO['templates.read'].description).toContain(
      'read every template of the company, drafts and those Meta reviews included',
    );
    for (const read of [
      () => apiListMessageTemplates({ db: untouched }, ctx(['messages.send']), {}),
      () => apiGetMessageTemplate({ db: untouched }, ctx(['contacts.read']), TEMPLATE),
    ]) {
      expect(await refusal(read())).toEqual([
        'forbidden',
        'This API key does not have the templates.read scope.',
        [],
      ]);
    }
    const key = ctx(['templates.read']);
    expect(await refusal(apiGetMessageTemplate({ db: untouched }, key, 'order_shipped'))).toEqual([
      'not_found',
      'Template not found.',
      [],
    ]);
    expect(
      (await refusal(apiListMessageTemplates({ db: untouched }, key, { status: 'live' })))[2],
    ).toEqual(['status']);
  });

  it('takes a page, a status, a number and a name, and nothing else', () => {
    expect(apiMessageTemplateListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(
      apiMessageTemplateListQuerySchema.parse({
        limit: '20',
        status: 'rejected',
        channelId: NUMBER,
        name: ' order_shipped ',
      }),
    ).toEqual({ limit: 20, status: 'rejected', channelId: NUMBER, name: 'order_shipped' });
    for (const input of [
      { limit: '0' },
      { limit: '101' },
      { status: 'live' },
      { channelId: 'main' },
      { name: '' },
      { language: 'en' },
    ]) {
      expect(
        apiMessageTemplateListQuerySchema.safeParse(input).success,
        JSON.stringify(input),
      ).toBe(false);
    }
  });

  it('gives a template with its review, whether a send can use it, its content and its numbers', () => {
    expect(toApiMessageTemplate(row(), numbers)).toEqual({
      id: TEMPLATE,
      name: 'order_shipped',
      language: 'en',
      category: 'utility',
      status: 'approved',
      rejectionReason: null,
      qualityScore: 'GREEN',
      submitError: null,
      origin: 'local',
      createdBy: 'member',
      createdByApiKeyId: null,
      version: 3,
      sendable: true,
      unsupportedReason: null,
      definition,
      edit: null,
      headerMedia: null,
      channels: [{ id: NUMBER, phone: '+91 80 4567 8901' }],
      submittedAt: '2026-10-01T09:00:00.000Z',
      lastSyncedAt: '2026-10-07T10:00:00.000Z',
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-07T10:00:00.000Z',
    });
    // An open edit (ADR-404): its state, the content sent and why it failed.
    const changedDefinition: TemplateDefinition = {
      ...definition,
      body: { text: 'Hello {{1}}, order {{2}} is on its way.', examples: ['Asha', 'A-1'] },
    };
    expect(
      toApiMessageTemplate(
        row({
          editState: 'failed',
          editComponents: toMetaComponents(changedDefinition),
          editError: 'Meta refused the edit (code 100): Invalid parameter',
          editRequestedAt: UPDATED,
        }),
        numbers,
      ),
    ).toMatchObject({
      definition,
      edit: {
        state: 'failed',
        definition: changedDefinition,
        error: 'Meta refused the edit (code 100): Invalid parameter',
        requestedAt: '2026-10-07T10:00:00.000Z',
      },
    });
    // A draft, a rejected template: their content, but no send.
    for (const status of ['draft', 'rejected', 'paused'] as const) {
      expect(toApiMessageTemplate(row({ status }), numbers)).toMatchObject({
        status,
        sendable: false,
        definition,
      });
    }
    // Content HyFib cannot represent: listed with its status and why, without content.
    const authentication = toApiMessageTemplate(
      row({ category: 'AUTHENTICATION', origin: 'synced', createdByUserId: null }),
      numbers,
    );
    expect(authentication).toMatchObject({
      category: 'authentication',
      origin: 'synced',
      createdBy: null,
      createdByApiKeyId: null,
      sendable: false,
      definition: null,
      unsupportedReason: 'Authentication templates are not supported yet.',
    });
    // A photo header: sent with its file, as GET /templates lists it.
    const photo = toApiMessageTemplate(
      row({
        category: 'MARKETING',
        components: [
          { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::aW1hZ2U='] } },
          { type: 'BODY', text: 'New arrivals.' },
        ],
      }),
      [],
    );
    expect(photo).toMatchObject({ category: 'marketing', sendable: true, headerMedia: 'image' });
    expect(photo.channels).toEqual([]);
    for (const template of [toApiMessageTemplate(row(), numbers), authentication, photo]) {
      expect(apiMessageTemplateSchema.safeParse(template).success).toBe(true);
    }
  });

  it('lists the company’s templates but deleted ones, newest first on exact pages, read only, while suspended too', async () => {
    const page = reading([[row(), row({ id: OTHER_ACCOUNT, cursorAt: 'x' }), row()], numbers]);
    const result = await apiListMessageTemplates(
      { db: page.db },
      ctx(['templates.read'], 'suspended'),
      { limit: '2' },
    );
    expect(result.data.map((t) => t.id)).toEqual([TEMPLATE, OTHER_ACCOUNT]);
    expect(result.nextCursor).toBe(encodeKeysetCursor('x', OTHER_ACCOUNT));
    expect(page.seen.options).toEqual({ accessMode: 'read only' });
    const [templates, active] = page.seen.reads;
    expect(templates?.where).toBe(
      `("app"."message_templates"."tenant_id" = "${TENANT}" and "app"."message_templates"."status" <> 'deleted')`,
    );
    expect(templates?.order).toEqual([
      '"app"."message_templates"."created_at" desc',
      '"app"."message_templates"."id" desc',
    ]);
    expect(templates?.limit).toBe(3);
    expect(active?.where).toBe(
      `("app"."channel_accounts"."tenant_id" = "${TENANT}" and "app"."channel_accounts"."status" = "active")`,
    );
    expect(page.unread()).toBe(0);
    // An exactly full page is the last; an empty one reads no numbers.
    const full = reading([[row(), row()], numbers]);
    expect(
      (await apiListMessageTemplates({ db: full.db }, ctx(['templates.read']), { limit: '2' }))
        .nextCursor,
    ).toBeNull();
    const none = reading([[]]);
    expect(await apiListMessageTemplates({ db: none.db }, ctx(['templates.read']), {})).toEqual({
      data: [],
      nextCursor: null,
    });
    expect(none.seen.reads.map((r) => r.limit)).toEqual([51]);
  });

  it('finds templates in a status, of a number’s account, by name, after a cursor', async () => {
    const where = async (query: Record<string, string>, answers: unknown[][] = [[]]) => {
      const page = reading(answers);
      await apiListMessageTemplates({ db: page.db }, ctx(['templates.read']), query);
      return page.seen.reads.map((r) => r.where);
    };
    expect(await where({ status: 'deleted' })).toEqual([
      `("app"."message_templates"."tenant_id" = "${TENANT}" and "app"."message_templates"."status" = "deleted")`,
    ]);
    expect((await where({ name: 'order_shipped' }))[0]).toContain(
      `"app"."message_templates"."name" = "order_shipped"`,
    );
    const [account, templates] = await where({ channelId: NUMBER }, [
      [{ whatsappAccountId: ACCOUNT }],
      [],
    ]);
    expect(account).toBe(
      `("app"."channel_accounts"."tenant_id" = "${TENANT}" and "app"."channel_accounts"."id" = "${NUMBER}")`,
    );
    expect(templates).toContain(`"app"."message_templates"."whatsapp_account_id" = "${ACCOUNT}"`);
    // Another company's number, or an unknown one: nothing, without reading templates.
    expect(await where({ channelId: OTHER_NUMBER }, [[]])).toHaveLength(1);
    const after = await where({
      cursor: encodeKeysetCursor('2026-10-01T09:00:00.000123Z', TEMPLATE),
    });
    expect(after[0]).toContain(
      `("app"."message_templates"."created_at", "app"."message_templates"."id") < ("2026-10-01T09:00:00.000123Z"::timestamptz, "${TEMPLATE}"::uuid)`,
    );
  });

  it('reads one template of any status with its latest status changes, and 404 for none', async () => {
    const changes = [
      { status: 'pending_deletion', reason: null, source: 'delete', occurredAt: UPDATED },
      { status: 'rejected', reason: 'INVALID_FORMAT', source: 'sync', occurredAt: CREATED },
    ];
    const one = reading([[row({ status: 'deleted' })], changes, numbers]);
    const template = await apiGetMessageTemplate({ db: one.db }, ctx(['templates.read']), TEMPLATE);
    expect(template).toMatchObject({ id: TEMPLATE, status: 'deleted', sendable: false });
    expect(template.history).toEqual([
      {
        status: 'pending_deletion',
        reason: null,
        source: 'delete',
        occurredAt: '2026-10-07T10:00:00.000Z',
      },
      {
        status: 'rejected',
        reason: 'INVALID_FORMAT',
        source: 'sync',
        occurredAt: '2026-10-01T09:00:00.000Z',
      },
    ]);
    expect(apiMessageTemplateDetailSchema.safeParse(template).success).toBe(true);
    expect(one.seen.options).toEqual({ accessMode: 'read only' });
    expect(one.seen.reads[0]?.where).toBe(
      `("app"."message_templates"."tenant_id" = "${TENANT}" and "app"."message_templates"."id" = "${TEMPLATE}")`,
    );
    expect(one.seen.reads[1]).toEqual({
      where: `("app"."template_status_events"."tenant_id" = "${TENANT}" and "app"."template_status_events"."template_id" = "${TEMPLATE}")`,
      order: [
        '"app"."template_status_events"."occurred_at" desc',
        '"app"."template_status_events"."id" desc',
      ],
      limit: MESSAGE_TEMPLATE_HISTORY,
    });
    expect(MESSAGE_TEMPLATE_HISTORY).toBe(50);
    const none = reading([[]]);
    expect(
      await refusal(apiGetMessageTemplate({ db: none.db }, ctx(['templates.read']), TEMPLATE)),
    ).toEqual(['not_found', 'Template not found.', []]);
    expect(none.unread()).toBe(0);
  });

  it('is described: every status, the order, what a send can use, the history', () => {
    for (const route of [
      ['get', '/message-templates'],
      ['get', '/message-templates/{id}'],
    ]) {
      expect(API_ROUTES).toContainEqual(route);
    }
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { operationId: string; description: string }>>;
    };
    const list = doc.paths['/message-templates']?.get;
    expect(list?.operationId).toBe('listMessageTemplates');
    for (const words of [
      'Scope: `templates.read`.',
      'drafts, those Meta is reviewing, approved, rejected, paused or disabled, and those found at Meta',
      'whether a send can use each now (as GET /templates lists the approved ones)',
      'null for content HyFib cannot represent',
      'Deleted templates are listed only when `status` asks for them.',
      'Newest first by when HyFib added them; pages never skip or repeat a template.',
    ]) {
      expect(list?.description).toContain(words);
    }
    const one = doc.paths['/message-templates/{id}']?.get;
    expect(one?.operationId).toBe('getMessageTemplate');
    expect(one?.description).toContain('with its latest 50 status changes, newest first');
    expect(one?.description).toContain('Another company’s template answers 404');
  });
});
