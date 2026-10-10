import { TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import type { FailureReasons } from '@w360/domain';
import { chartCount, chartShare, shareBarPath } from '@w360/domain/ops-chart';
import { failureReasonLabel } from '@/lib/campaign-labels';

/** The bar's full length, a share of 100%. */
const BAR = 96;

/**
 * A share as a bar 8 pixels thick in the failed sends' colour, repeating the number beside it: a
 * square start, a rounded end, the leftover air (`shareBarPath`).
 */
function ShareBar({ share }: { share: number }) {
  return (
    <svg width={BAR} height="8" viewBox={`0 0 ${BAR} 8`} aria-hidden="true" className="shrink-0">
      <path d={shareBarPath(share, BAR)} fill="var(--chart-3)" />
    </svg>
  );
}

/**
 * A window's failed sends by the code they failed with (ADR-347): the most frequent first, then the
 * rest together; each with its sends and its share of those failed, written and drawn as a bar in
 * the failed sends' colour, so the reasons compare at a glance while every number stays in the
 * table. When no send failed, a note says so.
 */
export function FailureReasonsTable({
  reasons,
  label,
  empty,
}: {
  reasons: FailureReasons;
  /** The table's accessible name: whose sends and over how many days. */
  label: string;
  /** What the note says when no send failed. */
  empty: string;
}) {
  if (reasons.failed === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    // The table scrolls in its own box rather than widening the card on a phone. Inline-size
    // containment keeps the table's width out of the sizes around it: WebKit otherwise let it widen
    // a company's platform page 360 pixels wide to 409.
    <div className="min-w-0 [contain:inline-size]">
      <Table aria-label={label}>
        <THead>
          <TR>
            <TH>Reason</TH>
            <TH>Code</TH>
            <TH>Failed</TH>
            <TH>Share of the failed</TH>
          </TR>
        </THead>
        <TBody>
          {reasons.reasons.map((r) => (
            <TR key={r.code ?? 'the rest'}>
              <TD className="min-w-48">{failureReasonLabel(r.code, r.codes)}</TD>
              <TD className="whitespace-nowrap font-mono text-xs">
                {r.code === null ? '—' : r.code === '' ? 'None' : r.code}
              </TD>
              <TD className="tabular-nums">{chartCount(r.failed)}</TD>
              <TD>
                <div className="flex items-center gap-2">
                  <ShareBar share={r.share} />
                  <span className="tabular-nums">{chartShare(r.share)}</span>
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
