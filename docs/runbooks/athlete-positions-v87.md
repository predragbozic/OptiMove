# v87: athlete positions and the Position average estimate

Migration `migrations_v2/202611221200_athletes_v87_positions.sql` (the prefix and number are provisional until the
*Rukovodilac* confirms them). The plan is `docs/ai/athlete-positions-plan.md`. The files beside this one are:
- `athlete-positions-v87-preflight.sql`;
- `athlete-positions-v87-postcheck.sql`;
- `athlete-positions-v87-rollback.sql`.

The rehearsal tool is `backend/scripts/athlete-positions-v87-rehearsal.mjs`, with bash (`.sh`) and PowerShell (`.ps1`)
wrappers.

## What it does

- **The registry.** `public.sport_positions` (Tests v42, empty on production) stays the one registry of positions. It
  gains the owner (`system`, or `club` with its club), the creator, the archive (who and when), a sort order and
  `updated_at`. v42's `unique (sport_id, name)` is replaced by one live name per owner (case-insensitive; an archived
  position frees its name). Clubs carry no sport, so v87 adds the sport `Football` and its six system positions:
  Goalkeeper, Centre back, Full back, Midfielder, Winger, Forward.
- **A club's own view of the defaults.** `public.club_position_overrides` (one row per club and system position): the
  club's own name for a default (null: the default name) and whether the club hides it. It never changes the system list
  or another club; a platform admin's later rename of a default reaches only the clubs without a name of their own. A
  hidden default is not offered for a new choice; an athlete who holds it keeps it, and it still counts in the position
  average. Never deleted (show it again, or rename it back to the default name).
- **The log.** `public.sport_position_changes` is append-only and is the request record of the list's routes; a club's
  rename, hide and show of a default are logged as `club_rename`, `club_hide`, `club_show` with the club.
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
- **The Tests module.** v87 changes none of its foreign keys into `public.sports` / `public.sport_positions`, nor the
  `unique (id, sport_id)` they rest on (`athlete-positions-v87-migration.test.mjs` test 2: before, after, and after the
  rollback). The rollback refuses (fixed message) while a Tests row names the sport Football.

## Locks while it runs

v87 takes every lock up front with `lock_timeout` 5 s: `public.sport_positions` and
`training_load.metric_value_estimates` ACCESS EXCLUSIVE (constraints and columns change), `public.sports` SHARE ROW
EXCLUSIVE. Behind a long transaction the deploy stops after 5 s with nothing changed, instead of waiting and holding up
the readers of estimates; run it at a quiet moment (preflight block 5), as the rollback. **If the deploy stops on the lock
timeout** (`55P03`, "canceling statement due to lock timeout"): nothing of v87 was applied (one transaction) and the
server did not start the new code; wait for a quiet moment, run preflight block 5 again, and deploy again.

## Before the merge

1. **PostgreSQL 17 rehearsal** (production runs 17). A PostgreSQL 17 server on loopback, `node`, and
   `npm --prefix backend ci` run once.
   - Linux / macOS: `backend/scripts/athlete-positions-v87-rehearsal.sh --host 127.0.0.1 --port 5432 --user postgres --pg-bin /usr/lib/postgresql/17/bin`
   - Windows: `powershell -ExecutionPolicy Bypass -File backend\scripts\athlete-positions-v87-rehearsal.ps1 -DbHost 127.0.0.1 -Port 5432 -User postgres -PgBin "C:\Program Files\PostgreSQL\17\bin"`

   It prints PASS or FAIL per step and `RESULT: PASS` at the end, and creates and drops only its own
   `optimove_tests_pos87rehearsal_*` databases. Step 8 compares the restored constraints with casts and parentheses
   removed: pg_restore prints a CHECK over a varchar column back in another form (v63's note check as well).
2. **Preflight**, read-only, each block as `begin transaction read only; <block>; rollback;`. Every ok column must be
   true. Keep block 4 for post-check block 6.
3. **Block 6 of the preflight, in git:** the 12-digit prefix is unique on the merge tree.

## After the deploy

- **Post-check**, read-only. Every ok column must be true. Block 6, the estimates per method, must equal preflight
  block 4: v87 writes no estimate.
- The routes answer 401 without a login: `GET /api/positions`, `GET /api/positions/athletes`,
  `PUT /api/positions/athletes/<zero uuid>` with `{}`.

## Rollback

`athlete-positions-v87-rollback.sql`, one transaction, at a quiet moment, and only on its own approval.
- **Before running it:** the deployed commit no longer contains the v87 file, otherwise the next start applies v87
  again.
- **When it refuses**, changing nothing: a position was added, renamed, archived or restored in the app; a club position
  exists; an athlete's position was ever set; a `position_average` estimate exists. From then on v87 is forward-only.
- **What it restores:** v69's method CHECK and `estimate_basis_ok`, v64's `validate_metric_value_estimate` (verbatim,
  md5 as before), v42's shape and unique of `public.sport_positions`, and no sport `Football`. The rehearsal's step 6 and
  `backend/tests/athlete-positions-v87-migration.test.mjs` test 2 check the catalog is identical.

## Known limits

- The guards prove that the row, the actor and the right agree. They do not stop whoever holds the database
  credentials (as v35 states it).
- The rights are the basic roles (`club_admin`, `team_coach`, `platform_admin`), as v85's. A custom role of v84 does
  not grant them.
- The database keeps names unique per owner only. Within a club, the service refuses a name that a live position of the
  club already shows (its own, or a default it shows, under the club's name for it); every write to one club's list takes
  that club's advisory lock (after the rights rows), so two admins of one club are decided one after the other
  (`athlete-positions-v87.test.mjs` test 12).
- A platform admin's rename of a default is not checked against the clubs' names: a club with its own position of that
  name, and no own name for the default, then shows the name twice until it renames one (display only).
- The bounded COMMIT is tested for a COMMIT that never ran (test 11); "committed, answer lost" rests on the same replay
  by request key and is not exercised separately.
- The admin branch of `public.athlete_position_right` locks the club membership before the team memberships (ascending),
  the order of the club-membership archive and of the athlete edit (D45).
- The users lock carries `is_active = true` (the known L1 gap of v54, inherited).
- An athlete's position change locks the athlete row `FOR NO KEY UPDATE` (the guard and the service), so it does not
  wait on, or hold up, an insert that only references the athlete (an import, a membership).
- The service's own check that the athlete is one of the workspace's is defence in depth: in every reachable state it
  asks what the database asks (a team workspace exists only for its coach); the database's check is proven on its own
  (`athlete-positions-v87.test.mjs` test 13 (a)).
- The three new `public` tables have no row-level security, like the other tables of `public` before v58; this holds
  while the Supabase Data API is off.
- A club's new position takes the next sort order up to 10000 (then they share 10000; there is no cap on how many).
- The estimate reads the positions in force at the moment of the proposal or the save (its basis keeps the position's
  id); a later change of a position does not change a saved estimate.
- An athlete in two clubs holds one position per club.
