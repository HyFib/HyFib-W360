import 'server-only';
import type { PipelineSummary, TenantContext } from '@w360/domain';
import type { DealFieldOption, MemberOption, PipelineOption } from '@/components/crm/deal-forms';
import { getRuntime } from '@/server/runtime';

/** Pipelines in use with their stages in use, for deal forms. */
export function pipelineOptions(pipelines: PipelineSummary[]): PipelineOption[] {
  return pipelines
    .filter((p) => !p.archived)
    .map((p) => ({
      id: p.id,
      name: p.name,
      currency: p.currency,
      stages: p.stages.filter((s) => !s.archived).map((s) => ({ id: s.id, name: s.name })),
    }));
}

/**
 * The member choices of a form, keeping the current owner or assignee when they no longer have CRM
 * access (so the form shows who it is instead of silently showing someone else).
 */
export function memberOptionsWith(
  options: MemberOption[],
  current: { membershipId: string; name: string } | null,
): MemberOption[] {
  return current && !options.some((m) => m.membershipId === current.membershipId)
    ? [...options, { membershipId: current.membershipId, name: `${current.name} (no CRM access)` }]
    : options;
}

/**
 * Names for timeline entries: every stage (archived too) and every member with CRM access; and the
 * company's custom deal fields (ADR-373) for deal forms.
 */
export async function crmLookups(ctx: TenantContext) {
  const { crm } = await getRuntime();
  const [pipelines, members, fields] = await Promise.all([
    crm.listPipelines(ctx, { includeArchived: true }),
    crm.members(ctx),
    crm.listDealFields(ctx),
  ]);
  const stageNames: Record<string, string> = {};
  for (const p of pipelines) for (const s of p.stages) stageNames[s.id] = s.name;
  const memberNames: Record<string, string> = {};
  for (const m of members) memberNames[m.membershipId] = m.name;
  const memberOptions: MemberOption[] = members.map((m) => ({
    membershipId: m.membershipId,
    name: m.name,
  }));
  const dealFields: DealFieldOption[] = fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    options: f.options,
  }));
  return {
    pipelines,
    options: pipelineOptions(pipelines),
    stageNames,
    memberNames,
    memberOptions,
    dealFields,
  };
}
