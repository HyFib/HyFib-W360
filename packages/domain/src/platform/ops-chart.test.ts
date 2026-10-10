import { describe, expect, it } from 'vitest';
import {
  DAILY_CHART_SERIES,
  DELIVERY_CHART_SERIES,
  chartCount,
  chartDayLabel,
  chartShare,
  chartStep,
  dailyChartLayout,
  deliveredShare,
  deliveryShareLayout,
  failedShare,
  failedShareLayout,
  nearestDayIndex,
  readShare,
  shareBase,
  sharedPlotEdges,
  type DailyChartDay,
} from './ops-chart';

// A day with its deliveries counts none cancelled unless told: a kept day without them, none known.
const day = (
  date: string,
  outbound: number,
  inbound: number,
  failed = 0,
  delivered: number | null = null,
  read: number | null = null,
  canceled: number | null = delivered === null ? null : 0,
): DailyChartDay => ({ day: date, outbound, failed, inbound, canceled, delivered, read });

describe('the messages a day chart (ADR-333)', () => {
  it('writes counts and days the same way on the server and in the browser', () => {
    expect(chartCount(0)).toBe('0');
    expect(chartCount(999)).toBe('999');
    expect(chartCount(1000)).toBe('1,000');
    expect(chartCount(1234567)).toBe('1,234,567');
    expect(chartDayLabel('2026-10-09')).toBe('9 Oct');
    expect(chartDayLabel('2026-01-31')).toBe('31 Jan');
    expect(chartDayLabel('2026-12-01')).toBe('1 Dec');
  });

  it('steps gridlines by 1, 2 or 5 times a power of ten, at most four above 0', () => {
    for (const [max, step] of [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 2],
      [8, 2],
      [9, 5],
      [10, 5],
      [20, 5],
      [21, 10],
      [40, 10],
      [41, 20],
      [1234, 500],
      [2000, 500],
      [2001, 1000],
    ] as const) {
      expect(chartStep(max), String(max)).toBe(step);
      // The busiest day sits under the top gridline, at most four steps above 0.
      expect(Math.ceil(max / step), String(max)).toBeLessThanOrEqual(4);
      const top = dailyChartLayout([day('2026-10-09', max, 0)], 720, 240).yTicks.at(-1)!.value;
      expect(top, String(max)).toBeGreaterThanOrEqual(max);
      expect(top, String(max)).toBeLessThan(Math.max(max, 1) + step);
    }
  });

  it('draws both series on one axis from 0 to the gridline at or above the busiest day', () => {
    const layout = dailyChartLayout(
      [day('2026-10-07', 10, 4, 1), day('2026-10-08', 30, 12), day('2026-10-09', 25, 8, 2)],
      720,
      240,
    );
    // Steps of 10 up to 30: 0, 10, 20, 30.
    expect(layout.yTicks.map((t) => [t.value, t.label])).toEqual([
      [0, '0'],
      [10, '10'],
      [20, '20'],
      [30, '30'],
    ]);
    // The plot sits right of the y labels (2 characters), above the days' names, under 12 pixels
    // of air, and left of the end labels.
    expect(layout.plot).toEqual({ left: 26, right: 600, top: 12, bottom: 212 });
    expect(layout.yTicks.map((t) => t.y)).toEqual([212, 145.33, 78.67, 12]);
    expect(layout.xs).toEqual([26, 313, 600]);
    expect(layout.series.map((s) => [s.key, s.label])).toEqual([
      ['outbound', 'Sent'],
      ['inbound', 'Received'],
    ]);
    expect(DAILY_CHART_SERIES.map((s) => s.key)).toEqual(['outbound', 'inbound']);
    expect(layout.series[0]!.path).toBe('M26 145.33 L313 12 L600 45.33');
    expect(layout.series[1]!.path).toBe('M26 185.33 L313 132 L600 158.67');
    expect(layout.series.map((s) => s.ys)).toEqual([
      [145.33, 12, 45.33],
      [185.33, 132, 158.67],
    ]);
    expect(layout.series.map((s) => s.end)).toEqual([
      { x: 600, y: 45.33, value: 25 },
      { x: 600, y: 158.67, value: 8 },
    ]);
    expect(layout.endLabels).toBe(true);
    expect(layout.xTicks.map((t) => [t.index, t.label])).toEqual([
      [0, '7 Oct'],
      [1, '8 Oct'],
      [2, '9 Oct'],
    ]);
  });

  it('scales both series to the busier one, whichever it is', () => {
    const layout = dailyChartLayout([day('2026-10-08', 3, 40), day('2026-10-09', 2, 10)], 720, 240);
    expect(layout.yTicks.map((t) => t.value)).toEqual([0, 10, 20, 30, 40]);
    expect(layout.series[1]!.path).toBe('M26 12 L600 162');
  });

  it('leaves the end values unwritten where the ends nearly meet, or the chart is narrow', () => {
    const close = dailyChartLayout([day('2026-10-08', 10, 2), day('2026-10-09', 20, 19)], 720, 240);
    expect(close.endLabels).toBe(false);
    // The plot takes the room the labels would have had.
    expect(close.plot.right).toBe(704);
    const narrow = dailyChartLayout([day('2026-10-08', 10, 2), day('2026-10-09', 20, 2)], 400, 240);
    expect(narrow.endLabels).toBe(false);
    expect(narrow.plot.right).toBe(384);
    const wide = dailyChartLayout([day('2026-10-08', 10, 2), day('2026-10-09', 20, 2)], 480, 240);
    expect(wide.endLabels).toBe(true);
    // 16 pixels apart is room enough for both; 15 is not.
    const apart = dailyChartLayout(
      [day('2026-10-08', 1, 1), day('2026-10-09', 200, 184)],
      720,
      240,
    );
    expect(apart.series.map((s) => s.end.y)).toEqual([12, 28]);
    expect(apart.endLabels).toBe(true);
    const near = dailyChartLayout([day('2026-10-08', 1, 1), day('2026-10-09', 200, 185)], 720, 240);
    expect(near.series.map((s) => s.end.y)).toEqual([12, 27]);
    expect(near.endLabels).toBe(false);
  });

  it('names as many days as fit, at most six, the first and the last always, never crowded', () => {
    const month = Array.from({ length: 31 }, (_, i) =>
      day(`2026-10-${String(i + 1).padStart(2, '0')}`, i, 2 * i),
    );
    const named = (days: number, width: number) => {
      const layout = dailyChartLayout(month.slice(0, days), width, 240);
      // Each name has its room: 64 pixels from the next, as the first and the last need.
      const xs = layout.xTicks.map((t) => t.x);
      for (let i = 1; i < xs.length; i += 1) {
        expect(xs[i]! - xs[i - 1]!, `${days} days at ${width}`).toBeGreaterThanOrEqual(64);
      }
      return layout.xTicks.map((t) => t.index);
    };
    expect(named(31, 720)).toEqual([0, 6, 12, 18, 24, 30]);
    expect(named(31, 390)).toEqual([0, 8, 16, 24, 30]);
    expect(named(31, 320)).toEqual([0, 10, 20, 30]);
    // A name too close to the last gives way to it; one far enough off stays.
    expect(named(24, 560)).toEqual([0, 5, 10, 15, 23]);
    expect(named(24, 720)).toEqual([0, 5, 10, 15, 20, 23]);
    expect(named(8, 720)).toEqual([0, 2, 4, 6, 7]);
    // Exactly 64 pixels is room enough.
    expect(named(8, 594)).toEqual([0, 2, 4, 6, 7]);
    expect(named(8, 593)).toEqual([0, 2, 4, 7]);
    // However narrow, the first day and the last.
    expect(named(31, 120)).toEqual([0, 30]);
  });

  it('draws one day in the middle and no day at all without failing', () => {
    const one = dailyChartLayout([day('2026-10-09', 3, 1)], 720, 240);
    expect(one.xs).toEqual([(one.plot.left + one.plot.right) / 2]);
    expect(one.series[0]!.path).toMatch(/^M\S+ \S+$/);
    expect(one.xTicks.map((t) => t.label)).toEqual(['9 Oct']);
    const none = dailyChartLayout([], 720, 240);
    expect(none.xs).toEqual([]);
    expect(none.xTicks).toEqual([]);
    expect(none.series.map((s) => s.path)).toEqual(['', '']);
    expect(none.endLabels).toBe(false);
    expect(none.yTicks.map((t) => t.value)).toEqual([0, 1]);
    expect(none.series.map((s) => [s.end.y, s.end.value])).toEqual([
      [none.plot.bottom, 0],
      [none.plot.bottom, 0],
    ]);
  });

  it('snaps the crosshair to the nearest day', () => {
    const xs = [26, 313, 600];
    expect(nearestDayIndex(xs, 0)).toBe(0);
    expect(nearestDayIndex(xs, 169)).toBe(0);
    // Halfway, the earlier day.
    expect(nearestDayIndex(xs, 169.5)).toBe(0);
    expect(nearestDayIndex(xs, 170)).toBe(1);
    expect(nearestDayIndex(xs, 456)).toBe(1);
    expect(nearestDayIndex(xs, 457)).toBe(2);
    expect(nearestDayIndex(xs, 9999)).toBe(2);
    expect(nearestDayIndex([], 10)).toBeNull();
  });
});

