import { notFound, uuidv7, type Keyring } from '@w360/core';
import { QUEUES } from '@w360/contracts';
import {
  and,
  eq,
  templateStatusEvents,
  whatsappAccounts,
  type TemplateEventSource,
  type TemplateStatus,
  type Tx,
} from '@w360/db';
import type { JobSigner } from '../jobs/envelope';
import type { JobQueue } from '../jobs/queue';
import { credentialAad } from '../messaging/credentials';

/**
 * Writes the template service, its edits (ADR-404) and its workers share: Meta's statuses, status
 * history, sync requests, queued template jobs and the account's credential.
 */

export const PROVIDER_TEMPLATE_STATUS: Record<string, TemplateStatus> = {
  APPROVED: 'approved',
  PENDING: 'pending',
  REJECTED: 'rejected',
  PAUSED: 'paused',
  DISABLED: 'disabled',
  IN_APPEAL: 'in_appeal',
  FLAGGED: 'flagged',
  ARCHIVED: 'archived',
  PENDING_DELETION: 'pending_deletion',
  DELETED: 'deleted',
  LIMIT_EXCEEDED: 'limit_exceeded',
  LOCKED: 'locked',
};

export function mapProviderTemplateStatus(status: string | null | undefined): TemplateStatus {
  return (status && PROVIDER_TEMPLATE_STATUS[status.toUpperCase()]) || 'unknown';
}

/** Records a change in a template's status history (append-only). */
export async function insertStatusEvent(
  tx: Tx,
  tenantId: string,
  input: {
    templateId: string;
    status: string;
    reason?: string | null;
    source: TemplateEventSource;
    actorUserId?: string | null;
    at: Date;
  },
) {
  await tx.insert(templateStatusEvents).values({
    id: uuidv7(),
    tenantId,
    templateId: input.templateId,
    status: input.status.slice(0, 32),
    reason: input.reason?.slice(0, 1000) ?? null,
    source: input.source,
    actorUserId: input.actorUserId ?? null,
    occurredAt: input.at,
  });
}

/** Marks the account as asking for a template sync, which the minute sweep queues. */
export async function requestSyncTx(tx: Tx, tenantId: string, whatsappAccountId: string, at: Date) {
  await tx
    .update(whatsappAccounts)
    .set({ templatesSyncRequestedAt: at })
    .where(
      and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, whatsappAccountId)),
    );
}

/** Queues a template job, signed for the company and who asked: a member, or none for a key. */
export async function enqueueTemplateJob(
  tx: Tx | null,
  deps: { jobs: JobQueue; signer: JobSigner },
  kind: 'template.submit' | 'template.delete' | 'template.edit' | 'template.sync',
  tenantId: string,
  actorUserId: string | null,
  ref: string,
  singletonKey: string,
  priority?: number,
) {
  const queue = {
    'template.submit': QUEUES.templateSubmit.name,
    'template.delete': QUEUES.templateDelete.name,
    'template.edit': QUEUES.templateEdit.name,
    'template.sync': QUEUES.templateSync.name,
  }[kind];
  await deps.jobs.enqueue(tx, queue, deps.signer.sign({ kind, tenantId, actorUserId, ref }), {
    singletonKey,
    ...(priority !== undefined ? { priority } : {}),
  });
  // A job already waiting under the key stands for this one, at the priority asked (ADR-178).
  if (priority !== undefined) await deps.jobs.raisePriority(tx, queue, singletonKey, priority);
}

/** The company's WhatsApp Business account (404 for none). */
export async function templateAccount(tx: Tx, tenantId: string, whatsappAccountId: string) {
  const [waba] = await tx
    .select({
      id: whatsappAccounts.id,
      status: whatsappAccounts.status,
      name: whatsappAccounts.name,
      managementPausedUntil: whatsappAccounts.managementPausedUntil,
    })
    .from(whatsappAccounts)
    .where(
      and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, whatsappAccountId)),
    );
  if (!waba) throw notFound('WhatsApp account');
  return waba;
}

/**
 * The WhatsApp account's id at Meta, its decrypted token and until when Meta throttles its
 * management calls (ADR-399), or null unless it is connected.
 */
export async function wabaCredential(
  tx: Tx,
  tenantId: string,
  whatsappAccountId: string,
  keyring: Keyring,
) {
  const [waba] = await tx
    .select({
      wabaId: whatsappAccounts.wabaId,
      status: whatsappAccounts.status,
      credential: whatsappAccounts.credentialCiphertext,
      managementPausedUntil: whatsappAccounts.managementPausedUntil,
    })
    .from(whatsappAccounts)
    .where(
      and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.id, whatsappAccountId)),
    );
  if (!waba || waba.status !== 'connected' || !waba.credential) return null;
  return {
    whatsappAccountId,
    wabaId: waba.wabaId,
    token: keyring.decryptString(waba.credential, credentialAad(tenantId, whatsappAccountId)),
    managementPausedUntil: waba.managementPausedUntil,
  };
}
