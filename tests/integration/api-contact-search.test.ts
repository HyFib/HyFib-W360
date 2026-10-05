import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, systemClock, uuidv7 } from '@w360/core';
import {
  API_CONTACT_SEARCH_WINDOW,
  apiRecordConsent,
  apiSearchContacts,
  apiUpdateMatchingContacts,
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
 * windows. Also segments refusing dates that do not exist instead of failing in the query,
 * finding contacts by when they last wrote, which also needs conversations.read (ADR-126), and by
 * name, in segments and searches alike (ADR-143).
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
    // Conditions on conversations and campaigns need those scopes too (ADR-126).
    for (const condition of [
      { type: 'last_message', op: 'within_days', days: 7 },
      { type: 'campaign', campaignId: uuidv7(), outcome: 'replied' },
    ]) {
      expect(
        (await refusal(apiSearchContacts(deps(), ctx, { conditions: [condition] }))).code,
      ).toBe('forbidden');
    }
    // Malformed searches.
    for (const [body, path] of [
      [{ conditions: [{ type: 'last_message', op: 'within_days', days: 0 }] }, 'conditions.0.days'],
      [
        { conditions: [{ type: 'campaign', campaignId: 'c1', outcome: 'replied' }] },
        'conditions.0.campaignId',
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

describe('finding contacts by when they last wrote (ADR-126)', () => {
  it('finds contacts who wrote, or did not, in the last days, with conversations.read, as segments do', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const now = Math.floor(Date.now() / 1000);
    const day = 86_400;
    // Created in this order, so pages list them newest first: Dev, Chitra, Bina, Asha.
    for (const [name, wrote] of [
      ['Asha', now - 3_600],
      ['Bina', now - 10 * day],
      ['Chitra', null],
      ['Dev', now - 40 * day],
    ] as const) {
      const phone = nextPhone();
      const created = await service.createContact(owner, { displayName: name, phone });
      if (name === 'Bina') await service.addTags(owner, created.id, ['vip']);
      if (wrote !== null) {
        await fx.deliver(
          fx.messagesBody(c, {
            messages: [{ waId: phone.slice(1), text: 'Hi', timestamp: wrote }],
          }),
        );
      }
    }
    // Another company's contact who wrote today is never found.
    const other = await fx.company();
    const theirPhone = nextPhone();
    await contactsService().createContact(await fx.ctx(other, other.owner), {
      displayName: 'Theirs',
      phone: theirPhone,
    });
    await fx.deliver(fx.messagesBody(other, { messages: [{ waId: theirPhone.slice(1) }] }));

    const reader = await apiKey(c, ['contacts.read', 'conversations.read']);
    const search = async (conditions: unknown[], match = 'all') =>
      names(await apiSearchContacts(deps(), reader, { match, conditions, limit: 100 }));
    const lastMessage = (op: string, days: number) => ({ type: 'last_message', op, days });
    expect(await search([lastMessage('within_days', 7)])).toEqual(['Asha']);
    expect(await search([lastMessage('within_days', 30)])).toEqual(['Bina', 'Asha']);
    expect(await search([lastMessage('not_within_days', 7)])).toEqual(['Dev', 'Chitra', 'Bina']);
    // Contacts who never wrote are among those who did not write in the last days.
    expect(await search([lastMessage('not_within_days', 365)])).toEqual(['Chitra']);
    expect(
      await search([lastMessage('within_days', 1), { type: 'tag', op: 'has', tag: 'vip' }], 'any'),
    ).toEqual(['Bina', 'Asha']);
    expect(
      await search([lastMessage('within_days', 7), { type: 'tag', op: 'has', tag: 'vip' }]),
    ).toEqual([]);
    // The same contacts a segment with the same conditions counts.
    for (const definition of [
      { match: 'all', conditions: [lastMessage('within_days', 30)] },
      { match: 'all', conditions: [lastMessage('not_within_days', 7)] },
      {
        match: 'any',
        conditions: [lastMessage('within_days', 1), { type: 'tag', op: 'has', tag: 'vip' }],
      },
    ]) {
      const preview = await segmentsService().previewDefinition(owner, definition);
      expect((await search(definition.conditions, definition.match)).length).toBe(preview.count);
    }
    // A key that reads contacts but not conversations is refused, and so is one that reads only
    // conversations.
    for (const scopes of [['contacts.read'], ['conversations.read']] as const) {
      const key = await apiKey(c, [...scopes]);
      const r = await refusal(
        apiSearchContacts(deps(), key, { conditions: [lastMessage('within_days', 7)] }),
      );
      expect(r.code).toBe('forbidden');
    }
  });
});

describe('finding contacts by name (ADR-143)', () => {
  it('compares names as text fields are, a name of spaces only read as none, as segments do', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const kept = await service.createContact(owner, {
      displayName: 'Asha Rao',
      phone: nextPhone(),
    });
    await service.addTags(owner, kept.id, ['vip']);
    await service.createContact(owner, { displayName: 'asha', phone: nextPhone() });
    await service.createContact(owner, { displayName: 'Bina_100%', phone: nextPhone() });
    await service.createContact(owner, { phone: nextPhone() });
    // WhatsApp profile names are kept as sent: one padded with spaces, one of spaces only.
    for (const profileName of ['  Ravi Kumar  ', '   ']) {
      await fx.deliver(
        fx.messagesBody(c, { messages: [{ waId: nextPhone().slice(1), text: 'Hi', profileName }] }),
      );
    }
    // An erased contact had a matching name, and another company's contact has one.
    const gone = await service.createContact(owner, { displayName: 'Asha', phone: nextPhone() });
    await service.eraseContact(owner, { contactId: gone.id, suppress: false });
    const other = await fx.company();
    await contactsService().createContact(await fx.ctx(other, other.owner), {
      displayName: 'asha',
      phone: nextPhone(),
    });

    const ctx = await apiKey(c, ['contacts.read']);
    const search = async (conditions: unknown[], match = 'all') =>
      names(await apiSearchContacts(deps(), ctx, { match, conditions, limit: 100 }));
    const name = (op: string, value?: string) => ({
      type: 'name',
      op,
      ...(value === undefined ? {} : { value }),
    });
    // Newest first: the two WhatsApp contacts, the one without a name, then the named ones.
    expect(await search([name('equals', 'ASHA')])).toEqual(['asha']);
    expect(await search([name('equals', ' asha ')])).toEqual(['asha']);
    expect(await search([name('equals', 'ravi kumar')])).toEqual(['  Ravi Kumar  ']);
    // not_equals compares whatever the case too, and also finds contacts without a name, one of
    // spaces only included.
    expect(await search([name('not_equals', 'ASHA')])).toEqual([
      '   ',
      '  Ravi Kumar  ',
      null,
      'Bina_100%',
      'Asha Rao',
    ]);
    // contains looks for the name as written, whatever its case, never as a pattern.
    expect(await search([name('contains', 'SHA')])).toEqual(['asha', 'Asha Rao']);
    expect(await search([name('contains', 'a_')])).toEqual(['Bina_100%']);
    expect(await search([name('contains', '%')])).toEqual(['Bina_100%']);
    expect(await search([name('is_set')])).toEqual([
      '  Ravi Kumar  ',
      'Bina_100%',
      'asha',
      'Asha Rao',
    ]);
    expect(await search([name('is_not_set')])).toEqual(['   ', null]);
    expect(
      await search([name('contains', 'asha'), { type: 'tag', op: 'has', tag: 'vip' }]),
    ).toEqual(['Asha Rao']);
    expect(await search([name('is_not_set'), name('contains', 'bina')], 'any')).toEqual([
      '   ',
      null,
      'Bina_100%',
    ]);
    // The same contacts a segment with the same conditions counts, saved or previewed.
    for (const definition of [
      { match: 'all', conditions: [name('equals', 'asha')] },
      { match: 'all', conditions: [name('not_equals', 'asha')] },
      { match: 'all', conditions: [name('is_not_set')] },
      {
        match: 'any',
        conditions: [name('contains', 'ravi'), { type: 'tag', op: 'has', tag: 'vip' }],
      },
    ]) {
      const preview = await segmentsService().previewDefinition(owner, definition);
      expect((await search(definition.conditions, definition.match)).length).toBe(preview.count);
    }
    const saved = await segmentsService().createSegment(
      owner,
      { name: 'Ashas', definition: { match: 'all', conditions: [name('contains', 'asha')] } },
      {},
    );
    const segment = await segmentsService().getSegment(owner, saved.id);
    expect([segment.problem, segment.preview?.count]).toEqual([null, 2]);
  });

  it('refuses a name condition without the name it compares with, or with one it takes none of', async () => {
    const c = await fx.company();
    const owner = await fx.ctx(c, c.owner);
    const ctx = await apiKey(c, ['contacts.read']);
    for (const [condition, message] of [
      [{ type: 'name', op: 'equals' }, 'equals needs a name to compare with.'],
      [{ type: 'name', op: 'not_equals', value: '' }, 'not_equals needs a name to compare with.'],
      [{ type: 'name', op: 'contains', value: '   ' }, 'contains needs a name to compare with.'],
      [{ type: 'name', op: 'is_set', value: 'Asha' }, 'is_set takes no value.'],
      [{ type: 'name', op: 'is_not_set', value: '' }, 'is_not_set takes no value.'],
    ] as const) {
      const r = await refusal(
        apiSearchContacts(deps(), ctx, {
          conditions: [{ type: 'tag', op: 'has', tag: 'vip' }, condition],
        }),
      );
      expect([r.code, r.paths, r.message]).toEqual([
        'validation_failed',
        ['conditions.1.value'],
        message,
      ]);
    }
    for (const [condition, path] of [
      [{ type: 'name', op: 'greater_than', value: 'a' }, 'conditions.0.op'],
      [{ type: 'name', op: 'equals', value: 5 }, 'conditions.0.value'],
      [{ type: 'name', op: 'equals', value: 'a'.repeat(201) }, 'conditions.0.value'],
      [{ type: 'name', op: 'equals', value: 'a', key: 'city' }, 'conditions.0'],
    ] as const) {
      const r = await refusal(apiSearchContacts(deps(), ctx, { conditions: [condition] }));
      expect([r.code, r.paths]).toEqual(['validation_failed', [path]]);
    }
    // Segments refuse the same, in members' words.
    for (const condition of [
      { type: 'name', op: 'equals' },
      { type: 'name', op: 'contains', value: '   ' },
    ]) {
      const r = await refusal(
        segmentsService().previewDefinition(owner, { match: 'all', conditions: [condition] }),
      );
      expect([r.code, r.message]).toEqual(['validation_failed', 'Enter a name to compare with.']);
    }
    const unknown = await refusal(
      segmentsService().previewDefinition(owner, {
        match: 'all',
        conditions: [{ type: 'name', op: 'greater_than', value: 'a' }],
      }),
    );
    expect(unknown.code).toBe('validation_failed');
  });
});

describe('groups of conditions (ADR-164)', () => {
  it('finds contacts matching all of some conditions and any of others, and names a refusal inside a group by its place', async () => {
    const c = await fx.company();
    await defineFields(c);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const add = async (displayName: string, attributes: Record<string, string>, tags: string[]) => {
      const created = await service.createContact(owner, {
        displayName,
        phone: nextPhone(),
        attributes,
      });
      if (tags.length > 0) await service.addTags(owner, created.id, tags);
    };
    await add('Asha', { city: 'Pune', orders: '5' }, ['vip']);
    await add('Bina', { city: 'Delhi', orders: '1' }, ['vip']);
    await add('Chitra', { city: 'Mumbai', orders: '9' }, ['vip']);
    await add('Dev', { city: 'Pune', orders: '7' }, []);
    const ctx = await apiKey(c, ['contacts.read']);
    const inPune = { type: 'field', key: 'city', op: 'equals', value: 'pune' };
    const busy = { type: 'field', key: 'orders', op: 'greater_than', value: 6 };

    // VIPs who are in Pune or have more than 6 orders.
    const vips = await apiSearchContacts(deps(), ctx, {
      conditions: [
        { type: 'tag', op: 'has', tag: 'vip' },
        { type: 'group', match: 'any', conditions: [inPune, busy] },
      ],
    });
    expect(names(vips)).toEqual(['Chitra', 'Asha']);
    // Any of: in Pune with more than 6 orders, or in Delhi.
    const either = await apiSearchContacts(deps(), ctx, {
      match: 'any',
      conditions: [
        { type: 'group', match: 'all', conditions: [inPune, busy] },
        { type: 'field', key: 'city', op: 'equals', value: 'delhi' },
      ],
    });
    expect(names(either)).toEqual(['Dev', 'Bina']);
    // A group of one condition finds what the condition alone finds.
    const alone = await apiSearchContacts(deps(), ctx, { conditions: [busy] });
    const grouped = await apiSearchContacts(deps(), ctx, {
      conditions: [{ type: 'group', match: 'any', conditions: [busy] }],
    });
    expect(names(grouped)).toEqual(names(alone));
    expect(names(alone)).toEqual(['Dev', 'Chitra']);

    // A condition the company's fields do not allow, inside a group, is named by its place.
    expect(
      await refusal(
        apiSearchContacts(deps(), ctx, {
          conditions: [
            { type: 'tag', op: 'has', tag: 'vip' },
            {
              type: 'group',
              match: 'any',
              conditions: [inPune, { type: 'field', key: 'plan', op: 'is_set' }],
            },
          ],
        }),
      ),
    ).toEqual({
      code: 'validation_failed',
      paths: ['conditions.1.conditions.1.key'],
      message: 'The company has no custom field with the key plan (GET /contact-fields).',
    });
    // So is a campaign the company does not have.
    const withCampaigns = await apiKey(c, ['contacts.read', 'campaigns.read']);
    const missing = await refusal(
      apiSearchContacts(deps(), withCampaigns, {
        conditions: [
          {
            type: 'group',
            match: 'any',
            conditions: [inPune, { type: 'campaign', campaignId: uuidv7(), outcome: 'delivered' }],
          },
        ],
      }),
    );
    expect(missing.paths).toEqual(['conditions.0.conditions.1.campaignId']);
  });
});

describe('changing the contacts a search finds (ADR-165)', () => {
  it('changes each page of the contacts a search finds as PATCH changes one, until the cursor is null', async () => {
    const c = await fx.company();
    await defineFields(c);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    for (const [displayName, city] of [
      ['Asha', 'Pune'],
      ['Bina', 'Delhi'],
      ['Chitra', 'Pune'],
      ['Dev', 'Pune'],
      ['Esha', null],
    ] as const) {
      await service.createContact(owner, {
        displayName,
        phone: nextPhone(),
        attributes: city ? { city } : {},
      });
    }
    // Another company's contact matches the same conditions and is never changed.
    const other = await fx.company();
    await defineFields(other);
    const theirs = await contactsService().createContact(await fx.ctx(other, other.owner), {
      displayName: 'Theirs',
      phone: nextPhone(),
      attributes: { city: 'Pune' },
    });

    const ctx = await apiKey(c, ['contacts.read', 'contacts.write']);
    const call = (cursor?: string | null) =>
      apiUpdateMatchingContacts(deps(), ctx, {
        conditions: [
          { type: 'field', key: 'city', op: 'equals', value: 'pune' },
          { type: 'tag', op: 'not_has', tag: 'local' },
        ],
        change: { addTags: ['local'], fields: { orders: 1 } },
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
    const first = await call();
    expect(names(first)).toEqual(['Dev', 'Chitra']);
    expect(first.data.map((contact) => [contact.tags, contact.fields])).toEqual([
      [['local'], { city: 'Pune', orders: 1 }],
      [['local'], { city: 'Pune', orders: 1 }],
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await call(first.nextCursor);
    expect([names(second), second.nextCursor]).toEqual([['Asha'], null]);
    // From the start again, nothing matches: the change took every contact out of the search.
    expect(await call()).toEqual({ data: [], nextCursor: null });

    const tagged = await apiSearchContacts(deps(), ctx, {
      conditions: [{ type: 'tag', op: 'has', tag: 'local' }],
    });
    expect(names(tagged)).toEqual(['Dev', 'Chitra', 'Asha']);
    expect(
      await fx.query('SELECT 1 FROM app.contact_tags WHERE contact_id = $1', [theirs.id]),
    ).toHaveLength(0);
    // Each contact changed is audited as the key, as PATCH /contacts/{id} audits one.
    const audits = await fx.query<{ actor_type: string; changed: string[] }>(
      `SELECT actor_type, metadata->'changed' AS changed FROM app.audit_events
        WHERE tenant_id = $1 AND action = 'contact.updated' ORDER BY occurred_at, id`,
      [c.tenant.id],
    );
    expect(audits).toEqual(
      Array.from({ length: 3 }, () => ({ actor_type: 'api_key', changed: ['fields', 'tags'] })),
    );

    // A field the company does not have refuses the call by its part, changing nothing.
    const refused = await refusal(
      apiUpdateMatchingContacts(deps(), ctx, {
        conditions: [{ type: 'field', key: 'city', op: 'is_set' }],
        change: { addTags: ['checked'], fields: { plan: 'gold' } },
      }),
    );
    expect([refused.code, refused.paths]).toEqual(['validation_failed', ['change.fields.plan']]);
    const checked = await apiSearchContacts(deps(), ctx, {
      conditions: [{ type: 'tag', op: 'has', tag: 'checked' }],
    });
    expect(checked.data).toEqual([]);
    // A key that can only write contacts cannot search them to change them.
    const writer = await apiKey(c, ['contacts.write']);
    expect(
      (
        await refusal(
          apiUpdateMatchingContacts(deps(), writer, {
            conditions: [{ type: 'field', key: 'city', op: 'is_set' }],
            change: { addTags: ['x'] },
          }),
        )
      ).code,
    ).toBe('forbidden');
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
