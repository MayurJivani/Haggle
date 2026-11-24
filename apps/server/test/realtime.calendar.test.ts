import { describe, expect, it } from 'vitest';
import { exchangeStatus, sessionsOn, EXCHANGES, tradable, wallToUtc } from '../src/realtime/calendar.js';

const at = (iso: string) => Date.parse(iso);

describe('exchange calendar', () => {
  it('opens New York at 09:30 local on both sides of the March DST change', () => {
    // US clocks spring forward on 2026-03-08: 14:30Z before, 13:30Z after.
    expect(sessionsOn(EXCHANGES.US, '2026-03-06')!.open).toBe(at('2026-03-06T14:30:00Z'));
    expect(sessionsOn(EXCHANGES.US, '2026-03-09')!.open).toBe(at('2026-03-09T13:30:00Z'));
    // ...and back on 2026-11-01.
    expect(sessionsOn(EXCHANGES.US, '2026-10-30')!.close).toBe(at('2026-10-30T20:00:00Z'));
    expect(sessionsOn(EXCHANGES.US, '2026-11-02')!.close).toBe(at('2026-11-02T21:00:00Z'));
  });

  it('keeps London on its own DST dates, not New York\'s', () => {
    // Between the US change (03-08) and the UK one (03-29) the gap between the two opens is an hour shorter.
    expect(sessionsOn(EXCHANGES.LSE, '2026-03-20')!.open).toBe(at('2026-03-20T08:00:00Z'));
    expect(sessionsOn(EXCHANGES.LSE, '2026-03-30')!.open).toBe(at('2026-03-30T07:00:00Z'));
  });

  it('reports the US session states through a trading day', () => {
    const d = '2026-11-24';
    expect(exchangeStatus('US', at(`${d}T08:59:00Z`)).state).toBe('closed');
    expect(exchangeStatus('US', at(`${d}T09:00:00Z`)).state).toBe('pre');
    expect(exchangeStatus('US', at(`${d}T14:30:00Z`)).state).toBe('open');
    // One second before the bell is still open; the bell itself is after-hours.
    expect(exchangeStatus('US', at(`${d}T20:59:59Z`)).state).toBe('open');
    const post = exchangeStatus('US', at(`${d}T21:00:00Z`));
    expect(post.state).toBe('post');
    expect(post.until).toBe(at(`2026-11-25T01:00:00Z`));
    expect(exchangeStatus('US', at(`2026-11-25T01:00:00Z`)).state).toBe('closed');
  });

  it('closes for Thanksgiving and closes early the day after', () => {
    const s = exchangeStatus('US', at('2026-11-26T16:00:00Z'));
    expect(s.state).toBe('holiday');
    expect(s.note).toBe('Thanksgiving');
    expect(s.nextOpen).toBe(at('2026-11-27T14:30:00Z'));
    const fri = sessionsOn(EXCHANGES.US, '2026-11-27')!;
    expect(fri.early).toBe(true);
    expect(fri.close).toBe(at('2026-11-27T18:00:00Z'));
    expect(exchangeStatus('US', at('2026-11-27T18:00:01Z')).state).toBe('post');
  });

  it('skips the weekend to Monday', () => {
    const s = exchangeStatus('US', at('2026-11-28T15:00:00Z'));
    expect(s.state).toBe('closed');
    expect(s.note).toBe('Weekend');
    expect(s.nextOpen).toBe(at('2026-11-30T14:30:00Z'));
    expect(s.tradingDate).toBe('2026-11-30');
  });

  it('pauses Tokyo for lunch and knows its holidays', () => {
    expect(exchangeStatus('TSE', at('2026-11-24T01:00:00Z')).state).toBe('open');
    const lunch = exchangeStatus('TSE', at('2026-11-24T03:00:00Z'));
    expect(lunch.state).toBe('break');
    expect(lunch.until).toBe(at('2026-11-24T03:30:00Z'));
    expect(exchangeStatus('TSE', at('2026-11-24T06:29:00Z')).state).toBe('open');
    expect(exchangeStatus('TSE', at('2026-11-24T06:30:00Z')).state).toBe('closed');
    expect(exchangeStatus('TSE', at('2026-11-23T01:00:00Z')).state).toBe('holiday');
  });

  it('lets several exchanges trade at once and each keep its own state', () => {
    // 14:45Z on a Tuesday in November: London and New York both open, Tokyo shut.
    const t = at('2026-11-24T14:45:00Z');
    expect(exchangeStatus('LSE', t).state).toBe('open');
    expect(exchangeStatus('US', t).state).toBe('open');
    expect(exchangeStatus('TSE', t).state).toBe('closed');
    expect(exchangeStatus('XETRA', t).state).toBe('open');
  });

  it('lets only limit orders trade in extended hours', () => {
    expect(tradable('open', 'market', true)).toBe(true);
    expect(tradable('pre', 'market', true)).toBe(false);
    expect(tradable('pre', 'limit', true)).toBe(true);
    expect(tradable('post', 'limit', false)).toBe(false);
    expect(tradable('closed', 'limit', true)).toBe(false);
  });

  it('converts a wall time in a spring-forward gap to just after the gap', () => {
    // 02:30 on 2026-03-08 does not exist in New York.
    expect(wallToUtc('2026-03-08', '02:30', 'America/New_York')).toBe(at('2026-03-08T07:30:00Z'));
  });
});
