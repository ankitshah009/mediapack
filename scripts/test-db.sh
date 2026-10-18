#!/usr/bin/env bash
# Apply migrations to a throwaway local Postgres and run invariant tests.
# Needs: brew install postgresql@17
set -euo pipefail
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$(mktemp -d)"
PORT="${PORT:-55432}"
trap '"$PG_BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true' EXIT  # data dir is left in $TMPDIR

"$PG_BIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA" -l "$DATA/log" start -w >/dev/null
PSQL=("$PG_BIN/psql" -h "$DATA" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

# Stub the Supabase-provided objects the migrations reference.
"${PSQL[@]}" -c "create role anon; create role authenticated; create role service_role;"
for f in "$ROOT"/supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f"; done
echo "migrations applied"
"${PSQL[@]}" -At -f "$ROOT/supabase/tests/invariants.sql" 2>&1 | grep -E "ok  |FAILED|PASSED|ERROR" | sed 's/^psql:.*NOTICE:  /  /'
