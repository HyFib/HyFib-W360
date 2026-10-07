import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, REMINDER_STATES, TASK_STATUSES, type Database } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import type { ApiContext } from './context';
import { taskTimeIssue } from '../crm/tasks';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { API_ROUTES, apiTaskSchema, buildOpenApiDocument } from './openapi';
import {
  apiCreateTask,
  apiCreateTaskSchema,
  apiGetTask,
  apiListTasks,
  apiTaskListQuerySchema,
  apiUpdateTask,
  apiUpdateTaskSchema,
} from './tasks';

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
    // Listed after the deal and pipeline scopes, in the order the database's scope checks list them.
    expect(API_SCOPE_KEYS.indexOf('tasks.read')).toBe(
      API_SCOPE_KEYS.indexOf('pipelines.manage') + 1,
    );
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
      'whoever created them (a member, an automation or an API key)',
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
    expect(list.responses['403']?.description).toContain('the CRM for pipelines, deals and tasks,');

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
      'changedBy',
      'changedByApiKeyId',
      'createdBy',
      'createdByApiKeyId',
    ]);
    expect(task.required).toEqual(Object.keys(task.properties));
    // Who made the latest change, with the key for a key's (ADR-278).
    const changer = apiTaskSchema.shape.changedBy;
    expect(changer.unwrap().options).toEqual(['member', 'automation', 'api']);
    for (const words of [
      'never which member',
      'automations only add tasks',
      'Null while the task is as it was added',
      'never the maker of an earlier change',
    ]) {
      expect(changer.description).toContain(words);
    }
    expect(apiTaskSchema.shape.changedByApiKeyId.description).toContain('when changedBy is api');
    expect(list.description).toContain(
      '`changedBy` says who made a task’s latest change of what task events report, with the key for one made through the API (`changedByApiKeyId`), so an integration can tell the tasks it changed last',
    );
    // Who added it, always someone, with the key for a key's (ADR-282).
    const creator = apiTaskSchema.shape.createdBy;
    expect(creator.options).toEqual(['member', 'automation', 'api']);
    expect(creator.safeParse(null).success).toBe(false);
    for (const words of ['a member (member, never which member)', 'as task.created says']) {
      expect(creator.description).toContain(words);
    }
    expect(apiTaskSchema.shape.createdByApiKeyId.description).toContain('when createdBy is api');
    expect(list.description).toContain(
      '`createdBy` and `createdByApiKeyId` say likewise who added it.',
    );
    expect(task.properties.reminderState?.enum).toEqual([...REMINDER_STATES]);
    // Every reason a reminder is skipped for (crm/tasks.ts and crm/reminders.ts) is named.
    for (const reason of ['task_closed', 'too_late', 'assignee_inactive']) {
      expect(task.properties.reminderSkipReason?.description).toContain(`\`${reason}\``);
    }
    // Ids only: no contact details, which member or automation added it, or timeline in it.
    expect(JSON.stringify(task)).not.toMatch(
      /"(phone|contactName|createdBy(Id|Membership\w*|Automation\w*)|timeline)"/,
    );
  });
});

