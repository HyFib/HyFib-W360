import Link from 'next/link';
import type { ActivityItem } from '@w360/domain';
import { formatMinor } from '@w360/domain/crm-money';
import { ACTIVITY_TEXT, DEAL_FIELD_TEXT } from '@/lib/crm-labels';
import { formatDateTime } from '@/lib/format';

/** A contact's or deal's timeline, newest first. */
export function Timeline({
  items,
  slug,
  timeZone,
  stageNames,
  memberNames,
  currency,
  showDeal,
}: {
  items: ActivityItem[];
  slug: string;
  timeZone: string;
  /** Every stage id of the company (archived ones too) to its name. */
  stageNames: Record<string, string>;
  memberNames: Record<string, string>;
  /** The deal's currency, to show value changes on a deal's timeline. */
  currency?: string;
  /** Name the deal on each entry (contact timelines). */
  showDeal: boolean;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">Nothing yet.</p>;
  const stage = (id: unknown) =>
    typeof id === 'string' ? (stageNames[id] ?? 'a removed stage') : 'a stage';
  const member = (id: unknown) =>
    typeof id === 'string' ? (memberNames[id] ?? 'a former member') : 'nobody';
  const detail = (a: ActivityItem): string | null => {
    switch (a.kind) {
      case 'stage_changed':
        return `${stage(a.data.fromStageId)} → ${stage(a.data.toStageId)}${a.data.toPipelineId ? ' (another pipeline)' : ''}`;
      case 'owner_changed':
        return `${member(a.data.from)} → ${member(a.data.to)}`;
      case 'deal_updated': {
        const fields = Array.isArray(a.data.fields)
          ? a.data.fields.map((f) => DEAL_FIELD_TEXT[String(f)] ?? String(f)).join(', ')
          : '';
        const money = (v: unknown) =>
          typeof v === 'number' && currency ? formatMinor(v, currency) : 'no value';
        return currency && 'valueTo' in a.data
          ? `${fields} (value ${money(a.data.valueFrom)} → ${money(a.data.valueTo)})`
          : fields;
      }
      case 'task_created':
      case 'task_completed':
      case 'task_reopened':
      case 'task_cancelled':
        return a.taskTitle;
      default:
        return null;
    }
  };
  return (
    <ol className="grid gap-3" aria-label="Timeline">
      {items.map((a) => (
        <li key={a.id} className="grid gap-1 border-l-2 border-border pl-3 text-sm">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{ACTIVITY_TEXT[a.kind] ?? a.kind}</span>
            {detail(a) ? <span className="min-w-0 break-words">{detail(a)}</span> : null}
          </span>
          {a.body ? <p className="whitespace-pre-wrap break-words">{a.body}</p> : null}
          <span className="text-xs text-muted-foreground">
            {formatDateTime(a.createdAt, timeZone)}
            {a.actor
              ? ` · ${a.actor.name}`
              : typeof a.data.automationId === 'string'
                ? ' · by an automation'
                : ''}
            {showDeal && a.dealId && a.dealTitle ? (
              <>
                {' · '}
                <Link
                  href={`/c/${slug}/crm/deals/${a.dealId}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {a.dealTitle}
                </Link>
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
