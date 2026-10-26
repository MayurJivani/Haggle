#!/bin/sh
# Downloads the public historical series the calibration measures, into a cache directory that is
# never committed (the raw series stay with their publishers; only derived statistics are kept).
#   Kenneth R. French Data Library (CRSP-based): market, size deciles, 12 industries, momentum.
#   FRED (Federal Reserve Bank of St. Louis): NASDAQ Composite, Baa-Treasury spread, 10-year yield, VIX, NBER recession indicator.
set -eu
DIR=${1:-.history}
mkdir -p "$DIR"
cd "$DIR"
FF=https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp
for f in F-F_Research_Data_Factors_daily_CSV F-F_Momentum_Factor_daily_CSV 12_Industry_Portfolios_Daily_CSV Portfolios_Formed_on_ME_Daily_CSV; do
  curl -sfL -o "$f.zip" "$FF/$f.zip"
  unzip -o -q "$f.zip"
done
for s in NASDAQCOM BAA10Y DGS10 VIXCLS USREC; do
  curl -sfL -o "$s.csv" "https://fred.stlouisfed.org/graph/fredgraph.csv?id=$s"
done
echo "history in $DIR"
