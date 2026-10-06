import 'server-only';
import {
  can,
  linkButtons,
  renderPlaceholders,
  sendSpecFor,
  type TenantContext,
} from '@w360/domain';
import type { SendableTemplate } from '@/components/templates/template-sender';
import { getRuntime } from './runtime';

/**
 * Approved templates this member may send (marketing templates need `campaigns.send`), with the
 * parameter counts the sender form needs. Templates whose website buttons' links end with a value
 * are listed only for a sender that asks for the values (`linkValues`, ADR-228): a contact's or a
 * conversation's, not yet campaigns'.
 */
export async function sendableTemplates(
  ctx: TenantContext,
  options: { linkValues?: boolean } = {},
): Promise<SendableTemplate[]> {
  if (!can(ctx, 'templates.read')) return [];
  if (!can(ctx, 'inbox.reply') && !can(ctx, 'campaigns.send')) return [];
  const { templates } = await getRuntime();
  const list = await templates.listTemplates(ctx);
  const out: SendableTemplate[] = [];
  for (const t of list) {
    if (t.status !== 'approved') continue;
    if (t.category === 'MARKETING' && !can(ctx, 'campaigns.send')) continue;
    const spec = sendSpecFor(t.category, t.components, { linkValues: options.linkValues });
    if (!spec.supported) continue;
    out.push({
      id: t.id,
      name: t.name,
      language: t.language,
      category: t.category,
      whatsappAccountId: t.whatsappAccountId,
      headerParams: spec.headerParams,
      bodyParams: spec.bodyParams,
      links: linkButtons(spec.definition),
      preview: renderPlaceholders(spec.definition),
    });
  }
  return out;
}
