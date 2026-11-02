import { compareRank, sharpe } from './ranking.js';

export interface AwardPlayer {
  nickname: string;
  joinedAt: number;
  value: number;
  trades: number;
  /** Portfolio value through the competition, oldest first. */
  samples: number[];
  eventGain: number;
  /** Profit per company traded, realised or not. */
  pnl: { ticker: string; pnl: number }[];
}

export interface Award {
  id: string;
  label: string;
  nickname: string;
  detail: string;
}

const eur = (cents: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
/** Fewest trades that still count as patient, and fewest that count as busy or broad. */
const PATIENT_TRADES = 3;
const BUSY = 5;
/** A dip smaller than this share of the purse is noise, not something to come back from. */
const BRINK = 0.03;
const SMALLEST_FIELD_FOR_SPOON = 3;

/**
 * The awards of one competition, from that competition's players only. Ties go to the higher rank, so a rerun
 * gives the same awards. `closingSamples` is how many value samples the last-calls window spans.
 */
export function pickAwards(players: AwardPlayer[], start: number, closingSamples: number): Award[] {
  const ranked = [...players].sort(compareRank);
  const out: Award[] = [];
  /** The ranked player with the highest score, among those with a score at all. */
  const top = (score: (p: AwardPlayer) => number | null) => {
    let best: { p: AwardPlayer; s: number } | null = null;
    for (const p of ranked) {
      const s = score(p);
      if (s !== null && (!best || s > best.s)) best = { p, s };
    }
    return best;
  };
  const give = (id: string, label: string, won: { p: AwardPlayer; s: number } | null, detail: (s: number, p: AwardPlayer) => string) => {
    if (won) out.push({ id, label, nickname: won.p.nickname, detail: detail(won.s, won.p) });
  };
  const bestCall = (p: AwardPlayer) => p.pnl.reduce((m, x) => (x.pnl > m.pnl ? x : m), p.pnl[0] ?? { ticker: '', pnl: 0 });
  const worstCall = (p: AwardPlayer) => p.pnl.reduce((m, x) => (x.pnl < m.pnl ? x : m), p.pnl[0] ?? { ticker: '', pnl: 0 });

  if (ranked[0]) out.push({ id: 'winner', label: 'Top of the market', nickname: ranked[0].nickname, detail: `finished with ${eur(ranked[0].value)}` });
  give('steady', 'Steadiest hand', top((p) => (p.trades > 0 && p.value > start ? sharpe(p.samples) : null)), () => 'best risk-adjusted return');
  give('crier', 'Read the crier', top((p) => (p.eventGain > 0 ? p.eventGain : null)), (s) => `+${eur(s)} during major events`);
  give('call', 'Call of the day', top((p) => (bestCall(p).pnl > 0 ? bestCall(p).pnl : null)), (s, p) => `+${eur(s)} on ${bestCall(p).ticker}`);
  give('comeback', 'Back from the brink', top((p) => {
    if (!p.trades || !p.samples.length) return null;
    const low = Math.min(...p.samples);
    return low < start * (1 - BRINK) && p.value > low ? p.value - low : null;
  }), (s) => `climbed ${eur(s)} from their low`);
  give('closer', 'Last-call hero', top((p) => {
    const before = p.samples[p.samples.length - 1 - closingSamples];
    return p.trades > 0 && before !== undefined && p.value > before ? p.value - before : null;
  }), (s) => `+${eur(s)} in last calls`);
  give('patient', 'Patient money', top((p) => (p.trades > 0 && p.trades <= PATIENT_TRADES && p.value > start ? p.value : null)), (s, p) => `+${eur(s - start)} from ${p.trades} ${p.trades === 1 ? 'trade' : 'trades'}`);
  give('busy', 'Busiest stall', top((p) => (p.trades >= BUSY ? p.trades : null)), (s) => `${s} trades`);
  give('bazaar', 'Tour of the bazaar', top((p) => (p.pnl.length >= BUSY ? p.pnl.length : null)), (s) => `traded ${s} companies`);
  give('bonfire', 'Biggest bonfire', top((p) => (worstCall(p).pnl < 0 ? -worstCall(p).pnl : null)), (s, p) => `lost ${eur(s)} on ${worstCall(p).ticker}`);
  const last = ranked.at(-1);
  if (last && ranked.length >= SMALLEST_FIELD_FOR_SPOON && last.trades > 0 && last.value < start) out.push({ id: 'spoon', label: 'Wooden spoon', nickname: last.nickname, detail: `finished with ${eur(last.value)}` });
  if (ranked.some((p) => p.trades > 0)) {
    const idle = ranked.find((p) => p.trades === 0);
    if (idle) out.push({ id: 'mattress', label: 'Under the mattress', nickname: idle.nickname, detail: 'never traded a share' });
  }
  return out;
}
