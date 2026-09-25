# Migration v25 — session roster foundation (Phase 5a1)

`migrations_v2/202609251000_training_load_v25_activity_roster_foundation.sql`.
Contract: `docs/ai/phase5a-discovery-and-contract.md`.

## What it adds

- `public.athlete_membership_periods`: the history of every club and team
  membership. A trigger on `public.athlete_memberships` opens a period when a
  membership becomes active or paused and closes it when it is archived; the
  membership row itself and Settings behave exactly as before. A second trigger
  refuses a change of a membership's athlete, club, team or type.
- A backfill of one period per existing membership (`valid_from = starts_at`;
  archived rows end at `archived_at`, or at `updated_at` when that is empty).
- `training.activity_roster(activity)`: the team's roster on the session date.
- `training.participation_reasons` (six seeded reasons), and the tables the 5a2
  commands will write: `activity_roster_requests`, `activity_athlete_decisions`,
  `activity_completions`, `activity_completion_log`. Nothing writes them in 5a1.
- `training.activity_source_observations`, written by the GPEXE approval.
- `training.lock_activity_decider(user, team, basis)`.

Not in v25: the triggers that turn a complete session back into *needs review*
(owner decision 2026-09-25, they come with the complete/reopen commands in 5a2).
Until then no code can mark a session complete.

## Applying it

Never automatically on a persistent database. The deploy runs every pending
migration at start (`npm start` → `node src/migrate.js`), so merging the PR
applies v25 to the deployed database on the next deploy; the local OPTIMOVE
database needs its own approval, a fresh restore-verified backup, and v22–v24
first (it is at v21).

Rehearsed on a disposable copy of the local OPTIMOVE database (2026-09-25; the
copy and its dump were removed afterwards):

| Step | Result |
|---|---|
| The copy brought to v24 with the runner | no v25 object |
| v25 with the runner | 7 tables, 7 functions, 2 membership triggers, 1 recorded migration; every membership got its period (8 of 8, all matching `starts_at` and status); 6 reasons; no trigger disabled |
| Rows of every table that existed before | unchanged |
| The rollback SQL below | schema identical to v24 (schema-only dump compared); data unchanged |
| v25 again after the rollback | applied |
| A v25 that fails at its last statement | nothing left behind; schema identical to v24; not recorded |

## Rolling it back

Prefer a roll-forward fix. The rollback removes the membership history
recorded since v25 and every observation (and, once 5a2 exists, coach
decisions). It is `docs/runbooks/activity-roster-v25-rollback.sql`, one
transaction, run only:

1. after the application is back on a commit without Phase 5a1 (the roster
   route and the GPEXE approval need these tables);
2. with a fresh, restore-verified backup of that database;
3. with the owner's approval for that database.

## Known limitation

A membership archived and restored **before** v25 was revived in place, so its
gap is lost: v25 backfills one open period from `starts_at`, and the athlete
appears on rosters inside that gap (over-inclusion, never omission; the coach
answers with *Did not participate* · Other). `valid_from` is the moment the
athlete was added in OptiMove, not a sporting join date: a session from before
that moment lists its measured athletes under *Recorded, but joined the team
after this date*.
