import { clipText } from '@w360/core';

/**
 * A WhatsApp number's messaging limit as Meta reports it (ADR-398): the
 * `whatsapp_business_manager_messaging_limit` field, which replaces the deprecated
 * `messaging_limit_tier` from Graph v24.0 (research M-059, M-008). Its values, as Meta's Business
 * SDK lists them for the field (M-059, M-199).
 */
export const MESSAGING_LIMITS = [
  'TIER_50',
  'TIER_250',
  'TIER_2K',
  'TIER_10K',
  'TIER_100K',
  'TIER_UNLIMITED',
  'UNTIERED',
] as const;

export type MessagingLimit = (typeof MESSAGING_LIMITS)[number];

/**
 * The unique customers a tier lets a business reach outside a customer service window in a moving
 * 24 hours (research M-058: 250, 2,000, 10,000, 100,000, then unlimited; 50 by the tier's name).
 */
const TIER_CUSTOMERS: Readonly<
  Record<Exclude<MessagingLimit, 'TIER_UNLIMITED' | 'UNTIERED'>, string>
> = {
  TIER_50: '50',
  TIER_250: '250',
  TIER_2K: '2,000',
  TIER_10K: '10,000',
  TIER_100K: '100,000',
};

/** The most characters of a limit HyFib keeps: the column's check, as `name_status`'s (0003). */
export const MESSAGING_LIMIT_MAX = 64;

/**
 * The limit from Meta's answer: text as Meta gives it, a value the SDK does not list included
 * (clipped to 64 characters, which no listed value comes near), and null when Meta gives no text
 * (the field absent, empty or not text).
 */
export function parseMessagingLimit(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return clipText(value, MESSAGING_LIMIT_MAX);
}

/** Whether Meta's SDK lists `limit` for the field, exactly as written. */
export function isListedMessagingLimit(limit: string): limit is MessagingLimit {
  return (MESSAGING_LIMITS as readonly string[]).includes(limit);
}

/**
 * How Settings → Channels words a number's limit, read from Meta (research M-058): a tier as the
 * unique customers it allows outside a customer service window in a moving 24 hours, shared by the
 * business portfolio; `TIER_UNLIMITED` as unlimited; `UNTIERED`, whose meaning is not documented,
 * as Meta reports it; any other text as an unknown tier; none as not reported.
 */
export function messagingLimitText(limit: string | null): string {
  if (limit === null) return 'Messaging limit: not reported by Meta';
  if (!isListedMessagingLimit(limit)) return `Messaging limit: unknown tier (${limit})`;
  if (limit === 'TIER_UNLIMITED') {
    return 'Messaging limit: unlimited (shared by the business portfolio)';
  }
  if (limit === 'UNTIERED') return 'Messaging limit: untiered (as Meta reports it)';
  return `Messaging limit: ${TIER_CUSTOMERS[limit]} unique customers outside a customer service window in a moving 24 hours (shared by the business portfolio)`;
}

/**
 * What Channels says under its numbers when one shows a limit (research M-058): what a limit counts,
 * and that Meta sets it per business portfolio since 2025-10-07.
 */
export const MESSAGING_LIMIT_NOTE =
  'A messaging limit is the number of unique customers a business can reach outside a customer service window in a moving 24 hours. Since 7 October 2025 Meta sets it per business portfolio, shared by all its numbers; HyFib shows the limit Meta reported when it last read the number.';
