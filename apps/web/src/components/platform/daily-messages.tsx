import { EmptyState, TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import type { OpsDailyActivity } from '@w360/domain';
import { DailyMessagesChart } from '@/components/platform/daily-chart';

/**
 * Messages a day (ADR-333, ADR-334): the chart of the days, the folded table of every day's numbers
 * beside it, or, when no message was sent or received in them, an empty state saying so.
 */
export function DailyMessages({
  days,
  label,
  empty,
}: {
  days: OpsDailyActivity[];
  /** The chart's accessible name: whose messages and over how many days. */
  label: string;
  /** What the empty state says when nothing was sent or received. */
  empty: string;
}) {
  if (days.every((d) => d.outbound === 0 && d.inbound === 0)) {
    return <EmptyState title="No messages in these days" description={empty} />;
  }
  return (
    <>
      <DailyMessagesChart days={days} label={label} />
      {/* min-w-0: the table scrolls in its box rather than widening the card on a phone. */}
      <details className="min-w-0 rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Table of the days</summary>
        <Table aria-label="Messages a day" className="mt-3">
          <THead>
            <TR>
              <TH>Day (UTC)</TH>
              <TH>Sent</TH>
              <TH>Failed</TH>
              <TH>Received</TH>
            </TR>
          </THead>
          <TBody>
            {days.map((d) => (
              <TR key={d.day}>
                <TD className="whitespace-nowrap">{d.day}</TD>
                <TD className="tabular-nums">{d.outbound}</TD>
                <TD className="tabular-nums">{d.failed}</TD>
                <TD className="tabular-nums">{d.inbound}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </details>
    </>
  );
}