describe('the failed sends a day chart (ADR-344)', () => {
  it('takes each day’s share of its sends that failed, and none on a day that sent nothing', () => {
    expect(failedShare(day('2026-10-09', 40, 3, 1))).toBe(0.025);
    expect(failedShare(day('2026-10-09', 40, 3, 0))).toBe(0);
    expect(failedShare(day('2026-10-09', 2, 0, 2))).toBe(1);
    // Received messages have no share: only sends fail.
    expect(failedShare(day('2026-10-09', 0, 12, 0))).toBeNull();
  });

  it('leaves the sends cancelled before they left out of every share (ADR-346)', () => {
    // 10 sent, 6 of them cancelled as a campaign paused: of the 4 others, 2 failed and 1 delivered
    // and read.
    const paused = day('2026-10-09', 10, 0, 2, 1, 1, 6);
    expect(shareBase(paused)).toBe(4);
    expect(failedShare(paused)).toBe(0.5);
    expect(deliveredShare(paused)).toBe(0.25);
    expect(readShare(paused)).toBe(0.25);
    // Every send cancelled: no share, as on a day that sent nothing.
    const cancelled = day('2026-10-09', 3, 1, 0, 0, 0, 3);
    expect(shareBase(cancelled)).toBe(0);
    expect(failedShare(cancelled)).toBeNull();
    expect(deliveredShare(cancelled)).toBeNull();
    expect(readShare(cancelled)).toBeNull();
    // A kept day counted before the cancellations were: of every send, as ADR-344 took them.
    expect(shareBase(day('2026-10-09', 40, 3, 1))).toBe(40);
    expect(failedShare(day('2026-10-09', 40, 3, 1))).toBe(0.025);
    // The failed share's scale reaches the share of those not cancelled: 1 of 5 is 20%, not 10%.
    expect(
      failedShareLayout([day('2026-10-09', 10, 0, 1, 4, 2, 5)], 720, 240).yTicks.at(-1)?.label,
    ).toBe('20%');
  });

  it('writes shares to a tenth of a percent, never as none or all when they are not', () => {
    expect(chartShare(0)).toBe('0%');
    expect(chartShare(0.025)).toBe('2.5%');
    expect(chartShare(0.03)).toBe('3%');
    expect(chartShare(1 / 3)).toBe('33.3%');
    expect(chartShare(0.0005)).toBe('0.1%');
    expect(chartShare(0.00049)).toBe('<0.1%');
    expect(chartShare(0.9994)).toBe('99.9%');
    expect(chartShare(0.9995)).toBe('>99.9%');
    expect(chartShare(1)).toBe('100%');
  });

  it('scales from 0% to the gridline at or above the largest share, broken where none was sent', () => {
    const layout = failedShareLayout(
      [
        day('2026-10-06', 40, 0, 1),
        day('2026-10-07', 10, 5, 0),
        day('2026-10-08', 0, 7),
        day('2026-10-09', 50, 2, 3),
      ],
      720,
      240,
    );
    // 6% at most: steps of 2%, valued in tenths of a percent.
    expect(layout.yTicks.map((t) => [t.value, t.label])).toEqual([
      [0, '0%'],
      [20, '2%'],
      [40, '4%'],
      [60, '6%'],
    ]);
    // Right of the y labels (2 characters), under 12 pixels of air, left of the end label.
    expect(layout.plot).toEqual({ left: 26, right: 660, top: 12, bottom: 212 });
    expect(layout.yTicks.map((t) => t.y)).toEqual([212, 145.33, 78.67, 12]);
    expect(layout.xs).toEqual([26, 237.33, 448.67, 660]);
    expect(layout.ys).toEqual([128.67, 212, null, 12]);
    // The line stops at the day that sent nothing and starts again after it, where one day alone
    // is drawn as a dot.
    expect(layout.path).toBe('M26 128.67 L237.33 212 M660 12');
    expect(layout.lone).toEqual([3]);
    expect(layout.end).toEqual({ x: 660, y: 12, share: 0.06 });
    expect(layout.endLabel).toBe(true);
    expect(layout.xTicks.map((t) => [t.index, t.label])).toEqual([
      [0, '6 Oct'],
      [1, '7 Oct'],
      [2, '8 Oct'],
      [3, '9 Oct'],
    ]);
  });

  it('keeps every share under the top gridline, whole steps of a tenth of a percent at least', () => {
    for (const [sent, failed, top, step] of [
      [3000, 1, 1, 1],
      [1000, 3, 3, 1],
      // Just past 0.2%: rounded up to 0.3%, so the day stays under the top.
      [1_000_000, 2001, 3, 1],
      [1000, 7, 8, 2],
      [3, 1, 400, 100],
      [1000, 45, 60, 20],
      [10, 9, 1000, 500],
      [1, 1, 1000, 500],
    ] as const) {
      const layout = failedShareLayout([day('2026-10-09', sent, 0, failed)], 720, 240);
      const values = layout.yTicks.map((t) => t.value);
      expect(values.at(-1), `${failed} of ${sent}`).toBe(top);
      expect(values[1], `${failed} of ${sent}`).toBe(step);
      expect(values.length, `${failed} of ${sent}`).toBeLessThanOrEqual(5);
      expect(layout.ys[0], `${failed} of ${sent}`).toBeGreaterThanOrEqual(layout.plot.top);
    }
    const tiny = failedShareLayout([day('2026-10-09', 3000, 0, 1)], 720, 240);
    expect(tiny.yTicks.map((t) => t.label)).toEqual(['0%', '0.1%']);
    // The labels' width decides the left edge: "0.1%" is 4 characters.
    expect(tiny.plot.left).toBe(40);
    expect(
      failedShareLayout([day('2026-10-09', 1, 0, 1)], 720, 240).yTicks.map((t) => t.label),
    ).toEqual(['0%', '50%', '100%']);
  });

  it('leaves the last share unwritten when the last day sent nothing, or the chart is narrow', () => {
    const none = failedShareLayout(
      [day('2026-10-08', 10, 0, 1), day('2026-10-09', 0, 4)],
      720,
      240,
    );
    expect(none.end).toBeNull();
    expect(none.endLabel).toBe(false);
    expect(none.plot.right).toBe(704);
    // The first day alone, between the chart's start and a day without sends.
    expect(none.lone).toEqual([0]);
    const narrow = failedShareLayout([day('2026-10-09', 10, 0, 1)], 479, 240);
    expect(narrow.endLabel).toBe(false);
    expect(narrow.plot.right).toBe(463);
    expect(failedShareLayout([day('2026-10-09', 10, 0, 1)], 480, 240).endLabel).toBe(true);
  });

  it('names the same days as the messages chart, and draws no line without sends or days', () => {
    const month = Array.from({ length: 31 }, (_, i) =>
      day(`2026-10-${String(i + 1).padStart(2, '0')}`, i, 2 * i, i % 3 === 0 ? 0 : 1),
    );
    expect(failedShareLayout(month, 720, 240).xTicks.map((t) => t.index)).toEqual([
      0, 6, 12, 18, 24, 30,
    ]);
    // The first day sent nothing: the line starts at the second.
    expect(failedShareLayout(month, 720, 240).path).toMatch(/^M\S+ \S+ L/);
    const quiet = failedShareLayout([day('2026-10-08', 0, 3), day('2026-10-09', 0, 1)], 720, 240);
    expect(quiet.path).toBe('');
    expect(quiet.ys).toEqual([null, null]);
    expect(quiet.lone).toEqual([]);
    expect(quiet.end).toBeNull();
    expect(quiet.yTicks.map((t) => t.label)).toEqual(['0%', '0.1%']);
    const empty = failedShareLayout([], 720, 240);
    expect(empty.xs).toEqual([]);
    expect(empty.path).toBe('');
    expect(empty.end).toBeNull();
    expect(empty.endLabel).toBe(false);
  });

  it('shares the plot’s edges with the messages chart above it, so each day sits under its own', () => {
    const days = [
      day('2026-10-07', 10, 4, 1),
      day('2026-10-08', 30, 12),
      day('2026-10-09', 25, 8, 2),
    ];
    // Alone, the messages chart's labels take 26 pixels and its end labels 120; the shares' labels
    // ("10%") take 33 and their end label 60; the deliveries' ("100%", ADR-346) take 40.
    expect(dailyChartLayout(days, 720, 240).plot).toMatchObject({ left: 26, right: 600 });
    expect(failedShareLayout(days, 720, 240).plot).toMatchObject({ left: 33, right: 660 });
    expect(deliveryShareLayout(days, 720, 240).plot).toMatchObject({ left: 40, right: 704 });
    const edges = sharedPlotEdges(days, 720, 240);
    expect(edges).toEqual({ left: 40, right: 600 });
    const messages = dailyChartLayout(days, 720, 240, edges);
    const shares = failedShareLayout(days, 720, 240, edges);
    const deliveries = deliveryShareLayout(days, 720, 240, edges);
    expect(messages.plot).toMatchObject(edges);
    expect(shares.plot).toMatchObject(edges);
    expect(deliveries.plot).toMatchObject(edges);
    expect(shares.xs).toEqual(messages.xs);
    expect(deliveries.xs).toEqual(messages.xs);
    expect(shares.xTicks).toEqual(messages.xTicks);
    expect(deliveries.xTicks).toEqual(messages.xTicks);
    expect(messages.xs).toEqual([40, 320, 600]);
    // The scales stay each chart's own.
    expect(messages.yTicks.map((t) => t.label)).toEqual(['0', '10', '20', '30']);
    expect(shares.yTicks.map((t) => t.label)).toEqual(['0%', '5%', '10%']);
    // Where the messages' ends nearly meet, they write no end labels, but the share still does:
    // the messages chart keeps the share's room on the right.
    const close = [day('2026-10-08', 10, 2, 1), day('2026-10-09', 20, 19, 1)];
    expect(dailyChartLayout(close, 720, 240).plot.right).toBe(704);
    const closeEdges = sharedPlotEdges(close, 720, 240);
    expect(closeEdges.right).toBe(660);
    expect(dailyChartLayout(close, 720, 240, closeEdges).plot.right).toBe(660);
  });
});

