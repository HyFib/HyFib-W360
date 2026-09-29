import type { ApiScope } from '@w360/db';
import type { Permission } from '../authz/permissions';

export type { ApiScope } from '@w360/db';

/**
 * The public API (P5-08, ADR-052): the parts the settings page and the services share. Pure
 * definitions without server dependencies, so pages can use them in the browser.
 */

export const API_SCOPE_KEYS = [
  'templates.read',
  'contacts.read',
  'contacts.write',
  'messages.send',
  'messages.send_marketing',
  'messages.reply',
  'conversations.read',
] as const satisfies readonly ApiScope[];

/**
 * What each scope allows, the member permission needed to grant it, and whether it writes
 * (writing scopes are refused while the company is suspended or restricted, as in the app).
 */
export const API_SCOPE_INFO: Record<
  ApiScope,
  { label: string; description: string; permission: Permission; writes: boolean }
> = {
  'templates.read': {
    label: 'Read templates',
    description: 'List approved templates and their variables.',
    permission: 'templates.read',
    writes: false,
  },
  'contacts.read': {
    label: 'Read contacts',
    description: 'Find contacts by phone number and read their details and consent.',
    permission: 'contacts.read',
    writes: false,
  },
  'contacts.write': {
    label: 'Create contacts and record consent',
    description: 'Create contacts and record opt-ins and opt-outs with their evidence.',
    permission: 'contacts.write',
    writes: true,
  },
  'messages.send': {
    label: 'Send utility templates',
    description: 'Send approved utility templates and read the status of messages the API sent.',
    permission: 'inbox.reply',
    writes: true,
  },
  'messages.send_marketing': {
    label: 'Send marketing templates',
    description:
      'Send approved marketing templates to contacts who opted in, within the frequency cap.',
    permission: 'campaigns.send',
    writes: true,
  },
  'messages.reply': {
    label: 'Reply with text',
    description:
      'Send text messages to contacts who wrote to the number in the last 24 hours, and read the status of messages the API sent.',
    permission: 'inbox.reply',
    writes: true,
  },
  'conversations.read': {
    label: 'Read conversations',
    description:
      "List the company's conversations and read their messages, including what contacts wrote.",
    permission: 'inbox.read_all',
    writes: false,
  },
};

/** The scopes that send messages; any of them reads the status of messages the API sent. */
export const API_SEND_SCOPES = [
  'messages.send',
  'messages.send_marketing',
  'messages.reply',
] as const satisfies readonly ApiScope[];

/** Days until a new key expires; 0 means it does not expire. */
export const API_KEY_EXPIRY_DAYS = [30, 90, 365, 0] as const;

/** How long before a key expires owners and administrators are reminded (ADR-067). */
export const API_KEY_REMINDER_DAYS = 7;

export const API_KEY_LIMITS = {
  activeKeys: 20,
  nameLength: 80,
  rotationOverlapHours: 72,
} as const;

export const API_LIMITS = {
  bodyBytes: 65_536,
  pageSize: 100,
  /** A text message's characters, as WhatsApp and the inbox allow. */
  textLength: 4096,
  idempotencyKeyLength: 255,
  idempotencyHours: 24,
  keyRate: { capacity: 50, refillPerSecond: 10 },
  companyRate: { capacity: 200, refillPerSecond: 30 },
  authFailureRate: { capacity: 20, refillPerSecond: 0.2 },
} as const;

/** `w360_` + 12 base32 characters (the key's public part), `_`, 43 base64url characters. */
export const API_TOKEN_RE = /^w360_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/;

/** Printable ASCII without spaces, as the idempotency key column accepts. */
export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** Whether a key is usable now. */
export function apiKeyState(
  key: { revokedAt: Date | null; expiresAt: Date | null },
  now: Date,
): 'active' | 'revoked' | 'expired' {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && key.expiresAt <= now) return 'expired';
  return 'active';
}

/**
 * Whether a usable key expires within API_KEY_REMINDER_DAYS days and was not rotated: the keys
 * owners and administrators are reminded about (ADR-067).
 */
export function apiKeyExpiresSoon(
  key: { revokedAt: Date | null; expiresAt: Date | null; replacedByKeyId: string | null },
  now: Date,
): boolean {
  if (apiKeyState(key, now) !== 'active' || key.replacedByKeyId || !key.expiresAt) return false;
  return key.expiresAt.getTime() - now.getTime() <= API_KEY_REMINDER_DAYS * 86_400_000;
}
