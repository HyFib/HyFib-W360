import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isAppError, Keyring } from '@w360/core';
import type { Database } from '@w360/db';
import { openChangeCursor, sealChangeCursor } from './change-cursors';
import { openContactChangeCursor, sealContactChangeCursor } from './contact-changes';
import type { ApiContext } from './context';
import { apiMessageChanges, apiMessageChangesQuerySchema } from './message-changes';
import { API_SCOPE_INFO } from './model';
import { buildOpenApiDocument } from './openapi';

const keyring = () => new Keyring({ primaryKeyId: 'k1', keys: { k1: randomBytes(32) } });
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

/** The code and paths of a refusal thrown by `fn`. */
function refusal(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, paths: (error.issues ?? []).map((i) => i.path) };
  }
  throw new Error('expected a refusal');
}

const createdAt = new Date('2026-10-02T10:00:00.000Z');
const statusAt = new Date('2026-10-02T10:05:00.000Z');
/** A row of the feed's query: a delivered text the company sent, or a message of an erased contact. */
const row = (n: number, erased = false) => ({
  id: `0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f${String(10 + n)}`,
  conversationId: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9fa1',
  direction: 'outbound' as const,
  type: 'text' as const,
  content: erased ? { redacted: true } : { text: `Order ${n} ships today.` },
  status: 'delivered' as const,
  statusAt,
  errorCode: null,
  errorTitle: null,
  senderType: 'api',
  templateId: null,
  apiKeyId: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9fb1',
  replyTo: null,
  createdAt,
  cursorAt: createdAt.toISOString(),
  contactId: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9fc1',
  channelId: '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9fd1',
  erasedAt: erased ? createdAt : null,
  changeId: String(100 + n),
  changeXact: String(5000 + n),
});

describe('message change cursors (ADR-116)', () => {
  it('open where they were sealed, in this feed only', () => {
    const ring = keyring();
    const at = { xact: '18446744073709551615', id: '9223372036854775807' };
    const cursor = sealChangeCursor(ring, 'message-changes', TENANT, at);
    expect(openChangeCursor(ring, 'message-changes', TENANT, cursor)).toEqual(at);
    expect(openChangeCursor(ring, 'message-changes', TENANT, undefined)).toEqual({
      xact: '0',
      id: '0',
    });
    const invalid = { code: 'validation_failed', paths: ['cursor'] };
    // A contact change cursor of the same company and place opens neither way.
    expect(
      refusal(() =>
        openChangeCursor(
          ring,
          'message-changes',
          TENANT,
          sealContactChangeCursor(ring, TENANT, at),
        ),
      ),
    ).toEqual(invalid);
    expect(refusal(() => openContactChangeCursor(ring, TENANT, cursor))).toEqual(invalid);
    expect(refusal(() => openChangeCursor(ring, 'message-changes', OTHER, cursor))).toEqual(
      invalid,
    );
    expect(refusal(() => openChangeCursor(keyring(), 'message-changes', TENANT, cursor))).toEqual(
      invalid,
    );
  });

  it('keep the contact feed’s cursors working as before (ADR-114)', () => {
    const ring = keyring();
    const at = { xact: '42', id: '7' };
    expect(
      openChangeCursor(ring, 'contact-changes', TENANT, sealContactChangeCursor(ring, TENANT, at)),
    ).toEqual(at);
    expect(
      openContactChangeCursor(ring, TENANT, sealChangeCursor(ring, 'contact-changes', TENANT, at)),
    ).toEqual(at);
  });
});

