import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, type Database } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import type { ApiContext } from './context';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { API_NOTE_MAX_LENGTH, apiCreateNote, apiCreateNoteSchema } from './notes';
import { API_ROUTES, buildOpenApiDocument } from './openapi';

const CONTACT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const DEAL = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';

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
    expect(API_SCOPE_KEYS.indexOf('notes.write')).toBe(API_SCOPE_KEYS.indexOf('tasks.write') + 1);
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
      'not read through the API',
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
      'createdAt',
    ]);
    expect(answered.required).toEqual(['id', 'body', 'contactId', 'dealId', 'createdAt']);
  });
});
