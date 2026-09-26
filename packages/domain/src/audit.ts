import { uuidv7 } from '@w360/core';
import {
  auditEvents,
  securityEvents,
  systemScope,
  type AuditActorType,
  type Database,
  type Tx,
} from '@w360/db';
import type { TenantContext } from './authz/context';

/**
 * Audit trail for sensitive actions. Rows are append-only (enforced by privileges and a trigger).
 * Metadata must never include message content, secrets or unnecessary personal data; record ids
 * and changed field names instead of values where possible.
 */
export interface AuditEntry {
  action: string;
  subjectType?: string;
  subjectId?: string;
  result?: 'success' | 'denied' | 'failure';
  metadata?: Record<string, unknown>;
}

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function recordAudit(
  tx: Tx,
  ctx: Pick<TenantContext, 'tenant' | 'user' | 'correlationId'>,
  entry: AuditEntry,
  meta: RequestMeta = {},
  actor: { type: AuditActorType; id: string | null } = { type: 'user', id: ctx.user.id },
): Promise<void> {
  await tx.insert(auditEvents).values({
    id: uuidv7(),
    tenantId: ctx.tenant.id,
    actorType: actor.type,
    actorId: actor.id,
    action: entry.action,
    subjectType: entry.subjectType ?? null,
    subjectId: entry.subjectId ?? null,
    result: entry.result ?? 'success',
    correlationId: ctx.correlationId,
    ipAddress: normalizeIp(meta.ipAddress),
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
    metadata: entry.metadata ?? {},
  });
}

/** System-actor audit entry for worker/provider initiated changes. */
export async function recordSystemAudit(
  tx: Tx,
  tenantId: string,
  entry: AuditEntry & { correlationId?: string },
  actor: { type: AuditActorType; id: string | null } = { type: 'system', id: null },
): Promise<void> {
  await tx.insert(auditEvents).values({
    id: uuidv7(),
    tenantId,
    actorType: actor.type,
    actorId: actor.id,
    action: entry.action,
    subjectType: entry.subjectType ?? null,
    subjectId: entry.subjectId ?? null,
    result: entry.result ?? 'success',
    correlationId: entry.correlationId ?? null,
    metadata: entry.metadata ?? {},
  });
}

export interface SecurityEvent {
  eventType: string;
  severity: 'info' | 'warning' | 'critical';
  userId?: string | null;
  tenantId?: string | null;
  correlationId?: string | null;
  details?: Record<string, unknown>;
}

/** Security events outside any tenant context. Insert-only for runtime roles. */
export async function recordSecurityEvent(
  db: Database,
  event: SecurityEvent,
  meta: RequestMeta = {},
): Promise<void> {
  await db.run(systemScope, async (tx) => {
    await tx.insert(securityEvents).values({
      id: uuidv7(),
      eventType: event.eventType,
      severity: event.severity,
      userId: event.userId ?? null,
      tenantId: event.tenantId ?? null,
      ipAddress: normalizeIp(meta.ipAddress),
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      correlationId: event.correlationId ?? null,
      details: event.details ?? {},
    });
  });
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const first = (ip.split(',')[0] ?? '').trim();
  const unwrapped = first.startsWith('::ffff:') ? first.slice(7) : first;
  return IPV4.test(unwrapped) || (IPV6.test(unwrapped) && unwrapped.includes(':'))
    ? unwrapped
    : null;
}
