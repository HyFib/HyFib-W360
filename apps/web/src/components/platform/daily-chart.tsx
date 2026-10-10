'use client';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  DAILY_CHART_SERIES,
  DELIVERY_CHART_SERIES,
  chartCount,
  chartDayLabel,
  chartShare,
  dailyChartLayout,
  deliveryShareLayout,
  failedShare,
  failedShareLayout,
  nearestDayIndex,
  shareBase,
  sharedPlotEdges,
  type DailyChartDay,
  type DailyChartLayout,
  type DailyChartSeriesKey,
  type DeliveryChartSeriesKey,
} from '@w360/domain/ops-chart';

const HEIGHT = 240;
/** The tooltip's width until the browser measures it. */
const TIP = 168;
/** The series' colours (globals.css): they follow the series, never their order in the data. */
const COLOR: Record<DailyChartSeriesKey, string> = {
  outbound: 'var(--chart-1)',
  inbound: 'var(--chart-2)',
};
/** The failed sends' share (ADR-344): a measure of its own, so a colour of its own. */
const FAILED_COLOR = 'var(--chart-3)';
/**
 * The shares delivered and read (ADR-346): measures of their own, so colours of their own, and the
 * read line dashed, so the two lines differ without their colours.
 */
const DELIVERY_STYLE: Record<DeliveryChartSeriesKey, { color: string; dash?: string }> = {
  delivered: { color: 'var(--chart-4)' },
  read: { color: 'var(--chart-5)', dash: '6 4' },
};

/** A short stroke of a series' colour: how the legend and the tooltip name a line. */
function LineKey({ color, dash }: { color: string; dash?: string }) {
  return (
    <svg width="16" height="8" aria-hidden="true" className="shrink-0">
      <line
        x1="1"
        y1="4"
        x2="15"
        y2="4"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={dash}
      />
    </svg>
  );
}

/**
 * The tooltip beside the crosshair at `x` (in the drawing's pixels), kept inside the box however
 * long its lines: its own width is measured again for each day it shows and each width of the box.
 */
function ChartTip({
  shownIndex,
  boxWidth,
  x,
  drawnWidth,
  children,
}: {
  shownIndex: number;
  boxWidth: number;
  x: number;
  drawnWidth: number;
  children: ReactNode;
}) {
  const tip = useRef<HTMLDivElement>(null);
  const [tipWidth, setTipWidth] = useState(TIP);
  useLayoutEffect(() => {
    const measured = tip.current?.offsetWidth;
    if (measured !== undefined) setTipWidth(measured);
  }, [shownIndex, boxWidth]);
  // Beside the crosshair, in the box's pixels, as near as the box's edges allow.
  const tipX = (x * boxWidth) / drawnWidth;
  const tipRoom = Math.max(0, boxWidth - tipWidth);
  const place =
    tipX > boxWidth / 2
      ? { right: Math.min(Math.max(0, boxWidth - tipX + 12), tipRoom) }
      : { left: Math.min(tipX + 12, tipRoom) };
  return (
    <div
      ref={tip}
      aria-hidden="true"
      className="pointer-events-none absolute top-2 z-10 grid w-max min-w-36 max-w-full gap-1 rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-sm"
      style={place}
    >
      {children}
    </div>
  );
}

/** What a chart draws for the frame at the width it has, with the day chosen or none. */
interface DayChartDrawing {
  layout: Pick<DailyChartLayout, 'width' | 'plot' | 'yTicks' | 'xTicks' | 'xs'>;
  /** The slider's value: the chosen day's numbers, or the last day's until another is chosen. */
  valueText: string;
  marks: ReactNode;
  /** The chosen day's tooltip, or null when no day is chosen. */
  tip: ReactNode;
}

/**
 * The frame both charts share: drawn at 720 pixels on the server and until the browser measures
 * the room it has, and never narrower than 280 (a narrower box shows the drawing scaled to fit); a
 * slider over the days to assistive technology; the gridlines, the days named under the axis and
 * the crosshair, which follows the pointer or the arrow keys, Home and End once the chart has focus
 * (Escape puts it away); and the tooltip of the chosen day. `draw` gives the chart's layout, marks
 * and tooltip for a width and a chosen day (`shownIndex`, null for none; `current` is the day the
 * slider names, the last until another is chosen).
 */
