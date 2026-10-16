import { validationFailed } from '@w360/core';
import type { DealFieldType } from '@w360/db';
import { dealFieldOptionKey } from './deal-field-values';

/**
 * Filtering the deals board, the won and lost lists, the export of what they show (ADR-391,
 * ADR-394) and `GET /deals` through the API (ADR-394) by one custom deal field:
 * a choice field (ADR-385) by one of its options or by having none, or a yes/no field by yes, no or
 * none. The filter travels in the page's address as `field=<key>:<option>` (`<key>:yes`,
 * `<key>:no` for a yes/no field), and `field=<key>:` for deals without a value: keys never hold a
 * colon (`^[a-z][a-z0-9_]{0,39}$`) and options are never empty, so the text splits unambiguously at
 * its first colon.
 *
 * Nothing in the address is trusted: it is resolved against the company's own field definitions,
 * read in the company's scope, and only a field and an option found there reach the query, as the
 * value stored on deals (an option as written, or a boolean). Pure, so it is unit-tested alone.
 *
 * The board and the won and lost lists ignore a filter that does not resolve and say so
 * (`dealFieldFilterView`); the export and the API refuse it (`requireDealFieldFilter`), so neither
 * is ever wider than asked.
 */

/** The longest filter text taken: a 40-character key, a colon and an 80-character option, with room. */
export const DEAL_FIELD_FILTER_MAX_LENGTH = 200;

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** The filter as the address gives it, not yet checked against any field. */
export interface DealFieldFilterParam {
  key: string;
  /** The option (or `yes`/`no`) as written in the address; null for deals without a value. */
  value: string | null;
}

/**
 * Reads `<key>:<option>` (or `<key>:`); null for an empty, malformed or overlong text. A value that
 * is only spaces is malformed (options are trimmed, so none is blank).
 */
export function parseDealFieldFilterParam(
  raw: string | null | undefined,
): DealFieldFilterParam | null {
  if (!raw || raw.length > DEAL_FIELD_FILTER_MAX_LENGTH) return null;
  const colon = raw.indexOf(':');
  if (colon < 0) return null;
  const key = raw.slice(0, colon);
  if (!KEY_RE.test(key)) return null;
  const rest = raw.slice(colon + 1);
  if (rest === '') return { key, value: null };
  const value = rest.trim();
  return value ? { key, value } : null;
}

/** The address text of a filter, as `parseDealFieldFilterParam` reads it. */
export function dealFieldFilterParam(key: string, value: string | null): string {
  return `${key}:${value ?? ''}`;
}

/** What filtering needs to know about a company's field. */
export interface FilterableFieldShape {
  key: string;
  label: string;
  type: DealFieldType;
  options: readonly string[] | null;
}

/** A field the board can be filtered by, with the choices its control offers. */
export interface DealFieldFilterField {
  key: string;
  label: string;
  type: 'choice' | 'boolean';
  /** Each choice's address text and label, the options (or Yes, No) first, then "Not set". */
  choices: { param: string; label: string }[];
}

/** A filter found among the company's fields, as the query and the page use it. */
export interface ResolvedDealFieldFilter {
  key: string;
  label: string;
  type: 'choice' | 'boolean';
  /** The value deals store (the option as written, or a boolean); null for deals without one. */
  stored: string | boolean | null;
  /** The address text, canonical (the option as written, `yes` or `no`). */
  param: string;
  /** The choice as the page names it: the option, Yes, No or Not set. */
  valueLabel: string;
}

/** Why a filter from the address was not applied. */
export type DealFieldFilterProblem = 'malformed' | 'no_field' | 'not_filterable' | 'no_option';

const isFilterable = (
  field: FilterableFieldShape,
): field is FilterableFieldShape & { type: 'choice' | 'boolean' } =>
  field.type === 'choice' || field.type === 'boolean';

/** The company's choice and yes/no fields, in the fields' order, with their choices. */
export function filterableDealFields(
  fields: readonly FilterableFieldShape[],
): DealFieldFilterField[] {
  return fields.filter(isFilterable).map((field) => {
    const values: [string, string][] =
      field.type === 'choice'
        ? (field.options ?? []).map((option) => [option, option])
        : [
            ['yes', 'Yes'],
            ['no', 'No'],
          ];
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      choices: [
        ...values.map(([value, label]) => ({
          param: dealFieldFilterParam(field.key, value),
          label,
        })),
        { param: dealFieldFilterParam(field.key, null), label: 'Not set' },
      ],
    };
  });
}

/**
 * Finds the filter among the company's fields: a choice field takes one of its options (any case,
 * since options never differ by case alone, resolved to the option as written, which is how deals
 * store it), a yes/no field `yes` or `no` (any case), and either one "not set". Anything else is
 * a problem the caller reports or refuses.
 */
