import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import { API_SCOPES, type Database, type SQL, type Tx } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { toMetaComponents, type TemplateDefinition } from '../templates/definition';
import { writeEditTemplate } from '../templates/edit';
import {
  templateNameError,
  writeCreateTemplateDraft,
  writeDeleteTemplateAtMeta,
  writeSubmitTemplate,
} from '../templates/service';
import type { ApiContext } from './context';
import {
  apiCreateMessageTemplate,
  apiCreateMessageTemplateSchema,
  apiDeleteMessageTemplate,
  apiEditMessageTemplate,
  apiEditMessageTemplateSchema,
  apiSubmitMessageTemplate,
  apiUpdateMessageTemplate,
  apiUpdateMessageTemplateSchema,
} from './message-template-drafts';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const TEMPLATE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const CALLER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';
const ACCOUNT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f04';
const NUMBER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f05';
const CREATED = new Date('2026-10-01T09:00:00.000Z');
const NOW = new Date('2026-10-07T10:00:00.000Z');

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: CALLER, scopes: new Set(scopes) },
    planScopes: null,
    requestId: 'req-1',
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read or written. */
const untouched = {
  run: () => {
    throw new Error('used the database');
  },
} as unknown as Database;
const clock = { now: () => NOW };
/** A job queue and signer that fail the test if anything is queued. */
const offline = {
  jobs: {
    enqueue: () => {
      throw new Error('queued a job');
    },
  } as unknown as JobQueue,
  signer: {} as JobSigner,
};

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

/** SQL as text with its parameters inline. */
const text = (query: SQL) => {
  const { sql, params } = new PgDialect().sqlToQuery(query);
  return sql.replace(/\$(\d+)/g, (_, n: string) => JSON.stringify(params[Number(n) - 1]));
};

/**
 * A transaction whose reads answer, in order, with `answers` (when awaited, locked or limited, and
 * an update when it returns rows), and that records each step: reads with their table, conditions
 * and lock or limit, inserts and updates, with SQL values as text, and the jobs queued, whether in
 * the transaction, with their queue, signed envelope and options. A read beyond the answers fails
 * the test.
 */
function recorder(answers: unknown[][]) {
  const queue = [...answers];
  const steps: unknown[][] = [];
  const next = () => {
    const rows = queue.shift();
    if (!rows) throw new Error('an unexpected read');
    return rows;
  };
  const plain = (values: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value && typeof value === 'object' && 'queryChunks' in value ? text(value as SQL) : value,
      ]),
    );
  const tx = {
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) => ({
        where: (condition: SQL) => {
          const step: unknown[] = ['read', getTableName(table), text(condition)];
          steps.push(step);
          return {
            then: (resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) => {
              try {
                resolve(next());
              } catch (error) {
                reject(error);
              }
            },
            for: (mode: string) => {
              step.push(mode);
              return Promise.resolve(next());
            },
            orderBy: () => ({
              limit: (n: number) => {
                step.push(n);
                return Promise.resolve(next());
              },
            }),
          };
        },
      }),
    }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (values: Record<string, unknown>) => {
        steps.push(['insert', getTableName(table), plain(values)]);
        return Promise.resolve();
      },
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: SQL) => {
          const step: unknown[] = ['update', getTableName(table), plain(values), text(condition)];
          steps.push(step);
          return {
            then: (resolve: (rows: undefined) => void) => resolve(undefined),
            returning: () => {
              step.push('returning');
              return Promise.resolve(next());
            },
          };
        },
      }),
    }),
  } as unknown as Tx;
  const jobs = {
    enqueue: (jobTx: unknown, name: string, envelope: unknown, options: unknown) => {
      steps.push(['enqueue', jobTx === tx, name, envelope, options]);
      return Promise.resolve('job-1');
    },
  } as unknown as JobQueue;
  const signer = { sign: (input: unknown) => ({ signed: input }) } as unknown as JobSigner;
  return { tx, steps, unread: () => queue.length, jobs, signer };
}

/** A database whose transactions run on `tx`. */
const on = (tx: Tx) =>
  ({ run: (_scope: unknown, fn: (tx: Tx) => Promise<unknown>) => fn(tx) }) as unknown as Database;

const shipped: TemplateDefinition = {
  category: 'UTILITY',
  header: { type: 'none' },
  body: { text: 'Hi {{1}}, your order has shipped.', examples: ['Asha'] },
  footer: null,
  buttons: [],
};
const delayed: TemplateDefinition = {
  ...shipped,
  body: { text: 'Hi {{1}}, your order is delayed.', examples: ['Asha'] },
};

/** A template row as the API reads it back, then its status changes and the active numbers. */
const detailReads = (overrides: Record<string, unknown> = {}) => [
  [
    {
      id: TEMPLATE,
      whatsappAccountId: ACCOUNT,
      name: 'order_shipped',
      language: 'en',
      category: 'UTILITY',
      status: 'draft',
      components: toMetaComponents(shipped),
      rejectionReason: null,
      qualityScore: null,
      submitError: null,
      origin: 'local',
      createdByUserId: null,
      createdByApiKeyId: CALLER,
      version: 0,
      submittedAt: null,
      lastSyncedAt: null,
      createdAt: CREATED,
      updatedAt: NOW,
      cursorAt: '2026-10-01T09:00:00.000000Z',
      ...overrides,
    },
  ],
  [],
  [{ id: NUMBER, phone: '+91 80 4567 8901', whatsappAccountId: ACCOUNT }],
];

