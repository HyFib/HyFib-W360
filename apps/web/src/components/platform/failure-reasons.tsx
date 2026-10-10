import type { ReactNode } from 'react';
import { TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import type { FailureReason, FailureReasonMonth, FailureReasons } from '@w360/domain';
import {
  chartCount,
  chartMonthLabel,
  chartShare,
  failedOfSent,
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
/** A partial month's bar with a failed send is at least 4 pixels high, so its outline shows. */
const PARTIAL_MONTH_MIN = 4;

/**
 * A share as a bar 8 pixels thick in the failed sends' colour, repeating the number beside it: a
 * square start, a rounded end, the leftover air (`shareBarPath`).
 */
export function ShareBar({ share }: { share: number }) {
  return (
    <svg width={BAR} height="8" viewBox={`0 0 ${BAR} 8`} aria-hidden="true" className="shrink-0">
      <path d={shareBarPath(share, BAR)} fill="var(--chart-3)" />
    </svg>
  );
}

/** A reason's name with its code, so two reasons HyFib does not describe are told apart. */
function reasonText(r: FailureReason): string {
  const label = failureReasonLabel(r.code, r.codes);
  return r.code === null || r.code === '' ? label : `${label} (${r.code})`;
}

/** A reason's code as the tables show it: none for the rest, None for failures without one. */
const codeText = (r: FailureReason) => (r.code === null ? '—' : r.code === '' ? 'None' : r.code);

/** A month as its bar and the screen reader name it, with the days of it a partial one holds. */
const monthText = (month: FailureReasonMonth) =>
  month.partial
    ? `${chartMonthLabel(month.month)} (${month.days} ${month.days === 1 ? 'day' : 'days'})`
    : chartMonthLabel(month.month);

/** The share of a row's sends failed in a month, as a month says it (ADR-364); none without one. */
const shareText = (share: number | null) =>
  share === null ? '' : `, ${chartShare(share)} of the sends`;

/**
 * A row's failed sends month by month (ADR-360), a reason's or a company's (ADR-362): a bar a month
 * in the failed sends' colour, the oldest month first, the row to its own height (its most in one
 * month fills it), so one that began, grew or faded shows at a glance; a partial first or last month
 * is drawn in outline, its edge in the full colour and its inside lighter. Each month says its count
 * when pointed at, with a company's the share of its sends failed (ADR-364), and the whole reads as
 * one sentence to a screen reader, named after the row; every count and share is in the folded
 * tables too (`YearMonths`).
 */
export function MonthBars({
  label,
  months,
  counts,
  sent,
}: {
  /** The row's name, as the sentence starts. */
  label: string;
  months: readonly FailureReasonMonth[];
  counts: readonly number[];
  /** A company's sends each month, those cancelled left out (ADR-364); a reason has none. */
  sent?: readonly number[];
}) {
  const heights = monthBarHeights(counts, MONTH_HEIGHT);
  const width = Math.max(0, months.length * (MONTH_BAR + MONTH_GAP) - MONTH_GAP);
  // A month's failed sends, with a company's share of its sends failed that month (ADR-364).
  const failedText = (index: number) => {
    const failed = counts[index] ?? 0;
    const share = sent === undefined ? null : failedOfSent(failed, sent[index] ?? 0);
    return `${chartCount(failed)} failed${shareText(share)}`;
  };
  // A reason's months say their counts alone, as before; a company's say what they count, a
  // semicolon between months, as each says two things.
  const spoken =
    sent === undefined
      ? months
          .map((month, index) => `${monthText(month)}: ${chartCount(counts[index] ?? 0)}`)
          .join(', ')
      : months.map((month, index) => `${monthText(month)}: ${failedText(index)}`).join('; ');
  return (
    <svg
      width={width}
      height={MONTH_HEIGHT + 1}
      viewBox={`0 0 ${width} ${MONTH_HEIGHT + 1}`}
      role="img"
      aria-label={`${label}, month by month: ${spoken}`}
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
        const drawn = heights[index] ?? 0;
        // The outline needs a bar at least 2 pixels high; a partial one gets 4, so it shows.
        const height = month.partial && drawn > 0 ? Math.max(drawn, PARTIAL_MONTH_MIN) : drawn;
        return (
          <g key={month.month}>
            <title>{`${monthText(month)}: ${failedText(index)}`}</title>
            {/* The month's whole height answers the pointer, a bar or not. */}
            <rect x={x} y="0" width={MONTH_BAR} height={MONTH_HEIGHT} fill="transparent" />
            {height > 0 && month.partial ? (
              // Inset by half the stroke, so the outline keeps the bar's width and height.
              <rect
                x={x + 0.5}
                y={MONTH_HEIGHT - height + 0.5}
                width={MONTH_BAR - 1}
                height={height - 1}
                rx="1"
                fill="var(--chart-3)"
                fillOpacity={0.3}
                stroke="var(--chart-3)"
              />
            ) : height > 0 ? (
              <rect
                x={x}
                y={MONTH_HEIGHT - height}
                width={MONTH_BAR}
                height={height}
                rx="1"
                fill="var(--chart-3)"
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Which of the year's months are partial, drawn in outline: none, the first, the last or both. */
function partialNote(first: boolean, last: boolean): string {
  const which =
    first && last ? 'first and last months are' : first ? 'first month is' : 'last month is';
  return first || last
    ? ` The year starts 365 days ago and ends yesterday, so its ${which} partial, drawn in outline.`
    : '';
}

/**
 * A row of the folded tables of months: its name, its code for a reason's, its count each month and
 * a company's sends (ADR-364).
 */
export interface MonthRow {
  key: string;
  /** Its name, as text or a link. */
  name: ReactNode;
  /** A reason's code, as the table above shows it, in a column of its own. */
  code?: string;
  counts: readonly number[];
  /** A company's sends each month, those cancelled left out, for the share of them failed. */
  sent?: readonly number[];
}

/**
 * Under a table whose rows draw their months (ADR-360, ADR-362): a note saying which months the
 * bars run from and to and which are partial, and a folded table of every month's count, for
 * keyboards and touch screens as for screen readers; with the rows' sends, a second of the share of
 * them failed each month (ADR-364). Nothing without months.
 */
export function YearMonths({
  label,
  summary = 'Month by month as a table',
  heading,
  each,
  months,
  rows,
  shares,
}: {
  /** The folded table's accessible name, which holds the table's own in no part. */
  label: string;
  /** What its fold says. */
  summary?: string;
  /** Its first column's heading, naming the rows. */
  heading: string;
  /** The rows as the note names them: each reason, each company. */
  each: string;
  months: readonly FailureReasonMonth[];
  rows: readonly MonthRow[];
  /**
   * The folded table of the share of the rows' sends failed each month (ADR-364): its accessible
   * name, which holds no other table's, and what its fold says. None without.
   */
  shares?: { label: string; summary: string };
}) {
  const first = months[0];
  const last = months.at(-1);
  if (!first || !last) return null;
  const coded = rows.some((row) => row.code !== undefined);
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Month by month, from {chartMonthLabel(first.month)} to {chartMonthLabel(last.month)}, {each}{' '}
        to its own height:{' '}
        {shares
          ? 'point at a month for its count and the share of the sends failed, or open the tables below for every count and share.'
          : 'point at a month for its count, or open the table below for every count.'}
        {partialNote(first.partial, last.partial)}
      </p>
      {/* min-w-0: the table scrolls in its box rather than widening the card on a phone. */}
      <details className="min-w-0 rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">{summary}</summary>
        <Table aria-label={label} className="mt-3">
          <THead>
            <TR>
              <TH>{heading}</TH>
              {coded ? <TH>Code</TH> : null}
              {months.map((month) => (
                <TH key={month.month} className="whitespace-nowrap">
                  {monthText(month)}
                </TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.key}>
                <TD className="min-w-48">{row.name}</TD>
                {coded ? <TD className="whitespace-nowrap font-mono text-xs">{row.code}</TD> : null}
                {months.map((month, at) => (
                  <TD key={month.month} className="tabular-nums">
                    {chartCount(row.counts[at] ?? 0)}
                  </TD>
                ))}
              </TR>
            ))}
          </TBody>
        </Table>
      </details>
      {shares ? (
        <details className="min-w-0 rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">{shares.summary}</summary>
          <Table aria-label={shares.label} className="mt-3">
            <THead>
              <TR>
                <TH>{heading}</TH>
                {months.map((month) => (
                  <TH key={month.month} className="whitespace-nowrap">
                    {monthText(month)}
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.key}>
                  <TD className="min-w-48">{row.name}</TD>
                  {months.map((month, at) => {
                    // No share when it sent none (or fewer than failed): a dash, not 0%.
                    const share = failedOfSent(row.counts[at] ?? 0, row.sent?.[at] ?? 0);
                    return (
                      <TD key={month.month} className="tabular-nums">
                        {share === null ? '—' : chartShare(share)}
                      </TD>
                    );
                  })}
                </TR>
              ))}
            </TBody>
          </Table>
        </details>
      ) : null}
    </>
  );
}

/**
 * A window's failed sends by the code they failed with (ADR-347): the most frequent first, then the
 * rest together; each with its sends and its share of those failed, written and drawn as a bar in
 * the failed sends' colour, so the reasons compare at a glance while every number stays in the
 * table. With the year's months (ADR-360), each reason's months are drawn beside it, and a folded
 * table under it gives every month's count, for keyboards and touch screens as for screen readers.
 * When no send failed, a note says so.
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
  /**
   * The year's months and each reason's failed sends in them, in the order of the reasons, with the
   * folded table's accessible name, which holds the table's own in no part.
   */
  months?: {
    months: readonly FailureReasonMonth[];
    byMonth: readonly (readonly number[])[];
    label: string;
  };
}) {
  if (reasons.failed === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
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
              <TD className="whitespace-nowrap font-mono text-xs">{codeText(r)}</TD>
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
                    label={reasonText(r)}
                    months={months.months}
                    counts={months.byMonth[index] ?? []}
                  />
                </TD>
              ) : null}
            </TR>
          ))}
        </TBody>
      </Table>
      {months ? (
        <YearMonths
          label={months.label}
          heading="Reason"
          each="each reason"
          months={months.months}
          rows={reasons.reasons.map((r, index) => ({
            key: r.code ?? 'the rest',
            name: failureReasonLabel(r.code, r.codes),
            code: codeText(r),
            counts: months.byMonth[index] ?? [],
          }))}
        />
      ) : null}
    </div>
  );
}
