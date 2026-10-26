# Market research

What real stock markets do, which of it Haggle's simulated market reproduces, and where each number came from. Every figure marked *measured* was computed by `apps/server/scripts/calibration/measure-history.ts` from the public series listed under Sources, and is stored in [data/history-stats.json](data/history-stats.json); rerun the script to reproduce it. Figures from papers are quoted as their findings, not recomputed. Nothing here is a forecast.

## How the market worked before this redesign

`apps/server/src/market/sim.ts` (October 2026) moved each company once per tick by `beta x market noise + sector noise + own noise + a pull toward an anchor`, plus scheduled news landing as a jump. The anchor was the company's report-based fair value plus slowly fading sentiment.

Known limits:

- **No time scale.** Volatilities were set by feel. A competition saw about a 3% market move, much calmer than any real quarter.
- **No economy.** Nothing persistent connected sectors or companies over time: no business cycle, no credit conditions, no sector booms, no growth. Every rally or slump came from noise or a scheduled story.
- **No momentum or bubbles.** A sector could not run ahead of its earnings, so there was nothing to unwind.
- **No size.** Size had no role beyond each company's own volatility setting.
- **Fair values stood still.** A company only filed a report when an earnings story picked it, so most went many competitions without new numbers.
- **What already worked, and stays:** scheduled news is a jump, never a drift, so a headline is not a free trade. The tape is deterministic and replays exactly after a restart. Trading never moves prices.

## Findings

### Return distributions and volatility

*Measured, US market (CRSP via the French library), daily log returns 1963 to 2026:*

