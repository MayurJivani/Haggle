import { describe, expect, it } from 'vitest';
import { pickAwards, type AwardPlayer } from '../src/session/awards.js';

const START = 1_000_000;
const player = (nickname: string, o: Partial<AwardPlayer>): AwardPlayer => ({
  nickname, joinedAt: nickname.charCodeAt(0), value: START, trades: 0, samples: [START], eventGain: 0, pnl: [], ...o,
});
const who = (awards: ReturnType<typeof pickAwards>, id: string) => awards.find((a) => a.id === id)?.nickname;

describe('awards', () => {
  const field = [
    player('ann', { value: 1_300_000, trades: 12, pnl: [{ ticker: 'NVDA', pnl: 350_000 }, { ticker: 'KO', pnl: -50_000 }], samples: [START, 1_050_000, 1_100_000, 1_200_000], eventGain: 40_000 }),
    player('bob', { value: 1_100_000, trades: 2, pnl: [{ ticker: 'PG', pnl: 100_000 }], samples: [START, 1_020_000, 1_040_000, 1_060_000] }),
    player('cat', { value: 1_050_000, trades: 6, pnl: ['A', 'B', 'C', 'D', 'E', 'F'].map((ticker) => ({ ticker, pnl: 10_000 })), samples: [START, 800_000, 900_000, 1_040_000] }),
    player('dan', { value: 700_000, trades: 3, pnl: [{ ticker: 'TSLA', pnl: -300_000 }], samples: [START, 900_000, 800_000, 750_000] }),
    player('eve', {}),
  ];
  const a = pickAwards(field, START, 1);

  it('each goes to who earned it', () => {
    expect(who(a, 'winner')).toBe('ann');
    expect(who(a, 'call')).toBe('ann');
    expect(a.find((x) => x.id === 'call')!.detail).toContain('NVDA');
    expect(who(a, 'crier')).toBe('ann');
    expect(who(a, 'comeback')).toBe('cat');
    expect(who(a, 'closer')).toBe('ann');
    expect(who(a, 'patient')).toBe('bob');
    expect(who(a, 'busy')).toBe('ann');
    expect(who(a, 'bazaar')).toBe('cat');
    expect(who(a, 'bonfire')).toBe('dan');
    expect(who(a, 'mattress')).toBe('eve');
  });

  it('the spoon needs a real field and a real loss', () => {
    expect(who(a, 'spoon')).toBe('dan'); // someone who never traded keeps a full purse, so ranks above a loser
    expect(who(pickAwards(field.slice(2, 4), START, 1), 'spoon')).toBeUndefined();
    expect(who(pickAwards(field.slice(0, 3), START, 1), 'spoon')).toBeUndefined();
  });

  it('no award without earning it: an empty or idle competition, a lone trader', () => {
    expect(pickAwards([], START, 1)).toEqual([]);
    expect(pickAwards([player('eve', {}), player('fay', {})], START, 1).map((x) => x.id)).toEqual(['winner']);
    const alone = pickAwards([player('ann', { value: 990_000, trades: 1, pnl: [{ ticker: 'KO', pnl: -10_000 }], samples: [START, 995_000] })], START, 1);
    expect(alone.map((x) => x.id)).toEqual(['winner', 'bonfire']);
  });

  it('is deterministic: ties go to the higher rank, whatever order players arrive in', () => {
    const tied = [player('zed', { value: 1_100_000, trades: 6, pnl: [{ ticker: 'A', pnl: 5 }] }), player('amy', { value: 1_200_000, trades: 6, pnl: [{ ticker: 'B', pnl: 5 }] })];
    expect(pickAwards(tied, START, 1)).toEqual(pickAwards([...tied].reverse(), START, 1));
    expect(who(pickAwards(tied, START, 1), 'busy')).toBe('amy');
  });
});
