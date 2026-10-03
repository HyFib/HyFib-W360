import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLogger,
  isAppError,
  isDatabaseQueryError,
  jsonbSize,
  jsonbText,
  systemClock,
  uuidv7,
} from '@w360/core';
import {
  authorizedTenantScope,
  contacts,
  eq,
  isUniqueViolation,
  sql,
  type Database,
} from '@w360/db';
import {
  createContactsService,
  NUL_CHARACTER_MESSAGE,
  processMetaWebhookReceipt,
  storeWebhookReceipt,
  type ContactsService,
} from '@w360/domain';
import { startWhatsAppFixture, type Company, type WhatsAppFixture } from './whatsapp-fixture';

/**
 * Database errors without the data they quote (ADR-129), against real PostgreSQL: a failed query's
 * error repeats its parameters, and PostgreSQL's repeats values in its message and detail, so
 * neither leaves `db.run`, reaches a log line or is kept as a receipt's last error.
 */
let fx: WhatsAppFixture;
let company: Company;
let contactsSvc: ContactsService;

const NAME = 'Priya Sharma';
const PHONE = '+919876543210';
const QUOTED = /Priya|9876543210/;

beforeAll(async () => {
  fx = await startWhatsAppFixture();
  company = await fx.company();
  contactsSvc = createContactsService({ db: fx.dbs.app, clock: systemClock });
});

afterAll(async () => {
  await fx.close();
});

const scope = () => authorizedTenantScope(company.tenant.id, company.owner.id);

