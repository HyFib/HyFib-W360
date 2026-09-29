import { cidr, jsonb, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { appSchema } from './tenancy';

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** What an API key may do (ADR-052); each stands for a member permission needed to grant it. */
export const API_SCOPES = [
  'templates.read',
  'contacts.read',
  'contacts.write',
  'messages.send',
  'messages.send_marketing',
  'messages.reply',
  'conversations.read',
  'conversations.write',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/**
 * Company API keys (migration 0024). The runtime role can read everything but `token_hash`, which
 * only the authentication function compares.
 */
export const apiKeys = appSchema.table('api_keys', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  tokenHash: text('token_hash').notNull(),
  scopes: text('scopes').array().notNull().$type<ApiScope[]>(),
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  expiresAt: tz('expires_at'),
  lastUsedAt: tz('last_used_at'),
  revokedAt: tz('revoked_at'),
  revokedByUserId: text('revoked_by_user_id'),
  replacedByKeyId: uuid('replaced_by_key_id'),
  /** When owners and administrators were emailed that the key expires soon (ADR-067). */
  expiryRemindedAt: tz('expiry_reminded_at'),
  /** The networks the key accepts requests from (ADR-076); null accepts any address. */
  allowedNetworks: cidr('allowed_networks').array(),
});

/** Stored responses of requests sent with an Idempotency-Key (24 hours). */
export const apiIdempotencyKeys = appSchema.table('api_idempotency_keys', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  apiKeyId: uuid('api_key_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  statusCode: smallint('status_code'),
  response: jsonb('response').$type<Record<string, unknown>>(),
  createdAt: tz('created_at').notNull().defaultNow(),
  expiresAt: tz('expires_at').notNull(),
});
