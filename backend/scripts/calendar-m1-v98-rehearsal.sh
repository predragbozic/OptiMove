#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
node -e 'if (+process.versions.node.split(".")[0] < 20) process.exit(1)'
: "${DATABASE_URL:?Set the URL of an isolated loopback rehearsal cluster}"
cd "$root"
node scripts/test-runner.mjs --project backend --kind disposable --file calendar-m1-v98-rehearsal.test.mjs --file calendar-m1-disposable.test.mjs
