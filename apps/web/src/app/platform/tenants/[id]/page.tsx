import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { MfaResetForm, SupportGrantForm, TenantStatusForm } from '@/components/platform/platform-forms';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Company · Platform' };
export const dynamic = 'force-dynamic';

export default async function PlatformTenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requirePlatformActor();
  const { platform } = await getRuntime();
  const companies = await platform.listTenants(actor, { limit: 200 });
  const company = companies.find((c) => c.id === id);
  if (!company) notFound();
  const owners = await platform.tenantOwners(actor, id);
  return (
    <div className="grid gap-6">
      <Link href="/platform" className="text-sm text-primary underline-offset-4 hover:underline">← All companies</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{company.name}</h1>
        <Badge tone={company.status === 'active' ? 'success' : 'warning'}>{company.status}</Badge>
      </div>
      {company.statusReason ? <p className="text-sm text-muted-foreground">Last status reason: {company.statusReason}</p> : null}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Account status</CardTitle>
            <CardDescription>Suspension stops outbound activity; ingestion, exports, billing and owner access continue.</CardDescription>
          </CardHeader>
          <CardContent><TenantStatusForm tenantId={company.id} status={company.status} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Support access</CardTitle>
            <CardDescription>Grants are recorded in the company’s audit log.</CardDescription>
          </CardHeader>
          <CardContent><SupportGrantForm tenantId={company.id} /></CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Owners and account recovery</CardTitle>
            <CardDescription>Reset two-factor only after verifying identity through a separate channel.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {owners.map((o) => (
              <div key={o.userId} className="grid gap-2 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{o.name}</span>
                  <Badge>{o.status}</Badge>
                </div>
                {o.userId !== actor.userId ? <MfaResetForm userId={o.userId} name={o.name} /> : null}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
