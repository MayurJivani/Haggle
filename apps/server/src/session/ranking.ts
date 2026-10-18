export interface Rankable {
  nickname: string;
  joinedAt: number;
  value: number;
}

/** Highest value first; ties go to whoever joined first, then by nickname, so a rerun ranks identically. */
export function compareRank(a: Rankable, b: Rankable): number {
  return b.value - a.value || a.joinedAt - b.joinedAt || (a.nickname < b.nickname ? -1 : a.nickname > b.nickname ? 1 : 0);
}

/** Mean over standard deviation of per-sample returns; null when there is too little movement to judge. */
export function sharpe(values: number[]): number | null {
  if (values.length < 6) return null;
  const r: number[] = [];
  for (let i = 1; i < values.length; i++) r.push(values[i]! / values[i - 1]! - 1);
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / r.length);
  return sd < 1e-9 ? null : mean / sd;
}

export type Phase = 'lobby' | 'trading' | 'closing' | 'results';

/** Which phase a session is in at `now`, from its times alone. */
export function phaseAt(now: number, opensAt: number, closesAt: number, closingSeconds: number, finished: boolean): Phase {
  if (finished || now >= closesAt) return 'results';
  if (now < opensAt) return 'lobby';
  return now >= closesAt - closingSeconds * 1000 ? 'closing' : 'trading';
}
