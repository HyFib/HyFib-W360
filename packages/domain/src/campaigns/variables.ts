import { z } from 'zod';
import { clipText } from '@w360/core';
import { TEMPLATE_LIMITS, type TemplateParams } from '../templates/definition';

/**
 * How a campaign fills each template variable for a recipient: fixed text, the contact's name or
 * one of the company's custom fields, with a fallback for contacts without a value. A recipient
 * whose variable cannot be filled (no value and no fallback) is skipped with `missing_variable`;
 * nothing is sent with an empty or placeholder value.
 *
 * Values are read live when the recipient is queued. Runs of white space (including line breaks)
 * are collapsed to one space, because a personalised value is a short inline phrase.
 */
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const value = z.string().trim().min(1).max(TEMPLATE_LIMITS.parameterValue);
const fallback = z.string().trim().max(200);

export const variableSourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('static'), value }),
  z.object({ source: z.literal('name'), fallback: fallback.min(1, 'Enter a fallback') }),
  z.object({
    source: z.literal('field'),
    key: z.string().regex(FIELD_KEY_RE, 'Choose a field'),
    fallback: fallback.optional(),
  }),
]);
export type VariableSource = z.infer<typeof variableSourceSchema>;

export const campaignVariablesSchema = z.object({
  header: z.array(variableSourceSchema).max(1).default([]),
  body: z.array(variableSourceSchema).max(TEMPLATE_LIMITS.bodyVariables).default([]),
});
export type CampaignVariables = z.infer<typeof campaignVariablesSchema>;

export const EMPTY_VARIABLES: CampaignVariables = { header: [], body: [] };

/** Reads stored variables, treating anything unparseable as empty (the editor then asks again). */
export function readCampaignVariables(raw: unknown): CampaignVariables {
  const parsed = campaignVariablesSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_VARIABLES;
}

export interface VariableContact {
  displayName: string | null;
  attributes: Record<string, unknown>;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function attributeText(raw: unknown): string | null {
  if (typeof raw === 'string') return collapse(raw) || null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  return null;
}

function resolveOne(source: VariableSource, contact: VariableContact): string | null {
  switch (source.source) {
    case 'static':
      return collapse(source.value) || null;
    case 'name':
      return (
        (contact.displayName ? collapse(contact.displayName) : '') || collapse(source.fallback)
      );
    case 'field':
      return (
        attributeText(contact.attributes[source.key]) ??
        (source.fallback ? collapse(source.fallback) || null : null)
      );
  }
}

/**
 * Template parameters for one contact, or the first variable that could not be filled
 * (`header.1`, `body.2`, …). Values are cut to the parameter length limit.
 */
export function resolveVariables(
  variables: CampaignVariables,
  contact: VariableContact,
): { ok: true; params: TemplateParams } | { ok: false; missing: string } {
  const header: string[] = [];
  for (const [i, source] of variables.header.entries()) {
    const text = resolveOne(source, contact);
    if (!text) return { ok: false, missing: `header.${i + 1}` };
    header.push(clipText(text, TEMPLATE_LIMITS.parameterValue));
  }
  const body: string[] = [];
  for (const [i, source] of variables.body.entries()) {
    const text = resolveOne(source, contact);
    if (!text) return { ok: false, missing: `body.${i + 1}` };
    body.push(clipText(text, TEMPLATE_LIMITS.parameterValue));
  }
  return { ok: true, params: { header, body } };
}

/**
 * Checks a mapping against a template's parameter counts and the company's fields. Returns a
 * member-facing problem, or null when the mapping is complete.
 */
export function checkVariables(
  variables: CampaignVariables,
  spec: { headerParams: number; bodyParams: number },
  fieldKeys: ReadonlySet<string>,
): string | null {
  if (variables.header.length !== spec.headerParams || variables.body.length !== spec.bodyParams) {
    return 'Choose a value for every template variable.';
  }
  for (const source of [...variables.header, ...variables.body]) {
    if (source.source === 'field' && !fieldKeys.has(source.key)) {
      return 'A variable uses a custom field that no longer exists.';
    }
  }
  return null;
}

/** Keys of custom fields a mapping reads (for the snapshot's missing-value check). */
export function fieldsWithoutFallback(variables: CampaignVariables): string[] {
  return [...variables.header, ...variables.body].flatMap((s) =>
    s.source === 'field' && !s.fallback ? [s.key] : [],
  );
}
