/**
 * Phone number normalisation to E.164. This is a syntactic check (country calling code plus up to
 * 15 digits in total); numbering plans are not validated, so a well-formed but unassigned number is
 * accepted and simply fails at delivery.
 *
 * A number without an international prefix is never guessed: a bare "9876543210" could belong to
 * any country, and guessing wrong would message a stranger. Callers state how bare numbers are to
 * be read.
 */
export const E164_RE = /^\+[1-9][0-9]{6,14}$/;
export const CALLING_CODE_RE = /^[1-9][0-9]{0,2}$/;

export type PhoneInputMode =
  /** Manual entry: the number must start with + or 00. */
  | { kind: 'explicit' }
  /** Bare digits already include the country calling code (for example 919876543210). */
  | { kind: 'international' }
  /** Bare digits are national numbers for this calling code; one leading trunk 0 is dropped. */
  | { kind: 'national'; callingCode: string };

export type PhoneResult = { ok: true; e164: string } | { ok: false; message: string };

const SEPARATORS = /[\s().\-/\u00a0\u2010-\u2015]/g;

export function normalizePhone(input: string, mode: PhoneInputMode): PhoneResult {
  const raw = input.normalize('NFKC').trim();
  if (!raw) return { ok: false, message: 'Phone number is missing.' };
  if (raw.length > 40) return { ok: false, message: 'Phone number is too long.' };
  let compact = raw.replace(SEPARATORS, '');
  if (!/^\+?[0-9]+$/.test(compact)) {
    return {
      ok: false,
      message: 'Phone numbers can contain only digits, spaces, brackets, dashes and a leading +.',
    };
  }
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  if (!compact.startsWith('+')) {
    switch (mode.kind) {
      case 'explicit':
        return {
          ok: false,
          message: 'Include the country code, starting with + (for example +91 98765 43210).',
        };
      case 'international':
        compact = `+${compact}`;
        break;
      case 'national':
        if (!CALLING_CODE_RE.test(mode.callingCode)) {
          return { ok: false, message: 'The country calling code is not valid.' };
        }
        compact = `+${mode.callingCode}${compact.replace(/^0/, '')}`;
        break;
    }
  }
  if (!E164_RE.test(compact)) {
    return { ok: false, message: 'Phone number is not a valid international number.' };
  }
  return { ok: true, e164: compact };
}

/** WhatsApp ids are the international number without "+"; only E.164-shaped ids map to a phone. */
export function phoneFromWaId(waId: string | null | undefined): string | null {
  if (!waId) return null;
  const candidate = `+${waId}`;
  return E164_RE.test(candidate) ? candidate : null;
}

/** Recipient value for the Cloud API `to` field (digits with country code, no "+"). */
export function waRecipientFromPhone(e164: string): string {
  if (!E164_RE.test(e164)) throw new Error('Not an E.164 number');
  return e164.slice(1);
}
