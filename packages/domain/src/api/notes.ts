import { z } from 'zod';
import { AppError } from '@w360/core';
import { and, contacts, crmDeals, eq } from '@w360/db';
import { recordSystemAudit } from '../audit';
import { addActivity } from '../crm/common';
import type { OutboundDeps } from '../messaging/outbound';
import { parseInput } from '../validation';
import { apiContactNotFound } from './contact-view';
import { apiActor, assertScope, type ApiContext } from './context';
import { assertCrmInPlan, invalidField } from './deals';
import {
  claimIdempotencyKey,
  storeIdempotentResponse,
  type ApiResponse,
  type IdempotencyInput,
} from './idempotency';

/**
 * Notes on the CRM timeline through the public API (ADR-268): with `notes.write` a key adds a note
 * to one of the company's contacts, or to one of its deals and so to the deal's contact, as members
 * add notes on the contact and deal pages, recorded as written through the API. Notes, like the rest
 * of the timeline, are never read through the API. A key needs the CRM in the company's plan.
 */

/** The longest note, as members write them (and as `app.crm_activities` holds them). */
export const API_NOTE_MAX_LENGTH = 4000;

/** What `POST /notes` takes: a note as members write one, about a contact or a deal. */
export const apiCreateNoteSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, 'Give the note’s text in `body`.')
      .max(API_NOTE_MAX_LENGTH, `A note is limited to ${API_NOTE_MAX_LENGTH} characters.`)
      .describe(
        `The note, as members write one on the contact and deal pages: up to ${API_NOTE_MAX_LENGTH} characters, spaces around it trimmed.`,
      ),
    contactId: z
      .uuid()
      .optional()
      .describe('The customer the note is about, as GET /contacts gives them.'),
    dealId: z
      .uuid()
      .optional()
      .describe(
        'The deal the note is about (GET /deals): the note is on its contact’s timeline too.',
      ),
  })
  .strict()
  .refine((note) => note.contactId !== undefined || note.dealId !== undefined, {
    message: 'Give `contactId`, `dealId` or both.',
    path: ['contactId'],
  });

/** A note as `POST /notes` answers it. */
export interface ApiNote {
  id: string;
  body: string;
  /** The contact whose timeline holds the note: the one given, or the deal's. */
  contactId: string;
  dealId: string | null;
  createdAt: string;
}

/**
 * Adds a note as members do (ADR-268), recorded as written by the key: to one of the company's
 * contacts (not erased), or to one of its deals and so to the deal's contact. The contact is locked
 * against erasure and merges until the note is in, as members' tasks lock it. The `note` activity
 * has no member actor and names the key, so the timeline says it came through the API; the audit log
 * names the key, never the note's text. With an Idempotency-Key a retry answers the first response.
 */
export async function apiCreateNote(
  deps: Pick<OutboundDeps, 'db' | 'clock'>,
  ctx: ApiContext,
  input: unknown,
  idempotency: IdempotencyInput | null,
): Promise<ApiResponse> {
  assertScope(ctx, 'notes.write');
  const data = parseInput(apiCreateNoteSchema, input);
  const now = deps.clock.now();
  return deps.db.run(ctx.scope, async (tx) => {
    // Claimed in the note's transaction, so a refused note leaves the key unused (ADR-052).
    let claimed: string | null = null;
    if (idempotency) {
      const claim = await claimIdempotencyKey(tx, ctx, idempotency, now);
      if ('replay' in claim) return claim.replay;
      claimed = claim.claimed;
    }
    await assertCrmInPlan(tx, ctx.tenant.id);
    const dealId = data.dealId ?? null;
    let contactId = data.contactId ?? null;
    if (dealId) {
      const [deal] = await tx
        .select({ contactId: crmDeals.contactId })
        .from(crmDeals)
        .where(and(eq(crmDeals.tenantId, ctx.tenant.id), eq(crmDeals.id, dealId)));
      if (!deal) {
        throw invalidField('dealId', 'Give the id of one of the company’s deals (GET /deals).');
      }
      if (contactId && contactId !== deal.contactId) {
        throw invalidField(
          'contactId',
          'The deal is another contact’s: leave `contactId` out, or give the deal’s contact.',
        );
      }
      contactId = deal.contactId;
    }
    if (!contactId) throw invalidField('contactId', 'Give `contactId`, `dealId` or both.');
    const [contact] = await tx
      .select({ erasedAt: contacts.erasedAt })
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenant.id), eq(contacts.id, contactId)))
      .for('key share');
    if (dealId) {
      // Merges lock both contacts first, so once the deal's contact is locked the deal stays with
      // it; a contact gone means a merge moved the deal between the reads.
      if (!contact) {
        throw new AppError('conflict', 'The deal moved to another contact meanwhile; try again.');
      }
      if (contact.erasedAt) {
        throw new AppError('conflict', 'The deal’s contact was erased, so it takes no new notes.');
      }
    } else if (!contact || contact.erasedAt) {
      throw await apiContactNotFound(tx, ctx.tenant.id, contactId);
    }
    const id = await addActivity(tx, {
      tenantId: ctx.tenant.id,
      contactId,
      dealId,
      actorMembershipId: null,
      kind: 'note',
      body: data.body,
      data: { apiKeyId: ctx.key.id },
      at: now,
    });
    await recordSystemAudit(
      tx,
      ctx.tenant.id,
      {
        action: 'crm.note_added',
        subjectType: 'crm_activity',
        subjectId: id,
        correlationId: ctx.requestId,
        metadata: { contactId, ...(dealId ? { dealId } : {}), source: 'api' },
      },
      apiActor(ctx),
    );
    const note: ApiNote = { id, body: data.body, contactId, dealId, createdAt: now.toISOString() };
    const response = { status: 201, body: { data: note } };
    if (claimed) await storeIdempotentResponse(tx, ctx, claimed, response);
    return { ...response, replayed: false };
  });
}
