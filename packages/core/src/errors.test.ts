import { describe, expect, it } from 'vitest';
import { AppError, errorClassAndCode } from './errors';

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
