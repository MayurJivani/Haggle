import type { BoardRow, EventScreen } from '../protocol.js';

/** Most points per line: a two-hour event samples 720 times, a TV needs far fewer. */
const MAX_POINTS = 240;

/**
 * The TV's view of a competition: the top of a ranked board, how the whole room is doing, and the
 * leaders' value lines from the bell to now. `samples` are each trader's values every `every` ticks,
 * taken at the same ticks for everyone; a trader may hold fewer (joined late, or a restart dropped the
 * older ones), so they are matched to the latest sample ticks from the right.
 */
export function screenOf(
  rows: BoardRow[],
  samples: Map<string, number[]>,
  o: { start: number; tick: number; every: number; ended: boolean; top: number; lines: number },
): Pick<EventScreen, 'top' | 'count' | 'up' | 'down' | 'avgBps' | 'lines'> {
  const sampleTicks: number[] = [];
  for (let t = 0; t <= o.tick; t += o.every) sampleTicks.push(t);
  if (o.ended && sampleTicks.at(-1) !== o.tick) sampleTicks.push(o.tick);
  const lines = rows.slice(0, o.lines).map((r) => {
    const s = samples.get(r.participantId) ?? [];
    const k = Math.min(s.length, sampleTicks.length);
    const pts: [number, number][] = [[0, o.start]];
    for (let i = 0; i < k; i++) {
      const t = sampleTicks[sampleTicks.length - k + i]!;
      if (t > 0) pts.push([t, s[s.length - k + i]!]);
    }
    // The line ends on the board's own value, so the chart and the leaderboard never disagree.
    if (o.tick > pts.at(-1)![0]) pts.push([o.tick, r.value]);
    else if (o.tick > 0) pts[pts.length - 1] = [o.tick, r.value];
    const stride = Math.ceil(pts.length / MAX_POINTS);
    return { participantId: r.participantId, nickname: r.nickname, points: stride > 1 ? pts.filter((_, i) => i % stride === 0 || i === pts.length - 1) : pts };
  });
  return {
    top: rows.slice(0, o.top),
    count: rows.length,
    up: rows.filter((r) => r.value > o.start).length,
    down: rows.filter((r) => r.value < o.start).length,
    avgBps: rows.length ? Math.round(rows.reduce((a, r) => a + r.bps, 0) / rows.length) : 0,
    lines,
  };
}
