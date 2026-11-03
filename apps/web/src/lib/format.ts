const eur = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
const eurWhole = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

/** Cents to "€1,234.56". */
export const money = (cents: number) => eur.format(cents / 100);
const pointsFmt = new Intl.NumberFormat('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Index levels in hundredths of a point to "1,234.56". */
export const points = (hundredths: number) => pointsFmt.format(hundredths / 100);
export const moneyWhole = (cents: number) => eurWhole.format(cents / 100);
/** Cents to "+€12.34" / "−€12.34" with a real minus sign. */
export const signedMoney = (cents: number) => (cents > 0 ? '+' : cents < 0 ? '−' : '') + eur.format(Math.abs(cents) / 100);
/** Basis points to "+1.23%". */
export const pct = (bps: number) => (bps > 0 ? '+' : bps < 0 ? '−' : '') + (Math.abs(bps) / 100).toFixed(2) + '%';
export const changeBps = (now: number, from: number) => (from ? Math.round(((now - from) * 10_000) / from) : 0);
export const tone = (n: number) => (n > 0 ? 'text-up' : n < 0 ? 'text-down' : 'text-ink-2');

export function clock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
};

export const SECTOR_COLOR: Record<string, string> = {
  Technology: 'var(--color-technology)',
  Semiconductors: 'var(--color-semiconductors)',
  Healthcare: 'var(--color-healthcare)',
  Finance: 'var(--color-finance)',
  Energy: 'var(--color-energy)',
  Automotive: 'var(--color-automotive)',
  Consumer: 'var(--color-consumer)',
  Industrials: 'var(--color-industrials)',
  'E-commerce': 'var(--color-ecommerce)',
  Telecom: 'var(--color-telecom)',
  'Aerospace & Defence': 'var(--color-aerospace)',
  Materials: 'var(--color-materials)',
  'Food & Beverage': 'var(--color-food)',
  Media: 'var(--color-media)',
  Logistics: 'var(--color-logistics)',
};

/** EUR millions to "EUR 1.2bn" style figures for financial tables. */
export const millions = (m: number) => {
  const sign = m < 0 ? '−' : '';
  const a = Math.abs(m);
  return `${sign}€${a >= 1000 ? `${(a / 1000).toFixed(1)}bn` : `${a.toFixed(0)}m`}`;
};
export const eps = (x: number) => (x < 0 ? '−' : '') + '€' + Math.abs(x).toFixed(2);
/** A fraction to a signed percentage: 0.123 to "+12.3%". */
export const ratio = (x: number | null, digits = 1) => (x === null ? 'N/A' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(digits) + '%');

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
/** Wall-clock time of an event: seconds today, the date before that. */
export const when = (ms: number, nowMs = Date.now()) => (nowMs - ms < 20 * 3_600_000 ? timeFmt.format(ms) : dayFmt.format(ms));


/**
 * A trader's lattice: which windows of a 5 by 5 carved screen are lit, mirrored left to right, from the
 * nickname (unique per trader, so the same face follows them from game to game). Never fewer than six lit.
 */
export function lattice(nickname: string): boolean[] {
  let h = 0x811c9dc5;
  for (const ch of nickname.toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  const cells = Array.from({ length: 25 }, (_, i) => {
    const col = i % 5;
    const half = col < 3 ? col : 4 - col;
    return ((h >>> (Math.floor(i / 5) * 3 + half)) & 1) === 1;
  });
  // A sparse hash still reads as a screen: light the centre column.
  if (cells.filter(Boolean).length < 6) for (let r = 0; r < 5; r++) cells[r * 5 + 2] = true;
  return cells;
}
