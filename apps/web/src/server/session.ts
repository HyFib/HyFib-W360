import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { AppError, isAppError, resolveClientIp, uuidv7 } from '@w360/core';
import {
  resolveTenantContext,
  type PlatformActor,
  type RequestMeta,
  type TenantContext,
} from '@w360/domain';
import { getRuntime } from './runtime';

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
}

export interface CurrentSession {
  user: CurrentUser;
  sessionId: string;
  sessionCreatedAt: Date;
}

/** Correlation id assigned by the proxy for this request (falls back to a fresh id). */
export async function correlationId(): Promise<string> {
  const h = await headers();
  const value = h.get('x-request-id');
  return value && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : uuidv7();
}

export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  const { trustedProxies } = await getRuntime();
  return {
    ipAddress: resolveClientIp(h.get('x-forwarded-for'), h.get('x-real-ip'), trustedProxies),
    userAgent: h.get('user-agent'),
  };
}

/** Current authenticated session, deduplicated per request. Always validated against the DB. */
export const getCurrentSession = cache(async (): Promise<CurrentSession | null> => {
  const { auth } = await getRuntime();
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result) return null;
  const user = result.user as typeof result.user & { twoFactorEnabled?: boolean | null };
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled === true,
    },
    sessionId: result.session.id,
    sessionCreatedAt: new Date(result.session.createdAt),
  };
});

export async function requireSession(nextPath?: string): Promise<CurrentSession> {
  const session = await getCurrentSession();
  if (!session) {
    redirect(nextPath ? `/sign-in?next=${encodeURIComponent(nextPath)}` : '/sign-in');
  }
  if (!session.user.emailVerified) redirect('/verify-email');
  return session;
}

/**
 * Resolves the company from the URL slug and verifies the caller's active membership. Any failure
 * renders a 404 so non-members cannot distinguish "not a member" from "does not exist".
 */
export const requireTenant = cache(async (slug: string): Promise<TenantContext> => {
  const session = await requireSession(`/c/${slug}`);
  const runtime = await getRuntime();
  try {
    return await resolveTenantContext(
      {
        db: runtime.db,
        clock: runtime.clock,
        mfaGracePeriodHours: runtime.config.MFA_GRACE_PERIOD_HOURS,
      },
      {
        userId: session.user.id,
        sessionId: session.sessionId,
        sessionCreatedAt: session.sessionCreatedAt,
        tenantSlug: slug,
        correlationId: await correlationId(),
      },
    );
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
});

/** Platform staff only; requires MFA. Non-staff get a 404. */
export const requirePlatformActor = cache(async (): Promise<PlatformActor> => {
  const session = await requireSession('/platform');
  const runtime = await getRuntime();
  const actor = await runtime.platform.resolveActor(session.user.id, await correlationId());
  if (!actor) notFound();
  return actor;
});

/**
 * Defence in depth on top of Next.js's built-in Server Action origin check: mutating requests must
 * carry an Origin header that matches a trusted origin exactly (requests without one are refused).
 */
export async function assertTrustedOrigin(): Promise<void> {
  const h = await headers();
  const origin = h.get('origin');
  const { config } = await getRuntime();
  const trusted = new Set(
    [config.APP_BASE_URL, ...(config.TRUSTED_ORIGINS ?? '').split(',')]
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean),
  );
  if (!origin || !trusted.has(origin)) {
    throw new AppError('forbidden', 'Request origin not allowed.');
  }
}
