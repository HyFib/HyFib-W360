import 'server-only';
import { can, type TenantContext } from '@w360/domain';
import type { BuilderField } from '@/components/segments/segment-builder';
import { getRuntime } from './runtime';

/** Inputs for the segment builder: custom fields and campaigns that can be retargeted. */
export async function segmentBuilderInputs(ctx: TenantContext): Promise<{
  fields: BuilderField[];
  campaigns: { id: string; name: string }[];
}> {
  const { contacts, campaigns } = await getRuntime();
  const [fields, list] = await Promise.all([
    can(ctx, 'contacts.read') ? contacts.listFields(ctx) : Promise.resolve([]),
    can(ctx, 'campaigns.read') ? campaigns.listCampaigns(ctx) : Promise.resolve({ items: [] }),
  ]);
  return {
    fields: fields.map((f) => ({ key: f.key, label: f.label, type: f.type })),
    campaigns: list.items
      .filter((c) => c.status !== 'draft' && c.status !== 'pending_approval')
      .map((c) => ({ id: c.id, name: c.name })),
  };
}
