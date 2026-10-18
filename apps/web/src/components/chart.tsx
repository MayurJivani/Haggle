import {
  BaselineSeries, ColorType, createChart, createSeriesMarkers, LineStyle,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { clock, money } from '../lib/format';
import { useGame } from '../lib/game';

const C = {
  up: '#3ddc84',
  down: '#ff5c62',
  ink3: '#8f897b',
  rule: '#2e2846',
  grid: '#1a1630',
  saffron: '#ffb020',
};

/**
 * The session tape for one company: a baseline chart around the opening price, green above and red
 * below, fixed to the whole session so it fills left to right as the clock runs. Crier events that
 * moved this company are pinned on it.
 */
export function PriceChart({ ticker }: { ticker: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Baseline'> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const assets = useGame((s) => s.assets);
  const tick = useGame((s) => s.tick);
  const events = useGame((s) => s.events);
  const history = useGame((s) => s.history);
  const session = useGame((s) => s.session);
  const index = assets.findIndex((a) => a.ticker === ticker);
  const asset = assets[index];
  const tickMs = session?.tickMs ?? 1000;
  const totalTicks = session?.totalTicks ?? 600;
  const rangeRef = useRef(totalTicks);
  rangeRef.current = totalTicks;

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: C.ink3, fontFamily: 'Archivo Variable, sans-serif', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.rule, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: C.rule, timeVisible: true, secondsVisible: true, lockVisibleTimeRangeOnResize: true },
      crosshair: { vertLine: { color: C.ink3, labelBackgroundColor: '#241f3d' }, horzLine: { color: C.ink3, labelBackgroundColor: '#241f3d' } },
      handleScroll: false,
      handleScale: false,
    });
    series.current = c.addSeries(BaselineSeries, {
      lineWidth: 2,
      topLineColor: C.up,
      topFillColor1: 'rgba(61, 220, 132, 0.26)',
      topFillColor2: 'rgba(61, 220, 132, 0.02)',
      bottomLineColor: C.down,
      bottomFillColor1: 'rgba(255, 92, 98, 0.02)',
      bottomFillColor2: 'rgba(255, 92, 98, 0.26)',
      priceLineColor: C.saffron,
      priceLineStyle: LineStyle.Dotted,
      priceFormat: { type: 'custom', formatter: (v: number) => money(v), minMove: 1 },
    });
    markers.current = createSeriesMarkers(series.current, []);
    chart.current = c;
    // A chart mounted in a hidden mobile tab sizes to zero; refit the session range once it has a width.
    const refit = () => c.timeScale().setVisibleLogicalRange({ from: 0, to: rangeRef.current });
    c.timeScale().subscribeSizeChange(refit);
    return () => {
      c.timeScale().unsubscribeSizeChange(refit);
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.applyOptions({
      localization: { timeFormatter: (t: Time) => `T+${clock((t as number) * tickMs)}`, priceFormatter: (v: number) => money(v) },
      timeScale: { tickMarkFormatter: (t: Time) => clock((t as number) * tickMs) },
    });
  }, [tickMs]);

  // Full redraw when the company changes (or a reconnect replaced the history).
  useEffect(() => {
    if (!series.current || !asset) return;
    series.current.applyOptions({ baseValue: { type: 'price', price: asset.base } });
    const h = history[index] ?? [];
    series.current.setData(h.map((p) => ({ time: p.tick as UTCTimestamp, value: p.price })));
    chart.current?.timeScale().setVisibleLogicalRange({ from: 0, to: totalTicks });
  }, [index, asset, totalTicks, history]);

  useEffect(() => {
    const last = history[index]?.at(-1);
    if (series.current && last && last.tick === tick) series.current.update({ time: last.tick as UTCTimestamp, value: last.price });
  }, [tick, index, history]);

  useEffect(() => {
    markers.current?.setMarkers(
      events.flatMap((ev) => {
        const hit = ev.effects.find((e) => e.ticker === ticker);
        if (!hit || Math.abs(hit.bps) < 150) return [];
        return [{
          time: ev.tick as UTCTimestamp,
          position: hit.bps > 0 ? ('belowBar' as const) : ('aboveBar' as const),
          shape: hit.bps > 0 ? ('arrowUp' as const) : ('arrowDown' as const),
          // Saffron, the crier's colour, with no label: any text lands on the line. The arrow carries
          // the direction and the headline lives in the feed.
          color: C.saffron,
        }];
      }),
    );
  }, [events, ticker]);

  return <div ref={el} className="h-full min-h-[220px] w-full" aria-label={`Simulated price chart for ${asset?.name ?? ticker}`} role="img" />;
}
