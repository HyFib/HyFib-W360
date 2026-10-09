import { describe, expect, it } from 'vitest';
import {
  DAILY_CHART_SERIES,
  chartCount,
  chartDayLabel,
  chartStep,
  dailyChartLayout,
  nearestDayIndex,
  type DailyChartDay,
} from './ops-chart';

const day = (date: string, outbound: number, inbound: number, failed = 0): DailyChartDay => ({
  day: date,
  outbound,
  failed,
  inbound,
});

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

  it('steps gridlines by 1, 2 or 5 times a power of ten, at most five above 0', () => {
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
      // The busiest day sits under the top gridline, at most five steps above 0.
      expect(Math.ceil(max / step), String(max)).toBeLessThanOrEqual(5);
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
