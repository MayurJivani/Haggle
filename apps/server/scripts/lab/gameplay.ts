// Whole multiplayer rounds played by bots with different personalities, to measure whether the market
// makes a good game: lead changes, comebacks, close finishes, activity, news spread through the round.
import { ASSETS, SECTORS } from '../../src/market/assets.js';
import { rng } from '../../src/market/rng.js';
import type { Run } from '../calibration/simulate.js';
import { ROUND_DAYS } from './strategies.js';

const PURSE = 1_000_000;
type Book = { cash: number; pos: Map<number, number>; wasBelow?: boolean };
interface Ctx { run: Run; t: number; start: number; pool: number[]; next: () => number; rank: number; players: number }
type Bot = { name: string; act: (b: Book, c: Ctx) => void; sector?: number };

const price = (run: Run, i: number, t: number) => Math.round(Math.exp(run.logP[i]![t]!));
const value = (b: Book, run: Run, t: number) => { let v = b.cash; for (const [i, q] of b.pos) v += q * price(run, i, t); return v; };
const sellAll = (b: Book, c: Ctx) => { for (const [i, q] of b.pos) b.cash += q * price(c.run, i, c.t); b.pos.clear(); };
const buyEqual = (b: Book, c: Ctx, picks: number[]) => {
  const each = b.cash / Math.max(1, picks.length);
  for (const i of picks) {
    const p = price(c.run, i, c.t);
    const q = Math.floor(each / p);
    if (q > 0) { b.cash -= q * p; b.pos.set(i, (b.pos.get(i) ?? 0) + q); }
  }
};
const rankBy = (c: Ctx, score: (i: number) => number, k: number) => [...c.pool].sort((x, y) => score(y) - score(x)).slice(0, k);
const moved = (c: Ctx, i: number, days: number) => c.run.logP[i]![c.t]! - c.run.logP[i]![Math.max(c.start, c.t - days)]!;
const rebalance = (b: Book, c: Ctx, picks: number[]) => { sellAll(b, c); buyEqual(b, c, picks); };
const shuffle = (c: Ctx, k: number) => [...c.pool].map((i) => [c.next(), i] as const).sort((a, b) => a[0] - b[0]).slice(0, k).map(([, i]) => i);
const at = (c: Ctx) => c.t - c.start;

const conservative = (b: Book, c: Ctx) => { if (at(c) === 0) buyEqual(b, c, rankBy(c, (i) => -ASSETS[i]!.beta - ASSETS[i]!.vol * 100, 8)); };
const aggressive = (b: Book, c: Ctx) => { if (at(c) % 15 === 0) rebalance(b, c, rankBy(c, (i) => ASSETS[i]!.vol * ASSETS[i]!.beta + c.next() * 0.002, 2)); };

export const BOTS: Bot[] = [
  { name: 'conservative', act: conservative },
  { name: 'aggressive', act: aggressive },
  { name: 'momentum', act: (b, c) => { if (at(c) && at(c) % 10 === 0) rebalance(b, c, rankBy(c, (i) => moved(c, i, 10), 3)); } },
  { name: 'contrarian', act: (b, c) => { if (at(c) && at(c) % 10 === 0) rebalance(b, c, rankBy(c, (i) => -moved(c, i, 10), 3)); } },
  { name: 'news trader', act: (b, c) => {
    const n = c.run.news.filter((x) => x.day === c.t && x.scope === 'asset' && x.sign > 0 && c.pool.includes(x.assets[0]!));
    if (n.length) rebalance(b, c, n.map((x) => x.assets[0]!));
    else if (at(c) % 12 === 11 && b.pos.size) sellAll(b, c);
  } },
  { name: 'sector specialist', act: (b, c) => { if (at(c) === 0) { const k = Math.floor(c.next() * SECTORS.length); buyEqual(b, c, c.pool.filter((i) => ASSETS[i]!.sector === SECTORS[k])); } } },
  { name: 'random', act: (b, c) => { if (at(c) % 12 === 0) rebalance(b, c, shuffle(c, 3)); } },
  { name: 'opportunist', act: (b, c) => {
    if (!at(c)) return;
    const worst = rankBy(c, (i) => -moved(c, i, 1), 1)[0]!;
    if (moved(c, worst, 1) < -0.04) rebalance(b, c, [worst]);
    else if (b.pos.size && moved(c, [...b.pos.keys()][0]!, 5) > 0.03) sellAll(b, c);
  } },
  { name: 'inactive', act: () => {} },
  { name: 'leaderboard chaser', act: (b, c) => {
    if (at(c) === 0) return void conservative(b, c);
    if (at(c) % 10 === 0 && c.rank > c.players / 2) aggressive(b, { ...c, start: c.t });
  } },
];

