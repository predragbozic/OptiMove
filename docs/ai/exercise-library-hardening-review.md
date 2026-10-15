# Exercise Library hardening review — 2026-10-15

Historical hardening snapshot. The later confirmed reuse policy and executed
isolated rehearsal are documented in `exercise-library-final-access-semantics.md`;
its current contract supersedes the open decisions and unexecuted-test status below.

Scope: existing uncommitted release checkout at detached HEAD
`66c50d69d190aa5a7f645b6fe910b631133a2870`, not a fresh implementation.
No branch, commit, PR, merge, deploy, persistent DB access, migration execution,
Training Load modification, or UI modification was performed in this hardening.
This document supersedes earlier release-plan claims about rollback and migration
coverage; earlier results describe the previous patch, not the new source guard.

## Findings and fixes

1. **HIGH / confirmed / fixed in application code.**
   `backend/src/routes/builder.js` POST `/nodes/:nodeId/exercises` previously
   authorized and inserted with separate pool queries and no collection lock.
   It now holds the existing shared transaction advisory lock
   `hashtextextended('exercise_collections', 0)` from before the access read
   through insertion and commit on one client. Collection writes already take
   the exclusive side in `routes/exerciseCollections.js`; exercise save already
   takes the shared side. No second advisory-lock namespace was introduced.
   An add committed before revoke remains a pre-existing snapshot, not a new
   unauthorized write. An add queued behind revoke rechecks current grants and
   returns 404 with no new item. Two real HTTP handlers on distinct DB connections
   were tested in both orders, observing actual DB lock waits, not assuming timing.

2. **MEDIUM / confirmed / fixed.**
   `routes/exercises.js:getOrCreateLookup` globally resolved names and
   unconditionally reactivated inactive rows, including another user's private row.
   Existing code documents global name/slug uniqueness; the tracked legacy SQL
   does not establish every deployed lookup constraint. No existing database was
   inspected, so exact production constraints remain an explicitly unverified
   preflight item. The fix preserves global name resolution and does not create
   per-owner duplicates or change the schema's lookup model. Reuse requires the
   existing library visibility scope; implicit reactivation is allowed only for an
   owned user-scoped value. Unavailable collisions return generic 409 and roll back
   the save. Active system values remain reusable; inactive system values are not
   silently reactivated through a coach exercise edit. The two-user tests use a
   representative global unique name index. Club/team read scope is preserved;
   there is no newly granted right to reactivate club/team values.

3. **MEDIUM / confirmed / schema fix prepared, execution unverified.**
   The original `exercise_personal_source_check` checks the target owner and
   non-self linkage, not the source's type. A direct SQL write could form a
   private-to-private chain. Existing HTTP save paths do not trust payload source
   fields and only create copies after authorizing a system source.
   New forward-only `202610151300_exercise_copy_source_integrity.sql` validates
   existing rows without repairing them, adds a source-side index, and installs a
   structural trigger. Copies require a canonical system source (system scope,
   no own source); established copy owner/scope/source cannot detach, transfer or
   repoint; a referenced system source cannot cease being canonical. Ordinary row
   locks protect canonical-source reads. Source demotion fails closed outside
   READ COMMITTED, avoiding a stale inverse-reference check at REPEATABLE READ.
   The migration itself also requires READ COMMITTED before acquiring its table
   lock: a lock alone would not refresh an older REPEATABLE READ preflight
   snapshot. Preflight and trigger installation then hold that lock blocking writers.
   The original migration is unchanged, SHA-256:
   `6b9d3b29bf9019ed25ab1a62f657c64334ef87977623c45b79723a1f9ee12b6a`.
   The new migration and DB guard integration tests have NOT been executed.

### Direct SQL security boundary

The trigger enforces structure, not a logged-in actor's block membership.
Raw SQL using the application's privileged DB credentials is not a supported
coach API. The new trigger cannot infer a trusted HTTP user from those credentials.
No RLS, new database role design, or actor session-variable system is introduced.
A privileged writer can bypass triggers or delete/recreate unreferenced records.
Review actual DB grants/RLS before release; if end users have direct table write
access, deployment is blocked pending a separately designed authorization fix.

## Revocation and program snapshots — unchanged product semantics

| Situation | Current behavior | Decision |
|---|---|---|
| Exercise Library original and owner's copy | Hidden after grant revocation; a copy remains private after regrant. | Already confirmed by owner. |
| Historical programs | Existing item snapshots are retained; plan access, not current library grants, gates reads. | Confirm historical retention explicitly; no deletion here. |
| Active programs and Athlete display | Same snapshot retention; revocation does not remove an assigned exercise or stop its use in the active plan. | Owner decision needed: grandfather prescriptions or restrict future active use? |
| Duplicate, assign, copy block/session/node, edit-draft and resubmit | Existing copy paths copy plan items/snapshots without checking each exercise's current library grant. Plan authorization still applies. | Owner decision needed: permit snapshot reuse after revoke, deny it, or require replacement? |
| Add afresh from Library | Current grant required; add serializes with revoke. | Fixed application behavior. |

