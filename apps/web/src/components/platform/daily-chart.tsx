'use client';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  DAILY_CHART_SERIES,
  chartCount,
  chartDayLabel,
  dailyChartLayout,
  nearestDayIndex,
  type DailyChartDay,
  type DailyChartSeriesKey,
} from '@w360/domain/ops-chart';

const HEIGHT = 240;
/** The tooltip's width until the browser measures it. */
const TIP = 168;
/** The series' colours (globals.css): they follow the series, never their order in the data. */
const COLOR: Record<DailyChartSeriesKey, string> = {
  outbound: 'var(--chart-1)',
  inbound: 'var(--chart-2)',
};

/** A short stroke of a series' colour: how the legend and the tooltip name a line. */
function LineKey({ color }: { color: string }) {
  return (
    <svg width="16" height="8" aria-hidden="true" className="shrink-0">
      <line x1="1" y1="4" x2="15" y2="4" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const describe = (d: DailyChartDay) =>
  `${chartDayLabel(d.day)}: ${chartCount(d.outbound)} sent, ${chartCount(d.inbound)} received, ${chartCount(d.failed)} failed`;

/**
 * The platform's messages sent and received each UTC day of the window (ADR-333): two lines on one
 * axis with a legend, the last day's values at the lines' ends when they fit, and a crosshair whose
 * tooltip gives the day's sent, received and failed messages, on hover or on the arrow keys, Home
 * and End once the chart has focus. To assistive technology the chart is a slider over the days,
 * its value the chosen day's numbers (the last day's until another is chosen). The table beside it
 * gives every number without the chart.
 */
export function DailyMessagesChart({ days, label }: { days: DailyChartDay[]; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  // Drawn at 720 pixels on the server and until the browser measures the room it has, and never
  // narrower than 280: a narrower box shows the drawing scaled to fit.
  const [size, setSize] = useState({ box: 720, drawn: 720 });
  const [tipWidth, setTipWidth] = useState(TIP);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const measured = Math.floor(entry.contentRect.width);
      setSize({ box: measured, drawn: Math.max(280, measured) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = dailyChartLayout(days, size.drawn, HEIGHT);
  const last = days.length - 1;
  const shownIndex = active !== null && active <= last ? active : null;
  const shown = shownIndex === null ? undefined : days[shownIndex];
  const shownX = shownIndex === null ? 0 : (layout.xs[shownIndex] ?? 0);
  const current = shownIndex ?? last;
  const currentDay = days[current];
  // The tooltip's own width keeps it inside the box, however long its numbers: measured again for
  // each day it shows and each width of the box.
  useLayoutEffect(() => {
    const measured = tip.current?.offsetWidth;
    if (measured !== undefined) setTipWidth(measured);
  }, [shownIndex, size.box]);
  // Beside the crosshair, in the box's pixels, as near as the box's edges allow.
  const tipX = (shownX * size.box) / layout.width;
  const tipRoom = Math.max(0, size.box - tipWidth);
  const tipPlace =
    tipX > size.box / 2
      ? { right: Math.min(Math.max(0, size.box - tipX + 12), tipRoom) }
      : { left: Math.min(tipX + 12, tipRoom) };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * layout.width;
    setActive(nearestDayIndex(layout.xs, x));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      setActive(null);
      return;
    }
    const next =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? Math.max(0, current - 1)
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? Math.min(last, current + 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null || last < 0) return;
    event.preventDefault();
    setActive(next);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ul aria-label="Lines" className="flex flex-wrap items-center gap-4 text-sm">
        {DAILY_CHART_SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <LineKey color={COLOR[s.key]} />
            {s.label}
          </li>
        ))}
      </ul>
      <div
        ref={box}
        role="slider"
        aria-label={label}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.max(last, 0)}
        aria-valuenow={Math.max(current, 0)}
        aria-valuetext={currentDay ? describe(currentDay) : 'No days'}
        tabIndex={0}
        className="relative w-full overflow-hidden rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onFocus={() => setActive((chosen) => chosen ?? (last >= 0 ? last : null))}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
      >
        <svg
          width={layout.width}
          height={HEIGHT}
          viewBox={`0 0 ${layout.width} ${HEIGHT}`}
          aria-hidden="true"
          className="block max-w-full touch-pan-y"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
        >
          {layout.yTicks.map((tick) => (
            <g key={tick.value}>
              <line
                x1={layout.plot.left}
                x2={layout.plot.right}
                y1={tick.y}
                y2={tick.y}
                stroke="var(--border)"
                strokeWidth="1"
              />
              <text
                x={layout.plot.left - 8}
                y={tick.y}
                textAnchor="end"
                dominantBaseline="middle"
                fill="var(--muted-foreground)"
                className="text-xs tabular-nums"
              >
                {tick.label}
              </text>
            </g>
          ))}
          {layout.xTicks.map((tick) => (
            <text
              key={tick.index}
              x={tick.x}
              y={layout.plot.bottom + 18}
              textAnchor={
                tick.index === 0 && layout.xTicks.length > 1
                  ? 'start'
                  : tick.index === last && layout.xTicks.length > 1
                    ? 'end'
                    : 'middle'
              }
              fill="var(--muted-foreground)"
              className="text-xs"
            >
              {tick.label}
            </text>
          ))}
          {shown ? (
            <line
              x1={shownX}
              x2={shownX}
              y1={layout.plot.top}
              y2={layout.plot.bottom}
              stroke="var(--muted-foreground)"
              strokeWidth="1"
            />
          ) : null}
          {layout.series.map((s) => (
            <path
              key={s.key}
              d={s.path}
              fill="none"
              stroke={COLOR[s.key]}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {last >= 0
            ? layout.series.map((s) => (
                <circle
                  key={s.key}
                  cx={shown ? shownX : s.end.x}
                  cy={shownIndex === null ? s.end.y : (s.ys[shownIndex] ?? s.end.y)}
                  r="4"
                  fill={COLOR[s.key]}
                  stroke="var(--card)"
                  strokeWidth="2"
                />
              ))
            : null}
          {layout.endLabels
            ? layout.series.map((s) => (
                <text
                  key={s.key}
                  x={s.end.x + 10}
                  y={s.end.y}
                  dominantBaseline="middle"
                  fill="var(--foreground)"
                  className="text-xs"
                >
                  {s.label} {chartCount(s.end.value)}
                </text>
              ))
            : null}
        </svg>
        {shown ? (
          <div
            ref={tip}
            aria-hidden="true"
            className="pointer-events-none absolute top-2 z-10 grid w-max min-w-36 max-w-full gap-1 rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-sm"
            style={tipPlace}
          >
            <span className="text-xs text-muted-foreground">{chartDayLabel(shown.day)} (UTC)</span>
            {DAILY_CHART_SERIES.map((s) => (
              <span key={s.key} className="flex items-center gap-2">
                <LineKey color={COLOR[s.key]} />
                <strong className="tabular-nums">{chartCount(shown[s.key])}</strong>
                <span className="text-muted-foreground">{s.label.toLowerCase()}</span>
              </span>
            ))}
            <span className="flex items-center gap-2">
              <span className="w-4 shrink-0" />
              <strong className="tabular-nums">{chartCount(shown.failed)}</strong>
              <span className="text-muted-foreground">failed</span>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