const VERSION_PLUS_ONE = '"app"."message_templates"."version" + 1';
const THIS_TEMPLATE = `("app"."message_templates"."tenant_id" = "${TENANT}" and "app"."message_templates"."id" = "${TEMPLATE}")`;

describe('template drafts through the API (ADR-295)', () => {
  it('needs templates.write, a scope the database accepts after templates.read, granted with the members’ templates.write', () => {
    expect(API_SCOPES).toContain('templates.write');
    expect(API_SCOPES.indexOf('templates.write')).toBe(API_SCOPES.indexOf('templates.read') + 1);
    expect(API_SCOPE_KEYS.indexOf('templates.write')).toBe(
      API_SCOPE_KEYS.indexOf('templates.read') + 1,
    );
    expect(API_SCOPE_INFO['templates.write']).toMatchObject({
      label: 'Write templates',
      permission: 'templates.write',
      writes: true,
    });
    for (const words of [
      'Add template drafts, change their content and delete drafts Meta never received',
      'as members who write templates do on the Templates page',
      'recorded as added through the API and in the audit log as done by the key',
      'Deleting templates Meta has also needs the scope that submits them to Meta.',
    ]) {
      expect(API_SCOPE_INFO['templates.write'].description).toContain(words);
    }
    // Owners and administrators, who create keys, write templates; agents do not.
    for (const role of ['owner', 'admin', 'marketer'] as const) {
      expect(ROLE_PERMISSIONS[role].has('templates.write')).toBe(true);
    }
    expect(ROLE_PERMISSIONS.agent.has('templates.write')).toBe(false);
  });

  it('refuses a key without the scope, a company not active, and an id that is none, before reading', async () => {
    const draft = { channelId: NUMBER, name: 'order_shipped', language: 'en', definition: shipped };
    for (const key of [ctx(['templates.read']), ctx(['templates.write'], 'suspended')]) {
      for (const write of [
        () => apiCreateMessageTemplate({ db: untouched, clock }, key, draft, null),
        () => apiUpdateMessageTemplate({ db: untouched }, key, TEMPLATE, { definition: shipped }),
        () => apiDeleteMessageTemplate({ db: untouched, clock, ...offline }, key, TEMPLATE),
      ]) {
        expect((await refusal(write()))[0]).toBe(
          key.tenant.status === 'active' ? 'forbidden' : 'tenant_suspended',
        );
      }
    }
    expect(
      await refusal(
        apiCreateMessageTemplate({ db: untouched, clock }, ctx(['templates.read']), draft, null),
      ),
    ).toEqual(['forbidden', 'This API key does not have the templates.write scope.', []]);
    const key = ctx(['templates.write']);
    for (const write of [
      () =>
        apiUpdateMessageTemplate({ db: untouched }, key, 'order_shipped', { definition: shipped }),
      () => apiDeleteMessageTemplate({ db: untouched, clock, ...offline }, key, 'order_shipped'),
    ]) {
      expect(await refusal(write())).toEqual(['not_found', 'Template not found.', []]);
    }
  });

  it('takes a number, a name, a language and the content, and a draft’s content and version, and nothing else', () => {
    expect(
      apiCreateMessageTemplateSchema.parse({
        channelId: NUMBER,
        name: ' order_shipped ',
        language: ' en_US ',
        definition: shipped,
      }),
    ).toEqual({ channelId: NUMBER, name: 'order_shipped', language: 'en_US', definition: shipped });
    for (const input of [
      { channelId: 'main', name: 'order_shipped', language: 'en', definition: shipped },
      { channelId: NUMBER, name: 'Order shipped', language: 'en', definition: shipped },
      { channelId: NUMBER, name: 'order_shipped', language: 'english', definition: shipped },
      { channelId: NUMBER, name: 'order_shipped', language: 'en' },
      {
        channelId: NUMBER,
        whatsappAccountId: ACCOUNT,
        name: 'order_shipped',
        language: 'en',
        definition: shipped,
      },
    ]) {
      expect(apiCreateMessageTemplateSchema.safeParse(input).success, JSON.stringify(input)).toBe(
        false,
      );
    }
    expect(
      apiUpdateMessageTemplateSchema.parse({ definition: shipped, expectedVersion: 2 }),
    ).toEqual({ definition: shipped, expectedVersion: 2 });
    for (const input of [
      {},
      { definition: shipped, expectedVersion: -1 },
      { definition: shipped, name: 'order_shipped' },
    ]) {
      expect(apiUpdateMessageTemplateSchema.safeParse(input).success, JSON.stringify(input)).toBe(
        false,
      );
    }
  });

  it('refuses content Meta would not take before reading, as the template editor does', async () => {
    const noExample = { ...shipped, body: { text: 'Hi {{1}}.', examples: [] } };
    const key = ctx(['templates.write']);
    const problem = [
      'validation_failed',
      'Body: give an example value for every variable.',
      ['body.examples'],
    ];
    expect(
      await refusal(
        apiCreateMessageTemplate(
          { db: untouched, clock },
          key,
          { channelId: NUMBER, name: 'order_shipped', language: 'en', definition: noExample },
          null,
        ),
      ),
    ).toEqual(problem);
    expect(
      await refusal(
        apiUpdateMessageTemplate({ db: untouched }, key, TEMPLATE, { definition: noExample }),
      ),
    ).toEqual(problem);
  });

  it('adds a draft for the account of one of the company’s numbers, as the key’s, and answers it', async () => {
    const run = recorder([[{ whatsappAccountId: ACCOUNT }], [], ...detailReads()]);
    const response = await apiCreateMessageTemplate(
      { db: on(run.tx), clock },
      ctx(['templates.write']),
      { channelId: NUMBER, name: 'order_shipped', language: 'en', definition: shipped },
      null,
    );
    expect(run.steps.slice(0, 4)).toEqual([
      [
        'read',
        'channel_accounts',
        `("app"."channel_accounts"."tenant_id" = "${TENANT}" and "app"."channel_accounts"."id" = "${NUMBER}")`,
      ],
      [
        'read',
        'message_templates',
        `("app"."message_templates"."tenant_id" = "${TENANT}" and "app"."message_templates"."whatsapp_account_id" = "${ACCOUNT}" and "app"."message_templates"."name" = "order_shipped" and "app"."message_templates"."language" = "en")`,
        'update',
      ],
      [
        'insert',
        'message_templates',
        {
          id: expect.any(String),
          tenantId: TENANT,
          whatsappAccountId: ACCOUNT,
          name: 'order_shipped',
          language: 'en',
          category: 'UTILITY',
          components: toMetaComponents(shipped),
          status: 'draft',
          origin: 'local',
          createdByUserId: null,
          createdByApiKeyId: CALLER,
        },
      ],
      [
        'insert',
        'audit_events',
        expect.objectContaining({
          tenantId: TENANT,
          actorType: 'api_key',
          actorId: CALLER,
          action: 'template.draft_saved',
          subjectType: 'template',
          correlationId: 'req-1',
          metadata: { name: 'order_shipped', language: 'en', source: 'api' },
        }),
      ],
    ]);
    // The audit names the draft just added.
    const added = run.steps[2]?.[2] as { id: string };
    expect(run.steps[3]?.[2]).toMatchObject({ subjectId: added.id });
    expect(response).toMatchObject({
      status: 201,
      replayed: false,
      body: {
        data: {
          id: TEMPLATE,
          status: 'draft',
          createdBy: 'api',
          createdByApiKeyId: CALLER,
          definition: shipped,
          history: [],
        },
      },
    });
    expect(run.unread()).toBe(0);
  });

  it('answers 404 for another company’s number or none, writing nothing', async () => {
    const run = recorder([[]]);
    expect(
      await refusal(
        apiCreateMessageTemplate(
          { db: on(run.tx), clock },
          ctx(['templates.write']),
          { channelId: NUMBER, name: 'order_shipped', language: 'en', definition: shipped },
          null,
        ),
      ),
    ).toEqual(['not_found', 'WhatsApp number not found.', []]);
    expect(run.steps.map((s) => s[0])).toEqual(['read']);
  });

  it('makes a deleted draft Meta never received a draft again, by its new author, and refuses any other template of the name', async () => {
    const data = {
      whatsappAccountId: ACCOUNT,
      name: 'order_shipped',
      language: 'en',
      definition: shipped,
    };
    const reused = recorder([[{ id: TEMPLATE, status: 'deleted', providerTemplateId: null }]]);
    expect(await writeCreateTemplateDraft(reused.tx, TENANT, data, { apiKeyId: CALLER })).toBe(
      TEMPLATE,
    );
    expect(reused.steps[1]).toEqual([
      'update',
      'message_templates',
      {
        components: toMetaComponents(shipped),
        category: 'UTILITY',
        status: 'draft',
        submitError: null,
        createdByUserId: null,
        createdByApiKeyId: CALLER,
        version: VERSION_PLUS_ONE,
      },
      THIS_TEMPLATE,
    ]);
    // A member's draft names the member, not a key.
    const members = recorder([[]]);
    await writeCreateTemplateDraft(members.tx, TENANT, data, { userId: 'user-1' });
    expect(members.steps[1]?.[2]).toMatchObject({
      createdByUserId: 'user-1',
      createdByApiKeyId: null,
    });
    for (const existing of [
      { id: TEMPLATE, status: 'draft', providerTemplateId: null },
      { id: TEMPLATE, status: 'deleted', providerTemplateId: '1234567890' },
    ]) {
      const taken = recorder([[existing]]);
      expect(
        await refusal(writeCreateTemplateDraft(taken.tx, TENANT, data, { apiKeyId: CALLER })),
      ).toEqual(['conflict', 'A template with this name and language already exists.', []]);
      expect(taken.steps).toHaveLength(1);
    }
    // A name taken at the same moment, by the account's unique name and language.
    const raced = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'message_templates_name_language_uq',
    });
    expect(await refusal(Promise.reject(templateNameError(raced)))).toEqual([
      'conflict',
      'A template with this name and language already exists.',
      [],
    ]);
    const other = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'x' });
    expect(templateNameError(other)).toBe(other);
  });

  it('changes a draft’s content from its version, and writes nothing for the content it has', async () => {
    const key = ctx(['templates.write']);
    const current = {
      status: 'draft',
      providerTemplateId: null,
      version: 3,
      category: 'UTILITY',
      // As the database gives it back: its keys in another order.
      components: toMetaComponents(shipped).map((c) =>
        Object.fromEntries(Object.entries(c).reverse()),
      ),
      name: 'order_shipped',
      language: 'en',
    };
    const same = recorder([[current], ...detailReads({ version: 3 })]);
    await apiUpdateMessageTemplate({ db: on(same.tx) }, key, TEMPLATE, {
      definition: shipped,
      expectedVersion: 3,
    });
    expect(same.steps.map((s) => s[0])).toEqual(['read', 'read', 'read', 'read']);
    expect(same.steps[0]).toEqual(['read', 'message_templates', THIS_TEMPLATE, 'update']);

    const changed = recorder([[current], ...detailReads({ version: 4 })]);
    const answer = await apiUpdateMessageTemplate({ db: on(changed.tx) }, key, TEMPLATE, {
      definition: delayed,
    });
    expect(changed.steps.slice(1, 3)).toEqual([
      [
        'update',
        'message_templates',
        {
          components: toMetaComponents(delayed),
          category: 'UTILITY',
          status: 'draft',
          submitError: null,
          version: VERSION_PLUS_ONE,
        },
        THIS_TEMPLATE,
      ],
      [
        'insert',
        'audit_events',
        expect.objectContaining({
          actorType: 'api_key',
          actorId: CALLER,
          action: 'template.draft_saved',
          subjectId: TEMPLATE,
          metadata: { name: 'order_shipped', language: 'en', source: 'api' },
        }),
      ],
    ]);
    expect(answer).toMatchObject({ id: TEMPLATE, version: 4 });

    // A change of category alone is a change.
    const recategorised = recorder([[current], ...detailReads()]);
    await apiUpdateMessageTemplate({ db: on(recategorised.tx) }, key, TEMPLATE, {
      definition: { ...shipped, category: 'MARKETING' },
    });
    expect(recategorised.steps[1]).toEqual([
      'update',
      'message_templates',
      expect.objectContaining({ category: 'MARKETING' }),
      THIS_TEMPLATE,
    ]);

    // A draft whose submission failed becomes a draft again, its content unchanged.
    const failed = recorder([[{ ...current, status: 'submit_failed' }], ...detailReads()]);
    await apiUpdateMessageTemplate({ db: on(failed.tx) }, key, TEMPLATE, { definition: shipped });
    expect(failed.steps[1]?.[0]).toBe('update');

    for (const [row, expected] of [
      [
        { ...current, version: 4 },
        ['conflict', 'This template has changed since that version. Read it again.', []],
      ],
      [
        { ...current, status: 'pending' },
        ['precondition_failed', 'Only drafts that Meta has not received can be changed.', []],
      ],
      [
        { ...current, status: 'submit_failed', providerTemplateId: '1234567890' },
        ['precondition_failed', 'Only drafts that Meta has not received can be changed.', []],
      ],
    ] as const) {
      const refused = recorder([[row]]);
      expect(
        await refusal(
          apiUpdateMessageTemplate({ db: on(refused.tx) }, key, TEMPLATE, {
            definition: delayed,
            expectedVersion: 3,
          }),
        ),
      ).toEqual(expected);
      expect(refused.steps).toHaveLength(1);
    }
    const none = recorder([[]]);
    expect(
      await refusal(
        apiUpdateMessageTemplate({ db: on(none.tx) }, key, TEMPLATE, { definition: delayed }),
      ),
    ).toEqual(['not_found', 'Template not found.', []]);
  });

  it('deletes a draft Meta never received, with its status change, and refuses the rest', async () => {
    const key = ctx(['templates.write']);
    const draft = {
      status: 'draft',
      providerTemplateId: null,
      name: 'order_shipped',
      language: 'en',
    };
    const run = recorder([[draft]]);
    expect(
      await apiDeleteMessageTemplate({ db: on(run.tx), clock, ...run }, key, TEMPLATE),
    ).toEqual({ id: TEMPLATE, deleted: true, status: 'deleted' });
    expect(run.steps).toEqual([
      ['read', 'message_templates', THIS_TEMPLATE, 'update'],
      [
        'update',
        'message_templates',
        { status: 'deleted', version: VERSION_PLUS_ONE },
        THIS_TEMPLATE,
      ],
      [
        'insert',
        'template_status_events',
        {
          id: expect.any(String),
          tenantId: TENANT,
          templateId: TEMPLATE,
          status: 'deleted',
          reason: null,
          source: 'delete',
          actorUserId: null,
          occurredAt: NOW,
        },
      ],
      [
        'insert',
        'audit_events',
        expect.objectContaining({
          actorType: 'api_key',
          actorId: CALLER,
          action: 'template.deleted',
          subjectId: TEMPLATE,
          metadata: { name: 'order_shipped', language: 'en', source: 'api' },
        }),
      ],
    ]);
    for (const [row, expected] of [
      [{ ...draft, status: 'deleted' }, ['conflict', 'This template is already deleted.', []]],
      [
        { ...draft, status: 'pending_deletion', providerTemplateId: '1234567890' },
        ['conflict', 'This template is already deleted.', []],
      ],
      [
        { ...draft, status: 'submitting' },
        ['precondition_failed', 'Wait until Meta confirms the submission before deleting.', []],
      ],
      // One Meta has needs templates.submit too (ADR-296).
      [
        { ...draft, status: 'approved', providerTemplateId: '1234567890' },
        ['forbidden', 'This API key does not have the templates.submit scope.', []],
      ],
    ] as const) {
      const refused = recorder([[row]]);
      expect(
        await refusal(
          apiDeleteMessageTemplate({ db: on(refused.tx), clock, ...refused }, key, TEMPLATE),
        ),
      ).toEqual(expected);
      expect(refused.steps).toHaveLength(1);
    }
    const none = recorder([[]]);
    expect(
      await refusal(apiDeleteMessageTemplate({ db: on(none.tx), clock, ...none }, key, TEMPLATE)),
    ).toEqual(['not_found', 'Template not found.', []]);
  });

  it('is described: the scope, the number, the checks, the draft staying a draft', () => {
    for (const route of [
      ['post', '/message-templates'],
      ['patch', '/message-templates/{id}'],
      ['delete', '/message-templates/{id}'],
    ]) {
      expect(API_ROUTES).toContainEqual(route);
    }
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { operationId: string; description: string }>>;
      components: { schemas: Record<string, { required?: string[] }> };
    };
    const create = doc.paths['/message-templates']?.post;
    expect(create?.operationId).toBe('createMessageTemplate');
    for (const words of [
      'Scope: `templates.write`.',
      'for the WhatsApp Business account of one of the company’s numbers',
      '409 otherwise; a deleted draft Meta never received is used again',
      'It stays a draft until it is submitted to Meta (POST /message-templates/{id}/submit, or on the Templates page).',
      'With an `Idempotency-Key`, a retry answers the first response.',
    ]) {
      expect(create?.description).toContain(words);
    }
    const change = doc.paths['/message-templates/{id}']?.patch;
    expect(change?.operationId).toBe('updateMessageTemplate');
    for (const words of [
      'only a draft Meta never received (`draft` or `submit_failed`; 412 otherwise)',
      'from `expectedVersion` when given (409 for another version)',
      'Content the draft already has answers it as it is, with no audit entry',
    ]) {
      expect(change?.description).toContain(words);
    }
    const remove = doc.paths['/message-templates/{id}']?.delete;
    expect(remove?.operationId).toBe('deleteMessageTemplate');
    expect(remove?.description).toContain(
      'One being submitted answers 412; one already deleted, or being deleted, 409.',
    );
    expect(doc.components.schemas.CreateMessageTemplate?.required).toEqual([
      'channelId',
      'name',
      'language',
      'definition',
    ]);
    expect(doc.components.schemas.UpdateMessageTemplate?.required).toEqual(['definition']);
  });
});