describe('the message change feed (ADR-116)', () => {
  it('takes a limit of 1 to 100 (50 by default) and a cursor, nothing else', () => {
    expect(apiMessageChangesQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(apiMessageChangesQuerySchema.parse({ limit: '100', cursor: 'abc' })).toEqual({
      limit: 100,
      cursor: 'abc',
    });
    for (const bad of [
      { limit: '0' },
      { limit: '101' },
      { limit: '1.5' },
      { since: '2026-10-01T00:00:00Z' },
      { direction: 'inbound' },
      { cursor: 'c'.repeat(401) },
    ]) {
      expect(apiMessageChangesQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('needs conversations.read, and refuses a bad query or cursor, before it reads anything', async () => {
    const deps = { db: untouched, keyring: keyring() };
    const code = (c: ApiContext, query: unknown) =>
      apiMessageChanges(deps, c, query).then(
        () => 'done',
        (error: unknown) => (isAppError(error) ? error.code : String(error)),
      );
    for (const scopes of [['messages.send', 'messages.reply'], ['contacts.read'], []]) {
      expect(await code(ctx(scopes), {}), JSON.stringify(scopes)).toBe('forbidden');
    }
    const reader = ctx(['conversations.read']);
    expect(await code(reader, { limit: '0' })).toBe('validation_failed');
    expect(await code(reader, { cursor: 'not-a-cursor' })).toBe('validation_failed');
    const otherFeed = sealContactChangeCursor(deps.keyring, TENANT, { xact: '1', id: '1' });
    expect(await code(reader, { cursor: otherFeed })).toBe('validation_failed');
  });

  it('reads for suspended and restricted companies too: it changes nothing', async () => {
    expect(API_SCOPE_INFO['conversations.read'].writes).toBe(false);
    const db = { run: async () => [] } as unknown as Database;
    for (const status of ['suspended', 'restricted']) {
      const page = await apiMessageChanges(
        { db, keyring: keyring() },
        ctx(['conversations.read'], status),
        {},
      );
      expect(page).toMatchObject({ data: [], hasMore: false });
    }
  });

  it('gives each message as the message feed does, erased ones as erased, and where to go on', async () => {
    const ring = keyring();
    const rows = [row(1), row(2, true), row(3)];
    let limit = 0;
    const db = {
      run: async (_scope: unknown, fn: (tx: unknown) => unknown) => {
        // The query asks for one row more than the page, to say whether more remain.
        const chain = {
          select: () => chain,
          from: () => chain,
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: (n: number) => {
            limit = n;
            return Promise.resolve(rows.slice(0, n));
          },
        };
        return fn(chain);
      },
    } as unknown as Database;
    const page = await apiMessageChanges({ db, keyring: ring }, ctx(['conversations.read']), {
      limit: '2',
    });
    expect(limit).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(page.data).toEqual([
      {
        id: rows[0]!.id,
        erased: false,
        message: {
          id: rows[0]!.id,
          conversationId: rows[0]!.conversationId,
          direction: 'outbound',
          type: 'text',
          text: 'Order 1 ships today.',
          reply: null,
          replyTo: null,
          mimeType: null,
          templateId: null,
          templateName: null,
          sentBy: 'api',
          apiKeyId: rows[0]!.apiKeyId,
          status: 'delivered',
          statusAt: statusAt.toISOString(),
          error: null,
          createdAt: createdAt.toISOString(),
          contactId: rows[0]!.contactId,
          channelId: rows[0]!.channelId,
        },
      },
      { id: rows[1]!.id, erased: true, message: null },
    ]);
    // The cursor continues after the last message shown, not after the one read to look ahead.
    expect(openChangeCursor(ring, 'message-changes', TENANT, page.nextCursor)).toEqual({
      xact: '5002',
      id: '102',
    });
  });

  it('says no more remain when the last page is exactly full', async () => {
    const rows = [row(1), row(2)];
    const db = {
      run: async (_scope: unknown, fn: (tx: unknown) => unknown) => {
        const chain = {
          select: () => chain,
          from: () => chain,
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
        };
        return fn(chain);
      },
    } as unknown as Database;
    const page = await apiMessageChanges({ db, keyring: keyring() }, ctx(['conversations.read']), {
      limit: '2',
    });
    expect(page.data.map((c) => c.id)).toEqual([rows[0]!.id, rows[1]!.id]);
    expect(page.hasMore).toBe(false);
  });

  it('gives back the same place when nothing changed since', async () => {
    const ring = keyring();
    const at = { xact: '77', id: '9' };
    const db = { run: async () => [] } as unknown as Database;
    const page = await apiMessageChanges({ db, keyring: ring }, ctx(['conversations.read']), {
      cursor: sealChangeCursor(ring, 'message-changes', TENANT, at),
    });
    expect(page.hasMore).toBe(false);
    expect(openChangeCursor(ring, 'message-changes', TENANT, page.nextCursor)).toEqual(at);
  });

  it('is described: the scope, the order, erased messages and the cursor', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as unknown as Record<
      string,
      Record<string, { operationId: string; description: string }>
    >;
    const op = paths['/message-changes']?.get;
    expect(op?.operationId).toBe('listMessageChanges');
    expect(op?.description).toContain('`conversations.read`');
    expect(op?.description).toContain('No change is skipped');
    expect(op?.description).toContain('given as erased');
    expect(op?.description).toContain('only with this feed');
    expect(paths['/messages']?.get?.description).toContain('`GET /message-changes`');
    const schemas = doc.components.schemas as Record<
      string,
      { required?: string[]; properties?: Record<string, unknown> }
    >;
    expect(schemas.MessageChange?.required).toEqual(['id', 'erased', 'message']);
  });
});