Evidence: `backend/src/routes/plans.js` reads
`plans.v_weekly_plan_items` and `plans.v_program_plan_items` after plan access
checks; `create_plan_read_views.sql` and
`migrations_v2/202608231700_weekly_calendar_draft_hidden_and_session_name.sql`
join exercise metadata without the Library grant predicate.
`backend/src/builderTreeBatch.js:copyBuilderSessionContents` and
`routes/builder.js:copyNodeTree` copy stored plan items.
Some plan views also return live exercise identifiers/code/name from an unrestricted
join; do not interpret snapshot retention as complete isolation of all Library
metadata. No status-based historical/active exception is added by revocation.
Bytes already delivered to browsers cannot be withdrawn.

## Static migration / compatibility / rollback review

- Lexical order on this checkout is v37
  `202610151000_training_load_v37_source_metric_revision_guards.sql`, ownership
  `202610151200_...`, then source guard `202610151300_...`.
  The two Exercise Library migrations reference no Training Load objects and have
  no new M2b schema dependency, but the existing startup runner applies ALL pending
  migrations. If v37 or any older main migration is pending, this is not an
  Exercise-Library-only deployment. Do not edit, skip, or implicitly authorize M2b.
- New application code requires the ownership migration. The guard requires its
  source column/FK/check. Each file has its own runner transaction: failure in the
  guard does not roll back an already committed ownership migration.
- New objects/nullable source column are structurally additive for old code, but
  old application code is NOT security-compatible with restricted blocks: it lacks
  their read predicate and copy-on-write contract. Mixed old/new instances or a
  code-only rollback can expose blocked system exercises or mutate originals.
- The trigger intentionally rejects privileged provenance reassignment and source
  demotion outside READ COMMITTED. Review administrative/import tooling that might
  perform such writes. Existing API create/edit paths do not request them.
- Locks and the source index build can block writes on a large exercise table.
  Runner timeout and production-size execution remain untested. Failed preflight
  stops without changing legacy rows; invalid rows require a separately approved
  remediation, never automatic conversion.
- The rollback script now drops the new trigger/function/index before dropping
  provenance, but still refuses ALL populated blocks, grants, audits or copies.
  It is an operator-reviewed, empty-state-only procedure, not a migration or an
  automated deploy action. Quiesce ALL writers and run it in one explicit
  transaction after separate approval; its existence does not authorize execution.
  Do not run it on a live writable service, delete data to pass its guard, edit
  migration checksums, or delete migration ledger records to force a restart.
  Ledger reconciliation and a data-preserving post-use rollback require a separate
  reviewed recovery plan. Prefer a forward application fix after real usage.

## Test evidence from this hardening

- Disposable runtime tests: 30 passed, 0 failed, 1 explicitly skipped rollback
  test (Builder access 10; exercise upsert 20 passed plus 1 skip).
  Fixtures are handwritten runtime contracts, NOT migration validation.
  Two-user lookup denial checks both PATCH and POST, no row changes, generic 409;
  source payload spoofing tests cover own/foreign private and inaccessible system
  targets. Original/copy privacy and revoke/regrant regression cases also pass.
- Existing Builder unit tests: 13 passed, 0 failed.
- Static migration file tests: 2 passed, 0 failed. Only UTF-8, filename/transaction
  control rules and original-file checksum were checked; SQL was not executed.
  The main test runner classified this file as DB-related because it imports the
  migration parser, so its unit selection ran zero tests. The two tests were then
  actually run directly with DATABASE_URL unset and dotenv pointed at no file.
- Prepared `exercise-copy-source-integrity.test.mjs` integration suite is
  explicitly skipped and was not executed: private/foreign/derived/missing/self
  sources, immutable copy provenance, source demotion/deletion, older repeatable-read
  snapshot, both orders of a two-connection READ COMMITTED copy/demotion race,
  and a migration preflight interleaving with an older REPEATABLE READ snapshot.
  Separate permission is needed before enabling migration execution.
- No full suite, frontend tests/build, migration/rollback SQL, production schema
  replay or production smoke tests were run in this hardening. Earlier UI/build
  evidence pertains only to the previous patch.
- Test server was independent PostgreSQL 17 on 127.0.0.1:55487; every test created
  and dropped a unique disposable DB. Runner audit found no remaining DBs and no
  writes to maintenance postgres. Server was stopped after tests. Persistent
  OPTIMOVE and all remote services were untouched.

Exact executed targeted commands:

```text
node scripts/test-runner.mjs --project backend --kind disposable --file builder-exercise-access.test.mjs --file exercises-upsert.test.mjs --json ../hardening-backend-tests.json --log-dir ../test-logs/hardening-backend
node scripts/test-runner.mjs --project backend --kind unit --file builder-tree-batch.test.mjs --file builder-timing.test.mjs --json ../hardening-unit-tests.json --log-dir ../test-logs/hardening-unit
node --test backend/tests/exercise-copy-source-static.test.mjs
git diff --check
```

## Release gates

Ready for human review of the local patch, not for merge/deploy. Before deployment:
confirm active/reused snapshot policy; separately authorize and execute guard
integration tests and migration rehearsal on an isolated representative schema;
verify lookup constraints, existing ownership/provenance, DB privileges, migration
ledger (especially v37), backup/restore, all-instance cutover and a data-preserving
recovery plan. PR creation still needs the owner's approval after this review.
