import { pino, type Logger, type LoggerOptions } from 'pino';

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

export function createLogger(options: { name: string; level?: string; pretty?: boolean } & Partial<LoggerOptions>): Logger {
  const { name, level, ...rest } = options;
  return pino({
    name,
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...rest,
  });
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
