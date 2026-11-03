import type { Replay } from '../../../server/src/protocol';

export type { Replay };
type Line = Replay['players'][number];

/** A trader's value at any moment of the race, straight between snapshots; null where a snapshot missed them. */
export function valueAt(ticks: number[], values: (number | null)[], t: number): number | null {
  const j = ticks.findIndex((x) => x >= t);
  if (j === -1) return values.at(-1) ?? null;
  if (j === 0 || ticks[j] === t) return values[j] ?? null;
  const a = values[j - 1];
  const b = values[j];
  if (a == null || b == null) return null;
  return a + ((b - a) * (t - ticks[j - 1]!)) / (ticks[j]! - ticks[j - 1]!);
}

/** How many times first place changed hands between snapshots (the bell, where everyone is level, does not count). */
export function leadChanges(race: Replay): number {
  let leader: string | null = null;
  let n = 0;
  for (let i = 1; i < race.ticks.length; i++) {
    const first = race.players.find((p) => p.ranks[i] === 1)?.participantId ?? null;
    if (first && leader && first !== leader) n++;
    if (first) leader = first;
  }
  return n;
}

/** Awards whose moment the race shows: where it was decided, on whose line. */
export function awardMoments(race: Replay, awards: { id: string; label: string; nickname: string }[]): { label: string; tick: number; value: number; who: string }[] {
  const end = race.ticks.at(-1) ?? 0;
  const tickOf = (id: string, p: Line) => {
    if (id === 'winner') return end;
    if (id === 'closer') return Math.max(0, end - race.closingTicks);
    if (id !== 'comeback') return null;
    // The low the climb started from: the line's lowest snapshot.
    let low = 0;
    p.values.forEach((v, i) => { if (v !== null && v < (p.values[low] ?? Infinity)) low = i; });
    return race.ticks[low]!;
  };
  return awards.flatMap((a) => {
    const p = race.players.find((x) => x.nickname === a.nickname);
    const tick = p ? tickOf(a.id, p) : null;
    const value = p && tick !== null ? valueAt(race.ticks, p.values, tick) : null;
    return p && tick !== null && value !== null ? [{ label: a.label, tick, value, who: p.participantId }] : [];
  });
}
