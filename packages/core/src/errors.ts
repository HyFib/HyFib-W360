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
