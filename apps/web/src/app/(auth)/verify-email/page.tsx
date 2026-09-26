import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { VerifyEmailPanel } from '@/components/auth/verify-email-panel';
import { getCurrentSession } from '@/server/session';

export const metadata: Metadata = { title: 'Confirm your email' };
export const dynamic = 'force-dynamic';

export default async function VerifyEmailPage() {
  const session = await getCurrentSession();
  if (session?.user.emailVerified) redirect('/');
  return <VerifyEmailPanel email={session?.user.email ?? null} />;
}
