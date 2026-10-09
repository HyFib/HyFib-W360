/**
 * The geometry of the operations console's "Messages a day" chart (P5-10, ADR-333): the platform's
 * messages sent and received each UTC day of the Usage tab's window, as lines on one axis. Pure,
 * so the browser draws it at the width it has and the unit tests read every number. Failed sends
 * are not drawn: far fewer than the others, they would lie flat on the axis; the tooltip and the
 * table give them.
 */

/** One UTC day of the platform's messages, as the service reads them. */
export interface DailyChartDay {
  /** YYYY-MM-DD. */
  day: string;
  outbound: number;
  failed: number;
  inbound: number;
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

/**
 * The step between gridlines for counts up to `max`: 1, 2 or 5 times a power of ten, at least 1
 * (counts are whole), so there are at most five gridlines above 0.
 */
export function chartStep(max: number): number {
  if (max <= 4) return 1;
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  return (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude;
}

/**
 * Where each day and gridline goes on a chart `width` by `height` pixels: the x axis spans the
 * days, the y axis from 0 to the first gridline at or above the busiest day's count.
 */
export function dailyChartLayout(
  days: readonly DailyChartDay[],
  width: number,
  height: number,
): DailyChartLayout {
  const max = Math.max(0, ...days.map((d) => Math.max(d.outbound, d.inbound)));
  const step = chartStep(max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  // The y labels' width decides the left edge: about 7 pixels a character, and a gap.
  const left = Math.max(...ticks.map((value) => chartCount(value).length)) * 7 + 12;
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
  const right = width - (endLabels ? END_LABEL_ROOM : 16);
  const x = (index: number) =>
    last <= 0 ? (left + right) / 2 : left + (index / last) * (right - left);
  const xs = days.map((_, index) => x(index));
  // As many days named as fit, at most six: the first, the last, and evenly between; a name too
  // close to the last gives way to it.
  const fit = Math.min(6, Math.max(2, Math.floor((right - left) / DAY_LABEL_ROOM)));
  const every = Math.ceil(last / (fit - 1));
  const named: number[] = [];
  for (let index = 0; index < last; index += every) named.push(index);
  const beforeLast = named.at(-1);
  if (beforeLast !== undefined && x(last) - x(beforeLast) < DAY_LABEL_ROOM) named.pop();
  if (last >= 0) named.push(last);
  const shownNames = new Set(named);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    width,
    height,
    plot: { left, right, top: plotTop, bottom },
    yTicks: ticks.map((value) => ({ value, y: round(y(value)), label: chartCount(value) })),
    xTicks: days.flatMap((d, index) =>
      shownNames.has(index) ? [{ index, x: round(x(index)), label: chartDayLabel(d.day) }] : [],
    ),
    xs: xs.map(round),
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
