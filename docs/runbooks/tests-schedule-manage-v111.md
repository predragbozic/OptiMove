# Tests Schedule Manage v111

This bridge stages `tests.schedule.manage` in the database. It keeps Settings
closed for the new word while the previous server can still serve a request.
The separate exposure change follows deployment and retirement of every
pre-bridge worker.

- Migration `migrations_v2/202612131000_tests_v111_schedule_manage_bridge.sql`
- Migration SHA-256 `822f6cc61c51aa66bf48639e9d577439d83d38b8b18efe8b7b41a5bd323f2cf3`
- Exact deployed predecessor for replay `a715b1641b7afa8e683a0b2ea0ccaa9cf8851d36`
- Required v110 SHA-256 `43a36a33128afb57f97f02767f7fd7d49743c4958fd10e774fc9b3f3a95f0cfd`
- Permission evaluator body MD5 before `3fdbf46bdba6bd0a209e26fc1bf7fcb2`, after `a09af1e41b096da583fbaf04727fe992`

The migration seeds the native Club admin and Team coach built-in roles with
Tests View. It seeds their live club versions and actual held native custom
roles only if that layer already grants Tests View. It preserves previous default
acknowledgement state and all unrelated grants. View-only holdings, personal
and platform paths, unrelated programmes and Calendar automation retain
their own existing rules. A standalone team still requires the two held Tests
words and its actor checks without a club ceiling.

1. Rehearse using an isolated loopback PostgreSQL 17 server with Node 20 or
   newer. Run `backend/scripts/tests-schedule-manage-v111-rehearsal.ps1` on
   Windows or `backend/scripts/tests-schedule-manage-v111-rehearsal.sh` on
   Linux. The Windows wrapper prompts securely if neither a test URL nor
   `PGPASSWORD` is present. Require `RESULT: PASS` and a clean database audit.
2. On the destination database, run the read-only
   `tests-schedule-manage-v111-preflight.sql`. Require each boolean true and
   confirm the exact previous build. Run the project's migration runner.
3. Run the read-only `tests-schedule-manage-v111-postcheck.sql` before allowing
   bridge writes. Require each boolean true and record the seed counts by layer.
   The first-use marker remains null at this boundary. Keep Settings closed.
4. Rehearse the exact overlapping old and new builds, including Settings
   edits to the built-in, club version and custom role layers and real native
   schedule effects. Enable Settings in its own release after old workers drain.

With Settings closed and both writers drained, rollback is available only
before the first committed checked native effect and while the audited layers
match the staged state. Run `tests-schedule-manage-v111-rollback.sql` directly
from its LF checkout. It refuses a later migration, changed permission or
marker bodies, disabled guards, altered role revisions, differing grants and
unexpected audit evidence. It restores the previous evaluator body and only
the staged permission items and their audit snapshots. Retain all schedules,
links, messages, check-ins, and unrelated grants. After checked use, fix forward.
