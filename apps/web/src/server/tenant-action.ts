import 'server-only';
import { AppError } from '@w360/core';
import { resolveTenantContext, type TenantContext } from '@w360/domain';
import { getRuntime } from './runtime';
import { correlationId, getCurrentSession, type CurrentSession } from './session';

/** Session for server actions: errors instead of redirects so callers get a typed result. */
export async function sessionForAction(): Promise<CurrentSession> {
  const session = await getCurrentSession();
  if (!session) throw new AppError('unauthenticated', 'Your session has ended. Sign in again.');
  if (!session.user.emailVerified) throw new AppError('forbidden', 'Verify your email address first.');
  return session;
}

/**
 * Company context for a server action. The slug comes from the client and is untrusted: the
 * membership is re-verified against the database on every call.
 */
export async function tenantForAction(slug: unknown): Promise<TenantContext> {
  if (typeof slug !== 'string') throw new AppError('not_found', 'Company not found.');
  const session = await sessionForAction();
  const runtime = await getRuntime();
  return resolveTenantContext(
    { db: runtime.db, clock: runtime.clock, mfaGracePeriodHours: runtime.config.MFA_GRACE_PERIOD_HOURS },
    { userId: session.user.id, sessionId: session.sessionId, tenantSlug: slug, correlationId: await correlationId() },
  );
}
