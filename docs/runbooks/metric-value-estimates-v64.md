# Migration v64: the request key of an estimate save, and an estimate participant's time zone (phase 5b, 6b-B)

`migrations_v2/202611121200_training_load_v64_metric_estimate_requests.sql`. Contract: `docs/ai/phase5b-estimates-contract.md`
(section 7, 6b-B as built). The *Rukovodilac*'s GO of 2026-11-12: Q1 (a) and Q2 (a).

## What it does

- **The request key (Q1 (a)).** `training_load.metric_value_estimates` gets `request_key` (uuid) and `request_hash` (64 hex),
  both `NOT NULL`, and a plain index on `(estimated_by_user_id, request_key)`.
  - Every row of one save carries the same key and hash. The service answers a repeated key from these rows (the replay), so a
    lost answer can be retried with the same key and is never saved twice.
  - A key used with another hash is `409 request_key_reused`. The provenance guard (v63's `validate_metric_value_estimate`,
    replaced under an md5 gate) also refuses a second hash for an (author, key) in the database. It first takes a
    transaction-scoped advisory lock of that (author, key) (seed 64), and the save takes the same lock before its replay read,
    so two saves of one key on two teams' sessions at once are decided one after the other (the team lock does not serialise
    them): the second is `request_key_reused`.
  - The session undo deletes an estimate's provenance rows with the session, and with them its key: the same key can then save
    anew, the same way a refused save leaves its key free.
  - The table must be empty: 6b-B is its first writer, so the columns need no default.
- **The participant's time zone (Q2 (a)).** v12's `protect_participant_identity_once_measured`, replaced under an md5 gate:
  - an estimate save creates the athlete's event participant in the **event's zone** (`event_timezone_snapshot`, which is the
    v62 team zone for a session whose units report several zones);
  - when the athlete's real data arrives later, the import writer re-snapshots the participant to the athlete's own zone
    (`gpexeImportWriter.ensureParticipants`);
  - the database allows that change **only** when every occasion of the participant (effective or superseded) is an estimate
    with no source identity, only the zone changes, and the new zone is not null;
  - a participant with any real occasion (manual, api_import, csv_import) keeps v12's rule: its zone is frozen, and the import
    is blocked as before (`participant_timezone_changed`).

Nothing writes an estimate while `ESTIMATES_ENABLED` is off (the default). It is turned on only after 6b-D is merged and
deployed, by a separate owner order.

## Order

After v63: v64 refuses to run without v63's table, or while that table holds a row.

## Before the deploy (the Rukovodilac)

1. The owner's order naming this migration file.
2. `metric-value-estimates-v64-preflight.sql`, block by block in read-only transactions: every `ok` must be true.
   - v63 is the last migration and v64 is not recorded.
   - `metric_value_estimates` is empty and has no request column yet.
   - The two bodies in force are v12's (`8c56c995…`) and v63's (`fa6e027c…`).
   - It is a quiet moment, and the role may create in the schema.
3. Deploy; the migrator applies v64 at start-up.

## After the deploy

`metric-value-estimates-v64-postcheck.sql`, read-only, checks:
- v64 is recorded once and is the last migration;
- the two bodies are v64's (`2064f10c…` for the participant guard, `d4fdb1a8…` for the provenance guard);
- both request columns are `NOT NULL`, the hash CHECK and the index are there;
- the two triggers that run these bodies are enabled;
- no estimate exists, and there is no idle transaction.

## Rollback

`metric-value-estimates-v64-rollback.sql`, one transaction. It restores v12's and v63's bodies, drops the index and the two
columns, and removes the record. It refuses when:
- the migrator is running;
- v64 is not recorded, or a later migration is;
- any provenance row exists (its key would be lost);
- the two bodies are not v64's.

It ends by checking that v12's and v63's bodies are back by md5. Rehearsed on disposable databases
(`backend/tests/metric-estimates-6b-b.test.mjs`, test 12): apply, then rollback, then the v63 catalog exactly, then re-apply.
Run anywhere real only with the owner's approval for that database, after a fresh restore-verified backup, on a commit that no
longer contains the migration.
