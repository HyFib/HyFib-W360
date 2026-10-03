import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';
import { isDatabaseDriverError, toDatabaseQueryError } from './errors';

/**
 * Structured JSON logging with default redaction. Never log provider tokens, passwords, session
 * cookies, message bodies or raw webhook payloads. The redaction list is a safety net, not a
 * licence to pass sensitive objects to the logger.
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'access_token',
  '*.access_token',
  'refreshToken',
  '*.refreshToken',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'cookie',
  '*.cookie',
  'body',
  '*.body',
  'rawBody',
  '*.rawBody',
  'card',
  '*.card',
];

export type { Logger };

const CAUSE_DEPTH = 8;

/**
 * Stands in for `error` in a log line with another cause, leaving `error` as it is: its prototype is
 * `error`, so pino reads the same class and properties.
 */
function withCause(error: object, cause: unknown): object {
  return Object.create(error, {
    message: { value: (error as { message?: unknown }).message },
    stack: { value: (error as { stack?: unknown }).stack },
    cause: { value: cause },
  }) as object;
}

/** `value` with a database driver's error along its causes replaced by its DatabaseQueryError. */
function loggable(value: unknown, depth = 0): unknown {
  if (typeof value !== 'object' || value === null || depth >= CAUSE_DEPTH) return value;
  if (isDatabaseDriverError(value)) return toDatabaseQueryError(value);
  const cause = (value as { cause?: unknown }).cause;
  const safeCause = loggable(cause, depth + 1);
  return safeCause === cause ? value : withCause(value, safeCause);
}

/**
 * pino's error serializer, given the error without a database driver's error along its causes or
 * among the errors it aggregates (ADR-129): a failed query's error repeats the query's parameters,
 * and PostgreSQL's can repeat values in its message and detail. Every logger uses it for `err`.
 */
export function serializeError(value: unknown): unknown {
  const safe = loggable(value);
  const serialized = stdSerializers.err(safe as Error) as unknown;
  const errors = (safe as { errors?: unknown } | null)?.errors;
  if (Array.isArray(errors) && typeof serialized === 'object' && serialized !== null) {
    (serialized as { aggregateErrors?: unknown }).aggregateErrors = errors.map(serializeError);
  }
  return serialized;
}

export function createLogger(
  options: { name: string; level?: string; pretty?: boolean } & Partial<LoggerOptions>,
  destination?: DestinationStream,
): Logger {
  const { name, level, serializers, ...rest } = options;
  const config: LoggerOptions = {
    name,
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...rest,
    // Last, so that no logger writes an error without it.
    serializers: { ...serializers, err: serializeError },
  };
  return destination ? pino(config, destination) : pino(config);
}

/** Masks an email for logs/audit metadata: `jane.doe@example.com` -> `j***@example.com`. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local[0]}***@${domain}`;
}

/** Masks a phone number keeping the last 4 digits. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}
