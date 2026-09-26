import { redirect } from 'next/navigation';
import { getRuntime } from '@/server/runtime';
import { getCurrentSession } from '@/server/session';

export const dynamic = 'force-dynamic';

/** Entry point: route signed-in users to their last company, otherwise to sign-in/onboarding. */
export default async function Home() {
  const session = await getCurrentSession();
  if (!session) redirect('/sign-in');
  if (!session.user.emailVerified) redirect('/verify-email');
  const { tenancy } = await getRuntime();
  const slug = await tenancy.defaultCompanySlug(session.user.id);
  redirect(slug ? `/c/${slug}` : '/onboarding');
}
