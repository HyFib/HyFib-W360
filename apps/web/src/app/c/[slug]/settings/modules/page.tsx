import type { Metadata } from 'next';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { MODULES } from '@/lib/modules';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Modules' };
export const dynamic = 'force-dynamic';

const label = {
  available: 'Available',
  planned: 'Not yet available',
  externally_blocked: 'Waiting on provider approval',
} as const;
const tone = { available: 'success', planned: 'neutral', externally_blocked: 'warning' } as const;

export default async function ModulesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Module availability</CardTitle>
        <CardDescription>
          Only modules that are fully available and permitted for your role appear in navigation.
          This list explains the rest. A module your plan does not include stays visible, read only,
          so nothing you made in it is hidden.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <THead>
            <TR>
              <TH>Module</TH>
              <TH>Status</TH>
              <TH>Your plan</TH>
              <TH>Your access</TH>
              <TH>Details</TH>
            </TR>
          </THead>
          <TBody>
            {MODULES.map((m) => (
              <TR key={m.key}>
                <TD className="font-medium">{m.label}</TD>
                <TD>
                  <Badge tone={tone[m.status]}>{label[m.status]}</Badge>
                </TD>
                <TD>
                  {!m.planModule ? (
                    'Included'
                  ) : ctx.plan.modules.has(m.planModule) ? (
                    <Badge tone="success">Included</Badge>
                  ) : (
                    <Badge tone="warning">Not included (read only)</Badge>
                  )}
                </TD>
                <TD>{ctx.rolePermissions.has(m.permission) ? 'Permitted' : 'Not in your roles'}</TD>
                <TD className="text-sm text-muted-foreground">{m.reason ?? '—'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}
