import { TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import type { FailureReasonMonth, FailureReasons } from '@w360/domain';
import {
  chartCount,
  chartMonthLabel,
  chartShare,
  monthBarHeights,
  shareBarPath,
} from '@w360/domain/ops-chart';
import { failureReasonLabel } from '@/lib/campaign-labels';

/** The bar's full length, a share of 100%. */
const BAR = 96;
/** A month's bar: 6 pixels wide, 2 apart, at most 24 high (ADR-360). */
const MONTH_BAR = 6;
const MONTH_GAP = 2;
const MONTH_HEIGHT = 24;

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

/** A month as its bar and the screen reader name it, with the days of it a partial one holds. */
const monthText = (month: FailureReasonMonth) =>
  month.partial
    ? `${chartMonthLabel(month.month)} (${month.days} ${month.days === 1 ? 'day' : 'days'})`
    : chartMonthLabel(month.month);

/**
 * A reason's failed sends month by month (ADR-360): a bar a month in the failed sends' colour, the
 * oldest month first, the row to its own height (its most in one month fills it), so a reason that
 * began, grew or faded shows at a glance; a partial first or last month is drawn lighter. Each month
 * says its count when pointed at, and the whole reads as one sentence to a screen reader; the counts
 * are the year's, in the same table.
 */
function MonthBars({
  reason,
  months,
  counts,
}: {
  reason: string;
  months: readonly FailureReasonMonth[];
  counts: readonly number[];
}) {
  const heights = monthBarHeights(counts, MONTH_HEIGHT);
  const width = Math.max(0, months.length * (MONTH_BAR + MONTH_GAP) - MONTH_GAP);
  const spoken = months
    .map((month, index) => `${monthText(month)}: ${chartCount(counts[index] ?? 0)}`)
    .join(', ');
  return (
    <svg
      width={width}
      height={MONTH_HEIGHT + 1}
      viewBox={`0 0 ${width} ${MONTH_HEIGHT + 1}`}
      role="img"
      aria-label={`${reason}, month by month: ${spoken}`}
      className="shrink-0"
    >
      <line
        x1="0"
        y1={MONTH_HEIGHT + 0.5}
        x2={width}
        y2={MONTH_HEIGHT + 0.5}
        stroke="var(--border)"
      />
      {months.map((month, index) => {
        const x = index * (MONTH_BAR + MONTH_GAP);
        const height = heights[index] ?? 0;
        return (
          <g key={month.month}>
            <title>{`${monthText(month)}: ${chartCount(counts[index] ?? 0)} failed`}</title>
            {/* The month's whole height answers the pointer, a bar or not. */}
            <rect x={x} y="0" width={MONTH_BAR} height={MONTH_HEIGHT} fill="transparent" />
            {height > 0 ? (
              <rect
                x={x}
                y={MONTH_HEIGHT - height}
                width={MONTH_BAR}
                height={height}
                rx="1"
                fill="var(--chart-3)"
                fillOpacity={month.partial ? 0.5 : 1}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Which of the year's months are partial, drawn lighter: none, the first, the last or both. */
function partialNote(first: boolean, last: boolean): string {
  const which =
    first && last ? 'first and last months are' : first ? 'first month is' : 'last month is';
  return first || last
    ? ` The year starts 365 days ago and ends yesterday, so its ${which} partial, drawn lighter.`
    : '';
}

/**
 * A window's failed sends by the code they failed with (ADR-347): the most frequent first, then the
 * rest together; each with its sends and its share of those failed, written and drawn as a bar in
 * the failed sends' colour, so the reasons compare at a glance while every number stays in the
 * table. With the year's months (ADR-360), each reason's months are drawn beside it. When no send
 * failed, a note says so.
 */
export function FailureReasonsTable({
  reasons,
  label,
  empty,
  months,
}: {
  reasons: FailureReasons;
  /** The table's accessible name: whose sends and over how many days. */
  label: string;
  /** What the note says when no send failed. */
  empty: string;
  /** The year's months and each reason's failed sends in them, in the order of the reasons. */
  months?: { months: readonly FailureReasonMonth[]; byMonth: readonly (readonly number[])[] };
}) {
  if (reasons.failed === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const first = months?.months[0];
  const last = months?.months.at(-1);
  return (
    // min-w-0 and the table's own box: it scrolls there rather than widening the card on a phone.
    <div className="grid min-w-0 gap-2">
      <Table aria-label={label}>
        <THead>
          <TR>
            <TH>Reason</TH>
            <TH>Code</TH>
            <TH>Failed</TH>
            <TH>Share of the failed</TH>
            {months ? <TH>Month by month</TH> : null}
          </TR>
        </THead>
        <TBody>
          {reasons.reasons.map((r, index) => (
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
              {months ? (
                <TD>
                  <MonthBars
                    reason={failureReasonLabel(r.code, r.codes)}
                    months={months.months}
                    counts={months.byMonth[index] ?? []}
                  />
                </TD>
              ) : null}
            </TR>
          ))}
        </TBody>
      </Table>
      {months && first && last ? (
        <p className="text-xs text-muted-foreground">
          Month by month, from {chartMonthLabel(first.month)} to {chartMonthLabel(last.month)}, each
          reason to its own height: point at a month for its count.
          {partialNote(first.partial, last.partial)}
        </p>
      ) : null}
    </div>
  );
}