/** What a logger writes for the error, as the API's, actions' and the job log's error lines do. */
function logLine(error: unknown): string {
  const lines: string[] = [];
  createLogger({ name: 'test' }, { write: (line) => lines.push(line) }).error(
    { err: error },
    'failed',
  );
  return lines.join('');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

describe('database errors', () => {
  it('leave db.run without the values a failed query quoted, with its SQLSTATE and frames', async () => {
    let raw: unknown;
    const error = await rejection(
      fx.dbs.app.run(scope(), async (tx) => {
        try {
          return await tx
            .select({ id: contacts.id })
            .from(contacts)
            .where(eq(contacts.id, `${NAME} ${PHONE}`));
        } catch (driverError) {
          raw = driverError;
          throw driverError;
        }
      }),
    );
    // The driver's error, as the transaction saw it, quoted the value twice over.
    expect(String((raw as Error).message)).toMatch(QUOTED);
    expect(String(((raw as Error).cause as Error).message)).toMatch(QUOTED);

    expect(isDatabaseQueryError(error)).toBe(true);
    if (!isDatabaseQueryError(error)) return;
    expect(error.message).toBe('Database query failed (SQLSTATE 22P02)');
    expect(error.code).toBe('22P02');
    expect(error.cause).toBeUndefined();
    // Where the query was awaited, without its first line (which repeated the parameters).
    expect(error.stack).toContain('database-errors.test.ts');
    expect(String(error.stack)).not.toMatch(QUOTED);
    expect(logLine(error)).not.toMatch(QUOTED);
    // The logger does the same to the driver's error itself.
    expect(logLine(raw)).toContain('"type":"DatabaseQueryError"');
    expect(logLine(raw)).not.toMatch(QUOTED);
  });

  it('keep the constraint and table of a check that failed, never the row', async () => {
    const error = await rejection(
      fx.dbs.app.run(scope(), (tx) =>
        tx.insert(contacts).values({
          id: uuidv7(),
          tenantId: company.tenant.id,
          displayName: NAME,
          phoneE164: PHONE,
          email: `${NAME} ${PHONE}`,
          source: 'manual',
        }),
      ),
    );
    expect(isDatabaseQueryError(error)).toBe(true);
    // PostgreSQL's message names the relation and the constraint; its detail, "Failing row contains
    // (…)", repeated every column of the row.
    expect(error).toMatchObject({
      message: 'new row for relation "contacts" violates check constraint "contacts_email_check"',
      code: '23514',
      schema: 'app',
      table: 'contacts',
      constraint: 'contacts_email_check',
    });
    expect(logLine(error)).not.toMatch(QUOTED);
  });

  it('are mapped as before, with a cause that quotes no number', async () => {
    const insert = () =>
      fx.dbs.app.run(scope(), (tx) =>
        tx.insert(contacts).values({
          id: uuidv7(),
          tenantId: company.tenant.id,
          displayName: NAME,
          phoneE164: '+919876543219',
          source: 'manual',
        }),
      );
    await insert();
    const error = await rejection(insert());
    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;
    expect(error.code).toBe('conflict');
    expect(error.details).toEqual({ constraint: 'contacts_tenant_phone_uq' });
    expect(isUniqueViolation(error, 'contacts_tenant_phone_uq')).toBe(true);
    expect(isDatabaseQueryError(error.cause)).toBe(true);
    expect(error.cause).toMatchObject({
      message: 'duplicate key value violates unique constraint "contacts_tenant_phone_uq"',
      code: '23505',
      constraint: 'contacts_tenant_phone_uq',
    });
    // PostgreSQL's detail was "Key (tenant_id, phone_e164)=(…, +919876543219) already exists."
    expect(logLine(error)).not.toMatch(/Priya|987654321/);
  });

  it("keep our function's W34xx sentence as the public message, even one too long for the cause", async () => {
    // Our functions' sentences are one short line; the public message is read from PostgreSQL's
    // error before it is replaced, so it does not depend on what the cause may keep.
    const sentence = `${'This refusal explains at length why nothing changed. '.repeat(6)}Try again later.`;
    expect(sentence.length).toBeGreaterThan(300);
    const error = await rejection(
      fx.dbs.app.run(scope(), (tx) =>
        tx.execute(
          sql.raw(`DO $$ BEGIN RAISE EXCEPTION '${sentence}' USING ERRCODE = 'W3412'; END $$`),
        ),
      ),
    );
    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;
    expect(error.code).toBe('precondition_failed');
    expect(error.publicMessage).toBe(sentence);
    expect(error.cause).toMatchObject({
      message: 'Database query failed (SQLSTATE W3412)',
      code: 'W3412',
    });
  });

  it("refuse members' contact search holding a NUL character before the database (ADR-130)", async () => {
    const ctx = await fx.ctx(company, company.owner);
    const error = await rejection(contactsSvc.listContacts(ctx, { q: `${NAME}\u0000${PHONE}` }));
    // PostgreSQL text cannot hold it ("invalid byte sequence for encoding "UTF8": 0x00", 22021),
    // so what the schema keeps is refused first, naming the field and never the text.
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'validation_failed',
      message: NUL_CHARACTER_MESSAGE,
      issues: [{ path: 'q', message: NUL_CHARACTER_MESSAGE }],
    });
    expect(logLine(error)).not.toMatch(QUOTED);
  });

  const receiptDeps = (db: Database = fx.dbs.app) => ({
    db,
    keyring: fx.keyring,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
  });

  async function receiptFor(body: unknown, db?: Database) {
    const deps = receiptDeps(db);
    const stored = await storeWebhookReceipt(deps, {
      provider: 'meta_whatsapp',
      rawBody: Buffer.from(JSON.stringify(body)),
    });
    const outcome = await processMetaWebhookReceipt(deps, stored.receiptId).catch(
      (error: unknown) => error,
    );
    const [receipt] = await fx.query<{ status: string; last_error: string | null }>(
      'SELECT status, last_error FROM ops.webhook_receipts WHERE id = $1',
      [stored.receiptId],
    );
    return { outcome, receipt };
  }

  it("keep a receipt's last error to the SQLSTATE when its processing fails in the database", async () => {
    // No inbound content fails its receipt since ADR-131, so the receipt's transaction runs a
    // statement PostgreSQL refuses first: its error quotes the name and number it could not read.
    const failing: Database = {
      pool: fx.dbs.app.pool,
      close: () => Promise.resolve(),
      run: (runScope, fn, options) =>
        runScope.kind === 'tenant'
          ? fx.dbs.app.run(
              runScope,
              async (tx) => {
                await tx.execute(sql`select ${`${NAME} ${PHONE}`}::int`);
                return fn(tx);
              },
              options,
            )
          : fx.dbs.app.run(runScope, fn, options),
    };
    const { outcome, receipt } = await receiptFor(
      fx.messagesBody(company, { messages: [{ waId: '919876543210', text: 'Hello' }] }),
      failing,
    );
    expect(isDatabaseQueryError(outcome)).toBe(true);
    expect(logLine(outcome)).not.toMatch(QUOTED);
    expect(receipt).toEqual({
      status: 'failed',
      last_error: 'Database query failed (SQLSTATE 22P02)',
    });
  });

  it('keep an inbound message holding a NUL character, with U+FFFD in its place (ADR-130)', async () => {
    const id = `wamid.in.${randomBytes(6).toString('hex')}`;
    const { outcome, receipt } = await receiptFor(
      fx.messagesBody(company, {
        messages: [{ id, waId: '919876543211', text: `Hi\u0000 call me back` }],
      }),
    );
    // The receipt failed on the message's jsonb before (22P05), with every other message in it.
    expect(outcome).toBe('processed');
    expect(receipt).toEqual({ status: 'processed', last_error: null });
    const [message] = await fx.query<{ content: { text: string } }>(
      'SELECT content FROM app.messages WHERE tenant_id = $1 AND external_message_id = $2',
      [company.tenant.id, id],
    );
    expect(message?.content.text).toBe('Hi\uFFFD call me back');
  });
});

