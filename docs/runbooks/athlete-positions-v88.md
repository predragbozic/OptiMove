# v88: athlete positions and the Position average estimate

Migration `migrations_v2/202611221000_athletes_v88_positions.sql` (the prefix and number are provisional until the
*Rukovodilac* confirms them). The plan is `docs/ai/athlete-positions-plan.md`. The files beside this one are:
- `athlete-positions-v88-preflight.sql`;
- `athlete-positions-v88-postcheck.sql`;
- `athlete-positions-v88-rollback.sql`.

The rehearsal tool is `backend/scripts/athlete-positions-v88-rehearsal.mjs`, with bash (`.sh`) and PowerShell (`.ps1`)
wrappers.

## What it does

- **The registry.** `public.sport_positions` (Tests v42, empty on production) stays the one registry of positions. It
  gains the owner (`system`, or `club` with its club), the creator, the archive (who and when), a sort order and
  `updated_at`. v42's `unique (sport_id, name)` is replaced by one live name per owner (case-insensitive; an archived
  position frees its name). Clubs carry no sport, so v88 adds the sport `Football` and its six system positions:
  Goalkeeper, Centre back, Full back, Midfielder, Winger, Forward.
- **The log.** `public.sport_position_changes` is append-only and is the request record of the list's routes.
- **An athlete's position.** `public.athlete_positions` is the append-only history of an athlete's position in a club;
  the row with the highest `seq` is in force (`public.athlete_position_in_force(athlete, club)`; a row with no position
  is a clear). One position per athlete and club. The row is the request record of the route.
- **The guards** (the acting user `optimove.position_actor`, rights locked users first):
  - the list: a platform admin writes a system position, the club's admin a club position; every change needs its log
    row by COMMIT; no delete; id, sport, owner and creator are write-once;
  - an athlete's position: a platform admin, the club's admin, or the coach of an active team of the club in which the
    athlete holds an active membership; the position must be a system one or the club's own, and active; the athlete row
    is locked, so two changes of one athlete are decided one after the other; the history is never updated or deleted.
- **The estimate.** `metric_value_estimates.method` also takes `position_average`; `estimate_basis_ok` gains its branch
  (exactly `athletes` >= 3 and `positionId`, a uuid); `validate_metric_value_estimate` lets it estimate an `avg`
  variable, as `team_average`. Every other branch is verbatim, so every existing row stays valid.
- **What it does not change.** No athlete, membership, estimate or activity row.

## Before the merge

1. **PostgreSQL 17 rehearsal** (production runs 17). A PostgreSQL 17 server on loopback, `node`, and
   `npm --prefix backend ci` run once.
   - Linux / macOS: `backend/scripts/athlete-positions-v88-rehearsal.sh --host 127.0.0.1 --port 5432 --user postgres --pg-bin /usr/lib/postgresql/17/bin`
   - Windows: `powershell -ExecutionPolicy Bypass -File backend\scripts\athlete-positions-v88-rehearsal.ps1 -DbHost 127.0.0.1 -Port 5432 -User postgres -PgBin "C:\Program Files\PostgreSQL\17\bin"`

   It prints PASS or FAIL per step and `RESULT: PASS` at the end, and creates and drops only its own
   `optimove_tests_pos88rehearsal_*` databases. Step 8 compares the restored constraints with casts and parentheses
   removed: pg_restore prints a CHECK over a varchar column back in another form (v63's note check as well).
2. **Preflight**, read-only, each block as `begin transaction read only; <block>; rollback;`. Every ok column must be
   true. Keep block 4 for post-check block 6.
3. **Block 6 of the preflight, in git:** the 12-digit prefix is unique on the merge tree.

## After the deploy

- **Post-check**, read-only. Every ok column must be true. Block 6, the estimates per method, must equal preflight
  block 4: v88 writes no estimate.
- The routes answer 401 without a login: `GET /api/positions`, `GET /api/positions/athletes`,
  `PUT /api/positions/athletes/<zero uuid>` with `{}`.

## Rollback

`athlete-positions-v88-rollback.sql`, one transaction, at a quiet moment, and only on its own approval.
- **Before running it:** the deployed commit no longer contains the v88 file, otherwise the next start applies v88
  again.
- **When it refuses**, changing nothing: a position was added, renamed, archived or restored in the app; a club position
  exists; an athlete's position was ever set; a `position_average` estimate exists. From then on v88 is forward-only.
- **What it restores:** v69's method CHECK and `estimate_basis_ok`, v64's `validate_metric_value_estimate` (verbatim,
  md5 as before), v42's shape and unique of `public.sport_positions`, and no sport `Football`. The rehearsal's step 6 and
  `backend/tests/athlete-positions-v88-migration.test.mjs` test 2 check the catalog is identical.

## Known limits

- The guards prove that the row, the actor and the right agree. They do not stop whoever holds the database
  credentials (as v35 states it).
- The rights are the basic roles (`club_admin`, `team_coach`, `platform_admin`), as v85's. A custom role of v84 does
  not grant them.
- A club position may carry a system position's name (names are unique per owner).
- The estimate reads the positions in force at the moment of the proposal or the save (its basis keeps the position's
  id); a later change of a position does not change a saved estimate.
- An athlete in two clubs holds one position per club.
