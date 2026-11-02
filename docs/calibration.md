# Calibration

Each parameter of the market model, where its value comes from, and how the simulated market compares with history. The labels mean:

- **Measured:** taken directly from data in [data/history-stats.json](data/history-stats.json).
- **Tuned:** set so a simulated statistic matches a measured one.
- **Gameplay:** a choice about how the game feels, documented as such.

## Reproducing

```bash
cd apps/server
sh scripts/calibration/fetch-history.sh .history               # public series, never committed
npx tsx scripts/calibration/measure-history.ts .history        # writes docs/data/history-stats.json
npx tsx scripts/calibration/run-sim.ts 400                     # writes docs/data/sim-stats.json and prints the table below
```

- **The simulation run:** 40 independent ten-year episodes from a fresh market (seeds 1000 to 1039), stitched into one 400-year record, with the game's full news schedule and quiet quarterly filings. It takes about a minute.
- **Why ten-year episodes:** that is roughly the horizon a persistent game market lives through (a hundred competitions is about 25 simulated years). On longer runs, the cap-weighted index of a fixed 75-company listing drifts toward the two or three companies that compounded fastest.
- **Which market series:** the listing's cap-weighted index is concentrated (six technology companies are half of it), so it is not comparable to a 4,000-stock market. Market statistics use the 15 sector indices weighted equally, each cap-weighted inside.

## Parameters

| Parameter | Value | Kind | Basis |
| --- | --- | --- | --- |
| `DAYS_PER_TICK` | 0.1 | Gameplay | A 600-tick competition is about a quarter: one report per company per competition |
| `marketVol` | 16.3% a year | Measured | US market daily log-return sd 1963 to 2026 |
| `marketShare` | 0.8 | Tuned | The whole index (factor, sectors, companies, news, jumps) lands near the measured 16.3% |
| `driftExpansion`, `driftRecession` | +12.1%, −3.8% a year | Measured | Market log return outside and inside NBER recessions |
| `varExpansion`, `varRecession` | 0.8, 2.62 | Measured | Volatility 14.5% and 26.3% outside and inside recessions, recessions 11.2% of days, normalised to a long-run mean of 1 |
| `garchAlpha`, `garchGamma`, `garchBeta` | 0.01, 0.04, 0.9695 | Tuned | Persistence 0.9995 per tick; tuned toward the measured clustering and leverage effect |
| `expansionTicks`, `recessionTicks` | 58.4 and 10.2 months | Measured | NBER expansion and recession lengths since 1945 |
| `recessionDemand` | 0.6 | Gameplay | How hard a recession leans on a sector, times its 2007 to 2009 loss ratio |
| `SECTOR_PROFILE.residual` | 6.7% to 16.5% a year | Measured | Each matching US industry's volatility beyond its market beta |
| `SECTOR_PROFILE.crisis` | 0.53 to 1.88 | Measured (one episode) | Industry log loss October 2007 to March 2009 over the market's |
| `creditExpansion`, `creditRecession` | 1.9, 3.6 points | Gameplay, guided by data | Baa spread averaged 2.06 (1990 to 2006), 1.48 low (2005), 6.16 peak (2008) |
| `creditVol` | 0.036 points a day | Measured | sd of daily spread changes |
| `creditHalfLife` | 120 trading days | Tuned | The measured 520-day half-life mixes regimes; within one the spread moves faster |
| `creditMarket` | −0.0316 per point | Measured | Market return per point of same-day spread widening |
| `creditExposed` | −0.03 per point | Gameplay | Extra for fully credit-exposed companies (banks, small, indebted) |
| `creditTightAt`, `creditEasyAt` | 3.0, 2.2 points | Gameplay | When tightening and easing are reported (hysteresis) |
| `demandHalfLife`, `demandScale` | 14 months, 4% a year | Tuned | Industry momentum (measured: correlation 0.058, leaders over laggards 0.59% a month) |
| `idioInfo`, `reversion` | 0.7, 0.002 | Tuned | Share of company noise that is lasting news, and how fast the rest reverts. Lower values made buying the worst recent mover a free edge |
| `reportTrust` | 0.15 | Tuned | How far a report moves hidden value. At 1 the fair-value exploit was 82% over ten rounds |
| `growthFromNews`, `demandFromShock`, `surpriseGrowth` | 1.5e-4, 5e-5, 3e-6 | Tuned | Persistence of company, sector and earnings news. Eight times larger made recent winners beat the market 78% a round |
| `garchAlpha`, `garchGamma`, `garchBeta`, `varLongAlpha`, `marketShare` | 0.015, 0.06, 0.9545, 0.004, 0.87 | Tuned | Short-term clustering, leverage effect, market volatility |
| `runawayRate`, `runawayMax` | a quarter-year constant, 300% a year | Gameplay | Upper limit on rare runaways: beyond 9x seed or so |
| `growthHalfLife`, `growthVol` | 12 months, 9e-7 | Tuned | Stock momentum (measured: 6.4% a year) |
| `specThreshold`, `specFeedback`, `specMax` | 20% lead, 0.0035, 100% a year | Tuned | Crash risk after a doubling (measured: 30% against a 6.7% base), without inflating momentum |
| `specHalfLife`, `trendHalfLife`, `frothHalfLife` | 3, 3, 30 months | Gameplay | Enthusiasm fades within a few quarters; the premium it built fades over years |
| `sectorHazard`, `heatSlope` | 1 in 80 years per sector, 10 | Tuned | Run-up and crash frequencies |
| `marketHazard`, `marketHeatSlope` | 1 in 150 months, 7 | Gameplay | Panics rare: about one in 18 years in simulation |
| `creditHazard`, `recessionPanic` | 0.5, 1.5 | Gameplay | Crashes likelier when credit is tight and in recessions |
| `panicJump`, `panicVariance`, `panicCredit` | 3 to 9%, +4, 0.25 to 0.75 points | Gameplay | A panic is a jump plus a volatility spike, as in 1987 and 2020 |
| `crashVariance`, `crashCredit` | +0.5, +0.05 (bank crash +0.3) | Gameplay | A sector crash shakes the market a little |
| `storyVariance` | +0.2 | Gameplay | A market-wide story lifts volatility a little |
| `sizeVol` | 8.7% a year | Measured | The SMB factor's sd since 1963 |
| `sizeBeta` | 0.12 | Measured | Monthly beta 1.12 for the smallest decile and 0.93 for the largest |
| `liquidity` | 0.3 | Gameplay | Small companies' own noise rises with market stress |
| `idioInfo` | 0.5 | Gameplay | Half a company's own noise is news about its value |
| `fragility`, `fragilityCap` | 1, 1 | Gameplay | Bad news hurts a stretched stock more, at most twice |
| `STORY_SCALE` | 0.6 | Tuned | Company and sector stories at 60% of template strength, so news does not swamp the measured volatility |
| Macro and market stories | 30% and 25% of former size | Tuned | A rate story moves a fully exposed company about 1 to 2% (Bernanke and Kuttner 2005: about 1% per 25bp surprise) |
| Readout surprise | log(value / last fair), ±40%, ±2% noise | Gameplay | Reports follow the business with about a year's lag |
| `reversion`, `sentimentHalfLife`, `transientHalfLife`, bounds | unchanged | Earlier model | Keep the headline exploit closed and prices valid |

