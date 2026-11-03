import { describe, expect, it } from 'vitest';
import { lattice } from './format';
import { awardMoments, leadChanges, valueAt, type Replay } from './replay';

const race: Replay = {
  ticks: [0, 10, 20, 30], tickMs: 1000, opensAt: 0, closingTicks: 10, start: 100,
  players: [
    { participantId: 'a', nickname: 'Ada', rank: 1, values: [100, 90, 80, 130], ranks: [null, 2, 2, 1] },
    { participantId: 'b', nickname: 'Bo', rank: 2, values: [100, 110, null, 120], ranks: [null, 1, 1, 2] },
  ],
  news: [],
};

describe('race replay', () => {
  it('reads a value between, on and past the snapshots', () => {
    expect(valueAt(race.ticks, race.players[0]!.values, 5)).toBe(95);
    expect(valueAt(race.ticks, race.players[0]!.values, 20)).toBe(80);
    expect(valueAt(race.ticks, race.players[0]!.values, 99)).toBe(130);
    // A snapshot that missed the trader leaves a gap, not a made-up value.
    expect(valueAt(race.ticks, race.players[1]!.values, 15)).toBeNull();
  });

  it('counts the lead changing hands, not the level start', () => {
    expect(leadChanges(race)).toBe(1);
  });

  it('places the awards whose moment the race shows, and skips one the snapshots missed', () => {
    const awards = [
      { id: 'winner', label: 'Top of the market', nickname: 'Ada' },
      { id: 'comeback', label: 'Back from the brink', nickname: 'Ada' },
      { id: 'closer', label: 'Last-call hero', nickname: 'Bo' },
      { id: 'busy', label: 'Busiest stall', nickname: 'Bo' },
      { id: 'winner', label: 'Off the chart', nickname: 'Nobody' },
    ];
    expect(awardMoments(race, awards)).toEqual([
      { label: 'Top of the market', who: 'a', tick: 30, value: 130 },
      { label: 'Back from the brink', who: 'a', tick: 20, value: 80 },
    ]);
  });
});

describe('lattice faces', () => {
  it('is mirrored, never sparse, the same for one trader and different across traders', () => {
    const names = ['Ada', 'Bo', 'x', 'Trader 42', 'zz'];
    for (const n of names) {
      const c = lattice(n);
      for (let r = 0; r < 5; r++) expect([c[r * 5], c[r * 5 + 1]]).toEqual([c[r * 5 + 4], c[r * 5 + 3]]);
      expect(c.filter(Boolean).length).toBeGreaterThanOrEqual(6);
      expect(lattice(n.toUpperCase())).toEqual(c);
    }
    expect(new Set(names.map((n) => lattice(n).join())).size).toBe(names.length);
  });
});
