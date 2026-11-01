# Simulation test plan

How the market model is checked. All tests run with `npm test` (the Postgres tests with `TEST_DATABASE_URL` set); the long calibration runs are scripts, not tests.

## Unit and behaviour tests

`apps/server/test/simulation.test.ts`, on controlled states and fixed seeds:

| Requirement | Test |
| --- | --- |
| Price compounding, valid prices | Log returns add up to the log price change exactly; 25 simulated years stay finite and above the floor |
| Reproducibility with a fixed seed | Two runs from one seed give identical prices and market-made news |
| Exact restart | Stop mid-run, rebuild from `state()`, continue: identical prices and news |
| A rising sector does not force every constituent up | Over 30 seeds, raised demand lifts the sector in at least 24 runs, and in some runs a member still falls |
| Companies differ within a rally | A fast grower (NVDA) rides raised demand harder than a mature giant (INTC) on average |
| Size is market value, not share price | Loadings follow capitalisation; a cheap share is not automatically a small company |
| Valuation makes bad news worse | The same negative story hits a stock 50% over fair value harder than one at fair value |
| Earnings follow the business | Value above the last fair value reads out as a beat, below it as a miss |
| A profitable company can fall; a loss-maker can rally | Over 40 draws each: misses on a profitable company mostly fall, and beats by a loss-maker (smaller loss) mostly rally |
| Quiet filings | Every company without an earnings story files once, with no price effect |
| Surprise size matters | A 30% beat moves the price more than a 3% beat |
| Froth raises crash risk without guaranteeing it | Over 40 seeds, a frothy sector crashes more often than a calm one, and not in every run |
| An overheated market can keep rising | Some frothy, enthusiastic sectors rise for a whole competition without a crash |
| Sector crash vs panic, uneven recovery | A sector crash moves its own sector (other sectors stay within normal noise); a panic hits more than 90% of companies by different amounts; a month later recoveries differ by more than 5 points |
| News states facts | A crash story mentions stretched valuations only when there was froth; no story says buy, sell or will rise; credit stories quote the spread; note ids are stable and unique |
| Statistical shape (Monte Carlo, 60 years) | Volatility 10 to 22%, mean 2 to 18%, positive excess kurtosis, clustering, negative leverage effect, no day-to-day predictability, higher sector correlation in stress, small riskier than big, weak momentum, crashes rare but present |

`apps/server/test/market.test.ts` keeps the earlier guarantees:

- determinism;
- scheduled stories move only what they name;
- cross-sector sensitivities (oil, rates);
- the headline move lands entirely on its tick;
- events apply once however often they are loaded;
- orders never reach the model;
- bounds under a storm of extreme stories;
- a restart replays no shock twice;
- prices carry across competitions;
- a new fair value never jumps the price.

`apps/server/test/fundamentals.test.ts` covers reports, trailing EPS, fair value and P/E.

## Integration tests

`apps/server/test/engine.db.test.ts` (real Postgres):

- whole competitions with concurrent orders, duplicates and ledger consistency;
- restart recovery that rebuilds the exact prices;
- rooms side by side on one market;
- quiet quarterly filings stored as reports and kept out of the news feed.

Every player in a competition gets the same prices, because the server broadcasts one tick message to every socket. The tests check that every client's book and the database agree. Clients never compute returns: they only display server prices and value portfolios from them.

## Historical replay and calibration

`scripts/calibration/measure-history.ts` measures stylized facts and episode paths from the French Data Library and FRED. `scripts/calibration/run-sim.ts` runs the model for 400 years with the full news schedule and prints the comparison in [calibration.md](calibration.md).

**The replay is statistical, not path-by-path.** The model is never fed historical prices. It is judged on whether it reproduces the shape of history: distributions, clustering, correlations in calm and stress, recession behaviour, size and momentum effects, run-up and crash frequencies, drawdown frequency.

**Methodology:**

1. Measure the real statistic on the longest clean sample (1963 on for daily market data, 1926 on for run-ups).
2. Compute the same statistic on simulated days (ten ticks) with the same definition (`simulate.ts` mirrors `measure-history.ts`).
3. Prefer a mechanism over a fudge. Tune only the parameters marked tuned, and record the target.
4. Record what does not match and why ([calibration.md](calibration.md), Known gaps).
5. Check the headline trade on every recalibration: buying after a positive story must not pay on average.

**When changing the model:** rerun `run-sim.ts 400` and compare against the table in [calibration.md](calibration.md). Update the table if the change is intended, then run `npm test`.
