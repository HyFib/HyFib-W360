import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, DEAL_STATUSES, type Database } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import type { ApiContext } from './context';
import { MAX_DEAL_MINOR } from '../crm/money';
import {
  apiCreateDeal,
  apiCreateDealSchema,
  apiDealListQuerySchema,
  apiGetDeal,
  apiListDeals,
  apiListPipelines,
  apiPipelineListQuerySchema,
} from './deals';
import { API_SCOPE_INFO } from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';

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

describe('CRM pipelines and deals through the API (ADR-253)', () => {
  it('are read with deals.read, a reading scope the database accepts, granted with crm.read', () => {
    expect(API_SCOPES).toContain('deals.read');
    expect(API_SCOPE_INFO['deals.read']).toMatchObject({
      label: 'Read CRM deals',
      permission: 'crm.read',
      writes: false,
    });
    for (const words of ['pipelines', 'chance of winning', 'Never notes, tasks or the timeline']) {
      expect(API_SCOPE_INFO['deals.read'].description).toContain(words);
    }
    expect(API_SCOPE_INFO['deals.read'].description).toContain("CRM in the company's plan");
    // Only owners and administrators create keys, and both read the CRM in the app.
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('crm.read')).toBe(true);
    }
  });

  it('page pipelines and nothing else', () => {
    const parsed = apiPipelineListQuerySchema.safeParse({});
    expect(parsed.success && [parsed.data.limit, parsed.data.cursor]).toEqual([50, undefined]);
    expect(apiPipelineListQuerySchema.safeParse({ limit: '100', cursor: 'abc' }).success).toBe(
      true,
    );
    for (const input of [{ limit: '101' }, { limit: '0' }, { archived: 'true' }]) {
      expect(apiPipelineListQuerySchema.safeParse(input).success, JSON.stringify(input)).toBe(
        false,
      );
    }
  });

  it('filter deals by pipeline, stage, status, contact, owner and time, nothing else', () => {
    const parse = (input: unknown) => apiDealListQuerySchema.safeParse(input);
    const parsed = parse({});
    expect(parsed.success && [parsed.data.limit, parsed.data.cursor]).toEqual([50, undefined]);
    for (const status of DEAL_STATUSES) expect(parse({ status }).success).toBe(true);
    for (const input of [
      { limit: '100', cursor: 'abc' },
      { pipelineId: TENANT, stageId: OTHER },
      { contactId: TENANT },
      { ownerId: OTHER },
      { ownerId: 'none' },
      { updatedSince: '2026-10-01T00:00:00+05:30' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(true);
    }
    for (const input of [
      { limit: '101' },
      { limit: '0' },
      { status: 'closed' },
      { pipelineId: 'sales' },
      { stageId: 'won' },
      { contactId: 'someone' },
      { ownerId: 'me' },
      { updatedSince: 'yesterday' },
      { conversationId: TENANT },
      { title: 'Order' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('need deals.read and refuse bad requests before reading anything', async () => {
    const missing = ['forbidden', 'This API key does not have the deals.read scope.', []];
    expect(await refusal(apiListPipelines({ db: untouched }, ctx(['contacts.read']), {}))).toEqual(
      missing,
    );
    expect(await refusal(apiListDeals({ db: untouched }, ctx(['orders.read']), {}))).toEqual(
      missing,
    );
    expect(await refusal(apiGetDeal({ db: untouched }, ctx(['contacts.read']), TENANT))).toEqual(
      missing,
    );
    expect(
      (
        await refusal(apiListPipelines({ db: untouched }, ctx(['deals.read']), { limit: '500' }))
      )[2],
    ).toEqual(['limit']);
    expect(
      (
        await refusal(apiListDeals({ db: untouched }, ctx(['deals.read']), { status: 'closed' }))
      )[2],
    ).toEqual(['status']);
    for (const list of [apiListPipelines, apiListDeals]) {
      expect(
        (await refusal(list({ db: untouched }, ctx(['deals.read']), { cursor: 'x' })))[0],
      ).toBe('validation_failed');
    }
    expect(await refusal(apiGetDeal({ db: untouched }, ctx(['deals.read']), 'not-an-id'))).toEqual([
      'not_found',
      'Deal not found.',
      [],
    ]);
  });

  it('read in read-only transactions, pipelines in one snapshot, while the company is suspended too', async () => {
    for (const status of ['active', 'suspended', 'restricted']) {
      const { db, runs } = reached();
      for (const read of [
        apiListPipelines({ db }, ctx(['deals.read'], status), {}),
        apiListDeals({ db }, ctx(['deals.read'], status), {}),
        apiGetDeal({ db }, ctx(['deals.read'], status), TENANT),
      ]) {
        await expect(read).rejects.toThrow('reached the database');
      }
      expect(runs).toEqual([
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
        { accessMode: 'read only' },
        { accessMode: 'read only' },
      ]);
    }
  });

  it('are described: the scope, the CRM, pages, filters, money and what is never read', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    for (const route of [
      ['get', '/pipelines'],
      ['get', '/deals'],
      ['get', '/deals/{id}'],
    ]) {
      expect(API_ROUTES).toContainEqual(route);
    }
    type Operation = {
      operationId: string;
      description: string;
      parameters: { name?: string; schema?: { enum?: string[]; anyOf?: unknown[] } }[];
      responses: Record<string, { description?: string }>;
    };

    const pipelines = doc.paths['/pipelines']?.get as Operation;
    expect(pipelines.operationId).toBe('listPipelines');
    expect(pipelines.parameters.map((p) => p.name)).toEqual(['limit', 'cursor']);
    for (const words of [
      'Scope: `deals.read`.',
      'archived ones too',
      'pages never skip or repeat a pipeline',
      '(403, reason not_in_plan)',
    ]) {
      expect(pipelines.description).toContain(words);
    }

    const list = doc.paths['/deals']?.get as Operation;
    expect(list.operationId).toBe('listDeals');
    expect(list.parameters.map((p) => p.name)).toEqual([
      'limit',
      'cursor',
      'pipelineId',
      'stageId',
      'status',
      'contactId',
      'ownerId',
      'updatedSince',
    ]);
    const param = (name: string) => list.parameters.find((p) => p.name === name)?.schema;
    expect(param('status')?.enum).toEqual([...DEAL_STATUSES]);
    expect(param('ownerId')?.anyOf).toContainEqual({ const: 'none' });
    expect(Object.keys(list.responses)).toEqual(
      expect.arrayContaining(['200', '401', '403', '422', '429']),
    );
    expect(Object.keys(list.responses)).not.toContain('404');
    for (const words of [
      'Scope: `deals.read`.',
      'newest first by when they were created',
      'pages never skip or repeat a deal',
      'Filters combine',
      '(403, reason not_in_plan)',
      'integers in the pipeline currency’s minor units',
      'Notes, tasks and the deal’s timeline are never read here',
      'renamed and without a lost reason',
      '`updatedSince` a little before your previous pass began',
    ]) {
      expect(list.description).toContain(words);
    }
    expect(list.responses['403']?.description).toContain(
      'the CRM when reading pipelines or deals or creating deals,',
    );

    const one = doc.paths['/deals/{id}']?.get as Operation;
    expect(one.operationId).toBe('getDeal');
    expect(one.description).toContain('Scope: `deals.read`.');
    expect(one.description).toContain('(403, reason not_in_plan)');
    expect(Object.keys(one.responses)).toEqual(expect.arrayContaining(['200', '403', '404']));

    const pipeline = doc.components.schemas.Pipeline as {
      properties: Record<string, { items?: { properties: Record<string, unknown> } }>;
      required: string[];
    };
    expect(Object.keys(pipeline.properties)).toEqual([
      'id',
      'name',
      'currency',
      'position',
      'archived',
      'stages',
      'createdAt',
    ]);
    expect(pipeline.required).toEqual(Object.keys(pipeline.properties));
    expect(Object.keys(pipeline.properties.stages?.items?.properties ?? {})).toEqual([
      'id',
      'name',
      'position',
      'archived',
      'winPercent',
    ]);

    const deal = doc.components.schemas.Deal as {
      properties: Record<string, { format?: string }>;
      required: string[];
    };
    expect(Object.keys(deal.properties)).toEqual([
      'id',
      'title',
      'pipelineId',
      'stageId',
      'status',
      'valueMinor',
      'currency',
      'contactId',
      'conversationId',
      'ownerId',
      'expectedCloseOn',
      'stageEnteredAt',
      'lostReason',
      'closedAt',
      'createdAt',
      'updatedAt',
    ]);
    expect(deal.required).toEqual(Object.keys(deal.properties));
    // Ids only: no contact details, notes, tasks or timeline anywhere in it.
    expect(JSON.stringify(deal)).not.toMatch(/"(phone|contactName|notes?|tasks?|timeline)"/);
  });
});

describe('creating CRM deals through the API (ADR-254)', () => {
  const deps = (db: Database) => ({ db, clock: { now: () => new Date() } });
  const deal = { contactId: TENANT, pipelineId: OTHER, title: 'Annual plan' };

  it('needs deals.write, a writing scope the database accepts, granted with crm.write', () => {
    expect(API_SCOPES).toContain('deals.write');
    expect(API_SCOPE_INFO['deals.write']).toMatchObject({
      label: 'Create CRM deals',
      permission: 'crm.write',
      writes: true,
    });
    for (const words of ['as members do', 'recorded as created through the API', 'CRM']) {
      expect(API_SCOPE_INFO['deals.write'].description).toContain(words);
    }
    // Owners and administrators, who create keys, create deals in the app.
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('crm.write')).toBe(true);
    }
  });

  it('takes a contact, a pipeline, a title and optionally a stage, a value, an owner and a date', () => {
    const parse = (input: unknown) => apiCreateDealSchema.safeParse(input);
    const minimal = parse({ ...deal, title: '  Annual plan  ' });
    expect(minimal.success && minimal.data).toEqual(deal);
    for (const input of [
      { ...deal, stageId: OTHER, valueMinor: 2_500_050, ownerId: TENANT },
      { ...deal, valueMinor: 0, expectedCloseOn: '2026-12-31' },
      { ...deal, valueMinor: MAX_DEAL_MINOR, ownerId: null, expectedCloseOn: null },
      { ...deal, title: 'x'.repeat(120) },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(true);
    }
    for (const input of [
      { pipelineId: OTHER, title: 'Annual plan' },
      { contactId: TENANT, title: 'Annual plan' },
      { contactId: TENANT, pipelineId: OTHER },
      { ...deal, title: '   ' },
      { ...deal, title: 'x'.repeat(121) },
      { ...deal, contactId: 'asha' },
      { ...deal, stageId: 'won' },
      { ...deal, valueMinor: -1 },
      { ...deal, valueMinor: 1.5 },
      { ...deal, valueMinor: MAX_DEAL_MINOR + 1 },
      { ...deal, valueMinor: '100' },
      { ...deal, ownerId: 'me' },
      { ...deal, expectedCloseOn: '2026-02-30' },
      { ...deal, status: 'won' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('refuses keys without the scope, suspended companies and bad bodies before anything is read', async () => {
    expect(await refusal(apiCreateDeal(deps(untouched), ctx(['deals.read']), deal, null))).toEqual([
      'forbidden',
      'This API key does not have the deals.write scope.',
      [],
    ]);
    for (const status of ['suspended', 'restricted']) {
      expect(
        (
          await refusal(apiCreateDeal(deps(untouched), ctx(['deals.write'], status), deal, null))
        )[0],
      ).toBe('tenant_suspended');
    }
    expect(
      (
        await refusal(
          apiCreateDeal(deps(untouched), ctx(['deals.write']), { ...deal, valueMinor: -5 }, null),
        )
      )[2],
    ).toEqual(['valueMinor']);
    // A valid request reaches the database in a writing transaction.
    const { db, runs } = reached();
    await expect(apiCreateDeal(deps(db), ctx(['deals.write']), deal, null)).rejects.toThrow(
      'reached the database',
    );
    expect(runs).toEqual([undefined]);
  });

  it('is described: the scope, the defaults, the refusals and the request body', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(API_ROUTES).toContainEqual(['post', '/deals']);
    const create = doc.paths['/deals']?.post as {
      operationId: string;
      description: string;
      parameters: { $ref?: string }[];
      requestBody: { content: Record<string, { schema: unknown }> };
      responses: Record<string, unknown>;
    };
    expect(create.operationId).toBe('createDeal');
    expect(create.parameters).toEqual([{ $ref: '#/components/parameters/IdempotencyKeyOptional' }]);
    expect(create.requestBody.content['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/CreateDeal',
    });
    expect(Object.keys(create.responses)).toEqual(
      expect.arrayContaining(['201', '403', '404', '409', '422', '423']),
    );
    for (const words of [
      'Scope: `deals.write`.',
      'its first when `stageId` is left out',
      'a value in the pipeline currency’s minor units',
      'recorded as created through the API',
      'refused with 409',
      '422 naming the field',
      '(403, reason not_in_plan)',
      'With an `Idempotency-Key`, a retry answers the first response.',
      '`contact_merged`',
    ]) {
      expect(create.description).toContain(words);
    }
    const body = doc.components.schemas.CreateDeal as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(body.properties)).toEqual([
      'contactId',
      'pipelineId',
      'stageId',
      'title',
      'valueMinor',
      'ownerId',
      'expectedCloseOn',
    ]);
    expect(body.required).toEqual(['contactId', 'pipelineId', 'title']);
    expect(body.additionalProperties).toBe(false);
  });
});
