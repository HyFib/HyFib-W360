import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAppError, Keyring, sha256Hex, systemClock, uuidv7 } from '@w360/core';
import {
  apiContactChanges,
  apiCreateContact,
  apiCreateContactField,
  apiDeleteContactField,
  apiListContactFields,
  apiUpdateContactField,
  authenticateApiToken,
  createApiKeysService,
  createContactsService,
  type ApiContext,
  type ApiScope,
  type TenantContext,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Defining contact fields through the public API (ADR-115) against real PostgreSQL: fields added
 * with a key made from the label or given, once per Idempotency-Key; renamed, leaving the key, the
 * type and the values; deleted with their values, each contact that had one recorded as changed;
 * every change audited as the key or the member; the 50-field limit kept when additions run at once,
 * whoever makes them; and keys without the scope, or of another company, refused.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx?.close();
});

const deps = () => ({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
const contactsService = () => createContactsService({ db: fx.dbs.app, clock: systemClock });

/** A key of the company created by its owner, and the context a request with it gets. */
async function apiKey(c: Company, scopes: ApiScope[]): Promise<ApiContext> {
  const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
  const created = await keys.create(await fx.ctx(c, c.owner), {
    name: 'Field definitions',
    scopes,
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

/** The code of a refusal and the paths it names. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, paths: (error.issues ?? []).map((i) => i.path) };
  }
  throw new Error('expected a refusal');
}

const fieldsOf = async (c: Company) =>
  (
    await fx.query<{ key: string; label: string; type: string }>(
      'SELECT key, label, type FROM app.contact_fields WHERE tenant_id = $1 ORDER BY key',
      [c.tenant.id],
    )
  ).map((f) => [f.key, f.label, f.type]);

const audits = (c: Company, action: string) =>
  fx.query<{ actor_type: string; actor_id: string; metadata: Record<string, unknown> }>(
    `SELECT actor_type, actor_id, metadata FROM app.audit_events
      WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
    [c.tenant.id, action],
  );

const attributesOf = async (contactId: string) =>
  (
    await fx.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM app.contacts WHERE id = $1',
      [contactId],
    )
  )[0]!.attributes;

let phoneSeq = 0;
const nextPhone = () => `+9198112${String(30000 + (phoneSeq += 1)).padStart(5, '0')}`;

/** A contact added through the API with these custom field values. */
async function contactWith(c: Company, fields: Record<string, unknown>): Promise<string> {
  const writer = await apiKey(c, ['contacts.write']);
  const created = await apiCreateContact(
    deps(),
    writer,
    { phone: nextPhone(), name: 'Field test', fields },
    null,
  );
  return (created.body.data as { id: string }).id;
}

describe('defining contact fields through the public API (ADR-115)', () => {
  it('adds fields keyed from the label or as given, once per Idempotency-Key, audited as the key', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['contact_fields.manage']);
    const city = await apiCreateContactField(
      deps(),
      ctx,
      { label: 'Delivery City', type: 'text' },
      null,
    );
    expect(city.status).toBe(201);
    expect(city.replayed).toBe(false);
    expect(city.body.data).toEqual({
      key: 'delivery_city',
      label: 'Delivery City',
      type: 'text',
      options: null,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const orders = await apiCreateContactField(
      deps(),
      ctx,
      { label: 'Orders', type: 'number', key: 'order_count' },
      null,
    );
    expect(orders.body.data).toMatchObject({ key: 'order_count', type: 'number' });

    // A key the company has is refused, naming it, whatever the label or type.
    expect(
      await refusal(
        apiCreateContactField(deps(), ctx, { label: 'Delivery city', type: 'date' }, null),
      ),
    ).toEqual({ code: 'conflict', paths: ['key'] });

    // A retry with the same Idempotency-Key answers with the first response and adds nothing.
    const idempotency = { key: 'add-tier', requestHash: sha256Hex('POST /contact-fields Tier') };
    const first = await apiCreateContactField(
      deps(),
      ctx,
      { label: 'Tier', type: 'text' },
      idempotency,
    );
    const again = await apiCreateContactField(
      deps(),
      ctx,
      { label: 'Tier', type: 'text' },
      idempotency,
    );
    expect(again).toEqual({ ...first, replayed: true });
    expect(await fieldsOf(c)).toEqual([
      ['delivery_city', 'Delivery City', 'text'],
      ['order_count', 'Orders', 'number'],
      ['tier', 'Tier', 'text'],
    ]);
    expect(await audits(c, 'contact_field.created')).toEqual(
      [
        { key: 'delivery_city', type: 'text' },
        { key: 'order_count', type: 'number' },
        { key: 'tier', type: 'text' },
      ].map((metadata) => ({ actor_type: 'api_key', actor_id: ctx.key.id, metadata })),
    );

    // The new field takes values at once.
    const contactId = await contactWith(c, { delivery_city: 'Pune', order_count: 3 });
    expect(await attributesOf(contactId)).toEqual({ delivery_city: 'Pune', order_count: 3 });
  });

  it('renames a field, leaving its key, type and values; only a real rename is audited, a member’s too', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const city = await contactsService().createField(owner, {
      label: 'City',
      key: 'city',
      type: 'text',
    });
    const contactId = await contactWith(c, { city: 'Chennai' });
    const ctx = await apiKey(c, ['contact_fields.manage']);

    expect(await apiUpdateContactField(deps(), ctx, 'city', { label: '  Town ' })).toEqual({
      key: 'city',
      label: 'Town',
      type: 'text',
      options: null,
      createdAt: expect.any(String),
    });
    expect(await attributesOf(contactId)).toEqual({ city: 'Chennai' });
    // The same label again changes nothing and leaves no trace.
    expect(await apiUpdateContactField(deps(), ctx, 'city', { label: 'Town' })).toMatchObject({
      label: 'Town',
    });
    for (const key of ['region', 'City']) {
      expect(
        await refusal(apiUpdateContactField(deps(), ctx, key, { label: 'Region' })),
      ).toMatchObject({ code: 'not_found' });
    }
    // Members' renames are audited now too.
    await contactsService().renameField(owner, city.id, 'City');
    await contactsService().renameField(owner, city.id, 'City');
    expect(await fieldsOf(c)).toEqual([['city', 'City', 'text']]);
    expect(await audits(c, 'contact_field.renamed')).toEqual([
      { actor_type: 'api_key', actor_id: ctx.key.id, metadata: { key: 'city' } },
      { actor_type: 'user', actor_id: c.owner.id, metadata: { key: 'city' } },
    ]);
  });

  it('deletes a field with its values on every contact, and the feed reads each contact that had one', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    await service.createField(owner, { label: 'City', key: 'city', type: 'text' });
    await service.createField(owner, { label: 'VIP', key: 'vip', type: 'boolean' });
    const withCity = await contactWith(c, { city: 'Pune', vip: true });
    const withoutCity = await contactWith(c, { vip: true });
    const reader = await apiKey(c, ['contacts.read']);
    const keyring = new Keyring({ primaryKeyId: 'k1', keys: { k1: Buffer.alloc(32, 7) } });
    const before = await apiContactChanges({ db: fx.dbs.app, keyring }, reader, {});
    expect(before.data.map((d) => d.id)).toEqual([withCity, withoutCity]);

    const ctx = await apiKey(c, ['contact_fields.manage']);
    expect(await apiDeleteContactField(deps(), ctx, 'city')).toEqual({
      key: 'city',
      deleted: true,
    });
    expect(await attributesOf(withCity)).toEqual({ vip: true });
    expect(await attributesOf(withoutCity)).toEqual({ vip: true });
    expect(await fieldsOf(c)).toEqual([['vip', 'VIP', 'boolean']]);
    const after = await apiContactChanges({ db: fx.dbs.app, keyring }, reader, {
      cursor: before.nextCursor,
    });
    expect(after.data.map((d) => [d.id, d.contact?.fields])).toEqual([[withCity, { vip: true }]]);

    expect(await refusal(apiDeleteContactField(deps(), ctx, 'city'))).toMatchObject({
      code: 'not_found',
    });
    expect(await audits(c, 'contact_field.deleted')).toEqual([
      { actor_type: 'api_key', actor_id: ctx.key.id, metadata: { key: 'city' } },
    ]);
  });

  /**
   * Adds a field (`key`) in a transaction of its own under the company's field lock, as an addition
   * in progress, until `work` waits for it; then commits. Returns how `work` ended.
   */
  async function whileAnotherAdds(c: Company, key: string, work: () => Promise<unknown>) {
    const holder: pg.PoolClient = await fx.dbs.adminPool.connect();
    let outcome: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `contact-fields:${c.tenant.id}`,
      ]);
      await holder.query(
        `INSERT INTO app.contact_fields (id, tenant_id, key, label, type)
         VALUES ($1, $2, $3, $3, 'text')`,
        [uuidv7(), c.tenant.id, key],
      );
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      outcome = work().then(
        () => 'done',
        (error: unknown) => (isAppError(error) ? error.code : error),
      );
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the addition is not waiting');
        },
        { timeout: 4_000, interval: 20 },
      );
      await holder.query('COMMIT');
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    } finally {
      holder.release();
    }
    return outcome;
  }

  it('keeps the 50-field limit when members and keys add fields at once', async () => {
    const c = await fx.company();
    const owner: TenantContext = await fx.ctx(c, c.owner);
    const ctx = await apiKey(c, ['contact_fields.manage']);
    await fx.query(
      `INSERT INTO app.contact_fields (id, tenant_id, key, label, type)
       SELECT gen_random_uuid(), $1, 'f' || g, 'Field ' || g, 'text' FROM generate_series(1, 48) g`,
      [c.tenant.id],
    );
    // A member's addition waits for the 49th, then adds the 50th.
    expect(
      await whileAnotherAdds(c, 'f49', () =>
        contactsService().createField(owner, { label: 'Fiftieth', type: 'text' }),
      ),
    ).toBe('done');
    expect(await fieldsOf(c)).toHaveLength(50);
    expect(
      await refusal(apiCreateContactField(deps(), ctx, { label: 'Extra', type: 'text' }, null)),
    ).toMatchObject({ code: 'validation_failed' });

    // With one deleted, a key's addition waits for another one's, then counts it and is refused.
    await apiDeleteContactField(deps(), ctx, 'fiftieth');
    expect(
      await whileAnotherAdds(c, 'f50', () =>
        apiCreateContactField(deps(), ctx, { label: 'Extra', type: 'text' }, null),
      ),
    ).toBe('validation_failed');
    expect(await fieldsOf(c)).toHaveLength(50);
  });

  it('refuses keys without the scope and another company’s fields; both scopes list the fields', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const owner = await fx.ctx(other, other.owner);
    await contactsService().createField(owner, { label: 'City', key: 'city', type: 'text' });
    const reader = await apiKey(c, ['contacts.read', 'contacts.write']);
    expect(
      await refusal(apiCreateContactField(deps(), reader, { label: 'City', type: 'text' }, null)),
    ).toMatchObject({ code: 'forbidden' });
    expect(await apiListContactFields(deps(), reader)).toEqual([]);

    const definer = await apiKey(c, ['contact_fields.manage']);
    expect(await apiListContactFields(deps(), definer)).toEqual([]);
    expect(
      await refusal(apiUpdateContactField(deps(), definer, 'city', { label: 'Town' })),
    ).toMatchObject({ code: 'not_found' });
    expect(await refusal(apiDeleteContactField(deps(), definer, 'city'))).toMatchObject({
      code: 'not_found',
    });
    expect(await fieldsOf(other)).toEqual([['city', 'City', 'text']]);

    // Only members who manage the company's settings may grant the scope.
    const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
    const ownerOfC = await fx.ctx(c, c.owner);
    const narrower: TenantContext = {
      ...ownerOfC,
      permissions: new Set([...ownerOfC.permissions].filter((p) => p !== 'tenant.settings.manage')),
    };
    expect(
      await refusal(
        keys.create(narrower, {
          name: 'Fields',
          scopes: ['contact_fields.manage'],
          expiresInDays: 30,
        }),
      ),
    ).toMatchObject({ code: 'forbidden' });
  });
});
