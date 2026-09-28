import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@w360/ui';
import { EMPTY_PLAN_FORM, PlanForm } from '@/components/platform/plan-forms';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'New plan · Platform' };
export const dynamic = 'force-dynamic';

export default async function NewPlanPage() {
  const actor = await requirePlatformActor();
  return (
    <div className="grid gap-6">
      <Link
        href="/platform/plans"
        className="text-sm text-primary underline-offset-4 hover:underline"
      >
        ← All plans
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">New plan</h1>
      {actor.role !== 'platform_owner' ? (
        <Alert tone="warning" title="Platform owners only">
          Only platform owners create and change plans. You can put companies on published plans.
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Version 1</CardTitle>
            <CardDescription>
              Saved as a draft. Review it, then publish it to make it assignable.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PlanForm initial={EMPTY_PLAN_FORM} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
