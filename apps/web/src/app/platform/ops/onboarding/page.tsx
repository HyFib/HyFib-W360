import type { Metadata } from 'next';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import { OPS_WINDOWS } from '@w360/domain';
import { CompanyLink, Utc } from '@/components/platform/ops';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Onboarding · Operations' };
export const dynamic = 'force-dynamic';

const STEP_LABELS: Record<string, string> = {
  subscribe_app: 'Subscribing the app',
  register_number: 'Registering the number',
  health_check: 'Checking the number',
  done: 'Done',
};

export default async function OpsOnboardingPage() {
  const actor = await requirePlatformActor();
  const { platformOps } = await getRuntime();
  const o = await platformOps.onboarding(actor);
  const days = OPS_WINDOWS.onboardingDays;
  return (
    <div className="grid grid-cols-1 gap-6">
      <p className="text-sm text-muted-foreground">
        {o.createdCompanies} {o.createdCompanies === 1 ? 'company was' : 'companies were'} created
        in the last {days} days; {o.connectedCompanies} of them{' '}
        {o.connectedCompanies === 1 ? 'has' : 'have'} an active WhatsApp number.
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Signups that failed or were abandoned</CardTitle>
          <CardDescription>
            Embedded Signup sessions in the last {days} days. An abandoned session expired before
            the popup finished.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {o.sessions.length === 0 ? (
            <EmptyState title="No failed or abandoned signups" />
          ) : (
            <Table aria-label="Signups that failed or were abandoned">
              <THead>
                <TR>
                  <TH>Company</TH>
                  <TH>Outcome</TH>
                  <TH>Reason</TH>
                  <TH>Started</TH>
                  <TH>Connected now</TH>
                </TR>
              </THead>
              <TBody>
                {o.sessions.map((s) => (
                  <TR key={s.sessionId}>
                    <TD>
                      <CompanyLink id={s.tenantId} name={s.tenantName} slug={s.tenantSlug} />
                    </TD>
                    <TD>
                      <Badge tone={s.outcome === 'failed' ? 'danger' : 'neutral'}>
                        {s.outcome === 'failed' ? 'Failed' : 'Abandoned'}
                      </Badge>
                    </TD>
                    <TD className="max-w-sm text-sm">{s.failureReason ?? '—'}</TD>
                    <TD>
                      <Utc at={s.startedAt} />
                    </TD>
                    <TD>{s.hasActiveNumber ? 'Yes' : 'No'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Number setups that failed or are stuck</CardTitle>
          <CardDescription>
            Setup failed, or has been running for over {OPS_WINDOWS.stuckSetupMinutes} minutes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {o.numbers.length === 0 ? (
            <EmptyState title="No failed or stuck number setups" />
          ) : (
            <Table aria-label="Number setups that failed or are stuck">
              <THead>
                <TR>
                  <TH>Company</TH>
                  <TH>Number</TH>
                  <TH>State</TH>
                  <TH>Step</TH>
                  <TH>Error</TH>
                  <TH>Since</TH>
                </TR>
              </THead>
              <TBody>
                {o.numbers.map((n) => (
                  <TR key={n.id}>
                    <TD>
                      <CompanyLink id={n.tenantId} name={n.tenantName} slug={n.tenantSlug} />
                    </TD>
                    <TD className="whitespace-nowrap">{n.phone ?? n.phoneNumberId}</TD>
                    <TD>
                      <Badge tone={n.stuck ? 'warning' : 'danger'}>
                        {n.stuck ? 'Stuck' : 'Failed'}
                      </Badge>
                    </TD>
                    <TD>{n.step ? (STEP_LABELS[n.step] ?? n.step) : '—'}</TD>
                    <TD className="max-w-sm text-sm">{n.error ?? '—'}</TD>
                    <TD>
                      <Utc at={n.updatedAt} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>New companies without an active number</CardTitle>
          <CardDescription>Created in the last {days} days.</CardDescription>
        </CardHeader>
        <CardContent>
          {o.stalled.length === 0 ? (
            <EmptyState title="Every new company has an active number" />
          ) : (
            <Table aria-label="New companies without an active number">
              <THead>
                <TR>
                  <TH>Company</TH>
                  <TH>Status</TH>
                  <TH>Created</TH>
                  <TH>Number being set up</TH>
                </TR>
              </THead>
              <TBody>
                {o.stalled.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <CompanyLink id={c.id} name={c.name} slug={c.slug} />
                    </TD>
                    <TD>
                      <Badge tone={c.status === 'active' ? 'success' : 'warning'}>{c.status}</Badge>
                    </TD>
                    <TD>
                      <Utc at={c.createdAt} />
                    </TD>
                    <TD>{c.inProgress ? 'Yes' : 'No'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
