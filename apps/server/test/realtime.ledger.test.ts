import { describe, expect, it } from 'vitest';
import { EMPTY, fillBuy, fillSell, FX, markValue, MICRO, PRICE, split, splitPrice, toScaled } from '../src/realtime/ledger.js';
import { fxScaled, priceStatus } from '../src/realtime/market.js';
import { fillPrice } from '../src/realtime/trading.js';
import { parseTradegateList } from '../src/realtime/catalogue.js';
import { deNum, tradegateQuote } from '../src/realtime/providers/tradegate.js';
import type { Quote } from '../src/realtime/types.js';

const eur = FX; // 1 EUR per EUR
const usd = toScaled('1.25', FX); // 1.25 USD per EUR

describe('realtime ledger', () => {
  it('parses decimals exactly', () => {
    expect(toScaled('187.4321', PRICE)).toBe(1_874_321n);
    expect(toScaled('0.1', PRICE)).toBe(1000n);
    expect(toScaled('1.08745', FX)).toBe(108_745_000n);
    expect(toScaled(0.30000000000000004, PRICE)).toBe(3000n);
  });

  it('buys, averages cost and realises profit on a partial sale', () => {
    const a = { cash: 1_000_000n, reserved: 0n };
    const b1 = fillBuy(a, EMPTY, 10n * MICRO, 100n * PRICE, eur);
    if (!b1.ok) throw new Error();
    expect(b1.total).toBe(100_000n); // 10 x EUR 100
    const b2 = fillBuy(b1.account, b1.holding, 10n * MICRO, 120n * PRICE, eur);
    if (!b2.ok) throw new Error();
    expect(b2.holding.cost).toBe(220_000n); // average EUR 110
    const s = fillSell(b2.account, b2.holding, 5n * MICRO, 130n * PRICE, eur);
    if (!s.ok) throw new Error();
    expect(s.realized).toBe(10_000n); // 5 x (130 - 110)
    expect(s.holding.cost).toBe(165_000n);
    expect(s.account.cash).toBe(1_000_000n - 220_000n + 65_000n);
    const all = fillSell(s.account, s.holding, 15n * MICRO, 100n * PRICE, eur);
    if (!all.ok) throw new Error();
    // Selling everything takes exactly the remaining cost: nothing strands.
    expect(all.holding).toEqual({ qty: 0n, reserved: 0n, cost: 0n, realized: 10_000n - 15_000n });
  });

  it('converts a foreign price to euro, rounding buys up and sells down', () => {
    // 1 share at USD 100.0001 with 1.25 USD per EUR = EUR 80.00008: buy pays 8001 cents, sell gets 8000.
    const a = { cash: 1_000_000n, reserved: 0n };
    const b = fillBuy(a, EMPTY, MICRO, 1_000_001n, usd);
    if (!b.ok) throw new Error();
    expect(b.total).toBe(8001n);
    const s = fillSell(b.account, b.holding, MICRO, 1_000_001n, usd);
    if (!s.ok) throw new Error();
    expect(s.total).toBe(8000n);
    expect(s.realized).toBe(-1n);
  });

  it('handles fractional shares to the micro-share', () => {
    const b = fillBuy({ cash: 100_000n, reserved: 0n }, EMPTY, 333_333n, 300n * PRICE, eur); // 0.333333 x EUR 300
    if (!b.ok) throw new Error();
    expect(b.total).toBe(10_000n); // EUR 99.9999 rounds up to EUR 100.00
  });

  it('refuses what it cannot pay for or does not own', () => {
    expect(fillBuy({ cash: 999n, reserved: 0n }, EMPTY, MICRO, 10n * PRICE, eur)).toEqual({ ok: false, reason: 'insufficient_cash' });
    // Cash held back for an open order is not available.
    expect(fillBuy({ cash: 2000n, reserved: 1500n }, EMPTY, MICRO, 10n * PRICE, eur)).toEqual({ ok: false, reason: 'insufficient_cash' });
    const h = { qty: 5n * MICRO, reserved: 3n * MICRO, cost: 500n, realized: 0n };
    expect(fillSell({ cash: 0n, reserved: 0n }, h, 3n * MICRO, PRICE, eur)).toEqual({ ok: false, reason: 'insufficient_shares' });
    expect(fillSell({ cash: 0n, reserved: 0n }, h, 2n * MICRO, PRICE, eur).ok).toBe(true);
    expect(fillBuy({ cash: 1000n, reserved: 0n }, EMPTY, 0n, PRICE, eur)).toEqual({ ok: false, reason: 'invalid_quantity' });
  });

  it('keeps value and cost through a split', () => {
    const h = { qty: 10n * MICRO, reserved: 2n * MICRO, cost: 400_000n, realized: 0n };
    const after = split(h, 1n, 4n);
    expect(after).toEqual({ qty: 40n * MICRO, reserved: 8n * MICRO, cost: 400_000n, realized: 0n });
    const price = 400n * PRICE;
    expect(markValue(after.qty, splitPrice(price, 1n, 4n), eur)).toBe(markValue(h.qty, price, eur));
  });

  it('values LSE pence quotes in pounds', () => {
    const rates = new Map([['GBP', '0.8']]);
    const pence = fxScaled(rates, 'GBp')!;
    // 100 shares at 250p = GBP 250 = EUR 312.50.
    expect(markValue(100n * MICRO, 250n * PRICE, pence)).toBe(31_250n);
    expect(fxScaled(rates, 'JPY')).toBeNull();
  });
});

