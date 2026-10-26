// Small statistics shared by the history measurement, the simulation measurement and the tests.

export const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;

export const sd = (x: number[]) => {
  const m = mean(x);
  return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1));
};

export const skew = (x: number[]) => {
  const m = mean(x);
  const s = sd(x);
  return x.reduce((a, v) => a + ((v - m) / s) ** 3, 0) / x.length;
};

/** Raw (not excess) kurtosis: 3 for a normal distribution. */
export const kurtosis = (x: number[]) => {
  const m = mean(x);
  const s = sd(x);
  return x.reduce((a, v) => a + ((v - m) / s) ** 4, 0) / x.length;
};

export const corr = (a: number[], b: number[]) => {
  const n = Math.min(a.length, b.length);
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
};

/** Autocorrelation at one lag. */
export const acf = (x: number[], lag: number) => corr(x.slice(0, -lag), x.slice(lag));

/** Peak-to-trough falls deeper than `min` in a log-level series, deepest first, with recovery dates. */
export function drawdowns(series: { date: string; lv: number }[], min: number) {
  const out: { peak: string; trough: string; recovered: string | null; depth: number; daysToTrough: number; daysToRecover: number | null }[] = [];
  let peak = 0;
  let trough = 0;
  for (let i = 1; i <= series.length; i++) {
    const done = i === series.length || series[i]!.lv >= series[peak]!.lv;
    if (!done) {
      if (series[i]!.lv < series[trough]!.lv) trough = i;
      continue;
    }
    const depth = Math.exp(series[trough]!.lv - series[peak]!.lv) - 1;
    if (depth <= -min) {
      out.push({
        peak: series[peak]!.date, trough: series[trough]!.date, recovered: i < series.length ? series[i]!.date : null,
        depth: Math.round(depth * 1e4) / 1e4, daysToTrough: trough - peak, daysToRecover: i < series.length ? i - peak : null,
      });
    }
    peak = i;
    trough = i;
  }
  return out.sort((a, b) => a.depth - b.depth);
}