describe('submitting templates and deleting those Meta has, through the API (ADR-296)', () => {
  /** A draft as the submission locks it. */
  const draft = {
    id: TEMPLATE,
    status: 'draft' as const,
    providerTemplateId: null,
    category: 'UTILITY' as const,
    components: toMetaComponents(shipped),
    whatsappAccountId: ACCOUNT,
    name: 'order_shipped',
    language: 'en',
  };
  const connected = [{ id: ACCOUNT, status: 'connected', name: 'Acme' }];
  const THIS_ACCOUNT = `("app"."whatsapp_accounts"."tenant_id" = "${TENANT}" and "app"."whatsapp_accounts"."id" = "${ACCOUNT}")`;

  it('needs templates.submit, a scope the database accepts after templates.write, granted with the members’ templates.submit', async () => {
    expect(API_SCOPES.indexOf('templates.submit')).toBe(API_SCOPES.indexOf('templates.write') + 1);
    expect(API_SCOPE_KEYS.indexOf('templates.submit')).toBe(
      API_SCOPE_KEYS.indexOf('templates.write') + 1,
    );
    expect(API_SCOPE_INFO['templates.submit']).toMatchObject({
      label: 'Submit templates',
      permission: 'templates.submit',
      writes: true,
    });
    for (const words of [
      'Submit template drafts to Meta for review',
      'with the scope that writes templates, delete templates Meta has, which can then no longer be sent',
      'as members who submit templates do on the Templates page, in the audit log as done by the key.',
    ]) {
      expect(API_SCOPE_INFO['templates.submit'].description).toContain(words);
    }
    for (const role of ['owner', 'admin', 'marketer'] as const) {
      expect(ROLE_PERMISSIONS[role].has('templates.submit')).toBe(true);
    }
    expect(ROLE_PERMISSIONS.agent.has('templates.submit')).toBe(false);

    for (const key of [ctx(['templates.write']), ctx(['templates.submit'], 'restricted')]) {
      expect(
        (
          await refusal(
            apiSubmitMessageTemplate({ db: untouched, clock, ...offline }, key, TEMPLATE, null),
          )
        ).slice(0, 2),
      ).toEqual(
        key.tenant.status === 'active'
          ? ['forbidden', 'This API key does not have the templates.submit scope.']
          : [
              'tenant_suspended',
              "The company's plan has ended, so the API cannot change data or send messages.",
            ],
      );
    }
    expect(
      await refusal(
        apiSubmitMessageTemplate(
          { db: untouched, clock, ...offline },
          ctx(['templates.submit']),
          'order_shipped',
          null,
        ),
      ),
    ).toEqual(['not_found', 'Template not found.', []]);
  });

  it('marks a draft submitting before Meta hears of it, queues the request in its transaction, as the key’s, and answers it', async () => {
    for (const status of ['draft', 'submit_failed'] as const) {
      const run = recorder([
        [{ ...draft, status }],
        connected,
        [{ version: 4 }],
        ...detailReads({ status: 'submitting', version: 4, submittedAt: NOW }),
      ]);
      const response = await apiSubmitMessageTemplate(
        { db: on(run.tx), clock, ...run },
        ctx(['templates.submit']),
        TEMPLATE,
        null,
      );
      expect(run.steps.slice(0, 6)).toEqual([
        ['read', 'message_templates', THIS_TEMPLATE, 'update'],
        ['read', 'whatsapp_accounts', THIS_ACCOUNT],
        [
          'update',
          'message_templates',
          {
            status: 'submitting',
            submittedAt: NOW,
            managementDeferredUntil: null,
            submitError: null,
            version: VERSION_PLUS_ONE,
          },
          THIS_TEMPLATE,
          'returning',
        ],
        [
          'insert',
          'template_status_events',
          {
            id: expect.any(String),
            tenantId: TENANT,
            templateId: TEMPLATE,
            status: 'submitting',
            reason: null,
            source: 'submit',
            actorUserId: null,
            occurredAt: NOW,
          },
        ],
        [
          'enqueue',
          true,
          QUEUES.templateSubmit.name,
          {
            signed: {
              kind: 'template.submit',
              tenantId: TENANT,
              actorUserId: null,
              ref: TEMPLATE,
            },
          },
          { singletonKey: `${TEMPLATE}:4` },
        ],
        [
          'insert',
          'audit_events',
          expect.objectContaining({
            tenantId: TENANT,
            actorType: 'api_key',
            actorId: CALLER,
            action: 'template.submitted',
            subjectType: 'template',
            subjectId: TEMPLATE,
            correlationId: 'req-1',
            metadata: { name: 'order_shipped', language: 'en', category: 'UTILITY', source: 'api' },
          }),
        ],
      ]);
      expect(response).toMatchObject({
        status: 200,
        replayed: false,
        body: { data: { id: TEMPLATE, status: 'submitting', version: 4 } },
      });
      expect(run.unread()).toBe(0);
    }
  });

  it('refuses a template Meta has or that is being submitted, content HyFib cannot send or Meta would not take, and an account not connected, changing nothing', async () => {
    const key = ctx(['templates.submit']);
    const sent = ['precondition_failed', 'This template has already been sent to Meta.', []];
    for (const [answers, expected] of [
      [[[{ ...draft, status: 'submitting' }]], sent],
      [[[{ ...draft, status: 'pending', providerTemplateId: '1234567890' }]], sent],
      [[[{ ...draft, status: 'submit_failed', providerTemplateId: '1234567890' }]], sent],
      [
        [
          [
            {
              ...draft,
              components: [{ type: 'HEADER', format: 'IMAGE' }, ...toMetaComponents(shipped)],
            },
          ],
        ],
        ['unsupported', 'This template cannot be submitted from HyFib.', []],
      ],
      [
        [
          [
            {
              ...draft,
              components: toMetaComponents({
                ...shipped,
                body: { text: 'Hi {{1}}.', examples: [] },
              }),
            },
          ],
        ],
        ['validation_failed', 'Body: give an example value for every variable.', ['body.examples']],
      ],
      [
        [[draft], [{ ...connected[0], status: 'disconnected' }]],
        ['precondition_failed', 'Reconnect this WhatsApp account before submitting templates.', []],
      ],
      [
        [[draft], []],
        ['not_found', 'WhatsApp account not found.', []],
      ],
      [[[]], ['not_found', 'Template not found.', []]],
    ] as const) {
      const run = recorder(answers as unknown as unknown[][]);
      expect(
        await refusal(
          apiSubmitMessageTemplate({ db: on(run.tx), clock, ...run }, key, TEMPLATE, null),
        ),
      ).toEqual(expected);
      expect(run.steps.every((step) => step[0] === 'read')).toBe(true);
      expect(run.unread()).toBe(0);
    }
  });

  it('submits as the member on the Templates page, the member named on the change and the job', async () => {
    const run = recorder([connected, [{ version: 1 }]]);
    await writeSubmitTemplate(run.tx, run, TENANT, draft, 'user-1', NOW);
    expect(run.steps[2]?.[2]).toMatchObject({ status: 'submitting', actorUserId: 'user-1' });
    expect(run.steps[3]).toEqual([
      'enqueue',
      true,
      QUEUES.templateSubmit.name,
      {
        signed: { kind: 'template.submit', tenantId: TENANT, actorUserId: 'user-1', ref: TEMPLATE },
      },
      { singletonKey: `${TEMPLATE}:1` },
    ]);
  });

  it('answers 503 and queues nothing while Meta throttles the account’s management calls (ADR-399)', async () => {
    const key = ctx(['templates.write', 'templates.submit']);
    const pausedUntil = new Date(NOW.getTime() + 5 * 60_000);
    const paused = [{ ...connected[0], managementPausedUntil: pausedUntil }];
    const row = {
      status: 'approved',
      providerTemplateId: '1234567890',
      name: 'order_shipped',
      language: 'en',
      whatsappAccountId: ACCOUNT,
    };
    const deletion = recorder([[row], paused]);
    const refused = await refusal(
      apiDeleteMessageTemplate({ db: on(deletion.tx), clock, ...deletion }, key, TEMPLATE),
    );
    expect(refused[0]).toBe('provider_unavailable');
    expect(refused[1]).toMatch(
      /^Meta is limiting management requests for this WhatsApp account until .* UTC\. Try again after that\.$/,
    );
    expect(deletion.steps.every((step) => step[0] === 'read')).toBe(true);
    const submission = recorder([paused]);
    await expect(
      writeSubmitTemplate(submission.tx, submission, TENANT, draft, null, NOW),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      details: { pausedUntil: pausedUntil.toISOString() },
    });
    expect(submission.steps.every((step) => step[0] === 'read')).toBe(true);
  });

  it('deletes a template Meta has with templates.submit too: pending deletion, the request queued in its transaction', async () => {
    const key = ctx(['templates.write', 'templates.submit']);
    for (const status of ['approved', 'rejected', 'paused'] as const) {
      const row = {
        status,
        providerTemplateId: '1234567890',
        name: 'order_shipped',
        language: 'en',
        whatsappAccountId: ACCOUNT,
      };
      const run = recorder([[row], connected]);
      expect(
        await apiDeleteMessageTemplate({ db: on(run.tx), clock, ...run }, key, TEMPLATE),
      ).toEqual({ id: TEMPLATE, deleted: false, status: 'pending_deletion' });
      expect(run.steps).toEqual([
        ['read', 'message_templates', THIS_TEMPLATE, 'update'],
        // Whether Meta throttles the account's management calls (ADR-399).
        ['read', 'whatsapp_accounts', THIS_ACCOUNT],
        [
          'update',
          'message_templates',
          { status: 'pending_deletion', managementDeferredUntil: null, version: VERSION_PLUS_ONE },
          THIS_TEMPLATE,
        ],
        [
          'insert',
          'template_status_events',
          {
            id: expect.any(String),
            tenantId: TENANT,
            templateId: TEMPLATE,
            status: 'pending_deletion',
            reason: null,
            source: 'delete',
            actorUserId: null,
            occurredAt: NOW,
          },
        ],
        [
          'enqueue',
          true,
          QUEUES.templateDelete.name,
          {
            signed: {
              kind: 'template.delete',
              tenantId: TENANT,
              actorUserId: null,
              ref: TEMPLATE,
            },
          },
          { singletonKey: `${TEMPLATE}:delete` },
        ],
        [
          'insert',
          'audit_events',
          expect.objectContaining({
            actorType: 'api_key',
            actorId: CALLER,
            action: 'template.deleted',
            subjectId: TEMPLATE,
            correlationId: 'req-1',
            metadata: { name: 'order_shipped', language: 'en', source: 'api' },
          }),
        ],
      ]);
    }
    // A draft Meta never received needs no more than templates.write, as before.
    const local = recorder([
      [
        {
          status: 'submit_failed',
          providerTemplateId: null,
          name: 'order_shipped',
          language: 'en',
        },
      ],
    ]);
    expect(
      await apiDeleteMessageTemplate({ db: on(local.tx), clock, ...local }, key, TEMPLATE),
    ).toEqual({ id: TEMPLATE, deleted: true, status: 'deleted' });
    expect(local.steps.some((step) => step[0] === 'enqueue')).toBe(false);
    // A member deleting one on the Templates page is named on the change and the job.
    const member = recorder([]);
    await writeDeleteTemplateAtMeta(member.tx, member, TENANT, TEMPLATE, 'user-1', NOW);
    expect(member.steps[1]?.[2]).toMatchObject({ actorUserId: 'user-1' });
    expect(member.steps[2]?.[3]).toEqual({
      signed: { kind: 'template.delete', tenantId: TENANT, actorUserId: 'user-1', ref: TEMPLATE },
    });
  });

  it('is described: the scope, the drafts it takes, Meta’s answer, the retry; and deletion at Meta', () => {
    expect(API_ROUTES).toContainEqual(['post', '/message-templates/{id}/submit']);
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId: string;
            description: string;
            responses: Record<string, { content: unknown }>;
          }
        >
      >;
    };
    const submit = doc.paths['/message-templates/{id}/submit']?.post;
    expect(submit?.operationId).toBe('submitMessageTemplate');
    for (const words of [
      'Scope: `templates.submit`.',
      'only a draft Meta never received (`draft` or `submit_failed`; 412 otherwise, as for one submitted already)',
      'whose WhatsApp Business account is connected (412 otherwise)',
      'It is `submitting` until HyFib has Meta’s answer',
      '`submit_failed`, with `submitError` saying why, when Meta did not take it',
      'With an `Idempotency-Key`, a retry answers the first response; without one, submitting it again is refused with 412.',
    ]) {
      expect(submit?.description).toContain(words);
    }
    const remove = doc.paths['/message-templates/{id}']?.delete;
    for (const words of [
      'One Meta has also needs `templates.submit` (403 naming it otherwise)',
      'it is `pending_deletion` until Meta answers, then `deleted`',
      'back to the status Meta reports, with a `delete_failed` change in its history',
    ]) {
      expect(remove?.description).toContain(words);
    }
    expect(JSON.stringify(remove?.responses['200']?.content)).toContain(
      '"status":{"type":"string","enum":["deleted","pending_deletion"]}',
    );
  });
});

