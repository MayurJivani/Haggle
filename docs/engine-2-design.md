# Market Engine 2: design

Results live in [calibration.md](calibration.md). This records what the engine is, why, and what was rejected.

## Requirements

**Functional.** One market shared by every competition. News, prices and reports that no room can influence. Companies that behave differently for reasons a player can learn. No mechanical rule that wins everywhere.

**Non-functional.** 1,000 players on one Node process. Deterministic replay after a restart. Ticks never wait on maintenance. Money stays exact.

**Constraints.** One process owns the market (the existing design). Postgres is the only store. Rounds last minutes, so the fundamentals model stays small.

## Shape

```
            seed + engine version
                    |
                    v
   +-------------- Tape --------------+      pure function of (seed, tick)
   |  MarketSim   economy, prices     |
   |  planEpoch   news per 600 ticks  |
   |  reports     fair values         |
   +----------------+-----------------+
                    | prices, stories, reports (one way only)
                    v
   +--------------- Engine -----------+      clock, sockets, checkpoints
   |  Room A      Room B     House    |      players, books, boards, results
   +----------------------------------+
```

`market/tape.ts` is the seam. Nothing in a room reaches it: the engine calls `prepare()` and `step()`, and rooms read the results. A test stores what an engine with overlapping, early-closing and restarted rooms played, and compares every tick and story with a `Tape` that has no rooms at all.

## Decisions

### The clock stops when nobody is trading

The tape is a function of the tick number, not of wall time. The market ticks once a second while any competition is running, and pauses when none is.

| Option | For | Against |
| --- | --- | --- |
| **Pause when idle (chosen)** | No writes for an empty server; content of every tick still independent of rooms | Wall time and market time drift apart; the chart shows gaps |
| Always ticking | A market that moves overnight | 150 rows a second, about 13 million a day, for nobody |

Rooms can decide when the next tick plays, never what it contains. Revisit if players ask for a market that moves while they are away.

### One schedule per epoch

Every 600 ticks the tape plans its news from the seed, the epoch number and the market's own state. Rooms add nothing, and a room closing early cancels nothing. Story ids derive from the epoch, so a replay stores nothing twice.

The core 75 get a full schedule and the other 75 get company stories of their own, so news does not thin out as the listing grows. A client hides stories about companies its competition does not list. Market-wide stories always move everyone.

A round no longer lines up with an epoch, so the old "strong twist near the end of the round" is gone as a guarantee. The lab tracks news spread through the round to make sure this did not cost anything.

### A report does not set the value of a business

Previously each report reset hidden value to the published fair value. A stock below fair value therefore had a known way up and no way for the gap to close from above. Reports now move hidden value only part of the way (`reportTrust`). If the business really is worse than the report implied, the next quarter is a miss and the published figure comes down.

### Mechanics read the economy, not prices

Volatility, drawdown and mood read the market factor rather than company prices. Otherwise one company's story would change every other price by a tiny amount, and a story could never be said to move only what it names.

### Phases are a reading, not a switch

Bull, bear, sideways and crisis are read from state (mood, recession, drawdown, volatility, credit), with hysteresis. Nothing rolls a die to change phase. Recession odds rise with credit stress and froth, and recovery odds with easing. Players are never sent the phase.

### Price precision

The model keeps full float precision in log price. Rounding to cents happens once, when a price leaves the model, and never feeds back. A EUR 0.78 share shows moves in 1.28% steps because of its display and execution tick, not because anything is lost. Execution stays in integer cents (see "Fractions" below for why). A sub-cent tick would touch every money path for three companies, so it is not done.

### Fractions of shares: rejected

The ledger, position constraints and every leaderboard rest on whole shares and integer cents. "Money is exact" is a product principle. Instead the host sees which companies a purse cannot buy, by name, and can remove them in one click. Nothing is dropped silently.

### Retention

| Data | Kept | Why |
| --- | --- | --- |
| Ticks | `TICK_RETENTION_DAYS` (default 30), never from a live competition's opening onward | Exact recent charts, restarts |
| Minute bars | For good | Long charts |
| Checkpoints, events | For good | Replay any old game tick by tick |
| Opening and closing prices, trades, results | For good | Verifying a finished game |

A background job folds a batch once a minute, in one statement, off the tick loop. Daily bars and thinning old checkpoints are the next steps if storage matters.

### Versioning

`ENGINE_VERSION` is stored on every event and competition. A change that alters the tape must bump it. Replaying history from an older version needs that version's code, which is what the git tags are for; keeping every old model loadable at runtime was rejected as cost without a use.

## Rejected

- **Fat-tailed draws feeding volatility.** Unstable. Rare jump ticks are read clipped by the volatility update instead.
- **Trades moving prices.** Would let a room reach the shared market.
- **A second process for the market.** One writer is what makes the ranking exact, and load tests show it carries the target.
- **Scripted narratives.** Stories come from state and chance; chains such as dear oil followed by inflation are possibilities with a stated chance, and some cut the other way.

## What to revisit

- A market factor with real long memory: the 120-day volatility autocorrelation is the one statistic this engine made worse.
- Daily bars once minute bars grow.
- Splitting ticks by listing if a custom room's players ever care about the bytes of 150 prices a second.
