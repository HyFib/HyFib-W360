import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isAppError, Keyring } from '@w360/core';
import type { Database } from '@w360/db';
import {
  apiContactChanges,
  apiContactChangesQuerySchema,
  openContactChangeCursor,
  sealContactChangeCursor,
} from './contact-changes';
import type { ApiContext } from './context';
import { buildOpenApiDocument } from './openapi';

const keyring = () => new Keyring({ primaryKeyId: 'k1', keys: { k1: randomBytes(32) } });
const TENANT = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f01';
const OTHER = '0192f0c4-8e2b-7c1d-9a3e-5b6c7d8e9f02';

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

describe('contact change cursors (ADR-114)', () => {
  it('open where they were sealed, and start at the first change without one', () => {
    const ring = keyring();
    const at = { xact: '18446744073709551615', id: '9223372036854775807' };
    const cursor = sealContactChangeCursor(ring, TENANT, at);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(cursor, 'base64url').toString('utf8')).not.toContain(at.xact);
    expect(openContactChangeCursor(ring, TENANT, cursor)).toEqual(at);
    expect(openContactChangeCursor(ring, TENANT, undefined)).toEqual({ xact: '0', id: '0' });
    // Sealed afresh each time, so two cursors of one place do not show they are the same.
    expect(sealContactChangeCursor(ring, TENANT, at)).not.toBe(cursor);
  });

  it('do not open for another company, another key, or after any change, naming the cursor', () => {
    const ring = keyring();
    const cursor = sealContactChangeCursor(ring, TENANT, { xact: '42', id: '7' });
    const invalid = { code: 'validation_failed', paths: ['cursor'] };
    expect(refusal(() => openContactChangeCursor(ring, OTHER, cursor))).toEqual(invalid);
    expect(refusal(() => openContactChangeCursor(keyring(), TENANT, cursor))).toEqual(invalid);
    const sealed = Buffer.from(cursor, 'base64url').toString('utf8');
    const flipped = sealed.replace(/:([A-Za-z0-9_-])/g, (_, ch: string) =>
      ch === 'A' ? ':B' : ':A',
    );
    expect(
      refusal(() =>
        openContactChangeCursor(ring, TENANT, Buffer.from(flipped).toString('base64url')),
      ),
    ).toEqual(invalid);
    expect(refusal(() => openContactChangeCursor(ring, TENANT, ''))).toEqual(invalid);
    expect(refusal(() => openContactChangeCursor(ring, TENANT, 'NDIuNw'))).toEqual(invalid);
  });

  it('hold only a transaction and a change id, digits each', () => {
    const ring = keyring();
    for (const at of [
      { xact: '-1', id: '1' },
      { xact: '1', id: '1.5' },
      { xact: '123456789012345678901', id: '1' },
      { xact: '1', id: '12345678901234567890' },
      { xact: '', id: '1' },
    ]) {
      const cursor = sealContactChangeCursor(ring, TENANT, at);
      expect(
        refusal(() => openContactChangeCursor(ring, TENANT, cursor)),
        JSON.stringify(at),
      ).toEqual({ code: 'validation_failed', paths: ['cursor'] });
    }
  });
});

describe('the contact change feed (ADR-114)', () => {
  it('takes a limit of 1 to 100 (50 by default) and a cursor, nothing else', () => {
    expect(apiContactChangesQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(apiContactChangesQuerySchema.parse({ limit: '100', cursor: 'abc' })).toEqual({
      limit: 100,
      cursor: 'abc',
    });
    for (const bad of [{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { since: 'x' }]) {
      expect(apiContactChangesQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('needs contacts.read before it reads anything', async () => {
    const ctx = {
      tenant: { id: TENANT, status: 'active' },
      key: { id: 'k', scopes: new Set(['contacts.write']) },
      planScopes: null,
    } as unknown as ApiContext;
    const db = {
      run: () => {
        throw new Error('read without the scope');
      },
    } as unknown as Database;
    await expect(apiContactChanges({ db, keyring: keyring() }, ctx, {})).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('is described: the scope, the order, the cursor and each changed contact', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as unknown as Record<
      string,
      Record<string, { operationId: string; description: string }>
    >;
    const op = paths['/contact-changes']?.get;
    expect(op?.operationId).toBe('listContactChanges');
    expect(op?.description).toContain('`contacts.read`');
    expect(op?.description).toContain('No change is skipped');
    expect(op?.description).toContain('A cursor works only for the company that read it.');
    const schemas = doc.components.schemas as Record<
      string,
      { required?: string[]; properties?: Record<string, unknown> }
    >;
    expect(schemas.ContactChange?.required).toEqual(['id', 'erased', 'contact']);
  });
});
