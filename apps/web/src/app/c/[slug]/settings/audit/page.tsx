import type { Metadata } from 'next';
import Link from 'next/link';
import { assertCan } from '@w360/domain';
import { Badge, Card, CardContent, EmptyState, TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { slug } = await params;
  const { cursor } = await searchParams;
  const ctx = await requireTenant(slug);
  assertCan(ctx, 'audit.read');
  const { tenancy } = await getRuntime();
  const page = await tenancy.listAuditEvents(ctx, { cursor: typeof cursor === 'string' ? cursor : undefined, limit: 50 });
  const base = `/c/${ctx.tenant.slug}/settings/audit`;
  return (
    <Card>
      <CardContent className="pt-6">
        {page.events.length === 0 ? (
          <EmptyState title="No audit events" description="Sensitive actions such as invitations, role changes and settings updates are recorded here." />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>When (UTC)</TH>
                  <TH>Actor</TH>
                  <TH>Action</TH>
                  <TH>Subject</TH>
                  <TH>Result</TH>
                </TR>
              </THead>
              <TBody>
                {page.events.map((e) => (
                  <TR key={e.id}>
                    <TD className="whitespace-nowrap"><time dateTime={e.occurredAt.toISOString()}>{e.occurredAt.toISOString().replace('T', ' ').slice(0, 19)}</time></TD>
                    <TD>
                      <div>{e.actorName ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{e.actorType === 'platform_admin' ? 'HyFib platform staff' : e.actorType}</div>
                    </TD>
                    <TD><code className="text-xs">{e.action}</code></TD>
                    <TD className="text-xs text-muted-foreground">{e.subjectType ? `${e.subjectType}` : '—'}</TD>
                    <TD><Badge tone={e.result === 'success' ? 'success' : e.result === 'denied' ? 'warning' : 'danger'}>{e.result}</Badge></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="mt-4 flex justify-end gap-3 text-sm">
              {cursor ? <Link href={base} className="text-primary underline-offset-4 hover:underline">Newest</Link> : null}
              {page.nextCursor ? (
                <Link href={`${base}?cursor=${encodeURIComponent(page.nextCursor)}`} className="text-primary underline-offset-4 hover:underline">Older</Link>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
