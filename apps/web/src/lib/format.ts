const eur = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
const eurWhole = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

/** Cents to "€1,234.56". */
export const money = (cents: number) => eur.format(cents / 100);
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
};
