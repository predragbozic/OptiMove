#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
node -e 'if (+process.versions.node.split(".")[0] < 20) process.exit(1)'
: "${DATABASE_URL:?Set the URL of an isolated loopback rehearsal cluster}"
node -e 'const u=new URL(process.env.DATABASE_URL); if (!["localhost","127.0.0.1","[::1]"].includes(u.hostname)) { console.error("Use an isolated loopback PostgreSQL cluster."); process.exit(1); }'
: "${OPTIMOVE_M3C_PREVIOUS_SERVER:?Set the clean checkout of the previous build}"
: "${OPTIMOVE_M3C_PREVIOUS_SHA:?Set the full SHA of the previous build}"
cd "$root"
node scripts/test-runner.mjs --project backend --kind disposable --file training-load-m3c-v103-rehearsal.test.mjs --file training-activity.test.mjs --file training-activity-metrics-integration.test.mjs
printf "%s\n" "RESULT: PASS"
