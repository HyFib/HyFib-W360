import { randomBytes } from 'node:crypto';

/**
 * Click-to-chat links (research M-160): `https://wa.me/<number>` opens a chat with a number (the
 * full international number, digits only) and `?text=` pre-fills a message the customer still sends
 * themselves. A link's reference code is appended to that message, "(ref ABC123)", so the
 * conversation it starts can be attributed to the link when the customer sends it unchanged.
 */

/** Reference codes: upper-case letters and digits without I, O, 0 and 1 (easy to read aloud). */
export const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Short-link slugs and widget ids: lower-case base32. */
export const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export const REF_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
export const SLUG_RE = /^[a-z2-7]{12}$/;
export const WIDGET_ID_RE = /^[a-z2-7]{16}$/;
/** The marker in a customer's message; matched without regard to case. */
const REF_MARKER_RE = /\(ref ([a-hj-np-z2-9]{6})\)/i;

export const GROWTH_LIMITS = {
  nameLength: 80,
  messageLength: 500,
  links: 500,
  widgets: 50,
  widgetLabelLength: 40,
  widgetGreetingLength: 200,
  /** The most ads Growth → Ads lists, and the public API gives (ADR-302). */
  adsShown: 200,
} as const;

/** A random string over a 32-character alphabet (each byte's low five bits: no modulo bias). */
export function randomToken(alphabet: string, length: number): string {
  if (alphabet.length !== 32) throw new Error('randomToken needs a 32-character alphabet');
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += alphabet[byte & 31];
  return out;
}

export const newRefCode = () => randomToken(REF_ALPHABET, 6);
export const newSlug = () => randomToken(TOKEN_ALPHABET, 12);
export const newWidgetId = () => randomToken(TOKEN_ALPHABET, 16);

/** The message a link pre-fills: the company's text, then the reference marker when it is used. */
export function prefilledText(message: string, refCode: string, includeRef: boolean): string {
  const text = message.trim();
  if (!includeRef) return text;
  return text ? `${text} (ref ${refCode})` : `(ref ${refCode})`;
}

/** The wa.me address for a number (digits only) and a pre-filled text. */
export function waMeUrl(phoneDigits: string, text: string): string {
  const digits = phoneDigits.replace(/\D/g, '');
  return text
    ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
    : `https://wa.me/${digits}`;
}

/** The reference code in a customer's message, if it carries one. */
export function findRefCode(text: string): string | null {
  const match = REF_MARKER_RE.exec(text);
  return match?.[1] ? match[1].toUpperCase() : null;
}

/** Digits of a display number such as "+91 90000 00000" (null when it cannot be a WhatsApp number). */
export function phoneDigits(display: string | null): string | null {
  const digits = (display ?? '').replace(/\D/g, '');
  return /^[0-9]{6,15}$/.test(digits) ? digits : null;
}
