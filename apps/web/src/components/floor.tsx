import { motion } from 'motion/react';
import { Minus, Plus, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { changeBps, money, pct, SECTOR_COLOR, tone } from '../lib/format';
import { game, useGame, type AssetInfo } from '../lib/game';
import { usePortfolio } from '../lib/portfolio';
import { Change, Pnl } from './chrome';
import { PriceChart } from './chart';

/** Tickers the crier is calling out right now. */
function useCalledOut() {
  const crier = useGame((s) => s.crier);
  return useMemo(() => new Set(crier?.effects.filter((e) => Math.abs(e.bps) >= 100).map((e) => e.ticker) ?? []), [crier]);
}

export function StallList({ selected, onSelect, readOnly = false }: { selected?: string; onSelect?: (t: string) => void; readOnly?: boolean }) {
  const assets = useGame((s) => s.assets);
  const prices = useGame((s) => s.prices);
  const prev = useGame((s) => s.prev);
  const tick = useGame((s) => s.tick);
  const p = usePortfolio();
  const called = useCalledOut();
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const map = new Map<string, { a: AssetInfo; i: number }[]>();
    assets.forEach((a, i) => {
      if (needle && !`${a.ticker} ${a.name} ${a.sector}`.toLowerCase().includes(needle)) return;
      map.set(a.sector, [...(map.get(a.sector) ?? []), { a, i }]);
    });
    return [...map];
  }, [assets, q]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <label className="relative mx-3 my-3 block">
        <span className="sr-only">Search companies</span>
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search company, ticker or sector"
          className="h-9 w-full rounded-md border border-rule bg-night pl-9 pr-3 text-sm text-ink placeholder:text-ink-3 focus:border-saffron/60 focus:outline-none"
        />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {groups.length === 0 && <p className="px-4 py-6 text-sm text-ink-2">No stall matches "{q}". Try a ticker like NVDA or a sector like Energy.</p>}
        {groups.map(([sector, rows]) => {
          const avg = Math.round(rows.reduce((s, { a, i }) => s + changeBps(prices[i] ?? a.base, a.base), 0) / rows.length);
          return (
            <section key={sector} aria-label={sector} style={{ ['--stripe' as string]: SECTOR_COLOR[sector] }}>
              <div className="sticky top-0 z-10 bg-night-2">
                <div className="awning h-1.5" aria-hidden />
                <div className="flex items-center justify-between px-4 pb-1 pt-2">
                  <h3 className="font-display text-[15px] font-bold uppercase tracking-[0.06em]" style={{ color: 'var(--stripe)' }}>
                    {sector}
                  </h3>
                  <Change bps={avg} className="text-[12px]" />
                </div>
              </div>
              <ul>
                {rows.map(({ a, i }) => {
                  const price = prices[i] ?? a.base;
                  const moved = price - (prev[i] ?? price);
                  const owned = p.byTicker.get(a.ticker)?.qty ?? 0;
                  const isSel = selected === a.ticker;
                  const Row = readOnly ? 'div' : 'button';
                  return (
                    <li key={a.ticker}>
                      <Row
                        {...(readOnly ? {} : { type: 'button' as const, onClick: () => onSelect?.(a.ticker), 'aria-pressed': isSel })}
                        className={`grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2 text-left ${
                          readOnly ? '' : 'hover:bg-night-3'
                        } ${isSel ? 'bg-night-4' : ''} ${called.has(a.ticker) ? 'struck' : ''}`}
                      >
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="text-[14px] font-bold">{a.ticker}</span>
                          <span className="truncate text-[13px] text-ink-3">{a.name}</span>
                          {owned > 0 && (
                            <span className="shrink-0 rounded-sm bg-saffron-deep px-1 text-[11px] font-semibold text-saffron" title={`You hold ${owned}`}>
                              {owned}
                            </span>
                          )}
                        </span>
                        <span className="flex items-baseline gap-2">
                          <span key={tick} className={`rounded-sm px-1 text-[14px] font-medium ${moved > 0 ? 'flash-up' : moved < 0 ? 'flash-down' : ''}`}>
                            {money(price)}
                          </span>
                          <span className={`w-[4.25rem] text-right text-[12px] ${tone(changeBps(price, a.base))}`}>{pct(changeBps(price, a.base))}</span>
                        </span>
                      </Row>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function CompanyPanel({ ticker }: { ticker: string }) {
  const assets = useGame((s) => s.assets);
  const prices = useGame((s) => s.prices);
  const prev = useGame((s) => s.prev);
  const i = assets.findIndex((a) => a.ticker === ticker);
  const a = assets[i];
  if (!a) return null;
  const price = prices[i] ?? a.base;
  const bps = changeBps(price, a.base);
  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ ['--stripe' as string]: SECTOR_COLOR[a.sector] }}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 px-4 pt-4">
        <h2 className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-display text-[44px] font-black leading-[0.9]">{a.ticker}</span>
          <span className="truncate text-lg text-ink-2">{a.name}</span>
          <span className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'var(--stripe)' }}>
            <span className="awning inline-block h-3 w-5 rounded-[2px]" aria-hidden />
            {a.sector}
          </span>
        </h2>
        <div className="flex items-center gap-3">
          <motion.span
            key={price}
            initial={{ y: price >= (prev[i] ?? price) ? 5 : -5 }}
            animate={{ y: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="tag inline-block bg-ink py-1 pr-3 font-display text-[34px] font-extrabold leading-none text-night"
          >
            {money(price)}
          </motion.span>
          <div className="flex flex-col text-sm leading-tight">
            <Change bps={bps} className="text-[15px] font-semibold" />
            <span className="text-[12px] text-ink-3">since the bell ({money(a.base)})</span>
          </div>
        </div>
      </div>
      <p className="hidden px-4 pt-2 text-[13px] text-ink-2 md:block">{a.description}</p>
      <div className="h-[220px] px-1 pt-2 md:h-auto md:min-h-0 md:flex-1">
        <PriceChart ticker={a.ticker} />
      </div>
    </div>
  );
}

export function OrderPanel({ ticker }: { ticker: string }) {
  const assets = useGame((s) => s.assets);
  const prices = useGame((s) => s.prices);
  const phase = useGame((s) => s.session?.phase);
  const conn = useGame((s) => s.conn);
  const pending = useGame((s) => s.pending);
  const book = useGame((s) => s.book);
  const p = usePortfolio();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qtyText, setQtyText] = useState('1');
  const id = useId();

  const i = assets.findIndex((a) => a.ticker === ticker);
  const price = prices[i] ?? assets[i]?.base ?? 0;
  const held = p.byTicker.get(ticker);
  const owned = held?.qty ?? 0;
  const maxBuy = price ? Math.floor(p.cash / price) : 0;
  const max = side === 'buy' ? maxBuy : owned;
  const qty = /^\d+$/.test(qtyText) ? Number(qtyText) : NaN;
  const total = Number.isFinite(qty) ? qty * price : 0;

  useEffect(() => setSide((s) => (s === 'sell' && owned === 0 ? 'buy' : s)), [ticker, owned]);

  const open = phase === 'trading' || phase === 'closing';
  const problem = !book
    ? 'You are watching this session.'
    : !open
      ? phase === 'lobby' ? 'Trading opens at the bell.' : 'The market is closed.'
      : conn !== 'open'
        ? 'Waiting for the connection.'
        : !Number.isInteger(qty) || qty < 1
          ? 'Enter a whole number of shares.'
          : side === 'buy' && total > p.cash
            ? `Not enough cash. You can afford ${maxBuy}.`
            : side === 'sell' && qty > owned
              ? owned ? `You only hold ${owned}.` : `You hold no ${ticker}.`
              : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) return;
    if (game.order(side, ticker, qty)) setQtyText('1');
  };

  const step = (d: number) => setQtyText(String(Math.max(1, (Number.isFinite(qty) ? qty : 0) + d)));

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 p-4" aria-label={`Order ${ticker}`}>
      <div role="radiogroup" aria-label="Side" className="grid grid-cols-2 rounded-md bg-night p-1">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            onClick={() => setSide(s)}
            className={`relative h-10 rounded-[5px] text-sm font-bold uppercase tracking-[0.08em] ${side === s ? 'text-night' : 'text-ink-2 hover:text-ink'}`}
          >
            {side === s && (
              <motion.span
                layoutId={`${id}-side`}
                className={`absolute inset-0 rounded-[5px] ${s === 'buy' ? 'bg-saffron' : 'bg-down'}`}
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative">{s}</span>
          </button>
        ))}
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label htmlFor={`${id}-qty`} className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-3">
            Shares
          </label>
          <button
            type="button"
            disabled={max < 1}
            onClick={() => setQtyText(String(max))}
            className="text-[13px] font-semibold text-saffron hover:underline disabled:text-ink-3 disabled:no-underline"
          >
            Max {max}
          </button>
        </div>
        <div className="flex items-stretch gap-1.5">
          <button type="button" onClick={() => step(-1)} aria-label="One fewer share" className="grid w-11 place-items-center rounded-md border border-rule bg-night hover:bg-night-3">
            <Minus size={16} aria-hidden />
          </button>
          <input
            id={`${id}-qty`}
            inputMode="numeric"
            autoComplete="off"
            value={qtyText}
            onChange={(e) => setQtyText(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
            className="h-11 min-w-0 flex-1 rounded-md border border-rule bg-night text-center text-lg font-semibold focus:border-saffron/60 focus:outline-none"
          />
          <button type="button" onClick={() => step(1)} aria-label="One more share" className="grid w-11 place-items-center rounded-md border border-rule bg-night hover:bg-night-3">
            <Plus size={16} aria-hidden />
          </button>
        </div>
      </div>

      <p className="flex justify-between text-[13px] text-ink-3">
        <span>
          {side === 'buy' ? 'Cost' : 'Proceeds'} <span className="font-semibold text-ink">{money(total)}</span>
        </span>
        <span>
          Cash after{' '}
          <span className={`font-semibold ${side === 'buy' && total > p.cash ? 'text-down' : 'text-ink'}`}>
            {money(Math.max(0, side === 'buy' ? p.cash - total : p.cash + total))}
          </span>
        </span>
      </p>

      <button
        type="submit"
        disabled={!!problem}
        className={`h-12 rounded-md text-[15px] font-bold text-night transition-[filter,opacity] hover:brightness-110 disabled:opacity-35 ${side === 'buy' ? 'bg-saffron' : 'bg-down'}`}
      >
        {side === 'buy' ? 'Buy' : 'Sell'} {Number.isFinite(qty) && qty > 0 ? qty : ''} {ticker}
        {pending > 0 && <span className="ml-2 font-medium">sending</span>}
      </button>
      <p className="min-h-[1.25rem] text-[13px] text-ink-2" aria-live="polite">
        {problem ??
          (owned > 0 && held ? (
            <span className="flex flex-wrap justify-between gap-x-3">
              <span>
                You hold <strong className="text-ink">{owned}</strong> at {money(Math.round(held.cost / owned))}
              </span>
              <Pnl cents={held.unrealized} className="font-semibold" />
            </span>
          ) : null)}
      </p>
    </form>
  );
}

export function Holdings({ onSelect }: { onSelect: (t: string) => void }) {
  const p = usePortfolio();
  const rows = p.holdings.slice().sort((a, b) => b.value - a.value);
  return (
    <div className="flex min-h-0 flex-col">
      {/* Phones: the bar has no room for cash, so the purse opens with the whole picture. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-rule px-4 py-4 md:hidden">
        <div className="col-span-2">
          <dt className="text-[12px] uppercase tracking-[0.08em] text-ink-3">Purse value</dt>
          <dd className="font-display text-5xl font-extrabold leading-none">{money(p.value)}</dd>
          <dd className="mt-1"><Pnl cents={p.pnl} className="font-semibold" /> <span className={`text-[13px] ${tone(p.bps)}`}>{pct(p.bps)}</span></dd>
        </div>
        <div>
          <dt className="text-[12px] uppercase tracking-[0.08em] text-ink-3">Cash</dt>
          <dd className="text-lg font-semibold">{money(p.cash)}</dd>
        </div>
        <div>
          <dt className="text-[12px] uppercase tracking-[0.08em] text-ink-3">In shares</dt>
          <dd className="text-lg font-semibold">{money(p.invested)}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 pb-2 pt-3">
        <h2 className="panel-title">Holdings</h2>
        <div className="hidden gap-x-5 text-[13px] md:flex">
          <span className="text-ink-3">
            Invested <span className="font-semibold text-ink">{money(p.invested)}</span>
          </span>
          <span className="text-ink-3">
            Open P/L <Pnl cents={p.unrealized} className="font-semibold" />
          </span>
          <span className="text-ink-3">
            Realised <Pnl cents={p.realized} className="font-semibold" />
          </span>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-ink-2">All cash so far. Cash is safe, but it never climbs the roster: pick a stall and buy a few shares.</p>
      ) : (
        <>
          <ul className="px-2 pb-3 md:hidden">
            {rows.map((h) => (
              <li key={h.asset.ticker}>
                <button type="button" onClick={() => onSelect(h.asset.ticker)} className="flex min-h-14 w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left active:bg-night-3">
                  <span className="flex items-center gap-2.5">
                    <span className="h-8 w-1.5 rounded-full" style={{ background: SECTOR_COLOR[h.asset.sector] }} aria-hidden />
                    <span>
                      <span className="block text-[15px] font-bold">{h.asset.ticker}</span>
                      <span className="block text-[13px] text-ink-3">
                        {h.qty} at {money(Math.round(h.cost / h.qty))}
                      </span>
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block text-[15px] font-semibold">{money(h.value)}</span>
                    <Pnl cents={h.unrealized} className="text-[13px]" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="hidden min-h-0 overflow-auto px-2 pb-2 md:block">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Company</th>
                  <th className="px-2 py-1.5 text-right font-medium">Shares</th>
                  <th className="px-2 py-1.5 text-right font-medium">Avg cost</th>
                  <th className="px-2 py-1.5 text-right font-medium">Price</th>
                  <th className="px-2 py-1.5 text-right font-medium">Value</th>
                  <th className="px-2 py-1.5 text-right font-medium">P/L</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.asset.ticker} className="border-t border-rule/60">
                    <td className="px-2 py-1.5">
                      <button type="button" onClick={() => onSelect(h.asset.ticker)} className="flex items-center gap-2 font-bold hover:text-saffron">
                        <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: SECTOR_COLOR[h.asset.sector] }} aria-hidden />
                        {h.asset.ticker}
                      </button>
                    </td>
                    <td className="px-2 py-1.5 text-right">{h.qty}</td>
                    <td className="px-2 py-1.5 text-right text-ink-2">{money(Math.round(h.cost / h.qty))}</td>
                    <td className="px-2 py-1.5 text-right">{money(h.price)}</td>
                    <td className="px-2 py-1.5 text-right font-semibold">{money(h.value)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <Pnl cents={h.unrealized} />
                      <span className={`ml-1.5 text-[12px] ${tone(h.unrealized)}`}>{pct(Math.round((h.unrealized * 10_000) / h.cost))}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
