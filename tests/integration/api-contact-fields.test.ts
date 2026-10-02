import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import { DEFAULT_EGRESS_POLICY, createEgressClient } from '@w360/core/egress';
import { authorizedTenantScope, contacts, eq, sql } from '@w360/db';
import {
  API_CONTACT_SEARCH_WINDOW,
  apiCreateContact,
  apiGetContact,
  apiListContactFields,
  apiListContacts,
  apiUpdateContact,
  authenticateApiToken,
  contactErasedPayloadSchema,
  contactUpdatedPayloadSchema,
  createApiKeysService,
  createContactsService,
  createWebhooksService,
  processWebhookDeliveries,
  type ApiContext,
  type ApiScope,
} from '@w360/domain';
import { failOnLog } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Contact custom fields and contact changes through the public API (ADR-112) against real
 * PostgreSQL and a local webhook receiver: the company's fields, values read typed and only for
 * the fields it defines, values set on a new contact and filled on an existing one, changes to the
 * name, email, fields and tags with every refusal saving nothing, the field rows locked against a
 * deletion at the same time, and `contact.updated` for every change of a field's value, whoever
 * makes it, but not for a field renamed or deleted. Also the contact list's filters by email, tag
 * and custom field value, read in windows (ADR-113).
 */
let fx: WhatsAppFixture;
let receiver: Server;
let port = 0;
const received: { path: string; body: string }[] = [];

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  receiver = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body });
      res.writeHead(204);
      res.end();
    });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  port = (receiver.address() as AddressInfo).port;
});

afterAll(async () => {
  receiver?.closeAllConnections();
  receiver?.close();
  await fx?.close();
});

