import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isAppError } from '@w360/core';
import { can } from '@w360/domain';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { PageHeader } from '@/components/page-header';
import { SegmentForm } from '@/components/segments/segment-form';
import type { Definition } from '@/components/segments/segment-builder';
import { segmentBuilderInputs } from '@/server/campaigns';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Segment' };
export const dynamic = 'force-dynamic';

export default async function SegmentPage({
  params,
}: {
  params: Promise<{ slug: string; segmentId: string }>;
}) {
  const { slug, segmentId } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'campaigns.read')) notFound();
  const { segments } = await getRuntime();
  let segment: Awaited<ReturnType<typeof segments.getSegment>>;
  try {
    segment = await segments.getSegment(ctx, segmentId);
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const inputs = can(ctx, 'campaigns.write') ? await segmentBuilderInputs(ctx) : null;
  return (
    <>
      <PageHeader title={segment.name} description="A saved audience, evaluated when it is used." />
      <div className="grid gap-6">
        {segment.problem ? <Alert tone="warning">{segment.problem}</Alert> : null}
        {segment.preview ? (
          <Card>
            <CardHeader>
              <CardTitle>
                {segment.preview.count === 1
                  ? '1 contact matches now'
                  : `${segment.preview.count} contacts match now`}
              </CardTitle>
              {segment.preview.sample.length > 0 ? (
                <CardDescription>
                  {segment.preview.sample
                    .map((p) => p.displayName ?? p.phoneE164 ?? 'Unnamed')
                    .join(', ')}
                  {segment.preview.count > segment.preview.sample.length ? ', …' : ''}
                </CardDescription>
              ) : null}
            </CardHeader>
          </Card>
        ) : null}
        {inputs ? (
          <Card>
            <CardHeader>
              <CardTitle>Conditions</CardTitle>
            </CardHeader>
            <CardContent>
              <SegmentForm
                slug={ctx.tenant.slug}
                fields={inputs.fields}
                campaigns={inputs.campaigns}
                existing={{
                  id: segment.id,
                  name: segment.name,
                  version: segment.version,
                  definition: segment.definition as unknown as Definition,
                }}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
