import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, type Database } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { CRM_LIMITS } from '../crm/common';
import type { ApiContext } from './context';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { toApiPipeline } from './deals';
import { API_ROUTES, apiPipelineSchema, buildOpenApiDocument } from './openapi';
import {
  apiCreatePipeline,
  apiCreatePipelineSchema,
  apiUpdatePipeline,
  apiUpdatePipelineSchema,
} from './pipelines';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const PIPELINE = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: TENANT, status },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read or written. */
const untouched = {
  run: () => {
    throw new Error('used the database');
  },
} as unknown as Database;
const deps = { db: untouched, clock: { now: () => new Date('2026-10-07T10:00:00Z') } };

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

describe('managing CRM pipelines through the API (ADR-286)', () => {
  it('needs pipelines.manage, a writing scope the database accepts, granted with tenant.settings.manage', () => {
    expect(API_SCOPES).toContain('pipelines.manage');
    // After the deal scopes, in the order the database's scope checks list them.
    expect(API_SCOPE_KEYS.indexOf('pipelines.manage')).toBe(
      API_SCOPE_KEYS.indexOf('deals.write') + 1,
    );
    expect(API_SCOPE_INFO['pipelines.manage']).toMatchObject({
      label: 'Manage CRM pipelines',
      permission: 'tenant.settings.manage',
      writes: true,
    });
    for (const words of [
      "each stage's chance of winning",
      'archive and restore them',
      'Settings → Pipelines',
      'recorded in the audit log as done by the key',
      'Never deletes a pipeline or its deals.',
      "Needs the CRM in the company's plan.",
    ]) {
      expect(API_SCOPE_INFO['pipelines.manage'].description).toContain(words);
    }
    // Only owners and administrators manage pipelines in Settings, and create keys.
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('tenant.settings.manage')).toBe(true);
    }
    for (const role of ['supervisor', 'agent', 'marketer', 'analyst', 'billing'] as const) {
      expect(ROLE_PERMISSIONS[role].has('tenant.settings.manage')).toBe(false);
    }
  });

  it('adds a pipeline from a name, a currency and its stages, and nothing else', () => {
    const parsed = apiCreatePipelineSchema.safeParse({
      name: ' Renewals ',
      currency: 'inr',
      stages: [
        { name: ' Due ' },
        { name: 'Quoted', winPercent: 60 },
        { name: 'X', winPercent: null },
      ],
    });
    expect(parsed.success && parsed.data).toEqual({
      name: 'Renewals',
      currency: 'INR',
      stages: [
        { name: 'Due' },
        { name: 'Quoted', winPercent: 60 },
        { name: 'X', winPercent: null },
      ],
    });
    const stages = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Stage ${i}` }));
    expect(
      apiCreatePipelineSchema.safeParse({
        name: 'Sales',
        currency: 'INR',
        stages: stages(CRM_LIMITS.stages),
      }).success,
    ).toBe(true);
    for (const [input, path] of [
      [{ currency: 'INR', stages: stages(1) }, 'name'],
      [{ name: ' ', currency: 'INR', stages: stages(1) }, 'name'],
      [{ name: 'x'.repeat(61), currency: 'INR', stages: stages(1) }, 'name'],
      [{ name: 'Sales', currency: 'RUPEES', stages: stages(1) }, 'currency'],
      [{ name: 'Sales', stages: stages(1) }, 'currency'],
      [{ name: 'Sales', currency: 'INR', stages: [] }, 'stages'],
      [{ name: 'Sales', currency: 'INR', stages: stages(CRM_LIMITS.stages + 1) }, 'stages'],
      [{ name: 'Sales', currency: 'INR', stages: ['New'] }, 'stages.0'],
      [{ name: 'Sales', currency: 'INR', stages: [{ name: 'x'.repeat(41) }] }, 'stages.0.name'],
      [
        { name: 'Sales', currency: 'INR', stages: [{ name: 'New', winPercent: 101 }] },
        'stages.0.winPercent',
      ],
      [
        { name: 'Sales', currency: 'INR', stages: [{ name: 'New', winPercent: 12.5 }] },
        'stages.0.winPercent',
      ],
      [{ name: 'Sales', currency: 'INR', stages: [{ name: 'New', id: PIPELINE }] }, 'stages.0'],
      [{ name: 'Sales', currency: 'INR', stages: stages(1), position: 0 }, ''],
    ] as const) {
      const result = apiCreatePipelineSchema.safeParse(input);
      expect(result.success, JSON.stringify(input)).toBe(false);
      expect(
        result.error?.issues.map((i) => i.path.join('.')),
        JSON.stringify(input),
      ).toContain(path);
    }
  });

  it('changes a name, the stages as they should be, or archives or restores on its own', () => {
    const parse = (input: unknown) => apiUpdatePipelineSchema.safeParse(input);
    for (const input of [
      { name: 'Renewals 2026' },
      { stages: [{ id: PIPELINE, name: 'Due', winPercent: 20 }, { name: 'New' }] },
      { stages: [{ name: 'Only', winPercent: null }], expectedVersion: 3 },
      { name: 'Sales', stages: [{ name: 'New' }], expectedVersion: 1 },
      { archived: true },
      { archived: false, expectedVersion: 2 },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(true);
    }
    const message = (input: unknown) => {
      const result = parse(input);
      return result.success ? null : result.error.issues.map((i) => [i.path.join('.'), i.message]);
    };
    expect(message({})).toEqual([
      ['', 'Give at least one change: `name`, `stages` or `archived`.'],
    ]);
    expect(message({ expectedVersion: 2 })).toEqual([
      ['', 'Give at least one change: `name`, `stages` or `archived`.'],
    ]);
    for (const input of [
      { archived: true, name: 'Old' },
      { archived: false, stages: [{ name: 'New' }] },
    ]) {
      expect(message(input)).toEqual([
        [
          'archived',
          'Archive or restore a pipeline on its own, and rename it or change its stages in another request.',
        ],
      ]);
    }
    for (const input of [
      { stages: [] },
      { stages: [{ id: 'due', name: 'Due' }] },
      { stages: [{ name: 'Due', archived: true }] },
      { currency: 'USD' },
      { name: 'Sales', position: 2 },
      { archived: 'true' },
      { name: 'Sales', expectedVersion: 0 },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('refuses before reading anything: the scope, a suspended company, an unknown id, a bad body', async () => {
    const body = { name: 'Partners', currency: 'INR', stages: [{ name: 'Open' }] };
    const missing = ['forbidden', 'This API key does not have the pipelines.manage scope.', []];
    expect(await refusal(apiCreatePipeline(deps, ctx(['deals.write']), body, null))).toEqual(
      missing,
    );
    expect(
      await refusal(apiUpdatePipeline(deps, ctx(['deals.read']), PIPELINE, { name: 'X' }, null)),
    ).toEqual(missing);
    for (const status of ['suspended', 'restricted']) {
      expect(
        (await refusal(apiCreatePipeline(deps, ctx(['pipelines.manage'], status), body, null)))[0],
      ).toBe('tenant_suspended');
      expect(
        (
          await refusal(
            apiUpdatePipeline(
              deps,
              ctx(['pipelines.manage'], status),
              PIPELINE,
              { name: 'X' },
              null,
            ),
          )
        )[0],
      ).toBe('tenant_suspended');
    }
    expect(
      await refusal(
        apiUpdatePipeline(deps, ctx(['pipelines.manage']), 'sales', { name: 'X' }, null),
      ),
    ).toEqual(['not_found', 'Pipeline not found.', []]);
    expect(
      (
        await refusal(
          apiCreatePipeline(deps, ctx(['pipelines.manage']), { ...body, stages: [] }, null),
        )
      )[2],
    ).toEqual(['stages']);
    expect(
      (await refusal(apiUpdatePipeline(deps, ctx(['pipelines.manage']), PIPELINE, {}, null)))[0],
    ).toBe('validation_failed');
  });

  it('give each pipeline its version and who added it, a key by its id', () => {
    const row = {
      id: PIPELINE,
      name: 'Renewals',
      currency: 'INR',
      position: 1,
      archivedAt: null,
      version: 3,
      createdByApiKeyId: null,
      createdAt: new Date('2026-10-07T10:00:00Z'),
    };
    const stage = { id: TENANT, name: 'Due', position: 0, archived: false, winPercent: 40 };
    const byMember = toApiPipeline(row, [stage]);
    expect(byMember).toEqual({
      id: PIPELINE,
      name: 'Renewals',
      currency: 'INR',
      position: 1,
      archived: false,
      stages: [stage],
      version: 3,
      createdBy: 'member',
      createdByApiKeyId: null,
      createdAt: '2026-10-07T10:00:00.000Z',
    });
    const byKey = toApiPipeline({ ...row, archivedAt: new Date(), createdByApiKeyId: 'key-1' }, []);
    expect([byKey.createdBy, byKey.createdByApiKeyId, byKey.archived]).toEqual([
      'api',
      'key-1',
      true,
    ]);
    // What the document says matches: a member or a key, never an automation.
    expect(apiPipelineSchema.shape.createdBy.options).toEqual(['member', 'api']);
    expect(apiPipelineSchema.safeParse(byMember).success).toBe(true);
  });

  it('are described: the scope, what is kept, removed and refused, retries and the CRM', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, { required?: string[]; properties?: object }> };
    };
    for (const route of [
      ['post', '/pipelines'],
      ['patch', '/pipelines/{id}'],
    ]) {
      expect(API_ROUTES).toContainEqual(route);
    }
    type Operation = {
      operationId: string;
      description: string;
      parameters: { $ref?: string }[];
      responses: Record<string, unknown>;
    };
    const create = doc.paths['/pipelines']?.post as Operation;
    expect(create.operationId).toBe('createPipeline');
    expect(create.parameters).toEqual([{ $ref: '#/components/parameters/IdempotencyKeyOptional' }]);
    expect(Object.keys(create.responses)).toEqual(
      expect.arrayContaining(['201', '403', '409', '422', '423']),
    );
    for (const words of [
      'Scope: `pipelines.manage`.',
      'unique among the company’s active pipelines (409 otherwise)',
      'which never changes',
      `at most ${CRM_LIMITS.pipelines} active pipelines (409 at the limit: archive one first)`,
      'recorded as added through the API, which Settings shows, and the audit log names the key',
      '(403, reason not_in_plan)',
      'a retry answers the first response',
    ]) {
      expect(create.description).toContain(words);
    }

    const update = doc.paths['/pipelines/{id}']?.patch as Operation;
    expect(update.operationId).toBe('updatePipeline');
    expect(update.parameters).toEqual([
      { $ref: '#/components/parameters/Id' },
      { $ref: '#/components/parameters/IdempotencyKeyOptional' },
    ]);
    expect(Object.keys(update.responses)).toEqual(
      expect.arrayContaining(['200', '404', '409', '422', '423']),
    );
    for (const words of [
      'Scope: `pipelines.manage`.',
      'a stage with its `id` is kept with its deals',
      'an active stage left out is removed from the board (archived',
      'refused with 409 while it holds open deals',
      'An archived stage cannot be listed (422) or brought back',
      'archiving or restoring goes in a request of its own (422)',
      'an archived pipeline is restored before it is changed (409)',
      'answers it as it is, with no new version or audit entry',
      'With `expectedVersion`, a pipeline changed since is refused with 409',
      'so a retry never adds them twice',
      'The currency never changes, and pipelines are never deleted.',
    ]) {
      expect(update.description).toContain(words);
    }
    expect(doc.components.schemas.CreatePipeline?.required).toEqual(['name', 'currency', 'stages']);
    expect(Object.keys(doc.components.schemas.UpdatePipeline?.properties ?? {})).toEqual([
      'name',
      'stages',
      'archived',
      'expectedVersion',
    ]);
    expect(doc.components.schemas.UpdatePipeline?.required ?? []).toEqual([]);
  });
});
