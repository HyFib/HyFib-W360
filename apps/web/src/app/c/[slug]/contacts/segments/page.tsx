import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import {
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
import { PageHeader } from '@/components/page-header';
import { SegmentForm } from '@/components/segments/segment-form';
import { formatDateTime } from '@/lib/format';
import { segmentBuilderInputs } from '@/server/campaigns';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Segments' };
export const dynamic = 'force-dynamic';

export default async function SegmentsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'campaigns.read')) notFound();
  const { segments } = await getRuntime();
  const list = await segments.listSegments(ctx);
  const base = `/c/${ctx.tenant.slug}/contacts/segments`;
  const inputs = can(ctx, 'campaigns.write') ? await segmentBuilderInputs(ctx) : null;

  return (
    <>
      <PageHeader
        title="Segments"
        description="Saved audiences. A segment is evaluated whenever it is used; a campaign freezes its audience when submitted."
      />
      <div className="grid gap-6">
        <Card>
          <CardContent className="p-0">
            {list.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="No segments yet"
                  description="Combine tags, consent, custom fields and campaign responses to define an audience."
                />
              </div>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Conditions</TH>
                    <TH>Last changed</TH>
                  </TR>
                </THead>
                <TBody>
                  {list.map((s) => (
                    <TR key={s.id}>
                      <TD className="font-medium">
                        <Link
                          href={`${base}/${s.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {s.name}
                        </Link>
                      </TD>
                      <TD className="text-sm text-muted-foreground">
                        {Array.isArray((s.definition as { conditions?: unknown }).conditions)
                          ? (s.definition as { conditions: unknown[] }).conditions.length
                          : '—'}
                      </TD>
                      <TD className="text-sm text-muted-foreground">
                        {formatDateTime(s.updatedAt.toISOString(), ctx.tenant.timezone)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
        {inputs ? (
          <Card>
            <CardHeader>
              <CardTitle>New segment</CardTitle>
              <CardDescription>
                Erased contacts never match. Preview shows who matches now.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SegmentForm
                slug={ctx.tenant.slug}
                fields={inputs.fields}
                campaigns={inputs.campaigns}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