## Validation

Everything here was measured on tag `engine-2-rc4`. Raw reports are in [data/lab/](data/lab/): `engine-1.json` is the baseline (tag `engine-1-lab`), `engine-2.json` the current engine, `load-matrix.txt` the load tests. Reproduce with `node --import tsx scripts/lab/run.ts <label>` and compare with `npx tsx scripts/lab/compare.ts engine-1 <label>`. `LAB_SET='{"param":value}'` runs an experiment without changing code.

Seeds: 200 independent markets over 160 years for prices (seeds from 10000), 200 over 10 years for strategies (from 20000), 2,000 over 2 years for bot rounds (from 30000, 16,000 rounds), and 40 ten-year episodes for the table below.

### Against history (400 simulated years)

History's mean is total return and Haggle has no dividends, so the like-for-like target is lower than the figure shown, by the dividend yield (not measured in our data).

| Statistic | History | Engine 1 | Engine 2 |
| --- | --- | --- | --- |
| Market volatility, annual | 16.3% | 15.5% | 15.6% |
| Market mean, annual log | 10.3% (with dividends) | 7.4% | 6.3% |
| Daily excess kurtosis | 18.1 | 8.5 | 10.1 |
| Daily skew | -0.77 | -0.45 | -0.61 |
| Absolute-return autocorrelation, lag 1 | 0.26 | 0.24 | 0.25 |
| Same, lag 20 | 0.20 | 0.18 | 0.14 |
| Same, lag 120 | 0.09 | 0.06 | 0.02 |
| Leverage effect | -0.090 | -0.029 | -0.060 |
| Days beyond 3 sd | 1.43% | 1.51% | 1.51% |
| Sector correlation, calm / stressed | 0.64 / 0.88 | 0.41 / 0.85 | 0.41 / 0.87 |
| Annual mean, recession / outside | -3.8% / 12.1% | -5.9% / 9.5% | -8.4% / 9.2% |
| Stock momentum, mean | 6.4% | 1.7% | 7.4% |
| Industry momentum, correlation | 0.058 | 0.065 | 0.100 |
| Sector leaders over laggards, per month | 0.59% | 0.12% | 0.52% |
| 40% crash in 2 years, base / after doubling | 6.7% / 30% | 5.6% / 18% | 8.3% / 18% |
| Sector-months after a doubling | 3.5% | 1.9% | 3.0% |
| Drawdowns per 100 years over 25% / 40% | 11 / about 5 | 9.5 / 4.25 | 8 / 4.5 |