describe('inbound content the database cannot store (ADR-131)', () => {
  const receiptDeps = () => ({
    db: fx.dbs.app,
    keyring: fx.keyring,
    jobs: fx.jobs(),
    signer: fx.signer,
    clock: systemClock,
  });

  /** Processes one inbound message and returns its receipt and the stored message's content. */
  async function deliverOne(message: Record<string, unknown>) {
    const id = `wamid.in.${randomBytes(6).toString('hex')}`;
    const deps = receiptDeps();
    const stored = await storeWebhookReceipt(deps, {
      provider: 'meta_whatsapp',
      rawBody: Buffer.from(
        JSON.stringify(fx.messagesBody(company, { messages: [{ id, ...message }] })),
      ),
    });
    const outcome = await processMetaWebhookReceipt(deps, stored.receiptId).catch(
      (error: unknown) => error,
    );
    const [receipt] = await fx.query<{ status: string; last_error: string | null }>(
      'SELECT status, last_error FROM ops.webhook_receipts WHERE id = $1',
      [stored.receiptId],
    );
    const [message_] = await fx.query<{ content: Record<string, unknown>; size: number }>(
      `SELECT content, pg_column_size(content) AS size FROM app.messages
        WHERE tenant_id = $1 AND external_message_id = $2`,
      [company.tenant.id, id],
    );
    return { outcome, receipt, content: message_?.content, size: message_?.size };
  }

  it('keep a long message with an emoji at the cut, clipped before the emoji', async () => {
    // Clipped at 4,096 code units, the cut left half the emoji, which jsonb refused (22P02), so the
    // whole receipt failed.
    const { outcome, receipt, content } = await deliverOne({
      waId: '919876543212',
      text: `${'x'.repeat(4095)}😀 the rest of a long message`,
    });
    expect(outcome).toBe('processed');
    expect(receipt).toEqual({ status: 'processed', last_error: null });
    expect(content).toEqual({ text: 'x'.repeat(4095) });
  });

  it("clip a conversation's preview and a contact's profile name without splitting an emoji", async () => {
    const waId = '919876543216';
    const { outcome } = await deliverOne({
      waId,
      text: `${'p'.repeat(199)}😀 and more`,
      profileName: `${'n'.repeat(199)}😀 and more`,
    });
    expect(outcome).toBe('processed');
    const [row] = await fx.query<{ preview: string; name: string; profile: string }>(
      `SELECT cv.last_message_preview AS preview, c.display_name AS name, i.profile_name AS profile
         FROM app.contact_identities i
         JOIN app.contacts c ON c.tenant_id = i.tenant_id AND c.id = i.contact_id
         JOIN app.conversations cv ON cv.tenant_id = c.tenant_id AND cv.contact_id = c.id
        WHERE i.tenant_id = $1 AND i.wa_id = $2`,
      [company.tenant.id, waId],
    );
    // Clipped at 200 code units, these ended with U+FFFD in place of the emoji's first half.
    expect(row).toEqual({
      preview: 'p'.repeat(199),
      name: 'n'.repeat(199),
      profile: 'n'.repeat(199),
    });
    // A later message with another profile name updates the identity's, clipped the same way.
    await deliverOne({ waId, text: 'Hello again', profileName: `${'m'.repeat(199)}😀 now` });
    const [identity] = await fx.query<{ profile: string }>(
      `SELECT profile_name AS profile FROM app.contact_identities WHERE tenant_id = $1 AND wa_id = $2`,
      [company.tenant.id, waId],
    );
    expect(identity).toEqual({ profile: 'm'.repeat(199) });
  });

  it('keep a contact card larger than a message may hold, with the contacts that fit', async () => {
    // A card of 25 contacts of about 4 KB failed its receipt (messages_content_check), as did one
    // contact larger than 64 KB, the card ADR-129's test used.
    const many = Array.from({ length: 25 }, (_, i) => ({
      name: { formatted_name: `${NAME} ${i}` },
      phones: [{ phone: PHONE, type: 'CELL' }],
      addresses: [{ street: 'x'.repeat(4_000), city: 'Pune' }],
    }));
    const large = await deliverOne({
      waId: '919876543213',
      type: 'contacts',
      extra: { contacts: many },
    });
    expect(large.outcome).toBe('processed');
    expect(large.receipt).toEqual({ status: 'processed', last_error: null });
    const kept = large.content?.contacts as unknown[];
    expect(kept).toEqual(many.slice(0, kept.length));
    expect(large.content?.omittedContacts).toBe(25 - kept.length);
    expect(large.size).toBeLessThanOrEqual(65_536);

    const huge = await deliverOne({
      waId: '919876543214',
      type: 'contacts',
      extra: {
        contacts: [
          { name: { formatted_name: `${NAME} ${PHONE} ${randomBytes(60_000).toString('hex')}` } },
        ],
      },
    });
    expect(huge.outcome).toBe('processed');
    expect(huge.content).toEqual({ contacts: [], omittedContacts: 1 });
  });

  it('keep a status whose errors and pricing are larger than their columns allow, bounded', async () => {
    // A status's errors (4 KB) and pricing (2 KB) were stored as WhatsApp sent them, so larger ones
    // failed the receipt (23514) with every message and status beside them.
    const text = `Status test ${randomBytes(4).toString('hex')}`;
    await deliverOne({ waId: '919876543217', text });
    const [conv] = await fx.query<{ conversation_id: string; channel_account_id: string }>(
      `SELECT conversation_id, channel_account_id FROM app.messages
        WHERE tenant_id = $1 AND content->>'text' = $2`,
      [company.tenant.id, text],
    );
    const wamid = `wamid.out.${randomBytes(6).toString('hex')}`;
    await fx.query(
      `INSERT INTO app.messages (id, tenant_id, conversation_id, channel_account_id, direction,
                                 external_message_id, type, content, status, status_rank, sender_type)
       VALUES (gen_random_uuid(), $1, $2, $3, 'outbound', $4, 'text', '{"text":"Shipped"}',
               'accepted', 20, 'api')`,
      [company.tenant.id, conv!.conversation_id, conv!.channel_account_id, wamid],
    );
    const deps = receiptDeps();
    const stored = await storeWebhookReceipt(deps, {
      provider: 'meta_whatsapp',
      rawBody: Buffer.from(
        JSON.stringify(
          fx.messagesBody(company, {
            statuses: [
              {
                id: wamid,
                status: 'failed',
                timestamp: String(Math.floor(Date.now() / 1000)),
                recipient_id: '919876543217',
                errors: [
                  {
                    code: 131026,
                    title: 'Message undeliverable',
                    message: 'Message undeliverable',
                    error_data: { details: 'd'.repeat(6000) },
                    href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
                  },
                ],
                pricing: {
                  billable: false,
                  pricing_model: 'PMP',
                  category: 'utility',
                  type: 'regular',
                  note: 'n'.repeat(3000),
                },
              },
            ],
          }),
        ),
      ),
    });
    expect(await processMetaWebhookReceipt(deps, stored.receiptId)).toBe('processed');
    const pricing = { billable: false, pricing_model: 'PMP', category: 'utility', type: 'regular' };
    expect(
      await fx.query(
        'SELECT errors, pricing FROM app.message_status_events WHERE tenant_id = $1 AND external_message_id = $2',
        [company.tenant.id, wamid],
      ),
    ).toEqual([
      {
        errors: [
          {
            code: 131026,
            title: 'Message undeliverable',
            message: 'Message undeliverable',
            error_data: { details: 'd'.repeat(500) },
          },
        ],
        pricing,
      },
    ]);
    expect(
      await fx.query(
        `SELECT status, error_code, error_title, pricing FROM app.messages
          WHERE tenant_id = $1 AND external_message_id = $2`,
        [company.tenant.id, wamid],
      ),
    ).toEqual([
      { status: 'failed', error_code: '131026', error_title: 'Message undeliverable', pricing },
    ]);
  });

  it("keep a Flow's answers holding half an emoji, with U+FFFD in its place", async () => {
    // An answer that a provider escaped as half an emoji was written to jsonb as that half (22P02).
    const { outcome, receipt, content } = await deliverOne({
      waId: '919876543215',
      type: 'interactive',
      extra: {
        interactive: {
          type: 'nfm_reply',
          nfm_reply: {
            name: 'flow',
            body: 'Sent',
            response_json: JSON.stringify({ city: 'Pune\ud83d' }),
          },
        },
      },
    });
    expect(outcome).toBe('processed');
    expect(receipt).toEqual({ status: 'processed', last_error: null });
    expect((content?.flow as { answers: unknown }).answers).toEqual({ city: 'Pune\ufffd' });
  });

  it('write half an emoji to any jsonb column as U+FFFD', async () => {
    const [created] = await fx.dbs.app.run(scope(), (tx) =>
      tx
        .insert(contacts)
        .values({
          id: uuidv7(),
          tenantId: company.tenant.id,
          attributes: { note: `call me \ud83d`, [`ke\ude00y`]: 'x' },
        })
        .returning({ attributes: contacts.attributes }),
    );
    expect(created?.attributes).toEqual({ note: 'call me \ufffd', 'ke\ufffdy': 'x' });
  });

  it('measure jsonb at no less than PostgreSQL takes', async () => {
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647);
    const values: unknown[] = [];
    for (let i = 0; i < 300; i += 1) {
      const pick = next() % 6;
      const text = 'aé€😀'.repeat(next() % 40) + String(next());
      const number = [0, 1, -1, 0.5, 1e21, 5e-324, 1.7976931348623157e308, next() / 7][next() % 8];
      values.push(
        [
          { text, n: number, flag: true, none: null },
          [number, text, [number], {}],
          {
            nested: { deeper: [text, { n: number }] },
            list: Array.from({ length: next() % 30 }, () => number),
          },
          text,
          number,
          Array.from({ length: next() % 50 }, () => ({ [text.slice(0, 5)]: number })),
        ][pick],
      );
    }
    const [row] = await fx.query<{ sizes: number[] }>(
      `SELECT array_agg(pg_column_size(v) ORDER BY o) AS sizes
         FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(v, o)`,
      [jsonbText(values)],
    );
    const sizes = row?.sizes ?? [];
    expect(sizes).toHaveLength(values.length);
    values.forEach((value, i) =>
      expect(jsonbSize(value)).toBeGreaterThanOrEqual(sizes[i] ?? Infinity),
    );
  });
});
