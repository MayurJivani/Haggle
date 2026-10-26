# Scenario library

How each economic scenario arises in Haggle's market, what it changes, and what it is modelled on. There are two kinds:

- **Emergent scenarios** are changes in the hidden state: the business cycle, credit, sector demand, speculation and company growth. Nobody schedules them. They start from probabilities each tick, change returns over many ticks, and are reported once they are visible in the data (a crash at once, a recession a competition later).
- **Announced scenarios** are scheduled stories. Their whole price effect lands on the tick they are published, split into a lasting re-rating and a temporary part that fades, so reading the headline is never a free trade. A severity-3 story also lifts market volatility.

Neither kind ever applies one fixed percentage to every company. Each company responds through its own beta, size, credit exposure, growth, valuation and sensitivities. Durations below are in simulated time: one competition is about a quarter, one year about four competitions.

## Technology boom (emergent)

- **Trigger:** the Technology or Semiconductors demand state drifts up, as an AR(1) shock that persists for about 14 months (half-life). No single tick causes it.
- **State changed:** sector demand dₛ, a positive drift on members' value, scaled by sector exposure (faster growers more).
- **Fundamentals:** the business really improves. Value (`fairLog`) rises, so quarterly reports read out beats, which then lift report-based fair value with a lag.
- **Who gains:** a fast-growing company gains more than a mature giant, and a high-volatility name swings more both ways. A company can still fall during the boom if its own growth, a miss or a story goes against it (tested).
- **Spillover:** none directly. It can feed speculation (see the next scenario).
- **Ends:** when demand mean-reverts. Persistence makes it look like momentum.
- **Reference:** industry momentum, measured 0.58% a month for leaders over laggards; Moskowitz and Grinblatt (1999).

## Technology bubble (emergent)

- **Trigger:** the sector's lead over the market (decayed over about 3 months) exceeds 20%. Beyond that, enthusiasm builds speculative drift.
- **State changed:** enthusiasm bₛ and each member's froth, a premium over fair value that reports do not support. Players see prices pulling away from fair values and P/E ratios.
- **Fragility:** the hazard of a sector crash grows as exp(10 · froth), and bad news is amplified up to twice for stretched stocks. A bubble can keep inflating for a long time (tested); not every bubble bursts, and not every rally becomes one.
- **Burst:** the crash takes out most of the froth and overshoots. Speculation turns negative, volatility rises, and credit widens a little.
- **Recovery:** the overshoot recovers over competitions. The froth does not come back unless a new run builds it.
- **Reference:** the NASDAQ, +579% in 1995 to 2000, then −78% in 2000 to 2002; industry doublings followed by a 40% crash in 30% of cases (measured); Greenwood, Shleifer and You (2019); Barberis et al. (2018).

## Interest-rate shock (announced)

- **Trigger:** a scheduled rate-hike, rate-cut or inflation story, chosen by the news schedule.
- **Effect:** each company moves by its rate sensitivity times the story's size, with jitter. Expensive growth stocks (high rate sensitivity) fall most on a hike, and banks and insurers gain (negative sensitivity). Stretched stocks fall further through fragility.
- **Size:** 1 to 2% for a fully exposed company (macro stories at 30% of their former strength).
- **Reference:** Bernanke and Kuttner (2005), about 1% per 25bp surprise; the 2022 rate cycle (10-year yield from 0.93% to 4.98%, NASDAQ −35% in 2022).

## Recession (emergent, reported)

- **Trigger:** the hidden cycle leaves expansion with probability 1/(58.4 months) per tick.
- **State changed:**
  - market drift turns from +12.1% to −3.8% a year;
  - the variance target rises from 0.8 to 2.62;
  - credit is pulled toward 3.6 points;
  - each sector's demand is pulled down in proportion to how it fared in 2007 to 2009 (cars and banks most, healthcare and food least, which is relatively better off);
  - panics are 1.5 times as likely.
- **Fundamentals:** value falls, so reports read out misses with a lag.
- **Reported:** one competition after it starts ("Economic data confirm the economy is shrinking"), and again when it ends.
- **Ends:** with probability 1/(10.2 months) per tick.
- **Reference:** NBER dates (FRED USREC); the measured recession returns and volatility.

## Credit crisis (emergent, can be triggered by stories or crashes)

