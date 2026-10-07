import 'server-only';
import { can, type TenantContext } from '@w360/domain';
import type { BuilderField, BuilderStore } from '@/components/segments/segment-builder';
import { getRuntime } from './runtime';

/**
 * Inputs for the segment builder: custom fields, campaigns that can be retargeted, and the stores
 * and order currencies for conditions on store orders, for members who can read them (ADR-231).
 */
export async function segmentBuilderInputs(ctx: TenantContext): Promise<{
  fields: BuilderField[];
  campaigns: { id: string; name: string }[];
  stores: BuilderStore[];
  orderCurrencies: string[];
}> {
  const { contacts, campaigns, stores } = await getRuntime();
  const orders = can(ctx, 'commerce.read');
  const [fields, list, storeList, currencies] = await Promise.all([
    can(ctx, 'contacts.read') ? contacts.listFields(ctx) : Promise.resolve([]),
    can(ctx, 'campaigns.read') ? campaigns.listCampaigns(ctx) : Promise.resolve({ items: [] }),
    orders ? stores.stores(ctx) : Promise.resolve([]),
    orders ? stores.orderCurrencies(ctx) : Promise.resolve([]),
  ]);
  return {
    fields: fields.map((f) => ({ key: f.key, label: f.label, type: f.type })),
    campaigns: list.items
      .filter((c) => c.status !== 'draft' && c.status !== 'pending_approval')
      .map((c) => ({ id: c.id, name: c.name })),
    stores: storeList.map((s) => ({
      id: s.id,
      name: s.name ?? s.shopDomain ?? s.storeUrl ?? 'Store',
    })),
    orderCurrencies: currencies,
  };
}
