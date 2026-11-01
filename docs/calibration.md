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

400 simulated years (40 episodes of 10) against US history (market since 1963; run-ups since 1926):

| Statistic | History | Simulation | Verdict |
| --- | --- | --- | --- |
| Market volatility, annual | 16.3% | 15.5% | Close |
| Market mean, annual log | 10.3% (total return) | 7.4% (price only) | Close; Haggle has no dividends |
| Daily excess kurtosis | 18.1 | 8.5 | Fat tails, but thinner than history |
| Daily skew | −0.77 | −0.45 | Right sign, weaker |
| Day-to-day return autocorrelation | 0.016 | 0.005 | Close to none in both |
| Absolute-return autocorrelation, lag 1 / 20 / 120 days | 0.26 / 0.20 / 0.09 | 0.24 / 0.18 / 0.06 | Clustering present; memory shorter than history |
| Leverage effect | −0.090 | −0.029 | Right sign, weaker |
| Days beyond 3 sd | 1.43% | 1.52% | Matches |
| Sector correlation, all / calm / stressed | 0.68 / 0.64 / 0.88 | 0.59 / 0.40 / 0.85 | Rises sharply in stress, as in history. Lower overall because ten-company sectors keep company noise that 300-stock industries diversify away |
| Annual mean, in recession / outside | −3.8% / 12.1% | −5.8% / 9.4% | Recessions hurt; somewhat more than history (only about 48 recessions in the sample, so noisy) |
| Volatility, in recession / outside | 26.3% / 14.5% | 18.7% / 15.0% | Higher in recessions, by less than history: recessions are short next to GARCH's memory |
| Monthly volatility, small / big | 22.0% / 14.8% (deciles) | 20.7% / 15.5% (thirds of the listing) | Small riskier. The listing has no true small caps, so the gap is narrower |
| Monthly beta, small / big | 1.12 / 0.93 | 1.00 / 0.97 | Right order, narrower |
| Stock momentum, mean / sd / skew | 6.4% / 12.6% / −1.44 | 1.7% / 9.7% / −0.09 | Positive and modest; crashes milder than history |
| Industry momentum: correlation / leaders over laggards / share positive | 0.058 / 0.59% / 58% | 0.062 / 0.12% a month / 50% | Correlation matches; the leaders' monthly edge is much weaker since growth stopped compounding forever |
| 40% crash within 2 years: base / after a doubling | 6.7% / 30% | 5.6% / 18% | Run-ups raise crash risk 3.2× (history: 4.4×) |
| Share of sector-months after a doubling | 3.5% | 1.8% | Rarer than history |
| Drawdowns per 100 years over 25% / over 40% | 11 / about 5 | 9.5 / 4.25 | Deep crashes somewhat rarer |

### Prices over the life of a server

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