describe('creating CRM tasks through the API (ADR-259)', () => {
  const deps = (db: Database) =>
    ({ db, clock: { now: () => new Date() }, jobs: {}, signer: {} }) as unknown as Parameters<
      typeof apiCreateTask
    >[0];
  const task = { title: 'Call back', assigneeId: OTHER };

  it('needs tasks.write, a writing scope the database accepts, granted with crm.write', () => {
    expect(API_SCOPES).toContain('tasks.write');
    expect(API_SCOPE_KEYS.indexOf('tasks.write')).toBe(API_SCOPE_KEYS.indexOf('tasks.read') + 1);
    expect(API_SCOPE_INFO['tasks.write']).toMatchObject({
      label: 'Create and change CRM tasks',
      permission: 'crm.write',
      writes: true,
    });
    for (const words of [
      'as members do',
      "for one of the company's contacts or deals or for nobody",
      'an active member who can use the CRM',
      'a reminder emailed to the assignee',
      'change, complete, cancel and reopen them as members do',
      'recorded as done through the API',
      "CRM in the company's plan",
    ]) {
      expect(API_SCOPE_INFO['tasks.write'].description).toContain(words);
    }
    // Owners and administrators, who create keys, create tasks in the app.
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('crm.write')).toBe(true);
    }
  });

  it('takes a title and an assignee, and optionally notes, a contact or deal and times', () => {
    const parse = (input: unknown) => apiCreateTaskSchema.safeParse(input);
    const minimal = parse({ ...task, title: '  Call back  ' });
    expect(minimal.success && minimal.data).toEqual(task);
    for (const input of [
      { ...task, notes: 'About the renewal', contactId: TENANT },
      { ...task, dealId: TENANT, contactId: OTHER },
      { ...task, notes: null, dueAt: null, remindAt: null },
      { ...task, dueAt: '2026-10-09T10:00:00+05:30', remindAt: '2026-10-08T09:30:00Z' },
      { ...task, title: 'x'.repeat(200), notes: 'y'.repeat(2000) },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(true);
    }
    for (const input of [
      { assigneeId: OTHER },
      { title: 'Call back' },
      { ...task, title: '   ' },
      { ...task, title: 'x'.repeat(201) },
      { ...task, notes: 'y'.repeat(2001) },
      { ...task, assigneeId: 'me' },
      { ...task, assigneeId: null },
      { ...task, contactId: 'asha' },
      { ...task, dealId: 'annual-plan' },
      { ...task, dueAt: 'tomorrow' },
      { ...task, remindAt: '2026-10-08' },
      { ...task, status: 'done' },
      { ...task, createdById: TENANT },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('keeps the members’ rule for times, naming the field', () => {
    const now = new Date('2026-10-07T10:00:00Z');
    const at = (ms: number) => new Date(now.getTime() + ms);
    const year = 365 * 24 * 3600_000;
    expect(taskTimeIssue(at(4 * year), at(year - 60_000), now, true)).toBeNull();
    expect(taskTimeIssue(at(-4 * year), at(-30_000), now, true)).toBeNull();
    expect(taskTimeIssue(at(5 * year + 60_000), null, now, true)).toEqual({
      path: 'dueAt',
      message: 'Choose a due date within five years.',
    });
    expect(taskTimeIssue(at(-5 * year - 60_000), null, now, true)?.path).toBe('dueAt');
    expect(taskTimeIssue(null, at(-90_000), now, true)).toEqual({
      path: 'remindAt',
      message: 'Choose a reminder time in the future.',
    });
    expect(taskTimeIssue(null, at(year + 60_000), now, true)).toEqual({
      path: 'remindAt',
      message: 'Choose a reminder time within a year.',
    });
    // A reminder that does not change is not checked again.
    expect(taskTimeIssue(null, at(-90_000), now, false)).toBeNull();
  });

  it('refuses keys without the scope, suspended companies and bad bodies before anything is read', async () => {
    expect(await refusal(apiCreateTask(deps(untouched), ctx(['tasks.read']), task, null))).toEqual([
      'forbidden',
      'This API key does not have the tasks.write scope.',
      [],
    ]);
    for (const status of ['suspended', 'restricted']) {
      expect(
        (
          await refusal(apiCreateTask(deps(untouched), ctx(['tasks.write'], status), task, null))
        )[0],
      ).toBe('tenant_suspended');
    }
    expect(
      (
        await refusal(
          apiCreateTask(deps(untouched), ctx(['tasks.write']), { ...task, dealId: 'x' }, null),
        )
      )[2],
    ).toEqual(['dealId']);
    // A valid request reaches the database in a writing transaction, where the times are checked
    // after an Idempotency-Key is claimed, so a retry after the reminder time is answered.
    const runs: unknown[] = [];
    const db = {
      run: (_scope: unknown, _fn: unknown, options?: unknown) => {
        runs.push(options);
        throw new Error('reached the database');
      },
    } as unknown as Database;
    const late = { ...task, remindAt: '2020-01-01T00:00:00Z' };
    await expect(apiCreateTask(deps(db), ctx(['tasks.write']), late, null)).rejects.toThrow(
      'reached the database',
    );
    expect(runs).toEqual([undefined]);
  });

  it('is described: the scope, what a task is about, the refusals and the request body', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(API_ROUTES).toContainEqual(['post', '/tasks']);
    const create = doc.paths['/tasks']?.post as {
      operationId: string;
      description: string;
      parameters: { $ref?: string }[];
      requestBody: { content: Record<string, { schema: unknown }> };
      responses: Record<string, unknown>;
    };
    expect(create.operationId).toBe('createTask');
    expect(create.parameters).toEqual([{ $ref: '#/components/parameters/IdempotencyKeyOptional' }]);
    expect(create.requestBody.content['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/CreateTask',
    });
    expect(Object.keys(create.responses)).toEqual(
      expect.arrayContaining(['201', '403', '404', '409', '422', '423']),
    );
    for (const words of [
      'Scope: `tasks.write`.',
      'about a contact (not erased), a deal and so its contact, or nobody',
      'an active member who can use the CRM (GET /members)',
      'a due time within five years',
      'from now to a year ahead',
      'recorded as created through the API',
      '422 naming the field',
      'a deal whose contact was erased with 409',
      '(403, reason not_in_plan)',
      'With an `Idempotency-Key`, a retry answers the first response.',
      '`contact_merged`',
    ]) {
      expect(create.description).toContain(words);
    }
    const body = doc.components.schemas.CreateTask as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(body.properties)).toEqual([
      'title',
      'notes',
      'assigneeId',
      'contactId',
      'dealId',
      'dueAt',
      'remindAt',
    ]);
    expect(body.required).toEqual(['title', 'assigneeId']);
    expect(body.additionalProperties).toBe(false);
  });
});

describe('changing CRM tasks through the API (ADR-260)', () => {
  const deps = (db: Database) =>
    ({ db, clock: { now: () => new Date() }, jobs: {}, signer: {} }) as unknown as Parameters<
      typeof apiUpdateTask
    >[0];

  it('takes details and a status, at least one, and never another contact or deal', () => {
    const parse = (input: unknown) => apiUpdateTaskSchema.safeParse(input);
    const trimmed = parse({ title: '  Call back  ' });
    expect(trimmed.success && trimmed.data).toEqual({ title: 'Call back' });
    for (const status of TASK_STATUSES) expect(parse({ status }).success).toBe(true);
    for (const input of [
      { notes: 'About the renewal', assigneeId: OTHER },
      { notes: null, dueAt: null, remindAt: null },
      { notes: '' },
      { dueAt: '2026-10-09T10:00:00+05:30', remindAt: '2026-10-08T09:30:00Z' },
      { title: 'Call back', status: 'done', expectedVersion: 3 },
      { status: 'open', remindAt: '2026-10-08T09:30:00Z' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(true);
    }
    for (const input of [
      {},
      { expectedVersion: 2 },
      { status: 'closed' },
      { title: '   ' },
      { title: null },
      { title: 'x'.repeat(201) },
      { notes: 'y'.repeat(2001) },
      { assigneeId: 'me' },
      { assigneeId: null },
      { dueAt: 'tomorrow' },
      { remindAt: '2026-10-08' },
      { status: 'done', expectedVersion: 0 },
      { status: 'done', expectedVersion: 1.5 },
      { contactId: TENANT },
      { dealId: TENANT },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('need tasks.write, an active company and a task id, refused before anything is read', async () => {
    const change = { status: 'done' };
    expect(
      await refusal(apiUpdateTask(deps(untouched), ctx(['tasks.read']), TENANT, change)),
    ).toEqual(['forbidden', 'This API key does not have the tasks.write scope.', []]);
    for (const status of ['suspended', 'restricted']) {
      expect(
        (
          await refusal(
            apiUpdateTask(deps(untouched), ctx(['tasks.write'], status), TENANT, change),
          )
        )[0],
      ).toBe('tenant_suspended');
    }
    expect(
      await refusal(apiUpdateTask(deps(untouched), ctx(['tasks.write']), 'not-an-id', change)),
    ).toEqual(['not_found', 'Task not found.', []]);
    expect(
      (await refusal(apiUpdateTask(deps(untouched), ctx(['tasks.write']), TENANT, {})))[0],
    ).toBe('validation_failed');
    // A valid request reaches the database in a writing transaction.
    const runs: unknown[] = [];
    const db = {
      run: (_scope: unknown, _fn: unknown, options?: unknown) => {
        runs.push(options);
        throw new Error('reached the database');
      },
    } as unknown as Database;
    await expect(apiUpdateTask(deps(db), ctx(['tasks.write']), TENANT, change)).rejects.toThrow(
      'reached the database',
    );
    expect(runs).toEqual([undefined]);
  });

  it('is described: the order of changes, the refusals, the version and the body', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: {
        schemas: Record<string, { properties: Record<string, { description?: string }> }>;
      };
    };
    expect(API_ROUTES).toContainEqual(['patch', '/tasks/{id}']);
    const update = doc.paths['/tasks/{id}']?.patch as {
      operationId: string;
      description: string;
      requestBody: { content: Record<string, { schema: unknown }> };
      responses: Record<string, unknown>;
    };
    expect(update.operationId).toBe('updateTask');
    expect(update.requestBody.content['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/UpdateTask',
    });
    expect(Object.keys(update.responses)).toEqual(
      expect.arrayContaining(['200', '403', '404', '409', '422', '423']),
    );
    for (const words of [
      'Scope: `tasks.write`.',
      'in this order: `status` `open` reopens a closed task',
      'a reminder skipped when it was closed is not brought back',
      'a new reminder time, from now to a year ahead, is emailed to the assignee then',
      '`status` `done` completes and `cancelled` cancels the open task, skipping a pending reminder',
      'A task’s contact and deal do not change.',
      'Only what differs is a change, so a retry changes nothing',
      'until it is reopened (409)',
      'With `expectedVersion`, a task changed since is refused with 409.',
      'as done through the API, and the audit log names the key',
      '(403, reason not_in_plan)',
    ]) {
      expect(update.description).toContain(words);
    }
    const body = doc.components.schemas.UpdateTask as unknown as {
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(body.properties)).toEqual([
      'title',
      'notes',
      'assigneeId',
      'dueAt',
      'remindAt',
      'status',
      'expectedVersion',
    ]);
    expect(body.required ?? []).toEqual([]);
    expect(body.additionalProperties).toBe(false);
    expect(doc.components.schemas.Task?.properties.version?.description).toContain(
      'PATCH /tasks/{id} takes it as `expectedVersion`',
    );
  });
});