export function resolveDealFieldFilter(
  fields: readonly FilterableFieldShape[],
  param: DealFieldFilterParam | null,
): { ok: true; filter: ResolvedDealFieldFilter } | { ok: false; problem: DealFieldFilterProblem } {
  if (!param) return { ok: false, problem: 'malformed' };
  const field = fields.find((candidate) => candidate.key === param.key);
  if (!field) return { ok: false, problem: 'no_field' };
  if (!isFilterable(field)) return { ok: false, problem: 'not_filterable' };
  const resolved = (stored: string | boolean | null, valueLabel: string) => ({
    ok: true as const,
    filter: {
      key: field.key,
      label: field.label,
      type: field.type,
      stored,
      param: dealFieldFilterParam(
        field.key,
        stored === null ? null : typeof stored === 'boolean' ? (stored ? 'yes' : 'no') : stored,
      ),
      valueLabel,
    },
  });
  if (param.value === null) return resolved(null, 'Not set');
  const wanted = dealFieldOptionKey(param.value);
  if (field.type === 'boolean') {
    if (wanted === 'yes') return resolved(true, 'Yes');
    if (wanted === 'no') return resolved(false, 'No');
    return { ok: false, problem: 'no_option' };
  }
  const option = (field.options ?? []).find(
    (candidate) => dealFieldOptionKey(candidate) === wanted,
  );
  return option === undefined ? { ok: false, problem: 'no_option' } : resolved(option, option);
}

/** What the audit log records of a filter: the field's key and the kind of match, never the option. */
export function dealFieldFilterAudit(filter: ResolvedDealFieldFilter): {
  key: string;
  match: 'option' | 'yes' | 'no' | 'not_set';
} {
  return {
    key: filter.key,
    match:
      filter.stored === null
        ? 'not_set'
        : typeof filter.stored === 'boolean'
          ? filter.stored
            ? 'yes'
            : 'no'
          : 'option',
  };
}

/** The refusal's words for a filter an export cannot apply. */
export function dealFieldFilterProblemMessage(problem: DealFieldFilterProblem): string {
  switch (problem) {
    case 'malformed':
      return 'The deal field filter is not valid.';
    case 'no_field':
      return 'This deal field no longer exists.';
    case 'not_filterable':
      return 'Deals can be filtered only by a choice or yes/no field.';
    case 'no_option':
      return 'This option is not one of the deal field’s options.';
  }
}

/** A view's field filter (ADR-391, ADR-394): the fields to choose from and what was applied. */
export interface DealFieldFilterView {
  /** The company's choice and yes/no fields, to choose from. */
  fields: DealFieldFilterField[];
  /** The filter applied, found among the company's fields; null for every deal. */
  applied: ResolvedDealFieldFilter | null;
  /** A filter was asked for but matches no field or option (a stale or edited link). */
  ignored: boolean;
}

/**
 * The lenient reading of the board and the won and lost lists: an absent or empty text asks for
 * nothing, and one that does not resolve is ignored and reported, so a stale link shows every deal
 * instead of an error.
 */
export function dealFieldFilterView(
  fields: readonly FilterableFieldShape[],
  raw: string | null | undefined,
): DealFieldFilterView {
  const asked = raw !== null && raw !== undefined && raw !== '';
  const resolved = asked ? resolveDealFieldFilter(fields, parseDealFieldFilterParam(raw)) : null;
  const applied = resolved?.ok ? resolved.filter : null;
  return { fields: filterableDealFields(fields), applied, ignored: asked && applied === null };
}

/** The refusal of a filter that cannot be applied, naming `field`, in the caller's words. */
export function dealFieldFilterRefusal(
  problem: DealFieldFilterProblem,
  message: (problem: DealFieldFilterProblem) => string = dealFieldFilterProblemMessage,
) {
  const text = message(problem);
  return validationFailed(text, [{ path: 'field', message: text }]);
}

/**
 * The strict reading of the export and `GET /deals` (ADR-394): the filter, or a refusal naming
 * `field` (400 from the export, 422 through the API). An empty text is malformed here: a filter
 * asked for must filter.
 */
export function requireDealFieldFilter(
  fields: readonly FilterableFieldShape[],
  raw: string,
  message?: (problem: DealFieldFilterProblem) => string,
): ResolvedDealFieldFilter {
  const resolved = resolveDealFieldFilter(fields, parseDealFieldFilterParam(raw));
  if (!resolved.ok) throw dealFieldFilterRefusal(resolved.problem, message);
  return resolved.filter;
}
