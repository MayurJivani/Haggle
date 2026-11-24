// RealTime accounting in exact integers (BigInt), never floating point. Units:
//   cash and cost: euro cents
//   quantity: micro-shares (MICRO per share), so fractional shares stay exact to six places
//   price: 1/10,000 of the instrument's currency (PRICE per unit)
//   fx: units of the instrument's currency per euro, scaled by FX
// cents = qty * price / fx. Buys round up and sells round down, so rounding never mints money.

export const MICRO = 1_000_000n;
export const PRICE = 10_000n;
export const FX = 100_000_000n;

export type Side = 'buy' | 'sell';
export type Reject = { ok: false; reason: 'insufficient_cash' | 'insufficient_shares' | 'invalid_quantity' | 'invalid_price' };

export interface Account {
  cash: bigint;
  reserved: bigint;
}
export interface Holding {
  qty: bigint;
  reserved: bigint;
  cost: bigint;
  realized: bigint;
}
export const EMPTY: Holding = { qty: 0n, reserved: 0n, cost: 0n, realized: 0n };

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const roundDiv = (a: bigint, b: bigint) => (2n * a + b) / (2n * b);

/** An exact decimal string (or a provider's number) to an integer at the given scale, rounded half up. */
export function toScaled(x: string | number, scale: bigint): bigint {
  const s = typeof x === 'number' ? x.toFixed(10) : x.trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && !m[3])) throw new Error(`not a decimal: ${x}`);
  const digits = scale.toString().length - 1;
  const frac = (m[3] ?? '').padEnd(digits + 1, '0');
  let v = BigInt((m[2] || '0') + frac.slice(0, digits)) + (Number(frac[digits]) >= 5 ? 1n : 0n);
  return m[1] ? -v : v;
}

export const buyCost = (qty: bigint, price: bigint, fx: bigint) => ceilDiv(qty * price, fx);
export const sellProceeds = (qty: bigint, price: bigint, fx: bigint) => (qty * price) / fx;

export interface Fill {
  ok: true;
  total: bigint;
  realized: bigint;
  account: Account;
  holding: Holding;
}

/**
 * A buy of qty at price. `release` is cash this order had reserved and now gives back (a limit or queued
 * order), so only the rest of the cost must come out of available cash.
 */
export function fillBuy(a: Account, h: Holding, qty: bigint, price: bigint, fx: bigint, release = 0n): Fill | Reject {
  if (qty <= 0n) return { ok: false, reason: 'invalid_quantity' };
  if (price <= 0n || fx <= 0n) return { ok: false, reason: 'invalid_price' };
  const total = buyCost(qty, price, fx);
  if (total > a.cash - a.reserved + release) return { ok: false, reason: 'insufficient_cash' };
  return {
    ok: true, total, realized: 0n,
    account: { cash: a.cash - total, reserved: a.reserved - release },
    holding: { ...h, qty: h.qty + qty, cost: h.cost + total },
  };
}

/** A sell of qty at price. `fromReserved` when the shares were promised to this order already. */
export function fillSell(a: Account, h: Holding, qty: bigint, price: bigint, fx: bigint, fromReserved = false): Fill | Reject {
  if (qty <= 0n) return { ok: false, reason: 'invalid_quantity' };
  if (price <= 0n || fx <= 0n) return { ok: false, reason: 'invalid_price' };
  if (qty > (fromReserved ? h.reserved : h.qty - h.reserved)) return { ok: false, reason: 'insufficient_shares' };
  const total = sellProceeds(qty, price, fx);
  // Average cost: selling everything removes exactly the remaining cost, so no cent is stranded.
  const costOut = qty === h.qty ? h.cost : roundDiv(h.cost * qty, h.qty);
  const realized = total - costOut;
  return {
    ok: true, total, realized,
    account: { cash: a.cash + total, reserved: a.reserved },
    holding: { qty: h.qty - qty, reserved: h.reserved - (fromReserved ? qty : 0n), cost: h.cost - costOut, realized: h.realized + realized },
  };
}

/** Market value of a holding in cents, marked at a price. */
export const markValue = (qty: bigint, price: bigint, fx: bigint) => (qty * price) / fx;

/** A split of `from` old shares into `to` new ones: more shares, same total cost. Returns the new quantities. */
export function split(h: Holding, from: bigint, to: bigint): Holding {
  return { ...h, qty: (h.qty * to) / from, reserved: (h.reserved * to) / from };
}
export const splitPrice = (price: bigint, from: bigint, to: bigint) => roundDiv(price * from, to);

/** A cash dividend on a holding, rounded down. */
export const dividend = (qty: bigint, perShare: bigint, fx: bigint) => (qty * perShare) / fx;

/** Basis points of return: 1234 = +12.34%. */
export const returnBps = (value: bigint, start: bigint) => Number(((value - start) * 10_000n) / start);
