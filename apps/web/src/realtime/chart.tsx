import { CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { useKept } from '../components/chrome';
import { api, compact, price, type ChartRange, type History, type Instrument, type Quote } from './store';

const RANGES: ChartRange[] = ['1D', '5D', '1M', '3M', '6M', '1Y', '5Y', 'MAX'];
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/** Real candles only: gaps (nights, weekends, holidays) are left out, never filled in. */
export function Candles({ i, q }: { i: Instrument; q: Quote | undefined }) {
  const [range, setRange] = useKept<ChartRange>('rt:range', '1D');
  const [hist, setHist] = useState<History | null | 'error' | 'loading'>('loading');
  const [hover, setHover] = useState<{ t: number; o: number; h: number; l: number; c: number; v: number } | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const tz = useRef('UTC');

  useEffect(() => {
    let gone = false;
    setHist('loading');
    api<History>(`/instruments/${i.id}/candles?range=${range}`).then((h) => !gone && setHist(h), () => !gone && setHist('error'));
    return () => void (gone = true);
  }, [i.id, range]);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: css('--color-ink-3'), fontFamily: css('--font-sans') },
      grid: { vertLines: { visible: false }, horzLines: { color: css('--color-night-3') } },
      rightPriceScale: { borderColor: css('--color-rule') },
      timeScale: { borderColor: css('--color-rule'), timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
      localization: {
        priceFormatter: (p: number) => price(Math.round(p * 10_000), i.currency),
        timeFormatter: (t: number) => new Date(t * 1000).toLocaleString(undefined, { timeZone: tz.current, dateStyle: 'medium', timeStyle: 'short' }),
      },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: css('--color-up'), downColor: css('--color-down'), wickUpColor: css('--color-up'), wickDownColor: css('--color-down'), borderVisible: false,
    });
    volume.current = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    c.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });
    c.subscribeCrosshairMove((p) => {
      const d = p.seriesData.get(candles.current!) as { time: number; open: number; high: number; low: number; close: number } | undefined;
      const v = p.seriesData.get(volume.current!) as { value: number } | undefined;
      setHover(d ? { t: d.time * 1000, o: d.open, h: d.high, l: d.low, c: d.close, v: v?.value ?? 0 } : null);
    });
    chart.current = c;
    return () => c.remove();
  }, [i.currency]);

  useEffect(() => {
    if (typeof hist !== 'object' || !hist || !candles.current) return;
    tz.current = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const up = css('--color-up'), down = css('--color-down');
    candles.current.setData(hist.candles.map((k) => ({ time: (k.t / 1000) as UTCTimestamp, open: k.o / 10_000, high: k.h / 10_000, low: k.l / 10_000, close: k.c / 10_000 })));
    volume.current!.setData(hist.candles.map((k) => ({ time: (k.t / 1000) as UTCTimestamp, value: k.v, color: `${k.c >= k.o ? up : down}73` })));
    chart.current!.timeScale().fitContent();
  }, [hist]);

  // The live price moves the latest 1D bar's close; a new bar only comes from the provider.
  useEffect(() => {
    if (range !== '1D' || typeof hist !== 'object' || !hist?.candles.length || !q?.last || !candles.current) return;
    const k = hist.candles.at(-1)!;
    if (q.at < k.t) return;
    const step = 5 * 60_000;
    if (q.at >= k.t + step) return;
    const c = q.last / 10_000;
    candles.current.update({ time: (k.t / 1000) as UTCTimestamp, open: k.o / 10_000, high: Math.max(k.h / 10_000, c), low: Math.min(k.l / 10_000, c), close: c });
  }, [q?.last, q?.at, range, hist]);

  const empty = typeof hist === 'object' && hist && hist.candles.length === 0;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 px-3 pt-3" role="tablist" aria-label="Chart range">
        {RANGES.map((r) => (
          <button key={r} type="button" role="tab" aria-selected={r === range} onClick={() => setRange(r)}
            className={`rounded px-2.5 py-1 text-xs font-bold ${r === range ? 'bg-saffron text-night' : 'text-ink-2 hover:bg-night-3'}`}>{r}</button>
        ))}
        <span className="ml-auto text-xs tabular-nums text-ink-3">
          {hover
            ? `${new Date(hover.t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}  O ${hover.o.toFixed(2)}  H ${hover.h.toFixed(2)}  L ${hover.l.toFixed(2)}  C ${hover.c.toFixed(2)}  Vol ${compact(hover.v)}`
            : typeof hist === 'object' && hist ? `${hist.resolution} bars · ${hist.source}${hist.quality === 'dev' ? ' (generated)' : ''}` : ''}
        </span>
      </div>
      <div className="relative h-[340px] sm:h-[420px]">
        <div ref={el} className="absolute inset-0" />
        {(hist === 'loading' || hist === 'error' || empty) && (
          <p className="absolute inset-0 grid place-items-center text-sm text-ink-3">
            {hist === 'loading' ? 'Loading history' : hist === 'error' ? 'No history available from the configured data provider.' : 'No trades in this range.'}
          </p>
        )}
      </div>
    </div>
  );
}
