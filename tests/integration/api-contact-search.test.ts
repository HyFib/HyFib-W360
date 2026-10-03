import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import {
  API_CONTACT_SEARCH_WINDOW,
  apiRecordConsent,
  apiSearchContacts,
  authenticateApiToken,
  createApiKeysService,
  createContactsService,
  createSegmentsService,
  type ApiContext,
  type ApiScope,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Finding contacts with segments' conditions through the public API (ADR-117) against real
 * PostgreSQL: every comparison of each type of custom field, tags, consent, the day a contact was
 * added in the company's time zone, source and calling code, all or any of them; the same contacts
 * a segment with the same conditions counts; refusals naming the condition's part; pages read in
 * windows. Also segments refusing dates that do not exist instead of failing in the query.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx?.close();
});

const deps = () => ({ db: fx.dbs.app, clock: systemClock });
const contactsService = () => createContactsService({ db: fx.dbs.app, clock: systemClock });
const segmentsService = () => createSegmentsService({ db: fx.dbs.app, clock: systemClock });

let phoneSeq = 0;
const nextPhone = () => `+9198333${String(40000 + (phoneSeq += 1)).padStart(5, '0')}`;

/** A key of the company created by its owner, and the context a request with it gets. */
async function apiKey(c: Company, scopes: ApiScope[]): Promise<ApiContext> {
  const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
  const created = await keys.create(await fx.ctx(c, c.owner), {
    name: 'Contact search',
    scopes,
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

/** The code of a refusal, the paths it names and its message. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      code: error.code,
      paths: (error.issues ?? []).map((i) => i.path),
      message: error.publicMessage,
    };
  }
  throw new Error('expected a refusal');
}

/** The company's four kinds of fields. */
async function defineFields(c: Company) {
  const owner = await fx.ctx(c, c.owner);
  const service = contactsService();
  await service.createField(owner, { label: 'City', key: 'city', type: 'text' });
  await service.createField(owner, { label: 'Orders', key: 'orders', type: 'number' });
  await service.createField(owner, { label: 'Birthday', key: 'birthday', type: 'date' });
  await service.createField(owner, { label: 'VIP', key: 'vip', type: 'boolean' });
}

const names = (page: { data: { name: string | null }[] }) => page.data.map((c) => c.name);

describe('searching contacts with segment conditions (ADR-117)', () => {
  it('compares custom fields as segments do, with each comparison of each type', async () => {
    const c = await fx.company();
    await defineFields(c);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    for (const [displayName, attributes] of [
      ['Asha', { city: 'Pune', orders: '3', birthday: '1990-04-01', vip: 'yes' }],
      ['Bina', { city: 'pune', orders: '3.5', vip: 'no' }],
      ['Chitra', { city: 'Delhi', orders: '30' }],
      ['Dev', { city: '100%_off' }],
      ['Esha', {}],
    ] as const) {
      await service.createContact(owner, { displayName, phone: nextPhone(), attributes });
    }
    // An erased contact had a value, and another company's contact has the same ones.
    const gone = await service.createContact(owner, {
      displayName: 'Gone',
      phone: nextPhone(),
      attributes: { city: 'Pune', orders: '3' },
    });
    await service.eraseContact(owner, { contactId: gone.id, suppress: false });
    const other = await fx.company();
    await defineFields(other);
    await contactsService().createContact(await fx.ctx(other, other.owner), {
      displayName: 'Theirs',
      phone: nextPhone(),
      attributes: { city: 'Pune', orders: '3' },
    });

    const ctx = await apiKey(c, ['contacts.read']);
    const find = async (key: string, op: string, value?: string | number) =>
      names(
        await apiSearchContacts(deps(), ctx, {
          conditions: [{ type: 'field', key, op, ...(value === undefined ? {} : { value }) }],
        }),
      );
    // Text: whatever its case; contains looks for the text as written, never as a pattern.
    expect(await find('city', 'equals', 'PUNE')).toEqual(['Bina', 'Asha']);
    expect(await find('city', 'not_equals', ' pune ')).toEqual(['Esha', 'Dev', 'Chitra']);
    expect(await find('city', 'contains', 'UN')).toEqual(['Bina', 'Asha']);
    expect(await find('city', 'contains', '%_')).toEqual(['Dev']);
    expect(await find('city', 'is_set')).toEqual(['Dev', 'Chitra', 'Bina', 'Asha']);
    expect(await find('city', 'is_not_set')).toEqual(['Esha']);
    // Numbers as numbers, given as numbers or strings.
    expect(await find('orders', 'greater_than', 3)).toEqual(['Chitra', 'Bina']);
    expect(await find('orders', 'greater_than', '3')).toEqual(['Chitra', 'Bina']);
    expect(await find('orders', 'less_than', 3.5)).toEqual(['Asha']);
    expect(await find('orders', 'equals', '3.0')).toEqual(['Asha']);
    expect(await find('orders', 'not_equals', 3)).toEqual(['Esha', 'Dev', 'Chitra', 'Bina']);
    // Dates as written, yes/no as true or false.
    expect(await find('birthday', 'before', '1991-01-01')).toEqual(['Asha']);
    expect(await find('birthday', 'after', '1990-04-01')).toEqual([]);
    expect(await find('birthday', 'equals', '1990-04-01')).toEqual(['Asha']);
    expect(await find('vip', 'is_true')).toEqual(['Asha']);
    expect(await find('vip', 'is_false')).toEqual(['Bina']);
    expect(await find('vip', 'is_not_set')).toEqual(['Esha', 'Dev', 'Chitra']);
    // Two conditions: all of them by default, or any.
    const both = [
      { type: 'field', key: 'city', op: 'equals', value: 'pune' },
      { type: 'field', key: 'orders', op: 'greater_than', value: 3 },
    ];
    expect(names(await apiSearchContacts(deps(), ctx, { conditions: both }))).toEqual(['Bina']);
    expect(names(await apiSearchContacts(deps(), ctx, { match: 'any', conditions: both }))).toEqual(
      ['Chitra', 'Bina', 'Asha'],
    );
    // Pages: a limit splits them, and the cursor goes on from the last contact shown.
    const first = await apiSearchContacts(deps(), ctx, {
      conditions: [{ type: 'field', key: 'city', op: 'is_set' }],
      limit: 3,
    });
    expect(names(first)).toEqual(['Dev', 'Chitra', 'Bina']);
    const second = await apiSearchContacts(deps(), ctx, {
      conditions: [{ type: 'field', key: 'city', op: 'is_set' }],
      limit: 3,
      cursor: first.nextCursor,
    });
    expect([names(second), second.nextCursor]).toEqual([['Asha'], null]);
  });

  it('finds contacts by tag, consent, the day they were added in the company’s time zone, source and calling code', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const writer = await apiKey(c, ['contacts.write']);
    const add = async (displayName: string, phone: string, createdAt: string, source: string) => {
      const created = await service.createContact(owner, { displayName, phone });
      await fx.query('UPDATE app.contacts SET created_at = $2, source = $3 WHERE id = $1', [
        created.id,
        createdAt,
        source,
      ]);
      return created.id;
    };
    // The company's day is India's (Asia/Kolkata, UTC+05:30): 19:00 UTC on 30 September is
    // already 1 October there, and 17:00 UTC is still 30 September.
    const kiran = await add('Kiran', '+919811100001', '2026-09-30T19:00:00Z', 'api');
    const lata = await add('Lata', '+14155550123', '2026-09-30T17:00:00Z', 'import');
    const mani = await add('Mani', '+919811100002', '2026-10-02T06:00:00Z', 'manual');
    await service.addTags(owner, kiran, ['vip']);
    await service.addTags(owner, lata, ['vip', 'new']);
    const evidence = 'Signed up on the website';
    await apiRecordConsent(deps(), writer, lata, {
      purpose: 'marketing',
      action: 'opt_in',
      evidence,
    });
    await apiRecordConsent(deps(), writer, mani, {
      purpose: 'marketing',
      action: 'opt_out',
      evidence,
    });
    await apiRecordConsent(deps(), writer, mani, {
      purpose: 'utility',
      action: 'opt_in',
      evidence,
    });

    const ctx = await apiKey(c, ['contacts.read']);
    const find = async (conditions: unknown[], match?: string) =>
      names(await apiSearchContacts(deps(), ctx, { conditions, ...(match ? { match } : {}) }));
    expect(await find([{ type: 'tag', op: 'has', tag: ' VIP ' }])).toEqual(['Kiran', 'Lata']);
    expect(await find([{ type: 'tag', op: 'not_has', tag: 'new' }])).toEqual(['Mani', 'Kiran']);
    expect(await find([{ type: 'consent', purpose: 'marketing', status: 'opted_in' }])).toEqual([
      'Lata',
    ]);
    expect(await find([{ type: 'consent', purpose: 'marketing', status: 'opted_out' }])).toEqual([
      'Mani',
    ]);
    expect(await find([{ type: 'consent', purpose: 'marketing', status: 'not_recorded' }])).toEqual(
      ['Kiran'],
    );
    expect(await find([{ type: 'consent', purpose: 'utility', status: 'opted_in' }])).toEqual([
      'Mani',
    ]);
    expect(await find([{ type: 'created', op: 'before', date: '2026-10-01' }])).toEqual(['Lata']);
    expect(await find([{ type: 'created', op: 'after', date: '2026-09-30' }])).toEqual([
      'Mani',
      'Kiran',
    ]);
    expect(await find([{ type: 'created', op: 'after', date: '2026-10-01' }])).toEqual(['Mani']);
    expect(await find([{ type: 'source', source: 'import' }])).toEqual(['Lata']);
    expect(await find([{ type: 'calling_code', prefix: '1' }])).toEqual(['Lata']);
    expect(await find([{ type: 'calling_code', prefix: '91' }])).toEqual(['Mani', 'Kiran']);
    expect(
      await find(
        [
          { type: 'calling_code', prefix: '91' },
          { type: 'consent', purpose: 'marketing', status: 'not_recorded' },
        ],
        'all',
      ),
    ).toEqual(['Kiran']);
    expect(
      await find(
        [
          { type: 'source', source: 'import' },
          { type: 'tag', op: 'has', tag: 'vip' },
        ],
        'any',
      ),
    ).toEqual(['Kiran', 'Lata']);
  });

  it('finds the contacts a segment with the same conditions counts', async () => {
    const c = await fx.company();
    await defineFields(c);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    for (let n = 0; n < 12; n += 1) {
      const created = await service.createContact(owner, {
        displayName: `Member ${n}`,
        phone: n % 3 === 0 ? `+1415555${String(1000 + n)}` : nextPhone(),
        attributes: { orders: String(n), city: n % 2 === 0 ? 'Pune' : 'Delhi' },
      });
      if (n % 4 === 0) await service.addTags(owner, created.id, ['vip']);
    }
    const ctx = await apiKey(c, ['contacts.read']);
    for (const definition of [
      {
        match: 'all',
        conditions: [
          { type: 'field', key: 'orders', op: 'greater_than', value: '4' },
          { type: 'field', key: 'city', op: 'equals', value: 'pune' },
        ],
      },
      {
        match: 'any',
        conditions: [
          { type: 'tag', op: 'has', tag: 'vip' },
          { type: 'calling_code', prefix: '1' },
        ],
      },
      {
        match: 'all',
        conditions: [
          { type: 'tag', op: 'not_has', tag: 'vip' },
          { type: 'field', key: 'orders', op: 'less_than', value: '7' },
        ],
      },
    ]) {
      const preview = await segmentsService().previewDefinition(owner, definition);
      const found = await apiSearchContacts(deps(), ctx, { ...definition, limit: 100 });
      expect(found.data.length).toBe(preview.count);
      expect(found.data.length).toBeGreaterThan(0);
    }
  });

  it('refuses conditions the company’s fields do not allow, naming them, and keys without contacts.read', async () => {
    const c = await fx.company();
    await defineFields(c);
    const other = await fx.company();
    await contactsService().createField(await fx.ctx(other, other.owner), {
      label: 'Region',
      key: 'region',
      type: 'text',
    });
    const ctx = await apiKey(c, ['contacts.read']);
    const field = (key: string, op: string, value?: unknown) => ({
      type: 'field',
      key,
      op,
      ...(value === undefined ? {} : { value }),
    });
    for (const [condition, path, message] of [
      [
        field('nope', 'is_set'),
        'conditions.1.key',
        'The company has no custom field with the key nope (GET /contact-fields).',
      ],
      [
        field('region', 'equals', 'North'),
        'conditions.1.key',
        'The company has no custom field with the key region (GET /contact-fields).',
      ],
      [
        field('city', 'greater_than', 'a'),
        'conditions.1.op',
        'greater_than does not apply to text fields: use is_set, is_not_set, equals, not_equals, contains.',
      ],
      [
        field('vip', 'equals', 'true'),
        'conditions.1.op',
        'equals does not apply to boolean fields: use is_set, is_not_set, is_true, is_false.',
      ],
      [field('orders', 'equals'), 'conditions.1.value', 'equals needs a value to compare with.'],
      [
        field('city', 'contains', '  '),
        'conditions.1.value',
        'contains needs a value to compare with.',
      ],
      [field('vip', 'is_true', 'false'), 'conditions.1.value', 'is_true takes no value.'],
      [
        field('orders', 'greater_than', 'three'),
        'conditions.1.value',
        'Give a number with at most 15 digits before the point and 6 after.',
      ],
      [
        field('orders', 'less_than', 1e21),
        'conditions.1.value',
        'Give a number with at most 15 digits before the point and 6 after.',
      ],
      [
        field('birthday', 'before', '1990-02-30'),
        'conditions.1.value',
        'Give a date written as YYYY-MM-DD.',
      ],
      [
        field('city', 'equals', 5),
        'conditions.1.value',
        'city is a text field: give the value as a string.',
      ],
      [
        { type: 'tag', op: 'has', tag: 'a,b' },
        'conditions.1.tag',
        'Tags cannot contain commas or control characters.',
      ],
      [
        { type: 'created', op: 'before', date: '2026-02-30' },
        'conditions.1.date',
        'Give a date written as YYYY-MM-DD.',
      ],
    ] as const) {
      const r = await refusal(
        apiSearchContacts(deps(), ctx, {
          conditions: [{ type: 'tag', op: 'has', tag: 'vip' }, condition],
        }),
      );
      expect([r.code, r.paths, r.message]).toEqual(['validation_failed', [path], message]);
    }
    // Conditions segments have but keys may not use, and malformed searches.
    for (const [body, path] of [
      [{ conditions: [{ type: 'last_message', op: 'within_days', days: 7 }] }, 'conditions.0.type'],
      [
        { conditions: [{ type: 'campaign', campaignId: uuidv7(), outcome: 'replied' }] },
        'conditions.0.type',
      ],
      [{ conditions: [] }, 'conditions'],
      [{ conditions: Array.from({ length: 21 }, () => field('city', 'is_set')) }, 'conditions'],
      [{ conditions: [field('city', 'is_set')], match: 'none' }, 'match'],
      [{ conditions: [field('city', 'is_set')], limit: 101 }, 'limit'],
      [{ conditions: [{ ...field('city', 'is_set'), extra: 1 }] }, 'conditions.0'],
      [{ conditions: [field('city', 'is_set')], sort: 'name' }, ''],
    ] as const) {
      const r = await refusal(apiSearchContacts(deps(), ctx, body));
      expect([r.code, r.paths]).toEqual(['validation_failed', [path]]);
    }
    const garbled = await refusal(
      apiSearchContacts(deps(), ctx, { conditions: [field('city', 'is_set')], cursor: 'x' }),
    );
    expect(garbled.code).toBe('validation_failed');
    const writer = await apiKey(c, ['contacts.write']);
    expect(
      (await refusal(apiSearchContacts(deps(), writer, { conditions: [field('city', 'is_set')] })))
        .code,
    ).toBe('forbidden');
  });

  it('reads in windows, so pages can be short or empty but never skip or repeat a contact', async () => {
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
    const ctx = await apiKey(c, ['contacts.read']);
    const pages = async (body: Record<string, unknown>) => {
      const seen: (string | null)[][] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = await apiSearchContacts(deps(), ctx, cursor ? { ...body, cursor } : body);
        seen.push(names(page));
        if (!page.nextCursor) return seen;
        cursor = page.nextCursor;
      }
      throw new Error('the pages did not end');
    };
    const edge = API_CONTACT_SEARCH_WINDOW;
    const pune = ['Bulk 1', 'Bulk 2', `Bulk ${edge}`, `Bulk ${edge + 1}`, `Bulk ${total - 1}`];
    pune.push(`Bulk ${total}`);
    const isPune = { type: 'field', key: 'city', op: 'equals', value: 'pune' };
    // The first window ends at its 2,000th contact; the next one goes on from just past it.
    expect(await pages({ conditions: [isPune] })).toEqual([pune.slice(0, 3), pune.slice(3)]);
    // A limit of one splits windows too, never skipping or repeating.
    expect((await pages({ conditions: [isPune], limit: 1 })).flat()).toEqual(pune);
    // A window can show nothing and still give the cursor past it (these contacts have no number).
    expect(await pages({ conditions: [{ type: 'calling_code', prefix: '1' }] })).toEqual([[], []]);
    // Several conditions are checked in the same windows.
    const containsPun = { type: 'field', key: 'city', op: 'contains', value: 'PUN' };
    expect((await pages({ match: 'all', conditions: [containsPun, isPune] })).flat()).toEqual(pune);
  });
});

describe('segments with dates that do not exist (ADR-117)', () => {
  it('refuses a creation day or a date comparison that does not exist, instead of failing in the query', async () => {
    const c = await fx.company();
    await defineFields(c);
    const owner = await fx.ctx(c, c.owner);
    for (const condition of [
      { type: 'created', op: 'before', date: '2026-02-30' },
      { type: 'field', key: 'birthday', op: 'after', value: '1990-13-01' },
    ]) {
      const r = await refusal(
        segmentsService().previewDefinition(owner, { match: 'all', conditions: [condition] }),
      );
      expect([r.code, r.message]).toEqual([
        'validation_failed',
        'Enter a date written as YYYY-MM-DD.',
      ]);
    }
    // A real day still works.
    const preview = await segmentsService().previewDefinition(owner, {
      match: 'all',
      conditions: [{ type: 'created', op: 'before', date: '2026-02-28' }],
    });
    expect(preview.count).toBe(0);
  });
});
