import { animate, motion, useReducedMotion } from 'motion/react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { changeBps, clock, moneyWhole, pct, tone } from '../lib/format';
import { awardMoments, leadChanges, valueAt, type Replay } from '../lib/replay';
import type { Results } from '../lib/game';
import { Lattice, useMedia } from './chrome';

/** How long the whole race takes to play, bell to close. */
const RACE_SECONDS = 14;
/** Fewest pixels between two line-end labels. */
const LABEL_GAP = 13;

/** The race behind the results: every leading line through the competition, played from the bell to the close. */
export function RaceReplay({ results }: { results: Results }) {
  const [race, setRace] = useState<Replay | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/sessions/${results.sessionId}/replay`, { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<Replay>) : null))
      .then((d) => setRace(d && d.ticks.length > 1 && d.players.length ? d : null))
      .catch(() => {});
    return () => ctl.abort();
  }, [results.sessionId]);
  if (!race) return null;
  return <Race race={race} me={results.me?.participantId ?? null} awards={results.awards} />;
}

function Race({ race, me, awards }: { race: Replay; me: string | null; awards: Results['awards'] }) {
  const still = useReducedMotion() ?? false;
  const phone = useMedia('(max-width: 767px)');
  const end = race.ticks.at(-1)!;
  // The final chart first; Play races it from the bell.
  const [t, setT] = useState(end);
  const [from, setFrom] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  const clipId = useId();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (from === null) return;
    const c = animate(from, end, { duration: (RACE_SECONDS * (end - from)) / end, ease: 'linear', onUpdate: setT, onComplete: () => setFrom(null) });
    return () => c.stop();
  }, [from, end]);

  const h = phone ? 230 : 300;
  const pad = { l: phone ? 44 : 56, r: phone ? 84 : 120, t: 18, b: 22 };
  const all = race.players.flatMap((p) => p.values.filter((v): v is number => v !== null));
  const lo = Math.min(race.start, ...all);
  const hi = Math.max(race.start, ...all);
  const span = hi - lo || race.start * 0.01;
  const x = (tick: number) => pad.l + ((w - pad.l - pad.r) * tick) / end;
  const y = (v: number) => pad.t + ((h - pad.t - pad.b) * (hi + span * 0.06 - v)) / (span * 1.12);

  const paths = race.players.map((p) => {
    let d = '';
    let pen = false;
    p.values.forEach((v, i) => {
      if (v === null) return void (pen = false);
      d += `${pen ? 'L' : 'M'}${x(race.ticks[i]!).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  });
  const moments = useMemo(() => awardMoments(race, awards), [race, awards]);
  const changes = useMemo(() => leadChanges(race), [race]);

  const snap = Math.max(0, race.ticks.findLastIndex((k) => k <= t));
  const now = race.players
    .map((p) => ({ p, v: valueAt(race.ticks, p.values, t) }))
    .filter((r): r is { p: Replay['players'][number]; v: number } => r.v !== null);
  // Standings as of the last snapshot, ranks and values together (the lines interpolate, a rank cannot);
  // at the bell everyone is level, so final order.
  const standings = race.players
    .flatMap((p) => (p.values[snap] == null ? [] : [{ p, v: p.values[snap]!, at: snap === 0 ? null : p.ranks[snap] ?? null }]))
    .sort((a, b) => (a.at ?? a.p.rank) - (b.at ?? b.p.rank));
  const latest = race.news.findLast((n) => n.tick <= t);
  const color = (id: string, rank: number) =>
    id === me ? 'var(--color-saffron)' : rank === 1 ? 'var(--color-ink)' : rank <= 3 ? 'var(--color-ink-2)' : 'var(--color-ink-3)';

  // Names at the line ends for the podium, the viewer and whoever is pointed at, pushed apart so none overlap.
  const labels = now
    .filter((r) => r.p.rank <= 3 || r.p.participantId === me || r.p.participantId === hover)
    .map((r) => ({ ...r, ly: y(r.v) }))
    .sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < labels.length; i++) labels[i]!.ly = Math.max(labels[i]!.ly, labels[i - 1]!.ly + LABEL_GAP);
  const playing = from !== null;
  const grid = [lo, race.start, hi].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="panel-title">The race</h2>
        <p className="text-[13px] text-ink-3">
          {race.players.length > 1 ? (changes === 0 ? 'The lead never changed hands' : `The lead changed hands ${changes} ${changes === 1 ? 'time' : 'times'}`) : 'Your purse from the bell to the close'}
        </p>
      </div>
      <div className="rounded-lg bg-night-2 px-2 pb-3 pt-2 sm:px-4">
        <div ref={box} className="w-full">
          <svg width={w} height={h} className="block" role="img" aria-label={`Portfolio values from the bell to the close. ${standings[0] ? `${standings[0].p.nickname} leads at ${clock(t * race.tickMs)}.` : ''}`}>
            <defs>
              <clipPath id={clipId}><rect x={0} y={0} width={x(t) + 1} height={h} /></clipPath>
            </defs>
            <rect x={x(end - race.closingTicks)} y={pad.t} width={x(end) - x(end - race.closingTicks)} height={h - pad.t - pad.b} fill="var(--color-down-deep)" opacity={0.55} />
            <text x={x(end - race.closingTicks) + 4} y={pad.t + 11} fontSize={10} fill="var(--color-down)" className="uppercase tracking-[0.08em]">Last calls</text>
            {grid.map((v) => (
              <g key={v}>
                <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke="var(--color-rule)" strokeDasharray={v === race.start ? '3 3' : undefined} />
                <text x={pad.l - 6} y={y(v) + 3.5} fontSize={10} textAnchor="end" fill="var(--color-ink-3)">{moneyWhole(v)}</text>
              </g>
            ))}
            <text x={pad.l} y={h - 6} fontSize={10} fill="var(--color-ink-3)">Bell</text>
            <text x={w - pad.r} y={h - 6} fontSize={10} textAnchor="end" fill="var(--color-ink-3)">Close {clock(end * race.tickMs)}</text>
            {race.news.map((n, i) => (
              <rect
                key={i}
                x={x(n.tick) - 1}
                y={h - pad.b - 6}
                width={2}
                height={6}
                fill={n.market ? 'var(--color-saffron)' : n.severity === 3 ? 'var(--color-down)' : 'var(--color-ink-3)'}
                opacity={n.tick <= t ? 1 : 0.35}
              >
                <title>{n.headline}</title>
              </rect>
            ))}
            <g clipPath={`url(#${clipId})`} fill="none" strokeLinejoin="round" strokeLinecap="round">
              {/* The viewer and the leaders draw last, on top. */}
              {race.players.map((p, i) => ({ p, d: paths[i]! })).reverse().sort((a, b) => Number(a.p.participantId === me) - Number(b.p.participantId === me)).map(({ p, d }) => {
                const lit = hover === null || hover === p.participantId;
                return (
                  <path
                    key={p.participantId}
                    d={d}
                    stroke={color(p.participantId, p.rank)}
                    strokeWidth={p.participantId === me || hover === p.participantId ? 2.5 : p.rank <= 3 ? 2 : 1.25}
                    opacity={lit ? (p.rank <= 3 || p.participantId === me ? 1 : 0.7) : 0.2}
                  />
                );
              })}
            </g>
            {moments.filter((m) => m.tick <= t).map((m) => (
              <g key={m.label}>
                <circle cx={x(m.tick)} cy={y(m.value)} r={4} fill="var(--color-night)" stroke="var(--color-saffron)" strokeWidth={1.5} />
                <text x={x(m.tick)} y={y(m.value) - 8} fontSize={10} textAnchor={m.tick > end * 0.8 ? 'end' : 'middle'} fill="var(--color-saffron)" className="uppercase tracking-[0.06em]">{m.label}</text>
              </g>
            ))}
            {now.map((r) => (
              <circle key={r.p.participantId} cx={x(t)} cy={y(r.v)} r={r.p.participantId === me ? 4 : 3} fill={color(r.p.participantId, r.p.rank)} opacity={hover === null || hover === r.p.participantId ? 1 : 0.3} />
            ))}
            {labels.map((r) => (
              <g key={r.p.participantId}>
              <Lattice nickname={r.p.nickname} size={14} you={r.p.participantId === me} x={x(t) + 8} y={r.ly - 7} />
              <text x={x(t) + 26} y={r.ly + 3.5} fontSize={11} fontWeight={600} fill={color(r.p.participantId, r.p.rank)}>
                {r.p.nickname.length > (phone ? 8 : 13) ? `${r.p.nickname.slice(0, phone ? 7 : 12)}…` : r.p.nickname}
              </text>
              </g>
            ))}
          </svg>
        </div>

        <div className="mt-2 flex items-center gap-3 px-1">
          {!still && (
            <button
              type="button"
              onClick={() => (playing ? setFrom(null) : setFrom(t >= end ? 0 : t))}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-saffron text-night hover:brightness-110"
              aria-label={playing ? 'Pause the race' : t >= end ? 'Play the race from the bell' : 'Play the race'}
            >
              {playing ? <Pause size={18} /> : t >= end ? <RotateCcw size={18} /> : <Play size={18} />}
            </button>
          )}
          <input
            type="range"
            min={0}
            max={end}
            step={1}
            value={Math.round(t)}
            onChange={(e) => {
              setFrom(null);
              setT(Number(e.target.value));
            }}
            className="h-10 min-w-0 flex-1 accent-saffron"
            aria-label="Moment of the race"
            aria-valuetext={`${clock(t * race.tickMs)} after the bell${standings[0] ? `, ${standings[0].p.nickname} leads` : ''}`}
          />
          <span className="w-[4.5rem] shrink-0 text-right text-[13px] text-ink-2">{clock(t * race.tickMs)}</span>
        </div>
        <p className="mt-1 truncate px-1 text-[13px] text-ink-3" aria-live={playing ? 'off' : 'polite'}>
          {latest ? <><span className={latest.market ? 'text-saffron' : latest.severity === 3 ? 'text-down' : 'text-ink-2'}>{latest.market ? 'Market call' : 'News'}</span> {latest.headline}</> : 'No major news yet'}
        </p>
      </div>

      <p className="mt-4 mb-1 px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3" aria-hidden>Standings at {snap === 0 ? 'the bell' : clock(race.ticks[snap]! * race.tickMs)}</p>
      <ol className="grid gap-x-6 sm:grid-cols-2" aria-label={`Standings at ${snap === 0 ? 'the bell' : clock(race.ticks[snap]! * race.tickMs)}`}>
        {standings.map((r) => {
          const you = r.p.participantId === me;
          return (
            <motion.li
              key={r.p.participantId}
              // Rows trade places as the race runs; reduced motion just reorders.
              layout={still ? false : 'position'}
              transition={{ type: 'spring', stiffness: 500, damping: 40 }}
              onPointerEnter={() => setHover(r.p.participantId)}
              onPointerLeave={() => setHover(null)}
              className={`grid grid-cols-[1.75rem_minmax(0,1fr)_auto_4.5rem] items-baseline gap-2 border-b border-rule/60 px-2 py-2 text-[14px] ${you ? 'rounded-md border-transparent bg-saffron-deep' : ''}`}
            >
              <span className={`font-display text-[18px] font-extrabold ${r.at === 1 ? 'text-saffron' : r.at !== null && r.at <= 3 ? 'text-ink' : 'text-ink-3'}`}>{r.at ?? ''}</span>
              <span className={`flex min-w-0 items-center gap-2 self-center ${you ? 'font-semibold text-saffron' : ''}`}><Lattice nickname={r.p.nickname} size={20} you={you} /><span className="truncate">{r.p.nickname}</span>{you && <span className="sr-only"> (you)</span>}</span>
              <span className="text-right">{moneyWhole(r.v)}</span>
              <span className={`text-right text-[13px] ${tone(changeBps(r.v, race.start))}`}>{pct(changeBps(r.v, race.start))}</span>
            </motion.li>
          );
        })}
      </ol>
    </div>
  );
}
