import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, isAppError, isDatabaseQueryError, systemClock, uuidv7 } from '@w360/core';
import { authorizedTenantScope, contacts, eq, isUniqueViolation, sql } from '@w360/db';
import {
  createContactsService,
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

  it("fail members' contact search on a NUL character without the search text", async () => {
    const ctx = await fx.ctx(company, company.owner);
    const error = await rejection(contactsSvc.listContacts(ctx, { q: `${NAME}\u0000${PHONE}` }));
    // PostgreSQL refuses the character in text: "invalid byte sequence for encoding "UTF8": 0x00".
    expect(isDatabaseQueryError(error)).toBe(true);
    expect((error as Error).message).toBe('Database query failed (SQLSTATE 22021)');
    expect(String((error as Error).stack)).not.toMatch(QUOTED);
    expect(logLine(error)).not.toMatch(QUOTED);
  });

  it("keep a receipt's last error to the SQLSTATE when its processing fails in the database", async () => {
    const deps = {
      db: fx.dbs.app,
      keyring: fx.keyring,
      jobs: fx.jobs(),
      signer: fx.signer,
      clock: systemClock,
    };
    const body = fx.messagesBody(company, {
      messages: [{ waId: '919876543210', text: `${NAME}\u0000 call me on ${PHONE}` }],
    });
    const stored = await storeWebhookReceipt(deps, {
      provider: 'meta_whatsapp',
      rawBody: Buffer.from(JSON.stringify(body)),
    });
    const error = await rejection(processMetaWebhookReceipt(deps, stored.receiptId));
    expect(isDatabaseQueryError(error)).toBe(true);
    const [receipt] = await fx.query<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM ops.webhook_receipts WHERE id = $1',
      [stored.receiptId],
    );
    // The message's jsonb holds "\u0000", which PostgreSQL cannot convert to text (22P05); the
    // receipt kept the whole insert, with the text and the number, as its last error before.
    expect(receipt).toEqual({
      status: 'failed',
      last_error: 'Database query failed (SQLSTATE 22P05)',
    });
  });
});
