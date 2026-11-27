#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
node -e 'if (+process.versions.node.split(".")[0] < 20) process.exit(1)'
: "${DATABASE_URL:?Set the URL of an isolated loopback rehearsal cluster}"
node -e 'const u=new URL(process.env.DATABASE_URL); if (!["localhost","127.0.0.1","[::1]"].includes(u.hostname)) { console.error("Use an isolated loopback PostgreSQL cluster."); process.exit(1); }'
: "${OPTIMOVE_DASHBOARDS_PREVIOUS_SHA:?Set the full SHA of the previous build}"
node -e 'if (!/^[a-f0-9]{40}$/.test(process.env.OPTIMOVE_DASHBOARDS_PREVIOUS_SHA)) process.exit(1)'
cd "$root"
node scripts/test-runner.mjs --project backend --kind disposable --file dashboards-manage-v105-rehearsal.test.mjs --file dashboard-manage-v105-scope.test.mjs
node scripts/test-runner.mjs --project backend --kind unit --file dashboard-manage-access.test.mjs
printf "%s\n" "RESULT: PASS"
