#!/bin/sh
# The multiplayer load matrix on a built server. Needs a throwaway Postgres in the container haggle-test-db.
#   sh scripts/lab/load-matrix.sh <output file>
OUT=$1; TOK=loadtest-token-123456789; PORT=4391
psql() { docker exec -i haggle-test-db psql -U postgres "$@"; }
start() { NODE_ENV=production DATABASE_URL=postgres://postgres:test@127.0.0.1:5499/$1 JOIN_RATE_LIMIT=100000 LOBBY_SECONDS=600 TRADING_SECONDS=600 MAX_PLAYERS=2000 MAX_ROOMS=100 ADMIN_TOKEN=$TOK PORT=$PORT node dist/index.js > /dev/null 2>&1 & PID=$!; sleep 6; }
ledger() { psql -d "$1" -tAc "SELECT count(*) FROM participants p WHERE p.cash_cents <> (SELECT coalesce(sum(l.amount_cents),0) FROM ledger l WHERE l.participant_id = p.id)" | sed 's/^/  ledger mismatches: /' >> "$OUT"; psql -d "$1" -tAc "SELECT count(*) - count(DISTINCT (participant_id, client_order_id)) FROM trades" | sed 's/^/  duplicate trades in db: /' >> "$OUT"; psql -d "$1" -tAc "SELECT count(*) FROM positions WHERE quantity < 0" | sed 's/^/  negative positions: /' >> "$OUT"; }
run() { # label db env...
  L=$1; DB=$2; shift 2
  echo "== $L" >> "$OUT"
  psql -c "CREATE DATABASE $DB" >/dev/null
  start "$DB"
  P0=$PID
  ( while kill -0 $P0 2>/dev/null; do ps -o rss= -p $P0; sleep 2; done | sort -n | tail -1 | awk '{print "  peak rss MB: " int($1/1024)}' >> "$OUT" ) &
  env TARGET=http://localhost:$PORT ADMIN_TOKEN=$TOK "$@" npx tsx scripts/loadtest.ts 2>&1 | grep -v notice | tr -d '\n ' | sed 's/{"clients/\n  {"clients/; s/PASS/\n  PASS/; s/FAIL/\n  FAIL/' | tail -2 >> "$OUT"; echo >> "$OUT"
  curl -s -H "Authorization: Bearer $TOK" localhost:$PORT/metrics | grep -E "tick_lag|checkpoint_fail|db_errors|event_loop" | sed 's/^/  /' >> "$OUT"
  ledger "$DB"
  kill $PID 2>/dev/null; wait $P0 2>/dev/null; sleep 3
}
[ -n "$RECOVERY_ONLY" ] || run "one room, 1000 players" l1 CLIENTS=1000 DURATION=75
[ -n "$RECOVERY_ONLY" ] || run "ten rooms, 100 players each" l2 CLIENTS=1000 ROOMS=10 DURATION=75
[ -n "$RECOVERY_ONLY" ] || run "twenty rooms, 50 players each" l3 CLIENTS=1000 ROOMS=20 DURATION=75
# Restart: kill -9 mid-trading, restart, everyone reconnects with the same cookie.
echo "== hard kill and restart, 300 players in 5 rooms" >> "$OUT"
psql -c "DROP DATABASE IF EXISTS l4 WITH (FORCE)" >/dev/null; psql -c "CREATE DATABASE l4" >/dev/null; start l4
( sleep 45; kill -9 $PID; sleep 5; NODE_ENV=production DATABASE_URL=postgres://postgres:test@127.0.0.1:5499/l4 JOIN_RATE_LIMIT=100000 LOBBY_SECONDS=600 TRADING_SECONDS=600 MAX_PLAYERS=2000 MAX_ROOMS=100 ADMIN_TOKEN=$TOK PORT=$PORT nohup node dist/index.js > /dev/null 2>&1 & echo $! > "$OUT.pid" ) &
env TARGET=http://localhost:$PORT RECOVER=1 CLIENTS=300 ROOMS=5 DURATION=90 npx tsx scripts/loadtest.ts 2>&1 | grep -v notice | tr -d '\n ' | sed 's/{"clients/\n  {"clients/; s/PASS/\n  PASS/; s/FAIL/\n  FAIL/' | tail -2 >> "$OUT"; echo >> "$OUT"
ledger l4; kill "$(cat "$OUT.pid")" 2>/dev/null; rm -f "$OUT.pid"; sleep 3
# Database outage: 15 seconds paused mid-trading.
echo "== database paused 15s, 300 players" >> "$OUT"
psql -c "DROP DATABASE IF EXISTS l5 WITH (FORCE)" >/dev/null; psql -c "CREATE DATABASE l5" >/dev/null; start l5
( sleep 40; docker pause haggle-test-db >/dev/null; sleep 15; docker unpause haggle-test-db >/dev/null ) &
env TARGET=http://localhost:$PORT RECOVER=1 ADMIN_TOKEN=$TOK CLIENTS=300 DURATION=90 npx tsx scripts/loadtest.ts 2>&1 | grep -v notice | tr -d '\n ' | sed 's/{"clients/\n  {"clients/; s/PASS/\n  PASS/; s/FAIL/\n  FAIL/' | tail -2 >> "$OUT"; echo >> "$OUT"
curl -s localhost:$PORT/healthz >> "$OUT"; echo >> "$OUT"
ledger l5; kill $PID 2>/dev/null
