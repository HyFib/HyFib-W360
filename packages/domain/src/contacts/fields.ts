import type { ContactFieldType } from '@w360/db';

/**
 * Contact tags and custom field values. Tags are lower-case labels without commas; custom field
 * values are stored in `contacts.attributes` keyed by the field key, typed by the field definition
 * (dates as YYYY-MM-DD strings).
 */
export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_CONTACT = 50;
export const MAX_CONTACT_FIELDS = 50;
export const MAX_TEXT_VALUE_LENGTH = 500;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;
/** A number value as members type it: at most 15 digits before the point and 6 after. */
const NUMBER_RE = /^-?\d{1,15}(\.\d{1,6})?$/;

export type AttributeValue = string | number | boolean;

export function normalizeTag(
  raw: string,
): { ok: true; tag: string } | { ok: false; message: string } {
  const tag = raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  if (!tag) return { ok: false, message: 'Tags cannot be empty.' };
  if (tag.length > MAX_TAG_LENGTH)
    return { ok: false, message: `Tags are limited to ${MAX_TAG_LENGTH} characters.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f,]/.test(tag))
    return { ok: false, message: 'Tags cannot contain commas or control characters.' };
  return { ok: true, tag };
}

export function fieldKeyFromLabel(label: string): string {
  const base = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 38);
  const key = /^[a-z]/.test(base) ? base : `f_${base}`;
  return key.replace(/_+$/g, '').slice(0, 40) || 'field';
}

export function normalizeEmail(
  raw: string,
): { ok: true; email: string | null } | { ok: false; message: string } {
  const email = raw.trim();
  if (!email) return { ok: true, email: null };
  if (email.length > 254 || !EMAIL_RE.test(email))
    return { ok: false, message: 'Email address is not valid.' };
  return { ok: true, email };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Converts a submitted value to the field's type. An empty value means "remove the value"
 * (`value: null`).
 */
export function coerceFieldValue(
  field: { label: string; type: ContactFieldType },
  raw: string,
): { ok: true; value: AttributeValue | null } | { ok: false; message: string } {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  switch (field.type) {
    case 'text':
      return value.length > MAX_TEXT_VALUE_LENGTH
        ? {
            ok: false,
            message: `${field.label} is longer than ${MAX_TEXT_VALUE_LENGTH} characters.`,
          }
        : { ok: true, value };
    case 'number': {
      if (!NUMBER_RE.test(value)) return { ok: false, message: `${field.label} must be a number.` };
      return { ok: true, value: Number(value) };
    }
    case 'date':
      return validDate(value)
        ? { ok: true, value }
        : { ok: false, message: `${field.label} must be a date written as YYYY-MM-DD.` };
    case 'boolean': {
      const v = value.toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(v)) return { ok: true, value: true };
      if (['false', 'no', 'n', '0'].includes(v)) return { ok: true, value: false };
      return { ok: false, message: `${field.label} must be yes or no.` };
    }
  }
}

/**
 * Checks a value sent through the public API against the field's type (ADR-112), strictly: a string
 * for text (at most 500 characters), a number for a number (as members type them), a real date as
 * a `YYYY-MM-DD` string for a date and a boolean for yes/no. Null, or an empty string for text and
 * dates, means "remove the value" (`value: null`), as an empty field does in the app.
 */
export function apiFieldValue(
  field: { label: string; type: ContactFieldType },
  value: unknown,
): { ok: true; value: AttributeValue | null } | { ok: false; message: string } {
  if (value === null) return { ok: true, value: null };
  switch (field.type) {
    case 'text':
      return typeof value === 'string'
        ? coerceFieldValue(field, value)
        : { ok: false, message: `${field.label} takes text.` };
    case 'date':
      return typeof value === 'string'
        ? coerceFieldValue(field, value)
        : { ok: false, message: `${field.label} takes a date written as YYYY-MM-DD.` };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        return { ok: false, message: `${field.label} takes a number.` };
      return NUMBER_RE.test(String(value))
        ? { ok: true, value }
        : {
            ok: false,
            message: `${field.label} takes a number with at most 15 digits before the point and 6 after.`,
          };
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, message: `${field.label} takes true or false.` };
  }
}

/** Reads a marketing-consent cell from an import file. */
export function parseConsentCell(raw: string): 'opt_in' | 'opt_out' | 'blank' | 'unrecognised' {
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!v) return 'blank';
  if (['yes', 'y', 'true', '1', 'opted_in', 'opt_in', 'optin', 'subscribed'].includes(v))
    return 'opt_in';
  if (['no', 'n', 'false', '0', 'opted_out', 'opt_out', 'optout', 'unsubscribed'].includes(v))
    return 'opt_out';
  return 'unrecognised';
}