Worse than engine 1: volatility memory at 20 and 120 days, the market mean, and how often sectors crash without a run-up. The first is the known cost of tuning to short-term clustering and the leverage effect, and matters least in rounds of minutes.

### Prices over the life of a server

All 150 companies, 200 markets. One round is about a quarter of a simulated year. An earlier "EUR 3 to EUR 8,000" in this file was measured before the final tuning and was wrong.

| Years | 1st pct | Median | Mean | 99th pct | Lowest ever | Highest ever | Hit floor | Hit ceiling |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 1.57 | 166 | 418 | 5,028 | 0.50 | 21,436 | 0.30% | 0 |
| 25 | 2.39 | 228 | 534 | 5,942 | 0.50 | 24,955 | 0.41% | 0 |
| 50 | 2.65 | 246 | 558 | 6,172 | 0.50 | 24,955 | 0.46% | 0 |
| 100 | 2.56 | 233 | 531 | 5,709 | 0.50 | 24,955 | 0.60% | 0 |
| 160 | 2.49 | 227 | 516 | 5,350 | 0.50 | 24,955 | 0.79% | 0 |

Prices are in EUR at the end of each span; "lowest" and "highest ever" cover the whole path. The level is stationary: the typical share settles near 2.7 times its seed price and stays there. Small, mid and large companies land in the same place.

**Outliers.** BKNG stays lowest against its seed (median 1.2x) because its EUR 4,105 seed is close to the EUR 6,000 ceiling. BYD fell furthest (6% of seed at worst): high beta, thin margins and an EV sector exposed to speculation. FCX ran highest (10.7x at best), the same mechanics upward on a volatile copper miner. Cheap shares (VOD, NTT, BTA) make up the floor hits. Drawdowns are common over a server's life: 60% of companies halve at some point within 10 years, as real stocks do.

### Fairness

Excess over the equal-weighted listing, whole shares, EUR 10,000, the 75 main-market companies.

| Beats the market | 1 round | 5 rounds | 10 rounds |
| --- | --- | --- | --- |
| Below fair value, engine 1 | 60% | 72% | 82% |
| Below fair value, engine 2 | 52% | 55% | 61% |
| Momentum + reversal, engine 1 | 52% | 52% | 44% |
| Momentum + reversal, engine 2 | 59% | 61% | 54% |
| Recent winners, engine 2 | 52% | 58% | 54% |
| Biggest losers, engine 2 | 46% | 38% | 40% |
| After good company news, engine 2 | 47% | 43% | 41% |
| After bad company news, engine 2 | 49% | 47% | 48% |
| Random five, engine 2 | 47% | 46% | 44% |

Over one round, which is what players play, the strongest simple rule is momentum + reversal at 59% with a worst 5% of -12%: an edge, not a guarantee. Its long-run form beats the market about 60% of the time in every phase over five rounds, and is the rule to watch. Buying a stock because it fell, or because of a headline, does not pay.

**The anchor.** Buying below published fair value no longer beats the market by much except in the deepest bucket: over 100% below, it wins 55% over one round and 69% over five, with a worst 5% of -61% log, and such stocks are about 1% of the sample. Below the hidden anchor by 10 to 25% still beats the market 88% over five rounds, but that happens in 0.25% of cases and players cannot see the anchor.