export interface RoundStats {
  leadChanges: number; closeFinish: number; earlyLock: number; comeback: number; longestFreeze: number; spread: number; best: number; worst: number;
  bigMoves: number; bigCompanies: number; bigSectors: number; stories: number; severe: number; longestQuiet: number; storyThirds: number[]; marketMove: number; winner: string; ret: Record<string, number>; storyKinds: Record<string, number>;
}

export function playRound(run: Run, round: number, pool: number[], seed: number): RoundStats | null {
  const start = run.rounds[round]!.day;
  const end = start + ROUND_DAYS;
  if (end >= run.days) return null;
  const next = rng(seed ^ (round * 2654435761));
  const books: Book[] = BOTS.map(() => ({ cash: PURSE, pos: new Map() }));
  let leader = -1, leadChanges = 0, freeze = 0, longestFreeze = 0, midBottom: number[] = [], earlyLeader = -1, lastOrder = '';
  let ranks = BOTS.map((_, i) => i);
  for (let t = start; t <= end; t++) {
    const c = { run, t, start, pool, next, rank: 0, players: BOTS.length };
    BOTS.forEach((bot, i) => { if (t < end) bot.act(books[i]!, { ...c, rank: ranks.indexOf(i) + 1 }); });
    const vals = books.map((b) => value(b, run, t));
    ranks = vals.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    if (leader !== -1 && ranks[0] !== leader) leadChanges++;
    leader = ranks[0]!;
    const order = ranks.slice(0, 5).join();
    freeze = order === lastOrder ? freeze + 1 : 0;
    longestFreeze = Math.max(longestFreeze, freeze);
    lastOrder = order;
    if (t === start + ROUND_DAYS / 2) midBottom = ranks.slice(5);
    if (t === start + ROUND_DAYS / 4) earlyLeader = leader;
  }
  const finals = books.map((b) => value(b, run, end));
  const sorted = [...finals].sort((a, b) => b - a);
  let bigMoves = 0, bigCompanies = 0;
  for (const i of pool) {
    const lp = run.logP[i]!;
    for (let t = start + 1; t <= end; t++) if (Math.abs(lp[t]! - lp[t - 1]!) > 0.03) bigMoves++;
    if (Math.abs(lp[end]! - lp[start]!) > 0.15) bigCompanies++;
  }
  const bigSectors = SECTORS.filter((s) => {
    const m = pool.filter((i) => ASSETS[i]!.sector === s);
    return m.length && Math.abs(m.reduce((t, i) => t + run.logP[i]![end]! - run.logP[i]![start]!, 0) / m.length) > 0.05;
  }).length;
  const set = new Set(pool);
  const news = run.news.filter((n) => n.day >= start && n.day < end && (n.scope === 'market' || n.scope === 'factor' || n.assets.some((a) => set.has(a))));
  const days = [start - 1, ...news.map((n) => n.day), end];
  let longestQuiet = 0;
  for (let k = 1; k < days.length; k++) longestQuiet = Math.max(longestQuiet, days[k]! - days[k - 1]!);
  const thirds = [0, 0, 0];
  const kinds: Record<string, number> = {};
  for (const n of news) { thirds[Math.min(2, Math.floor((n.day - start) / (ROUND_DAYS / 3)))]!++; kinds[n.scope] = (kinds[n.scope] ?? 0) + 1; }
  const mk = pool.reduce((t, i) => t + run.logP[i]![end]! - run.logP[i]![start]!, 0) / pool.length;
  const winner = BOTS[finals.indexOf(sorted[0]!)]!.name;
  return {
    leadChanges, closeFinish: sorted[0]! - sorted[1]! < PURSE * 0.02 ? 1 : 0, earlyLock: BOTS[earlyLeader]!.name === winner ? 1 : 0,
    comeback: midBottom.some((i) => finals[i]! >= sorted[2]!) ? 1 : 0, longestFreeze, spread: (sorted[0]! - sorted[sorted.length - 1]!) / PURSE,
    best: sorted[0]! / PURSE - 1, worst: sorted.at(-1)! / PURSE - 1, bigMoves, bigCompanies, bigSectors, stories: news.length, severe: news.filter((n) => n.severity >= 2).length, longestQuiet, storyThirds: thirds, marketMove: mk, winner,
    ret: Object.fromEntries(BOTS.map((b, i) => [b.name, finals[i]! / PURSE - 1])), storyKinds: kinds,
  };
}
