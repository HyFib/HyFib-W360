import { describe, expect, it } from 'vitest';
import {
  AppError,
  DatabaseQueryError,
  errorClassAndCode,
  isAppError,
  isDatabaseDriverError,
  isDatabaseQueryError,
  toDatabaseQueryError,
  withoutDriverErrors,
} from './errors';

describe('errorClassAndCode', () => {
  it('names the class and the first code along the causes, never the messages', () => {
    // A failed query's error, as drizzle wraps PostgreSQL's: the message quotes the parameters.
    class QueryError extends Error {}
    const failed = new QueryError('Failed query: select … params: +919876543210', {
      cause: Object.assign(new Error('invalid input syntax for type uuid: "Priya"'), {
        code: '22P02',
      }),
    });
    const facts = errorClassAndCode(failed);
    expect(facts).toEqual({ errorClass: 'QueryError', errorCode: '22P02' });
    expect(JSON.stringify(facts)).not.toMatch(/9876543210|Priya/);

    expect(errorClassAndCode(new RangeError('Invalid time value'))).toEqual({
      errorClass: 'RangeError',
      errorCode: null,
    });
    expect(errorClassAndCode(new AppError('not_found', 'Contact not found.'))).toEqual({
      errorClass: 'AppError',
      errorCode: 'not_found',
    });
    expect(
      errorClassAndCode(
        Object.assign(new TypeError('Invalid URL'), {
          code: 'ERR_INVALID_URL',
          input: 'https://hooks.example.com/orders?customer=Priya',
        }),
      ),
    ).toEqual({ errorClass: 'TypeError', errorCode: 'ERR_INVALID_URL' });
    expect(errorClassAndCode(Object.assign(new Error('x'), { code: 42 }))).toEqual({
      errorClass: 'Error',
      errorCode: '42',
    });
  });

  it('leaves out a code that is not one and anything thrown that is not an error', () => {
    const quoting = Object.assign(new Error('x'), { code: 'Priya Sharma' });
    expect(errorClassAndCode(quoting)).toEqual({ errorClass: 'Error', errorCode: null });
    expect(
      errorClassAndCode(
        new Error('x', { cause: Object.assign(new Error('y'), { code: 'EPIPE' }) }),
      ),
    ).toEqual({ errorClass: 'Error', errorCode: 'EPIPE' });
    expect(errorClassAndCode('Priya Sharma, +919876543210')).toEqual({
      errorClass: 'string',
      errorCode: null,
    });
    expect(errorClassAndCode({ code: 'not_found' })).toEqual({
      errorClass: 'object',
      errorCode: null,
    });
    const anonymous = new (class extends Error {})('x');
    expect(errorClassAndCode(anonymous).errorClass).toBe('Error');
  });
});

/** Shaped like pg-protocol's DatabaseError: named "error", with PostgreSQL's fields as properties. */
class PgDatabaseError extends Error {
  constructor(message: string, fields: Record<string, string>) {
    super(message);
    this.name = 'error';
    Object.assign(this, fields);
  }
}

/** Shaped like drizzle's DrizzleQueryError: the query and its parameters in the message. */
class DrizzleQueryError extends Error {
  constructor(
    readonly query: string,
    readonly params: unknown[],
    cause?: unknown,
  ) {
    super(`Failed query: ${query}\nparams: ${params.join(',')}`);
    this.cause = cause;
    Error.captureStackTrace(this, DrizzleQueryError);
  }
}

