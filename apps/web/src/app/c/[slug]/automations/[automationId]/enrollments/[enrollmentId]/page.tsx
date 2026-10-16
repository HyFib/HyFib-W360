import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { ENROLLMENT_END_REASON_LABELS, can } from '@w360/domain';
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
import { StopEnrollmentButton } from '@/components/automations/enrollment-actions';
import { AutoRefresh } from '@/components/campaigns/campaign-actions';
import { PageHeader } from '@/components/page-header';
import { ENROLLMENT_STATUS } from '@/lib/automation-labels';
import { formatDateTime } from '@/lib/format';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Enrolment' };
export const dynamic = 'force-dynamic';

/**
 * One enrolment of contacts in an automation (ADR-401): its progress, how many started and were
 * refused (by reason) or not started, who started or stopped it, and Stop while it runs. The page
 * re-checks the member's permission itself and re-renders every 15 seconds while it runs.
 */
export default async function EnrollmentPage({
  params,
}: {
  params: Promise<{ slug: string; automationId: string; enrollmentId: string }>;
}) {
  const { slug, automationId, enrollmentId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'automations.read')) notFound();
  const { automationEnrollments } = await getRuntime();
  let enrollment: Awaited<ReturnType<typeof automationEnrollments.getEnrollment>>;
  try {
    enrollment = await automationEnrollments.getEnrollment(ctx, enrollmentId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  if (enrollment.automationId !== automationId) notFound();
  const tz = ctx.tenant.timezone;
  const status = ENROLLMENT_STATUS[enrollment.status] ?? {
    label: enrollment.status,
    tone: 'neutral' as const,
  };
  const running = enrollment.status === 'running';
  const base = `/c/${ctx.tenant.slug}/automations/${automationId}`;
  const n = (v: number) => v.toLocaleString('en-IN');
  return (
    <>
      <AutoRefresh active={running} />
      <PageHeader
        title={`Enrolment in ${enrollment.automationName}`}
        description={`${
          enrollment.source === 'segment'
            ? `Members of the segment “${enrollment.segmentName ?? 'a segment'}”`
            : 'Contacts chosen on the Contacts page'
        }, started ${formatDateTime(enrollment.createdAt.toISOString(), tz)} by ${
          enrollment.createdByName ?? 'a member'
        }.`}
        actions={
          <Link href={base} className="text-sm text-primary underline-offset-4 hover:underline">
            Open the automation
          </Link>
        }
      />
      <div className="grid max-w-3xl gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Progress <Badge tone={status.tone}>{status.label}</Badge>
            </CardTitle>
            <CardDescription>
              {running
                ? 'Runs start in the background, at most 50 at a time. This page updates itself.'
                : enrollment.endReason
                  ? `${ENROLLMENT_END_REASON_LABELS[enrollment.endReason]}${
                      enrollment.stoppedByName ? ` (${enrollment.stoppedByName})` : ''
                    } Ended ${formatDateTime(enrollment.endedAt?.toISOString() ?? null, tz)}.`
                  : `Every contact was handled. Ended ${formatDateTime(
                      enrollment.endedAt?.toISOString() ?? null,
                      tz,
                    )}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              {[
                ['Contacts', enrollment.total],
                ['Started', enrollment.started],
                ['Refused', enrollment.refused],
                ['Not started', enrollment.cancelled],
                ['Waiting', enrollment.pending],
              ].map(([label, value]) => (
                <div key={label} className="grid">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{n(Number(value))}</dd>
                </div>
              ))}
            </dl>
            {running && can(ctx, 'automations.publish') ? (
              <StopEnrollmentButton slug={ctx.tenant.slug} enrollmentId={enrollment.id} />
            ) : null}
            <p className="text-xs text-muted-foreground">
              Stopping leaves runs already started going; stop one from its page. Runs started by
              this enrolment are listed with the automation’s runs.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Refused</CardTitle>
            <CardDescription>
              Contacts the automation was not started for, by reason. The others went on.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {enrollment.refusals.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">None.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Reason</TH>
                    <TH className="text-right">Contacts</TH>
                  </TR>
                </THead>
                <TBody>
                  {enrollment.refusals.map((r) => (
                    <TR key={r.reason}>
                      <TD>{r.label}</TD>
                      <TD className="text-right tabular-nums">{n(r.count)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Link
          href={`/c/${ctx.tenant.slug}/automations/runs?automation=${automationId}`}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Runs of this automation
        </Link>
      </div>
    </>
  );
}
