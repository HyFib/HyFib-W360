import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '@w360/domain';
import { DealImportWizard } from '@/components/crm/deal-import-wizard';
import { ModuleNotInPlan } from '@/components/plan-limit';
import { PageHeader } from '@/components/page-header';
import { crmLookups } from '@/server/crm';
import { requireTenant } from '@/server/session';

export const metadata: Metadata = { title: 'Import deals' };
export const dynamic = 'force-dynamic';

/** Deals from a CSV file into a pipeline (ADR-374), new or changed and closed (ADR-387). */
export default async function ImportDealsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireTenant(slug);
  if (!can(ctx, 'crm.write') || !can(ctx, 'contacts.import')) notFound();
  const { options } = await crmLookups(ctx);
  return (
    <>
      <Link
        href={`/c/${ctx.tenant.slug}/crm`}
        className="mb-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
      >
        ← CRM
      </Link>
      <PageHeader
        title="Import deals"
        description="Each row adds a deal for the contact with its phone number, or changes the deal its deal id names, as a deals export writes them; a won or lost row also closes its deal. The rows are checked before anything is written; rows with errors are skipped and listed by row number."
      />
      <ModuleNotInPlan ctx={ctx} module="crm" />
      <DealImportWizard
        slug={ctx.tenant.slug}
        pipelines={options
          .filter((p) => p.stages.length > 0)
          .map((p) => ({ id: p.id, name: p.name, currency: p.currency }))}
      />
    </>
  );
}
