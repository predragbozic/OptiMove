#!/usr/bin/env bash
# The v83 rehearsal (K4b, changing an RPE answer) on a local PostgreSQL - bash. Runs
# backend/scripts/rpe-answer-change-v83-rehearsal.mjs unchanged; see that file and
# docs/runbooks/rpe-answer-change-v83.md for what it does. Loopback only; it creates and drops its own
# optimove_tests_k4bv83rehearsal_* databases.
#
# One trip: when backend/scripts/permission-roles-v84-rehearsal.mjs is in this checkout too (roles R2), it is run right
# after, against the same server, with the same password - one command, one prompt, both results.
#
#   backend/scripts/rpe-answer-change-v83-rehearsal.sh [--host 127.0.0.1] [--port 5432] [--user postgres] [--pg-bin /usr/lib/postgresql/17/bin]
#
# The password: from PGPASSWORD if set, otherwise asked once (not echoed, never printed).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
host="127.0.0.1"; port="5432"; user="postgres"; pgbin=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --user) user="$2"; shift 2 ;;
    --pg-bin) pgbin="$2"; shift 2 ;;
    *) echo "refusing: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$host" in localhost|127.0.0.1|::1) ;; *) echo "refusing: $host is not a loopback host (localhost, 127.0.0.1, ::1)" >&2; exit 2 ;; esac
command -v node >/dev/null || { echo "FAIL  node is not on PATH" >&2; exit 2; }
dump="pg_dump"; [ -n "$pgbin" ] && dump="$pgbin/pg_dump"
command -v "$dump" >/dev/null || [ -x "$dump" ] || { echo "FAIL  pg_dump not found (put PostgreSQL's bin on PATH or pass --pg-bin)" >&2; exit 2; }
[ -d "$here/../node_modules/pg" ] || { echo "FAIL  backend dependencies missing: run npm --prefix backend ci" >&2; exit 2; }
if [ -z "${PGPASSWORD:-}" ]; then
  read -r -s -p "Password for $user@$host:$port (not shown): " pw; echo
else
  pw="$PGPASSWORD"
fi
args=(--host "$host" --port "$port" --user "$user")
[ -n "$pgbin" ] && args+=(--pg-bin "$pgbin")
echo "=== v83 (K4b, changing an RPE answer) ==="
OPTIMOVE_REHEARSAL_PASSWORD="$pw" PGPASSWORD="" node "$here/rpe-answer-change-v83-rehearsal.mjs" "${args[@]}"; code83=$?
code84=0
if [ -f "$here/permission-roles-v84-rehearsal.mjs" ]; then
  echo "=== v84 (roles R2) ==="
  OPTIMOVE_REHEARSAL_PASSWORD="$pw" PGPASSWORD="" node "$here/permission-roles-v84-rehearsal.mjs" "${args[@]}"; code84=$?
fi
pw=""
echo "=== v83: $([ $code83 -eq 0 ] && echo PASS || echo FAIL)$([ -f "$here/permission-roles-v84-rehearsal.mjs" ] && echo " · v84: $([ $code84 -eq 0 ] && echo PASS || echo FAIL)") ==="
[ $code83 -eq 0 ] && [ $code84 -eq 0 ]
