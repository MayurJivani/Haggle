import { describe, expect, it } from 'vitest';
import { screenOf } from '../src/session/screen.js';
import type { BoardRow } from '../src/protocol.js';

const row = (rank: number, id: string, value: number): BoardRow => ({ rank, participantId: id, nickname: id, value, cash: value, bps: Math.round(((value - 1000) * 10_000) / 1000), trades: 1, top: null });

describe('event screen', () => {
  it('counts the room and draws the leaders from the bell, late joiners matched from the right', () => {
    const rows = [row(1, 'a', 1500), row(2, 'b', 1000), row(3, 'c', 800)];
    // Sampled at ticks 0, 10, 20; b joined after the bell (its purse pushed at join), c lost its old samples to a restart.
    const samples = new Map([['a', [1000, 1200, 1400]], ['b', [1000, 1000]], ['c', [900]]]);
    const s = screenOf(rows, samples, { start: 1000, tick: 25, every: 10, ended: false, top: 2, lines: 3 });
    expect(s.top.map((r) => r.participantId)).toEqual(['a', 'b']);
    expect([s.count, s.up, s.down, s.avgBps]).toEqual([3, 1, 1, Math.round((5000 + 0 - 2000) / 3)]);
    expect(s.lines[0]!.points).toEqual([[0, 1000], [10, 1200], [20, 1400], [25, 1500]]);
    expect(s.lines[1]!.points).toEqual([[0, 1000], [10, 1000], [20, 1000], [25, 1000]]);
    expect(s.lines[2]!.points).toEqual([[0, 1000], [20, 900], [25, 800]]);
  });

  it('ends on the closing sample and thins long games', () => {
    const long = Array.from({ length: 1001 }, (_, i) => 1000 + i);
    const s = screenOf([row(1, 'a', 2000)], new Map([['a', long]]), { start: 1000, tick: 10_000, every: 10, ended: true, top: 10, lines: 8 });
    const pts = s.lines[0]!.points;
    expect(pts.length).toBeLessThanOrEqual(240);
    expect(pts.at(-1)).toEqual([10_000, 2000]);
    // Closed early on tick 25: the closing sample lands on 25 and the end matches the board.
    const early = screenOf([row(1, 'a', 1300)], new Map([['a', [1000, 1100, 1200, 1300]]]), { start: 1000, tick: 25, every: 10, ended: true, top: 10, lines: 8 });
    expect(early.lines[0]!.points).toEqual([[0, 1000], [10, 1100], [20, 1200], [25, 1300]]);
    expect(screenOf([], new Map(), { start: 1000, tick: 0, every: 10, ended: false, top: 10, lines: 8 }).avgBps).toBe(0);
  });

  it('filters out host when screen is built from engine', () => {
    const rows = [row(1, 'host-id', 2000), row(2, 'player-1', 1500), row(3, 'player-2', 1200)];
    const samples = new Map([['player-1', [1000, 1500]], ['player-2', [1000, 1200]]]);
    const filteredRows = rows.filter((r) => r.participantId !== 'host-id');
    const s = screenOf(filteredRows, samples, { start: 1000, tick: 10, every: 5, ended: false, top: 10, lines: 8 });
    expect(s.top.map((r) => r.participantId)).toEqual(['player-1', 'player-2']);
    expect(s.lines.map((l) => l.participantId)).toEqual(['player-1', 'player-2']);
    expect(s.count).toBe(2);
  });
});
