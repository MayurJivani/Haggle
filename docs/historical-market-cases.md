# Historical market cases

The real episodes the model was designed against, with their measured price paths. All figures are from [data/history-stats.json](data/history-stats.json): CRSP-based market and industry returns from the Kenneth French Data Library (total return, dividends included), and the NASDAQ Composite, credit spread and VIX from FRED (price index levels). They are used to choose mechanisms and check the model's shape. They are never fed into the game's market, and the game never replays a historical path.

## The dot-com boom and bust, 1995 to 2002

NASDAQ Composite, year-end closes:

| 1994 | 1995 | 1996 | 1997 | 1998 | 1999 | 2000 | 2001 | 2002 | 2003 | 2004 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 752 | 1,052 | 1,291 | 1,570 | 2,193 | 4,069 | 2,471 | 1,950 | 1,336 | 1,997 | 2,175 |

- **Run-up:** from 743.58 on 3 January 1995 to 5,048.62 on 10 March 2000, up 579%. The run-up accelerated, with 1999 alone up 86% (2,193 to 4,069).
- **Bust:** down to 1,114.11 on 9 October 2002, a 78% fall. It did not regain the 2000 peak until 23 April 2015.
- **Volatility:** annual volatility was 15.9% over 1995 to 1997 and 39.3% over 1999 to 2002. Volatility rose with the bubble and stayed high through the bust.
- **The wider market** fell less. It peaked on 24 March 2000, had fallen 49% by 9 October 2002, and recovered its peak (total return) on 23 October 2006. Month-end levels against February 2000: +6% (March 2000), −22% (March 2001), −29% (September 2001), −42% (September 2002).
- **In the industry run-up data**, business equipment (mostly technology) and telecom both crossed the "doubled in two years" mark in 1999. Both crashed by more than 40% within the next two years (the October 1999 episodes in `runups.episodes`).

What the model takes from it:

- A sector-specific bubble can run for years and accelerate before breaking, so the hazard rises with froth but never forces a crash.
- The bust is a sector event that spills into the market but is much larger in the sector.
- Volatility in the sector rises with the bubble.
- Recovery can take many years. In the model, the froth that a crash removes is gone for good; only the overshoot below fair value recovers.

## The Global Financial Crisis, 2007 to 2009

- **Market path (total return):** peak 9 October 2007, trough 9 March 2009, a 54.6% fall over 355 trading days, recovered 28 February 2012.
- **Month-end levels against October 2007:**

| 2008-01 | 2008-06 | 2008-09 | 2008-10 | 2008-11 | 2009-02 | 2009-03 | 2009-06 | 2009-12 | 2010-06 | 2010-12 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| −11% | −16% | −22% | −36% | −41% | −50% | −46% | −37% | −23% | −27% | −9% |

- **Credit:** the Baa-Treasury spread had bottomed at 1.48 points in March 2005 and peaked at 6.16 on 4 December 2008.
- **Fear:** the VIX peaked at 80.86 on 20 November 2008, against a median of 17.6 since 1990.
- **Correlation:** the average correlation between the 12 industries rose from 0.64 (2004 to 2006) to 0.88 (September 2008 to March 2009).
- **Who fell how far** (peak to trough): finance −76% and durables −77%, against healthcare −34% and consumer non-durables −36%. The smallest size decile fell 65% and the largest 53%.
- **Recoveries differed** in the year after the trough: durables +226%, finance +122%, the smallest decile +126%, utilities +45%, the largest decile +64%.

What the model takes from it:

- A systemic crisis is a credit event as well as a price event: credit widens, volatility jumps and correlations rise.
- Losses scale with leverage, cyclicality and size; a defensive sector falls less.
- The rebound is steepest for what fell furthest, and it is uneven.
- The hidden recession, credit level and panic hazard reproduce these channels. The measured crisis loss ratios set each sector's recession sensitivity.

## Momentum crashes

- **2009:** the momentum factor (prior 12-month winners minus losers) fell 63% from November 2008 to January 2010, much of it in the spring 2009 rebound. Battered, high-beta past losers rose fastest while past winners lagged (Daniel and Moskowitz 2016).
- **1932 to 1942:** its worst ever drawdown, 72%.
- **Over 1963 to 2026** the factor's daily returns still averaged +6.4% a year, with a skew of −1.44.

What the model takes from it:

- Momentum should pay on average and occasionally fail badly. It is never guaranteed and never scheduled to reverse.
- In the model it emerges from persistent demand and growth. Rebounds after panics favour high-beta, credit-exposed names, so recent losers can lead the rebound.

## Short, violent crashes: 1987 and 2020

- **1987:** the market fell 33% from 25 August to 4 December 1987, including the worst day since 1963 (19 October, log −19.1%). It recovered by 15 May 1989.
- **2020:** the market fell 34% in 23 trading days (19 February to 23 March 2020) and recovered by 5 August 2020, 117 trading days after the peak. Month-end against January 2020: −8% (February), −20% (March), −9% (April), −2% (June), +12% (August). The VIX peaked at 82.69 on 16 March 2020.

What the model takes from it: a panic is a fast, correlated fall with a volatility spike and wider credit, followed by a recovery whose speed depends on what caused it. In the model, a panic is a market-wide jump plus a volatility and credit shock. Its overshoot recovers, while recessions and credit decide how much of the fall lasts.

## The 2022 rate shock

The 10-year Treasury yield rose from 0.93% (4 January 2021) to 4.98% (19 October 2023). The NASDAQ Composite, heavy in long-duration growth companies, fell from 15,833 (3 January 2022) to 10,213 (28 December 2022), a 35% fall.

What the model takes from it: rate stories hit companies by their rate sensitivity (growth and technology most, banks the other way), and expensive stocks fall further on the same bad news (fragility).

## Ordinary markets

Most of the time nothing dramatic happens:

- **Since 1963** the market has spent 89% of days outside recessions, at 14.5% annual volatility and +12.1% a year (log, total return).
- **Deep falls are rare:** drawdowns of more than 25% happened seven times in 63 years (1968 to 1970, 1973 to 1974, 1987, 2000 to 2002, 2007 to 2009, 2020, and 2021 to 2022 at 26%), and three of them exceeded 40%.
- **Crashes after run-ups:** an industry fell 40% within two years after only 6.7% of industry-months, and after 30% of two-year doublings.

The model has to be mostly calm too: in a ten-minute competition a market panic should be rare, and a sector crash unusual.

## Limits of these cases

- US data only, while Haggle's listing is global. The industry mapping to Haggle's sectors is approximate (see `SECTOR_PROFILE` in `apps/server/src/market/assets.ts`).
- French market and industry returns include dividends; Haggle's prices do not.
- One crisis (2007 to 2009) sets the sector crisis sensitivities: thin evidence, used as a guide only.
- Company-level earnings data (for surprise reactions) are not public in these sources. Earnings effects rest on the cited literature, and their sizes are gameplay choices.
