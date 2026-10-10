/**
 * The geometry of the operations console's "Messages a day" chart (P5-10, ADR-333): the platform's
 * messages sent and received each UTC day of the Usage tab's window, as lines on one axis. Pure,
 * so the browser draws it at the width it has and the unit tests read every number. Failed sends
 * are not drawn on it: far fewer than the others, they would lie flat on the axis. They have a
 * chart of their own under it (ADR-344), as a share of the messages sent each day, on an axis of
 * percentages, and so do the sends delivered and read (ADR-346).
 */

/** One UTC day of the platform's messages, as the service reads them. */
export interface DailyChartDay {
  /** YYYY-MM-DD. */
  day: string;
  outbound: number;
  failed: number;
  inbound: number;
  /**
   * Of the sent, those cancelled before they left (their status canceled: a paused or cancelled
   * campaign's queued sends), those delivered (delivered, read or played) and those read (read or
   * played), ADR-346; null on a kept day counted before they were.
   */
  canceled: number | null;
  delivered: number | null;
  read: number | null;
}

/** The two drawn series, in their fixed order: they keep their colours whatever the data. */
export const DAILY_CHART_SERIES = [
  { key: 'outbound', label: 'Sent' },
  { key: 'inbound', label: 'Received' },
] as const;

export type DailyChartSeriesKey = (typeof DAILY_CHART_SERIES)[number]['key'];

export interface DailyChartLayout {
  width: number;
  height: number;
  /** The plot's edges, inside the axis labels. */
  plot: { left: number; right: number; top: number; bottom: number };
  /** Gridlines and their labels, from 0 up: whole numbers, at most five. */
  yTicks: { value: number; y: number; label: string }[];
  /** The days named under the axis: the first, the last and evenly between. */
  xTicks: { index: number; x: number; label: string }[];
  /** Each day's x, for the crosshair. */
  xs: number[];
  series: {
    key: DailyChartSeriesKey;
    label: string;
    path: string;
    /** Each day's y, for the dots at the crosshair. */
    ys: number[];
    end: { x: number; y: number; value: number };
  }[];
  /** Whether the series' values are written at their ends: not when the ends nearly meet. */
  endLabels: boolean;
}

/** Room for an end label ("Received 12,345"), and below the plot for the days' names. */
const END_LABEL_ROOM = 120;
const X_AXIS_ROOM = 28;
const TOP_ROOM = 12;
/** Ends closer than this read as one label, so they are not written (the legend names them). */
const END_LABEL_GAP = 16;
/** Narrower than this, the plot keeps the room the end labels would take. */
const END_LABEL_MIN_WIDTH = 480;
/** Room for the failed sends' end label (">99.9%", ADR-344). */
const SHARE_LABEL_ROOM = 60;
/**
 * The room a day's name ("30 Sep", about 40 pixels) takes under the axis. The first name starts at
 * its day and the last ends at its day, so a name beside either needs one and a half names' width.
 */
const DAY_LABEL_ROOM = 64;

/**
 * A count as the console writes it: 12,345. Written by hand rather than by the locale, so the
 * server and the browser draw the same text and the chart hydrates without a difference.
 */
