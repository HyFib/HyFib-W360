import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import {
  apiCreateContact,
  apiCreateContactField,
  apiGetContact,
  apiListContactFields,
  apiListContacts,
  apiUpdateContact,
  apiUpdateContactField,
  authenticateApiToken,
  createApiKeysService,
  createContactMergeService,
  createContactsService,
  createSegmentsService,
  type ApiContext,
  type ApiScope,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Choice-type custom contact fields (ADR-407) against real PostgreSQL: values set by members, CSV
 * import, bulk edits and the API, taken whatever their case where members type them and exactly
 * as written through the API, always stored as the option is written; options changed while
 * contacts have some chosen; another company's field not found; the shape the database checks and
 * the runtime role's grants.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx?.close();
});

const contactsSvc = () => createContactsService({ db: fx.dbs.app, clock: systemClock });
const deps = () => ({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });

async function apiKey(c: Company, scopes: ApiScope[]): Promise<ApiContext> {
  const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
  const created = await keys.create(await fx.ctx(c, c.owner), {
    name: 'Choices',
    scopes,
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      code: error.code,
      message: error.publicMessage,
      paths: (error.issues ?? []).map((i) => i.path),
    };
  }
  throw new Error('expected a refusal');
}

const attributesOf = async (contactId: string) =>
  (
    await fx.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM app.contacts WHERE id = $1',
      [contactId],
    )
  )[0]!.attributes;

const optionsOf = async (fieldId: string) =>
  (
    await fx.query<{ options: string[] | null }>(
      'SELECT options FROM app.contact_fields WHERE id = $1',
      [fieldId],
    )
  )[0]!.options;

