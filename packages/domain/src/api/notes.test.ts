import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, type Database } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import type { ApiContext } from './context';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import {
  API_NOTE_MAX_LENGTH,
  apiCreateNote,
  apiCreateNoteSchema,
  apiCrmNoteListQuerySchema,
  apiGetNote,
  apiListNotes,
  toApiNote,
} from './notes';
import { API_ROUTES, apiNoteSchema, buildOpenApiDocument } from './openapi';

const CONTACT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const DEAL = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';
const WRITER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f03';

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: CONTACT, status },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read. */
const untouched = {
  run: () => {
    throw new Error('read the database');
  },
} as unknown as Database;

const deps = (db: Database) =>
  ({ db, clock: { now: () => new Date() } }) as unknown as Parameters<typeof apiCreateNote>[0];

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

describe('adding CRM notes through the API (ADR-268)', () => {
  it('needs notes.write, a writing scope the database accepts, granted with crm.write', () => {
    expect(API_SCOPES).toContain('notes.write');
    expect(API_SCOPE_KEYS.indexOf('notes.write')).toBe(API_SCOPE_KEYS.indexOf('notes.read') + 1);
    expect(API_SCOPE_INFO['notes.write']).toMatchObject({
      label: 'Add notes to the CRM timeline',
      permission: 'crm.write',
      writes: true,
    });
    for (const words of [
      "of one of the company's contacts, or of one of its deals and so the deal's contact",
      'as members do on the contact and deal pages',
      'recorded as written through the API',
      'Never read the timeline.',
      "CRM in the company's plan",
    ]) {
      expect(API_SCOPE_INFO['notes.write'].description).toContain(words);
    }
    // Owners and administrators, who create keys, add notes in the app.
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('crm.write')).toBe(true);
    }
  });

  it('takes the text and a contact, a deal or both, trimmed, up to the members’ limit', () => {
    const parse = (input: unknown) => apiCreateNoteSchema.safeParse(input);
    expect(API_NOTE_MAX_LENGTH).toBe(4000);
    const trimmed = parse({ body: '  Called; will pay Friday  ', contactId: CONTACT });
    expect(trimmed.success && trimmed.data).toEqual({
      body: 'Called; will pay Friday',
      contactId: CONTACT,
    });
    for (const input of [
      { body: 'x', dealId: DEAL },
      { body: 'x', contactId: CONTACT, dealId: DEAL },
      { body: 'x'.repeat(4000), contactId: CONTACT },
      { body: 'Line one\nLine two', contactId: CONTACT },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(true);
    }
    for (const input of [
      { body: 'x' },
      { contactId: CONTACT },
      { body: '   ', contactId: CONTACT },
      { body: 'x'.repeat(4001), contactId: CONTACT },
      { body: 42, contactId: CONTACT },
      { body: 'x', contactId: 'asha' },
      { body: 'x', dealId: 'annual-plan' },
      { body: 'x', contactId: null },
      { body: 'x', contactId: CONTACT, kind: 'call' },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
    const issue = (input: unknown) => {
      const found = parse(input).error?.issues[0];
      return found && [found.path.join('.'), found.message];
    };
    expect(issue({ body: 'x' })).toEqual(['contactId', 'Give `contactId`, `dealId` or both.']);
    expect(issue({ body: ' ', contactId: CONTACT })).toEqual([
      'body',
      'Give the note’s text in `body`.',
    ]);
    expect(issue({ body: 'x'.repeat(4001), contactId: CONTACT })).toEqual([
      'body',
      'A note is limited to 4000 characters.',
    ]);
  });

  it('refuses keys without the scope, suspended companies and bad bodies before anything is read', async () => {
    const note = { body: 'Called', contactId: CONTACT };
    expect(await refusal(apiCreateNote(deps(untouched), ctx(['tasks.write']), note, null))).toEqual(
      ['forbidden', 'This API key does not have the notes.write scope.', []],
    );
    for (const status of ['suspended', 'restricted']) {
      expect(
        (
          await refusal(apiCreateNote(deps(untouched), ctx(['notes.write'], status), note, null))
        )[0],
      ).toBe('tenant_suspended');
    }
    expect(
      (await refusal(apiCreateNote(deps(untouched), ctx(['notes.write']), { body: 'x' }, null)))[2],
    ).toEqual(['contactId']);
    // A valid request reaches the database in a writing transaction.
    const runs: unknown[] = [];
    const db = {
      run: (_scope: unknown, _fn: unknown, options?: unknown) => {
        runs.push(options);
        throw new Error('reached the database');
      },
    } as unknown as Database;
    await expect(apiCreateNote(deps(db), ctx(['notes.write']), note, null)).rejects.toThrow(
      'reached the database',
    );
    expect(runs).toEqual([undefined]);
  });

  it('is described: the scope, what a note is about, the refusals and the request body', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(API_ROUTES).toContainEqual(['post', '/notes']);
    const create = doc.paths['/notes']?.post as {
      operationId: string;
      description: string;
      parameters: { $ref?: string }[];
      requestBody: { content: Record<string, { schema: unknown }> };
      responses: Record<string, unknown>;
    };
    expect(create.operationId).toBe('createNote');
    expect(create.parameters).toEqual([{ $ref: '#/components/parameters/IdempotencyKeyOptional' }]);
    expect(create.requestBody.content['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/CreateNote',
    });
    expect(Object.keys(create.responses)).toEqual(
      expect.arrayContaining(['201', '403', '404', '409', '422', '423']),
    );
    for (const words of [
      'Scope: `notes.write`.',
      'to a contact (not erased), or to a deal and so to its contact, up to 4000 characters',
      'recorded as written through the API',
      'the audit log names the key, never the note’s text',
      'GET /notes reads notes (`notes.read`); the rest of the timeline is not read through the API.',
      '422 naming the field',
      'a deal whose contact was erased with 409',
      '(403, reason not_in_plan)',
      'With an `Idempotency-Key`, a retry answers the first response.',
      '`contact_merged`',
    ]) {
      expect(create.description).toContain(words);
    }
    const body = doc.components.schemas.CreateNote as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(body.properties)).toEqual(['body', 'contactId', 'dealId']);
    expect(body.required).toEqual(['body']);
    expect(body.additionalProperties).toBe(false);
    const answered = doc.components.schemas.Note as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(answered.properties)).toEqual([
      'id',
      'body',
      'contactId',
      'dealId',
      'writtenBy',
      'apiKeyId',
      'createdAt',
    ]);
    expect(answered.required).toEqual(Object.keys(answered.properties));
  });
});