- **Trigger:** the credit spread rises:
  - in recessions;
  - on panics (0.25 to 0.75 points) and bank-sector crashes (0.3 points);
  - through scheduled bank-stress stories (an announced shock to credit-sensitive companies).
- **Effect:** the market falls 3.2% per point the spread widens, and credit-exposed companies (banks, smaller and more indebted firms) up to twice that. Crash and panic hazards rise with the spread above 1.9 points.
- **Reported:** when the spread crosses 3 points ("Borrowing costs jump"), and again below 2.2 points ("Credit conditions ease").
- **Recovery:** the spread is pulled back toward its regime level with a 120-trading-day half-life.
- **Reference:** the Baa spread from 1.48 points in 2005 to 6.16 in December 2008; Gilchrist and Zakrajšek (2012); Jordà, Schularick and Taylor (2015).

## Energy supply shock (announced)

- **Trigger:** oil-spike or oil-slump stories.
- **Effect:** by oil sensitivity. Producers (Energy) move with the oil price, while airlines, carmakers, logistics and fuel-intensive manufacturers move against it.
- **Reference:** cross-sector factor sensitivities in `assets.ts`. The 2022 energy rally (energy up 210% over the two years to March 2022 in the industry data) is one of the measured run-up episodes that did not crash.

## Breakthrough innovation (announced, company level)

- **Trigger:** product-launch, drug-approval and contract-win stories, and datacenter-capex or renewables-push at sector level.
- **Effect:** a jump in the company (or basket), partly lasting. A new-competitor story is its counterpart: an established company losing to a rival.
- **Weak companies:** a weak company can recover on a breakthrough. A loss-maker that beats expectations (a smaller loss) rallies (tested).

## Fraud or accounting scandal (announced, company level)

- **Trigger:** a probe (investigation) story. Its follow-up, later in the same competition, is either probe-cleared or probe-fined.
- **Effect:** a large, mostly lasting fall in that company only. It does not move the market, because one company has no systemic exposure in the model. A bank crash, by contrast, widens credit for everyone.

## Market panic (emergent, and announced)

- **Emergent:** a panic hazard of about 1/(150 months), rising with average froth and credit stress, and 1.5 times higher in recessions. The panic:
  - cuts every company 3 to 9%, scaled by beta and credit exposure;
  - lifts variance by 4 (a volatility spike that carries the selling on over the following days);
  - widens credit;
  - dampens all enthusiasm.

  Each company falls by a different amount and recovers by a different amount (tested).
- **Announced:** each competition has one market-wide story (a panic or rally headline) at about 3 to 5%, which also lifts volatility a little.
- **Reference:** 1987 (−33%, worst day −19%) and 2020 (−34% in 23 trading days; VIX 82.69).

## Bull-market rotation (emergent)

- **How it arises:** sector demand states are independent AR(1)s. As one sector's demand fades and another's builds, leadership rotates. A crash in the leading sector speeds the rotation, because enthusiasm there reverses while other sectors are untouched.
- **Effect:** old leaders slow and new leaders outperform, without any rule saying so.
- **Reference:** measured industry momentum is positive but weak (correlation 0.058); most months are not decided by it.

## Recovery after a crash (emergent)

How fast prices come back depends on what fell and why:

- **The overshoot recovers.** The temporary part of a crash or panic fades with a half-life of about 5 competitions, plus the pull of the anchor.
- **The froth does not come back.**
- **Credit-driven losses** come back as the spread narrows. Companies most exposed to credit fell most and rebound most.
- **In a recession,** value keeps falling until the cycle turns.

So recoveries are uneven across companies and sectors (tested), as after March 2009, when durables rose 226% in a year and utilities 45%.

## Selection and probabilities

| Scenario | How often (simulated, 400 years) | How decided |
| --- | --- | --- |
| Recession | 0.12 a year (about one every 8 years; history: about one every 6) | Markov chain |
| Sector crash | 0.33 a year across all 15 sectors | Hazard per sector per tick |
| Market panic | 0.055 a year | Hazard per tick |
| Credit tightening reported | 0.13 a year | Spread crossing 3 points |
| Scheduled stories | 8 to 13 per competition, plus about 70 quiet quarterly filings | `schedule()` and `quietReports()` from the competition's seed |

In game terms, at about four competitions a year:

- a sector crash about once in 12 competitions;
- a market panic about once in 70;
- a recession about once in 33.

Most competitions are ordinary markets moved by news, demand and noise.