Over ten rounds several rules exceed 60%, including buying after a market crash (66%, thin sample). Ten rounds is about two and a half hours of continuous play with the same holdings, which no competition allows, since accounts reset each round.

### Gameplay

Ten bots with different personalities, 16,000 rounds of the main market.

| Measure | Engine 1 | Engine 2 |
| --- | --- | --- |
| Lead changes per round | 11.2 | 11.1 |
| Close finishes (within 2% of the purse) | 31% | 32% |
| Leader at a quarter wins | 31% | 31% |
| A bottom-half player at halftime reaches the top three | 50% | 50% |
| Longest top-five freeze, simulated days | 4.5 | 4.6 |
| Stories per round | 10.2 | 10.9 |
| Longest quiet stretch, simulated days | 8.1 | 8.0 |
| Companies moving over 15% in a round | 12.6 | 15.1 |
| Dull rounds | 0.03% | 0.01% |

Win share by bot, engine 2: opportunist 23%, aggressive 13%, contrarian 13%, news trader 10%, random 10%, sector specialist 9%, momentum 8%, chaser 6%, inactive 6%, conservative 3%. In engine 1 the contrarian averaged +4.5% a round against +1.7% for random; now +2.0% against +1.8%. The conservative bot rarely wins but has the mildest losses, and the opportunist's wins come from holding one stock at a time, with a worst 5% of -23%.

These are bots, not people. They show the market still creates swings and comebacks; only real games can show it is fun.

### Load

`scripts/lab/load-matrix.sh` on a production build, one process, with 150 companies on the tape. Full output in [data/lab/load-matrix.txt](data/lab/load-matrix.txt).

| Scenario | Order p99 | Double executions | Inconsistent prices | Ledger mismatches | Peak RSS |
| --- | --- | --- | --- | --- | --- |
| One room, 1,000 players, 75 s | 21 ms | 0 | 0 | 0 | 274 MB |
| Ten rooms, 100 each | 18 ms | 0 | 0 | 0 | 272 MB |
| Twenty rooms, 50 each | 19 ms | 0 | 0 | 0 | 271 MB |
| `kill -9` mid-trading, 300 players, 5 rooms | 10 ms | 0 | 0 | 0 | not measured |
| Database paused 15 s, 300 players | 14 s (during the pause) | 0 | 0 | 0 | not measured |

Not covered: a market crash or a burst of news forced during full load, long soak runs for memory growth, and a real network.

## Prices over the life of a server

`test/realism.test.ts` runs the full market with news for 160 simulated years (about 640 rounds). Before the long-run fixes, within 100 rounds Nvidia reached the EUR 1,000,000 ceiling and Deere fell to 1% of its seed price: reports compounded each company's seed growth forever. Trend growth now fades to 6% a year (half-way in eight quarters), and past three times either side of its seed price a share feels a gentle pull of at most 30% a year (`levelBand`, `levelRate`, `levelMax`; gameplay, standing in for the stock splits a fixed purse cannot follow). Measured at 100 simulated years, company prices run from about EUR 3 to EUR 8,000, with the same range at 25 years.

### Headline trade

Buying a company at the close of the simulated day a positive story about it landed, against the market:

| Hold | Trades | Won | Mean excess return |
| --- | --- | --- | --- |
| 12 days (a fifth of a competition) | 3,611 | 50.8% | −0.06% |
| 60 days (a competition) | 3,611 | 50.2% | −0.62% |

The move lands on the headline tick, so reading the news is no edge on its own; momentum and hidden demand did not reopen the old exploit.

## Known gaps

- **Tails and memory:** kurtosis, skew, the leverage effect and the long memory of volatility are all present but weaker than history. One GARCH component cannot carry both short and long memory (a two-component model would). Fat-tailed per-tick draws made the variance unstable, so tails come from jumps instead.
- **Crash dynamics:** momentum crashes and deep (over 40%) market crashes are rarer and milder than history.
- **Small caps:** the listing's companies are all large. Size effects use size relative to the listing, so they are weaker than the decile comparison.
- **Recessions:** the realised recession return varies a lot between seed sets, because recessions are rare. The measured drift is used as is rather than tuned to noise.
- **Thin evidence:** sector crisis sensitivities rest on one episode (2007 to 2009), and US data stand in for a global listing.
- **Out-of-sample checks:** history was used for direction and size, with no parameter fitted to one famous crash. The test suite checks behaviour on seeds the calibration did not use (2000 to 2005, 100 to 599), not against held-out years of real data.
