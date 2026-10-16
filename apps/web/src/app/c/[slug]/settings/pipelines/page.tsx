import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can, CRM_LIMITS } from '@w360/domain';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { DealFieldsManager } from '@/components/crm/deal-fields-manager';
import { PipelineArchiveButton, PipelineForm } from '@/components/crm/pipeline-editor';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Pipelines' };
export const dynamic = 'force-dynamic';

/** New pipelines default to rupees; the wallet and Meta charges are in INR too. */
const DEFAULT_CURRENCY = 'INR';

export default async function PipelinesSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'crm.read')) notFound();
  const manage = can(ctx, 'tenant.settings.manage');
  const { crm } = await getRuntime();
  const pipelines = await crm.listPipelines(ctx, { includeArchived: true });
  const dealFields = await crm.listDealFields(ctx);
  const active = pipelines.filter((p) => !p.archived);
  const archived = pipelines.filter((p) => p.archived);
  const currencies = Intl.supportedValuesOf('currency');
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Pipelines</CardTitle>
          <CardDescription>
            The stages deals move through on the{' '}
            <Link
              href={`/c/${ctx.tenant.slug}/crm`}
              className="text-primary underline-offset-4 hover:underline"
            >
              CRM board
            </Link>
            . Each pipeline has one currency for its deal values. Changes are recorded in the audit
            log.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pipelines yet.</p>
          ) : (
            <ul className="grid gap-3">
              {active.map((p) => {
                const stages = p.stages.filter((s) => !s.archived);
                return (
                  <li key={p.id} className="grid gap-2 rounded-md border border-border p-3">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{p.name}</span>
                      <span className="text-muted-foreground">{p.currency}</span>
                      {p.addedThroughApi ? (
                        <span className="text-muted-foreground">Added through the API</span>
                      ) : null}
                    </p>
                    <ol className="flex flex-wrap gap-x-2 gap-y-1 text-sm text-muted-foreground">
                      {stages.map((s, i) => (
                        <li key={s.id}>
                          {i + 1}. {s.name}
                          {s.winPercent !== null ? ` · ${s.winPercent}%` : ''}
                          {s.openDeals > 0
                            ? ` (${s.openDeals} open deal${s.openDeals === 1 ? '' : 's'})`
                            : ''}
                        </li>
                      ))}
                    </ol>
                    {manage ? (
                      <details>
                        <summary className="cursor-pointer text-sm font-medium">
                          Edit {p.name}
                        </summary>
                        <div className="mt-3 grid gap-4">
                          <PipelineForm
                            key={p.id}
                            slug={ctx.tenant.slug}
                            pipeline={{
                              id: p.id,
                              name: p.name,
                              currency: p.currency,
                              version: p.version,
                              stages: stages.map((s) => ({
                                id: s.id,
                                name: s.name,
                                winPercent: s.winPercent,
                              })),
                            }}
                            currencies={currencies}
                            defaultCurrency={p.currency}
                          />
                          <PipelineArchiveButton
                            slug={ctx.tenant.slug}
                            pipelineId={p.id}
                            version={p.version}
                            archived={false}
                          />
                        </div>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {manage ? (
        active.length < CRM_LIMITS.pipelines ? (
          <Card>
            <CardHeader>
              <CardTitle>New pipeline</CardTitle>
              <CardDescription>
                Name the stages in the order deals move through them. Won and lost are outcomes, not
                stages.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PipelineForm
                slug={ctx.tenant.slug}
                currencies={currencies}
                defaultCurrency={DEFAULT_CURRENCY}
              />
            </CardContent>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">
            A company can use up to {CRM_LIMITS.pipelines} pipelines at once. Archive one to add
            another.
          </p>
        )
      ) : (
        <p className="text-sm text-muted-foreground">Owners and administrators manage pipelines.</p>
      )}

      {archived.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Archived pipelines</CardTitle>
            <CardDescription>
              Hidden from the board. Their closed deals still count in reports.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3">
              {archived.map((p) => (
                <li key={p.id} className="grid gap-2 rounded-md border border-border p-3">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground">{p.currency}</span>
                    {p.addedThroughApi ? (
                      <span className="text-muted-foreground">Added through the API</span>
                    ) : null}
                    <Badge tone="neutral">Archived</Badge>
                  </p>
                  {manage ? (
                    <PipelineArchiveButton
                      slug={ctx.tenant.slug}
                      pipelineId={p.id}
                      version={p.version}
                      archived
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Deal fields</CardTitle>
          <CardDescription>
            Fields of your own on every deal, filled in on the deal’s page: text, a number, a date,
            yes/no or a choice among options you list. A field’s key names its column in deal
            exports and its value in the API; the key and the type never change. A choice’s options
            can be added and reordered later, and removed or renamed while no deal has them chosen.
            Changes are recorded in the audit log.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DealFieldsManager
            slug={ctx.tenant.slug}
            fields={dealFields.map((field) => ({
              id: field.id,
              key: field.key,
              label: field.label,
              type: field.type,
              options: field.options,
            }))}
            canEdit={manage}
          />
        </CardContent>
      </Card>
    </div>
  );
}
