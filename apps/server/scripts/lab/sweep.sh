#!/bin/sh
# Runs one labelled parameter set through the fast lab and the calibration: sweep.sh <label> '<json>'
L=$1; export LAB_SET=$2
node --import tsx scripts/lab/run.ts "$L" --procs 11 --price-seeds 8 --seeds 200 2>/dev/null >/dev/null
npx tsx scripts/calibration/run-sim.ts 200 2>/dev/null | grep -v notice > "../../docs/data/lab/$L.calibration.txt"
