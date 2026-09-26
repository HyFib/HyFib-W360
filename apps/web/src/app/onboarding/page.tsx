import type { Metadata } from 'next';
import Link from 'next/link';
import { Brand } from '@/components/brand';
import { CreateCompanyForm } from '@/components/onboarding/create-company-form';
import { getRuntime } from '@/server/runtime';
import { requireSession } from '@/server/session';

export const metadata: Metadata = { title: 'Create a company' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const session = await requireSession('/onboarding');
  const { tenancy } = await getRuntime();
  const companies = await tenancy.listMyCompanies(session.user.id);
  const timezones = Intl.supportedValuesOf('timeZone');
  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <header className="px-6 py-5">
        <Brand />
      </header>
      <main id="main" className="flex flex-1 justify-center px-4 pb-16 pt-6">
        <div className="grid w-full max-w-md gap-4">
          <CreateCompanyForm timezones={timezones} defaultTimezone="Asia/Kolkata" />
          {companies.length > 0 ? (
            <p className="text-center text-sm text-muted-foreground">
              Or go back to{' '}
              {companies.map((c, i) => (
                <span key={c.slug}>
                  {i > 0 ? ', ' : ''}
                  <Link
                    href={`/c/${c.slug}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {c.name}
                  </Link>
                </span>
              ))}
            </p>
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              Waiting for an invitation instead? Open the link from your invitation email.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