const QUOTED = /Priya|9876543210|forged|select|Failing row|Key \(/;

function postgresError() {
  return new PgDatabaseError('invalid input syntax for type uuid: "Priya Sharma"', {
    severity: 'ERROR',
    code: '22P02',
    detail: 'Failing row contains (Priya Sharma, +919876543210).',
    hint: 'Priya',
    where: 'SQL statement "select \'Priya\'"',
    internalQuery: "select 'Priya'",
    routine: 'string_to_uuid',
    file: 'uuid.c',
    line: '133',
  });
}

/** A failed query as it reaches `db.run`: awaited in a service, a parameter forging a frame. */
async function contactLookup(): Promise<never> {
  await Promise.resolve();
  throw new DrizzleQueryError(
    'select "id" from "app"."contacts" where "id" = $1',
    ['Priya Sharma\n    at forged (/home/priya/+919876543210.js:1:1)', '+919876543210'],
    postgresError(),
  );
}

async function failedQuery(): Promise<DrizzleQueryError> {
  try {
    return await contactLookup();
  } catch (error) {
    return error as DrizzleQueryError;
  }
}

describe('DatabaseQueryError', () => {
  it('keeps the SQLSTATE and the names PostgreSQL gave, and nothing that is not a name', () => {
    const error = new DatabaseQueryError({
      code: '23505',
      severity: 'ERROR',
      schema: 'app',
      table: 'contacts',
      column: 'phone_e164',
      dataType: 'text',
      constraint: 'contacts_phone_uq',
      routine: '_bt_check_unique',
    });
    expect(error.message).toBe(
      'Database query failed (SQLSTATE 23505, constraint contacts_phone_uq, table contacts, column phone_e164)',
    );
    expect(error).toMatchObject({
      name: 'DatabaseQueryError',
      code: '23505',
      severity: 'ERROR',
      schema: 'app',
      dataType: 'text',
      routine: '_bt_check_unique',
    });
    expect(isDatabaseQueryError(error)).toBe(true);
    expect(isAppError(error)).toBe(false);
    expect(error.stack?.startsWith(`DatabaseQueryError: ${error.message}\n`)).toBe(true);

    const quoting = new DatabaseQueryError({
      code: 'Priya',
      severity: 'Priya Sharma',
      table: 'contacts; Priya',
      constraint: 'Key (phone_e164)=(+919876543210)',
      stoppedBy: 'Priya Sharma',
    });
    expect(quoting.message).toBe('Database query failed');
    expect(quoting).toMatchObject({ code: undefined, severity: undefined, table: undefined });
    expect(JSON.stringify({ ...quoting, stack: quoting.stack })).not.toMatch(QUOTED);
    expect(new DatabaseQueryError({ stoppedBy: 'RangeError' }).message).toBe(
      'Database query failed (RangeError)',
    );
  });

  it("keeps PostgreSQL's message only where its SQLSTATE's messages quote no values", () => {
    expect(
      new DatabaseQueryError({
        code: '23505',
        message: 'duplicate key value violates unique constraint "contacts_phone_uq"',
        constraint: 'contacts_phone_uq',
      }).message,
    ).toBe('duplicate key value violates unique constraint "contacts_phone_uq"');
    expect(
      new DatabaseQueryError({ code: 'P0001', message: "A key's expiry can only come sooner." })
        .message,
    ).toBe("A key's expiry can only come sooner.");
    // Data exceptions quote the value that failed, and syntax errors the SQL text.
    for (const [code, message] of [
      ['22P02', 'invalid input syntax for type uuid: "Priya Sharma"'],
      ['22003', 'value "9876543210" is out of range for type integer'],
      ['42601', 'syntax error at or near "Priya"'],
    ]) {
      expect(new DatabaseQueryError({ code, message }).message).toBe(
        `Database query failed (SQLSTATE ${code})`,
      );
    }
    // Without a SQLSTATE, or more than one short line, there is no message to trust.
    expect(new DatabaseQueryError({ message: 'Priya Sharma' }).message).toBe(
      'Database query failed',
    );
    for (const message of ['first line\nPriya Sharma', 'x'.repeat(301), '']) {
      expect(new DatabaseQueryError({ code: '23514', message }).message).toBe(
        'Database query failed (SQLSTATE 23514)',
      );
    }
  });

  it('keeps only lines that are stack frames under its own first line', () => {
    const error = new DatabaseQueryError(
      { code: '22P02' },
      '    at lookup (/srv/app.js:1:1)\nPriya Sharma\n    at async run (/srv/db.js:2:2)',
    );
    expect(error.stack).toBe(
      'DatabaseQueryError: Database query failed (SQLSTATE 22P02)\n    at lookup (/srv/app.js:1:1)\n    at async run (/srv/db.js:2:2)',
    );
  });
});

describe('database driver errors', () => {
  it('are recognised by their shape: PostgreSQL errors and failed drizzle queries', async () => {
    const failed = await failedQuery();
    expect(isDatabaseDriverError(failed)).toBe(true);
    expect(isDatabaseDriverError(postgresError())).toBe(true);
    // pg-boss copies an error into a plain object before it emits it.
    expect(isDatabaseDriverError({ ...postgresError(), message: 'x' })).toBe(true);
    expect(isDatabaseDriverError({ query: 'select 1', params: [] })).toBe(true);

    expect(
      isDatabaseDriverError(new DatabaseQueryError({ code: '22P02', severity: 'ERROR' })),
    ).toBe(false);
    expect(isDatabaseDriverError(new AppError('conflict', 'Taken.'))).toBe(false);
    expect(isDatabaseDriverError(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    expect(isDatabaseDriverError({ severity: 'ERROR', code: 'Priya' })).toBe(false);
    expect(isDatabaseDriverError({ query: 'select 1' })).toBe(false);
    expect(isDatabaseDriverError(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe(false);
    expect(isDatabaseDriverError('Failed query: select 1')).toBe(false);
    expect(isDatabaseDriverError(null)).toBe(false);
  });

  it('become a DatabaseQueryError with the facts and the frames, never the data', async () => {
    const failed = await failedQuery();
    expect(failed.message).toMatch(QUOTED);
    const safe = toDatabaseQueryError(failed);
    expect(safe.message).toBe('Database query failed (SQLSTATE 22P02)');
    expect(safe).toMatchObject({ code: '22P02', severity: 'ERROR', routine: 'string_to_uuid' });
    expect(safe.cause).toBeUndefined();
    // The frames of the failed query, where the service awaited it, and not the forged one.
    expect(safe.stack).toMatch(
      /^DatabaseQueryError: Database query failed \(SQLSTATE 22P02\)\n {4}at /,
    );
    expect(safe.stack).toContain('contactLookup');
    expect(safe.stack).toContain('errors.test.ts');
    expect(JSON.stringify({ ...safe, message: safe.message, stack: safe.stack })).not.toMatch(
      QUOTED,
    );
    expect(Object.keys(safe).sort()).toEqual([
      'code',
      'column',
      'constraint',
      'dataType',
      'name',
      'routine',
      'schema',
      'severity',
      'table',
    ]);
  });

  it('name what stopped a query before PostgreSQL answered, and drop a stack they cannot read', async () => {
    const stopped = toDatabaseQueryError(
      new DrizzleQueryError(
        'insert into "app"."contacts" values ($1)',
        ['Priya'],
        new RangeError('Invalid time value'),
      ),
    );
    expect(stopped.message).toBe('Database query failed (RangeError)');
    expect(stopped.code).toBeUndefined();

    // A message changed after V8 wrote the stack: its first line no longer matches, so none of the
    // stack is kept and the error has its own.
    const failed = await failedQuery();
    void failed.stack;
    failed.message = 'Changed';
    const safe = toDatabaseQueryError(failed);
    expect(safe.stack).toMatch(/^DatabaseQueryError: Database query failed \(SQLSTATE 22P02\)\n/);
    expect(safe.stack).not.toMatch(QUOTED);

    // A message cut to its first line after V8 wrote the stack: the first line matches again, but the
    // rest of the old message, the forged frame among it, sits before the frames, so none are kept.
    const shortened = await failedQuery();
    void shortened.stack;
    shortened.message = shortened.message.split('\n')[0] ?? '';
    const kept = toDatabaseQueryError(shortened);
    expect(kept.stack).not.toMatch(QUOTED);
    expect(kept.stack).not.toContain('contactLookup');
  });

  it('are taken out of an error and its causes, keeping the errors that wrap them', async () => {
    const plain = new RangeError('Invalid time value');
    expect(withoutDriverErrors(plain)).toBe(plain);
    expect(withoutDriverErrors('text')).toBe('text');
    const already = new DatabaseQueryError({ code: '22P02' });
    expect(withoutDriverErrors(already)).toBe(already);

    const head = withoutDriverErrors(await failedQuery());
    expect(isDatabaseQueryError(head)).toBe(true);

    const wrapped = new AppError('conflict', 'That shortcut is taken.', {
      cause: await failedQuery(),
    });
    expect(withoutDriverErrors(wrapped)).toBe(wrapped);
    expect(wrapped.message).toBe('That shortcut is taken.');
    expect(isDatabaseQueryError(wrapped.cause)).toBe(true);
    expect((wrapped.cause as DatabaseQueryError).code).toBe('22P02');

    const deeper = new Error('outer', { cause: new Error('inner', { cause: postgresError() }) });
    withoutDriverErrors(deeper);
    expect(isDatabaseQueryError((deeper.cause as Error).cause)).toBe(true);

    // A wrapper whose cause cannot be replaced gives way to the DatabaseQueryError.
    const frozen = Object.freeze(new Error('frozen', { cause: await failedQuery() }));
    expect(isDatabaseQueryError(withoutDriverErrors(frozen))).toBe(true);

    const looped = new Error('looped') as Error & { cause?: unknown };
    looped.cause = looped;
    expect(withoutDriverErrors(looped)).toBe(looped);
  });
});
