import Link from 'next/link';
import { can, PLAN_MODULE_LABELS, type PlanModule, type TenantContext } from '@w360/domain';
import { Alert } from '@w360/ui';

/**
 * How much of one plan limit is used, beside the form that adds to it (ADR-051). Nothing when the
 * plan has no limit. The services enforce the limit; this only explains it.
 */
export function PlanLimitHint({
  ctx,
  one,
  what,
  used,
  limit,
  detail,
}: {
  ctx: TenantContext;
  /** The noun for one, like "seat" or "live automation". */
  one: string;
  /** The plural, like "seats" or "live automations". */
  what: string;
  used: number;
  limit: number | null;
  detail?: string;
}) {
  if (limit === null) return null;
  const link = can(ctx, 'billing.read') ? (
    <Link
      href={`/c/${ctx.tenant.slug}/billing`}
      className="text-primary underline-offset-4 hover:underline"
    >
      See the plan
    </Link>
  ) : null;
  if (used >= limit) {
    const title =
      limit === 1
        ? `Your plan's one ${one} is in use`
        : `All ${limit} ${what} of your plan are in use`;
    return (
      <Alert tone="warning" title={limit === 0 ? `Your plan includes no ${what}` : title}>
        {detail ? `${detail} ` : ''}Free one, or ask HyFib for more. {link}
      </Alert>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {used} of {limit} {limit === 1 ? one : what} of your plan in use
      {detail ? ` (${detail})` : ''}. {link}
    </p>
  );
}

const MODULE_EFFECTS: Record<PlanModule, string> = {
  automations:
    'You can still see your automations and their runs, but not change or publish them, and they no longer start from customer messages, store events or the API.',
  flows: 'You can still see your flows and their answers, but not change, publish or send them.',
  crm: 'You can still see your deals and tasks, but not change them.',
  commerce:
    'You can still see your orders, products and stores, but not send products, request payments or change order messages, which are no longer sent.',
};

/** Explains a module the plan leaves out (its write permissions are gone; reading stays). */
export function ModuleNotInPlan({ ctx, module }: { ctx: TenantContext; module: PlanModule }) {
  if (ctx.plan.modules.has(module)) return null;
  return (
    <Alert
      tone="warning"
      title={`Your plan does not include ${PLAN_MODULE_LABELS[module]}`}
      className="mb-4"
    >
      {MODULE_EFFECTS[module]} Ask HyFib to change the plan.
    </Alert>
  );
}
