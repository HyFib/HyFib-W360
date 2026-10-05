import { stdSerializers } from 'pino';
import { describe, expect, it } from 'vitest';
import { AppError } from './errors';
import { createLogger, logLibraryLine, serializeError } from './logger';

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
  }
}

const QUOTED = /Priya|9876543210|Failing row|Key \(|insert into/;

function uniqueViolation() {
  return new PgDatabaseError('duplicate key value violates unique constraint "contacts_phone_uq"', {
    severity: 'ERROR',
    code: '23505',
    detail: 'Key (tenant_id, phone_e164)=(0190, +919876543210) already exists.',
    schema: 'app',
    table: 'contacts',
    constraint: 'contacts_phone_uq',
    routine: '_bt_check_unique',
  });
}

function failedInsert() {
  return new DrizzleQueryError(
    'insert into "app"."contacts" ("display_name", "phone_e164") values ($1, $2)',
    ['Priya Sharma', '+919876543210'],
    uniqueViolation(),
  );
}

function logged(write: (logger: ReturnType<typeof createLogger>) => void) {
  const lines: string[] = [];
  write(createLogger({ name: 'test', level: 'info' }, { write: (line) => lines.push(line) }));
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('serializeError', () => {
  it('logs a database driver error as its DatabaseQueryError, without the data it quoted', () => {
    const serialized = serializeError(failedInsert()) as Record<string, unknown>;
    expect(serialized).toMatchObject({
      type: 'DatabaseQueryError',
      message: 'duplicate key value violates unique constraint "contacts_phone_uq"',
      code: '23505',
      constraint: 'contacts_phone_uq',
      schema: 'app',
    });
    expect(JSON.stringify(serialized)).not.toMatch(QUOTED);
  });

  it('keeps the errors that wrap one, and leaves the logged error as it was', () => {
    const failed = failedInsert();
    const wrapped = new AppError('conflict', 'That number is taken.', { cause: failed });
    const serialized = serializeError(wrapped) as Record<string, unknown>;
    expect(serialized).toMatchObject({
      type: 'AppError',
      code: 'conflict',
      message:
        'That number is taken.: duplicate key value violates unique constraint "contacts_phone_uq"',
    });
    expect(String(serialized.stack)).toContain(
      'caused by: DatabaseQueryError: duplicate key value violates unique constraint',
    );
    expect(JSON.stringify(serialized)).not.toMatch(QUOTED);
    expect(wrapped.cause).toBe(failed);
  });

  it('logs the plain object pg-boss copies a database error into without its detail', () => {
    const error = uniqueViolation();
    const copy = { ...error, message: error.message, stack: error.stack, queue: 'messaging.send' };
    const serialized = serializeError(copy) as Record<string, unknown>;
    expect(serialized).toMatchObject({ type: 'DatabaseQueryError', code: '23505' });
    expect(JSON.stringify(serialized)).not.toMatch(QUOTED);
  });

  it('logs the errors an AggregateError holds the same way', () => {
    const serialized = serializeError(
      new AggregateError([failedInsert(), new RangeError('Invalid time value')], 'Both failed'),
    ) as { aggregateErrors: Record<string, unknown>[] };
    expect(serialized.aggregateErrors.map((e) => e.type)).toEqual([
      'DatabaseQueryError',
      'RangeError',
    ]);
    expect(JSON.stringify(serialized)).not.toMatch(QUOTED);
  });

  it('logs any other error as pino does', () => {
    const error = new RangeError('Invalid time value', { cause: new Error('inner') });
    expect(serializeError(error)).toEqual(stdSerializers.err(error));
    expect(serializeError('text')).toBe('text');
    expect(serializeError(undefined)).toBeUndefined();
  });
});

describe('createLogger', () => {
  it('writes errors through serializeError, whatever serializers a caller passes', () => {
    const lines = logged((logger) => {
      logger.error({ err: failedInsert() }, 'query failed');
      logger.child({ requestId: 'r1' }).error({ err: failedInsert() }, 'child failed');
    });
    const overridden: string[] = [];
    createLogger(
      { name: 'test', serializers: { err: (value: unknown) => value } },
      { write: (line) => overridden.push(line) },
    ).error({ err: failedInsert() }, 'overridden');

    for (const line of [
      ...lines,
      ...overridden.map((l) => JSON.parse(l) as Record<string, unknown>),
    ]) {
      expect((line.err as Record<string, unknown>).type).toBe('DatabaseQueryError');
      expect(JSON.stringify(line)).not.toMatch(QUOTED);
    }
    expect(lines).toHaveLength(2);
    expect(overridden).toHaveLength(1);
  });
});

describe('logLibraryLine', () => {
  it("writes a library's message with its first error, without the data either holds", () => {
    const lines = logged((logger) => {
      logLibraryLine(logger, 'error', 'Failed to read session from database', [failedInsert()]);
      logLibraryLine(logger, 'error', 'Error parsing JSON', [{ error: failedInsert() }]);
      logLibraryLine(logger, 'warn', 'Failed to query fallback join for model user:', [
        { where: [{ field: 'email', value: 'priya@example.com' }], limit: 1 },
        new RangeError('Invalid time value'),
      ]);
      logLibraryLine(logger, 'info', 'Sessions pruned', [{ count: 3, user: 'Priya' }]);
    });
    expect(lines.map((line) => [line.level, line.msg])).toEqual([
      ['error', 'Failed to read session from database'],
      ['error', 'Error parsing JSON'],
      ['warn', 'Failed to query fallback join for model user:'],
      ['info', 'Sessions pruned'],
    ]);
    expect(lines.map((line) => (line.err as { type?: string } | undefined)?.type)).toEqual([
      'DatabaseQueryError',
      'DatabaseQueryError',
      'RangeError',
      undefined,
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/Priya|priya@example\.com|9876543210|insert into/);
  });
});