describe('reading CRM notes through the API (ADR-279)', () => {
  it('needs notes.read, a reading scope the database accepts, granted with crm.read', () => {
    expect(API_SCOPES).toContain('notes.read');
    expect(API_SCOPE_KEYS.indexOf('notes.read')).toBe(API_SCOPE_KEYS.indexOf('tasks.write') + 1);
    expect(API_SCOPE_INFO['notes.read']).toMatchObject({
      label: 'Read CRM notes',
      permission: 'crm.read',
      writes: false,
    });
    for (const words of [
      "the notes on the CRM timelines of the company's contacts and deals",
      'the contact and deal each is about',
      'whether a member or a key wrote it (a key by its id)',
      'Never which member wrote a note, or the rest of the timeline.',
      "CRM in the company's plan",
    ]) {
      expect(API_SCOPE_INFO['notes.read'].description).toContain(words);
    }
    // Every role that reads the CRM in the app can grant it, as for deals and tasks.
    for (const role of ['owner', 'admin'] as const) {
      expect(ROLE_PERMISSIONS[role].has('crm.read')).toBe(true);
    }
    expect(API_SCOPE_INFO['notes.read'].permission).toBe(API_SCOPE_INFO['tasks.read'].permission);
  });

  it('takes pages, a contact, a deal and a time, and nothing else', () => {
    const parse = (input: unknown) => apiCrmNoteListQuerySchema.safeParse(input);
    expect(parse({}).success && parse({}).data).toEqual({ limit: 50 });
    const full = parse({
      limit: '100',
      cursor: 'abc',
      contactId: CONTACT,
      dealId: DEAL,
      createdSince: '2026-10-07T10:00:00+05:30',
    });
    expect(full.success && full.data).toEqual({
      limit: 100,
      cursor: 'abc',
      contactId: CONTACT,
      dealId: DEAL,
      createdSince: '2026-10-07T10:00:00+05:30',
    });
    for (const input of [
      { limit: '0' },
      { limit: '101' },
      { contactId: 'asha' },
      { dealId: 'annual-plan' },
      { createdSince: 'yesterday' },
      { updatedSince: '2026-10-07T10:00:00Z' },
      { writtenBy: 'api' },
      { cursor: 'x'.repeat(201) },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('says who wrote a note: a key by its id, a member never by name', () => {
    const row = {
      id: DEAL,
      body: 'Called back',
      contactId: CONTACT,
      dealId: null,
      createdAt: new Date('2026-10-07T10:00:00.000Z'),
    };
    expect(toApiNote({ ...row, byMember: true, apiKeyId: null })).toEqual({
      id: DEAL,
      body: 'Called back',
      contactId: CONTACT,
      dealId: null,
      writtenBy: 'member',
      apiKeyId: null,
      createdAt: '2026-10-07T10:00:00.000Z',
    });
    expect(toApiNote({ ...row, dealId: DEAL, byMember: false, apiKeyId: WRITER })).toMatchObject({
      dealId: DEAL,
      writtenBy: 'api',
      apiKeyId: WRITER,
    });
    // A member's note names no key, whatever its data holds.
    expect(toApiNote({ ...row, byMember: true, apiKeyId: WRITER })).toMatchObject({
      writtenBy: 'member',
      apiKeyId: null,
    });
  });

  it('refuses keys without the scope, bad queries and bad ids before anything is read', async () => {
    const expected = ['forbidden', 'This API key does not have the notes.read scope.', []];
    // notes.write adds notes; it does not read them.
    for (const scopes of [['notes.write'], ['tasks.read', 'deals.read']]) {
      expect(await refusal(apiListNotes(deps(untouched), ctx(scopes), {}))).toEqual(expected);
      expect(await refusal(apiGetNote(deps(untouched), ctx(scopes), CONTACT))).toEqual(expected);
    }
    expect(
      (await refusal(apiListNotes(deps(untouched), ctx(['notes.read']), { dealId: 'x' })))[2],
    ).toEqual(['dealId']);
    expect((await refusal(apiGetNote(deps(untouched), ctx(['notes.read']), 'not-a-note')))[0]).toBe(
      'not_found',
    );
    // A suspended company still reads, as it reads deals and tasks; both reads are read-only.
    const runs: unknown[] = [];
    const db = {
      run: (_scope: unknown, _fn: unknown, options?: unknown) => {
        runs.push(options);
        throw new Error('reached the database');
      },
    } as unknown as Database;
    const reader = ctx(['notes.read'], 'suspended');
    await expect(apiListNotes(deps(db), reader, {})).rejects.toThrow('reached the database');
    await expect(apiGetNote(deps(db), reader, CONTACT)).rejects.toThrow('reached the database');
    expect(runs).toEqual([{ accessMode: 'read only' }, { accessMode: 'read only' }]);
  });

  it('is described: the scope, the filters, who wrote a note, and what is never read', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(API_ROUTES).toEqual(
      expect.arrayContaining([
        ['get', '/notes'],
        ['get', '/notes/{id}'],
      ]),
    );
    const list = doc.paths['/notes']?.get as {
      operationId: string;
      description: string;
      parameters: { name: string }[];
      responses: Record<string, unknown>;
    };
    expect(list.operationId).toBe('listNotes');
    expect(list.parameters.map((p) => p.name)).toEqual([
      'limit',
      'cursor',
      'contactId',
      'dealId',
      'createdSince',
    ]);
    expect(Object.keys(list.responses)).toEqual(['200', '401', '403', '422', '429', '500']);
    for (const words of [
      'Scope: `notes.read`.',
      'whoever wrote them (a member or an API key), newest first by when they were added; pages never skip or repeat a note',
      'says who wrote it (`writtenBy`), with the key for one added through the API (`apiKeyId`), never which member',
      '(403, reason not_in_plan)',
      'The rest of the timeline (stage moves, closings, tasks done) is never read here',
      'erasing a contact deletes its notes, so they are no longer listed and their ids answer 404',
      'merging contacts moves the merged contact’s notes to the one kept (`contactId` changes',
      'ask for `createdSince` a little before your previous pass began',
    ]) {
      expect(list.description).toContain(words);
    }
    const one = doc.paths['/notes/{id}']?.get as {
      operationId: string;
      description: string;
      responses: Record<string, unknown>;
    };
    expect(one.operationId).toBe('getNote');
    expect(one.description).toContain('Scope: `notes.read`. As GET /notes gives it.');
    expect(one.description).toContain('The id of any other timeline entry answers 404');
    expect(Object.keys(one.responses)).toEqual(['200', '401', '403', '404', '429', '500']);
    // Who wrote a note: a member, never which, or a key by its id.
    expect(apiNoteSchema.shape.writtenBy.options).toEqual(['member', 'api']);
    expect(apiNoteSchema.shape.writtenBy.description).toContain('(member, never which member)');
    expect(apiNoteSchema.shape.apiKeyId.description).toContain('when writtenBy is api');
    expect(apiNoteSchema.shape.contactId.description).toContain(
      'a merge moves it to the contact kept',
    );
  });
});
