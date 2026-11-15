# Migration v70: the GPEXE field inventory (I1)

Migration: `migrations_v2/202611151200_training_load_v70_source_field_observations.sql`. Plan:
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
  - the unit word, only when the answer carried one in a `{unit, value}` object and it passes v34's unit-token rule;
  - how many answers carried the name (summed over succeeded checks);
  - the first and the last check that saw it.
- **Never stored:** a value, an athlete id, a session id, a date of a session or raw JSON. A name that is not an identifier
  (`^[A-Za-z_][A-Za-z0-9_]{0,63}$`) or that is a prototype key is never recorded.
- **Bounds:** at most 300 names per endpoint and 2,000 per check; the rest is counted in memory, never stored.
- **When it is written:** in the check's finalization, in the same COMMIT that marks it succeeded. A failed, busy or unknown
  check records nothing.
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

A database without v70 records nothing: the finalization checks once per process whether the table exists, so a test
database built from a subset of the migrations is unaffected.

**Privacy.** These are names of metrics, not of people. GPEXE lets a team name its own parameters, so the name guard stays,
and who may read the rows is I2's (a platform admin all of them; a club admin read-only, only those seen through their own
club's connection; a coach nothing).

## Before the merge (the Rukovodilac)

1. Run `docs/runbooks/source-field-observations-v70-preflight.sql`, each block read-only. Every boolean must be true.
   Block 3 also wants no running check: a finalization running across the deploy would meet the new table midway.
2. The owner's order naming the migration file.

## After the deploy

Run `docs/runbooks/source-field-observations-v70-postcheck.sql`, each block read-only. Every boolean must be true. The
first rows appear with the first succeeded check after the deploy.

## Rollback

`docs/runbooks/source-field-observations-v70-rollback.sql`. It refuses once a row exists or a later migration is
recorded, and it was rehearsed on disposable databases (`backend/tests/source-field-observations-v70.test.mjs`). Code that
still writes the inventory records nothing without the table.

## Tests

- `backend/tests/gpexe-in-app-import.test.mjs`, the "I1:" tests, with a real check against the fake source:
  - **what is recorded:** the names, the kind and the answer's unit word; a field the importer does not read is recorded
    too;
  - **what never is:** no value, session or athlete id, and no malformed name;
  - **the snapshot is untouched:** still projected to the consumed fields;
  - **a second check:** the counts grow and the first sighting stays;
  - **the writer rules:** with a running check's marker, only that check's own rows of its connection, first seen by it;
    identity final, counts only grow; no raw write, delete or truncate.
- `backend/tests/source-field-observations-v70.test.mjs`: the preflight, the refusal over an existing table, the
  post-check, the rollback to the exact catalog, its refusal with a row, and the re-apply.
