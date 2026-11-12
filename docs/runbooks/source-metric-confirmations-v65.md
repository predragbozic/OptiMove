# Runbook: migration v65, the stored confirmation of a drag-and-drop mapping (J18, M-A)

Contract: `docs/ai/c112-drag-mapping-contract.md` (J18; accepted by the owner as C113 on 2026-11-04; sections 5.1–5.4,
5.6, 5.8 and 15). This is **M-A**, the migration of slice 18-1. The gate on a club admin's activation is **M-B**, a
later migration that ships with the board's backend (18-3) and frontend (18-4) in one deploy.

- **v65** (`migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql`) adds the evidence store of a
  board save. **No application code reads or writes it yet**, so the deploy changes nothing a user can see.
  - **A check before anything changes:** the four T8 bodies it replaces are the ones in force (by md5: v52's
    `source_metric_audit_row_ok` and `source_metric_audit_actor_guard`, v48's `source_metric_audit_insert_guard`,
    v50's `source_metric_audit_revision_guard`), and T8's action CHECK is v34's text; otherwise the migration refuses
    (`23514`) and changes nothing.
  - **T9** `source_metric_confirmations`: the act (who, when, club, team, binding, connection). Only the
    `team_mapping` shape; the time and the 90-day expiry are set by the database.
  - **T9s** `source_metric_confirmation_sessions`: the stored session (candidate id without a foreign key, content
    hash, session id, start, check, pair index). No athlete id.
  - **T9i** `source_metric_confirmation_items`: one row per mapping version, with copies of its facts and, for a row
    the admin checked, two athletes' raw and stored values, a random salt and a digest.
  - **Guards:** the acting user and the derived basis; the binding's club and connection; the check and candidate
    facts (not superseded, not an undone import, the same start); the T4 and T2b facts; append-only; the two removals
    of values; the deferred links at COMMIT. Every refusal is fixed text with no id, name or value.
  - **`remove_expired_confirmation_values(p_limit)`**: nulls the values and the salt of confirmations past their date,
    one bounded batch, under a purge marker bound to its transaction.
  - **T8** `source_metric_audit`: the nullable `confirmation_id`, the actions `mapping_confirmation`,
    `confirmation_values_expired` and `confirmation_values_erased`, one row per confirmation and action, and the four
    bodies (every existing line byte for byte; the new lines sit between the `M-A (J18)` marks).
  - **Not in it:** the gate (M-B), T2b's observation columns and the observed acts (18-P), any code.
  - **Locks:** T4 `SHARE ROW EXCLUSIVE` first (it waits for a writer up to the runner's `lock_timeout`, 30 s). The
    new foreign keys then take `SHARE ROW EXCLUSIVE` on `public.clubs`, `public.teams`, `public.users`, the source
    connections and bindings, the import checks and the source revisions, each within the runner's `lock_timeout`.
    Only then T8 `ACCESS EXCLUSIVE` with `NOWAIT`, held for T8's own statements only. T5 is not locked.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server.

**Deploy compatibility.** The new schema with the current code is safe: the code writes none of the three new actions
and never sets `confirmation_id`, and every existing branch of the four bodies is unchanged. The same holds after a
code rollback. A schema rollback is refused once a confirmation exists.

## Before the merge (the standing order for migration PRs)

`docs/ai/metrics-core-plan.md`, section 2, "Standing order for migration PRs", applies. The executor never calls a
Supabase connector tool and never touches the production database.

1. Right before the merge, on the merge tree: the 12-digit prefixes are unique (`.claude/rules/migrations.md`), and the
   md5 of the four bodies on `main` is still the list of the preflight's block 3 (another migration may have replaced
   one while this pull request was open). If the last migration on `main` is no longer v64, block 2 of the preflight is
   re-issued with that migration's name and checksum first.
2. The *Rukovodilac* runs `docs/runbooks/source-metric-confirmations-v65-preflight.sql` read-only, one block at a time,
   on the same UTC day as the merge. Every value must be the expected one:
   - block 1 shows PostgreSQL 15 or later;
   - block 2 shows the previous migration recorded with its checksum as the last one, and no v65;
   - block 3 shows the four bodies v65 replaces in force;
   - block 4 shows T8's action CHECK and table comment as v34 wrote them;
   - block 5 shows nothing of v65 exists yet, every trigger of T8 enabled (7), and the functions v65 relies on;
   - block 6 shows the migrator's role owns T8 and the four functions and may create in `training_load`;
   - block 7 shows no default for the actor setting or the purge marker;
   - block 8 shows a quiet moment: no lock on T8, no writer on T4 or on the seven tables the new foreign keys
     reference, no running check or identity load, no session idle in a transaction;
   - block 9 is a sanity line: no T8 row of the three new actions;
   - block 10 is information for 18-3, not a condition: how the server logs statements and their parameters.
3. Both ★★ GOs on the exact head, then the owner's order that names v65 and the file's sha256 (the post-check's
   block 1 carries it).

## Deploy order

1. The merge from exactly the reviewed head.
2. The owner's deploy of exactly that commit, **right after** the *Rukovodilac*'s preflight block 8 came back clean.
3. The *Rukovodilac*'s smoke (`/api/health` serves the commit) and its read-only post-check,
   `docs/runbooks/source-metric-confirmations-v65-postcheck.sql`.

No PR is merged into `main` from the merge until the deploy and the post-check have passed.

### If the deploy fails on a lock

v65 first waits, at most 30 seconds each, for writers of T4 and of the tables its foreign keys reference; a longer
holder fails it with *canceling statement due to lock timeout*. It then takes the audit table (T8) with `NOWAIT`: if
anyone reads or writes it at that moment (the Mappings screen, a mapping write, a replay), the migration fails at once
with *could not obtain lock on relation* (SQLSTATE `55P03`). In both
cases:

1. **Nothing is applied**: the migration is one transaction, v65 is not recorded in `schema_migrations`, and the
   previous instance keeps serving.
2. Run the preflight's block 8 again; when it is clean, repeat the deploy at once.
3. Do not retry in a loop and do not change the migration file: its sha256 is the one the owner ordered.

## After the deploy

- The post-check's six blocks: v65 recorded once with its checksum as the last migration; the four bodies are v65's;
  the tables, the fifteen functions, the column, the constraints and the index exist; all 19 triggers are enabled;
  nothing is written; nothing is left locked.
- **Backups.** From 18-3 on, the values of a confirmation live in T9i for 90 days. A backup keeps them for its own
  retention; before a restored copy is used, `select training_load.remove_expired_confirmation_values(200)` is run
  until it returns an empty list (the v32 rule for GPEXE names).

## Rollback

`docs/runbooks/source-metric-confirmations-v65-rollback.sql`. Never automatic; only on the owner's order for that
database, after a restore-verified backup, and only once the deployed commit no longer contains the migration file.

- It refuses, changing nothing: when the migrator is running; when v65 is not recorded or a later migration is (M-B is
  rolled back first); once a confirmation or a T8 row of a confirmation exists; when a v65 object is missing, a trigger
  is disabled, or a body in force is not v65's.
- Otherwise, in one transaction, it restores v34's action CHECK and T8 comment and the four bodies byte for byte,
  drops the column, the three tables and the fifteen functions, and removes the v65 record.
- Rehearsed on a disposable database by `backend/tests/source-metric-confirmations-v65.test.mjs`: apply → rollback →
  the identical catalog → apply again.

## What the executor did and did not do

Every statement here was run only on disposable `optimove_tests_*` databases of a local PostgreSQL. No persistent
database, Supabase connector, GPEXE request or credential was used.
