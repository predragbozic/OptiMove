# A column fills a variable with a condition when the team's GPEXE setting matches (migration v80)

Migration: `migrations_v2/202611201100_training_load_v80_condition_match.sql`. Files beside this runbook:
`condition-match-v80-preflight.sql`, `-postcheck.sql`, `-rollback.sql`. Plan: `docs/ai/v80-condition-match-plan.md` (step B;
its section 9 records what was built and where it departs from the plan). Tests:
`backend/tests/condition-match-v80.test.mjs` (the migration, its rollback on a migrated and on a legacy-snapshot database, the
three database guards), `backend/tests/condition-match-v80-unit.test.mjs` (the rules, the match arithmetic, the importer's
block) and tests V80-1 to V80-4 of `backend/tests/source-metric-board-save-18-3.test.mjs` (the board, the placement, the save,
S1, A1 and the owner's confirmation route).

## What it is

* A GPEXE details column without parameters (a numbered power or speed zone column, the acceleration or deceleration events
  count) has no range of its own: its range is the team's setting in GPEXE. Before v80 such a column never filled a variable
  with a condition (`condition_mismatch`). Since v80 it does, **for one team at a time, when that team's setting equals the
  variable's condition exactly** (the limits, the operator and, for events, the duration; units only through
  `unit_conversions`; no tolerance).
* What v80 adds (no body of an earlier migration is replaced, no existing row changes):
  * `source_metric_mapping_versions.condition_rule` (jsonb, written once): which setting gives the column its range,
    `{"family":"power"|"speed","kind":"zone","zone":N}` or `{"event":"acceleration"|"deceleration","kind":"event"}`. A version
    without parameters on a variable with a condition must carry a rule that fits the condition's shape; no other version
    may;
  * on `source_metric_mapping_activations` (written once): `matched_condition` (the variable's condition, exactly as
    stored), `matched_source_range` (the column's range in GPEXE's units at the match), `matched_threshold_set_id`,
    `matched_at`. An activation of a version with a rule records all four, any other none;
  * `source_metric_event_setting_confirmations`: the owner's confirmation of the team's event setting GPEXE shows for a
    details event column (append-only, by its acting platform administrator);
  * two shape functions and three guard triggers (and a TRUNCATE guard).
* The service (`sourceConditionRules.js`, `sourceConditionMatch.js`) reads the rule from the field's key, the range from the
  team threshold set of a stored session (`raw_bundle.teamThresholds`), and compares. The board offers a variable with a
  condition only where a column matches; the placement and the save refuse any other drop naming both settings; S1 and A1's
  listed starts match each team against its newest stored session and refuse the whole operation for a team that does not
  match (`team_setting_mismatch`, `team_setting_missing`, `event_setting_not_confirmed`, `conversion_unavailable`, with the
  binding named).
* **The importer** reads every session against the activation's `matched_source_range`: a session whose team setting is not
  the one the column was matched with blocks the whole candidate (`team_setting_changed`), so nothing of it is imported;
  earlier imported values stay as they are.
* **Deployed alone, v80 changes nothing anyone sees**: no version has a rule and no activation a match until an
  administrator places such a column (the board's drop arrives with step C).

## The owner's step for an events column (two numbers and Confirm)

A GPEXE details events count carries no threshold of its own. Before it can fill a variable with a condition, the owner
confirms, once per field, the setting GPEXE shows for the team:

1. Compare the column with GPEXE first (the Source fields' comparison, route O), on one session of the team.
2. In GPEXE's team settings, read the acceleration (or deceleration) events threshold and duration.
3. Enter the two numbers and press Confirm
   (`POST /api/training-load/sources/metrics/fields/:fieldId/revisions/:revisionId/event-setting-confirmation`,
   `{ requestKey, thresholdValue, durationSeconds }`, a platform administrator in the platform workspace; everyone else the
   identical 404).

OptiMove checks the two numbers against the compared session's team setting. A lost answer is never "not saved": the
route answers `200` with `verified_after_commit_error` when the COMMIT went through, `503 outcome_unknown` when it cannot
tell, and the same request key then replays or saves. If they differ it says what that session
holds ("GPEXE's setting for the session you compared is at or above 2.5 m/s² lasting 0.3 s. Check the team's settings in
GPEXE and enter what it shows."). The same key answers the saved confirmation again; another body under it is refused. The
screen for it is step C.

## Running it

* **Preflight** (read-only, each block in a read-only transaction): v79 recorded and v80 not; nothing of v80 exists; v80's
  own refusal counted (`kind_none_on_conditioned` 0: no version without parameters already targets a variable version with a
  condition - the service never wrote one); the v35 actor functions exist; a quiet moment; the role owns both tables.
* **Locks of the migration**: it first takes `ACCESS EXCLUSIVE` on `source_metric_mapping_versions`, then on
  `source_metric_mapping_activations` (one `LOCK TABLE`, under `lock_timeout` 5 s), so nothing is written between its own
  refusal check and the columns; `ADD COLUMN` (nullable, no default) is catalog only, no rewrite, no scan. An activation write
  takes the activations table and then the versions table through its foreign key, the reverse order: a writer at the same
  moment can make the migration stop at its 5 s bound (nothing applied) or end itself in `40P01` (nothing written). Run it at
  the preflight's quiet moment.
* **Post-check**: v80 recorded once (compare `checksum` with the file's sha256); the five columns, the table and its index;
  the four triggers enabled; no rule, match or confirmation yet; nothing waiting.
* **Locks at run time**: the guards read immutable rows only (the variable version, the mapping version) without a locking
  clause, and the actor functions keep v54's order (users before the role row). The services keep their existing lock
  orders (S1 and A1: LO-1; the board save: section 4.4 of its contract); the match reads the newest stored session of the
  team inside the transaction after the binding and its team are locked. The candidate is never locked: a stored bundle is
  immutable, and a session stored later with another setting is blocked by the importer.
* **Rollback** (`condition-match-v80-rollback.sql`; it locks the three tables `ACCESS EXCLUSIVE` before its row checks; rehearsed apply -> rollback -> the catalog before v80 exactly -> re-apply,
  on a migrated database and on one built from the legacy schema snapshot): refuses while the migrator runs, without v80, and
  once a version carries a rule, an activation records a match or a confirmation exists. It drops what v80 added and the v80
  record; it changes no row of another table. It does not refuse because a later migration is recorded (v81, the calendar's,
  touches none of v80's objects); a later migration that uses v80's columns must add that refusal to this file.
* **What the database does not bind** (the v35 limit: the guards keep accidents out, not code that sets the actor): that a
  rule belongs to the field's key (a zone rule on any column without parameters passes the shape and fit checks), and that a
  confirmation's `event_kind`, `observation_confirmation_id` and `threshold_set_id` belong to its revision. The service sets
  all of them (`conditionRuleFor`, the route's own reads).
* **Not run on PostgreSQL 17**: every test ran on the container's PostgreSQL 16. Production runs 17.6.
