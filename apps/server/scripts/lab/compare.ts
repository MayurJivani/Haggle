// Two lab reports side by side: the A/B every engine change must pass.
//   npx tsx scripts/lab/compare.ts engine-1 engine-2 [--hold 1]
import { readFileSync } from 'node:fs';
const load = (l: string) => JSON.parse(readFileSync(new URL(`../../../../docs/data/lab/${l}.json`, import.meta.url), 'utf8'));
const [a, b] = [load(process.argv[2]!), load(process.argv[3]!)];
const pad = (x: unknown, n: number) => String(x).padEnd(n);
const line = (k: string, x: unknown, y: unknown) => console.log(`${pad(k, 34)} ${pad(x, 12)} ${y}`);
console.log(`\n== gameplay (${a.label} vs ${b.label})`);
for (const k of Object.keys(a.gameplay)) if (k !== 'bots') line(k, JSON.stringify(a.gameplay[k]), JSON.stringify(b.gameplay[k]));
console.log('\n== bots: win share, mean, worst 5%');
for (const x of a.gameplay.bots) { const y = b.gameplay.bots.find((o: any) => o.bot === x.bot); line(x.bot, `${x.winShare} ${x.mean} ${x.worst5}`.padEnd(28), `${y.winShare} ${y.mean} ${y.worst5}`); }
console.log('\n== prices, EUR: p1 / median / p99 / highest ever; % left band');
for (const x of a.prices) { const y = b.prices.find((o: any) => o.years === x.years); if (y) line(`${x.years}y`, `${x.eur.p1} ${x.eur.median} ${x.eur.p99} ${x.highestEverEur} ${x.pctLeftBand}`.padEnd(36), `${y.eur.p1} ${y.eur.median} ${y.eur.p99} ${y.highestEverEur} ${y.pctLeftBand}`); }
for (const h of [1, 5, 10]) {
  console.log(`\n== strategies, core, EUR 10k, hold ${h}: mean excess, beat market, t`);
  const f = (r: any) => r.strategies.filter((s: any) => s.holdRounds === h && s.universe === 'core' && s.budget === 10000);
  for (const x of f(a)) { const y = f(b).find((o: any) => o.strategy === x.strategy); line(x.strategy, `${x.meanExcess} ${x.winVsMarket} ${x.excessT}`.padEnd(26), y ? `${y.meanExcess} ${y.winVsMarket} ${y.excessT}` : '-'); }
}
console.log('\n== anchor, hold 1 and 5: P(up), mean log, P(beat market)');
for (const x of a.anchor) if (x.holdRounds !== 10) { const y = b.anchor.find((o: any) => o.kind === x.kind && o.discount === x.discount && o.holdRounds === x.holdRounds); line(`${x.kind} ${x.discount} h${x.holdRounds}`, `${x.pUp} ${x.meanLog} ${x.pExcess}`.padEnd(24), y ? `${y.pUp} ${y.meanLog} ${y.pExcess}` : '-'); }
