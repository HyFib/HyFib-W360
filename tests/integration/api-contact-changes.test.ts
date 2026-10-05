import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, Keyring, systemClock, uuidv7 } from '@w360/core';
import {
  apiContactChanges,
  apiCreateContact,
  apiGetContact,
  apiRecordConsent,
  apiUpdateContact,
  authenticateApiToken,
  compactContactChanges,
  createApiKeysService,
  createContactsService,
  sealContactChangeCursor,
  type ApiContactChange,
  type ApiContext,
  type ApiScope,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Following contact changes through the public API (ADR-114) against real PostgreSQL: every
 * contact once, at its latest change, in the order the changes were saved; what counts as a change
 * (name, email, custom field values and a field's deletion, tags, consent states, erasure) and what
 * does not; a cursor that never passes a change still being saved; the compaction, which deletes
 * the changes later ones replaced without changing what the feed reads and never passes a change
 * still being saved either; and cursors sealed to their company.
 */
let fx: WhatsAppFixture;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
});

afterAll(async () => {
  await fx?.close();
});

const deps = () => ({ db: fx.dbs.app, clock: systemClock, jobs: fx.jobs(), signer: fx.signer });
const feedDeps = () => ({ db: fx.dbs.app, keyring: fx.keyring });
const contactsService = () => createContactsService({ db: fx.dbs.app, clock: systemClock });

let phoneSeq = 0;
const nextPhone = () => `+9198222${String(30000 + (phoneSeq += 1)).padStart(5, '0')}`;

/** A key of the company created by its owner, and the context a request with it gets. */
async function apiKey(c: Company, scopes: ApiScope[]): Promise<ApiContext> {
  const keys = createApiKeysService({ db: fx.dbs.app, clock: systemClock });
  const created = await keys.create(await fx.ctx(c, c.owner), {
    name: 'Contact sync',
    scopes,
    expiresInDays: 0,
  });
  const ctx = await authenticateApiToken(fx.dbs.app, created.token, uuidv7());
  if (!ctx) throw new Error('a new key does not authenticate');
  return ctx;
}

/** Every page from `cursor` until `hasMore` is false: the changes and the last `nextCursor`. */
async function readFeed(ctx: ApiContext, cursor?: string, limit = 100) {
  const changes: ApiContactChange[] = [];
  let next = cursor;
  for (let pages = 0; pages < 1_000; pages += 1) {
    const page = await apiContactChanges(feedDeps(), ctx, {
      limit: String(limit),
      ...(next === undefined ? {} : { cursor: next }),
    });
    changes.push(...page.data);
    next = page.nextCursor;
    if (!page.hasMore) return { changes, cursor: next };
  }
  throw new Error('the feed did not end');
}

const ids = (changes: ApiContactChange[]) => changes.map((c) => c.id);

async function createContact(ctx: ApiContext, name: string, extra: Record<string, unknown> = {}) {
  const created = await apiCreateContact(deps(), ctx, { phone: nextPhone(), name, ...extra }, null);
  return (created.body as { data: { id: string } }).data.id;
}

const rowsOf = async (contactId: string) =>
  (
    await fx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.contact_changes WHERE contact_id = $1',
      [contactId],
    )
  )[0]!.n;

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