function DayChartFrame({
  count,
  label,
  draw,
}: {
  count: number;
  label: string;
  draw: (drawn: number, shownIndex: number | null, current: number) => DayChartDrawing;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ box: 720, drawn: 720 });
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
  const last = count - 1;
  const shownIndex = active !== null && active <= last ? active : null;
  const current = shownIndex ?? last;
  const { layout, valueText, marks, tip } = draw(size.drawn, shownIndex, current);
  const shownX = shownIndex === null ? null : (layout.xs[shownIndex] ?? null);
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
    <div
      ref={box}
      role="slider"
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.max(last, 0)}
      aria-valuenow={Math.max(current, 0)}
      aria-valuetext={valueText}
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
        {shownX !== null ? (
          <line
            x1={shownX}
            x2={shownX}
            y1={layout.plot.top}
            y2={layout.plot.bottom}
            stroke="var(--muted-foreground)"
            strokeWidth="1"
          />
        ) : null}
        {marks}
      </svg>
      {shownIndex !== null && shownX !== null && tip !== null ? (
        <ChartTip shownIndex={shownIndex} boxWidth={size.box} x={shownX} drawnWidth={layout.width}>
          {tip}
        </ChartTip>
      ) : null}
    </div>
  );
}

const describe = (d: DailyChartDay) =>
  `${chartDayLabel(d.day)}: ${chartCount(d.outbound)} sent, ${chartCount(d.inbound)} received, ${chartCount(d.failed)} failed`;

/**
 * The platform's messages sent and received each UTC day of the window (ADR-333): two lines on one
 * axis with a legend, the last day's values at the lines' ends when they fit, and a crosshair whose
 * tooltip gives the day's sent, received and failed messages. The table beside it gives every
 * number without the chart.
 */
export function DailyMessagesChart({
  days,
  label,
  legendLabel = 'Lines',
  aligned = false,
}: {
  days: DailyChartDay[];
  label: string;
  /** The legend's accessible name, told apart when a page draws two charts. */
  legendLabel?: string;
  /** Drawn above the failed sends' chart, on the plot's edges both share (ADR-344). */
  aligned?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ul aria-label={legendLabel} className="flex flex-wrap items-center gap-4 text-sm">
        {DAILY_CHART_SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <LineKey color={COLOR[s.key]} />
            {s.label}
          </li>
        ))}
      </ul>
      <DayChartFrame
        count={days.length}
        label={label}
        draw={(drawn, shownIndex, current) => {
          const layout = dailyChartLayout(
            days,
            drawn,
            HEIGHT,
            aligned ? sharedPlotEdges(days, drawn, HEIGHT) : undefined,
          );
          const shown = shownIndex === null ? undefined : days[shownIndex];
          const shownX = shownIndex === null ? 0 : (layout.xs[shownIndex] ?? 0);
          const currentDay = days[current];
          return {
            layout,
            valueText: currentDay ? describe(currentDay) : 'No days',
            marks: (
              <>
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
                {days.length > 0
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
              </>
            ),
            tip: shown ? (
              <>
                <span className="text-xs text-muted-foreground">
                  {chartDayLabel(shown.day)} (UTC)
                </span>
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
              </>
            ) : null,
          };
        }}
      />
    </div>
  );
}

// Of the sends not cancelled before they left (`shareBase`, ADR-346), as the shares are.
const describeShare = (d: DailyChartDay) => {
  const share = failedShare(d);
  return share === null
    ? `${chartDayLabel(d.day)}: none sent`
    : `${chartDayLabel(d.day)}: ${chartShare(share)} of ${chartCount(shareBase(d))} sent failed (${chartCount(d.failed)})`;
};

/**
 * The share of the messages sent each UTC day that failed (ADR-344), under the messages chart: one
 * line on an axis of percentages, where the failed sends do not lie flat beside thousands sent; a
 * gap on a day that sent nothing, and a dot for a day alone between such days; the last day's share
 * at the line's end when it fits; and a crosshair whose tooltip gives the day's share, failed and
 * sent. One measure needs no legend: the caption above names it, and the table gives every share.
 */
