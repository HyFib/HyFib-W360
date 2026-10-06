import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, Button, Card, CardContent, CardTitle } from '@w360/ui';
import {
  OPS_LIST_ROWS,
  type HealthIssue,
  type HealthLevel,
  type OpsExportList,
} from '@w360/domain';

/** One number on the operations overview, optionally linking to the page that explains it. */
export function StatTile({
  label,
  value,
  detail,
  href,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  href?: string;
  tone?: 'danger' | 'warning';
}) {
  const valueClass =
    tone === 'danger' ? 'text-destructive' : tone === 'warning' ? 'text-warning' : undefined;
  const body = (
    <CardContent className="grid gap-1 pt-6">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${valueClass ?? ''}`}>{value}</p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </CardContent>
  );
  return (
    <Card>
      {href ? (
        <Link
          href={href}
          className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </Link>
      ) : (
        body
      )}
    </Card>
  );
}

/** How many rows a list's CSV gives at most, for the lists it gives beyond the tab's (ADR-200). */
const EXPORT_ROWS: Partial<Record<OpsExportList, number>> = {
  signups: OPS_LIST_ROWS.signups.exported,
  'number-setups': OPS_LIST_ROWS.numberSetups.exported,
  'new-companies': OPS_LIST_ROWS.newCompanies.exported,
  failures: OPS_LIST_ROWS.failures.exported,
  receipts: OPS_LIST_ROWS.receipts.exported,
  quarantine: OPS_LIST_ROWS.quarantine.exported,
  'dead-letters': OPS_LIST_ROWS.deadLetters.exported,
};

/**
 * A list's title with "Download CSV" for it (ADR-158), and how many rows it gives
 * when that is more than the tab shows (ADR-200). The link's name gives the list, so a tab
 * with several lists tells their links apart.
 */
export function ListTitle({ title, list }: { title: string; list: OpsExportList }) {
  const rows = EXPORT_ROWS[list];
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <CardTitle>{title}</CardTitle>
      <div className="flex flex-wrap items-center gap-2">
        {rows ? (
          <span className="text-xs text-muted-foreground">
            The CSV gives up to {rows.toLocaleString('en')} rows
          </span>
        ) : null}
        <Button asChild variant="outline" size="sm">
          <a href={`/platform/ops/export/${list}`} download aria-label={`Download CSV: ${title}`}>
            Download CSV
          </a>
        </Button>
      </div>
    </div>
  );
}

export function LevelBadge({ level }: { level: HealthLevel }) {
  if (level === 'critical') return <Badge tone="danger">Critical</Badge>;
  if (level === 'warning') return <Badge tone="warning">Needs attention</Badge>;
  return <Badge tone="success">Healthy</Badge>;
}

export function IssueList({ issues }: { issues: HealthIssue[] }) {
  return (
    <ul className="grid gap-1 text-sm">
      {issues.map((issue) => (
        <li key={issue.key} className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${
              issue.severity === 'critical' ? 'bg-destructive' : 'bg-warning'
            }`}
          />
          <span>
            <span className="sr-only">
              {issue.severity === 'critical' ? 'Critical: ' : 'Warning: '}
            </span>
            {issue.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CompanyLink({ id, name, slug }: { id: string; name: string; slug: string }) {
  return (
    <>
      <Link
        href={`/platform/tenants/${id}`}
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        {name}
      </Link>
      <div className="text-xs text-muted-foreground">/{slug}</div>
    </>
  );
}

/** Platform pages show times in UTC. */
export function Utc({ at }: { at: Date | null }) {
  if (!at) return <span className="text-muted-foreground">—</span>;
  return (
    <time dateTime={at.toISOString()} className="whitespace-nowrap">
      {at.toISOString().slice(0, 16).replace('T', ' ')} UTC
    </time>
  );
}

export function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : '—';
}
