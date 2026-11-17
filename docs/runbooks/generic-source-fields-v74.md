# v74: generic source fields (G1)

Migration `migrations_v2/202611161200_training_load_v74_generic_source_fields.sql`. Contract:
`docs/ai/gpexe-field-inventory-plan.md` section 8 (accepted; the owner's decision (a) of 2026-11-16).

## What it does

- **T2a, a field created by a platform admin (route C).** A write with an acting user is held to route C's contract:
  - the acting user is an active platform admin, creating in their own name;
  - the key is a generic gpexe / rest_v1 one (`athlete_session.*` or `details.players.*`);
  - at COMMIT, the field has its `source_metric_create` audit row.

  A write without an acting user stays as it was before v74. This is a known limit of the same kind as C74.
- **T2b, the evidence status `source_stated`.** Its proof is a typed link, `unit_observation_id` and
  `meaning_observation_id`, to the field observation that proves it. `evidence_ref_ok` stays docs-only.
  - The CHECKs tie the status to that proof.
  - The actor guard admits the observed act: the unit and the meaning together, on an active, unproven revision without
    parameters.
  - The write-once guard and the audit link cover the new columns.
- **T9 and T9i: `field_observation` and `field_unit`** (one session, one compared row with the two athletes' raw values
  in GPEXE's unit, shown `as_sent`). They come with their guards and deferred checks.
- **T8:** the actions `source_metric_unit_observed` (keyed: the request record) and `source_metric_meaning_observed`,
  and the chain of `source_metric_create`.
- **The display rule `as_sent`** (section 8.7): any unit token.
- **The gates** of v52 (activation) and v65 (T9i) accept `source_stated` as well as `verified`.
- **GPEXE's unit words** (plan section 8.10): the seed-only table `training_load.source_unit_words`, nine rows. A word
  GPEXE sends is a quantity kind; its row gives the unit token, the board's display rule and the evidence. A
  `field_unit` row names its word in `source_unit_word`, and the database takes its unit, rule and screen unit from that
  row. A word without a row is never guessed: the act answers `409 unit_not_stated`. No `unit_conversions` row is
  seeded.
- **A tenth word is a migration.** The table takes rows only inside a migration's seed window and is append-only, so a
  new word GPEXE starts to send (or a corrected one) needs its own migration with its evidence anchor.

Twelve bodies are replaced. Each one is md5-gated, and every new line sits between the `G1 (v74)` marks. The revisions
already verified by documents are not changed.

## Order of the work

| Slice | Content |
|---|---|
| G1a (this) | v74, route C |
| G2 | the generic extractors and the pinned projection |
| G1b | route O and the board's tick |

Until G2, a created field cannot be mapped. Until G1b, no field can become `source_stated`.

## Before the merge (the owner's order names this file)

1. Run `docs/runbooks/generic-source-fields-v74-preflight.sql` read-only, block by block, and check every expected
   value.
   - Keep block 6's two values.
   - v73 (App health) may be recorded or not.
2. Check that it is a quiet moment: block 5 shows 0 and 0.

## After the deploy

Run `docs/runbooks/generic-source-fields-v74-postcheck.sql` read-only.
- Block 5 must equal the preflight's block 6.
- Block 6 is all zeros until someone creates a field.

## Rollback

`docs/runbooks/generic-source-fields-v74-rollback.sql`, one transaction. It refuses once any field was created or
observed: the evidence is append-only, so the way forward is a new migration. It also refuses once any
`field_unit` row names a GPEXE unit word, and when a later migration other than v76 is recorded. v76 (the undo by the
importer) reached production before v74 and shares no object with it, so the preflight expects it, the post-check and
the rollback do not count it, and the rollback leaves it in place. It drops `source_unit_words` with its
rows. It restores every body and CHECK exactly.

It is rehearsed in `backend/tests/source-field-create-g1.test.mjs` test 11:
- the preflight on v72;
- v74 applied, then the post-check with a verified revision's digest unchanged;
- the rollback, giving exactly v72's catalog;
- v74 applied again;
- a refusal while a row names a unit word, and after a created field, each with nothing changed.
