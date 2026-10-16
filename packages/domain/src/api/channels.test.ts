import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, CHANNEL_STATUSES, type Database } from '@w360/db';
import { ROLE_PERMISSIONS } from '../authz/permissions';
import { apiChannelListQuerySchema, apiListChannels } from './channels';
import type { ApiContext } from './context';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { API_ROUTES, buildOpenApiDocument } from './openapi';

const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';

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

describe('WhatsApp numbers through the API (ADR-171)', () => {
  it('are read with channels.read, a reading scope the database accepts, granted with the permission members read them with', () => {
    expect(API_SCOPES).toContain('channels.read');
    expect(API_SCOPE_KEYS[0]).toBe('channels.read');
    expect(API_SCOPE_INFO['channels.read']).toMatchObject({
      label: 'Read WhatsApp numbers',
      permission: 'channels.read',
      writes: false,
    });
    expect(API_SCOPE_INFO['channels.read'].description).toContain(
      "Never Meta's ids or credentials.",
    );
    // Every role but billing sees the numbers in Settings → Channels; owners and administrators,
    // who create keys, among them.
    expect(
      Object.entries(ROLE_PERMISSIONS)
        .filter(([, permissions]) => permissions.has('channels.read'))
        .map(([role]) => role)
        .sort(),
    ).toEqual(['admin', 'agent', 'analyst', 'marketer', 'owner', 'supervisor']);
  });

  it('take a page and a status, nothing else', () => {
    const parse = (input: unknown) => apiChannelListQuerySchema.safeParse(input);
    const parsed = parse({});
    expect(parsed.success && [parsed.data.limit, parsed.data.cursor, parsed.data.status]).toEqual([
      50,
      undefined,
      undefined,
    ]);
    for (const status of CHANNEL_STATUSES) expect(parse({ status }).success, status).toBe(true);
    expect(parse({ limit: '100', cursor: 'abc' }).success).toBe(true);
    for (const input of [
      { limit: '101' },
      { limit: '0' },
      { status: 'connected' },
      { status: 'ACTIVE' },
      { phone: '+919876543210' },
      { accountId: TENANT },
    ]) {
      expect(parse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it('need channels.read and refuse bad requests before reading anything', async () => {
    for (const scopes of [['templates.read'], ['messages.send', 'webhooks.manage']]) {
      expect(await refusal(apiListChannels({ db: untouched }, ctx(scopes), {}))).toEqual([
        'forbidden',
        'This API key does not have the channels.read scope.',
        [],
      ]);
    }
    expect(
      (
        await refusal(apiListChannels({ db: untouched }, ctx(['channels.read']), { limit: '500' }))
      )[2],
    ).toEqual(['limit']);
    expect(
      (
        await refusal(apiListChannels({ db: untouched }, ctx(['channels.read']), { cursor: 'x' }))
      )[0],
    ).toBe('validation_failed');
    expect(
      (
        await refusal(
          apiListChannels({ db: untouched }, ctx(['channels.read']), { status: 'connected' }),
        )
      )[2],
    ).toEqual(['status']);
  });

  it('read in a read-only transaction, while the company is suspended too', async () => {
    for (const status of ['active', 'suspended', 'restricted']) {
      const { db, runs } = reached();
      await expect(apiListChannels({ db }, ctx(['channels.read'], status), {})).rejects.toThrow(
        'reached the database',
      );
      expect(runs).toEqual([{ accessMode: 'read only' }]);
    }
  });

  it('are described: the scope, the order, the status filter and what is never given', () => {
    const doc = buildOpenApiDocument('https://example.test/api/v1') as unknown as {
      info: { description: string };
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(API_ROUTES).toContainEqual(['get', '/channels']);
    const list = doc.paths['/channels']?.get as {
      operationId: string;
      summary: string;
      description: string;
      parameters: { name?: string; schema?: { enum?: string[] } }[];
      responses: Record<string, unknown>;
    };
    expect(list.operationId).toBe('listChannels');
    expect(list.summary).toBe('WhatsApp numbers, oldest first');
    expect(list.parameters.map((p) => p.name)).toEqual(['limit', 'cursor', 'status']);
    expect(list.parameters.find((p) => p.name === 'status')?.schema?.enum).toEqual([
      ...CHANNEL_STATUSES,
    ]);
    expect(Object.keys(list.responses)).toEqual(
      expect.arrayContaining(['200', '401', '403', '422', '429', '500']),
    );
    for (const words of [
      'Scope: `channels.read`.',
      'whatever their status',
      '`from` takes on POST /messages',
      "Meta's ids for them and their credentials are never given",
    ]) {
      expect(list.description).toContain(words);
    }
    const schema = doc.components.schemas.Channel as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['id', 'phone', 'name', 'status', 'createdAt']);
    expect(schema.required).toEqual(Object.keys(schema.properties));
    expect(schema.properties.status?.enum).toEqual([...CHANNEL_STATUSES]);
    // Nothing Meta or the connection holds: no Meta id, credential or registration detail.
    expect(JSON.stringify(schema)).not.toMatch(
      /"(phoneNumberId|wabaId|whatsappAccountId|token|credential\w*|pin|qualityRating|messagingLimit\w*)"/,
    );
    expect(doc.info.description).toContain('list your WhatsApp numbers');
  });
});
