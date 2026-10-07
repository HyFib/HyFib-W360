import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import { authorizedTenantScope, sql } from '@w360/db';
import {
  BULK_TAG_LIMIT,
  MAX_TAGS_PER_CONTACT,
  createConsentService,
  createContactsService,
  parseCsv,
  processSendIntent,
  queueTextMessage,
  type ContactsService,
  type ConsentService,
} from '@w360/domain';
import { acceptInvitation, createUser, invite } from './helpers';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Contacts, consent and erasure against real PostgreSQL: one contact per number across manual
 * entry, import and inbound WhatsApp; CSV import/export (including formula injection); consent
 * provenance and ordering; keyword opt-outs from webhooks; suppression; and erasure.
 */
let fx: WhatsAppFixture;
let contactsSvc: ContactsService;
let consentSvc: ConsentService;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  contactsSvc = createContactsService({ db: fx.dbs.app, clock: systemClock });
  consentSvc = createConsentService({ db: fx.dbs.app, clock: systemClock });
});

afterAll(async () => {
  await fx.close();
});

async function expectAppError(promise: Promise<unknown>, code: string, message?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe(code);
      if (message) expect(error.publicMessage).toMatch(message);
    }
    return;
  }
  throw new Error(`expected ${code}`);
}

async function consentState(tenantId: string, contactId: string) {
  const rows = await fx.query<{ purpose: string; status: string }>(
    'SELECT purpose, status FROM app.contact_consents WHERE tenant_id = $1 AND contact_id = $2 ORDER BY purpose',
    [tenantId, contactId],
  );
  return Object.fromEntries(rows.map((r) => [r.purpose, r.status]));
}

async function contactIdFor(tenantId: string, phone: string) {
  const [row] = await fx.query<{ id: string }>(
    'SELECT id FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2',
    [tenantId, phone],
  );
  return row?.id ?? null;
}