describe('following contact changes through the public API (ADR-114)', () => {
  it('reads every contact once, at its latest change, in the order the changes were saved, and a cursor reads what changed since', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['contacts.read', 'contacts.write']);
    const asha = await createContact(ctx, 'Asha');
    const bala = await createContact(ctx, 'Bala');
    const chitra = await createContact(ctx, 'Chitra');

    const first = await readFeed(ctx);
    expect(ids(first.changes)).toEqual([asha, bala, chitra]);
    expect(first.changes[0]).toEqual({
      id: asha,
      erased: false,
      contact: await apiGetContact(deps(), ctx, asha),
    });

    await apiUpdateContact(deps(), ctx, asha, { name: 'Asha K' });
    const all = await readFeed(ctx);
    expect(ids(all.changes)).toEqual([bala, chitra, asha]);
    expect(all.changes[2]!.contact?.name).toBe('Asha K');
    const since = await readFeed(ctx, first.cursor);
    expect(ids(since.changes)).toEqual([asha]);

    // A tag, then a consent state set and changed; the same opt-in again leaves it as it is.
    await apiUpdateContact(deps(), ctx, bala, { addTags: ['vip'] });
    const tagged = await readFeed(ctx, since.cursor);
    expect(tagged.changes.map((ch) => [ch.id, ch.contact?.tags])).toEqual([[bala, ['vip']]]);
    const consent = { purpose: 'marketing', action: 'opt_in', evidence: 'Checkout form' };
    await apiRecordConsent(deps(), ctx, chitra, consent);
    const consented = await readFeed(ctx, tagged.cursor);
    expect(consented.changes.map((ch) => [ch.id, ch.contact?.consent.marketing])).toEqual([
      [chitra, 'opted_in'],
    ]);
    await apiRecordConsent(deps(), ctx, chitra, consent);
    expect((await readFeed(ctx, consented.cursor)).changes).toEqual([]);
    await apiRecordConsent(deps(), ctx, chitra, { ...consent, action: 'opt_out' });
    const withdrawn = await readFeed(ctx, consented.cursor);
    expect(withdrawn.changes.map((ch) => [ch.id, ch.contact?.consent.marketing])).toEqual([
      [chitra, 'opted_out'],
    ]);
    // Nor do a name the contact already has, a column written with its own value, or a write
    // of the row's times alone.
    await apiUpdateContact(deps(), ctx, asha, { name: 'Asha K' });
    await fx.query(
      'UPDATE app.contacts SET display_name = display_name, attributes = attributes WHERE id = $1',
      [asha],
    );
    await fx.query('UPDATE app.contacts SET updated_at = now() WHERE id = $1', [bala]);
    const unchanged = await readFeed(ctx, withdrawn.cursor);
    expect(unchanged.changes).toEqual([]);
    // An empty page keeps the place it was given. A request changing several things is one
    // change.
    const rows = await rowsOf(bala);
    await apiUpdateContact(deps(), ctx, bala, { name: 'Bala R', addTags: ['new'] });
    expect(await rowsOf(bala)).toBe(rows + 1);
    expect(ids((await readFeed(ctx, unchanged.cursor)).changes)).toEqual([bala]);

    // One contact a page: the same contacts in the same order, never one twice.
    const paged: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await apiContactChanges(feedDeps(), ctx, {
        limit: '1',
        ...(cursor === undefined ? {} : { cursor }),
      });
      paged.push(...ids(page.data));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
      expect(page.data).toHaveLength(1);
    }
    expect(paged).toEqual([asha, chitra, bala]);
  });

  it('records a change whoever makes it: tags added and removed, custom field values, a field’s deletion, the email, the number, erasure', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['contacts.read', 'contacts.write']);
    const owner = await fx.ctx(c, c.owner);
    const service = contactsService();
    const city = await service.createField(owner, { label: 'City', key: 'city', type: 'text' });
    const withCity = await createContact(ctx, 'Devi', { fields: { city: 'Pune' } });
    const without = await createContact(ctx, 'Elan');
    let at = (await readFeed(ctx)).cursor;
    const next = async () => {
      const read = await readFeed(ctx, at);
      at = read.cursor;
      return read.changes;
    };

    await service.addTags(owner, withCity, ['gold']);
    expect(ids(await next())).toEqual([withCity]);
    await service.removeTag(owner, withCity, 'gold');
    expect((await next()).map((ch) => [ch.id, ch.contact?.tags])).toEqual([[withCity, []]]);
    await apiUpdateContact(deps(), ctx, withCity, { fields: { city: 'Delhi' } });
    expect((await next()).map((ch) => ch.contact?.fields)).toEqual([{ city: 'Delhi' }]);
    await apiUpdateContact(deps(), ctx, withCity, { email: 'devi@example.com' });
    expect((await next()).map((ch) => ch.contact?.email)).toEqual(['devi@example.com']);
    const newPhone = nextPhone();
    await service.updateContact(owner, withCity, { displayName: 'Devi', phone: newPhone });
    expect((await next()).map((ch) => ch.contact?.phone)).toEqual([newPhone]);

    // A field's deletion removes its values: each contact that had one changed.
    await service.deleteField(owner, city.id);
    expect((await next()).map((ch) => [ch.id, ch.contact?.fields])).toEqual([[withCity, {}]]);

    const phone = (await apiGetContact(deps(), ctx, withCity)).phone!;
    await service.eraseContact(owner, { contactId: withCity, suppress: false });
    const erased = await next();
    expect(erased).toEqual([{ id: withCity, erased: true, contact: null }]);
    expect(JSON.stringify(erased)).not.toContain(phone.slice(1));
    // From the start: each contact once, the erased one as erased.
    expect(
      (await readFeed(ctx)).changes.map((ch) => [ch.id, ch.erased, ch.contact?.name ?? null]),
    ).toEqual([
      [without, false, 'Elan'],
      [withCity, true, null],
    ]);
  });

  it('never reads past a change still being saved, so following the cursor misses nothing', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['contacts.read', 'contacts.write']);
    const held = await createContact(ctx, 'Farah');
    const later = await createContact(ctx, 'Gopal');
    const last = await createContact(ctx, 'Hema');
    const start = await readFeed(ctx);
    expect(ids(start.changes)).toEqual([held, later, last]);

    const holder = await fx.dbs.adminPool.connect();
    let during: Awaited<ReturnType<typeof readFeed>>;
    let fromStart: Awaited<ReturnType<typeof readFeed>>;
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE app.contacts SET display_name = 'Farah S' WHERE id = $1`, [held]);
      // Saved after the held change began, and committed first.
      await apiUpdateContact(deps(), ctx, later, { name: 'Gopal N' });
      // Saved last, by the transaction that began first.
      await holder.query(`UPDATE app.contacts SET display_name = 'Hema T' WHERE id = $1`, [last]);
      during = await readFeed(ctx, start.cursor);
      fromStart = await readFeed(ctx);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    // The committed change lies beyond the ones still being saved, so none is read yet.
    expect(during.changes).toEqual([]);
    // Each contact is still read once from the start, as it is now.
    expect(fromStart.changes.map((ch) => [ch.id, ch.contact?.name])).toEqual([
      [held, 'Farah'],
      [later, 'Gopal N'],
      [last, 'Hema'],
    ]);
    // In the order of the transactions: both changes of the one that began first, then the other.
    const after = await readFeed(ctx, during.cursor);
    expect(after.changes.map((ch) => [ch.id, ch.contact?.name])).toEqual([
      [held, 'Farah S'],
      [last, 'Hema T'],
      [later, 'Gopal N'],
    ]);
    expect((await readFeed(ctx, after.cursor)).changes).toEqual([]);
  });

  it('compacts the changes later ones replaced without changing what the feed reads, and never passes a change still being saved', async () => {
    const c = await fx.company();
    const ctx = await apiKey(c, ['contacts.read', 'contacts.write']);
    const often = await createContact(ctx, 'Hari');
    for (const name of ['Hari 2', 'Hari 3', 'Hari 4']) {
      await apiUpdateContact(deps(), ctx, often, { name });
    }
    const once = await createContact(ctx, 'Indu');
    expect(await rowsOf(often)).toBe(4);
    const before = await readFeed(ctx);
    expect(ids(before.changes)).toEqual([often, once]);

    // A change still being saved holds the compaction back: what it saves later is compacted too.
    const holder = await fx.dbs.adminPool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE app.contacts SET display_name = 'Indu M' WHERE id = $1`, [once]);
      await apiUpdateContact(deps(), ctx, often, { name: 'Hari 5' });
      for (let i = 0; i < 100 && (await rowsOf(often)) > 2; i += 1) {
        await compactContactChanges(fx.dbs.app, 10_000);
      }
      // The earlier changes replaced each other; the one saved after the held change began is not
      // read yet, so it replaced nothing.
      expect(await rowsOf(often)).toBe(2);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    for (let i = 0; i < 100 && ((await rowsOf(often)) > 1 || (await rowsOf(once)) > 1); i += 1) {
      await compactContactChanges(fx.dbs.app, 10_000);
    }
    expect([await rowsOf(often), await rowsOf(once)]).toEqual([1, 1]);
    // The compaction keeps its place, past the last change it read.
    expect(
      (
        await fx.query<{ past: boolean }>(
          `SELECT (s.xact, s.change_id) >= (c.xact, c.id) AS past
             FROM ops.contact_change_compaction s, app.contact_changes c WHERE c.contact_id = $1`,
          [often],
        )
      )[0]!.past,
    ).toBe(true);
    // The held change began first, so it comes first.
    const after = await readFeed(ctx);
    expect(after.changes.map((ch) => [ch.id, ch.contact?.name])).toEqual([
      [once, 'Indu M'],
      [often, 'Hari 5'],
    ]);
    // Following the earlier cursor reads both changes, once each.
    expect(ids((await readFeed(ctx, before.cursor)).changes)).toEqual([once, often]);
  });

  it('opens a cursor only for the company that read it and refuses forged ones; a key needs contacts.read', async () => {
    const mine = await fx.company();
    const theirs = await fx.company();
    const ctx = await apiKey(mine, ['contacts.read', 'contacts.write']);
    const other = await apiKey(theirs, ['contacts.read', 'contacts.write']);
    const contact = await createContact(ctx, 'Jaya');
    const read = await readFeed(ctx);
    expect(ids(read.changes)).toEqual([contact]);
    expect(ids((await readFeed(other)).changes)).not.toContain(contact);

    const elsewhere = sealContactChangeCursor(
      new Keyring({ primaryKeyId: 'other', keys: { other: randomBytes(32) } }),
      mine.tenant.id,
      { xact: '0', id: '0' },
    );
    const [version, keyId, iv, body, tag] = Buffer.from(read.cursor, 'base64url')
      .toString('utf8')
      .split(':') as [string, string, string, string, string];
    const flipped = `${body.startsWith('A') ? 'B' : 'A'}${body.slice(1)}`;
    const tampered = Buffer.from([version, keyId, iv, flipped, tag].join(':')).toString(
      'base64url',
    );
    const malformed = sealContactChangeCursor(fx.keyring, mine.tenant.id, { xact: '1e3', id: '1' });
    for (const [key, cursor] of [
      [other, read.cursor],
      [ctx, elsewhere],
      [ctx, tampered],
      [ctx, malformed],
      [ctx, 'not-a-cursor'],
    ] as const) {
      expect(await refusal(apiContactChanges(feedDeps(), key, { cursor }))).toEqual({
        code: 'validation_failed',
        paths: ['cursor'],
      });
    }
    const writer = await apiKey(mine, ['contacts.write']);
    expect((await refusal(apiContactChanges(feedDeps(), writer, {}))).code).toBe('forbidden');
  });
});
