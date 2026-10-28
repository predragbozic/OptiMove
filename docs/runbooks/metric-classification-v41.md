# Runbook: migration v41 (domains and categories of canonical variables, phase 12b)

Contract: `docs/ai/phase12-domains-categories-contract.md` (J6, accepted as C101); as built: section J6 of
`docs/ai/gpexe-metric-variable-mapping-discovery.md`.

- **v41** (`migrations_v2/202610281000_training_load_v41_metric_classification.sql`):
  - the `key` and `description` columns of `training_load.metric_domains` and `metric_categories`;
  - the change and request records (`metric_classification_changes`, `metric_classification_requests`);
  - the database guards of every write of a `system` or `club` domain, category or link;
  - O3's index: a canonical category under at most one domain.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server, so the server starts only once v41 is applied.

Every step that touches the production database is the owner's. The executor prepares the scripts and never runs them
there.

## Before the merge

The same day as the merge and deploy:

1. Run `docs/runbooks/metric-classification-v41-preflight.sql` one block at a time. Every value must be the expected
   one:
   - block 5 must show no `system` or `club` row in the three tables;
   - block 7 is information only: record its numbers.
2. Stop and report on any other value.

The merge needs the owner's order naming the pull request and v41.

## After the deploy

1. `/api/health` serves the merge commit with `ok: true`.
2. Run `docs/runbooks/metric-classification-v41-postcheck.sql` one block at a time:
   - block 1 compares the recorded checksum with the one in the file;
   - block 3 shows no change, request or canonical row until an admin uses the new routes.

## If v41 refuses at deploy

v41's first statement is a fail-closed count. It refuses while any `system` or `club` domain, category or link exists
(C101: the owner's count of 2026-10-28 found none).

**What it looks like:**
- the deploy does not come up;
- the migrator's log shows `ABORT applying "migrations_v2/202610281000_training_load_v41_metric_classification.sql"`
  with SQLSTATE 23514;
- the message gives three counts (domains, categories, links), never a name or an id.

**The state:**
- nothing of v41 is applied or recorded;
- the server does not start while v41 keeps failing.

**Do not run v41's rollback script.** It is only for a recorded v41.

**Recovery, on the owner's decision:**
- **(a)** A commit that removes the v41 file, then a redeploy. Then decide what the counted rows are.
- **(b)** The owner's order to remove or re-own the counted rows (they were written after the count, through the older
  API), then a redeploy of the same code.

Adopting such rows as canonical (O9's legacy branch, a NULL key) is not built: it is a new decision.

## Rollback

On the owner's approval only, for the database the owner names (`.claude/rules/database-safety.md`):
- after a fresh restore-verified backup;
- with the deployed commit no longer carrying the v41 file or the classification routes.

Run `docs/runbooks/metric-classification-v41-rollback.sql` as one script that stops at the first error
(`psql -v ON_ERROR_STOP=1 -f`). It refuses, changing nothing:
- without v41, or under a later migration;
- once any change or request row, or any `system` or `club` domain, category or link exists. After that the way
  forward is a new migration;
- while a v41 function, trigger or index is missing, or a v41 trigger is disabled.

## Using the classification

The routes are under `/api/training-load/sources/metrics/classification` (C1–C5), and the variable reads take
`domainId` or `categoryId` (C6):
- an active platform admin writes `system` rows in the platform workspace and a club's rows in that club's workspace;
- a club's active admin writes the club's rows in its own workspace;
- a team coach reads the club's classification in its team workspace and writes nothing.

The older `/api/training-load/metrics` API answers `409 canonical_classification_read_only` for a `system` or `club`
domain, category or link (O7). Its team and user rows are unchanged.

**What the database refuses** (whoever writes, SQL included):
- a `system` or `club` write without the acting user of the transaction, or by a user without the right;
- deleting a canonical domain or category (it is archived), or changing its key, owner or creator;
- updating a canonical link (it is removed and created again);
- a canonical category under a second domain;
- a change without its request row (at COMMIT).

A future migration that writes a canonical row must switch these guards off inside itself and say so.

**O8, recorded as a follow-up:** the older reads (and so the Activities and dashboard pickers) show a club's domains
and categories to its club admins only. A team coach's picker keeps grouping a club variable under "Other" until that
is decided.
