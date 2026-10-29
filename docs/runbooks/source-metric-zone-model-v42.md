# Runbook: migration v42 (the zone model, option A; phase 5b)

Contract: `docs/ai/phase5-zone-model-contract.md` (C102, C103; P1–P6 decided by the *Rukovodilac*). As built: section J7
of `docs/ai/gpexe-metric-variable-mapping-discovery.md`.

- **v42** (`migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql`):
  - a zone's meaning act confirms the operator of its shape: `between` for the closed zones, `>=` for the open top
    zone. `source_metric_revisions_actor_guard()` is v39's body with that one branch changed;
  - the seed of one source field, `more.complementary_data.power.distance.open_top` ("Power zone distance (open top
    zone)"), with its revision 1: observed, active, no proof, as v34 seeded its parent;
  - `source_metric_require_seed_window()` accepts v42's marker only inside v42's own transaction, and every marker once
    v42 is recorded.
  - No table, column, constraint, index or trigger is added or dropped.
- **F3** (`backend/src/sourceFieldVerificationService.js`): a zone's meaning act needs `boundOperator` `between` or `>=`.
  `verification_model_unresolved` is no longer answered.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server, so the new server never meets v41.

Every step that touches the production database is the owner's. The executor prepares the scripts and never runs them
there.

## Before the merge

The same day as the merge and deploy:

1. Run `docs/runbooks/source-metric-zone-model-v42-preflight.sql` one block at a time. Every value must be the expected
   one:
   - block 3 proves the two functions are exactly v34's and v39's;
   - block 5 must show no zone revision with a meaning proof or an operator;
   - block 7 is information only: record its numbers;
   - block 9 must show a quiet moment.
2. Stop and report on any other value.

The merge needs the owner's order naming the pull request and v42.

## Deploy order

1. The owner's preflight the same day.
2. The owner's order naming the pull request and v42.
3. The merge from exactly the reviewed head.
4. The deploy, started by the owner by hand.
5. The *Rukovodilac*'s smoke.
6. The owner's post-check.

While the old server still serves during the deploy, it refuses a zone's meaning act (`409`), and its database refuses
it too until v42 commits. No mixed state can save a zone operator outside the zone rule.

## After the deploy

1. `/api/health` serves the merge commit with `ok: true`.
2. Before any zone field is confirmed (blocks 4 and 6 expect no proof and no audit row on the new field), run
   `docs/runbooks/source-metric-zone-model-v42-postcheck.sql` one block at a time:
   - block 1 compares the recorded checksum with the one in the file;
   - block 4 shows ten fields, the new one exactly as seeded;
   - block 6 shows no audit row for the new field.

## If v42 refuses at deploy

**Fail-closed refusal (`23514`).** v42 refuses, writing nothing, when the field `.open_top` already exists or a zone
revision already carries a meaning proof or an operator. Neither is possible on a database the preflight passed.
- **What it looks like:** the deploy does not come up; the migrator's log shows
  `ABORT applying "migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql"` with SQLSTATE 23514 and
  one fixed message.
- **The state:** nothing of v42 is applied or recorded; the old server keeps serving.
- **Do not run v42's rollback script.** It is only for a recorded v42. Report to the owner.

**Lock timeout.** v42 takes `SHARE ROW EXCLUSIVE` on the source fields and their revisions. A long write on either
makes it fail on the runner's lock timeout. Nothing of v42 is written (one transaction), the new server does not start,
and the old server keeps serving.
1. Check that no session holds a lock on the two tables (block 9 of the preflight).
2. Run the deploy again in a quiet moment.
3. If it fails the same way again, report to the owner. No manual change in the database.

## Rollback

On the owner's approval only, for the database the owner names (`.claude/rules/database-safety.md`):
- after a fresh restore-verified backup;
- with the deployed commit no longer carrying the v42 file or the F3 change.

Run `docs/runbooks/source-metric-zone-model-v42-rollback.sql` in a quiet moment as one transaction that stops at the
first error (`psql -v ON_ERROR_STOP=1 --single-transaction -f`). It refuses, changing nothing:
- without v42, or under a later migration;
- once any zone revision carries a meaning proof or an operator - the normal path after the first real confirmation
  of a zone. v42 is forward-only from then on, and a correction is a later migration;
- while the field `.open_top` is not exactly its seed: another revision, a proof, a retirement, an actor, a changed
  label, or any mapping, mapping version, activation, value provenance or audit row naming it;
- while any trigger of the two tables is disabled when it starts;
- while the migrator is running: it takes the migrator's advisory lock for its own transaction, without waiting.

Run it from a checkout with LF line endings (`.gitattributes` pins the v42 runbook SQL to LF): the restored bodies must
be byte for byte v39's and v34's, which preflight block 3 checks by their md5.

It disables exactly the two v34 guards that refuse a DELETE, for its own transaction, deletes the seed, enables them
again and checks every trigger of the two tables before the COMMIT. It restores v39's actor guard and v34's seed window
verbatim, clears their comments (v41 has none) and removes the v42 record. After it, v41's catalog and data come back
exactly, and v42 can be applied again.

## Confirming a zone field

The first real confirmation of a zone field is a separate order, with the evidence of Z4 / C97 (section J4 of the
discovery document). The unit act is as before. The meaning act of a zone takes the operator of its shape:
- the power field (`more.complementary_data.power.distance`): its closed zones, `between`;
- the open top zone (`.open_top`) and the speed field (`more.complementary_data.speed.distance`, one open zone): `>=`.

The operator is saved for good, and the correction is a new revision. The database accepts either operator on any zone
field: it does not tie a field to its shape (P4). The mapping version's operator equality (v34) catches a pairing of a
closed zone with `>=` or of the open top zone with `between`. It does not catch a `>=` wrongly confirmed on the power
field and then mapped to a variable of the open shape (J7 section 2); the field-to-shape rule is the extractor
registry's (7f).
