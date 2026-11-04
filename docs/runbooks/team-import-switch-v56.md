# The import switch per team (U2, migration v56)

Part of J19 (`docs/ai/gps-import-flow-contract.md`, U2); plan: `docs/ai/u2-per-team-import-switch-plan.md`. Migration:
`migrations_v2/202611041400_training_load_v56_team_import_switch.sql`. Rollback / preflight / post-check beside this file
(`team-import-switch-v56-*.sql`).

## What it is

An import is approved only when **both** switches are on:

1. the environment's master switch `GPEXE_IMPORT_APPLY_ENABLED` (a Render setting, unchanged: a kill switch for the whole
   server), and
2. the team's own switch (`training_load.gpexe_team_import_switch`, absent row = off).

A team is in one of two modes:

| Mode | Who approves an import |
|---|---|
| `pilot` (default) | an active platform admin, or a coach with an explicit approver grant (`team_grant`, unchanged) |
| `team` | additionally the **club admin** of the team's club (`club_admin`) and the team's **coaches** (`team_coach`) |

The explicit coach grants stay valid in both modes (decision R-U2-5).

## Who may do what

| Act | Platform admin | Club admin (club workspace) | Coach |
|---|---|---|---|
| Turn a team **off** | yes | yes | no |
| Turn a `pilot` team **on** | yes | no | no |
| Turn a `team`-mode team on | yes | yes | no |
| Move a team between `pilot` and `team` | yes | no | no |
| Record the backup / restore-probe dates and the two attestations | yes | no | no |
| Read the switch state and mode | yes | yes | yes (state and mode only) |

Everyone else, and a team that is archived or of another club, gets the same 404.

## The conditions (read inside the database when a team is turned on)

- a **backup** dated within the last **2 days**, and a **restore probe** dated within the last **35 days** (both modes);
- for `team` mode also the two recorded attestations **wrong-link procedure available** (U5) and **archived team stops a
  running search** (condition 5; proven by the real-flow test in `backend/tests/team-import-switch-u2.test.mjs`, test 10).

Turning **off** has no condition. The dates are global (the backup is the platform's), recorded by a platform admin on the
Imports screen (*Imports for this team → Record a date*) or `POST /api/training-load/gpexe/import-prerequisites`.

### How to record the Supabase backup date

OptiMove cannot read Supabase. In the Supabase dashboard open *Database → Backups*, note the date of the newest daily backup,
and record that date. The monthly restore probe (restore the backup into a scratch project and compare a few row counts) is
recorded with the day it was done. A date in the future, or older than 400 days, is refused.

## Switch off is effective at once

The approval transaction reads the team's switch row `FOR SHARE` (inside `lock_gpexe_import_approver`, after the role rows).
An off that has committed is seen by every approval that has not yet passed that point; an off that arrives while an approval
is past it waits for that approval's COMMIT. A batch stops at the candidate where the switch turned off
(`team_import_switch_off` is a batch stop code; the rest are `not_attempted`).

Lock order of the new writers: acting user row, then the role row, then the team and its club (`FOR SHARE`), then the switch
row (`FOR UPDATE`). `lock_gpexe_import_approver` takes no team or club row lock (a team move holds the team import lock and
then the team row).

## Known limits

- The write guards prove that a row comes from the sanctioned function in the same transaction; they are not a defence against
  whoever holds the database credentials (the v35 limit).
- The dated conditions are checked when a team is turned **on**, not on every approval: a backup that ages out while a team is
  on does not stop imports by itself. The platform admin turns teams off.
- A mode `team` club admin / coach basis is derived at approval time from the live role rows; an ended role is a 403.

## Rollback

`team-import-switch-v56-rollback.sql` refuses once any switch row, history row, prerequisite record or `club_admin` /
`team_coach` approval exists (forward-only after that), under a later migration, or if the approver function is not v56's.
It restores v54's body byte for byte and the original CHECK. Rehearsed in test 12 of the suite.
