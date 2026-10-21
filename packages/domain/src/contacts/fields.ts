import { z } from 'zod';
import type { ContactFieldType } from '@w360/db';

/**
 * Contact tags and custom field values. Tags are lower-case labels without commas; custom field
 * values are stored in `contacts.attributes` keyed by the field key, typed by the field definition
 * (dates as YYYY-MM-DD strings, a choice as its option written as the field lists it). Deal fields
 * (ADR-373, ADR-385) read their values with the same functions.
 */
export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_CONTACT = 50;
export const MAX_CONTACT_FIELDS = 50;
export const MAX_TEXT_VALUE_LENGTH = 500;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;
/** A number value as members type it: at most 15 digits before the point and 6 after. */
export const NUMBER_RE = /^-?\d{1,15}(\.\d{1,6})?$/;

export type AttributeValue = string | number | boolean;

/** The most options a choice field has (the database holds the same bound, 0301 and 0320). */
export const MAX_FIELD_OPTIONS = 50;
/** The most characters an option has (the database holds the same bound, 0301 and 0320). */
export const MAX_FIELD_OPTION_LENGTH = 80;

/** What reading a value needs to know about its field. */
export interface FieldShape {
  label: string;
  type: ContactFieldType;
  /** A choice field's options, in order; null for every other type. */
  options: readonly string[] | null;
}

/** Options compare ignoring case, as forms and CSV import match them. */
export const fieldOptionKey = (option: string) => option.toLowerCase();

/** C0 and C1 control characters, line breaks among them: never part of an option. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A choice field's options (ADR-385, ADR-407): 1 to 50, each trimmed, 1 to 80 characters without
 * control characters, none twice ignoring case, kept in the order given.
 */
export const fieldOptionsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, 'Options cannot be empty.')
      .max(MAX_FIELD_OPTION_LENGTH, `Options are limited to ${MAX_FIELD_OPTION_LENGTH} characters.`)
      .refine(
        (option) => !CONTROL_RE.test(option),
        'Options cannot hold line breaks or control characters.',
      ),
  )
  .min(1, 'Give a choice field at least one option.')
  .max(MAX_FIELD_OPTIONS, `A choice field has at most ${MAX_FIELD_OPTIONS} options.`)
  .superRefine((options, ctx) => {
    const seen = new Set<string>();
    options.forEach((option, i) => {
      const key = fieldOptionKey(option);
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: [i], message: `“${option}” is listed twice.` });
      }
      seen.add(key);
    });
  });

/**
 * Refines a field's definition so that a choice has options and no other type has any; for the
 * schemas that add contact and deal fields.
 */
export function refineFieldOptions(
  data: { type: ContactFieldType; options?: readonly string[] | undefined },
  ctx: z.RefinementCtx,
): void {
  if (data.type === 'choice' && !data.options) {
    ctx.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'Give a choice field at least one option.',
    });
  }
  if (data.type !== 'choice' && data.options) {
    ctx.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'Only choice fields have options.',
    });
  }
}

/** Whether two lists of options are the same options, written the same, in the same order. */
export function sameOptions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((option, i) => option === b[i]);
}

/**
 * The options records have chosen that a new list leaves out, or writes differently, in the current
 * list's order: a change of options is refused while there are any.
 */
export function removedChosenOptions(
  current: readonly string[],
  next: readonly string[],
  chosen: readonly string[],
): string[] {
  const used = new Set(chosen);
  const kept = new Set(next);
  return current.filter((option) => used.has(option) && !kept.has(option));
}

/** How many options a new list adds and removes, compared as written. */
export function optionChanges(
  current: readonly string[],
  next: readonly string[],
): { added: number; removed: number } {
  const before = new Set(current);
  const after = new Set(next);
  return {
    added: next.filter((option) => !before.has(option)).length,
    removed: current.filter((option) => !after.has(option)).length,
  };
}

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

/** Whether a string is a date that exists, written as YYYY-MM-DD (30 February is not). */
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Converts a submitted value to the field's type. An empty value means "remove the value"
 * (`value: null`). A choice takes one of its options whatever the case, and is stored as the option
 * is written (ADR-385, ADR-407).
 */
export function coerceFieldValue(
  field: FieldShape,
  raw: string,
): { ok: true; value: AttributeValue | null } | { ok: false; message: string } {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  switch (field.type) {
    case 'choice': {
      const key = fieldOptionKey(value);
      const option = (field.options ?? []).find((candidate) => fieldOptionKey(candidate) === key);
      return option === undefined
        ? { ok: false, message: `${field.label} must be one of its options.` }
        : { ok: true, value: option };
    }
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
 * a `YYYY-MM-DD` string for a date, a boolean for yes/no, and one of a choice's options as text,
 * written as the field lists it (ADR-407; spaces around it are ignored, as for text). Null, or an
 * empty string for text, dates and choices, means "remove the value" (`value: null`), as an empty
 * field does in the app.
 */
export function apiFieldValue(
  field: FieldShape,
  value: unknown,
): { ok: true; value: AttributeValue | null } | { ok: false; message: string } {
  if (value === null) return { ok: true, value: null };
  switch (field.type) {
    case 'choice': {
      const given = typeof value === 'string' ? value.trim() : null;
      if (given === '') return { ok: true, value: null };
      return given !== null && (field.options ?? []).includes(given)
        ? { ok: true, value: given }
        : {
            ok: false,
            message: `${field.label} takes one of its options, written as GET /contact-fields lists them.`,
          };
    }
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

/**
 * Reads a custom field value given in a query string to find contacts (ADR-113): text as written
 * (compared whatever its case), a number as members type it, a real date as `YYYY-MM-DD`, `true`
 * or `false` for yes/no, and one of a choice's options whatever its case (ADR-407; another value
 * could find nothing, so it is refused). An empty value would find nothing, so it is refused.
 */
export function apiFieldFilterValue(
  field: FieldShape,
  raw: string,
): { ok: true; value: AttributeValue } | { ok: false; message: string } {
  if (field.type === 'boolean') {
    if (raw === 'true') return { ok: true, value: true };
    if (raw === 'false') return { ok: true, value: false };
    return { ok: false, message: `${field.label} takes true or false.` };
  }
  const checked = coerceFieldValue(field, raw);
  if (!checked.ok) return checked;
  if (checked.value === null)
    return { ok: false, message: `Give a value of ${field.label} to find.` };
  return { ok: true, value: checked.value };
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
