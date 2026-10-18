#!/usr/bin/env bash
# Disposable Postgres only: run the existing invariants plus real-session demo races.
set -euo pipefail
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/mediapack-demo-db.XXXXXX")"
PORT="${PORT:-55435}"
trap '"$PG_BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true' EXIT
"$PG_BIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -h ''" -l "$DATA/log" start -w >/dev/null
PSQL=("$PG_BIN/psql" -h "$DATA" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -c "create role anon; create role authenticated; create role service_role;"
for f in "$ROOT"/supabase/migrations/*.sql; do "${PSQL[@]}" --single-transaction -f "$f"; done
"${PSQL[@]}" -At -f "$ROOT/supabase/tests/invariants.sql" 2>&1 | grep -E "ok  |FAILED|PASSED|ERROR" | sed 's/^psql:.*NOTICE:  /  /'
MEDIAPACK_DEMO_TEST_SOCKET="$DATA" MEDIAPACK_DEMO_TEST_PORT="$PORT" node --test "$ROOT/supabase/tests/demo-buyer.test.mjs"
