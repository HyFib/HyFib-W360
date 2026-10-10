import { EmptyState, TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import type { OpsDailyActivity } from '@w360/domain';
import { chartShare, failedShare } from '@w360/domain/ops-chart';
import { DailyFailedShareChart, DailyMessagesChart } from '@/components/platform/daily-chart';

/**
 * Messages a day (ADR-333, ADR-334): the chart of the days, under it the share of each day's sends
 * that failed (ADR-344), and the folded table of every day's numbers; or, when no message was sent
 * or received in them, an empty state saying so.
 */
export function DailyMessages({
  days,
  label,
  empty,
  failed,
  names = { legend: 'Lines', summary: 'Table of the days', table: 'Messages a day' },
}: {
  days: OpsDailyActivity[];
  /** The chart's accessible name: whose messages and over how many days. */
  label: string;
  /** What the empty state says when nothing was sent or received. */
  empty: string;
  /**
   * The failed share's chart: its accessible name, what it says when nothing was sent, and the
   * period its caption ends with, so the two captions of a page with two charts differ.
   */
  failed: { label: string; noneSent: string; period: string };
  /** The legend's, the folded table's and its summary's names, told apart on a page with two. */
  names?: { legend: string; summary: string; table: string };
}) {
  if (days.every((d) => d.outbound === 0 && d.inbound === 0)) {
    return <EmptyState title="No messages in these days" description={empty} />;
  }
  const sent = days.some((d) => d.outbound > 0);
  return (
    <>
      <DailyMessagesChart days={days} label={label} legendLabel={names.legend} aligned={sent} />
      <figure className="grid min-w-0 gap-2">
        <figcaption className="text-sm font-medium">
          Sends that failed, as a share of those sent, {failed.period}
        </figcaption>
        {sent ? (
          <DailyFailedShareChart days={days} label={failed.label} />
        ) : (
          <p className="text-sm text-muted-foreground">{failed.noneSent}</p>
        )}
      </figure>
      {/* min-w-0: the table scrolls in its box rather than widening the card on a phone. */}
      <details className="min-w-0 rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">{names.summary}</summary>
        <Table aria-label={names.table} className="mt-3">
          <THead>
            <TR>
              <TH>Day (UTC)</TH>
              <TH>Sent</TH>
              <TH>Failed</TH>
              <TH>Received</TH>
              <TH>Share failed</TH>
            </TR>
          </THead>
          <TBody>
            {days.map((d) => {
              const share = failedShare(d);
              return (
                <TR key={d.day}>
                  <TD className="whitespace-nowrap">{d.day}</TD>
                  <TD className="tabular-nums">{d.outbound}</TD>
                  <TD className="tabular-nums">{d.failed}</TD>
                  <TD className="tabular-nums">{d.inbound}</TD>
                  <TD className="tabular-nums">
                    {share === null ? 'None sent' : chartShare(share)}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </details>
    </>
  );
}
