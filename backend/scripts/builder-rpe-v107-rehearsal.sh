#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
node -e 'if (+process.versions.node.split(".")[0] < 20) process.exit(1)'
: "${DATABASE_URL:?Set the URL of an isolated loopback rehearsal cluster}"
node -e 'const u=new URL(process.env.DATABASE_URL); if (!["localhost","127.0.0.1","[::1]"].includes(u.hostname)) { console.error("Use an isolated loopback PostgreSQL cluster."); process.exit(1); }'
cd "$root"
node scripts/test-runner.mjs --project backend --kind disposable --file builder-rpe-v107-rehearsal.test.mjs --file builder-rpe-guard-only.test.mjs --file program-rpe-settings-http-disposable.test.mjs
node scripts/test-runner.mjs --project backend --kind unit --file builder-batch-edit-classify.test.mjs --file builder-tree-batch-routes.test.mjs
printf "%s\n" "RESULT: PASS"
