import { EmptyState, TBody, TD, TH, THead, TR, Table } from '@w360/ui';
import type { OpsDailyActivity } from '@w360/domain';
import {
  chartShare,
  failedShare,
  shareBase,
  shareGap,
  type ShareGap,
} from '@w360/domain/ops-chart';
import {
  DailyDeliveryShareChart,
  DailyFailedShareChart,
  DailyMessagesChart,
} from '@/components/platform/daily-chart';

/** Why a day has no share, as the table says it (ADR-346). */
const GAP_CELL: Record<ShareGap, string> = {
  none_sent: 'None sent',
  all_cancelled: 'All cancelled',
  not_counted: 'Not counted',
};

/** A count of the sends not cancelled, with its share of them, "970 (97%)", or why none (ADR-346). */
const ofSent = (d: OpsDailyActivity, count: number | null) => {
  const gap = shareGap(d);
  const base = shareBase(d);
  return gap !== null
    ? GAP_CELL[gap]
    : count === null || base === null
      ? 'Not counted'
      : `${count} (${chartShare(count / base)})`;
};

/** In place of the share charts when every send of the days drawn was cancelled before it left. */
const ALL_CANCELLED = 'Every send of these days was cancelled before it left: none has a share.';

/** In place of the share charts while the days drawn with sends are not counted again yet. */
const NOT_COUNTED =
  'The sends cancelled, delivered and read of these days are not counted yet: the worker counts each day again, a few days a minute.';

/**
 * Messages a day (ADR-333, ADR-334): the chart of the days, under it the share of each day's sends
 * that failed (ADR-344) and the shares delivered and read (ADR-346), and the folded table of every
 * day's numbers; or, when no message was sent or received in them, an empty state saying so.
 */
export function DailyMessages({
  days,
  label,
  empty,
  failed,
  delivered,
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
  /**
   * The delivery chart's accessible name and its legend's, told apart on a page with two, and what
   * it says when nothing was sent.
   */
  delivered: { label: string; legend: string; noneSent: string };
  /** The legend's, the folded table's and its summary's names, told apart on a page with two. */
  names?: { legend: string; summary: string; table: string };
}) {
  if (days.every((d) => d.outbound === 0 && d.inbound === 0)) {
    return <EmptyState title="No messages in these days" description={empty} />;
  }
  const sent = days.some((d) => d.outbound > 0);
  // The shares are of the sends not cancelled before they left (ADR-346): drawn when a day has one,
  // else a note saying why none has.
  const shared = days.some((d) => shareGap(d) === null);
  const note = (noneSent: string) =>
    !sent
      ? noneSent
      : days.some((d) => shareGap(d) === 'not_counted')
        ? NOT_COUNTED
        : ALL_CANCELLED;
  return (
    <>
      <DailyMessagesChart days={days} label={label} legendLabel={names.legend} aligned={shared} />
      <figure className="grid min-w-0 gap-2">
        <figcaption className="text-sm font-medium">
          Sends that failed, as a share of those not cancelled, {failed.period}
        </figcaption>
        {shared ? (
          <DailyFailedShareChart days={days} label={failed.label} />
        ) : (
          <p className="text-sm text-muted-foreground">{note(failed.noneSent)}</p>
        )}
      </figure>
      <figure className="grid min-w-0 gap-2">
        <figcaption className="text-sm font-medium">
          Sends delivered and read, as shares of those not cancelled, {failed.period}
        </figcaption>
        {shared ? (
          <DailyDeliveryShareChart
            days={days}
            label={delivered.label}
            legendLabel={delivered.legend}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{note(delivered.noneSent)}</p>
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
              <TH>Cancelled</TH>
              <TH>Failed</TH>
              <TH>Received</TH>
              <TH>Share failed</TH>
              <TH>Delivered</TH>
              <TH>Read</TH>
            </TR>
          </THead>
          <TBody>
            {days.map((d) => {
              const share = failedShare(d);
              const gap = shareGap(d);
              return (
                <TR key={d.day}>
                  <TD className="whitespace-nowrap">{d.day}</TD>
                  <TD className="tabular-nums">{d.outbound}</TD>
                  <TD className="whitespace-nowrap tabular-nums">
                    {d.canceled === null ? 'Not counted' : d.canceled}
                  </TD>
                  <TD className="tabular-nums">{d.failed}</TD>
                  <TD className="tabular-nums">{d.inbound}</TD>
                  <TD className="whitespace-nowrap tabular-nums">
                    {gap !== null
                      ? GAP_CELL[gap]
                      : share === null
                        ? 'Not counted'
                        : chartShare(share)}
                  </TD>
                  <TD className="whitespace-nowrap tabular-nums">{ofSent(d, d.delivered)}</TD>
                  <TD className="whitespace-nowrap tabular-nums">{ofSent(d, d.read)}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </details>
    </>
  );
}
