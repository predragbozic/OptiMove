# ADR-005: Append-only, checksum-protected migration policy

**Status:** Active

## Context

Multiple people/sessions/branches touch `migrations_v2/`. Without a hard guarantee that
an already-applied migration can't silently change, two environments can drift apart
(one has the old file's effect, another the edited one) while the migration history
looks identical.

## Decision

Migrations are flat files in `migrations_v2/`, applied by `backend/src/migrate.js`, and
once applied are treated as immutable: the runner checksums each file and refuses to
proceed if an already-recorded migration's checksum no longer matches the file on disk.
No transaction-control statements are allowed inside a migration file — the runner
manages the transaction.

## Exact contracts

- Naming: `YYYYMMDDHHMM_description.sql`, regex-validated in `migrate.js`. Real
  examples: `202608211200_weekly_plan_items_empty_structures.sql`,
  `202609071300_training_activity_v4_canonical_functions.sql`,
  `202609101200_training_load_v18_dashboard_catalog_seed.sql`.
- Checksum: `applyNewMigration()` (`migrate.js:762-803`) computes a SHA-256 of the file
  bytes (line 766) and compares it against the stored `schema_migrations.checksum`
  (line 768). Matching checksum on a recorded migration → skip (770-772). Mismatch →
  hard abort: `"${migrationName}" recorded checksum differs from the file on disk now.`
  (line 774).
- Transaction control ban: `assertNoTransactionControl()` (`migrate.js:233`), called
  before every migration runs (line 777). `ROLLBACK TO SAVEPOINT` is exempted. A
  repo-wide grep across all `.sql` files in `migrations_v2/` for bare `BEGIN;`/`COMMIT;`/
  `ROLLBACK;` (excluding inside dollar-quoted function bodies, which the runner's own
  lexer masks out) found zero violations as of 2026-09-14.
- Backfill example that's actually in the repo:
  `migrations_v2/202609080900_training_load_v14_session_tracking_and_rpe_defaults.sql:54,66`
  — adds `plan_sessions.training_load_enabled boolean not null default false`, then
  backfills `set training_load_enabled = true where rpe_enabled = true` — a filtered,
  already-`DEFAULT`-backed single-column set, not a full-table blind rewrite.

## Consequences

- On a feature branch, before that migration has been applied anywhere real, it can
  still be edited freely — the immutability guarantee is about "applied," not
  "committed."
- After merge (or any real apply, including local dev), a needed change goes into a new,
  later-numbered migration file — never an edit to the old one.
- A migration that needs `CREATE INDEX CONCURRENTLY` or another statement incompatible
  with being wrapped in the runner's transaction needs explicit handling — check
  `migrate.js` for how (or whether) that's currently supported before assuming it works
  by default.

## Evidence

Verified against `backend/src/migrate.js` and a full grep of `migrations_v2/*.sql`, in a
research pass on 2026-09-14.

## Supersedes / Superseded by

—
