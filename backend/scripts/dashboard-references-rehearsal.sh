#!/usr/bin/env bash
set -euo pipefail
# Set DATABASE_URL only for a dedicated loopback PostgreSQL test cluster.
: "${DATABASE_URL:?Set DATABASE_URL for the dedicated loopback test cluster}"
node "$(dirname "$0")/dashboard-references-rehearsal.mjs"