- **Spread and shape:** sd 1.02% a day (16.3% a year), skew −0.77, excess kurtosis 18.
- **Tails:** 1.4% of days move more than 3 sd, against 0.27% for a normal distribution, and 0.3% move more than 5 sd.
- **Extremes:** the worst day was 19 October 1987 (log −19.1%), the best 13 October 2008 (+10.8%).
- **Direction:** returns barely predict tomorrow's (autocorrelation 0.016).
- **Volatility clustering:** absolute returns are strongly persistent, with autocorrelation 0.26 at one day, 0.31 at five, 0.20 at twenty and 0.09 at 120 days.
- **Leverage effect:** volatility rises more after falls than after rises (corr(r, next day's r²) = −0.09).

These are the classic stylized facts (Cont 2001). Volatility clustering is what ARCH/GARCH models capture (Engle 1982; Bollerslev 1986), and the asymmetry is what GJR-GARCH adds (Glosten, Jagannathan and Runkle 1993).

### The business cycle

*Measured*, with NBER recession months (FRED USREC):

- **Duration:** since 1945 expansions last 58.4 months on average and recessions 10.2. Recessions cover 11.2% of trading days since 1963.
- **Returns:** the market returns +12.1% a year (log, total return) outside recessions and −3.8% inside them.
- **Volatility:** 14.5% a year outside recessions and 26.3% inside.

### Sectors

*Measured* on Kenneth French's 12 US industry portfolios, daily 1963 to 2026:

- **Correlation:** the average pairwise correlation is 0.68. It was 0.64 in calm 2004 to 2006 and 0.88 between September 2008 and March 2009, so diversification thins out in a crisis.
- **Market betas:** from 0.59 (utilities) to 1.24 (business equipment, mostly technology).
- **Volatility beyond beta:** what is left once beta is removed runs from 6.7% (manufacturing) to 16.5% (energy) a year.
- **2007 to 2009 losses** ranged from −34% (healthcare) and −36% (consumer non-durables) to −76% (finance) and −77% (consumer durables, including carmakers).
- **Recoveries:** in the year after the March 2009 trough, durables rose 226% while utilities rose 45%.

### Size

Smaller firms have historically earned more on average and carried more risk (Banz 1981; Fama and French 1993). *Measured*:

- **Daily figures mislead:** at daily frequency the smallest size decile looks *less* volatile than the largest (16.2% against 16.7% a year), with a beta of 0.77. Thinly traded small shares print stale prices, which hides their risk.
- **Monthly figures show it:** the smallest decile has 22.0% annual volatility against 14.8% for the largest, with market betas of 1.12 and 0.93.
- **In the crisis and after:** the smallest decile fell 65% from October 2007 to March 2009 against 53% for the largest, then rose 126% in the following year against 64%.
- **The size factor:** SMB (small minus big) has an annual sd of 8.7% and is nearly uncorrelated with the market (−0.04).

### Momentum

Stocks that rose most over the past year tend to keep outperforming over the next few months (Jegadeesh and Titman 1993), much of it at the industry level (Moskowitz and Grinblatt 1999). The strategy is prone to sudden severe crashes, typically in rebounds after market falls (Daniel and Moskowitz 2016). *Measured*:

- **Stock momentum:** the French momentum factor (top minus bottom prior 12-month returns) earned 6.4% a year with 12.6% volatility and skew −1.44 since 1963.
- **Momentum crashes:** its worst falls were 72% (1932 to 1942) and 63% (November 2008 to January 2010).
- **Industry momentum:** an industry's past-year lead over the market correlates 0.058 with its next month's lead. The three leading industries beat the three lagging ones by 0.59% a month, in 58% of months.
- **The market as a whole:** past-year return barely predicts its next month (correlation 0.05).

Momentum is a persistent tendency, not a law. It fails often and occasionally violently.

### Bubbles and crashes

Greenwood, Shleifer and You (2019) find that industries whose prices doubled over two years crashed more often afterwards than other industries, and that the risk rose with features of the run-up such as volatility, the age of firms and new issuance. A run-up alone did not reliably predict lower average returns. *Measured* in the same spirit on the 12 industries, 1926 to 2026: after an industry had doubled over two years, it fell 40% from that level within the next two years in 30% of cases, against 6.7% for all industry-months. Most such run-ups did not end in a crash.

Credit plays a part. Jordà, Schularick and Taylor (2015) find that bubbles financed by credit expansion are followed by deeper recessions and slower recoveries than other bubbles. The IMF's April 2003 World Economic Outlook (chapter "When Bubbles Burst") documents how often equity and housing booms ended in busts across countries, and how busts tied to credit and housing did more economic damage.

Barberis, Greenwood, Jin and Shleifer (2018) model bubbles as extrapolators chasing past price increases, which tempers rational selling but does not abolish it. That is the mechanism Haggle's speculation uses.

### Credit conditions

*Measured* on the Baa corporate yield minus the 10-year Treasury (FRED BAA10Y):

- **Level:** it averaged 2.06 points from 1990 to 2006, bottomed at 1.48 in March 2005 and peaked at 6.16 on 4 December 2008.
- **Link to stocks:** on days it widened, the market fell about 3.2% per point (correlation −0.10).
- **Persistence:** the level mean-reverts slowly, with a daily AR(1) half-life of about 520 trading days.

Gilchrist and Zakrajšek (2012) show credit spreads carry information about the business cycle, beyond default risk alone.

### Rates, earnings and valuation

- **Monetary surprises:** Bernanke and Kuttner (2005) find that a surprise 25 basis point cut in the federal funds rate lifts broad US stocks by about 1% on the day. The effect works mainly through expected future excess returns and dividends, not through real rates directly.
- **Earnings surprises:** stock prices react to earnings relative to expectations (Ball and Brown 1968). The reaction continues for weeks after the announcement (post-earnings-announcement drift; Bernard and Thomas 1989). Haggle deliberately does not reproduce that drift, because a known, tradeable drift after a headline is exactly what the game must not offer.
- **Valuation:** valuation ratios have little power over short horizons but predict long-horizon returns (Campbell and Shiller 1998).
- **Rate shocks and growth stocks:** in 2022 the 10-year Treasury yield rose from 0.93% (January 2021 low) to 4.98% (October 2023 high), and the Nasdaq Composite fell from 15,833 (3 January 2022) to 10,213 (28 December 2022), a 35% decline.

## Statistical tendency or causal mechanism

The model is built from mechanisms (cycle, credit, demand, speculation, fragility). It is checked against tendencies (the measured figures above):

| Finding | Status in the literature | In Haggle |
| --- | --- | --- |
| Volatility clusters, falls raise it | Robust tendency | GJR-GARCH on the market factor |
| Recessions lower returns and raise volatility | Robust tendency | Hidden two-state cycle with measured durations |
| Credit spreads widen in stress and hurt equities | Robust tendency, partly causal (financing) | Hidden credit level, measured response |
| Industry and stock momentum | Robust tendency, mechanism debated | Emerges from persistent demand and growth, plus thresholded extrapolation |
| Run-ups raise crash risk | Tendency (Greenwood et al.); no indicator predicts reliably | Crash hazard rises with speculative froth and credit stress, never certain |
| Small firms riskier, with higher beta | Robust at monthly frequency | Size loading from relative market value |
| Expensive stocks fall harder on bad news | Plausible mechanism, weaker evidence | Gameplay parameter (fragility), capped at 2× |

## Sources

Data:

- Kenneth R. French, Data Library: Fama/French 3 factors (daily), momentum factor (daily), 12 industry portfolios (daily), portfolios formed on size (daily). https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html (CRSP-based)
- FRED, Federal Reserve Bank of St. Louis: NASDAQ Composite (NASDAQCOM), Moody's Baa yield relative to the 10-year Treasury (BAA10Y), 10-year Treasury yield (DGS10), CBOE VIX (VIXCLS), NBER recession indicator (USREC). https://fred.stlouisfed.org/
- NBER Business Cycle Dating. https://www.nber.org/research/business-cycle-dating
- Federal Reserve History: [The Great Recession and Its Aftermath](https://www.federalreservehistory.org/essays/great-recession-and-its-aftermath), [Stock Market Crash of 1987](https://www.federalreservehistory.org/essays/stock-market-crash-of-1987), [The Dot-Com Bubble](https://www.federalreservehistory.org/essays/dotcom-bubble)

Papers (DOIs checked against Crossref):

- Ball, R., Brown, P. (1968). An Empirical Evaluation of Accounting Income Numbers. *Journal of Accounting Research* 6, 159. doi:10.2307/2490232
- Banz, R. (1981). The relationship between return and market value of common stocks. *Journal of Financial Economics* 9, 3-18. doi:10.1016/0304-405X(81)90018-0
- Barberis, N., Greenwood, R., Jin, L., Shleifer, A. (2018). Extrapolation and bubbles. *Journal of Financial Economics*. doi:10.1016/j.jfineco.2018.04.007
- Bernanke, B., Kuttner, K. (2005). What Explains the Stock Market's Reaction to Federal Reserve Policy? *Journal of Finance* 60, 1221-1257. doi:10.1111/j.1540-6261.2005.00760.x
- Bernard, V., Thomas, J. (1989). Post-Earnings-Announcement Drift: Delayed Price Response or Risk Premium? *Journal of Accounting Research* 27, 1. doi:10.2307/2491062
- Bollerslev, T. (1986). Generalized autoregressive conditional heteroskedasticity. *Journal of Econometrics* 31, 307-327. doi:10.1016/0304-4076(86)90063-1
- Campbell, J., Shiller, R. (1998). Valuation Ratios and the Long-Run Stock Market Outlook. *Journal of Portfolio Management* 24, 11-26. doi:10.3905/jpm.24.2.11
- Cont, R. (2001). Empirical properties of asset returns: stylized facts and statistical issues. *Quantitative Finance* 1, 223-236. doi:10.1080/713665670
- Daniel, K., Moskowitz, T. (2016). Momentum crashes. *Journal of Financial Economics* 122, 221-247. doi:10.1016/j.jfineco.2015.12.002
- Engle, R. (1982). Autoregressive Conditional Heteroscedasticity with Estimates of the Variance of United Kingdom Inflation. *Econometrica* 50, 987. doi:10.2307/1912773
- Fama, E., French, K. (1993). Common risk factors in the returns on stocks and bonds. *Journal of Financial Economics* 33, 3-56. doi:10.1016/0304-405X(93)90023-5
- Gilchrist, S., Zakrajšek, E. (2012). Credit Spreads and Business Cycle Fluctuations. *American Economic Review* 102, 1692-1720. doi:10.1257/aer.102.4.1692
- Glosten, L., Jagannathan, R., Runkle, D. (1993). On the Relation between the Expected Value and the Volatility of the Nominal Excess Return on Stocks. *Journal of Finance* 48, 1779-1801. doi:10.1111/j.1540-6261.1993.tb05128.x
- Greenwood, R., Shleifer, A., You, Y. (2019). Bubbles for Fama. *Journal of Financial Economics* 131, 20-43. doi:10.1016/j.jfineco.2018.09.002
- International Monetary Fund (2003). *World Economic Outlook, April 2003: Growth and Institutions*, chapter II "When Bubbles Burst". doi:10.5089/9781589062146.081
- Jegadeesh, N., Titman, S. (1993). Returns to Buying Winners and Selling Losers: Implications for Stock Market Efficiency. *Journal of Finance* 48, 65-91. doi:10.1111/j.1540-6261.1993.tb04702.x
- Jordà, Ò., Schularick, M., Taylor, A. (2015). Leveraged bubbles. *Journal of Monetary Economics* 76, S1-S20. doi:10.1016/j.jmoneco.2015.08.005 (NBER working paper 21486)
- Moskowitz, T., Grinblatt, M. (1999). Do Industries Explain Momentum? *Journal of Finance* 54, 1249-1290. doi:10.1111/0022-1082.00146