describe('editing a template Meta has through the API (ADR-404)', () => {
  const approved = {
    id: TEMPLATE,
    status: 'approved' as const,
    providerTemplateId: '1234567890',
    category: 'UTILITY' as const,
    components: toMetaComponents(shipped),
    whatsappAccountId: ACCOUNT,
    editState: null,
    name: 'order_shipped',
    language: 'en',
  };
  const connected = [{ id: ACCOUNT, status: 'connected', name: 'Acme' }];

  it('needs templates.submit and an id, before reading', async () => {
    for (const key of [
      ctx(['templates.write']),
      ctx(['templates.read']),
      ctx(['templates.submit'], 'restricted'),
    ]) {
      const refused = await refusal(
        apiEditMessageTemplate(
          { db: untouched, clock, ...offline },
          key,
          TEMPLATE,
          { definition: delayed },
          null,
        ),
      );
      expect(refused[0]).toBe(key.tenant.status === 'active' ? 'forbidden' : 'tenant_suspended');
    }
    expect(
      await refusal(
        apiEditMessageTemplate(
          { db: untouched, clock, ...offline },
          ctx(['templates.submit']),
          'order_shipped',
          { definition: delayed },
          null,
        ),
      ),
    ).toEqual(['not_found', 'Template not found.', []]);
    // Only the content: a name, a language or anything else is refused.
    expect(
      (
        await refusal(
          apiEditMessageTemplate(
            { db: untouched, clock, ...offline },
            ctx(['templates.submit']),
            TEMPLATE,
            { definition: delayed, name: 'other' },
            null,
          ),
        )
      )[0],
    ).toBe('validation_failed');
  });

  it('writes the edit ahead: sending, the content sent, who asked, its change and the job in one transaction', async () => {
    const run = recorder([[{ n: 0 }], connected, [{ version: 5 }]]);
    await writeEditTemplate(run.tx, run, TENANT, approved, delayed, 'user-1', NOW);
    expect(run.steps[0]?.[1]).toBe('campaigns');
    expect(run.steps[0]?.[2]).toContain('"running"');
    expect(run.steps[2]).toEqual([
      'update',
      'message_templates',
      {
        editState: 'sending',
        editComponents: toMetaComponents(delayed),
        editError: null,
        editRequestedAt: NOW,
        editRequestedByUserId: 'user-1',
        managementDeferredUntil: null,
        version: VERSION_PLUS_ONE,
      },
      THIS_TEMPLATE,
      'returning',
    ]);
    expect(run.steps[3]?.[2]).toMatchObject({
      status: 'edit_requested',
      source: 'edit',
      actorUserId: 'user-1',
      occurredAt: NOW,
    });
    expect(run.steps[4]).toEqual([
      'enqueue',
      true,
      QUEUES.templateEdit.name,
      { signed: { kind: 'template.edit', tenantId: TENANT, actorUserId: 'user-1', ref: TEMPLATE } },
      { singletonKey: `${TEMPLATE}:edit:5` },
    ]);
    expect(run.unread()).toBe(0);
  });

  it('refuses while a campaign sends it, a disconnected account, a pause, and writes nothing', async () => {
    const sending = recorder([[{ n: 1 }]]);
    await expect(
      writeEditTemplate(sending.tx, sending, TENANT, approved, delayed, null, NOW),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
    const disconnected = recorder([[{ n: 0 }], [{ ...connected[0], status: 'disconnected' }]]);
    await expect(
      writeEditTemplate(disconnected.tx, disconnected, TENANT, approved, delayed, null, NOW),
    ).rejects.toMatchObject({
      code: 'precondition_failed',
      publicMessage: 'Reconnect this WhatsApp account before editing templates.',
    });
    const pausedUntil = new Date(NOW.getTime() + 5 * 60_000);
    const paused = recorder([
      [{ n: 0 }],
      [{ ...connected[0], managementPausedUntil: pausedUntil }],
    ]);
    await expect(
      writeEditTemplate(paused.tx, paused, TENANT, approved, delayed, null, NOW),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    for (const run of [sending, disconnected, paused]) {
      expect(run.steps.every((step) => step[0] === 'read')).toBe(true);
    }
    // Content the editor refuses is refused before anything is read.
    const invalid = recorder([]);
    await expect(
      writeEditTemplate(
        invalid.tx,
        invalid,
        TENANT,
        approved,
        { ...delayed, body: { text: 'Hi {{1}}', examples: [] } },
        null,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(invalid.steps).toEqual([]);
  });

  it('refuses to delete a template while its edit is on its way to Meta', async () => {
    const run = recorder([[{ ...approved, editState: 'sending' }]]);
    expect(
      await refusal(
        apiDeleteMessageTemplate(
          { db: on(run.tx), clock, ...run },
          ctx(['templates.write', 'templates.submit']),
          TEMPLATE,
        ),
      ),
    ).toEqual([
      'precondition_failed',
      'Wait until Meta answers the edit of this template before deleting it.',
      [],
    ]);
    expect(run.steps.every((step) => step[0] === 'read')).toBe(true);
  });

  it('is described: the scope, what stays, the refusals, Meta’s answer and the retry', () => {
    expect(API_ROUTES).toContainEqual(['post', '/message-templates/{id}/edit']);
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, { operationId: string; description: string }>>;
    };
    const edit = doc.paths['/message-templates/{id}/edit']?.post;
    expect(edit?.operationId).toBe('editMessageTemplate');
    for (const words of [
      'Scope: `templates.submit`.',
      'Its name, language and category stay',
      'while one of the company’s campaigns using it is sending',
      'HyFib does not limit which statuses can be edited or how often: Meta decides',
      'its code and message in `edit.error`',
      'With an `Idempotency-Key`, a retry answers the first response',
    ]) {
      expect(edit?.description).toContain(words);
    }
    expect(apiEditMessageTemplateSchema.safeParse({ definition: delayed }).success).toBe(true);
  });
});
