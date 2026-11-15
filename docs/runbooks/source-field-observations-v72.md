# Migration v72: the GPEXE field inventory (I1)

Migration: `migrations_v2/202611151200_training_load_v72_source_field_observations.sql`. Plan:
`docs/ai/gpexe-field-inventory-plan.md` (sections 1, 5 and 6; the owner's D-INV-1 and his answers Q1 and Q5).

## What it does

A succeeded check now also records the **names** of the fields its GPEXE answers carried. It needs no extra request: the
names are read in memory from the answers the check already reads (`backend/src/sourceFieldInventory.js`, called by the
adapter right after it accepted an answer).

- **One row per name:** per source connection, per endpoint and per field name, in `training_load.source_field_observations`.
  The endpoints are `athlete_session`, `more.events`, `more.complementary_data`, `details.session`, `details.drill` and
  `team_thresholds`.
- **What a row holds:**
  - the value-shape kind;
  - the unit word, only when the answer carried one in a `{unit, value}` object and it passes v40's unit-token rule exactly
    (the collector uses `metricTextRules.unitTokenOk`, and the write passes it through
    `training_load.source_metric_unit_token_ok` once more). It is text the source chose, at most 30 characters with no
    blank: it is scoped like the names (I2);
  - how many answers carried the name (summed over succeeded checks). One answer is: an athlete row of a session's list
    (its own canary or fallback read adds none), one `/more/` answer, one whole-session details answer, one drill answer,
    one thresholds answer;
  - the first and the last check that saw it.
- **Never stored:** a value, an athlete id, a session id, a date of a session or raw JSON. A name that is not an identifier
  (`^[A-Za-z_][A-Za-z0-9_]{0,63}$`) or that is a prototype key is never recorded.
- **Bounds:** at most 300 names per endpoint, so at most 1,800 per check; the rest is counted in memory, never stored.
- **When it is written:** in the check's finalization, in the same COMMIT that marks it succeeded. A failed, busy or unknown
  check records nothing.
- **It never decides a check.** The write runs in a savepoint with its own `lock_timeout` of 300 ms. Any refusal rolls back to
  that savepoint, logs `[gpexe] check <id>: the field inventory was not recorded (<code>)` and lets the check publish. The
  refusals include a row held by another team's finalization of the same connection, a CHECK, or a missing table. That
  check's names are then simply not counted. Only a statement with no answer within its bound still ends the finalization,
  as for every other statement.
- **Two finalizations of one connection:** the last sighting is `greatest(stored, now())`, so a finalization whose
  transaction began before another one's write committed never moves it back.
- **What it does not change:** the stored snapshot, the preview, every read of the check, the mapper and the import.
- **`rest_v1` only:** the legacy path records nothing (Q5).

**The writer.** Only the finalization of a running check that reads through a source connection writes, for that same
connection.
- The finalization sets the transaction-local `optimove.field_inventory_check = '<check id>:<xact id>'` right before its
  one upsert.
- A raw write without it, for another check or for another connection, is refused (`42501`).
- The identity (connection, family, endpoint, name, first sighting) is final, and the counts and the last sighting only
  grow (`23514`).
- DELETE and TRUNCATE are refused.
- The same limit as v35: this keeps out a write that bypasses the finalization by accident. It is no defence against code
  that runs SQL through the application's own pool while a check of that connection runs, nor against whoever holds the
  database credentials.

A database without v72 records nothing: the finalization checks once per process whether the table exists, so a test
database built from a subset of the migrations is unaffected. If the table goes missing later (a rollback), the first
write's `42P01` is skipped like any other refusal and the probe runs again.

**Privacy.** These are names of metrics, not of people. GPEXE lets a team name its own parameters, so the name guard stays,
and who may read the rows is I2's (a platform admin all of them; a club admin read-only, only those seen through their own
club's connection; a coach nothing).

## Who reads the rows (I2)

`GET /api/training-load/sources/metrics/field-inventory` (`backend/src/sourceFieldInventoryRead.js`; plan section 7.2):
- **A platform admin in the platform workspace** reads every connection's names. A club scope (the club's admin, or a
  platform admin in that club's workspace) reads only the names seen through the club's own connections: club-owned,
  or team-owned by one of its own teams.
- **Everyone else** gets the identical 404 of the metrics routes.
- **One row per (endpoint, name):** kind, unit word, answers seen, last date, and whether a source field already covers it.
- **Never answered:** a connection id, a check id, a label, a club or a team.
- **A club sees a unit word** only when it is an active conversion's unit.
- **Team thresholds** reach the platform admin only, with `endpoint=team_thresholds`. `state` does not apply to them: they are never a field, so
  `covered` is null.
- **`covered`** counts an active source field only; a retired one no longer covers its name. Source field keys are lower
  case, so a name with a capital letter is never covered until G1 can add it.
- **Bounded** like every metrics read (C70): read-only, a statement bound, `409 try_again` past it.

## Order with D1's v71

D1 (another track, PR #524) holds v71: `202611151000_training_load_v71_dashboard_simple_atomic_save.sql`. Its prefix sorts before v72's. The preflight, the post-check
and the rollback accept it recorded once or not at all, in either order of deploy (the pattern of v66's files).

## Before the merge (the Rukovodilac)

1. Run `docs/runbooks/source-field-observations-v72-preflight.sql`, each block read-only. Every boolean must be true.
   Block 3 also wants no running check: a finalization running across the deploy would meet the new table midway.
2. The owner's order naming the migration file.

## After the deploy

Run `docs/runbooks/source-field-observations-v72-postcheck.sql`, each block read-only. Every boolean must be true. The
first rows appear with the first succeeded check after the deploy.

## Rollback

`docs/runbooks/source-field-observations-v72-rollback.sql`. It refuses once a row exists or a later migration is
recorded, and it was rehearsed on disposable databases (`backend/tests/source-field-observations-v72.test.mjs`). Code that
still writes the inventory records nothing without the table.

## Tests

- `backend/tests/gpexe-in-app-import.test.mjs`, the "I1:" tests, with a real check against the fake source:
  - **what is recorded:** the names, the kind and the answer's unit word; a field the importer does not read is recorded
    too;
  - **what never is:** no value, session or athlete id, no malformed name, and no unit word v40 refuses;
  - **the counts:** an athlete row once, every drill answer once, the whole details once;
  - **it never decides a check:** a row held by another transaction skips the inventory and the check publishes; a
    finalization that began before another write of the same row committed still records;
  - **nothing from a failed check or the legacy path;**
  - **the snapshot is untouched:** still projected to the consumed fields;
  - **a second check:** the counts grow and the first sighting stays;
  - **the writer rules:** with a running check's marker, only that check's own rows of its connection, first seen by it;
    identity final, counts only grow; no raw write, delete or truncate.
- `backend/tests/source-field-observations-v72.test.mjs`: the preflight, the refusal over an existing table, the
  post-check, the rollback to the exact catalog, its refusal with a row, and the re-apply.
