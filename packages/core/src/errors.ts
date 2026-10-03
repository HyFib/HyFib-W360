/**
 * Typed application errors. Services throw these; transport layers (route handlers, server
 * actions, workers) translate them into responses without leaking internal details.
 */
export type AppErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  | 'precondition_failed'
  | 'rate_limited'
  | 'tenant_suspended'
  | 'mfa_required'
  | 'step_up_required'
  | 'insufficient_funds'
  | 'provider_unavailable'
  | 'provider_rejected'
  | 'unsupported'
  | 'internal';

const HTTP_STATUS: Record<AppErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  precondition_failed: 412,
  rate_limited: 429,
  tenant_suspended: 423,
  mfa_required: 403,
  step_up_required: 403,
  insufficient_funds: 402,
  provider_unavailable: 503,
  provider_rejected: 422,
  unsupported: 501,
  internal: 500,
};

export interface FieldIssue {
  path: string;
  message: string;
}

/**
 * Brand shared through the global symbol registry. Bundlers can include this module more than once
 * (for example in separate server chunks), which breaks `instanceof`; the brand does not.
 */
const APP_ERROR_BRAND = Symbol.for('w360.app-error');

export class AppError extends Error {
  readonly [APP_ERROR_BRAND] = true;
  readonly code: AppErrorCode;
  readonly httpStatus: number;
  /** Safe, user-presentable message. Never include secrets or other tenants' data. */
  readonly publicMessage: string;
  readonly issues: FieldIssue[] | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: AppErrorCode,
    publicMessage: string,
    options: { cause?: unknown; issues?: FieldIssue[]; details?: Record<string, unknown> } = {},
  ) {
    super(publicMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.publicMessage = publicMessage;
    this.issues = options.issues;
    this.details = options.details;
  }
}

export const notFound = (what = 'Resource') => new AppError('not_found', `${what} not found.`);
export const forbidden = (message = 'You do not have permission to perform this action.') =>
  new AppError('forbidden', message);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError('conflict', message, details ? { details } : {});
export const preconditionFailed = (message: string) => new AppError('precondition_failed', message);
export const validationFailed = (message: string, issues: FieldIssue[] = []) =>
  new AppError('validation_failed', message, { issues });

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[APP_ERROR_BRAND] === true
  );
}

/** Normalises an unknown thrown value into an Error for logging without losing the cause. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : 'Non-error value thrown', { cause: value });
}

const ERROR_CLASS = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * What a log line may say about an error whose message can quote data: its class and the first
 * code along its causes (an application error code, a Node.js code or a SQLSTATE), never its
 * message, stack or details. A failed query's error, for example, repeats the query's parameters.
 */
export function errorClassAndCode(value: unknown): {
  errorClass: string;
  errorCode: string | null;
} {
  const name = value instanceof Error ? value.constructor.name : typeof value;
  let errorCode: string | null = null;
  let current: unknown = value;
  for (let depth = 0; depth < 5 && current instanceof Error && errorCode === null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    const text = typeof code === 'number' && Number.isInteger(code) ? String(code) : code;
    if (typeof text === 'string' && ERROR_CODE.test(text)) errorCode = text;
    current = current.cause;
  }
  return { errorClass: ERROR_CLASS.test(name) ? name : 'Error', errorCode };
}

/**
 * Brand of DatabaseQueryError, shared through the global symbol registry like AppError's: the
 * error has a SQLSTATE and a severity, as a driver error does, but is not one.
 */
const DATABASE_QUERY_ERROR_BRAND = Symbol.for('w360.database-query-error');
const SQLSTATE = /^[0-9A-Z]{5}$/;
const SEVERITY = /^[A-Z]{1,16}$/;
const SQL_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const STACK_FRAME = /^ +at \S/;
const SINGLE_LINE = /^\P{Cc}{1,300}$/u;
const CAUSE_DEPTH = 8;

/** What PostgreSQL names about a failed query; each is kept only if it reads as a code or a name. */
export interface DatabaseQueryFacts {
  code?: unknown;
  /** PostgreSQL's own message, kept only for the SQLSTATEs whose messages name no values. */
  message?: unknown;
  severity?: unknown;
  schema?: unknown;
  table?: unknown;
  column?: unknown;
  dataType?: unknown;
  constraint?: unknown;
  routine?: unknown;
  /** The class of the error that stopped the query before PostgreSQL answered. */
  stoppedBy?: unknown;
}

const kept = (pattern: RegExp, value: unknown): string | undefined =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

/**
 * PostgreSQL's own message when its SQLSTATE's messages name only objects (a constraint, table,
 * column or type) or are our functions' sentences, which never quote personal data: not data
 * exceptions (class 22), whose messages quote the value that failed ("invalid input syntax for type
 * uuid: "…"", "value "…" is out of range"), nor syntax errors (42601), which quote the SQL text.
 */
function keptMessage(code: string | undefined, message: unknown): string | undefined {
  if (!code || code.startsWith('22') || code === '42601') return undefined;
  return kept(SINGLE_LINE, message);
}

/**
 * A failed database query without the data it quoted (ADR-129). A driver's error repeats the
 * query's parameters (drizzle) and can repeat values in PostgreSQL's message, detail, hint, context
 * and internal query; this keeps the SQLSTATE, the names PostgreSQL gave and the stack frames of the
 * error it replaces. Its message is PostgreSQL's when that SQLSTATE's messages quote no values, and
 * otherwise names the SQLSTATE and those names.
 */
