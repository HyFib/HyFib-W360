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
 * 24 hours, as research M-058 gives them (250, 2,000, 10,000, 100,000, then unlimited). Research
 * gives no figure for `TIER_50` or `UNTIERED`.
 */
const TIER_CUSTOMERS: Readonly<
  Record<Exclude<MessagingLimit, 'TIER_50' | 'TIER_UNLIMITED' | 'UNTIERED'>, string>
> = {
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
 * How Settings → Channels words a number's limit, read from Meta (research M-058): a tier M-058
 * gives a figure for as the unique customers it allows outside a customer service window in a
 * moving 24 hours, shared by the business portfolio; `TIER_UNLIMITED` as unlimited; `TIER_50` and
 * `UNTIERED`, which research does not explain, as Meta reports them, without a number; any other
 * text as an unknown tier; none as not reported.
 */
export function messagingLimitText(limit: string | null): string {
  if (limit === null) return 'Messaging limit: not reported by Meta';
  if (!isListedMessagingLimit(limit)) return `Messaging limit: unknown tier (${limit})`;
  if (limit === 'TIER_UNLIMITED') {
    return 'Messaging limit: unlimited (shared by the business portfolio)';
  }
  if (limit === 'TIER_50') return 'Messaging limit: TIER_50 (as Meta reports it)';
  if (limit === 'UNTIERED') return 'Messaging limit: untiered (as Meta reports it)';
  return `Messaging limit: ${TIER_CUSTOMERS[limit]} unique customers outside a customer service window in a moving 24 hours (shared by the business portfolio)`;
}

/** What Graph answered when it refused a health read that asked for the limit. */
export interface MessagingLimitRefusal {
  kind: string;
  httpStatus?: number;
  code?: number;
  subcode?: number;
  detail?: string;
}

/** The most characters of Meta's message about a refusal that the audit keeps. */
export const MESSAGING_LIMIT_REFUSAL_DETAIL_MAX = 200;

/** A link, which may carry a secret in its query. */
const LINK = /\bhttps?:\/\/\S+/gi;
/** A Meta access token (`EAA…`), should Meta's message quote one. */
const ACCESS_TOKEN = /\bEAA[0-9A-Za-z]{8,}/g;

/**
 * The audit metadata of a number set up without its limit because Graph refused the read that
 * asked for it (ADR-398): the refusal's kind, HTTP status, code and subcode, and Meta's message
 * clipped to 200 characters with any link or access token in it replaced, so the append-only log
 * never keeps either. Never the request, the token or the address asked.
 */
export function messagingLimitRefusalMetadata(
  refusal: MessagingLimitRefusal,
): Record<string, string | number | null> {
  const detail = refusal.detail
    ? clipText(
        refusal.detail.replace(LINK, '[link]').replace(ACCESS_TOKEN, '[token]'),
        MESSAGING_LIMIT_REFUSAL_DETAIL_MAX,
      )
    : null;
  return {
    messagingLimit: 'refused',
    kind: refusal.kind,
    httpStatus: refusal.httpStatus ?? null,
    code: refusal.code ?? null,
    subcode: refusal.subcode ?? null,
    detail,
  };
}

/**
 * What Channels says under its numbers when one shows a limit (research M-058): what a limit counts,
 * and that Meta sets it per business portfolio since 2025-10-07.
 */
export const MESSAGING_LIMIT_NOTE =
  'A messaging limit is the number of unique customers a business can reach outside a customer service window in a moving 24 hours. Since 7 October 2025 Meta sets it per business portfolio, shared by all its numbers; HyFib shows the limit Meta reported when it last read the number.';
