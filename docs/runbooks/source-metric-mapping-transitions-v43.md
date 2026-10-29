# Runbook: migration v43 and the mapping version transitions (phase 7b)

Contract: `docs/ai/phase7b-mapping-transitions-contract.md` (J8; accepted as C104; R1–R8 decided by the *Rukovodilac*).
As built: section J8 of `docs/ai/gpexe-metric-variable-mapping-discovery.md`.

- **v43** (`migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql`): two checks of a
  mapping version's audit rows (T8, the actions `mapping_status` and `mapping_version_replaced` only).
  - **G1** (deferred, at COMMIT, `source_metric_audit_v43_replacement_link`): a replacement's label is true. A
    `mapping_version_replaced` row needs, in its own operation, the `active → disabled` row of another version of the
    same mapping, by the same user, whose `disable_reason` is the replaced row's reason; a plain `needs_review → active`
    row needs an operation that disabled no active version of its mapping.
  - **G2** (before insert, `source_metric_audit_v43_transition_facts`): a transition row agrees with its own version: a
    `→ disabled` row carries the version's `disable_reason`, `performed_at` is `now()`, and the transition's own time
    lies within its transaction.
  - Functions and triggers only: no table, column, constraint, index or data; no existing function changes.
- **The code** (one release with v43, not dependent on it):
  - A1 `POST /api/training-load/sources/metrics/mappings/:mappingId/versions/:versionId/activate` and A2
    `…/disable` (`backend/src/sourceMetricMappingService.js`, `backend/src/routes/sourceMetrics.js`): an active
    platform admin, in the workspace of the mapping's owner;
  - the revision lifecycle's pinned step (L2, L4, L5) disables an `active` pinned version too
    (`backend/src/sourceRevisionLifecycleService.js`; J8 Q5 and Q7).

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server, so the new server never meets v42.

**A rollback of v43 needs no revert of the phase 7b code, and the reverse** (the *Nezavisni revizor*'s LOW-2). The code
writes rows that satisfy G1 and G2; without v43 its routes work unchanged, since G1 and G2 are backstops only. Without
the code, v43 checks only the rows the earlier code writes (a submission and the pinned step), which satisfy it.

Every step that touches the production database is the owner's. The executor prepares the scripts and never runs them
there.

## Before the merge

The same day as the merge and deploy:

1. Run `docs/runbooks/source-metric-mapping-transitions-v43-preflight.sql` one block at a time. Every value must be the
   expected one:
   - block 2 shows v42 as the last migration, with its checksum;
   - block 3 shows no v43 object and v35's `source_metric_actor_basis`;
   - **block 4 is a hard assertion: no active mapping version and no activation.** Anything else: stop, do not merge,
     report;
   - block 5 is information only: record its numbers; the post-check shows them again;
   - blocks 8 and 9 must show a quiet moment.
2. Stop and report on any other value.

The merge needs the owner's order naming the pull request, the exact file
`migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql` and its sha256 (given in the pull
request), with this preflight the same day.

## Deploy order

1. The owner's preflight the same day.
2. The owner's order naming the pull request, the v43 file and its sha256.
3. The merge from exactly the reviewed head.
4. The deploy, started by the owner by hand.
5. The *Rukovodilac*'s smoke (without a login, the two new routes answer `401`).
6. The owner's post-check.

While the old server still serves during the deploy, it has no A1 or A2 route (`404`), and its pinned step refuses an
active pinned version - which cannot exist, since nothing can activate one before the new server runs.

## After the deploy

1. `/api/health` serves the merge commit with `ok: true`.
2. Before any version is activated, run `docs/runbooks/source-metric-mapping-transitions-v43-postcheck.sql` one block
   at a time:
   - block 1 compares the recorded checksum with the one in the file;
   - block 2 compares both function bodies and `source_metric_actor_basis` by md5;
   - block 3 shows both triggers, enabled, of the specified kind;
   - block 4 shows the numbers of preflight block 5 again, with no active version and no activation.

## If v43 refuses at deploy

**Lock timeout.** Creating the two triggers takes `SHARE ROW EXCLUSIVE` on the audit table. A long write on it makes
v43 fail on the runner's lock timeout. Nothing of v43 is written (one transaction), the new server does not start, and
the old server keeps serving.
1. Check that no session holds a lock on T3, T4 or T8 (block 8 of the preflight).
2. Run the deploy again in a quiet moment.
3. If it fails the same way again, report to the owner. No manual change in the database.

v43 has no fail-closed data check: it adds checks of rows written after it, and changes no row.

## When a block of the post-check differs

- **Block 1 or 2:** the recorded file or a function is not the repository's. Stop and report; change nothing.
- **Block 3:** a trigger is missing, disabled or of another kind. Stop and report; change nothing. Do not enable or
  create a trigger by hand.
- **Block 4:** a number differs from the preflight. Stop and report which; v43 writes no row, so a difference means a
  write happened between the two checks.

## Rollback

On the owner's approval only, for the database the owner names (`.claude/rules/database-safety.md`):
- after a fresh restore-verified backup;
- with the deployed commit no longer carrying the v43 file (otherwise the migrator applies it again at the next start).
  The phase 7b code may stay deployed.

Run `docs/runbooks/source-metric-mapping-transitions-v43-rollback.sql` in a quiet moment as one transaction that stops
at the first error (`psql -v ON_ERROR_STOP=1 -f`; the script carries its own `BEGIN` and `COMMIT`). It refuses,
changing nothing:
- while the migrator is running: it takes the migrator's advisory lock for its own transaction, without waiting;
- without v43, or under a later migration;
- while a v43 function or trigger is missing, or a v43 trigger is disabled.

It takes the audit table's lock before its checks, drops the two triggers and the two functions and removes the v43
record. It changes no row: every audit row written while v43 was applied stays. After it, v42's catalog comes back
exactly, and v43 can be applied again.

## Using the routes

- **Activate (A1):** `{ requestKey, expectedActiveVersionId }`. With `expectedActiveVersionId: null` the mapping must
  have no active version; naming its active version (and giving a `reason`) replaces it in the same transaction.
- **Disable (A2):** `{ requestKey, expectedStatus, reason }`, `expectedStatus` the status the caller saw (`draft`,
  `needs_review` or `active`).
- A lost answer is repeated with the same `requestKey`: the same request replays the current state and never writes
  twice. A key used with another body is `409 request_key_reused`.
- The disable reason is stored on the version and in its audit row, and never returned (C63).
- An open activation (T5) refuses both until phase 7d. Nothing reads an active version before 7d and M4, so an
  activation changes no imported value.
