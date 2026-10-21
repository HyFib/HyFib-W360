import { describe, expect, it } from 'vitest';
import { isAppError } from '@w360/core';
import { API_SCOPES, type Database } from '@w360/db';
import {
  apiContactFieldCreateSchema,
  apiContactFieldUpdateSchema,
  apiCreateContactField,
  apiDeleteContactField,
  apiUpdateContactField,
} from './contact-fields';
import { apiListContactFields } from './contacts';
import type { ApiContext } from './context';
import { API_SCOPE_INFO, API_SCOPE_KEYS } from './model';
import { buildOpenApiDocument } from './openapi';

const ctx = (scopes: string[], status = 'active') =>
  ({
    tenant: { id: 't', status },
    key: { id: 'k', scopes: new Set(scopes) },
    planScopes: null,
  }) as unknown as ApiContext;

/** A database that fails the test if anything is read. */
const untouched = {
  run: () => {
    throw new Error('read the database');
  },
} as unknown as Database;

const code = (fn: () => Promise<unknown>) =>
  fn().then(
    () => 'done',
    (error: unknown) => (isAppError(error) ? error.code : String(error)),
  );

describe('defining contact fields through the API (ADR-115)', () => {
  it('is its own scope, granted by members who manage the company’s settings', () => {
    expect(API_SCOPE_KEYS).toContain('contact_fields.manage');
    expect(API_SCOPES).toContain('contact_fields.manage');
    expect(API_SCOPE_INFO['contact_fields.manage']).toMatchObject({
      permission: 'tenant.settings.manage',
      writes: true,
    });
  });

  it('adds a field from a label and a type, with a key of the field-key shape or none', () => {
    expect(apiContactFieldCreateSchema.parse({ label: '  City ', type: 'text' })).toEqual({
      label: 'City',
      type: 'text',
    });
    expect(
      apiContactFieldCreateSchema.parse({ label: 'Orders', type: 'number', key: 'orders_2' }),
    ).toEqual({ label: 'Orders', type: 'number', key: 'orders_2' });
    for (const bad of [
      { label: '', type: 'text' },
      { label: '   ', type: 'text' },
      { label: 'x'.repeat(81), type: 'text' },
      { label: 'City', type: 'list' },
      { label: 'City' },
      { label: 'City', type: 'text', key: 'City' },
      { label: 'City', type: 'text', key: '1city' },
      { label: 'City', type: 'text', key: 'city-name' },
      { label: 'City', type: 'text', key: 'c'.repeat(41) },
      { label: 'City', type: 'text', id: 'x' },
    ]) {
      expect(apiContactFieldCreateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('renames a field and changes nothing else', () => {
    expect(apiContactFieldUpdateSchema.parse({ label: ' Town ' })).toEqual({ label: 'Town' });
    for (const bad of [{}, { label: '' }, { label: 'Town', type: 'number' }, { key: 'town' }]) {
      expect(apiContactFieldUpdateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('adds a choice field with its options, and no other type with any (ADR-407)', () => {
    expect(
      apiContactFieldCreateSchema.parse({
        label: 'Tier',
        type: 'choice',
        options: [' Gold ', 'Silver'],
      }),
    ).toEqual({ label: 'Tier', type: 'choice', options: ['Gold', 'Silver'] });
    for (const bad of [
      { label: 'Tier', type: 'choice' },
      { label: 'Tier', type: 'choice', options: [] },
      { label: 'Tier', type: 'choice', options: ['Gold', 'gold'] },
      { label: 'Tier', type: 'choice', options: ['Go\nld'] },
      { label: 'Tier', type: 'choice', options: ['x'.repeat(81)] },
      { label: 'Tier', type: 'choice', options: Array.from({ length: 51 }, (_, i) => `o${i}`) },
      { label: 'City', type: 'text', options: ['Gold'] },
    ]) {
      expect(apiContactFieldCreateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('changes a choice field’s options, its label, or both (ADR-407)', () => {
    expect(apiContactFieldUpdateSchema.parse({ options: ['Gold', ' Silver'] })).toEqual({
      options: ['Gold', 'Silver'],
    });
    expect(apiContactFieldUpdateSchema.parse({ label: 'Tier', options: ['Gold'] })).toEqual({
      label: 'Tier',
      options: ['Gold'],
    });
    for (const bad of [{ options: [] }, { options: ['A', 'a'] }, { options: 'Gold' }]) {
      expect(apiContactFieldUpdateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses before anything is read: without the scope, while the company is not active, keys no field can have, and other bodies', async () => {
    const deps = { db: untouched, clock: { now: () => new Date() } };
    const create = (c: ApiContext, body: unknown) =>
      code(() => apiCreateContactField(deps, c, body, null));
    const update = (c: ApiContext, key: string, body: unknown) =>
      code(() => apiUpdateContactField(deps, c, key, body));
    const remove = (c: ApiContext, key: string) => code(() => apiDeleteContactField(deps, c, key));
    const body = { label: 'City', type: 'text' };
    const definer = ctx(['contact_fields.manage']);
    for (const scopes of [['contacts.read', 'contacts.write'], ['webhooks.manage']]) {
      expect(await create(ctx(scopes), body)).toBe('forbidden');
      expect(await update(ctx(scopes), 'city', { label: 'Town' })).toBe('forbidden');
      expect(await remove(ctx(scopes), 'city')).toBe('forbidden');
    }
    for (const status of ['suspended', 'restricted']) {
      const c = ctx(['contact_fields.manage'], status);
      expect(await create(c, body)).toBe('tenant_suspended');
      expect(await update(c, 'city', { label: 'Town' })).toBe('tenant_suspended');
      expect(await remove(c, 'city')).toBe('tenant_suspended');
    }
    for (const key of ['City', 'city name', '../city', '', 'c'.repeat(41)]) {
      expect(await update(definer, key, { label: 'Town' }), key).toBe('not_found');
      expect(await remove(definer, key), key).toBe('not_found');
    }
    expect(await create(definer, { label: 'City' })).toBe('validation_failed');
    expect(await update(definer, 'city', { label: 'Town', type: 'date' })).toBe(
      'validation_failed',
    );
  });

  it('lists the fields for keys that read contacts or define the fields, and no other', async () => {
    const createdAt = new Date('2026-10-02T10:00:00.000Z');
    const db = {
      run: async () => [
        { key: 'city', label: 'City', type: 'text', options: null, createdAt },
        { key: 'tier', label: 'Tier', type: 'choice', options: ['Gold', 'Silver'], createdAt },
      ],
    } as unknown as Database;
    for (const scopes of [['contacts.read'], ['contact_fields.manage']]) {
      expect(await apiListContactFields({ db }, ctx(scopes))).toEqual([
        {
          key: 'city',
          label: 'City',
          type: 'text',
          options: null,
          createdAt: '2026-10-02T10:00:00.000Z',
        },
        {
          key: 'tier',
          label: 'Tier',
          type: 'choice',
          options: ['Gold', 'Silver'],
          createdAt: '2026-10-02T10:00:00.000Z',
        },
      ]);
    }
    expect(await code(() => apiListContactFields({ db: untouched }, ctx(['contacts.write'])))).toBe(
      'forbidden',
    );
  });

  it('is described: the scope, the limit, the key that never changes and what a deletion takes', () => {
    const doc = buildOpenApiDocument('https://app.example.com/api/v1');
    const paths = doc.paths as unknown as Record<
      string,
      Record<string, { operationId: string; description: string; parameters?: { $ref?: string }[] }>
    >;
    expect(paths['/contact-fields']?.post?.operationId).toBe('createContactField');
    expect(paths['/contact-fields']?.post?.description).toContain('`contact_fields.manage`');
    expect(paths['/contact-fields']?.post?.description).toContain('at most 50 fields');
    expect(paths['/contact-fields']?.get?.description).toContain(
      '`contacts.read` or `contact_fields.manage`',
    );
    expect(paths['/contact-fields/{key}']?.patch?.operationId).toBe('updateContactField');
    expect(paths['/contact-fields/{key}']?.patch?.description).toContain(
      "Changes the label, a choice field's options, or both",
    );
    expect(paths['/contact-fields/{key}']?.patch?.description).toContain('refused with 409');
    expect(paths['/contact-fields/{key}']?.delete?.operationId).toBe('deleteContactField');
    expect(paths['/contact-fields/{key}']?.delete?.description).toContain(
      "Every contact's value for the field is deleted with it",
    );
    const parameters = (
      doc.components as unknown as {
        parameters: Record<string, { schema: { pattern: string } }>;
      }
    ).parameters;
    expect(parameters.FieldKey?.schema.pattern).toBe('^[a-z][a-z0-9_]{0,39}$');
    const schemas = doc.components.schemas as Record<string, { required?: string[] }>;
    expect(schemas.ContactFieldCreate?.required).toEqual(['label', 'type']);
    // Either the label or the options, or both (ADR-407).
    expect(schemas.ContactFieldUpdate?.required).toBeUndefined();
    expect(schemas.ContactFieldUpdate).toMatchObject({ minProperties: 1 });
    const field = doc.components.schemas as Record<
      string,
      { properties?: Record<string, { enum?: string[] }>; required?: string[] }
    >;
    expect(field.ContactField?.properties?.type?.enum).toContain('choice');
    expect(field.ContactField?.properties).toHaveProperty('options');
    expect(field.ContactField?.required).toContain('options');
    expect(field.ContactFieldCreate?.properties).toHaveProperty('options');
    expect(field.ContactFieldUpdate?.properties).toHaveProperty('options');
  });
});
