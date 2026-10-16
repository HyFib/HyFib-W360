import { clipText } from '@w360/core';

/**
 * A WhatsApp number's messaging limit tier as Meta reports it (ADR-398): the phone number's
 * `messaging_limit_tier`, which Meta's OpenAPI description (`business-messaging-api_v23.0.yaml`,
 * schema `WhatsAppAccountNumber`) describes only as "Current messaging limit tier for the account
 * number", with the values below. It says nothing of what a tier allows, so HyFib shows the tier as
 * Meta names it and never turns it into a number of conversations or customers.
 */
export const MESSAGING_LIMIT_TIERS = [
  'TIER_50',
  'TIER_250',
  'TIER_1K',
  'TIER_10K',
  'TIER_100K',
  'TIER_UNLIMITED',
] as const;

/** The most characters of a tier HyFib keeps: the column's check, as `name_status`'s (0003). */
export const MESSAGING_LIMIT_TIER_MAX = 64;

/**
 * `messaging_limit_tier` from Meta's answer: text as Meta gives it, a tier its description does not
 * list included (clipped to 64 characters, which no listed tier comes near), and null when Meta
 * gives no text (the field absent, empty or not text).
 */
export function parseMessagingLimitTier(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return clipText(value, MESSAGING_LIMIT_TIER_MAX);
}

/** Whether Meta's description lists `tier`, exactly as written. */
export function isListedMessagingLimitTier(tier: string): boolean {
  return (MESSAGING_LIMIT_TIERS as readonly string[]).includes(tier);
}

/**
 * How Settings → Channels words a number's tier, read from Meta: a listed tier as Meta names it,
 * any other text as an unknown tier, and none as not reported. Never a guessed number.
 */
export function messagingLimitText(tier: string | null): string {
  if (tier === null) return 'Messaging limit: not reported by Meta';
  if (isListedMessagingLimitTier(tier)) return `Messaging limit: ${tier}`;
  return `Messaging limit: unknown tier (${tier})`;
}

/**
 * What Channels says under its numbers when one shows a tier (research M-058): the tier is Meta's
 * for the number, while Meta has set the limits per business portfolio since 2025-10-07.
 */
export const MESSAGING_LIMIT_NOTE =
  'A number’s messaging limit is the tier Meta reports for it, named as Meta names it. Since 7 October 2025 Meta sets messaging limits per business portfolio, shared by all its numbers.';
