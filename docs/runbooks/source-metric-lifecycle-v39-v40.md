# Runbook: migrations v39 and v40 (the revision lifecycle and Q10 part B)

Contract: `docs/ai/v39-revision-lifecycle-contract.md` (J5); as built: section J5 of
`docs/ai/gpexe-metric-variable-mapping-discovery.md`. The two migrations come in one pull request:

- **v39** (`migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql`): the database guards
  of the revision lifecycle (routes L1-L5).
- **v40** (`migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql`): the database twins of the
  text rules (Q10 part B).

The runner applies each migration in its own transaction, in name order, and stops at the first failure
(`backend/src/migrate.js`). `npm start` runs the migrations before the server, so the server starts only when both
are applied.

Every step that touches the production database is the owner's. The executor prepares the scripts and never runs them
there.

## Before the merge

The same day as the merge and deploy, after the last admin write:

1. Run `docs/runbooks/source-metric-revision-lifecycle-v39-preflight.sql` one block at a time. Every value must be the
   expected one.
2. Run `docs/runbooks/source-metric-text-rules-v40-preflight.sql` one block at a time:
   - every value must be the expected one;
   - block 4 must show `refused = 0` in all 21 rows.
3. The old Render service stays inactive during and after the deploy (C100, gate 3).

Stop and report on any other value. The merge needs the owner's order naming both migrations.

## After the deploy

1. `/api/health` serves the merge commit with `ok: true`.
2. Run the v39 post-check (`docs/runbooks/source-metric-revision-lifecycle-v39-postcheck.sql`).
3. Run the v40 post-check (`docs/runbooks/source-metric-text-rules-v40-postcheck.sql`).

## If v40 refuses at deploy

v40's last statement is a fail-closed block. It counts, column by column, the stored rows the new rule refuses, and it
raises if any count is above 0.

**What it looks like:**
- the deploy does not come up;
- the migrator's log shows `ABORT applying "migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql"`
  with SQLSTATE 23514;
- the message names each column with a count, never a value.

**The state:**
- v39 is applied and recorded;
- v40's transaction rolled back, so nothing of v40 is recorded;
- the server does not start while v40 keeps failing.

**Do not run v40's rollback script.** It is only for a recorded v40.

**Recovery, on the owner's decision:**
- **(a)** A commit that removes the v40 file, then a redeploy. v39 stays applied, and the refused column is decided
  afterwards.
- **(b)** If the refused row is in a column that is not append-only, the owner's order to correct that row, then a
  redeploy of the same code.

A count in an append-only column (the value provenance T6, the audit T8, `metric_variable_requests`) cannot be
corrected by an update. It is a new owner decision: exempt that column, or loosen part B. The migration never resolves
it.

## Rollback

On the owner's approval only, for the database the owner names (`.claude/rules/database-safety.md`):
- after a fresh restore-verified backup;
- with the deployed commit no longer carrying the migration file being rolled back.

**Order:** v40 first, then v39. Run each as one script that stops at the first error (`psql -v ON_ERROR_STOP=1 -f`).

- **v40:** `docs/runbooks/source-metric-text-rules-v40-rollback.sql`
  - restores v34's two functions;
  - always possible, also after the lifecycle has written;
  - refuses only without v40 or under a later migration.
- **v39:** `docs/runbooks/source-metric-revision-lifecycle-v39-rollback.sql`
  - restores v37's two functions and drops v39's link function, triggers and index;
  - refuses while v40 or a later migration is recorded, while a v39 object is missing or disabled, and once the
    lifecycle has written a revision. After that the way forward is a new migration.

## Using the lifecycle

The routes are an active platform admin's, in the platform workspace (O1). Retiring or replacing a revision disables
every `needs_review` mapping version pinned to it, a club's included, with the reason "Source revision retired." (O4).
If one of those versions belongs to an archived club, the request is refused with `club_archived` naming that club. Then:
1. restore the club;
2. repeat the request;
3. archive the club again.

While the club is restored, its workspace is open to its members again; keep that interval short.

**Known limit:** retiring or replacing a revision disables its pinned versions in one transaction, with no cap on
their number (M2 has no write quota, C68). Many submitted versions on one revision could keep that transaction past
its 10 s statement bound, and every attempt would then answer `try_again`. This cannot happen today, because no
production revision has a proven unit, so no mapping version exists. It needs a decision before the first production
confirmation (M6): a cap on open versions, or batches (phase 7).

The first production confirmation of a field waits for its evidence (C97, M6).
