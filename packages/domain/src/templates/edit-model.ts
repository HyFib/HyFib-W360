import { AppError } from '@w360/core';
import type { TemplateEditState, TemplateStatus } from '@w360/db';
import { canonicalJson } from '../automations/graph';
import type { EditTemplateRequest } from '../messaging/graph';
import {
  fromMetaComponents,
  linkButtons,
  sendSpecFor,
  toMetaComponents,
  type TemplateDefinition,
} from './definition';

/**
 * Editing a template Meta has (ADR-404), the decisions without the database: what the request to
 * Meta carries, when HyFib refuses an edit, and how the sync settles an edit whose answer was lost.
 *
 * Meta's OpenAPI description (`editTemplate`, research M-201) confirms the call and its
 * `success: true` answer only. How often a template can be edited, which statuses allow it, whether
 * the category may change and the status an edited template gets are not confirmed, so HyFib
 * refuses only what it must (a template Meta does not have, one being deleted, an edit already on
 * its way, content it cannot represent, a category change, no change, a campaign scheduled or
 * sending, and a change of variables or buttons something still sends) and shows Meta's own
 * refusal for the rest.
 */

/**
 * How long after the request (or its deferral for Meta's pause, ADR-399) the sync waits for Meta's
 * components to show an edit whose answer was lost, before it calls the edit unconfirmed: as long
 * as a submission's confirmation window (ADR-019).
 */
export const TEMPLATE_EDIT_CONFIRM_WINDOW_MS = 10 * 60_000;

/**
 * The campaign statuses in which a campaign is about to send, or sending, its template: an edit is
 * refused while one exists (ADR-404), read under a share lock so a campaign the runner is starting
 * is waited for.
 */
export const SENDING_CAMPAIGN_STATUSES = ['scheduled', 'running'] as const;

/**
 * How long before the window ends the job still sends an edit: a request sent later could be
 * applied by Meta after the sync has called the edit unconfirmed (the sync also confirms a late
 * edit, but the margin keeps that rare).
 */
export const TEMPLATE_EDIT_SEND_MARGIN_MS = 60_000;

/**
 * What senders rely on in a template (ADR-404): how many header, body and link values a send
 * fills, at which buttons the links are, and the quick-reply buttons with their titles (an
 * automation's asking step branches on them; order rules confirm or cancel by them). Automations,
 * campaigns and store rules store values for exactly this shape, and stop when it changes.
 */
export interface TemplateShape {
  header: number;
  body: number;
  links: number[];
  quickReplies: { index: number; title: string }[];
}

/** The shape of content in Meta's components, or null when HyFib cannot read it. */
export function templateShape(category: string, components: unknown[]): TemplateShape | null {
  const spec = sendSpecFor(category, components);
  if (!spec.supported) return null;
  return {
    header: spec.headerParams,
    body: spec.bodyParams,
    links: linkButtons(spec.definition).map((b) => b.index),
    quickReplies: spec.definition.buttons.flatMap((b, index) =>
      b.type === 'QUICK_REPLY' ? [{ index, title: b.text }] : [],
    ),
  };
}

/** Whether an edit changes what senders rely on (a template HyFib cannot read counts as changed). */
export function shapeChanged(category: string, before: unknown[], after: unknown[]): boolean {
  const a = templateShape(category, before);
  const b = templateShape(category, after);
  return !a || !b || canonicalJson(a) !== canonicalJson(b);
}

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

/** What else an edit is checked against: who uses the template now. */
export interface EditUse {
  /** The company's campaigns using it that are scheduled or sending. */
  sendingCampaigns: number;
  /**
   * What sends it with stored values (unfinished campaigns, published automations, store rules),
   * as members read them; asked only when the edit changes the template's shape.
   */
  users: () => Promise<string[]> | string[];
}

/**
 * Why HyFib refuses this edit, or null when it can be sent: the template's own checks, then a
 * campaign scheduled or sending, then a change of variables or buttons something still sends.
 */
export async function templateEditRefusal(
  row: EditableTemplate,
  definition: TemplateDefinition,
  use: EditUse,
): Promise<AppError | null> {
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
  if (use.sendingCampaigns > 0) {
    return new AppError(
      'precondition_failed',
      'A campaign using this template is scheduled or sending. Wait until it finishes, or pause or cancel it, then edit the template.',
    );
  }
  const after = toMetaComponents(definition);
  if (shapeChanged(row.category, row.components, after)) {
    const users = await use.users();
    if (users.length > 0) {
      const named = users.slice(0, 3).join(', ');
      const more = users.length > 3 ? ` and ${users.length - 3} more` : '';
      return new AppError(
        'precondition_failed',
        `This edit changes the template’s variables or buttons, which ${named}${more} rely on. Change those first so they no longer use it, or add a new template instead.`,
      );
    }
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

/** When an edit's window starts: the later of its request and its deferral for Meta's pause. */
export function editWindowStart(requestedAt: Date, deferredUntil: Date | null): Date {
  return deferredUntil && deferredUntil > requestedAt ? deferredUntil : requestedAt;
}

/**
 * What a sync makes of an open edit, given the components Meta lists now and the database's time:
 * `confirmed` when they show the content sent, whether the edit is still sending (its answer was
 * lost) or already failed (Meta applied it after the window, or after a refusal HyFib could not
 * read as one); for a sending edit without them, `unconfirmed` once the window has passed and
 * `waiting` before; `none` for no open edit, or a failed one Meta's content does not show.
 */
export function editReconciliation(
  edit: OpenTemplateEdit,
  category: string,
  remoteComponents: unknown[],
  now: Date,
): 'none' | 'confirmed' | 'waiting' | 'unconfirmed' {
  if (!edit.state || !edit.components || !edit.requestedAt) return 'none';
  if (sameTemplateContent(category, remoteComponents, edit.components)) return 'confirmed';
  if (edit.state !== 'sending') return 'none';
  const start = editWindowStart(edit.requestedAt, edit.deferredUntil);
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