const deps = () => ({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
const contactsService = () => createContactsService({ db: fx.dbs.app, clock: systemClock });

/** A key of the company created by its owner, and the context a request with it gets. */
async function apiKey(c: Company, scopes: ApiScope[]): Promise<{ token: string; ctx: ApiContext }> {
  const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
  const created = await keys.create(await fx.ctx(c, c.owner), {
    name: 'Contact fields',
    scopes,
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return { token: created.token, ctx };
}

/** The code of a refusal and the paths it names. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, paths: (error.issues ?? []).map((i) => i.path), error };
  }
  throw new Error('expected a refusal');
}

/** The company's four kinds of fields, by key. */
async function defineFields(c: Company) {
  const owner = await fx.ctx(c, c.owner);
  const service = contactsService();
  return {
    city: await service.createField(owner, { label: 'City', key: 'city', type: 'text' }),
    orders: await service.createField(owner, { label: 'Orders', key: 'orders', type: 'number' }),
    birthday: await service.createField(owner, {
      label: 'Birthday',
      key: 'birthday',
      type: 'date',
    }),
    vip: await service.createField(owner, { label: 'VIP', key: 'vip', type: 'boolean' }),
  };
}

const attributesOf = async (contactId: string) =>
  (
    await fx.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM app.contacts WHERE id = $1',
      [contactId],
    )
  )[0]!.attributes;

const updateAudits = (contactId: string) =>
  fx.query<{ actor_type: string; metadata: Record<string, unknown> }>(
    `SELECT actor_type, metadata FROM app.audit_events
      WHERE action = 'contact.updated' AND subject_id = $1 ORDER BY occurred_at, id`,
    [contactId],
  );

let phoneSeq = 0;
const nextPhone = () => `+9198111${String(20000 + (phoneSeq += 1)).padStart(5, '0')}`;

describe('contact custom fields through the public API (ADR-112)', () => {
  it('lists the company’s fields by label with their keys and types, for contacts.read only', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const fields = await defineFields(c);
    await contactsService().createField(await fx.ctx(other, other.owner), {
      label: 'Region',
      key: 'region',
      type: 'text',
    });
    const { ctx } = await apiKey(c, ['contacts.read']);
    const listed = await apiListContactFields(deps(), ctx);
    expect(listed.map((f) => [f.key, f.label, f.type])).toEqual([
      ['birthday', 'Birthday', 'date'],
      ['city', 'City', 'text'],
      ['orders', 'Orders', 'number'],
      ['vip', 'VIP', 'boolean'],
    ]);
    expect(listed.every((f) => !Number.isNaN(Date.parse(f.createdAt)))).toBe(true);
    // A rename changes the label, never the key.
    await contactsService().renameField(await fx.ctx(c, c.owner), fields.city.id, 'Town');
    expect((await apiListContactFields(deps(), ctx)).map((f) => [f.key, f.label])).toEqual([
      ['birthday', 'Birthday'],
      ['orders', 'Orders'],
      ['city', 'Town'],
      ['vip', 'VIP'],
    ]);
    const { ctx: writer } = await apiKey(c, ['contacts.write']);
    expect((await refusal(apiListContactFields(deps(), writer))).code).toBe('forbidden');
  });

  it('reads the values of the company’s fields in every contact, typed, and of no other key', async () => {
    const c = await fx.company();
    await defineFields(c);
    const owner = await fx.ctx(c, c.owner);
    const { id } = await contactsService().createContact(owner, {
      displayName: 'Meera',
      phone: nextPhone(),
      attributes: { city: 'Pune', orders: '3', birthday: '1990-04-01', vip: 'yes' },
    });
    const { ctx } = await apiKey(c, ['contacts.read']);
    const typed = { city: 'Pune', orders: 3, birthday: '1990-04-01', vip: true };
    expect((await apiGetContact(deps(), ctx, id)).fields).toEqual(typed);
    expect((await apiListContacts(deps(), ctx, {})).data.find((r) => r.id === id)?.fields).toEqual(
      typed,
    );
    // A value written for a field deleted at the same moment, by a writer that checked the field
    // before its deletion, is kept in the row but never read.
    await fx.query(
      `UPDATE app.contacts SET attributes = attributes || '{"gone": "x"}' WHERE id = $1`,
      [id],
    );
    expect((await apiGetContact(deps(), ctx, id)).fields).toEqual(typed);
    const { id: bare } = await contactsService().createContact(owner, { phone: nextPhone() });
    expect((await apiGetContact(deps(), ctx, bare)).fields).toEqual({});
  });

  it('sets fields on a contact it creates, and fills only those an existing contact has no value for', async () => {
    const c = await fx.company();
    await defineFields(c);
    const { ctx } = await apiKey(c, ['contacts.read', 'contacts.write']);
    const phone = nextPhone();
    const created = await apiCreateContact(
      deps(),
      ctx,
      { phone, name: 'Asha', fields: { city: 'Pune', orders: 2, vip: false } },
      null,
    );
    expect(created.status).toBe(201);
    const id = (created.body.data as { id: string }).id;
    expect((created.body.data as { fields: unknown }).fields).toEqual({
      city: 'Pune',
      orders: 2,
      vip: false,
    });
    const again = await apiCreateContact(
      deps(),
      ctx,
      { phone, fields: { city: 'Delhi', birthday: '1991-01-01', orders: 7 } },
      null,
    );
    expect(again.status).toBe(200);
    expect((again.body.data as { fields: unknown }).fields).toEqual({
      city: 'Pune',
      orders: 2,
      vip: false,
      birthday: '1991-01-01',
    });
    // An empty string gives no value.
    const blank = await apiCreateContact(
      deps(),
      ctx,
      { phone: nextPhone(), fields: { city: '' } },
      null,
    );
    expect((blank.body.data as { fields: unknown }).fields).toEqual({});

    // Refusals name the field and create nothing.
    const fresh = nextPhone();
    for (const [fields, path] of [
      [{ nope: 'x' }, 'fields.nope'],
      [{ orders: '2' }, 'fields.orders'],
      [{ birthday: '1991-02-30' }, 'fields.birthday'],
      [{ vip: 'no' }, 'fields.vip'],
    ] as const) {
      const r = await refusal(apiCreateContact(deps(), ctx, { phone: fresh, fields }, null));
      expect([r.code, r.paths]).toEqual(['validation_failed', [path]]);
    }
    expect((await apiListContacts(deps(), ctx, { phone: fresh })).data).toEqual([]);
    expect(await attributesOf(id)).toEqual({
      city: 'Pune',
      orders: 2,
      vip: false,
      birthday: '1991-01-01',
    });
  });

  it('adds tags to an existing contact up to the 50 members keep, and no more', async () => {
    const c = await fx.company();
    const { ctx } = await apiKey(c, ['contacts.write']);
    const phone = nextPhone();
    const { id } = await contactsService().createContact(await fx.ctx(c, c.owner), { phone });
    await fx.query(
      `INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag)
       SELECT gen_random_uuid(), $1, $2, 'tag-' || n FROM generate_series(1, 49) AS n`,
      [c.tenant.id, id],
    );
    const tooMany = await refusal(
      apiCreateContact(deps(), ctx, { phone, tags: ['one', 'two'] }, null),
    );
    expect([tooMany.code, tooMany.paths]).toEqual(['validation_failed', ['tags']]);
    expect(tooMany.error.publicMessage).toBe('A contact can have at most 50 tags.');
    // Tags it already has do not count twice.
    const fiftieth = await apiCreateContact(deps(), ctx, { phone, tags: ['one', 'tag-1'] }, null);
    expect((fiftieth.body.data as { tags: string[] }).tags).toHaveLength(50);
  });

  it('changes the name, email, fields and tags, clears what it is given empty, and saves nothing when nothing differs', async () => {
    const c = await fx.company();
    await defineFields(c);
    const { ctx } = await apiKey(c, ['contacts.read', 'contacts.write']);
    const created = await apiCreateContact(
      deps(),
      ctx,
      {
        phone: nextPhone(),
        name: 'Asha',
        email: 'asha@example.test',
        tags: ['new'],
        fields: { city: 'Pune', orders: 2 },
      },
      null,
    );
    const id = (created.body.data as { id: string }).id;
    const changed = await apiUpdateContact(deps(), ctx, id, {
      name: '  Asha Rao ',
      email: 'asha.rao@example.test',
      fields: { orders: 5, city: null, vip: true },
      // A tag given twice is added once.
      addTags: ['VIP', 'vip'],
      removeTags: ['new'],
    });
    expect(changed).toMatchObject({
      id,
      name: 'Asha Rao',
      email: 'asha.rao@example.test',
      tags: ['vip'],
      fields: { orders: 5, vip: true },
    });
    expect(await apiGetContact(deps(), ctx, id)).toEqual(changed);
    expect(await updateAudits(id)).toEqual([
      {
        actor_type: 'api_key',
        metadata: {
          changed: ['name', 'email', 'fields', 'tags'],
          fields: ['orders', 'city', 'vip'],
          tagsAdded: 1,
          tagsRemoved: 1,
          source: 'api',
        },
      },
    ]);

    // The same change again, values it already has, and a value it has not, cleared: nothing.
    await apiUpdateContact(deps(), ctx, id, {
      name: 'Asha Rao',
      email: 'asha.rao@example.test',
      fields: { orders: 5, city: null, vip: true, birthday: '' },
      addTags: ['vip'],
      removeTags: ['new'],
    });
    expect(await updateAudits(id)).toHaveLength(1);

    // Empty clears.
    const cleared = await apiUpdateContact(deps(), ctx, id, { name: '', email: null });
    expect([cleared.name, cleared.email]).toEqual([null, null]);
    expect((await updateAudits(id)).at(-1)?.metadata).toEqual({
      changed: ['name', 'email'],
      fields: [],
      tagsAdded: 0,
      tagsRemoved: 0,
      source: 'api',
    });
  });

  it('refuses unknown fields, other types, bad values and too many tags, saving nothing', async () => {
    const c = await fx.company();
    await defineFields(c);
    const { ctx } = await apiKey(c, ['contacts.read', 'contacts.write']);
    const created = await apiCreateContact(
      deps(),
      ctx,
      { phone: nextPhone(), name: 'Bina', fields: { city: 'Pune' } },
      null,
    );
    const id = (created.body.data as { id: string }).id;
    const before = await apiGetContact(deps(), ctx, id);
    for (const [body, path, message] of [
      [
        { fields: { nope: 'x' } },
        'fields.nope',
        'The company has no custom field with the key nope (GET /contact-fields).',
      ],
      [{ name: 'New', fields: { orders: '5' } }, 'fields.orders', 'Orders takes a number.'],
      [
        { fields: { orders: 1e21 } },
        'fields.orders',
        'Orders takes a number with at most 15 digits before the point and 6 after.',
      ],
      [
        { fields: { birthday: '2026-02-30' } },
        'fields.birthday',
        'Birthday must be a date written as YYYY-MM-DD.',
      ],
      [{ fields: { vip: 'yes' } }, 'fields.vip', 'VIP takes true or false.'],
      [{ fields: { city: 'x'.repeat(501) } }, 'fields.city', 'City is longer than 500 characters.'],
      [{ email: 'not an address' }, 'email', 'Email address is not valid.'],
      [
        { addTags: ['vip'], removeTags: ['VIP'] },
        'removeTags',
        'The tag vip cannot be both added and removed.',
      ],
      [{ addTags: ['a,b'] }, 'addTags', 'Tags cannot contain commas or control characters.'],
    ] as const) {
      const r = await refusal(apiUpdateContact(deps(), ctx, id, body));
      expect([r.code, r.paths, r.error.publicMessage]).toEqual([
        'validation_failed',
        [path],
        message,
      ]);
    }
    expect(await apiGetContact(deps(), ctx, id)).toEqual(before);
    expect(await updateAudits(id)).toEqual([]);

    // 50 tags at most: adding one more is refused, swapping one is not.
    await fx.query(
      `INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag)
       SELECT gen_random_uuid(), $1, $2, 'tag-' || n FROM generate_series(1, 50) AS n`,
      [c.tenant.id, id],
    );
    const tooMany = await refusal(apiUpdateContact(deps(), ctx, id, { addTags: ['one-more'] }));
    expect([tooMany.code, tooMany.paths]).toEqual(['validation_failed', ['addTags']]);
    const swapped = await apiUpdateContact(deps(), ctx, id, {
      addTags: ['one-more'],
      removeTags: ['tag-1'],
    });
    expect(swapped.tags).toHaveLength(50);
    expect(swapped.tags).toContain('one-more');
  });

  it('finds only the company’s live contacts, with the write scope, while the company is active', async () => {
    const c = await fx.company();
    const other = await fx.company();
    const { ctx } = await apiKey(c, ['contacts.read', 'contacts.write']);
    const { id: theirs } = await contactsService().createContact(await fx.ctx(other, other.owner), {
      phone: nextPhone(),
    });
    const owner = await fx.ctx(c, c.owner);
    const { id: erased } = await contactsService().createContact(owner, { phone: nextPhone() });
    await contactsService().eraseContact(owner, { contactId: erased, suppress: false });
    for (const contactId of [theirs, erased, uuidv7()]) {
      expect((await refusal(apiUpdateContact(deps(), ctx, contactId, { name: 'X' }))).code).toBe(
        'not_found',
      );
    }
    const { id } = await contactsService().createContact(owner, { phone: nextPhone() });
    // Another company's field is no field of this one.
    await defineFields(other);
    const unknown = await refusal(apiUpdateContact(deps(), ctx, id, { fields: { city: 'Pune' } }));
    expect([unknown.code, unknown.paths]).toEqual(['validation_failed', ['fields.city']]);
    expect((await apiListContactFields(deps(), ctx)).map((f) => f.key)).toEqual([]);
    const { ctx: reader } = await apiKey(c, ['contacts.read']);
    expect((await refusal(apiUpdateContact(deps(), reader, id, { name: 'X' }))).code).toBe(
      'forbidden',
    );
    const { token } = await apiKey(c, ['contacts.write']);
    await fx.query(`UPDATE app.tenants SET status = 'suspended' WHERE id = $1`, [c.tenant.id]);
    try {
      const suspended = await authenticateApiToken(fx.dbs.app, token, 'r');
      expect((await refusal(apiUpdateContact(deps(), suspended!, id, { name: 'X' }))).code).toBe(
        'tenant_suspended',
      );
    } finally {
      await fx.query(`UPDATE app.tenants SET status = 'active' WHERE id = $1`, [c.tenant.id]);
    }
    expect(
      (
        await fx.query<{ name: string | null }>(
          'SELECT display_name AS name FROM app.contacts WHERE id = $1',
          [id],
        )
      )[0]!.name,
    ).toBeNull();
  });

  it('waits for a field being deleted, then refuses it, so no value of a deleted field is kept', async () => {
    const c = await fx.company();
    const fields = await defineFields(c);
    const { ctx } = await apiKey(c, ['contacts.write']);
    const owner = await fx.ctx(c, c.owner);
    const { id } = await contactsService().createContact(owner, {
      phone: nextPhone(),
      attributes: { city: 'Chennai' },
    });
    const holder = await fx.dbs.adminPool.connect();
    let outcome: Promise<unknown> | undefined;
    try {
      // A deletion of the field in the contacts service's order: the field's row, then the values.
      await holder.query('BEGIN');
      await holder.query('DELETE FROM app.contact_fields WHERE id = $1', [fields.city.id]);
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      outcome = apiUpdateContact(deps(), ctx, id, { fields: { city: 'Pune', orders: 1 } }).then(
        () => 'changed',
        (error: unknown) => (isAppError(error) ? error.issues?.[0]?.path : error),
      );
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the request is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
      // The request waits on the field without holding the contact, so the deletion goes on.
      await holder.query(
        `UPDATE app.contacts SET attributes = attributes - 'city'
          WHERE tenant_id = $1 AND attributes ? 'city'`,
        [c.tenant.id],
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    // Without the lock the request would have written the value after the deletion removed the
    // values, and a field made later with the same key would show it; locking the contact first
    // would deadlock with the deletion.
    expect(await outcome).toBe('fields.city');
    expect(await attributesOf(id)).toEqual({});
  });
});

describe('contact.updated for custom field values (ADR-112)', () => {
  const HOST = 'hooks.receiver.test';
  const webhooks = () =>
    createWebhooksService({
      db: fx.dbs.app,
      clock: systemClock,
      keyring: fx.keyring,
      egressPolicy: { allowLoopbackForTests: true },
    });

  async function deliverDue(c: Company) {
    const jobs = fx.jobs();
    await processWebhookDeliveries(
      {
        db: fx.dbs.app,
        clock: systemClock,
        keyring: fx.keyring,
        egress: createEgressClient(
          { ...DEFAULT_EGRESS_POLICY, allowLoopbackForTests: true, timeoutMs: 2_000 },
          { resolve: async () => [{ address: '127.0.0.1', family: 4 }] },
        ),
        timeoutMs: 2_000,
        jobs,
        signer: fx.signer,
        notices: {
          outbox: { keyring: fx.keyring, jobs, signer: fx.signer },
          appBaseUrl: 'https://app.w360.test',
        },
        logger: failOnLog,
      },
      authorizedTenantScope(c.tenant.id, null),
    );
  }

  const contactEvents = (c: Company) =>
    fx.query<{ type: string }>(
      `SELECT type FROM app.webhook_events WHERE tenant_id = $1 AND type LIKE 'contact.%'
        ORDER BY created_at, id`,
      [c.tenant.id],
    );

  it('captures one per transaction for a change of a field’s value, whoever makes it, and none for a field renamed or deleted', async () => {
    const c = await fx.company();
    const fields = await defineFields(c);
    const owner = await fx.ctx(c, c.owner);
    const path = `/ok/${randomBytes(6).toString('hex')}`;
    await webhooks().create(owner, {
      url: `http://${HOST}:${port}${path}`,
      eventTypes: ['contact.updated', 'contact.erased'],
    });
    const { ctx } = await apiKey(c, ['contacts.read', 'contacts.write']);
    const service = contactsService();
    const { id } = await service.createContact(owner, {
      displayName: 'Chitra',
      phone: nextPhone(),
    });
    const updates = async () =>
      (await contactEvents(c)).filter((e) => e.type === 'contact.updated').length;
    const counts: number[] = [];
    const step = async (change: () => Promise<unknown>) => {
      await change();
      counts.push(await updates());
    };

    // Through the API: a value, a value with the name in one transaction, and nothing new.
    await step(() => apiUpdateContact(deps(), ctx, id, { fields: { city: 'Pune' } }));
    await step(() =>
      apiUpdateContact(deps(), ctx, id, { name: 'Chitra S', fields: { orders: 1 } }),
    );
    await step(() => apiUpdateContact(deps(), ctx, id, { fields: { orders: 1 } }));
    // A member's save and an automation's or a Flow's write (the runtime role's update of the
    // values), then the same value again.
    await step(() =>
      service.updateContact(owner, id, { displayName: 'Chitra S', attributes: { vip: 'yes' } }),
    );
    const write = (attributes: ReturnType<typeof sql>) =>
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, null), (tx) =>
        tx.update(contacts).set({ attributes }).where(eq(contacts.id, id)),
      );
    await step(() => write(sql`${contacts.attributes} || jsonb_build_object('orders', 9)`));
    await step(() => write(sql`${contacts.attributes} || jsonb_build_object('orders', 9)`));
    // A key no field has changes no value of the contact's fields.
    await step(() => write(sql`${contacts.attributes} || '{"gone": "x"}'::jsonb`));
    // A rename changes no value; a deletion removes the field for every contact at once.
    await step(() => service.renameField(owner, fields.city.id, 'Town'));
    await step(() => service.deleteField(owner, fields.city.id));
    expect(counts).toEqual([1, 2, 2, 3, 4, 4, 4, 4, 4]);
    expect(await attributesOf(id)).toEqual({ orders: 9, vip: true, gone: 'x' });

    await deliverDue(c);
    const bodies = received
      .filter((r) => r.path === path)
      .map((r) => JSON.parse(r.body) as { type: string; data: { contact: unknown } });
    expect(bodies).toHaveLength(4);
    for (const body of bodies) {
      expect(contactUpdatedPayloadSchema.safeParse(body).success).toBe(true);
      // Built when delivered, with the fields the company has then.
      expect(body.data.contact).toMatchObject({
        id,
        name: 'Chitra S',
        fields: { orders: 9, vip: true },
        erased: false,
      });
    }

    // Erasure sends only contact.erased, without values.
    await service.eraseContact(owner, { contactId: id, suppress: false });
    expect((await contactEvents(c)).map((e) => e.type).slice(-1)).toEqual(['contact.erased']);
    expect(await updates()).toBe(4);
    await deliverDue(c);
    const erased = received
      .filter((r) => r.path === path)
      .map((r) => JSON.parse(r.body) as { type: string; data: { contact: unknown } })
      .filter((b) => b.type === 'contact.erased');
    expect(erased).toHaveLength(1);
    expect(contactErasedPayloadSchema.safeParse(erased[0]).success).toBe(true);
    expect(erased[0]!.data.contact).toMatchObject({ id, erased: true });
    expect((erased[0]!.data.contact as { fields: unknown }).fields).toEqual({});
  });
});

describe('finding contacts (ADR-113)', () => {
  const names = (page: { data: { name: string | null }[] }) => page.data.map((c) => c.name);

  it('finds contacts by email, tag and typed custom field values, all of which they must match', async () => {
    const c = await fx.company();
    await defineFields(c);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const asha = await service.createContact(owner, {
      displayName: 'Asha',
      phone: nextPhone(),
      email: 'Asha@Example.test',
      attributes: { city: 'Pune', orders: '3', birthday: '1990-04-01', vip: 'yes' },
    });
    await service.addTags(owner, asha.id, ['vip']);
    const bina = await service.createContact(owner, {
      displayName: 'Bina',
      phone: nextPhone(),
      email: 'bina@example.test',
      attributes: { city: 'pune', orders: '3.5', vip: 'no' },
    });
    await service.addTags(owner, bina.id, ['vip', 'new']);
    await service.createContact(owner, {
      displayName: 'Chitra',
      phone: nextPhone(),
      attributes: { city: 'Delhi', orders: '30' },
    });
    // Another company's contact has the same values, and an erased one had them.
    const other = await fx.company();
    await defineFields(other);
    const theirs = await contactsService().createContact(await fx.ctx(other, other.owner), {
      displayName: 'Theirs',
      phone: nextPhone(),
      email: 'asha@example.test',
      attributes: { city: 'Pune', orders: '3' },
    });
    await contactsService().addTags(await fx.ctx(other, other.owner), theirs.id, ['vip']);
    const gone = await service.createContact(owner, {
      displayName: 'Gone',
      phone: nextPhone(),
      attributes: { city: 'Pune' },
    });
    await service.eraseContact(owner, { contactId: gone.id, suppress: false });
    // A value of another type written behind the app is never compared as a number, and a number
    // written with a trailing zero is still equal to its value.
    const odd = await service.createContact(owner, { displayName: 'Odd', phone: nextPhone() });
    await fx.query(`UPDATE app.contacts SET attributes = '{"orders": "n/a"}' WHERE id = $1`, [
      odd.id,
    ]);
    const dee = await service.createContact(owner, { displayName: 'Dee', phone: nextPhone() });
    await fx.query(`UPDATE app.contacts SET attributes = '{"orders": 3.50}' WHERE id = $1`, [
      dee.id,
    ]);

    const { ctx } = await apiKey(c, ['contacts.read']);
    const find = async (query: Record<string, string>) =>
      names(await apiListContacts(deps(), ctx, query));
    expect(await find({ email: 'asha@EXAMPLE.test' })).toEqual(['Asha']);
    expect(await find({ tag: ' VIP ' })).toEqual(['Bina', 'Asha']);
    expect(await find({ 'fields[city]': 'PUNE' })).toEqual(['Bina', 'Asha']);
    expect(await find({ 'fields[orders]': '3' })).toEqual(['Asha']);
    expect(await find({ 'fields[orders]': '3.0' })).toEqual(['Asha']);
    expect(await find({ 'fields[orders]': '3.5' })).toEqual(['Dee', 'Bina']);
    expect(await find({ 'fields[orders]': '30' })).toEqual(['Chitra']);
    expect(await find({ 'fields[birthday]': '1990-04-01' })).toEqual(['Asha']);
    expect(await find({ 'fields[vip]': 'true' })).toEqual(['Asha']);
    expect(await find({ 'fields[vip]': 'false' })).toEqual(['Bina']);
    expect(
      await find({ tag: 'vip', 'fields[city]': 'pune', 'fields[vip]': 'false', limit: '5' }),
    ).toEqual(['Bina']);
    expect(await find({ tag: 'new', email: 'asha@example.test' })).toEqual([]);
    expect(await find({ 'fields[city]': 'Mumbai' })).toEqual([]);
    // A short list has no next page, and the list without filters leaves the erased contact out.
    expect((await apiListContacts(deps(), ctx, { tag: 'vip' })).nextCursor).toBeNull();
    expect((await apiListContacts(deps(), ctx, {})).data.map((r) => r.id)).not.toContain(gone.id);
  });

  it('refuses unknown fields and values of another type, naming the field', async () => {
    const c = await fx.company();
    await defineFields(c);
    const other = await fx.company();
    await contactsService().createField(await fx.ctx(other, other.owner), {
      label: 'Region',
      key: 'region',
      type: 'text',
    });
    const { ctx } = await apiKey(c, ['contacts.read']);
    for (const [query, path, message] of [
      [
        { 'fields[nope]': 'x' },
        'fields.nope',
        'The company has no custom field with the key nope (GET /contact-fields).',
      ],
      [
        { 'fields[region]': 'North' },
        'fields.region',
        'The company has no custom field with the key region (GET /contact-fields).',
      ],
      [{ 'fields[orders]': 'three' }, 'fields.orders', 'Orders must be a number.'],
      [{ 'fields[vip]': 'yes' }, 'fields.vip', 'VIP takes true or false.'],
      [
        { 'fields[birthday]': '1990-02-30' },
        'fields.birthday',
        'Birthday must be a date written as YYYY-MM-DD.',
      ],
      [{ 'fields[city]': ' ' }, 'fields.city', 'Give a value of City to find.'],
      [{ email: 'not an address' }, 'email', 'Email address is not valid.'],
      [{ tag: 'a,b' }, 'tag', 'Tags cannot contain commas or control characters.'],
    ] as const) {
      const r = await refusal(apiListContacts(deps(), ctx, query));
      expect([r.code, r.paths, r.error.publicMessage]).toEqual([
        'validation_failed',
        [path],
        message,
      ]);
    }
    const { ctx: writer } = await apiKey(c, ['contacts.write']);
    expect((await refusal(apiListContacts(deps(), writer, { tag: 'vip' }))).code).toBe('forbidden');
  });

  it('reads a filtered list in windows, so pages can be short or empty but never skip or repeat a contact', async () => {
    const c = await fx.company();
    await defineFields(c);
    const total = API_CONTACT_SEARCH_WINDOW + 5;
    // Contact n was created n seconds ago: Pune for the two newest, the two on each side of the
    // first window's edge and the two oldest.
    await fx.query(
      `INSERT INTO app.contacts (id, tenant_id, display_name, attributes, source, created_at)
       SELECT gen_random_uuid(), $1, 'Bulk ' || n,
              CASE WHEN n IN (1, 2, $3, $3 + 1, $2 - 1, $2) THEN '{"city": "Pune"}'
                   ELSE '{"city": "Delhi"}' END::jsonb,
              'api', now() - make_interval(secs => n)
         FROM generate_series(1, $2::int) AS n`,
      [c.tenant.id, total, API_CONTACT_SEARCH_WINDOW],
    );
    const oldest = (
      await fx.query<{ id: string }>(
        `SELECT id FROM app.contacts WHERE tenant_id = $1 AND display_name = $2`,
        [c.tenant.id, `Bulk ${total}`],
      )
    )[0]!.id;
    await contactsService().addTags(await fx.ctx(c, c.owner), oldest, ['oldest']);
    const { ctx } = await apiKey(c, ['contacts.read']);
    const pages = async (query: Record<string, string>) => {
      const seen: (string | null)[][] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = await apiListContacts(deps(), ctx, cursor ? { ...query, cursor } : query);
        seen.push(names(page));
        if (!page.nextCursor) return seen;
        cursor = page.nextCursor;
      }
      throw new Error('the pages did not end');
    };
    const edge = API_CONTACT_SEARCH_WINDOW;
    const pune = ['Bulk 1', 'Bulk 2', `Bulk ${edge}`, `Bulk ${edge + 1}`, `Bulk ${total - 1}`];
    pune.push(`Bulk ${total}`);
    // The first window ends at its 2,000th contact; the next one goes on from just past it.
    expect(await pages({ 'fields[city]': 'Pune' })).toEqual([pune.slice(0, 3), pune.slice(3)]);
    // A limit of one splits windows too, never skipping or repeating.
    expect((await pages({ 'fields[city]': 'Pune', limit: '1' })).flat()).toEqual(pune);
    // A window can show nothing and still give the cursor past it.
    expect(await pages({ tag: 'oldest' })).toEqual([[], [`Bulk ${total}`]]);
    // Without a tag or field filter, a page is not windowed.
    const unfiltered = await apiListContacts(deps(), ctx, { limit: '3' });
    expect(names(unfiltered)).toEqual(['Bulk 1', 'Bulk 2', 'Bulk 3']);
  });
});