export function DailyFailedShareChart({ days, label }: { days: DailyChartDay[]; label: string }) {
  return (
    <DayChartFrame
      count={days.length}
      label={label}
      draw={(drawn, shownIndex, current) => {
        // On the plot's edges the messages chart above shares, so each day sits under its own.
        const layout = failedShareLayout(days, drawn, HEIGHT, sharedPlotEdges(days, drawn, HEIGHT));
        const shown = shownIndex === null ? undefined : days[shownIndex];
        const shownShare = shown ? failedShare(shown) : null;
        const shownY = shownIndex === null ? null : (layout.ys[shownIndex] ?? null);
        // The dot rides the crosshair, on a day with a share; without a chosen day, the line's end.
        const dot =
          shownIndex === null
            ? layout.end
            : shownY === null
              ? null
              : { x: layout.xs[shownIndex] ?? 0, y: shownY };
        const currentDay = days[current];
        return {
          layout,
          valueText: currentDay ? describeShare(currentDay) : 'No days',
          marks: (
            <>
              <path
                d={layout.path}
                fill="none"
                stroke={FAILED_COLOR}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {layout.lone.map((index) => (
                <circle
                  key={index}
                  cx={layout.xs[index]}
                  cy={layout.ys[index] ?? undefined}
                  r="3"
                  fill={FAILED_COLOR}
                />
              ))}
              {dot ? (
                <circle
                  cx={dot.x}
                  cy={dot.y}
                  r="4"
                  fill={FAILED_COLOR}
                  stroke="var(--card)"
                  strokeWidth="2"
                />
              ) : null}
              {layout.endLabel && layout.end ? (
                <text
                  x={layout.end.x + 10}
                  y={layout.end.y}
                  dominantBaseline="middle"
                  fill="var(--foreground)"
                  className="text-xs tabular-nums"
                >
                  {chartShare(layout.end.share)}
                </text>
              ) : null}
            </>
          ),
          tip: shown ? (
            <>
              <span className="text-xs text-muted-foreground">
                {chartDayLabel(shown.day)} (UTC)
              </span>
              {shownShare === null ? (
                <span className="text-muted-foreground">No message sent</span>
              ) : (
                <>
                  <span className="flex items-center gap-2">
                    <LineKey color={FAILED_COLOR} />
                    <strong className="tabular-nums">{chartShare(shownShare)}</strong>
                    <span className="text-muted-foreground">failed</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="w-4 shrink-0" />
                    <span className="tabular-nums">
                      <strong>{chartCount(shown.failed)}</strong>
                      <span className="text-muted-foreground"> of </span>
                      <strong>{chartCount(shareBase(shown))}</strong>
                    </span>
                    <span className="text-muted-foreground">sent</span>
                  </span>
                </>
              )}
            </>
          ) : null,
        };
      }}
    />
  );
}

const describeDelivery = (d: DailyChartDay) => {
  const base = shareBase(d);
  if (base <= 0) return `${chartDayLabel(d.day)}: none sent`;
  if (d.delivered === null || d.read === null) {
    return `${chartDayLabel(d.day)}: deliveries not counted yet`;
  }
  return `${chartDayLabel(d.day)}: ${chartShare(d.delivered / base)} of ${chartCount(base)} sent delivered (${chartCount(d.delivered)}), ${chartShare(d.read / base)} read (${chartCount(d.read)})`;
};

/**
 * The shares of the messages sent each UTC day that were delivered and read (ADR-346), under the
 * failed sends' chart: two lines on an axis of percentages with a legend, the read one dashed; a
 * gap on a day that sent nothing or whose deliveries are not counted yet, and a dot for a day alone
 * between such days; the last day's shares at the lines' ends when they fit; and a crosshair whose
 * tooltip gives the day's shares and counts. The table gives every share.
 */