export const chartCount = (value: number): string =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A UTC day, YYYY-MM-DD, as the chart names it, 9 Oct, by the same hand as the counts. */
export function chartDayLabel(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

/** A month, YYYY-MM, as the console names it, Oct 2025, by the same hand (ADR-360). */
export function chartMonthLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/**
 * The heights of a row of month bars at most `height` pixels high (ADR-360): the most in one month
 * fills it, the others in proportion, rounded, at least 2 pixels for a month with one failed send so
 * it still shows, and none for a month without.
 */
export function monthBarHeights(counts: readonly number[], height: number): number[] {
  const most = Math.max(0, ...counts);
  return counts.map((n) => (n > 0 && most > 0 ? Math.max(2, Math.round((n / most) * height)) : 0));
}

/**
 * The step between gridlines for counts up to `max`: 1, 2 or 5 times a power of ten, at least 1
 * (counts are whole) and at least a quarter of `max`, so there are at most four gridlines above 0.
 */
export function chartStep(max: number): number {
  if (max <= 4) return 1;
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  return (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * The days along an x axis from `left` to `right`: each day's x, and the days named under it, as
 * many as fit, at most six: the first, the last, and evenly between; a name too close to the last
 * gives way to it.
 */
function dayAxis(days: readonly DailyChartDay[], left: number, right: number) {
  const last = days.length - 1;
  const x = (index: number) =>
    last <= 0 ? (left + right) / 2 : left + (index / last) * (right - left);
  const fit = Math.min(6, Math.max(2, Math.floor((right - left) / DAY_LABEL_ROOM)));
  const every = Math.ceil(last / (fit - 1));
  const named: number[] = [];
  for (let index = 0; index < last; index += every) named.push(index);
  const beforeLast = named.at(-1);
  if (beforeLast !== undefined && x(last) - x(beforeLast) < DAY_LABEL_ROOM) named.pop();
  if (last >= 0) named.push(last);
  const shownNames = new Set(named);
  return {
    x,
    xs: days.map((_, index) => round(x(index))),
    xTicks: days.flatMap((d, index) =>
      shownNames.has(index) ? [{ index, x: round(x(index)), label: chartDayLabel(d.day) }] : [],
    ),
  };
}

/** A plot's left and right edges, which two charts of the same days can share (ADR-344). */
export interface PlotEdges {
  left: number;
  right: number;
}

/**
 * Where each day and gridline goes on a chart `width` by `height` pixels: the x axis spans the
 * days, the y axis from 0 to the first gridline at or above the busiest day's count. With `edges`,
 * the plot spans those instead of its own (`sharedPlotEdges`).
 */
export function dailyChartLayout(
  days: readonly DailyChartDay[],
  width: number,
  height: number,
  edges?: PlotEdges,
): DailyChartLayout {
  const max = Math.max(0, ...days.map((d) => Math.max(d.outbound, d.inbound)));
  const step = chartStep(max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  // The y labels' width decides the left edge: about 7 pixels a character, and a gap.
  const left = edges?.left ?? Math.max(...ticks.map((value) => chartCount(value).length)) * 7 + 12;
  const plotTop = TOP_ROOM;
  const bottom = height - X_AXIS_ROOM;
  const y = (value: number) => bottom - (value / top) * (bottom - plotTop);
  const last = days.length - 1;
  const lastDay = days.at(-1);
  // Without days there are no ends, so nothing is written.
  const endLabels =
    width >= END_LABEL_MIN_WIDTH &&
    lastDay !== undefined &&
    Math.abs(y(lastDay.outbound) - y(lastDay.inbound)) >= END_LABEL_GAP;
  const right = edges?.right ?? width - (endLabels ? END_LABEL_ROOM : 16);
  const { x, xs, xTicks } = dayAxis(days, left, right);
  return {
    width,
    height,
    plot: { left, right, top: plotTop, bottom },
    yTicks: ticks.map((value) => ({ value, y: round(y(value)), label: chartCount(value) })),
    xTicks,
    xs,
    series: DAILY_CHART_SERIES.map((s) => ({
      key: s.key,
      label: s.label,
      path: days
        .map((d, index) => `${index === 0 ? 'M' : 'L'}${round(x(index))} ${round(y(d[s.key]))}`)
        .join(' '),
      ys: days.map((d) => round(y(d[s.key]))),
      end: lastDay
        ? { x: round(x(last)), y: round(y(lastDay[s.key])), value: lastDay[s.key] }
        : { x: round(x(0)), y: round(bottom), value: 0 },
    })),
    endLabels,
  };
}

/**
 * The sends a day's shares are of (ADR-346): those sent less those cancelled before they left, as
 * the company reports' failure rate counts them, so a campaign paused, whose queued sends are
 * cancelled and sent again as new messages when it resumes, does not read as fewer deliveries or
 * failures. Null on a kept day counted before the cancellations were, until it is counted again.
 */
export function shareBase(day: DailyChartDay): number | null {
  return day.canceled === null ? null : day.outbound - day.canceled;
}

/** Why a day has no share (ADR-346): see `shareGap`. */
export type ShareGap = 'none_sent' | 'all_cancelled' | 'not_counted';

/**
 * Why a day has no share (ADR-346), or null when it has one: it sent nothing, every send was
 * cancelled before it left, or it is a kept day whose cancellations are not counted yet.
 */
export function shareGap(day: DailyChartDay): ShareGap | null {
  if (day.outbound === 0) return 'none_sent';
  const base = shareBase(day);
  if (base === null) return 'not_counted';
  return base <= 0 ? 'all_cancelled' : null;
}

/**
 * The share of a day's sent messages that failed (ADR-344), from 0 to 1, of those not cancelled
 * (`shareBase`), or null on a day that sent none, whose sends were all cancelled, or whose
 * cancellations are not counted yet: it has no share, and the chart leaves a gap there rather than
 * draw it as 0%.
 */
export function failedShare(day: DailyChartDay): number | null {
  const base = shareBase(day);
  return base !== null && base > 0 ? day.failed / base : null;
}

/**
 * A company's failed sends as a share of its sends (ADR-364), those cancelled left out, from 0 to 1;
 * null when it sent none, or when fewer sends than failed sends are left, as of a company whose
 * deletion removes its sends before its failed sends by code: no share, rather than one above all.
 */
export function failedOfSent(failed: number, sent: number): number | null {
  return sent > 0 && failed <= sent ? failed / sent : null;
}

/**
 * A share as the chart writes it, by the same hand as the counts: 3%, 2.5%, to a tenth of a
 * percent; a share above 0 too small for a tenth is "<0.1%", and one below 1 that would round to
 * 100% is ">99.9%", so neither reads as none or as all of them.
 */
export function chartShare(share: number): string {
  const tenths = Math.round(share * 1000);
  if (share > 0 && tenths === 0) return '<0.1%';
  if (share < 1 && tenths === 1000) return '>99.9%';
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}%`;
}

export interface FailedShareLayout {
  width: number;
  height: number;
  /** The plot's edges, inside the axis labels. */
  plot: { left: number; right: number; top: number; bottom: number };
  /** Gridlines and their labels, from 0% up, valued in tenths of a percent: at most five. */
  yTicks: { value: number; y: number; label: string }[];
  /** The days named under the axis, as the messages chart names them. */
  xTicks: { index: number; x: number; label: string }[];
  /** Each day's x, for the crosshair. */
  xs: number[];
  /** The line, broken at each day that sent nothing. */
  path: string;
  /** Each day's y, or null on a day that sent nothing. */
  ys: (number | null)[];
  /** The days with a share between days without one: a line of one point draws nothing. */
  lone: number[];
  /** Where the line ends and the last day's share, or null when the last day sent nothing. */
  end: { x: number; y: number; share: number } | null;
  /** Whether the last day's share is written at the line's end. */
  endLabel: boolean;
}

/**
 * Where each day and gridline goes on the failed sends' chart (ADR-344), `width` by `height`
 * pixels: the days along the x axis as on the messages chart, the y axis from 0% to the first
 * gridline at or above the day with the largest share, in tenths of a percent so the steps are
 * whole like the counts' (0.1% at least). Days that sent nothing have no point. With `edges`, the
 * plot spans those instead of its own (`sharedPlotEdges`).
 */
export function failedShareLayout(
  days: readonly DailyChartDay[],
  width: number,
  height: number,
  edges?: PlotEdges,
): FailedShareLayout {
  const shares = days.map(failedShare);
  // Each day's share rounded up to a tenth of a percent, in whole numbers, so the scale's top is at
  // or above every day's.
  const tenthsUp = (d: DailyChartDay) => {
    const base = shareBase(d);
    return base !== null && base > 0 ? Math.floor((d.failed * 1000 + base - 1) / base) : 0;
  };
  const max = Math.max(0, ...days.map(tenthsUp));
  const step = chartStep(max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  const left =
    edges?.left ?? Math.max(...ticks.map((value) => chartShare(value / 1000).length)) * 7 + 12;
  const plotTop = TOP_ROOM;
  const bottom = height - X_AXIS_ROOM;
  const y = (tenths: number) => bottom - (tenths / top) * (bottom - plotTop);
  const lastShare = shares.at(-1) ?? null;
  const endLabel = width >= END_LABEL_MIN_WIDTH && lastShare !== null;
  const right = edges?.right ?? width - (endLabel ? SHARE_LABEL_ROOM : 16);
  const { xs, xTicks } = dayAxis(days, left, right);
  const ys = shares.map((share) => (share === null ? null : round(y(share * 1000))));
  const drawn = (index: number) => ys[index] !== undefined && ys[index] !== null;
  const endX = xs.at(-1);
  const endY = ys.at(-1);
  return {
    width,
    height,
    plot: { left, right, top: plotTop, bottom },
    yTicks: ticks.map((value) => ({
      value,
      y: round(y(value)),
      label: chartShare(value / 1000),
    })),
    xTicks,
    xs,
    path: ys
      .flatMap((value, index) =>
        value === null ? [] : [`${drawn(index - 1) ? 'L' : 'M'}${xs[index]} ${value}`],
      )
      .join(' '),
    ys,
    lone: ys.flatMap((_, index) =>
      drawn(index) && !drawn(index - 1) && !drawn(index + 1) ? [index] : [],
    ),
    end:
      lastShare !== null && endX !== undefined && endY !== undefined && endY !== null
        ? { x: endX, y: endY, share: lastShare }
        : null,
    endLabel,
  };
}

/**
 * The share of a day's sent messages delivered (ADR-346), from 0 to 1, of those not cancelled
 * (`shareBase`): those whose status got to delivered, read or played. Null as the failed share is,
 * and on a kept day counted before the deliveries were: the chart leaves a gap there rather than
 * draw it as 0%.
 */
export function deliveredShare(day: DailyChartDay): number | null {
  const base = shareBase(day);
  return base !== null && base > 0 && day.delivered !== null ? day.delivered / base : null;
}

/** The share of a day's sent messages read (ADR-346), read or played; null as the delivered one. */
export function readShare(day: DailyChartDay): number | null {
  const base = shareBase(day);
  return base !== null && base > 0 && day.read !== null ? day.read / base : null;
}

/** The delivery chart's two series, in their fixed order: they keep their colours whatever the data. */
export const DELIVERY_CHART_SERIES = [
  { key: 'delivered', label: 'Delivered', share: deliveredShare },
  { key: 'read', label: 'Read', share: readShare },
] as const;

export type DeliveryChartSeriesKey = (typeof DELIVERY_CHART_SERIES)[number]['key'];

/** The delivery chart's gridlines, in whole percent: the whole range, which a share can take. */
const DELIVERY_TICKS = [0, 25, 50, 75, 100];

export interface DeliveryShareLayout {
  width: number;
  height: number;
  /** The plot's edges, inside the axis labels. */
  plot: { left: number; right: number; top: number; bottom: number };
  /** Gridlines and their labels: 0, 25, 50, 75 and 100%. */
  yTicks: { value: number; y: number; label: string }[];
  /** The days named under the axis, as the messages chart names them. */
  xTicks: { index: number; x: number; label: string }[];
  /** Each day's x, for the crosshair. */
  xs: number[];
  series: {
    key: DeliveryChartSeriesKey;
    label: string;
    /** The line, broken at each day without a share. */
    path: string;
    /** Each day's y, or null on a day without a share. */
    ys: (number | null)[];
    /** The days with a share between days without one: a line of one point draws nothing. */
    lone: number[];
    /** Where the line ends and the last day's share, or null when the last day has none. */
    end: { x: number; y: number; share: number } | null;
  }[];
  /** Whether the last day's shares are written at the lines' ends: not when the ends nearly meet. */
  endLabels: boolean;
}

/**
 * A share drawn as a bar `thickness` pixels high in a box `length` long (ADR-347): from a square
 * start to an end rounded by half the thickness, at least 2 pixels long so a share too small to see
 * still shows, as an SVG path.
 */
export function shareBarPath(share: number, length: number, thickness = 8): string {
  const drawn = Math.min(length, Math.max(share * length, 2));
  const radius = Math.min(thickness / 2, drawn / 2);
  const straight = round(drawn - radius);
  return `M0 0 H${straight} A${round(radius)} ${thickness / 2} 0 0 1 ${straight} ${thickness} H0 Z`;
}

/**
 * Where each day and gridline goes on the delivery chart (ADR-346), `width` by `height` pixels: the
 * days along the x axis as on the messages chart, the y axis from 0% to 100%, a line for the share
 * delivered and one for the share read. Days without a share have no point. With `edges`, the plot
 * spans those instead of its own (`sharedPlotEdges`).
 */
export function deliveryShareLayout(
  days: readonly DailyChartDay[],
  width: number,
  height: number,
  edges?: PlotEdges,
): DeliveryShareLayout {
  const left =
    edges?.left ??
    Math.max(...DELIVERY_TICKS.map((value) => chartShare(value / 100).length)) * 7 + 12;
  const top = TOP_ROOM;
  const bottom = height - X_AXIS_ROOM;
  const y = (share: number) => round(bottom - share * (bottom - top));
  const shares = DELIVERY_CHART_SERIES.map((s) => days.map((d) => s.share(d)));
  const endYs = shares.map((list) => {
    const last = list.at(-1) ?? null;
    return last === null ? null : y(last);
  });
  const [deliveredEnd, readEnd] = endYs;
  const endLabels =
    width >= END_LABEL_MIN_WIDTH &&
    deliveredEnd !== null &&
    deliveredEnd !== undefined &&
    readEnd !== null &&
    readEnd !== undefined &&
    Math.abs(deliveredEnd - readEnd) >= END_LABEL_GAP;
  const right = edges?.right ?? width - (endLabels ? END_LABEL_ROOM : 16);
  const { xs, xTicks } = dayAxis(days, left, right);
  const endX = xs.at(-1);
  return {
    width,
    height,
    plot: { left, right, top, bottom },
    yTicks: DELIVERY_TICKS.map((value) => ({
      value,
      y: y(value / 100),
      label: chartShare(value / 100),
    })),
    xTicks,
    xs,
    series: DELIVERY_CHART_SERIES.map((s, i) => {
      const list = shares[i] ?? [];
      const ys = list.map((share) => (share === null ? null : y(share)));
      const drawn = (index: number) => ys[index] !== undefined && ys[index] !== null;
      const lastShare = list.at(-1) ?? null;
      const endY = ys.at(-1);
      return {
        key: s.key,
        label: s.label,
        path: ys
          .flatMap((value, index) =>
            value === null ? [] : [`${drawn(index - 1) ? 'L' : 'M'}${xs[index]} ${value}`],
          )
          .join(' '),
        ys,
        lone: ys.flatMap((_, index) =>
          drawn(index) && !drawn(index - 1) && !drawn(index + 1) ? [index] : [],
        ),
        end:
          lastShare !== null && endX !== undefined && endY !== undefined && endY !== null
            ? { x: endX, y: endY, share: lastShare }
            : null,
      };
    }),
    endLabels,
  };
}

/**
 * The edges the messages chart and the share charts drawn under it share (ADR-344, ADR-346), so
 * each day sits at the same x in all: room on the left for any chart's gridline labels, and on the
 * right for any's end labels.
 */
export function sharedPlotEdges(
  days: readonly DailyChartDay[],
  width: number,
  height: number,
): PlotEdges {
  const plots = [
    dailyChartLayout(days, width, height).plot,
    failedShareLayout(days, width, height).plot,
    deliveryShareLayout(days, width, height).plot,
  ];
  return {
    left: Math.max(...plots.map((p) => p.left)),
    right: Math.min(...plots.map((p) => p.right)),
  };
}

/** The day nearest a pointer at `pointerX`, by the days' x (the crosshair snaps to it). */
export function nearestDayIndex(xs: readonly number[], pointerX: number): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const [index, x] of xs.entries()) {
    const distance = Math.abs(x - pointerX);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}
