import {
  BaselineSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, LineStyle, TickMarkType,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { Radio } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { changeBps, money, pct, tone, when } from '../lib/format';
import { game, useGame, type EventInfo, type Range } from '../lib/game';
import { availableRanges, defaultRange, fold, fromHistory, RANGE_LABEL, toLine, type Series } from '../lib/series';
import { useKept } from './chrome';

const C = {
  up: '#3ddc84',
  down: '#ff5c62',
  ink2: '#bdb6a6',
  ink3: '#8f897b',
  rule: '#2e2846',
  grid: '#1a1630',
  saffron: '#ffb020',
};

/** History per company and range, kept across mounts: reopening a chart shows it at once. */
const cache = new Map<string, Series>();
const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
const axisTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const axisDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** Whether a story bears on this company: about it, about its sector, or about the whole economy. */
export function concerns(ev: EventInfo, ticker: string, sector: string) {
  return ev.related.includes(ticker) || ev.target === ticker || ev.target === sector || ev.category === 'macro';
}

/** What a chart follows: one company, or an equal-weighted index of many. */
export interface ChartSubject {
  /** Cache key, unique per subject. */
  key: string;
  label: string;
  url: (range: Range) => string;
  /** The subject's value in one tick's prices, given the loaded history. */
  value: (p: number[], s: Series) => number | undefined;
  /** Where the baseline splits green from red: the value at the opening bell. */
  baseline: (s: Series | null) => number | undefined;
  format: (v: number) => string;
  /** Stories marked on the timeline. */
  concerns: (ev: EventInfo) => boolean;
}

interface Hover {
  x: number;
  y: number;
  at: number;
  price: number;
  from: number;
  note: string | null;
}

/** One company's simulated price. */
export function PriceChart({ ticker, wheel = true }: { ticker: string; wheel?: boolean }) {
  const index = useGame((s) => s.index.get(ticker) ?? -1);
  const asset = useGame((s) => s.assets[index]);
  const open = useGame((s) => s.open[index]);
  const subject = useMemo<ChartSubject>(() => ({
    key: ticker,
    label: `Simulated price chart for ${asset?.name ?? ticker}`,
    url: (range) => `/api/prices/${ticker}?range=${range}`,
    value: (p) => (index >= 0 ? p[index] : undefined),
    baseline: () => open,
    format: money,
    concerns: (ev) => !!asset && concerns(ev, ticker, asset.sector),
  }), [ticker, index, asset, open]);
  return <TimelineChart subject={subject} wheel={wheel} />;
}

/**
 * The full timeline for one subject: stored history for the chosen range, extended (never replaced)
 * by live ticks. A player who pans into the past keeps their view while the market moves on; a
 * marker says newer prices are waiting and Back to live returns to them.
 */
export function TimelineChart({ subject, wheel = true }: { subject: ChartSubject; wheel?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const line = useRef<ISeriesApi<'Baseline'> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const events = useGame((s) => s.events);
  const session = useGame((s) => s.session);
  const competitionMs = (session?.totalTicks ?? 600) * (session?.tickMs ?? 1000);
  const [range, setRange] = useKept<Range>('chart.range', () => defaultRange(competitionMs));
  const key = `${subject.key}:${range}`;
  const format = useRef(subject.format);
  format.current = subject.format;
  const [series, setSeries] = useState<Series | null>(() => cache.get(key) ?? null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(cache.has(key) ? 'ready' : 'loading');
  const [away, setAway] = useState(false);
  const [newer, setNewer] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const awayRef = useRef(false);
  const seriesRef = useRef<Series | null>(null);
  seriesRef.current = series;

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: C.ink3, fontFamily: 'Archivo Variable, sans-serif', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.rule, scaleMargins: { top: 0.14, bottom: 0.1 } },
      timeScale: {
        borderColor: C.rule, timeVisible: true, secondsVisible: false, rightOffset: 4, shiftVisibleRangeOnNewBar: true,
        // Axis labels in the player's own time zone, like the crosshair (the library defaults to UTC).
        tickMarkFormatter: (t: Time, type: TickMarkType) => (type < TickMarkType.Time ? axisDay : axisTime).format((t as number) * 1000),
      },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: C.ink3, labelBackgroundColor: '#241f3d' }, horzLine: { color: C.ink3, labelBackgroundColor: '#241f3d' } },
      // Pan and pinch-zoom horizontally; a vertical swipe still scrolls the page on a phone.
      // In a page that scrolls (wheel = false) the wheel scrolls the page; drag, pinch and the axes still zoom and pan.
      handleScroll: { mouseWheel: wheel, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: wheel, pinch: true, axisPressedMouseMove: true },
      localization: {
        priceFormatter: (v: number) => format.current(v),
        timeFormatter: (t: Time) => when((t as number) * 1000),
      },
    });
    line.current = c.addSeries(BaselineSeries, {
      lineWidth: 2,
      topLineColor: C.up,
      topFillColor1: 'rgba(61, 220, 132, 0.22)',
      topFillColor2: 'rgba(61, 220, 132, 0.02)',
      bottomLineColor: C.down,
      bottomFillColor1: 'rgba(255, 92, 98, 0.02)',
      bottomFillColor2: 'rgba(255, 92, 98, 0.22)',
      priceLineColor: C.saffron,
      priceLineStyle: LineStyle.Dotted,
      priceFormat: { type: 'custom', formatter: (v: number) => format.current(v), minMove: 1 },
    });
    markers.current = createSeriesMarkers(line.current, []);
    chart.current = c;

    const ts = c.timeScale();
    const onRange = () => {
      // Scrolled more than a couple of bars into the past: the player is reading history.
      const isAway = ts.scrollPosition() < -2;
      awayRef.current = isAway;
      setAway(isAway);
      if (!isAway) setNewer(false);
    };
    ts.subscribeVisibleLogicalRangeChange(onRange);
    c.subscribeCrosshairMove((p) => {
      const s = seriesRef.current;
      const d = p.seriesData.get(line.current!) as { value?: number } | undefined;
      if (!p.point || p.time === undefined || !d?.value || !s?.bars.length) return setHover(null);
      const at = (p.time as number) * 1000;
      const note = noteAt(at, s.bucketMs);
      setHover({ x: p.point.x, y: p.point.y, at, price: d.value, from: s.bars[0]!.o, note });
    });
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(onRange);
      c.remove();
      chart.current = null;
      line.current = null;
    };
  }, []);

  // Stories and bells marked on the chart, looked up again for the tooltip.
  const marks = useMemo(() => {
    const out: { at: number; text: string; kind: 'news' | 'bell' }[] = [];
    for (const ev of events) if (subject.concerns(ev)) out.push({ at: ev.at, text: ev.headline, kind: 'news' });
    for (const s of series?.sessions ?? []) out.push({ at: s.opensAt, text: 'Opening bell', kind: 'bell' });
    return out.sort((a, b) => a.at - b.at);
  }, [events, series?.sessions, subject]);
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const noteAt = (at: number, bucket: number) => marksRef.current.find((m) => m.at >= at && m.at < at + bucket)?.text ?? null;

  useEffect(() => {
    if (!series || !line.current) return;
    const first = series.bars[0]?.t ?? 0;
    const bucket = series.bucketMs;
    const list: SeriesMarker<Time>[] = marks
      .filter((m) => m.at >= first)
      .map((m) => ({
        time: sec(Math.floor(m.at / bucket) * bucket),
        position: m.kind === 'bell' ? ('belowBar' as const) : ('aboveBar' as const),
        shape: m.kind === 'bell' ? ('square' as const) : ('circle' as const),
        color: m.kind === 'bell' ? C.ink3 : C.saffron,
        size: m.kind === 'bell' ? 0.6 : 0.8,
      }));
    markers.current?.setMarkers(list);
  }, [marks, series]);

  const open = subject.baseline(series);
  useEffect(() => {
    if (line.current && open) line.current.applyOptions({ baseValue: { type: 'price', price: open } });
  }, [open]);

  // Load the range: stored history first, then whatever this tab has seen since that answer left.
  useEffect(() => {
    let live = true;
    const cached = cache.get(key) ?? null;
    setSeries(cached);
    setState(cached ? 'ready' : 'loading');
    setNewer(false);
    if (cached && line.current) {
      line.current.setData(toLine(cached) as never);
      chart.current?.timeScale().fitContent();
    }
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = () => fetch(subject.url(range))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((h) => {
        if (!live) return;
        const s = fromHistory(h);
        // Nothing stored yet (a brand-new market): ask again once the first prices are durable.
        if (!s.bars.length) retry = setTimeout(load, 5000);
        for (const t of game.ticks) {
          const v = subject.value(t.p, s);
          if (v !== undefined) fold(s, t.seq, t.at, v);
        }
        cache.set(key, s);
        setSeries(s);
        setState('ready');
        line.current?.setData(toLine(s) as never);
        if (!awayRef.current) chart.current?.timeScale().fitContent();
      })
      .catch(() => live && setState(cached ? 'ready' : 'error'));
    void load();
    return () => {
      live = false;
      clearTimeout(retry);
    };
  }, [key, range, subject]);

  // Live: each tick extends the series in place, the earlier history untouched.
  useEffect(
    () =>
      game.onTick((t) => {
        const s = cache.get(key);
        const v = s && subject.value(t.p, s);
        if (!s || v === undefined) return;
        const prevLast = s.bars.at(-1);
        const what = fold(s, t.seq, t.at, v);
        if (what === 'skip' || !line.current) return;
        const bar = s.bars.at(-1)!;
        if (what === 'append' && prevLast && bar.t - prevLast.t > s.bucketMs * 3) line.current.update({ time: sec(prevLast.t + s.bucketMs) } as never);
        line.current.update({ time: sec(bar.t), value: bar.c });
        if (what === 'append' && awayRef.current) setNewer(true);
      }),
    [key, subject],
  );

  const ranges = availableRanges(series?.span ?? null);
  const bars = series?.bars ?? [];
  const lo = bars.length ? Math.min(...bars.map((b) => b.l)) : null;
  const hi = bars.length ? Math.max(...bars.map((b) => b.h)) : null;
  const backToLive = () => {
    chart.current?.timeScale().scrollToRealTime();
    setNewer(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-3 pb-1">
        <div role="group" aria-label="Chart range" className="flex flex-wrap gap-0.5">
          {ranges.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={r === range}
              onClick={() => setRange(r)}
              className={`h-7 min-w-9 rounded-sm px-2 text-[12px] font-semibold ${r === range ? 'bg-night-4 text-ink' : 'text-ink-3 hover:text-ink'}`}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
        <dl className="flex gap-x-3 text-[12px] text-ink-3">
          {open !== undefined && (
            <div className="flex gap-1"><dt>Bell</dt><dd className="text-ink-2">{subject.format(open)}</dd></div>
          )}
          {lo !== null && hi !== null && (
            <div className="flex gap-1"><dt>Range</dt><dd className="text-ink-2">{subject.format(lo)} to {subject.format(hi)}</dd></div>
          )}
        </dl>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={el}
          className="absolute inset-0"
          role="img"
          aria-label={`${subject.label}, ${RANGE_LABEL[range]} range${bars.length ? `, last ${subject.format(bars.at(-1)!.c)}` : ''}`}
        />
        {state !== 'ready' && (
          <p className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-ink-3">
            {state === 'loading' ? 'Loading price history' : 'Price history did not load. Pick a range to retry.'}
          </p>
        )}
        {state === 'ready' && !bars.length && (
          <p className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-sm text-ink-3">
            No trading yet. The line starts at the first opening bell.
          </p>
        )}
        {hover && (
          <div
            className="pointer-events-none absolute z-10 max-w-[15rem] rounded-md border border-rule bg-night-3 px-2.5 py-1.5 text-[12px] shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
            style={{ left: Math.min(hover.x + 12, (el.current?.clientWidth ?? 300) - 200), top: Math.max(4, hover.y - 64) }}
          >
            <p className="text-ink-3">{when(hover.at)}</p>
            <p className="font-semibold">
              {subject.format(hover.price)} <span className={tone(changeBps(hover.price, hover.from))}>{pct(changeBps(hover.price, hover.from))}</span>
              <span className="font-normal text-ink-3"> in range</span>
            </p>
            {hover.note && <p className="mt-0.5 leading-snug text-saffron">{hover.note}</p>}
          </div>
        )}
        {away && (
          <button
            type="button"
            onClick={backToLive}
            className="absolute bottom-9 right-14 z-10 flex h-8 items-center gap-1.5 rounded-full border border-rule bg-night-3 px-3 text-[12px] font-semibold text-ink shadow-[0_8px_24px_rgba(0,0,0,0.5)] hover:border-saffron/60"
          >
            <Radio size={14} className={newer ? 'text-saffron' : 'text-ink-3'} aria-hidden />
            {newer ? 'New prices: back to live' : 'Back to live'}
          </button>
        )}
      </div>
    </div>
  );
}