describe('contacts', () => {
  let c: Company;
  beforeAll(async () => {
    c = await fx.company();
  });

  it('creates one contact per number and reports the existing one on a duplicate', async () => {
    const ctx = await fx.ctx(c, c.agent);
    const { id } = await contactsSvc.createContact(ctx, {
      displayName: 'Asha Rao',
      phone: '+91 98765 11111',
      email: 'asha@example.test',
      tags: ['VIP', ' vip ', 'Pune'],
    });
    const detail = await contactsSvc.getContact(ctx, id);
    expect(detail.contact).toMatchObject({ phoneE164: '+919876511111', source: 'manual' });
    expect(detail.tags).toEqual(['pune', 'vip']);
    try {
      await contactsSvc.createContact(ctx, { phone: '0091 98765 11111' });
      throw new Error('expected conflict');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('conflict');
      expect(isAppError(error) && error.details).toEqual({ contactId: id });
    }
    await expectAppError(
      contactsSvc.createContact(ctx, { phone: '98765 11111' }),
      'validation_failed',
      /country code/,
    );
  });

  it('validates custom field values by type and removes values when a field is deleted', async () => {
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await expectAppError(
      contactsSvc.createField(agent, { label: 'Plan', type: 'text' }),
      'forbidden',
    );
    await contactsSvc.createField(owner, { label: 'Renewal date', type: 'date' });
    const { key } = await contactsSvc.createField(owner, { label: 'Seats', type: 'number' });
    expect(key).toBe('seats');
    const { id } = await contactsSvc.createContact(agent, {
      phone: '+919876522222',
      attributes: { renewal_date: '2027-02-28', seats: '12' },
    });
    await expectAppError(
      contactsSvc.updateContact(agent, id, { attributes: { renewal_date: '2027-02-30' } }),
      'validation_failed',
      /YYYY-MM-DD/,
    );
    await expectAppError(
      contactsSvc.updateContact(agent, id, { attributes: { unknown_key: 'x' } }),
      'validation_failed',
    );
    await contactsSvc.updateContact(agent, id, { attributes: { seats: '' } });
    let detail = await contactsSvc.getContact(agent, id);
    expect(detail.contact.attributes).toEqual({ renewal_date: '2027-02-28' });
    const field = detail.fields.find((f) => f.key === 'renewal_date')!;
    await contactsSvc.deleteField(owner, field.id);
    detail = await contactsSvc.getContact(agent, id);
    expect(detail.contact.attributes).toEqual({});
  });

  it('links inbound WhatsApp identities to the existing contact with that number', async () => {
    const ctx = await fx.ctx(c, c.agent);
    const { id } = await contactsSvc.createContact(ctx, {
      displayName: 'Imported Ravi',
      phone: '+919876533333',
    });
    // Two receipts for the same new sender processed concurrently still yield one contact.
    const [a, b] = await Promise.all([
      fx.deliver(fx.messagesBody(c, { messages: [{ waId: '919876533333', text: 'Hi' }] })),
      fx.deliver(fx.messagesBody(c, { messages: [{ waId: '919876533333', text: 'Hello again' }] })),
    ]);
    expect([a.outcome, b.outcome]).toEqual(['processed', 'processed']);
    const contacts = await fx.query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2',
      [c.tenant.id, '+919876533333'],
    );
    expect(contacts).toEqual([{ id, display_name: 'Imported Ravi' }]);
    const identities = await fx.query<{ contact_id: string }>(
      'SELECT contact_id FROM app.contact_identities WHERE tenant_id = $1 AND wa_id = $2',
      [c.tenant.id, '919876533333'],
    );
    expect(identities).toEqual([{ contact_id: id }]);
    // The number now comes from WhatsApp and cannot be edited.
    await expectAppError(
      contactsSvc.updateContact(ctx, id, { phone: '+919876533334' }),
      'precondition_failed',
    );
    // Two concurrent receipts for a brand-new sender create exactly one contact.
    await Promise.all([
      fx.deliver(fx.messagesBody(c, { messages: [{ waId: '919876544444', text: 'one' }] })),
      fx.deliver(fx.messagesBody(c, { messages: [{ waId: '919876544444', text: 'two' }] })),
    ]);
    const fresh = await fx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.contacts WHERE tenant_id = $1 AND phone_e164 = $2',
      [c.tenant.id, '+919876544444'],
    );
    expect(fresh[0]!.n).toBe(1);
  });

  it('lists and searches contacts with keyset pagination and filters', async () => {
    const ctx = await fx.ctx(c, c.agent);
    for (let i = 0; i < 5; i += 1) {
      await contactsSvc.createContact(ctx, {
        displayName: `Paged ${i}`,
        phone: `+91990000000${i}`,
        tags: ['paged'],
      });
    }
    const first = await contactsSvc.listContacts(ctx, { tag: 'paged', limit: 3 });
    expect(first.items).toHaveLength(3);
    // Each row carries its own tags (correlated with the listed contact, not the tag rows).
    expect(first.items.map((i) => i.tags)).toEqual([['paged'], ['paged'], ['paged']]);
    const second = await contactsSvc.listContacts(ctx, {
      tag: 'paged',
      limit: 3,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const ids = new Set([...first.items, ...second.items].map((i) => i.id));
    expect(ids.size).toBe(5);
    expect(
      (await contactsSvc.listContacts(ctx, { q: '99000 00003' })).items.map((i) => i.displayName),
    ).toEqual(['Paged 3']);
    expect((await contactsSvc.listContacts(ctx, { q: 'paged 4' })).items).toHaveLength(1);
    // Wildcards in the search text match literally.
    expect((await contactsSvc.listContacts(ctx, { q: '%' })).items).toHaveLength(0);
  });

  it('pages through contacts written in one transaction, which share their creation time to the microsecond', async () => {
    const d = await fx.company();
    const ctx = await fx.ctx(d, d.agent);
    // An import writes its new contacts in one transaction: they share now(). A cursor cut to
    // milliseconds skipped all but the first page of them.
    const batch = await fx.query<{ id: string }>(
      `INSERT INTO app.contacts (id, tenant_id, phone_e164, source)
       SELECT gen_random_uuid(), $1, '+9170100' || lpad(g::text, 5, '0'), 'import'
         FROM generate_series(1, 7) g
       RETURNING id`,
      [d.tenant.id],
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await contactsSvc.listContacts(ctx, { limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(batch.map((r) => r.id).sort());
  });
});

describe('bulk tag and field edits (ADR-213, ADR-238)', () => {
  async function tagsOf(contactId: string) {
    const rows = await fx.query<{ tag: string }>(
      'SELECT tag FROM app.contact_tags WHERE contact_id = $1 ORDER BY tag',
      [contactId],
    );
    return rows.map((r) => r.tag);
  }

  it('adds a tag to every contact the filters match, but those that have it or are full, removes it, and audits both', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const a = await contactsSvc.createContact(owner, {
      displayName: 'Asha Rao',
      phone: '+919811000001',
      tags: ['pune'],
    });
    const b = await contactsSvc.createContact(owner, {
      displayName: 'Bina Shah',
      phone: '+919811000002',
      tags: ['pune', 'vip'],
    });
    const full = await contactsSvc.createContact(owner, {
      displayName: 'Chitra Das',
      phone: '+919811000003',
      tags: ['pune'],
    });
    await fx.query(
      `INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag)
       SELECT gen_random_uuid(), $1, $2, 'tag ' || n FROM generate_series(1, $3::int - 1) n`,
      [c.tenant.id, full.id, MAX_TAGS_PER_CONTACT],
    );
    const other = await contactsSvc.createContact(owner, {
      displayName: 'Dev Mehta',
      phone: '+919811000004',
      tags: ['mumbai'],
    });
    const erased = await contactsSvc.createContact(owner, {
      displayName: 'Esha Paul',
      phone: '+919811000005',
      tags: ['pune'],
    });
    await contactsSvc.eraseContact(owner, { contactId: erased.id, suppress: false });

    // The erased contact no longer matches.
    const pune = { tag: 'pune' };
    expect(await contactsSvc.countContacts(owner, pune)).toBe(3);
    // The number shown must still be the number matching.
    await expectAppError(
      contactsSvc.bulkTagContacts(owner, {
        filter: pune,
        tag: 'vip',
        action: 'add',
        expectedCount: 2,
      }),
      'conflict',
      /These filters now match 3 contacts, not 2\./,
    );
    await expectAppError(
      contactsSvc.bulkTagContacts(owner, {
        filter: pune,
        tag: 'a,b',
        action: 'add',
        expectedCount: 3,
      }),
      'validation_failed',
      /commas/,
    );
    expect(
      await contactsSvc.bulkTagContacts(
        owner,
        { filter: pune, tag: ' VIP ', action: 'add', expectedCount: 3 },
        { ipAddress: '203.0.113.7' },
      ),
    ).toEqual({ action: 'add', tag: 'vip', matched: 3, changed: 1, unchanged: 1, atLimit: 1 });
    expect(await tagsOf(a.id)).toEqual(['pune', 'vip']);
    expect(await tagsOf(b.id)).toEqual(['pune', 'vip']);
    expect(await tagsOf(full.id)).not.toContain('vip');
    expect(await tagsOf(other.id)).toEqual(['mumbai']);

    // Removing it, by an agent, from the contacts a search finds.
    const agent = await fx.ctx(c, c.agent);
    const search = { q: 'Rao' };
    expect(await contactsSvc.countContacts(agent, search)).toBe(1);
    expect(
      await contactsSvc.bulkTagContacts(agent, {
        filter: search,
        tag: 'vip',
        action: 'remove',
        expectedCount: 1,
      }),
    ).toEqual({ action: 'remove', tag: 'vip', matched: 1, changed: 1, unchanged: 0, atLimit: 0 });
    expect(await tagsOf(a.id)).toEqual(['pune']);
    expect(
      await contactsSvc.bulkTagContacts(owner, {
        filter: pune,
        tag: 'vip',
        action: 'remove',
        expectedCount: 3,
      }),
    ).toEqual({ action: 'remove', tag: 'vip', matched: 3, changed: 1, unchanged: 2, atLimit: 0 });
    expect(await tagsOf(b.id)).toEqual(['pune']);

    // Audited with the counts and which filters were used, never the search text.
    const audit = await fx.query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'contacts.bulk_tagged' ORDER BY id`,
      [c.tenant.id],
    );
    expect(audit).toEqual([
      {
        actor_id: c.owner.id,
        metadata: {
          action: 'add',
          tag: 'vip',
          matched: 3,
          changed: 1,
          unchanged: 1,
          atLimit: 1,
          filter: { q: false, tag: 'pune', consent: 'any' },
        },
      },
      {
        actor_id: c.agent.id,
        metadata: {
          action: 'remove',
          tag: 'vip',
          matched: 1,
          changed: 1,
          unchanged: 0,
          atLimit: 0,
          filter: { q: true, tag: null, consent: 'any' },
        },
      },
      expect.objectContaining({ actor_id: c.owner.id }),
    ]);
    expect(JSON.stringify(audit)).not.toContain('Rao');

    // Members who cannot change contacts cannot use it; another company finds none of these.
    const user = await createUser(fx.dbs, { name: 'Analyst A' });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, ['analyst']);
    await acceptInvitation(fx.dbs, user, token);
    const analyst = await fx.ctx(c, user);
    await expectAppError(contactsSvc.countContacts(analyst, pune), 'forbidden');
    await expectAppError(
      contactsSvc.bulkTagContacts(analyst, {
        filter: pune,
        tag: 'vip',
        action: 'add',
        expectedCount: 3,
      }),
      'forbidden',
    );
    const d = await fx.company();
    const elsewhere = await fx.ctx(d, d.owner);
    expect(await contactsSvc.countContacts(elsewhere, pune)).toBe(0);
    await expectAppError(
      contactsSvc.bulkTagContacts(elsewhere, {
        filter: pune,
        tag: 'vip',
        action: 'add',
        expectedCount: 3,
      }),
      'conflict',
      /These filters now match 0 contacts, not 3\./,
    );
  });

  async function attributesOf(contactId: string) {
    const [row] = await fx.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM app.contacts WHERE id = $1',
      [contactId],
    );
    return row?.attributes;
  }

  async function feedRows(contactId: string) {
    const [row] = await fx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.contact_changes WHERE contact_id = $1',
      [contactId],
    );
    return row?.n;
  }

  it('sets one custom field on every contact the filters match, or clears it, only where that changes it, and audits each edit (ADR-238)', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await contactsSvc.createField(owner, { label: 'City', type: 'text' });
    await contactsSvc.createField(owner, { label: 'Orders', type: 'number' });
    await contactsSvc.createField(owner, { label: 'Wholesale', type: 'boolean' });
    const a = await contactsSvc.createContact(owner, {
      displayName: 'Asha Rao',
      phone: '+919822000001',
      tags: ['pune'],
      attributes: { city: 'Mumbai' },
    });
    const b = await contactsSvc.createContact(owner, {
      displayName: 'Bina Shah',
      phone: '+919822000002',
      tags: ['pune'],
      attributes: { city: 'Pune', orders: '3' },
    });
    const other = await contactsSvc.createContact(owner, {
      displayName: 'Dev Mehta',
      phone: '+919822000003',
      tags: ['mumbai'],
      attributes: { city: 'Mumbai' },
    });
    const erased = await contactsSvc.createContact(owner, {
      displayName: 'Esha Paul',
      phone: '+919822000004',
      tags: ['pune'],
    });
    await contactsSvc.eraseContact(owner, { contactId: erased.id, suppress: false });
    const pune = { tag: 'pune' };
    expect(await contactsSvc.countContacts(owner, pune)).toBe(2);

    // The value is checked against the field's type, the field must be the company's, and the
    // number shown must still be the number matching.
    await expectAppError(
      contactsSvc.bulkSetField(owner, {
        filter: pune,
        key: 'orders',
        value: 'many',
        expectedCount: 2,
      }),
      'validation_failed',
      /Orders must be a number\./,
    );
    await expectAppError(
      contactsSvc.bulkSetField(owner, {
        filter: pune,
        key: 'country',
        value: 'India',
        expectedCount: 2,
      }),
      'validation_failed',
      /Choose one of the company’s custom fields\./,
    );
    await expectAppError(
      contactsSvc.bulkSetField(owner, {
        filter: pune,
        key: 'city',
        value: 'Pune',
        expectedCount: 3,
      }),
      'conflict',
      /These filters now match 2 contacts, not 3\./,
    );
    expect(await attributesOf(a.id)).toEqual({ city: 'Mumbai' });

    const feedBefore = { a: await feedRows(a.id), b: await feedRows(b.id) };
    expect(
      await contactsSvc.bulkSetField(
        owner,
        { filter: pune, key: 'city', value: ' Pune ', expectedCount: 2 },
        { ipAddress: '203.0.113.7' },
      ),
    ).toEqual({ key: 'city', label: 'City', value: 'Pune', matched: 2, changed: 1, unchanged: 1 });
    expect(await attributesOf(a.id)).toEqual({ city: 'Pune' });
    expect(await attributesOf(b.id)).toEqual({ city: 'Pune', orders: 3 });
    expect(await attributesOf(other.id)).toEqual({ city: 'Mumbai' });
    // The contact that changed is a change in the contact feed; the one left as it was is not.
    expect(await feedRows(a.id)).toBe(feedBefore.a! + 1);
    expect(await feedRows(b.id)).toBe(feedBefore.b);

    // Typed values, stored as one contact's edit stores them.
    expect(
      await contactsSvc.bulkSetField(owner, {
        filter: pune,
        key: 'wholesale',
        value: 'Yes',
        expectedCount: 2,
      }),
    ).toMatchObject({ value: true, changed: 2, unchanged: 0 });
    expect(await attributesOf(b.id)).toEqual({ city: 'Pune', orders: 3, wholesale: true });

    // Clearing, by an agent, for the contacts a search finds; clearing again changes nothing.
    const agent = await fx.ctx(c, c.agent);
    expect(
      await contactsSvc.bulkSetField(agent, {
        filter: { q: 'Shah' },
        key: 'orders',
        value: '',
        expectedCount: 1,
      }),
    ).toEqual({
      key: 'orders',
      label: 'Orders',
      value: null,
      matched: 1,
      changed: 1,
      unchanged: 0,
    });
    expect(await attributesOf(b.id)).toEqual({ city: 'Pune', wholesale: true });
    expect(
      await contactsSvc.bulkSetField(owner, {
        filter: pune,
        key: 'orders',
        value: '  ',
        expectedCount: 2,
      }),
    ).toMatchObject({ value: null, matched: 2, changed: 0, unchanged: 2 });

    // Audited with the field, the counts and which filters were used, never the value or the
    // search text.
    const audit = await fx.query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'contacts.bulk_field_set' ORDER BY id`,
      [c.tenant.id],
    );
    expect(audit).toEqual([
      {
        actor_id: c.owner.id,
        metadata: {
          key: 'city',
          cleared: false,
          matched: 2,
          changed: 1,
          unchanged: 1,
          filter: { q: false, tag: 'pune', consent: 'any' },
        },
      },
      expect.objectContaining({ actor_id: c.owner.id }),
      {
        actor_id: c.agent.id,
        metadata: {
          key: 'orders',
          cleared: true,
          matched: 1,
          changed: 1,
          unchanged: 0,
          filter: { q: true, tag: null, consent: 'any' },
        },
      },
      expect.objectContaining({ actor_id: c.owner.id }),
    ]);
    expect(JSON.stringify(audit)).not.toContain('Pune');
    expect(JSON.stringify(audit)).not.toContain('Shah');

    // Members who cannot change contacts cannot use it; another company's fields and contacts
    // are its own.
    const user = await createUser(fx.dbs, { name: 'Analyst B' });
    const { token } = await invite(fx.dbs, c.tenant, c.owner, user.email, ['analyst']);
    await acceptInvitation(fx.dbs, user, token);
    const analyst = await fx.ctx(c, user);
    await expectAppError(
      contactsSvc.bulkSetField(analyst, {
        filter: pune,
        key: 'city',
        value: 'Goa',
        expectedCount: 2,
      }),
      'forbidden',
    );
    const d = await fx.company();
    const elsewhere = await fx.ctx(d, d.owner);
    await expectAppError(
      contactsSvc.bulkSetField(elsewhere, {
        filter: pune,
        key: 'city',
        value: 'Goa',
        expectedCount: 2,
      }),
      'validation_failed',
      /Choose one of the company’s custom fields\./,
    );
    await contactsSvc.createField(elsewhere, { label: 'City', type: 'text' });
    await expectAppError(
      contactsSvc.bulkSetField(elsewhere, {
        filter: pune,
        key: 'city',
        value: 'Goa',
        expectedCount: 2,
      }),
      'conflict',
      /These filters now match 0 contacts, not 2\./,
    );
    expect(await attributesOf(a.id)).toEqual({ city: 'Pune', wholesale: true });
  });

  it('refuses more contacts than one edit may change', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    await fx.query(
      `WITH added AS (
         INSERT INTO app.contacts (id, tenant_id, display_name, source)
         SELECT gen_random_uuid(), $1, 'Bulk ' || n, 'import' FROM generate_series(1, $2::int) n
         RETURNING id)
       INSERT INTO app.contact_tags (id, tenant_id, contact_id, tag)
       SELECT gen_random_uuid(), $1, id, 'lead' FROM added`,
      [c.tenant.id, BULK_TAG_LIMIT + 1],
    );
    expect(await contactsSvc.countContacts(owner, { tag: 'lead' })).toBe(BULK_TAG_LIMIT + 1);
    await expectAppError(
      contactsSvc.bulkTagContacts(owner, {
        filter: { tag: 'lead' },
        tag: 'lead',
        action: 'remove',
        expectedCount: BULK_TAG_LIMIT,
      }),
      'validation_failed',
      /At most 10,000 contacts can be tagged at once\. Narrow the filters first\./,
    );
    const [left] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.contact_tags WHERE tenant_id = $1 AND tag = 'lead'`,
      [c.tenant.id],
    );
    expect(left!.n).toBe(BULK_TAG_LIMIT + 1);
    // A field edit has the same limit (ADR-238).
    await contactsSvc.createField(owner, { label: 'City', type: 'text' });
    await expectAppError(
      contactsSvc.bulkSetField(owner, {
        filter: { tag: 'lead' },
        key: 'city',
        value: 'Pune',
        expectedCount: BULK_TAG_LIMIT,
      }),
      'validation_failed',
      /At most 10,000 contacts can be edited at once\. Narrow the filters first\./,
    );
    const [set] = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.contacts
        WHERE tenant_id = $1 AND (attributes -> 'city') IS NOT NULL`,
      [c.tenant.id],
    );
    expect(set!.n).toBe(0);
  });
});

