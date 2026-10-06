import type { Metadata } from 'next';
import Link from 'next/link';
import { MASKABLE_ROLES, ROLE_LABELS, assertCan, can, maskPhoneNumber } from '@w360/domain';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { NumberMaskingForm } from '@/components/settings/number-masking-form';
import { CompanySecurityForm } from '@/components/settings/security-form';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Security settings' };
export const dynamic = 'force-dynamic';

export default async function SecuritySettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'tenant.read');
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Two-factor authentication policy</CardTitle>
          <CardDescription>Applies to every member of {ctx.tenant.name}.</CardDescription>
        </CardHeader>
        <CardContent>
          <CompanySecurityForm
            slug={ctx.tenant.slug}
            requireMfaAllMembers={ctx.tenant.requireMfaAllMembers}
            canEdit={can(ctx, 'tenant.security.manage')}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Hide customers&apos; numbers</CardTitle>
          <CardDescription>
            Choose the roles whose members see customers&apos; phone numbers masked.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NumberMaskingForm
            slug={ctx.tenant.slug}
            roles={MASKABLE_ROLES.map((role) => ({
              role,
              label: `${ROLE_LABELS[role].label}s`,
              description: ROLE_LABELS[role].description,
            }))}
            example={maskPhoneNumber('+919845012345')}
            maskedNumberRoles={ctx.tenant.maskedNumberRoles}
            canEdit={can(ctx, 'tenant.security.manage')}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
          <CardDescription>
            Manage your password, two-factor authentication and active sessions in{' '}
            <Link href="/account" className="text-primary underline-offset-4 hover:underline">
              account settings
            </Link>
            .
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