describe('tradegate parsing', () => {
  it('reads German number strings and the index member list', () => {
    expect(deNum('1 216,40')).toBe(1216.4);
    expect(deNum('+1,10')).toBe(1.1);
    expect(deNum(53.22)).toBe(53.22);
    expect(deNum('53.22')).toBe(53.22);
    expect(deNum('1.216,40')).toBe(1216.4);
    expect(deNum('')).toBeNull();
    const q = tradegateQuote(7, { bid: '189,06', ask: 189.1, bidsize: 350, asksize: 250, last: '189,10', high: '189,60', low: 183.74, close: 187.1, stueck: 43103 }, 1000)!;
    expect([q.bid, q.ask, q.last, q.prevClose, q.volume]).toEqual([1_890_600, 1_891_000, 1_891_000, 1_871_000, 43103]);
    expect(tradegateQuote(7, {}, 1000)).toBeNull();
    expect(parseTradegateList('<a id="name_1" href="orderbuch.php?isin=DE000A1EWWW0">adidas AG&nbsp;</a><a href="orderbuch.php?isin=DE000A1EWWW0">x</a>'))
      .toEqual([{ isin: 'DE000A1EWWW0', name: 'x' }]);
    expect(parseTradegateList('<a href="orderbuch.php?isin=FR0000121014">LVMH Mo&euml;t &amp; M&uuml;nchener Gro&szlig;</a>')[0]!.name).toBe('LVMH Moët & Münchener Groß');
  });
});

const quote = (p: Partial<Quote>): Quote => ({
  id: 1, last: null, bid: null, ask: null, bidSize: null, askSize: null, open: null, high: null, low: null, prevClose: null, volume: null,
  at: 0, quality: 'realtime', delayMin: 0, source: 'test', ...p,
});

describe('fill policy', () => {
  const policy = { slippageBps: 10, maxSpreadBps: 200 };
  it('buys at the ask and sells at the bid', () => {
    const q = quote({ bid: 99_900, ask: 100_100, last: 100_000 });
    expect(fillPrice(q, 'buy', policy)).toEqual({ price: 100_100, basis: 'ask' });
    expect(fillPrice(q, 'sell', policy)).toEqual({ price: 99_900, basis: 'bid' });
  });
  it('falls back to the last trade plus slippage when there is no usable book', () => {
    expect(fillPrice(quote({ last: 100_000 }), 'buy', policy)).toEqual({ price: 100_100, basis: 'last+10bps' });
    expect(fillPrice(quote({ last: 100_000 }), 'sell', policy)).toEqual({ price: 99_900, basis: 'last-10bps' });
    // A 10% spread is not a market to trade on.
    expect(fillPrice(quote({ bid: 95_000, ask: 105_000, last: 100_000 }), 'buy', policy)?.basis).toBe('last+10bps');
    expect(fillPrice(quote({}), 'buy', policy)).toBeNull();
  });
  it('labels prices stale, closed or by quality', () => {
    const open = Date.parse('2026-11-24T15:00:00Z');
    expect(priceStatus(undefined, 'US', open, 60_000)).toBe('none');
    expect(priceStatus(quote({ last: 1, at: open - 5000 }), 'US', open, 60_000)).toBe('realtime');
    expect(priceStatus(quote({ last: 1, at: open - 120_000 }), 'US', open, 60_000)).toBe('stale');
    // A 15-minute delayed feed is not stale at 15 minutes old, and is labelled delayed.
    expect(priceStatus(quote({ last: 1, at: open - 15 * 60_000 - 5000, quality: 'delayed', delayMin: 15 }), 'US', open, 60_000)).toBe('delayed');
    expect(priceStatus(quote({ last: 1, at: open - 120_000 }), 'US', Date.parse('2026-11-28T15:00:00Z'), 60_000)).toBe('closed');
  });
});