describe('CSV import and export', () => {
  let c: Company;
  beforeAll(async () => {
    c = await fx.company();
  });

  const csv = [
    'Phone,Full Name,Email,Tags,Consent',
    '+91 98111 00001,Anil,anil@example.test,gold;north,yes',
    '98111 00002,Bina,,silver,no',
    'not-a-number,Chitra,,,',
    '+919811100001,Duplicate Anil,,,',
    '+919811100003,Esha,bad-email,,',
    '+919811100004,"=HYPERLINK(""http://evil.test"")",,,maybe',
  ].join('\r\n');

  it('previews the file with suggested column mapping', async () => {
    const ctx = await fx.ctx(c, c.marketer);
    const preview = await contactsSvc.previewImport(ctx, { fileName: 'list.csv', text: csv });
    expect(preview.totalRows).toBe(6);
    expect(preview.suggested).toMatchObject({
      phone: 0,
      name: 1,
      email: 2,
      tags: 3,
      marketingConsent: 4,
    });
    const agent = await fx.ctx(c, c.agent);
    await expectAppError(
      contactsSvc.previewImport(agent, { fileName: 'x.csv', text: csv }),
      'forbidden',
    );
  });

  it('imports valid rows, reports row errors without row contents, and records consent with provenance', async () => {
    const ctx = await fx.ctx(c, c.marketer);
    const mapping = { phone: 0, name: 1, email: 2, tags: 3, marketingConsent: 4, fields: {} };
    // Opt-ins from a column need an attestation; opt-outs never do.
    const noAttestation = await contactsSvc.importContacts(ctx, {
      text: csv,
      fileName: 'list.csv',
      mapping,
      phoneFormat: 'national',
      callingCode: '91',
      tags: ['import-1'],
      consent: { mode: 'column' },
    });
    expect(noAttestation).toMatchObject({
      totalRows: 6,
      created: 3,
      updated: 0,
      errorCount: 3,
      consentRecorded: 1,
    });
    const errors = noAttestation.messages.filter((m) => m.level === 'error');
    expect(errors.map((e) => e.row)).toEqual([4, 5, 6]);
    expect(JSON.stringify(noAttestation.messages)).not.toContain('Chitra');
    const anil = (await contactIdFor(c.tenant.id, '+919811100001'))!;
    const bina = (await contactIdFor(c.tenant.id, '+919811100002'))!;
    expect(await consentState(c.tenant.id, anil)).toEqual({});
    expect(await consentState(c.tenant.id, bina)).toEqual({ marketing: 'opted_out' });
    const tags = await fx.query<{ tag: string }>(
      'SELECT tag FROM app.contact_tags WHERE tenant_id = $1 AND contact_id = $2 ORDER BY tag',
      [c.tenant.id, anil],
    );
    expect(tags.map((t) => t.tag)).toEqual(['gold', 'import-1', 'north']);

    // Re-import with an attestation and updates enabled: Anil's opt-in is recorded, Bina's opt-out
    // is kept (an import never overrides an opt-out).
    const binaOptIn = csv.replace('98111 00002,Bina,,silver,no', '98111 00002,Bina B,,silver,yes');
    const second = await contactsSvc.importContacts(ctx, {
      text: binaOptIn,
      fileName: 'list-2.csv',
      mapping,
      phoneFormat: 'national',
      callingCode: '91',
      updateExisting: true,
      consent: {
        mode: 'column',
        attestation: 'Collected on our website sign-up form with a WhatsApp opt-in checkbox.',
      },
    });
    expect(second).toMatchObject({ created: 0, updated: 3, consentRecorded: 1 });
    expect(await consentState(c.tenant.id, anil)).toEqual({ marketing: 'opted_in' });
    expect(await consentState(c.tenant.id, bina)).toEqual({ marketing: 'opted_out' });
    expect(
      second.messages.some(
        (m) => m.level === 'notice' && /Kept the existing marketing opt-out/.test(m.message),
      ),
    ).toBe(true);
    const [binaRow] = await fx.query<{ display_name: string }>(
      'SELECT display_name FROM app.contacts WHERE id = $1',
      [bina],
    );
    expect(binaRow!.display_name).toBe('Bina B');
    const [event] = await fx.query<{
      source: string;
      actor_id: string;
      evidence: { importId: string; row: number };
    }>(
      `SELECT source, actor_id, evidence FROM app.consent_events WHERE tenant_id = $1 AND contact_id = $2 AND action = 'opt_in'`,
      [c.tenant.id, anil],
    );
    expect(event).toMatchObject({
      source: 'import',
      actor_id: c.marketer.id,
      evidence: { row: 2 },
    });
    const [run] = await fx.query<{ consent_attestation: string; error_count: number }>(
      'SELECT consent_attestation, error_count FROM app.contact_imports WHERE id = $1',
      [event!.evidence.importId],
    );
    expect(run).toMatchObject({ error_count: 3 });
    expect(run!.consent_attestation).toMatch(/website sign-up form/);
  });

  it('exports every contact when more than one batch shares a creation time', async () => {
    const d = await fx.company();
    await fx.query(
      `INSERT INTO app.contacts (id, tenant_id, phone_e164, source)
       SELECT gen_random_uuid(), $1, '+9170200' || lpad(g::text, 5, '0'), 'import'
         FROM generate_series(1, 505) g`,
      [d.tenant.id],
    );
    const ctx = await fx.ctx(d, d.marketer);
    let out = '';
    for await (const chunk of contactsSvc.exportContacts(ctx, {})) out += chunk;
    // The export reads 500 contacts at a time: the second batch must hold the other 5.
    expect(parseCsv(out).rows.length).toBe(505);
  });

  it('exports formula-safe CSV that round-trips through the parser', async () => {
    const ctx = await fx.ctx(c, c.marketer);
    let out = '';
    for await (const chunk of contactsSvc.exportContacts(ctx, {})) out += chunk;
    expect(out.startsWith('\uFEFFphone,name,email,tags')).toBe(true);
    expect(out).toContain('+919811100004,"\'=HYPERLINK(""http://evil.test"")"');
    const parsed = parseCsv(out);
    expect(parsed.rows.length).toBe(3);
    // Tags and consent are the contact's own (imported above).
    const anil = parsed.rows.find((r) => r[0] === '+919811100001');
    const bina = parsed.rows.find((r) => r[0] === '+919811100002');
    expect(anil?.slice(3, 6)).toEqual(['gold; import-1; north', 'opted_in', '']);
    expect(bina?.slice(4, 6)).toEqual(['opted_out', '']);
    const agent = await fx.ctx(c, c.agent);
    const denied = contactsSvc.exportContacts(agent, {});
    await expectAppError(denied.next(), 'forbidden');
    const audit = await fx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.audit_events WHERE tenant_id = $1 AND action = 'contacts.exported'`,
      [c.tenant.id],
    );
    expect(audit[0]!.n).toBe(1);
  });
});

describe('consent', () => {
  let c: Company;
  beforeAll(async () => {
    c = await fx.company();
  });

  it('records keyword opt-outs and opt-ins from inbound messages exactly once, ordered by when they happened', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stop = fx.messagesBody(c, {
      messages: [{ id: 'wamid.kw.stop', waId: '919822200001', text: ' Stop! ', timestamp: now }],
    });
    expect((await fx.deliver(stop)).outcome).toBe('processed');
    const contactId = (await contactIdFor(c.tenant.id, '+919822200001'))!;
    expect(await consentState(c.tenant.id, contactId)).toEqual({
      marketing: 'opted_out',
      utility: 'opted_out',
    });
    // Replayed delivery: no second event.
    await fx.deliver({
      entry: (stop as { entry: unknown }).entry,
      object: 'whatsapp_business_account',
    });
    const events = await fx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.consent_events WHERE tenant_id = $1 AND contact_id = $2',
      [c.tenant.id, contactId],
    );
    expect(events[0]!.n).toBe(2);
    // A START sent earlier but delivered late does not undo the newer STOP.
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [{ waId: '919822200001', text: 'start', timestamp: now - 60 }],
      }),
    );
    expect(await consentState(c.tenant.id, contactId)).toEqual({
      marketing: 'opted_out',
      utility: 'opted_out',
    });
    // A newer START does.
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [{ waId: '919822200001', text: 'START', timestamp: now + 60 }],
      }),
    );
    expect(await consentState(c.tenant.id, contactId)).toEqual({
      marketing: 'opted_in',
      utility: 'opted_in',
    });
    // Keywords inside a sentence are ordinary messages; quick-reply buttons count.
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [{ waId: '919822200001', text: 'please stop calling me', timestamp: now + 120 }],
      }),
    );
    expect(await consentState(c.tenant.id, contactId)).toEqual({
      marketing: 'opted_in',
      utility: 'opted_in',
    });
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [
          {
            waId: '919822200001',
            type: 'button',
            extra: { button: { text: 'Stop promotions', payload: 'x' } },
            timestamp: now + 180,
          },
        ],
      }),
    );
    expect(await consentState(c.tenant.id, contactId)).toEqual({
      marketing: 'opted_out',
      utility: 'opted_in',
    });
    const [evidence] = await fx.query<{
      evidence: { keyword: string; messageId: string };
      actor_type: string;
    }>(
      `SELECT evidence, actor_type FROM app.consent_events WHERE tenant_id = $1 AND contact_id = $2 ORDER BY occurred_at DESC LIMIT 1`,
      [c.tenant.id, contactId],
    );
    expect(evidence).toMatchObject({
      actor_type: 'contact',
      evidence: { keyword: 'STOP PROMOTIONS' },
    });
  });

  it('lets an opt-out win a tie and keeps consent history append-only', async () => {
    const ctx = await fx.ctx(c, c.agent);
    const { id } = await contactsSvc.createContact(ctx, { phone: '+919822200002' });
    const at = new Date().toISOString();
    await fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.agent.id), async (tx) => {
      for (const action of ['opt_out', 'opt_in']) {
        await tx.execute(sql`insert into app.consent_events (id, tenant_id, contact_id, purpose, action, source, actor_type, occurred_at)
          values (${uuidv7()}::uuid, ${c.tenant.id}::uuid, ${id}::uuid, 'marketing', ${action}, 'agent', 'user', ${at}::timestamptz)`);
      }
    });
    expect(await consentState(c.tenant.id, id)).toEqual({ marketing: 'opted_out' });
    await expect(
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.agent.id), (tx) =>
        tx.execute(
          sql`update app.consent_events set action = 'opt_in' where contact_id = ${id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.agent.id), (tx) =>
        tx.execute(
          sql`update app.contact_consents set status = 'opted_in' where contact_id = ${id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('applies company keyword settings and refuses ambiguous or empty opt-out lists', async () => {
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    const settings = {
      optOutKeywords: 'stop, band karo',
      marketingOptOutKeywords: 'no offers',
      optInKeywords: 'start',
      requireMarketingOptIn: true,
    };
    await expectAppError(consentSvc.updateSettings(agent, settings), 'forbidden');
    await expectAppError(
      consentSvc.updateSettings(owner, { ...settings, optInKeywords: 'stop' }),
      'validation_failed',
      /both/,
    );
    await expectAppError(
      consentSvc.updateSettings(owner, { ...settings, optOutKeywords: '' }),
      'validation_failed',
      /at least one/,
    );
    await consentSvc.updateSettings(owner, settings);
    expect((await consentSvc.getSettings(agent)).optOutKeywords).toEqual(['STOP', 'BAND KARO']);
    await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: '919822200003', text: 'Band karo' }] }),
    );
    const contactId = (await contactIdFor(c.tenant.id, '+919822200003'))!;
    expect(await consentState(c.tenant.id, contactId)).toEqual({
      marketing: 'opted_out',
      utility: 'opted_out',
    });
  });

  it('manages the suppression list with the right permissions', async () => {
    const agent = await fx.ctx(c, c.agent);
    const owner = await fx.ctx(c, c.owner);
    const { id } = await consentSvc.addSuppression(agent, {
      phone: '+91 98222 00009',
      reason: 'complaint',
    });
    await expectAppError(
      consentSvc.addSuppression(agent, { phone: '+919822200009', reason: 'manual' }),
      'conflict',
    );
    await expectAppError(consentSvc.removeSuppression(agent, id), 'forbidden');
    const list = await consentSvc.listSuppressions(owner);
    expect(list.items.map((s) => s.phoneE164)).toContain('+919822200009');
    await consentSvc.removeSuppression(owner, id);
    expect((await consentSvc.listSuppressions(owner)).items.map((s) => s.phoneE164)).not.toContain(
      '+919822200009',
    );
  });
});

describe('erasure', () => {
  it('removes personal data, redacts messages, clears recipient ids and stops queued sends', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const agent = await fx.ctx(c, c.agent);
    await fx.deliver(
      fx.messagesBody(c, {
        messages: [{ id: 'wamid.er.in', waId: '919833300001', text: 'My address is 12 MG Road' }],
      }),
    );
    const contactId = (await contactIdFor(c.tenant.id, '+919833300001'))!;
    await contactsSvc.addTags(agent, contactId, ['vip']);
    const [conv] = await fx.query<{ id: string }>(
      'SELECT id FROM app.conversations WHERE tenant_id = $1 AND contact_id = $2',
      [c.tenant.id, contactId],
    );
    // One sent message with a delivery status, one still queued.
    const deps = { db: fx.dbs.app, jobs: fx.jobs(), signer: fx.signer, clock: systemClock };
    const sent = await queueTextMessage(deps, agent, {
      conversationId: conv!.id,
      text: 'Thanks, noted',
      clientKey: `ck_${uuidv7()}`,
    });
    const [intent] = await fx.query<{ id: string }>(
      'SELECT id FROM app.send_intents WHERE message_id = $1',
      [sent.messageId],
    );
    await processSendIntent(
      {
        db: fx.dbs.app,
        keyring: fx.keyring,
        graph: fx.graph,
        clock: systemClock,
        rate: { capacity: 100, refillPerSecond: 100 },
        jobs: fx.jobs(),
        signer: fx.signer,
      },
      authorizedTenantScope(c.tenant.id, c.agent.id),
      intent!.id,
    );
    const [wamid] = await fx.query<{ external_message_id: string }>(
      'SELECT external_message_id FROM app.messages WHERE id = $1',
      [sent.messageId],
    );
    await fx.deliver(
      fx.messagesBody(c, {
        statuses: [
          {
            id: wamid!.external_message_id,
            status: 'delivered',
            timestamp: String(Math.floor(Date.now() / 1000)),
            recipient_id: '919833300001',
          },
        ],
      }),
    );
    const queued = await queueTextMessage(deps, agent, {
      conversationId: conv!.id,
      text: 'One more thing',
      clientKey: `ck_${uuidv7()}`,
    });

    // The send requests hold the text (and the number) until erasure.
    const requestsOf = () =>
      fx.query<{ request: unknown }>(
        `SELECT s.request FROM app.send_intents s
           JOIN app.messages m ON m.tenant_id = s.tenant_id AND m.id = s.message_id
          WHERE m.conversation_id = $1 ORDER BY s.created_at`,
        [conv!.id],
      );
    expect(JSON.stringify(await requestsOf())).toContain('Thanks, noted');
    await expectAppError(
      contactsSvc.eraseContact(agent, { contactId, suppress: true }),
      'forbidden',
    );
    await contactsSvc.eraseContact(owner, { contactId, suppress: true });

    const [contact] = await fx.query<{
      display_name: string | null;
      phone_e164: string | null;
      erased_at: Date | null;
    }>('SELECT display_name, phone_e164, erased_at FROM app.contacts WHERE id = $1', [contactId]);
    expect(contact).toMatchObject({ display_name: null, phone_e164: null });
    expect(contact!.erased_at).not.toBeNull();
    const messages = await fx.query<{ content: unknown; status: string }>(
      'SELECT content, status FROM app.messages WHERE conversation_id = $1 ORDER BY created_at',
      [conv!.id],
    );
    expect(messages.every((m) => JSON.stringify(m.content) === '{"redacted":true}')).toBe(true);
    const [queuedIntent] = await fx.query<{ state: string; last_error_code: string }>(
      'SELECT state, last_error_code FROM app.send_intents WHERE message_id = $1',
      [queued.messageId],
    );
    expect(queuedIntent).toEqual({ state: 'canceled', last_error_code: 'contact_erased' });
    // Past and cancelled sends alike lose their requests (P5-11 fix).
    const requests = await requestsOf();
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => JSON.stringify(r.request) === '{"redacted":true}')).toBe(true);
    const statusEvents = await fx.query<{ recipient_wa_id: string | null }>(
      'SELECT recipient_wa_id FROM app.message_status_events WHERE tenant_id = $1',
      [c.tenant.id],
    );
    expect(statusEvents.length).toBeGreaterThan(0);
    expect(statusEvents.every((e) => e.recipient_wa_id === null)).toBe(true);
    const leftovers = await fx.query<{ identities: number; tags: number; suppressed: number }>(
      `SELECT (SELECT count(*)::int FROM app.contact_identities WHERE contact_id = $1) AS identities,
              (SELECT count(*)::int FROM app.contact_tags WHERE contact_id = $1) AS tags,
              (SELECT count(*)::int FROM app.suppressions WHERE tenant_id = $2 AND phone_e164 = '+919833300001') AS suppressed`,
      [contactId, c.tenant.id],
    );
    expect(leftovers[0]).toEqual({ identities: 0, tags: 0, suppressed: 1 });
    expect(await consentState(c.tenant.id, contactId)).toEqual({
      marketing: 'opted_out',
      utility: 'opted_out',
    });
    const [preview] = await fx.query<{ last_message_preview: string | null }>(
      'SELECT last_message_preview FROM app.conversations WHERE id = $1',
      [conv!.id],
    );
    expect(preview!.last_message_preview).toBeNull();
    await expectAppError(
      contactsSvc.eraseContact(owner, { contactId, suppress: true }),
      'conflict',
    );

    // The recipient-id exception exists only inside the erasure function.
    await expect(
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), (tx) =>
        tx.execute(
          sql`update app.message_status_events set recipient_wa_id = null where tenant_id = ${c.tenant.id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      fx.dbs.app.run(authorizedTenantScope(c.tenant.id, c.owner.id), async (tx) => {
        await tx.execute(sql`select set_config('w360.contact_erasure', 'on', true)`);
        await tx.execute(
          sql`update app.message_status_events set recipient_bsuid = null where tenant_id = ${c.tenant.id}::uuid`,
        );
      }),
    ).rejects.toThrow();

    // The same number writing in again becomes a new contact, but stays suppressed.
    await fx.deliver(
      fx.messagesBody(c, { messages: [{ waId: '919833300001', text: 'Hi again' }] }),
    );
    const newId = await contactIdFor(c.tenant.id, '+919833300001');
    expect(newId).not.toBeNull();
    expect(newId).not.toBe(contactId);
  });

  it('cannot erase another company’s contact', async () => {
    const a = await fx.company();
    const b = await fx.company();
    const ctxA = await fx.ctx(a, a.agent);
    const { id } = await contactsSvc.createContact(ctxA, { phone: '+919844400001' });
    const ownerB = await fx.ctx(b, b.owner);
    await expectAppError(
      contactsSvc.eraseContact(ownerB, { contactId: id, suppress: false }),
      'not_found',
    );
    await expectAppError(contactsSvc.getContact(ownerB, id), 'not_found');
    await expectAppError(
      consentSvc.recordConsent(ownerB, { contactId: id, purpose: 'marketing', action: 'opt_in' }),
      'not_found',
    );
    const [still] = await fx.query<{ phone_e164: string }>(
      'SELECT phone_e164 FROM app.contacts WHERE id = $1',
      [id],
    );
    expect(still!.phone_e164).toBe('+919844400001');
  });
});