export function DailyDeliveryShareChart({
  days,
  label,
  legendLabel,
}: {
  days: DailyChartDay[];
  label: string;
  /** The legend's accessible name, told apart when a page draws two of these charts. */
  legendLabel: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ul aria-label={legendLabel} className="flex flex-wrap items-center gap-4 text-sm">
        {DELIVERY_CHART_SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <LineKey color={DELIVERY_STYLE[s.key].color} dash={DELIVERY_STYLE[s.key].dash} />
            {s.label}
          </li>
        ))}
      </ul>
      <DayChartFrame
        count={days.length}
        label={label}
        draw={(drawn, shownIndex, current) => {
          // On the plot's edges the charts above share, so each day sits under its own.
          const layout = deliveryShareLayout(
            days,
            drawn,
            HEIGHT,
            sharedPlotEdges(days, drawn, HEIGHT),
          );
          const shown = shownIndex === null ? undefined : days[shownIndex];
          const currentDay = days[current];
          return {
            layout,
            valueText: currentDay ? describeDelivery(currentDay) : 'No days',
            marks: (
              <>
                {layout.series.map((s) => (
                  <path
                    key={s.key}
                    d={s.path}
                    fill="none"
                    stroke={DELIVERY_STYLE[s.key].color}
                    strokeDasharray={DELIVERY_STYLE[s.key].dash}
                    strokeWidth="2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))}
                {layout.series.flatMap((s) =>
                  s.lone.map((index) => (
                    <circle
                      key={`${s.key}-${index}`}
                      cx={layout.xs[index]}
                      cy={s.ys[index] ?? undefined}
                      r="3"
                      fill={DELIVERY_STYLE[s.key].color}
                    />
                  )),
                )}
                {layout.series.map((s) => {
                  // The dot rides the crosshair, on a day with a share; without a chosen day, the
                  // line's end.
                  const shownY = shownIndex === null ? null : (s.ys[shownIndex] ?? null);
                  const dot =
                    shownIndex === null
                      ? s.end
                      : shownY === null
                        ? null
                        : { x: layout.xs[shownIndex] ?? 0, y: shownY };
                  return dot ? (
                    <circle
                      key={s.key}
                      cx={dot.x}
                      cy={dot.y}
                      r="4"
                      fill={DELIVERY_STYLE[s.key].color}
                      stroke="var(--card)"
                      strokeWidth="2"
                    />
                  ) : null;
                })}
                {layout.endLabels
                  ? layout.series.map((s) =>
                      s.end ? (
                        <text
                          key={s.key}
                          x={s.end.x + 10}
                          y={s.end.y}
                          dominantBaseline="middle"
                          fill="var(--foreground)"
                          className="text-xs tabular-nums"
                        >
                          {s.label} {chartShare(s.end.share)}
                        </text>
                      ) : null,
                    )
                  : null}
              </>
            ),
            tip: shown ? (
              <>
                <span className="text-xs text-muted-foreground">
                  {chartDayLabel(shown.day)} (UTC)
                </span>
                {shareBase(shown) <= 0 ? (
                  <span className="text-muted-foreground">No message sent</span>
                ) : shown.delivered === null || shown.read === null ? (
                  <span className="text-muted-foreground">Deliveries not counted yet</span>
                ) : (
                  <>
                    {DELIVERY_CHART_SERIES.map((s) => {
                      const share = s.share(shown);
                      return (
                        <span key={s.key} className="flex items-center gap-2">
                          <LineKey
                            color={DELIVERY_STYLE[s.key].color}
                            dash={DELIVERY_STYLE[s.key].dash}
                          />
                          <strong className="tabular-nums">
                            {share === null ? '' : chartShare(share)}
                          </strong>
                          <span className="text-muted-foreground">
                            {s.label.toLowerCase()} ({chartCount(shown[s.key] ?? 0)})
                          </span>
                        </span>
                      );
                    })}
                    <span className="flex items-center gap-2">
                      <span className="w-4 shrink-0" />
                      <strong className="tabular-nums">{chartCount(shareBase(shown))}</strong>
                      <span className="text-muted-foreground">sent</span>
                    </span>
                  </>
                )}
              </>
            ) : null,
          };
        }}
      />
    </div>
  );
}
