# Runbook: migration v47 and the unit-conversion writes (phase 7c)

Contract: `docs/ai/phase7c-unit-conversions-contract.md` (J9; accepted on 2026-10-30 by the *Rukovodilac*'s and the
*Nezavisni revizor*'s GO; Q1–Q3 and R1–R7 decided by the *Rukovodilac*).

- **v47** (`migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql`): the database actor guard of the
  two writes of `training_load.unit_conversions` (C76).
  - **`unit_conversions_v47_actor_guard`** (BEFORE INSERT OR UPDATE): a conversion created with a creator names the
    acting user of the transaction (the v35 setting `optimove.source_metric_actor`), an active platform admin; a
    retirement names the acting user, an active platform admin, at the time of its own transaction
    (`retired_at = now()`). A seed row (no creator) is left to v34's seed window.
  - **The audit guard** (`source_metric_audit_revision_guard()`, v39's body with one new branch): a
    `unit_conversion_create` or `unit_conversion_retire` audit row follows its own write in the same transaction, once,
    with the conversion's evidence (create) or retirement reason (retire). A unique index makes "once" physical.
  - **At COMMIT** (two deferred constraint triggers): every created conversion and every retirement has its audit row.
  - **Two CHECKs on the row:** both units are unit tokens, and the factor pair is in D5's full normal form
    (`source_metric_factor_pair_normal`). v47 refuses, changing nothing, while an existing row fails either.
  - No table, column or data change.
- **The code** (one release with v47): `backend/src/unitConversionService.js` and `backend/src/routes/sourceMetrics.js`.
  - `POST /api/training-load/sources/metrics/conversions` creates an active conversion (201);
  - `POST …/conversions/:conversionId/retire` retires one (200);
  - both only for an active platform admin in the platform workspace; everyone else gets the identical 404;
  - `GET …/conversions` now answers in pages of 100, `{ conversions, nextCursor }`, with `seeded` on each row.

The runner applies the migration in its own transaction and stops at the first failure (`backend/src/migrate.js`).
`npm start` runs the migrations before the server, so the new server never meets v46.

**The code needs v47; v47 does not need the code.** The new routes write the audit rows v47 checks, and v39 refuses
every conversion audit row, so the routes fail (`500`) on a database without v47 - which the deploy order rules out.
Without the new code, v47 changes nothing a writer does: no code wrote a conversion before phase 7c.

Every step that touches the production database is the owner's. The executor prepares the scripts and never runs them
there.

## Before the merge

The same day as the merge and deploy:

1. Run `docs/runbooks/unit-conversion-guards-v47-preflight.sql` one block at a time. Every value must be the expected
   one:
   - block 1 shows PostgreSQL 15 or later;
   - block 2 shows v46 as the last migration and v39 recorded, each with its checksum;
   - block 3 shows v39's body of the audit guard in force and no v47 object;
   - **block 4 is a hard assertion: `safe_to_merge = true` (every existing conversion passes both new rules).**
     Anything else: stop, do not merge, report. Record its counts; the post-check shows them again;
   - block 5 shows no conversion audit row;
   - block 6 shows the migrator's role may create the objects and owns both tables, and every trigger of both tables
     enabled;
   - block 7 shows no actor default;
   - block 8 must show a quiet moment on both tables.
2. Stop and report on any other value.

The merge needs the owner's order naming the pull request, the exact file
`migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql` and its sha256 (given in the pull request),
with this preflight the same day.

## Deploy order

1. The owner's preflight the same day.
2. The owner's order naming the pull request, the v47 file and its sha256.
3. The merge from exactly the reviewed head.
4. The deploy, started by the owner.
5. The *Rukovodilac*'s smoke (without a login, the two new routes and `GET /conversions` answer `401`).
6. The owner's post-check.

While v47 runs, every read of `unit_conversions` (`GET /conversions`, a mapping version's draft, an activation) waits
for its short run. While the old server still serves during the deploy, it has no conversion write route (`404`), and
its `GET /conversions` answers the old unpaged shape.

## After the deploy

1. `/api/health` serves the merge commit with `ok: true`.
2. Before any conversion is created or retired, run `docs/runbooks/unit-conversion-guards-v47-postcheck.sql` one block
   at a time:
   - block 1 compares the recorded checksum with the one in the file;
   - block 2 compares the five function bodies by md5;
   - block 3 shows the three triggers, enabled, of the specified kind, each calling its v47 function;
   - block 4 shows the index valid and both CHECKs validated;
   - block 5 shows the rows of preflight block 4 again and no conversion audit row.

## A rollback

`docs/runbooks/unit-conversion-guards-v47-rollback.sql` (rehearsed on disposable databases by
`backend/tests/unit-conversions-7c.test.mjs`). It refuses, changing nothing, once a conversion was created through the
API or retired, or once a conversion audit row exists: from then on the way forward is a new migration. Before it is run
anywhere real: a fresh restore-verified backup; the deployed commit no longer carries v47 or the phase 7c routes; the
owner's approval for that database.

## Retiring a conversion: what happens

- An **active mapping version keeps its own factors**: nothing that was activated changes, and no stored value changes.
- A **new draft** of that unit pair answers `409 conversion_unavailable` until an active conversion of the pair exists
  again.
- A **draft or submitted version** made with the retired factors can be activated again only if an active conversion
  with exactly the same factors exists. After a correction with other factors, disable that version and make a new
  one.
- The **reverse pair** is a row of its own and is not touched: retiring `m/s → km/h` leaves `km/h → m/s` active.
- A correction is not atomic: between the retirement and the new conversion, a draft or an activation of the pair
  answers `409 conversion_unavailable` (the safe direction).
