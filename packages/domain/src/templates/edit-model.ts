import { AppError } from '@w360/core';
import type { TemplateEditState, TemplateStatus } from '@w360/db';
import { canonicalJson } from '../automations/graph';
import type { EditTemplateRequest } from '../messaging/graph';
import { fromMetaComponents, toMetaComponents, type TemplateDefinition } from './definition';

/**
 * Editing a template Meta has (ADR-404), the decisions without the database: what the request to
 * Meta carries, when HyFib refuses an edit, and how the sync settles an edit whose answer was lost.
 *
 * Meta's OpenAPI description (`editTemplate`, research M-201) confirms the call and its
 * `success: true` answer only. How often a template can be edited, which statuses allow it, whether
 * the category may change and the status an edited template gets are not confirmed, so HyFib
 * refuses only what it must (a template Meta does not have, one being deleted, an edit already on
 * its way, content it cannot represent, a category change, no change, a campaign sending it) and
 * shows Meta's own refusal for the rest.
 */

/**
 * How long after the request (or its deferral for Meta's pause, ADR-399) the sync waits for Meta's
 * components to show an edit whose answer was lost, before it calls the edit unconfirmed: as long
 * as a submission's confirmation window (ADR-019).
 */
export const TEMPLATE_EDIT_CONFIRM_WINDOW_MS = 10 * 60_000;

/** The campaign statuses in which a campaign is sending its template (ADR-404 refuses then). */
export const SENDING_CAMPAIGN_STATUSES = ['running'] as const;

/** The categories HyFib edits: those its editor represents. */
type EditableCategory = EditTemplateRequest['category'];

const isEditableCategory = (category: string): category is EditableCategory =>
  category === 'MARKETING' || category === 'UTILITY';

/**
 * The request an edit sends: the template's category as Meta last reported it (unchanged) and the
 * new content in the components creation sends.
 */
export function editTemplateRequest(
  category: EditableCategory,
  definition: TemplateDefinition,
): EditTemplateRequest {
  return { category, components: toMetaComponents({ ...definition, category }) };
}

/**
 * Whether two component lists carry the same content: compared as HyFib's editor reads them (so
 * key order, letter case of types and an example given as text or as a list do not matter), or as
 * canonical JSON when either cannot be read.
 */
export function sameTemplateContent(category: string, a: unknown[], b: unknown[]): boolean {
  const left = fromMetaComponents(category, a);
  const right = fromMetaComponents(category, b);
  if (left && right) return canonicalJson(left) === canonicalJson(right);
  return canonicalJson(a) === canonicalJson(b);
}

/** What an edit is checked against: the template as HyFib holds it. */
export interface EditableTemplate {
  status: TemplateStatus;
  providerTemplateId: string | null;
  category: string;
  components: unknown[];
  editState: TemplateEditState | null;
}

/**
 * Why HyFib cannot send an edit of this template whatever its content, or null when it can: the
 * Templates page offers the editor only then.
 */
export function templateEditBlocker(row: EditableTemplate): AppError | null {
  if (row.providerTemplateId === null) {
    return new AppError(
      'precondition_failed',
      'Meta does not have this template yet. Change the draft and submit it instead.',
    );
  }
  if (row.status === 'deleted' || row.status === 'pending_deletion') {
    return new AppError('conflict', 'This template is deleted or being deleted.');
  }
  if (row.editState === 'sending') {
    return new AppError(
      'precondition_failed',
      'An edit of this template is waiting for Meta’s answer. Edit it again once it has one.',
    );
  }
  if (!isEditableCategory(row.category) || !fromMetaComponents(row.category, row.components)) {
    return new AppError(
      'unsupported',
      'This template has content HyFib cannot edit. Edit it in WhatsApp Manager.',
    );
  }
  return null;
}

/**
 * Why HyFib refuses this edit, or null when it can be sent. `sendingCampaigns`: how many of the
 * company's campaigns using the template are sending it now.
 */
export function templateEditRefusal(
  row: EditableTemplate,
  definition: TemplateDefinition,
  sendingCampaigns: number,
): AppError | null {
  const blocker = templateEditBlocker(row);
  if (blocker) return blocker;
  if (definition.category !== row.category) {
    return new AppError(
      'validation_failed',
      `The category cannot change in an edit: it stays ${row.category.toLowerCase()}.`,
      { issues: [{ path: 'definition.category', message: 'The category cannot change.' }] },
    );
  }
  if (sameTemplateContent(row.category, row.components, toMetaComponents(definition))) {
    return new AppError('precondition_failed', 'This is the content Meta already has.');
  }
  if (sendingCampaigns > 0) {
    return new AppError(
      'precondition_failed',
      'A campaign using this template is sending. Pause it or wait until it finishes, then edit the template.',
    );
  }
  return null;
}

/** An open edit as the sync sees it. */
export interface OpenTemplateEdit {
  state: TemplateEditState | null;
  components: unknown[] | null;
  requestedAt: Date | null;
  /** When a deferral for Meta's pause runs the edit's job again (ADR-399). */
  deferredUntil: Date | null;
}

/**
 * What a sync makes of an edit still sending, given the components Meta lists now: `confirmed`
 * when they show the content sent (the answer was lost but the edit was made), `unconfirmed` when
 * they do not and the window has passed, `waiting` before that, and `none` for no edit sending.
 */
export function editReconciliation(
  edit: OpenTemplateEdit,
  category: string,
  remoteComponents: unknown[],
  now: Date,
): 'none' | 'confirmed' | 'waiting' | 'unconfirmed' {
  if (edit.state !== 'sending' || !edit.components || !edit.requestedAt) return 'none';
  if (sameTemplateContent(category, remoteComponents, edit.components)) return 'confirmed';
  const start =
    edit.deferredUntil && edit.deferredUntil > edit.requestedAt
      ? edit.deferredUntil
      : edit.requestedAt;
  return now.getTime() - start.getTime() > TEMPLATE_EDIT_CONFIRM_WINDOW_MS
    ? 'unconfirmed'
    : 'waiting';
}

/** Meta's refusal of an edit, as members and keys read it: its code and its message. */
export function editRefusalText(failure: {
  kind: string;
  code?: number;
  httpStatus?: number;
  title: string;
  detail?: string;
}): string {
  const message = (failure.detail ?? failure.title).slice(0, 800);
  if (failure.kind === 'auth') {
    return `Meta rejected the stored credential (code ${failure.code ?? failure.httpStatus ?? 'none'}): ${message}. Reconnect the WhatsApp account and edit the template again.`;
  }
  const code =
    failure.code !== undefined
      ? `code ${failure.code}`
      : failure.httpStatus !== undefined
        ? `HTTP ${failure.httpStatus}`
        : 'no code';
  return `Meta refused the edit (${code}): ${message}`;
}
