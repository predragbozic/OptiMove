#!/usr/bin/env bash
# P1 PG17 disposable rehearsal; PGPASSWORD is optional for a trusted local cluster.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/dashboard-pages-rehearsal.mjs" "$@"