describe('the sends delivered and read a day chart (ADR-346)', () => {
  it('gives a day’s sends delivered and read as shares of those sent, none without sends or counts', () => {
    const counted = day('2026-10-09', 8, 0, 1, 6, 4);
    expect(deliveredShare(counted)).toBe(0.75);
    expect(readShare(counted)).toBe(0.5);
    // Nothing sent: no share, though messages were received.
    expect(deliveredShare(day('2026-10-09', 0, 5, 0, 0, 0))).toBeNull();
    expect(readShare(day('2026-10-09', 0, 5, 0, 0, 0))).toBeNull();
    // A kept day counted before its deliveries were: no share until it is counted again.
    expect(deliveredShare(day('2026-10-09', 8, 0))).toBeNull();
    expect(readShare(day('2026-10-09', 8, 0))).toBeNull();
    expect(DELIVERY_CHART_SERIES.map((s) => [s.key, s.label])).toEqual([
      ['delivered', 'Delivered'],
      ['read', 'Read'],
    ]);
  });

  it('draws both shares from 0% to 100%, broken at days without one, lone days as dots', () => {
    const days = [
      day('2026-10-04', 4, 0, 0, 4, 2),
      day('2026-10-05', 10, 1, 1, 9, 5),
      // Nothing sent, then a day counted before its deliveries were.
      day('2026-10-06', 0, 3),
      day('2026-10-07', 8, 0, 2, 6, 2),
      day('2026-10-08', 8, 2),
      day('2026-10-09', 5, 0, 0, 4, 1),
    ];
    const layout = deliveryShareLayout(days, 720, 240);
    expect(layout.yTicks).toEqual([
      { value: 0, y: 212, label: '0%' },
      { value: 25, y: 162, label: '25%' },
      { value: 50, y: 112, label: '50%' },
      { value: 75, y: 62, label: '75%' },
      { value: 100, y: 12, label: '100%' },
    ]);
    // The last day's shares are written at the lines' ends, with the room they take on the right.
    expect(layout.endLabels).toBe(true);
    expect(layout.plot).toEqual({ left: 40, right: 600, top: 12, bottom: 212 });
    expect(layout.xs).toEqual([40, 152, 264, 376, 488, 600]);
    expect(layout.xTicks).toEqual(
      dailyChartLayout(days, 720, 240, { left: 40, right: 600 }).xTicks,
    );
    expect(layout.series).toEqual([
      {
        key: 'delivered',
        label: 'Delivered',
        path: 'M40 12 L152 32 M376 62 M600 52',
        ys: [12, 32, null, 62, null, 52],
        lone: [3, 5],
        end: { x: 600, y: 52, share: 0.8 },
      },
      {
        key: 'read',
        label: 'Read',
        path: 'M40 112 L152 112 M376 162 M600 172',
        ys: [112, 112, null, 162, null, 172],
        lone: [3, 5],
        end: { x: 600, y: 172, share: 0.2 },
      },
    ]);
  });

  it('writes no end labels where the ends nearly meet, the chart is narrow or the last day has no share', () => {
    const close = [day('2026-10-08', 4, 0, 0, 4, 4), day('2026-10-09', 20, 0, 0, 10, 9)];
    // 50% and 45%: 10 pixels apart.
    expect(deliveryShareLayout(close, 720, 240).endLabels).toBe(false);
    expect(deliveryShareLayout(close, 720, 240).plot.right).toBe(704);
    const apart = [day('2026-10-08', 4, 0, 0, 4, 4), day('2026-10-09', 20, 0, 0, 20, 5)];
    expect(deliveryShareLayout(apart, 720, 240).endLabels).toBe(true);
    expect(deliveryShareLayout(apart, 479, 240).endLabels).toBe(false);
    expect(deliveryShareLayout(apart, 480, 240).endLabels).toBe(true);
    const lastWithout = [day('2026-10-08', 4, 0, 0, 4, 1), day('2026-10-09', 0, 2)];
    const without = deliveryShareLayout(lastWithout, 720, 240);
    expect(without.endLabels).toBe(false);
    expect(without.series.map((s) => s.end)).toEqual([null, null]);
    expect(without.series.map((s) => s.lone)).toEqual([[0], [0]]);
    const empty = deliveryShareLayout([], 720, 240);
    expect(empty.series.map((s) => [s.path, s.end])).toEqual([
      ['', null],
      ['', null],
    ]);
    expect(empty.endLabels).toBe(false);
  });
});
