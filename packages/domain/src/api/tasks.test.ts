import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, REMINDER_STATES, TASK_STATUSES, type Database } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import type { ApiContext } from './context';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';
import { apiGetTask, apiListTasks, apiTaskListQuerySchema } from './tasks';

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

describe('CRM tasks through the API (ADR-258)', () => {
  it('are read with tasks.read, a reading scope the database accepts, granted with crm.read', () => {
    expect(API_SCOPES).toContain('tasks.read');
    // Listed after the deal scopes, in the order the database's scope checks list them.
    expect(API_SCOPE_KEYS.indexOf('tasks.read')).toBe(API_SCOPE_KEYS.indexOf('deals.write') + 1);
    expect(API_SCOPE_INFO['tasks.read']).toMatchObject({
      label: 'Read CRM tasks',
      permission: 'crm.read',
      writes: false,
    });
    for (const words of [
      'title, notes, due time, reminder, status and assignee',
      'contact and deal ids',
      'Never the CRM timeline',
      "CRM in the company's plan",
    ]) {
      expect(API_SCOPE_INFO['tasks.read'].description).toContain(words);
    }
    // Only owners and administrators create keys, and both read the CRM in the app.
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('crm.read')).toBe(true);
    }
  });

  it('filter tasks by status, assignee, contact, deal and time, nothing else', () => {
    const parse = (input: unknown) => apiTaskListQuerySchema.safeParse(input);
    const parsed = parse({});
    expect(parsed.success && [parsed.data.limit, parsed.data.cursor]).toEqual([50, undefined]);
    for (const status of TASK_STATUSES) expect(parse({ status }).success).toBe(true);
    for (const input of [
      { limit: '100', cursor: 'abc' },
      { assigneeId: TENANT },
      { contactId: TENANT, dealId: OTHER },
      { updatedSince: '2026-10-01T00:00:00+05:30' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(true);
    }
    for (const input of [
      { limit: '101' },
      { limit: '0' },
      { status: 'closed' },
      { assigneeId: 'me' },
      { assigneeId: 'none' },
      { contactId: 'someone' },
      { dealId: 'big-one' },
      { updatedSince: 'yesterday' },
      { dueBefore: '2026-10-01T00:00:00Z' },
      { title: 'Call back' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('need tasks.read and refuse bad requests before reading anything', async () => {
    const missing = ['forbidden', 'This API key does not have the tasks.read scope.', []];
    expect(await refusal(apiListTasks({ db: untouched }, ctx(['deals.read']), {}))).toEqual(
      missing,
    );
    expect(await refusal(apiGetTask({ db: untouched }, ctx(['deals.write']), TENANT))).toEqual(
      missing,
    );
    expect(
      (
        await refusal(apiListTasks({ db: untouched }, ctx(['tasks.read']), { status: 'closed' }))
      )[2],
    ).toEqual(['status']);
    expect(
      (await refusal(apiListTasks({ db: untouched }, ctx(['tasks.read']), { cursor: 'x' })))[0],
    ).toBe('validation_failed');
    expect(await refusal(apiGetTask({ db: untouched }, ctx(['tasks.read']), 'not-an-id'))).toEqual([
      'not_found',
      'Task not found.',
      [],
    ]);
  });

  it('read in read-only transactions, while the company is suspended too', async () => {
    for (const status of ['active', 'suspended', 'restricted']) {
      const runs: unknown[] = [];
      const db = {
        run: (_scope: unknown, _fn: unknown, options?: unknown) => {
          runs.push(options);
          throw new Error('reached the database');
        },
      } as unknown as Database;
      for (const read of [
        apiListTasks({ db }, ctx(['tasks.read'], status), {}),
        apiGetTask({ db }, ctx(['tasks.read'], status), TENANT),
      ]) {
        await expect(read).rejects.toThrow('reached the database');
      }
      expect(runs).toEqual([{ accessMode: 'read only' }, { accessMode: 'read only' }]);
    }
  });

  it('are described: the scope, the CRM, pages, filters, reminders and what is never read', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    for (const route of [
      ['get', '/tasks'],
      ['get', '/tasks/{id}'],
    ]) {
      expect(API_ROUTES).toContainEqual(route);
    }
    type Operation = {
      operationId: string;
      description: string;
      parameters: { name?: string; schema?: { enum?: string[] } }[];
      responses: Record<string, { description?: string }>;
    };

    const list = doc.paths['/tasks']?.get as Operation;
    expect(list.operationId).toBe('listTasks');
    expect(list.parameters.map((p) => p.name)).toEqual([
      'limit',
      'cursor',
      'status',
      'assigneeId',
      'contactId',
      'dealId',
      'updatedSince',
    ]);
    expect(list.parameters.find((p) => p.name === 'status')?.schema?.enum).toEqual([
      ...TASK_STATUSES,
    ]);
    expect(Object.keys(list.responses)).toEqual(
      expect.arrayContaining(['200', '401', '403', '422', '429']),
    );
    expect(Object.keys(list.responses)).not.toContain('404');
    for (const words of [
      'Scope: `tasks.read`.',
      'whoever created them (a member or an automation)',
      'newest first by when they were created',
      'pages never skip or repeat a task',
      'Filters combine',
      '(403, reason not_in_plan)',
      'The CRM timeline is never read here',
      'Erasing a contact deletes its tasks',
      'moves the merged contact’s tasks to the one kept',
      '`updatedSince` a little before your previous pass began',
    ]) {
      expect(list.description).toContain(words);
    }
    expect(list.responses['403']?.description).toContain(
      'the CRM when reading pipelines, deals or tasks or creating or changing deals,',
    );

    const one = doc.paths['/tasks/{id}']?.get as Operation;
    expect(one.operationId).toBe('getTask');
    expect(one.description).toContain('Scope: `tasks.read`.');
    expect(one.description).toContain('(403, reason not_in_plan)');
    expect(Object.keys(one.responses)).toEqual(expect.arrayContaining(['200', '403', '404']));

    const task = doc.components.schemas.Task as {
      properties: Record<string, { enum?: string[]; description?: string }>;
      required: string[];
    };
    expect(Object.keys(task.properties)).toEqual([
      'id',
      'title',
      'notes',
      'status',
      'dueAt',
      'remindAt',
      'reminderState',
      'remindedAt',
      'reminderSkipReason',
      'assigneeId',
      'contactId',
      'dealId',
      'completedAt',
      'createdAt',
      'updatedAt',
      'version',
    ]);
    expect(task.required).toEqual(Object.keys(task.properties));
    expect(task.properties.reminderState?.enum).toEqual([...REMINDER_STATES]);
    // Every reason a reminder is skipped for (crm/tasks.ts and crm/reminders.ts) is named.
    for (const reason of ['task_closed', 'too_late', 'assignee_inactive']) {
      expect(task.properties.reminderSkipReason?.description).toContain(`\`${reason}\``);
    }
    // Ids only: no contact details, creators or timeline anywhere in it.
    expect(JSON.stringify(task)).not.toMatch(/"(phone|contactName|createdBy\w*|timeline)"/);
  });
});