export class DatabaseQueryError extends Error {
  readonly [DATABASE_QUERY_ERROR_BRAND] = true;
  /** The SQLSTATE, when PostgreSQL answered. */
  readonly code: string | undefined;
  readonly severity: string | undefined;
  readonly schema: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  readonly dataType: string | undefined;
  readonly constraint: string | undefined;
  readonly routine: string | undefined;

  /** `frames` are the stack frames to keep (lines starting with "at"); others are dropped. */
  constructor(facts: DatabaseQueryFacts = {}, frames: string | null = null) {
    const code = kept(SQLSTATE, facts.code);
    const constraint = kept(SQL_NAME, facts.constraint);
    const table = kept(SQL_NAME, facts.table);
    const column = kept(SQL_NAME, facts.column);
    const parts = [
      code ? `SQLSTATE ${code}` : kept(ERROR_CLASS, facts.stoppedBy),
      constraint && `constraint ${constraint}`,
      table && `table ${table}`,
      column && `column ${column}`,
    ].filter((part): part is string => Boolean(part));
    super(
      keptMessage(code, facts.message) ??
        (parts.length > 0
          ? `Database query failed (${parts.join(', ')})`
          : 'Database query failed'),
    );
    this.name = 'DatabaseQueryError';
    this.code = code;
    this.severity = kept(SEVERITY, facts.severity);
    this.schema = kept(SQL_NAME, facts.schema);
    this.table = table;
    this.column = column;
    this.dataType = kept(SQL_NAME, facts.dataType);
    this.constraint = constraint;
    this.routine = kept(SQL_NAME, facts.routine);
    const lines =
      frames === null ? [] : frames.split('\n').filter((line) => STACK_FRAME.test(line));
    if (lines.length > 0) {
      Object.defineProperty(this, 'stack', {
        value: [`${this.name}: ${this.message}`, ...lines].join('\n'),
        writable: true,
        configurable: true,
      });
    }
  }
}

export function isDatabaseQueryError(value: unknown): value is DatabaseQueryError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[DATABASE_QUERY_ERROR_BRAND] === true
  );
}

function isPostgresError(value: Record<string, unknown>): boolean {
  return (
    typeof value.severity === 'string' &&
    typeof value.code === 'string' &&
    SQLSTATE.test(value.code)
  );
}

/**
 * Whether `value` is a database driver's error, by its shape rather than its class (a second copy
 * of a library, or pg-boss's plain-object copy of an error, has another class): PostgreSQL's (a
 * severity and a SQLSTATE) or a failed drizzle query (the query's text and parameters).
 */
export function isDatabaseDriverError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || isDatabaseQueryError(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isPostgresError(record) || (typeof record.query === 'string' && Array.isArray(record.params))
  );
}

/** `error` and its causes, outermost first, without repeating one. */
function causeChain(error: unknown): object[] {
  const chain: object[] = [];
  let current: unknown = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    chain.length < CAUSE_DEPTH &&
    !chain.includes(current)
  ) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * The frames of `error`'s stack. The first line repeats the message, which can quote data on more
 * than one line, so it is removed exactly as V8 wrote it ("name: message"); a stack that does not
 * start that way, or has anything but frames after it, gives none.
 */
function stackFrames(error: object): string | null {
  const { stack, message, name } = error as { stack?: unknown; message?: unknown; name?: unknown };
  if (typeof stack !== 'string' || typeof message !== 'string') return null;
  const labels = new Set([name, error.constructor?.name, 'Error']);
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const head = !label ? message : !message ? label : `${label}: ${message}`;
    if (!stack.startsWith(`${head}\n`)) continue;
    const frames = stack.slice(head.length + 1);
    return frames.split('\n').every((line) => STACK_FRAME.test(line)) ? frames : null;
  }
  return null;
}

/**
 * The DatabaseQueryError for a driver error: the facts of the PostgreSQL error at or under it (or
 * the class of the error that stopped the query before PostgreSQL answered), and its frames.
 */
export function toDatabaseQueryError(driverError: object): DatabaseQueryError {
  const chain = causeChain(driverError);
  const postgres = chain.find((link) => isPostgresError(link as Record<string, unknown>)) as
    Record<string, unknown> | undefined;
  const deepest = chain.length > 1 ? chain[chain.length - 1] : undefined;
  return new DatabaseQueryError(
    postgres ?? { stoppedBy: deepest instanceof Error ? deepest.constructor.name : undefined },
    stackFrames(driverError),
  );
}

/**
 * `error` without a database driver's error along its causes (ADR-129). The first driver error, with
 * everything it wraps, is replaced by its DatabaseQueryError: returned in place of `error` when
 * `error` is that driver error, otherwise set as the cause of the error that wrapped it, which keeps
 * its own message and class. Anything else is returned as it is.
 */
export function withoutDriverErrors(error: unknown): unknown {
  const chain = causeChain(error);
  const index = chain.findIndex(isDatabaseDriverError);
  if (index < 0) return error;
  const safe = toDatabaseQueryError(chain[index] as object);
  if (index === 0) return safe;
  const replaced = Reflect.defineProperty(chain[index - 1] as object, 'cause', {
    value: safe,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return replaced ? error : safe;
}

/**
 * `api` with every method's failure rethrown through `withoutDriverErrors` (ADR-129), for a library
 * that queries the database on its own connection (Better Auth): its errors would otherwise reach
 * the caller, and Next.js's output, with the failed query's parameters. Methods are awaited, so
 * each returns a promise; other properties are read as they are.
 */
export function withoutDriverErrorsFrom<T extends object>(api: T): T {
  return new Proxy(api, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]): Promise<unknown> => {
        try {
          return (await Reflect.apply(value, target, args)) as unknown;
        } catch (error) {
          throw withoutDriverErrors(error);
        }
      };
    },
  });
}
