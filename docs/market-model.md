# The market model

The model is in `apps/server/src/market/sim.ts`, and the numbers behind its parameters are in [calibration.md](calibration.md). One server process runs one persistent market; every player in every room sees the same prices, news and reports, and clients never compute a return.

## Time and units

- **Time:** one tick stands for `DAYS_PER_TICK` = 0.1 trading days. A standard 600-tick competition is therefore about 60 trading days, roughly one quarter, and one simulated year is 2,520 ticks. This is a gameplay choice. It matches one quarterly report per company per competition, and it makes a competition long enough for business conditions to matter.
- **Units:** all returns are log returns per tick, and prices are `P = exp(log P)` in integer euro cents.
- **Conversions:** an annual volatility σ becomes σ/√2520 per tick, and an annual log drift μ becomes μ/2520.

## State

Hidden states, never sent to clients:

| State | Meaning | Dynamics |
| --- | --- | --- |
| `recession` | the business cycle | two-state Markov: leaves expansion with probability 1/(58.4 months) per tick and recession with 1/(10.2 months) |
| `variance` h | market variance in units of its long-run level | GJR-GARCH(1,1), target 0.8 in expansion and 2.62 in recession |
| `credit` c | corporate credit spread, percentage points | mean-reverting to 1.9 (expansion) or 3.6 (recession); shocks scale with √h; jumps on crashes and panics |
| demand dₛ | each sector's business demand (per-tick drift) | AR(1), half-life 14 months, stationary spread 4% a year; pulled down in a recession by the sector's crisis sensitivity |
| spec bₛ | each sector's speculative enthusiasm (per-tick drift) | AR(1), half-life 3 months, fed by the sector's recent lead over the market beyond a threshold |
| trend τₛ | the sector's recent lead over the market | exponentially decayed sum of daily excess returns, half-life 3 months |
| growth gᵢ | each company's own prospects (per-tick drift) | AR(1), half-life 12 months |
| froth φᵢ | the company's speculative premium over fair value | built by speculation, fades with a 30-month half-life, removed by crashes |

Public state:

- **Prices.**
- **Fair value** `fairLog`: the market's value of the business.
- **Sentiment and transient premiums**, left by scheduled stories.
- **The volatility regime** (calm, nervous or stressed, read from h) and the **credit spread**, both shown to players.

## One tick

For company i in sector s:

```
info_i   = β_i' · (μ_M + σ_M · m · √h · z_M  +  κ_M · Δc)               the economy and credit
         + e_i  · (k_d · d_s + σ_s · z_s)                                its sector's demand and shock
         + ℓ_i  · σ_SMB · z_SMB  +  κ_x · x_i · Δc                       size and credit exposure
         + g_i  +  π · σ_i · L_i · z_i                                    its own prospects and half its noise
spec_i   = q_i · b_s                                                      speculation (not news about value)
noise_i  = (1 − π) · σ_i · L_i · z_i                                      the other half of its noise

fairLog_i += info_i
froth_i    = froth_i · fade + spec_i
anchor_i   = fairLog_i + sentiment_i + froth_i + transient_i
r_i        = clamp(info_i + spec_i + noise_i + pull_i, ±5%) + shock_i
log P_i   += r_i            (kept within ±1 of the anchor, and between €0.50 and €1,000,000)
```

where:

- **β_i' = β_i · (1 + 0.12 · ℓ_i):** the company's beta, tilted by its size loading ℓ_i.
- **Size loading ℓ_i:** the company's seed market value relative to the listing's median, in units of the spread of log market values, capped at ±1.5. Positive means smaller. It uses market capitalisation, never share price, so a €6 share can belong to a large company.
- **Market drift μ_M:** +12.1% a year in expansion and −3.8% in a recession.
- **Market shock scale:** σ_M = 16.3% a year, scaled by m = 0.8, the factor's share once sectors, companies and news add their own variance.
- **Shocks z:** bounded standard normals in a fixed draw order every tick.
- **Credit:** κ_M = −0.0316 per point of spread change for the whole market, and κ_x = −0.03 extra for a fully credit-exposed company. Credit exposure x_i is half the company's credit sensitivity plus half its size loading when positive.
- **Sector exposure e_i = clamp(0.6 + 2 · growth_i, 0.3, 1.8):** a fast grower rides its sector's demand harder than a mature giant.
- **Speculative exposure q_i:** higher for volatile, loss-making and fast-growing companies.
- **Sector shock σ_s:** the measured volatility of the matching US industry beyond its market beta.
- **Own noise σ_i:** the company's own volatility. L_i = 1 + 0.3 · max(0, ℓ_i) · max(0, √h − 1) raises a small company's noise in stress, standing in for thin liquidity.
- **News share π = 0.5:** half the company's own noise is news about its value; the other half reverts.
- **pull_i = 0.004 · (anchor − where the price would otherwise be):** what makes the non-news half of the noise, and the temporary part of a shock, revert.
- **shock_i:** the sum of a scheduled story, a sector crash and a panic landing on this tick.

### Shocks and fragility

`raw = story + crash + panic`. A negative shock is amplified by how far the stock trades above what its fundamentals support:

```
shock = raw · (1 + min(max(sentiment_i + froth_i, 0), 1))     when raw < 0, so at most twice its size
```

Shocks are then capped at 35% per tick and per rolling 60-tick window. The anchor moves by exactly what landed, so a capped or clipped shock leaves no catch-up drift for anyone to trade:

- **A scheduled story** splits into lasting sentiment and a temporary part, as its template says.
- **A crash or panic** first removes the stock's froth (permanently) and puts the overshoot below it into the temporary part, which recovers.

### Crashes and panics: hazards, not schedules

```
heat_s        = Σ_{i∈s} w_i · froth_i                         (w: seed market-value weights in the sector)
stress        = 0.5 · max(0, c − 1.9)
P(crash_s)    = 1/(80 years) · exp(10 · max(0, heat_s)) · (1 + stress)                   per tick
P(panic)      = 1/(150 months) · exp(7 · max(0, mean heat)) · (1 + stress) · (1.5 if in recession)
```

- **A sector crash** cuts by 8% plus 0.7 times the heat, capped at 32% and then scaled by a random 0.7 to 1.3. Each member falls in proportion to its speculative exposure. Enthusiasm reverses, variance rises by 0.5, and credit widens by 0.05 points (0.3 for a bank crash).
- **A panic** cuts every company by 3 to 9%, times its beta and one plus its credit exposure. Variance rises by 4, credit widens by 0.25 to 0.75 points, and all enthusiasm is dampened.

Neither is ever certain, and both can happen in calm markets at their base rates.

### Speculation and momentum

Each tick the sector's lead over the market is added to its trend τₛ. Enthusiasm moves toward

```
target b_s = clamp(0.0035 · sign(τ_s) · max(0, |τ_s| − 0.2), ±100% a year)
```

- **The threshold:** an ordinary trend draws no crowd. A lead of more than 20% does, and its speculative drift builds froth over fair value, so a bubble shows to players as a price stretched above the fair value its reports support.
- **Momentum** comes mostly from persistent sector demand and company growth (real changes in value that take months to play out) and partly from this extrapolation.
- **Nothing reverses on a schedule.** Momentum ends when demand or growth turns, or when a crash removes the froth.

## Fundamentals and expectations

Reports are a noisy readout of the business, not random numbers:

- **Every company files once per competition** (about once a quarter). Companies with an earnings story file through it; the rest file quietly, spread across the competition, with no headline and no price move of their own.
- **The surprise:** the quarter's EPS surprise against consensus (last year's quarter grown at the company's trend) is the log gap between the market's value of the business (`fairLog`) and the fair value of the latest reports, capped at ±40%, plus ±2% noise. A business that has been doing better than its reports showed beats, and one that has been doing worse misses.
- **Fair value follows with a lag.** Trailing EPS is four quarters, so report-based fair value follows the business with about a year's lag. In between, players see price above or below fair value, which is a real signal mixed with noise.
- **Earnings stories:** an earnings story is a beat or a miss according to that readout. Its price reaction scales with the size of the surprise (from 0.3 to 1.5 times the template's strength). A profitable company can miss and fall; a loss-maker can beat (lose less than expected) and rally.
- **A filed report** moves fair value without jumping the price: the gap goes into sentiment, which fades over about 20 competitions. That is the long-horizon pull of valuation.

## Scheduled news

The schedule in `events.ts` is unchanged in shape: macro, sector and company stories, one market-wide story, and follow-ups. Two calibrations changed:

- **Macro and market-wide stories** are 30% and 25% of their former size, so a Fed-like rate story moves growth stocks about 1 to 2% (compare Bernanke and Kuttner 2005).
- **Company and sector stories** land at 60% of template strength (`STORY_SCALE`).

A story's whole move still lands on its tick, so buying on a headline buys only the noise that follows.

## News the market makes itself

`SimNote`s become stories the moment they happen (`notes.ts`). Each states only facts about the simulation at that tick:

- **Sector crash:** its size, which companies were hit hardest, and whether the sector had run ahead of its earnings, which is said only when its froth was above 5%.
- **Panic:** the fall, the wider spread, and the hardest hit.
- **Recession and recovery:** reported one competition after the cycle turns, as data would reveal it.
- **Credit tightening and easing:** when the spread crosses 3.0 or falls back below 2.2 points, with hysteresis so a spread hovering near a line is not news every few ticks.

Their ids are negative and derived from the tick, so a replay after a restart stores and shows each once.

## Determinism and safety rails

- **Fixed draws:** every tick draws the same random numbers in the same order whatever the state, and the whole state round-trips through `state()`. A restart resumes from a checkpoint and replays the identical tape, market-made news included.
- **Bounds:**
  - ±5% per tick on ordinary moves, and 35% per tick and per rolling window on shocks;
  - the price stays within e^±1 of its anchor, and between €0.50 and €1,000,000;
  - variance stays within 0.2 to 25 times its long-run level, and credit within 1.2 to 7 points;
  - fragility amplifies a negative shock at most twice.
- **Nothing from orders reaches the model:** trading never moves prices.
- **Upgrade from the previous model:** a checkpoint with no recorded variance is from the old model. That model let common market noise drift prices away from fair value (by 3% on average in the dev database), so on load each company's value starts where its price stands. The upgrade itself moves no price, and there is no catch-up rally afterwards (tested).
- **Bounded draws:** the market shock is a bounded normal. A fat-tailed per-tick draw feeding GARCH produced one-day collapses of 50% in testing, so fat tails come from volatility clustering and from crash and panic jumps instead.

## What players can and cannot see

They see:

- prices and charts;
- reports and fair values;
- every published story, including what the market itself did;
- the volatility regime and the credit spread;
- their own and (where a room allows) rivals' portfolios.

They never see the cycle state before it is reported, sector demand, enthusiasm, froth, company growth, crash hazards, or any story's price impact before it lands. The model cannot predict real markets and does not try to.