const audits = (c: Company, action: string) =>
  fx.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM app.audit_events
      WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at, id`,
    [c.tenant.id, action],
  );

/**
 * Deletes a field in the service's order (its row, then every contact's value) in a transaction
 * that waits until `start`'s work blocks on it, then finishes and commits; returns what the work
 * ended with. By default the work starts once the row is deleted; with `valuesFirst`, once the
 * values are removed too, so the deletion holds those contacts while the work starts.
 */
async function whileDeleting(
  c: Company,
  fieldId: string,
  key: string,
  start: () => Promise<string>,
  valuesFirst = false,
): Promise<string> {
  const holder = await fx.dbs.adminPool.connect();
  let outcome: Promise<string> | undefined;
  const removeValues = () =>
    holder.query(
      `UPDATE app.contacts SET attributes = attributes - $2::text
        WHERE tenant_id = $1 AND attributes ? $2::text`,
      [c.tenant.id, key],
    );
  try {
    await holder.query('BEGIN');
    await holder.query('DELETE FROM app.contact_fields WHERE id = $1', [fieldId]);
    if (valuesFirst) await removeValues();
    const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
    outcome = start();
    await vi.waitFor(
      async () => {
        const [waiting] = await fx.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
          [lock!.pid],
        );
        if (waiting!.n < 1) throw new Error('the work is not waiting yet');
      },
      { timeout: 4_000, interval: 20 },
    );
    // The work waits on the field's row without holding a contact, so the deletion goes on.
    if (!valuesFirst) await removeValues();
  } finally {
    await holder.query('COMMIT');
    holder.release();
  }
  return outcome!;
}

const settled = (promise: Promise<unknown>) =>
  promise.then(
    () => 'done',
    (error: unknown) => (isAppError(error) ? error.publicMessage : String(error)),
  );

let phoneSeq = 0;
const nextPhone = () => `+9198333${String(10000 + (phoneSeq += 1)).padStart(5, '0')}`;

/** A company with a choice field "Tier" (Gold, Silver, Bronze) and a text field "City". */
async function setup() {
  const c = await fx.company();
  const owner = await fx.ctx(c, c.owner);
  const tier = await contactsSvc().createField(owner, {
    label: 'Tier',
    type: 'choice',
    options: ['Gold', 'Silver', 'Bronze'],
  });
  await contactsSvc().createField(owner, { label: 'City', type: 'text' });
  return { c, owner, tier };
}

describe('choice-type custom contact fields (ADR-407)', () => {
  it('take an option from members whatever its case, stored as written, and export it as text', async () => {
    const { c, owner, tier } = await setup();
    expect(tier.key).toBe('tier');
    expect(await optionsOf(tier.id)).toEqual(['Gold', 'Silver', 'Bronze']);
    const fields = await contactsSvc().listFields(owner);
    expect(fields.find((f) => f.key === 'tier')).toMatchObject({
      type: 'choice',
      options: ['Gold', 'Silver', 'Bronze'],
    });
    expect(fields.find((f) => f.key === 'city')).toMatchObject({ type: 'text', options: null });
    expect(await audits(c, 'contact_field.created')).toEqual(
      expect.arrayContaining([{ metadata: { key: 'tier', type: 'choice', options: 3 } }]),
    );

    const agent = await fx.ctx(c, c.agent);
    const { id } = await contactsSvc().createContact(agent, {
      phone: nextPhone(),
      attributes: { tier: ' gold ' },
    });
    expect(await attributesOf(id)).toEqual({ tier: 'Gold' });
    await contactsSvc().updateContact(agent, id, { attributes: { tier: 'SILVER' } });
    expect(await attributesOf(id)).toEqual({ tier: 'Silver' });
    expect(
      await refusal(contactsSvc().updateContact(agent, id, { attributes: { tier: 'Platinum' } })),
    ).toMatchObject({ code: 'validation_failed', message: 'Tier must be one of its options.' });
    expect(
      await refusal(
        contactsSvc().createContact(agent, { phone: nextPhone(), attributes: { tier: 'Gld' } }),
      ),
    ).toMatchObject({ code: 'validation_failed' });
    await contactsSvc().updateContact(agent, id, { attributes: { tier: '' } });
    expect(await attributesOf(id)).toEqual({});
    await contactsSvc().updateContact(agent, id, { attributes: { tier: 'bronze' } });

    let csv = '';
    for await (const chunk of contactsSvc().exportContacts(owner, {})) csv += chunk;
    // The file starts with a byte order mark.
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [header, ...lines] = csv.slice(1).trim().split('\r\n');
    const column = header!.split(',').indexOf('tier');
    expect(column).toBeGreaterThan(0);
    expect(lines.map((line) => line.split(',')[column])).toEqual(['Bronze']);
  });

  it('take an option from a CSV file whatever its case, and refuse a row with another value', async () => {
    const { c } = await setup();
    const marketer = await fx.ctx(c, c.marketer);
    const text = [
      'Phone,Tier',
      '+919833300001,gold',
      '+919833300002,SILVER',
      '+919833300003,Platinum',
      '+919833300004,',
    ].join('\r\n');
    const result = await contactsSvc().importContacts(marketer, {
      text,
      fileName: 'tiers.csv',
      mapping: { phone: 0, fields: { tier: 1 } },
      phoneFormat: 'international',
      consent: { mode: 'none' },
    });
    expect(result).toMatchObject({ totalRows: 4, created: 3, errorCount: 1 });
    expect(result.messages).toEqual([
      { row: 4, level: 'error', message: 'Tier must be one of its options.' },
    ]);
    const rows = await fx.query<{ phone_e164: string; tier: string | null }>(
      `SELECT phone_e164, attributes ->> 'tier' AS tier FROM app.contacts
        WHERE tenant_id = $1 ORDER BY phone_e164`,
      [c.tenant.id],
    );
    expect(rows).toEqual([
      { phone_e164: '+919833300001', tier: 'Gold' },
      { phone_e164: '+919833300002', tier: 'Silver' },
      { phone_e164: '+919833300004', tier: null },
    ]);
  });

  it('set an option on every contact the filters match, whatever its case, and refuse another value', async () => {
    const { owner } = await setup();
    const a = await contactsSvc().createContact(owner, { phone: nextPhone(), tags: ['vip'] });
    const b = await contactsSvc().createContact(owner, {
      phone: nextPhone(),
      tags: ['vip'],
      attributes: { tier: 'Silver' },
    });
    expect(
      await refusal(
        contactsSvc().bulkSetField(owner, {
          filter: { tag: 'vip' },
          key: 'tier',
          value: 'Platinum',
          expectedCount: 2,
        }),
      ),
    ).toMatchObject({ code: 'validation_failed', paths: ['value'] });
    const result = await contactsSvc().bulkSetField(owner, {
      filter: { tag: 'vip' },
      key: 'tier',
      value: 'silver',
      expectedCount: 2,
    });
    expect(result).toMatchObject({ value: 'Silver', matched: 2, changed: 1, unchanged: 1 });
    expect(await attributesOf(a.id)).toEqual({ tier: 'Silver' });
    expect(await attributesOf(b.id)).toEqual({ tier: 'Silver' });
  });

  it('give options through the API and take values exactly as written, strict as for other types', async () => {
    const { c } = await setup();
    const definer = await apiKey(c, ['contact_fields.manage', 'contacts.read', 'contacts.write']);
    const created = await apiCreateContactField(
      deps(),
      definer,
      { label: 'Plan', type: 'choice', options: ['Basic', ' Pro '] },
      null,
    );
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      key: 'plan',
      type: 'choice',
      options: ['Basic', 'Pro'],
    });
    for (const body of [
      { label: 'Size', type: 'choice' },
      { label: 'Size', type: 'choice', options: ['S', 's'] },
      { label: 'Size', type: 'text', options: ['S'] },
    ]) {
      expect(
        (await refusal(apiCreateContactField(deps(), definer, body, null))).code,
        JSON.stringify(body),
      ).toBe('validation_failed');
    }
    const listed = await apiListContactFields(deps(), definer);
    expect(listed.map((f) => [f.key, f.type, f.options])).toEqual(
      expect.arrayContaining([
        ['plan', 'choice', ['Basic', 'Pro']],
        ['tier', 'choice', ['Gold', 'Silver', 'Bronze']],
        ['city', 'text', null],
      ]),
    );

    const added = await apiCreateContact(
      deps(),
      definer,
      { phone: nextPhone(), fields: { tier: 'Gold', plan: ' Pro ' } },
      null,
    );
    const contactId = (added.body.data as { id: string }).id;
    expect(await attributesOf(contactId)).toEqual({ tier: 'Gold', plan: 'Pro' });
    expect((await apiGetContact(deps(), definer, contactId)).fields).toEqual({
      tier: 'Gold',
      plan: 'Pro',
    });
    for (const value of ['gold', 'Platinum', 1, true]) {
      expect(
        await refusal(apiUpdateContact(deps(), definer, contactId, { fields: { tier: value } })),
      ).toMatchObject({ code: 'validation_failed', paths: ['fields.tier'] });
    }
    expect(await attributesOf(contactId)).toEqual({ tier: 'Gold', plan: 'Pro' });
    await apiUpdateContact(deps(), definer, contactId, { fields: { tier: 'Bronze', plan: null } });
    expect(await attributesOf(contactId)).toEqual({ tier: 'Bronze' });

    // Finding contacts by an option, whatever its case; a value that is none is refused.
    const found = await apiListContacts(deps(), definer, { 'fields[tier]': 'bronze' });
    expect(found.data.map((r) => r.id)).toEqual([contactId]);
    expect(
      await refusal(apiListContacts(deps(), definer, { 'fields[tier]': 'Platinum' })),
    ).toMatchObject({ code: 'validation_failed', paths: ['fields.tier'] });

    // Options change through PATCH under the rules Settings follows, audited as the key.
    expect(
      await refusal(apiUpdateContactField(deps(), definer, 'tier', { options: ['Gold'] })),
    ).toMatchObject({ code: 'conflict', paths: ['options'] });
    const changed = await apiUpdateContactField(deps(), definer, 'tier', {
      label: 'Level',
      options: ['Bronze', 'Gold', 'Platinum'],
    });
    expect(changed).toMatchObject({
      key: 'tier',
      label: 'Level',
      type: 'choice',
      options: ['Bronze', 'Gold', 'Platinum'],
    });
    expect(
      await refusal(apiUpdateContactField(deps(), definer, 'city', { options: ['Pune'] })),
    ).toMatchObject({ code: 'validation_failed', paths: ['options'] });
    expect(await audits(c, 'contact_field.options_changed')).toEqual([
      { metadata: { key: 'tier', options: 3, added: 1, removed: 1 } },
    ]);
  });

  it('change options only while every option contacts have chosen stays as written, under the lock', async () => {
    const { c, owner, tier } = await setup();
    const one = await contactsSvc().createContact(owner, {
      phone: nextPhone(),
      attributes: { tier: 'Silver' },
    });
    const refusedRemoval = await refusal(
      contactsSvc().setFieldOptions(owner, tier.id, ['Gold', 'Bronze']),
    );
    expect(refusedRemoval).toMatchObject({
      code: 'conflict',
      message:
        'Contacts have “Silver” chosen, so it cannot be removed or renamed. Change those contacts first.',
    });
    // A change of case is a rename.
    expect(
      (await refusal(contactsSvc().setFieldOptions(owner, tier.id, ['Gold', 'silver', 'Bronze'])))
        .code,
    ).toBe('conflict');
    expect(await optionsOf(tier.id)).toEqual(['Gold', 'Silver', 'Bronze']);

    // Unused options may go or be renamed; options may be added and reordered.
    await contactsSvc().setFieldOptions(owner, tier.id, ['Silver', 'Golden', 'Platinum']);
    expect(await optionsOf(tier.id)).toEqual(['Silver', 'Golden', 'Platinum']);
    expect(await attributesOf(one.id)).toEqual({ tier: 'Silver' });
    // The same list again changes nothing and is not audited.
    await contactsSvc().setFieldOptions(owner, tier.id, ['Silver', 'Golden', 'Platinum']);
    expect(await audits(c, 'contact_field.options_changed')).toEqual([
      { metadata: { key: 'tier', options: 3, added: 2, removed: 2 } },
    ]);
    // Values are now checked against the new options.
    expect(
      (await refusal(contactsSvc().updateContact(owner, one.id, { attributes: { tier: 'Gold' } })))
        .code,
    ).toBe('validation_failed');
    await contactsSvc().updateContact(owner, one.id, { attributes: { tier: 'platinum' } });
    expect(await attributesOf(one.id)).toEqual({ tier: 'Platinum' });

    // An erased contact holds no value, so it keeps no option.
    await contactsSvc().eraseContact(owner, { contactId: one.id, suppress: false });
    await contactsSvc().setFieldOptions(owner, tier.id, ['Silver']);
    expect(await optionsOf(tier.id)).toEqual(['Silver']);

    // Members who do not manage the settings may not; text fields have no options.
    expect(
      (await refusal(contactsSvc().setFieldOptions(await fx.ctx(c, c.agent), tier.id, ['A']))).code,
    ).toBe('forbidden');
    const city = (await contactsSvc().listFields(owner)).find((f) => f.key === 'city')!;
    expect(await refusal(contactsSvc().setFieldOptions(owner, city.id, ['Pune']))).toMatchObject({
      code: 'validation_failed',
      paths: ['options'],
    });
  });

  it('a change of options waits for a write of values holding the lock, then counts its value', async () => {
    const { owner, tier } = await setup();
    const { id } = await contactsSvc().createContact(owner, { phone: nextPhone() });
    // A write of values holds the company's contact-field lock shared, as the service takes it,
    // and stores Bronze, which the change below would remove.
    const writer = await fx.dbs.adminPool.connect();
    let change: Promise<string> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query(
        `SELECT pg_advisory_xact_lock_shared(hashtextextended('contact-fields:' || $1::text, 0))`,
        [owner.tenant.id],
      );
      await writer.query(
        `UPDATE app.contacts SET attributes = attributes || '{"tier":"Bronze"}' WHERE id = $1`,
        [id],
      );
      const [lock] = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      change = contactsSvc()
        .setFieldOptions(owner, tier.id, ['Gold', 'Silver'])
        .then(
          () => 'done',
          (error: unknown) => (isAppError(error) ? error.code : String(error)),
        );
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the change is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await writer.query('COMMIT');
      writer.release();
    }
    // The change waited, then saw the value committed and refused to remove its option.
    expect(await change).toBe('conflict');
    expect(await optionsOf(tier.id)).toEqual(['Gold', 'Silver', 'Bronze']);
  });

  it('a member’s write waits for a field being deleted, then refuses it, leaving no value behind', async () => {
    const { c, owner, tier } = await setup();
    const { id } = await contactsSvc().createContact(owner, { phone: nextPhone() });
    const agent = await fx.ctx(c, c.agent);
    const holder = await fx.dbs.adminPool.connect();
    let outcome: Promise<string> | undefined;
    try {
      // A deletion in the service's order: the field's row, then the values.
      await holder.query('BEGIN');
      await holder.query('DELETE FROM app.contact_fields WHERE id = $1', [tier.id]);
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      outcome = contactsSvc()
        .updateContact(agent, id, { attributes: { tier: 'gold' } })
        .then(
          () => 'saved',
          (error: unknown) => (isAppError(error) ? error.publicMessage : String(error)),
        );
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the write is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
      // The write waits on the field's row without holding the contact, so the deletion goes on.
      await holder.query(
        `UPDATE app.contacts SET attributes = attributes - 'tier'
          WHERE tenant_id = $1 AND attributes ? 'tier'`,
        [c.tenant.id],
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect(await outcome).toBe('Unknown custom field.');
    expect(await attributesOf(id)).toEqual({});
    // A field added again with the key finds no value left behind.
    await contactsSvc().createField(owner, {
      label: 'Tier',
      type: 'choice',
      options: ['Platinum'],
    });
    expect(await attributesOf(id)).toEqual({});
  });

  it('a bulk edit waits for a field being deleted, then refuses it, leaving no value behind', async () => {
    const { c, owner, tier } = await setup();
    const a = await contactsSvc().createContact(owner, { phone: nextPhone(), tags: ['vip'] });
    const outcome = await whileDeleting(c, tier.id, 'tier', () =>
      settled(
        contactsSvc().bulkSetField(owner, {
          filter: { tag: 'vip' },
          key: 'tier',
          value: 'Gold',
          expectedCount: 1,
        }),
      ),
    );
    expect(outcome).toBe('Choose one of the company’s custom fields.');
    expect(await attributesOf(a.id)).toEqual({});
  });

  it('a merge waits for a field being deleted, so the kept contact never takes its value', async () => {
    const { c, owner, tier } = await setup();
    const kept = await contactsSvc().createContact(owner, { phone: nextPhone() });
    // A contact without a number (as WhatsApp usernames make them) that has a value.
    const merged = uuidv7();
    await fx.query(
      `INSERT INTO app.contacts (id, tenant_id, phone_e164, source, attributes)
       VALUES ($1, $2, NULL, 'manual', '{"tier":"Gold"}')`,
      [merged, c.tenant.id],
    );
    const merges = createContactMergeService({ db: fx.dbs.app, clock: systemClock });
    const outcome = await whileDeleting(c, tier.id, 'tier', () =>
      settled(merges.mergeContacts(owner, { keepContactId: kept.id, mergeContactId: merged })),
    );
    expect(outcome).toBe('done');
    expect(await attributesOf(kept.id)).toEqual({});
    await contactsSvc().createField(owner, { label: 'Tier', type: 'choice', options: ['Silver'] });
    expect(await attributesOf(kept.id)).toEqual({});
  });

  it('a deletion waits for a write holding the field, then removes its value', async () => {
    const { c, owner, tier } = await setup();
    const { id } = await contactsSvc().createContact(owner, { phone: nextPhone() });
    // A write in the service's order (the company's lock, the field's row, then the contact),
    // written here in SQL so it can be held at a known point. This proves the deletion waits for a
    // transaction holding the field's row and its contact, then removes the value it wrote; it
    // does not prove the order inside the deletion (removing values before deleting the row would
    // also pass), which the member, bulk edit and merge races above cover from the other side.
    const writer = await fx.dbs.adminPool.connect();
    let deletion: Promise<string> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query(
        `SELECT pg_advisory_xact_lock_shared(hashtextextended('contact-fields:' || $1::text, 0))`,
        [c.tenant.id],
      );
      await writer.query('SELECT 1 FROM app.contact_fields WHERE id = $1 FOR SHARE', [tier.id]);
      await writer.query(
        `UPDATE app.contacts SET attributes = attributes || '{"tier":"Gold"}' WHERE id = $1`,
        [id],
      );
      const [lock] = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      deletion = settled(contactsSvc().deleteField(owner, tier.id));
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the deletion is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await writer.query('COMMIT');
      writer.release();
    }
    expect(await deletion).toBe('done');
    expect(await attributesOf(id)).toEqual({});
  });

  it('an import waits for a contact a field’s deletion holds, then keeps neither the deleted value nor drops the imported one', async () => {
    const { c, owner, tier } = await setup();
    const phone = nextPhone();
    const { id } = await contactsSvc().createContact(owner, {
      phone,
      attributes: { city: 'Pune', tier: 'Gold' },
    });
    const marketer = await fx.ctx(c, c.marketer);
    const importCity = () =>
      settled(
        contactsSvc().importContacts(marketer, {
          text: `Phone,City\r\n${phone},Delhi`,
          fileName: 'cities.csv',
          mapping: { phone: 0, fields: { city: 1 } },
          phoneFormat: 'international',
          updateExisting: true,
          consent: { mode: 'none' },
        }),
      );
    // The deletion removes the value, holding the contact, while the import starts.
    expect(await whileDeleting(c, tier.id, 'tier', importCity, true)).toBe('done');
    expect(await attributesOf(id)).toEqual({ city: 'Delhi' });
  });

  it('an import waits for a member’s change of another field, then keeps it', async () => {
    const { c, owner } = await setup();
    const phone = nextPhone();
    const { id } = await contactsSvc().createContact(owner, {
      phone,
      attributes: { city: 'Pune' },
    });
    const marketer = await fx.ctx(c, c.marketer);
    const holder = await fx.dbs.adminPool.connect();
    let outcome: Promise<string> | undefined;
    try {
      // A member's change as the service makes it: the contact locked, then written.
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM app.contacts WHERE id = $1 FOR UPDATE', [id]);
      await holder.query(
        `UPDATE app.contacts SET attributes = attributes || '{"tier":"Silver"}' WHERE id = $1`,
        [id],
      );
      const [lock] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
      outcome = settled(
        contactsSvc().importContacts(marketer, {
          text: `Phone,City\r\n${phone},Delhi`,
          fileName: 'cities.csv',
          mapping: { phone: 0, fields: { city: 1 } },
          phoneFormat: 'international',
          updateExisting: true,
          consent: { mode: 'none' },
        }),
      );
      await vi.waitFor(
        async () => {
          const [waiting] = await fx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity a WHERE $1 = ANY (pg_blocking_pids(a.pid))',
            [lock!.pid],
          );
          if (waiting!.n < 1) throw new Error('the import is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect(await outcome).toBe('done');
    expect(await attributesOf(id)).toEqual({ city: 'Delhi', tier: 'Silver' });
  });

  it('a bulk edit and a field’s deletion over two contacts both finish, locking contacts in id order', async () => {
    const { owner, tier } = await setup();
    // Created in turn, so the first has the lower id (UUIDv7).
    const first = await contactsSvc().createContact(owner, {
      phone: nextPhone(),
      tags: ['vip'],
      attributes: { tier: 'Gold' },
    });
    const second = await contactsSvc().createContact(owner, {
      phone: nextPhone(),
      tags: ['vip'],
      attributes: { tier: 'Silver' },
    });
    expect(first.id < second.id).toBe(true);
    const blocked = async () =>
      (
        await fx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
        )
      )[0]!.n;
    const holder = await fx.dbs.adminPool.connect();
    let bulk: Promise<string> | undefined;
    let deletion: Promise<string> | undefined;
    try {
      // The second contact is held, so the bulk edit locks the first and waits for the second.
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM app.contacts WHERE id = $1 FOR UPDATE', [second.id]);
      bulk = settled(
        contactsSvc().bulkSetField(owner, {
          filter: { tag: 'vip' },
          key: 'city',
          value: 'Pune',
          expectedCount: 2,
        }),
      );
      await vi.waitFor(
        async () => {
          if ((await blocked()) < 1) throw new Error('the bulk edit is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
      // The deletion locks the contacts with a value in id order: it waits for the first.
      deletion = settled(contactsSvc().deleteField(owner, tier.id));
      await vi.waitFor(
        async () => {
          if ((await blocked()) < 2) throw new Error('the deletion is not waiting yet');
        },
        { timeout: 4_000, interval: 20 },
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect(await bulk).toBe('done');
    expect(await deletion).toBe('done');
    expect(await attributesOf(first.id)).toEqual({ city: 'Pune' });
    expect(await attributesOf(second.id)).toEqual({ city: 'Pune' });
  });

  it('refuse more keys in one change than a company can have fields, before locking any', async () => {
    const { owner } = await setup();
    const { id } = await contactsSvc().createContact(owner, { phone: nextPhone() });
    const attributes = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'x']));
    expect(await refusal(contactsSvc().updateContact(owner, id, { attributes }))).toMatchObject({
      code: 'validation_failed',
      paths: ['attributes'],
    });
  });

  it('compare a choice in segments as text, whatever its case', async () => {
    const { owner } = await setup();
    await contactsSvc().createContact(owner, { phone: nextPhone(), attributes: { tier: 'Gold' } });
    await contactsSvc().createContact(owner, {
      phone: nextPhone(),
      attributes: { tier: 'Silver' },
    });
    await contactsSvc().createContact(owner, { phone: nextPhone() });
    const segments = createSegmentsService({ db: fx.dbs.app, clock: systemClock });
    const count = async (op: string, value?: string) =>
      (
        await segments.previewDefinition(owner, {
          match: 'all',
          conditions: [{ type: 'field', key: 'tier', op, ...(value ? { value } : {}) }],
        })
      ).count;
    expect(await count('equals', 'gold')).toBe(1);
    expect(await count('not_equals', 'GOLD')).toBe(2);
    expect(await count('is_set')).toBe(2);
    expect(await count('is_not_set')).toBe(1);
    expect(await count('equals', 'Platinum')).toBe(0);
    expect((await refusal(count('contains', 'go'))).code).toBe('validation_failed');
  });

  it('do not find another company’s field', async () => {
    const { tier } = await setup();
    const other = await fx.company();
    const stranger = await fx.ctx(other, other.owner);
    expect((await refusal(contactsSvc().setFieldOptions(stranger, tier.id, ['Gold']))).code).toBe(
      'not_found',
    );
    const key = await apiKey(other, ['contact_fields.manage']);
    expect(
      (await refusal(apiUpdateContactField(deps(), key, 'tier', { options: ['Gold'] }))).code,
    ).toBe('not_found');
    expect(await optionsOf(tier.id)).toEqual(['Gold', 'Silver', 'Bronze']);
  });

  it('hold their options in a shape the database checks too, which the runtime role may update', async () => {
    const { owner, tier } = await setup();
    const city = (await contactsSvc().listFields(owner)).find((f) => f.key === 'city')!;
    for (const options of [
      `'{}'::text[]`,
      `ARRAY[NULL]::text[]`,
      `ARRAY['Gold', NULL]`,
      `ARRAY['']`,
      `ARRAY[' Gold']`,
      `ARRAY['Gold ']`,
      `ARRAY[repeat('x', 81)]`,
      `ARRAY[E'Two\\nlines']`,
      `ARRAY[['Gold'], ['Silver']]`,
      `array_fill('x'::text, ARRAY[51])`,
      `NULL`,
    ]) {
      await expect(
        fx.query(`UPDATE app.contact_fields SET options = ${options} WHERE id = $1`, [tier.id]),
        options,
      ).rejects.toThrow(/contact_fields_options/);
    }
    await expect(
      fx.query(`UPDATE app.contact_fields SET options = ARRAY['Pune'] WHERE id = $1`, [city.id]),
    ).rejects.toThrow(/contact_fields_options/);
    await expect(
      fx.query(`UPDATE app.contact_fields SET type = 'text' WHERE id = $1`, [tier.id]),
    ).rejects.toThrow(/contact_fields_options/);
    await expect(
      fx.query(`UPDATE app.contact_fields SET type = 'select' WHERE id = $1`, [city.id]),
    ).rejects.toThrow(/contact_fields_type_check/);
    await fx.query(
      `UPDATE app.contact_fields
          SET options = array_fill(repeat('x', 80), ARRAY[48]) || ARRAY['Two words', 'Ünïcode']
        WHERE id = $1`,
      [tier.id],
    );
    const grants = await fx.query<{ c: string; ok: boolean }>(
      `SELECT c, has_column_privilege('w360_app', 'app.contact_fields', c, 'UPDATE') AS ok
         FROM unnest(ARRAY['options', 'label', 'type', 'key', 'tenant_id']) AS c`,
    );
    expect(Object.fromEntries(grants.map((g) => [g.c, g.ok]))).toEqual({
      options: true,
      label: true,
      type: false,
      key: false,
      tenant_id: false,
    });
  });
});
