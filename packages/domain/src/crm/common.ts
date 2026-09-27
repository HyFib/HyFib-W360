import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@w360/core';
import {
  and,
  contacts,
  crmActivities,
  eq,
  inArray,
  memberships,
  sql,
  users,
  type CrmActivityKind,
  type Tx,
} from '@w360/db';
import { permissionsForRoles } from '../authz/permissions';

/** A contact as CRM pages show it (members with CRM access can read contacts). */
export interface ContactRef {
  id: string;
  name: string | null;
  phone: string | null;
  erased: boolean;
}

export interface MemberRef {
  membershipId: string;
  name: string;
  /** False once the member left the company or lost CRM access. */
  active: boolean;
}

export const CRM_LIMITS = {
  /** Pipelines in use at the same time (archived ones do not count). */
  pipelines: 20,
  /** Stages in use per pipeline. */
  stages: 30,
  /** Open deals shown per board column; the count and total cover all of them. */
  boardDealsPerStage: 200,
  /** Entries shown on a timeline. */
  timeline: 100,
} as const;

export const uuidSchema = z.uuid('Invalid id.');

export function trimmed(max: number, label: string) {
  return z
    .string()
    .trim()
    .min(1, `Enter ${label}.`)
    .max(max, `${label[0]?.toUpperCase()}${label.slice(1)} is limited to ${max} characters.`);
}

/** Members with CRM access, keyed by membership id (inactive ones are marked, not dropped). */
export async function memberRefs(
  tx: Tx,
  tenantId: string,
  ids: readonly (string | null)[],
): Promise<Map<string, MemberRef>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({
      id: memberships.id,
      status: memberships.status,
      roles: memberships.roles,
      name: sql<string>`coalesce(${memberships.displayName}, ${users.name})`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, tenantId), inArray(memberships.id, wanted)));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        membershipId: r.id,
        name: r.name,
        active: r.status === 'active' && permissionsForRoles(r.roles).has('crm.read'),
      },
    ]),
  );
}

/** Active members who can work with deals and tasks (owners and assignees). */
export async function crmMembers(tx: Tx, tenantId: string): Promise<MemberRef[]> {
  const rows = await tx
    .select({
      id: memberships.id,
      roles: memberships.roles,
      name: sql<string>`coalesce(${memberships.displayName}, ${users.name})`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active')));
  return rows
    .filter((r) => permissionsForRoles(r.roles).has('crm.read'))
    .map((r) => ({ membershipId: r.id, name: r.name, active: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Owners and assignees must be active members with CRM access. */
export async function assertCrmMember(tx: Tx, tenantId: string, membershipId: string) {
  const ref = (await memberRefs(tx, tenantId, [membershipId])).get(membershipId);
  if (!ref?.active) {
    throw new AppError('validation_failed', 'Choose an active member who can use the CRM.');
  }
}

export async function contactRefs(
  tx: Tx,
  tenantId: string,
  ids: readonly (string | null)[],
): Promise<Map<string, ContactRef>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({
      id: contacts.id,
      name: contacts.displayName,
      phone: contacts.phoneE164,
      erasedAt: contacts.erasedAt,
    })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, wanted)));
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, name: r.name, phone: r.phone, erased: r.erasedAt !== null },
    ]),
  );
}

/**
 * Locks the contact against erasure for the rest of the transaction and says whether it is erased.
 * Erasure locks the contact FOR UPDATE, so a CRM change and an erasure of the same contact run one
 * after the other: erasure removes everything written before it, and a change that waited sees the
 * erasure. Every CRM write about a contact takes this lock first, before locking a deal or task,
 * because erasure locks the contact before the contact's deals and tasks.
 */
export async function lockContact(
  tx: Tx,
  tenantId: string,
  contactId: string,
): Promise<{ erased: boolean }> {
  const [row] = await tx
    .select({ erasedAt: contacts.erasedAt })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)))
    .for('key share');
  if (!row) throw notFound('Contact');
  return { erased: row.erasedAt !== null };
}

/** A contact CRM records can be attached to: it exists and was not erased (locked, see above). */
export async function assertLiveContact(tx: Tx, tenantId: string, contactId: string) {
  if ((await lockContact(tx, tenantId, contactId)).erased) {
    throw new AppError('conflict', 'This contact was erased.');
  }
}

export async function addActivity(
  tx: Tx,
  input: {
    tenantId: string;
    contactId: string;
    dealId?: string | null;
    taskId?: string | null;
    actorMembershipId: string | null;
    kind: CrmActivityKind;
    data?: Record<string, unknown>;
    body?: string | null;
    at: Date;
  },
): Promise<string> {
  const id = uuidv7();
  await tx.insert(crmActivities).values({
    id,
    tenantId: input.tenantId,
    contactId: input.contactId,
    dealId: input.dealId ?? null,
    taskId: input.taskId ?? null,
    actorMembershipId: input.actorMembershipId,
    kind: input.kind,
    data: input.data ?? {},
    body: input.body ?? null,
    createdAt: input.at,
  });
  return id;
}

export function versionConflict(): AppError {
  return new AppError(
    'conflict',
    'Someone else changed this in the meantime. Reload and try again.',
  );
}
