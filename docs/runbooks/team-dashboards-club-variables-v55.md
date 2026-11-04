# Runbook: migration v55, a team's dashboards may chart the variables of the team's own club (O7)

Migration: `migrations_v2/202611041300_training_load_v55_team_dashboards_club_variables.sql`.
Suite: `backend/tests/team-dashboards-club-variables-o7.test.mjs` (disposable databases only).
Files beside this one: `team-dashboards-club-variables-v55-preflight.sql`, `-postcheck.sql`, `-rollback.sql`.
Contract: J15 section 12 (O7) and the *Rukovodilac*'s plan GO of 2026-11-04 (conditions 1-4 below).

## What it does

One function body is replaced, `CREATE OR REPLACE`; no table, column, trigger, index or row:
`training_load.dashboard_widget_series_validate_metric_visibility()` (v16), the trigger function that decides which
metric definitions a dashboard series may name. It gains one branch: a **club** definition is visible to a dashboard whose
data workspace is a **team**, when that team is active, belongs to the definition's club, and the club is active. Every
other branch and the final exception (errcode and message) are byte for byte v16's.

The application follows the same rule:
- `isMetricVisibleToDashboard()` (`backend/src/trainingLoadDashboardAccess.js`): the same branch; anything else answers
  as before, so a foreign, archived or missing variable is the same 404 on the routes.
- `listDefinitions()` (`backend/src/trainingLoadMetricsCatalog.js`), the picker's list: in a **team** workspace it also
  returns the variables of the club the route resolved from the active team workspace (never from the caller's roles).
  The club admin, the platform admin and every other workspace see what they saw before.
- The move card (Variables, a copy): "Charts that use OptiMove's X stay on it and get no new points. Add <copy> to a
  chart to follow the new values." Nothing is written to a dashboard automatically: the coach adds the copy to a chart
  by hand in the picker (the *Rukovodilac*, decision (a)).

## Lock order (the *Rukovodilac*'s condition 1)

dashboard -> widget -> series (ADR-003, the sanctioned functions), then, inside the trigger: the **definition** `FOR SHARE`
(as in v16), then the **team** `FOR SHARE`, then its **club** `FOR SHARE`, each in a statement of its own, so the order is
fixed. The suite records it twice: the body's text (definition before team before club) and two real sessions (a peer
holding the club row makes the insert wait there; an exclusive lock on the definition and on the team must queue behind
the insert, proving both were taken before the club).

## Evidence (disposable databases)

- On v16's body: no team dashboard can use any club variable; after v55 the matrix of dashboard data workspace
  (club, team, private dashboard in a club) x definition owner (OptiMove, club A, club B) is cell for cell unchanged,
  except the two cells "team of club X x club X variable", which become allowed.
- Another club's variable, an archived team and an archived club are refused with the same exception (errcode `P0001`,
  the same message) as every other invisible definition.
- The md5 gate refuses a body that is not v16's. The rollback restores v16's body byte for byte (and the matrix is v16's
  again), refuses under a later migration, a body that is not v55's, a missing record, a running migrator, and while a
  team dashboard series already uses a club variable; v55 applies again.
- Mutations killed: the club comparison dropped; the team's activity dropped; the club's activity dropped; the team row
  or the club row not locked. One equivalent mutant survives on purpose (the branch without its "team data workspace"
  condition): with a club or private data workspace the team lookup finds nothing, so the outcome cannot differ.

## Deploy

0. Run the preflight and post-check as the role the migrator uses (the application's `DATABASE_URL` role), or a member of it.
1. Preflight (read-only): `team-dashboards-club-variables-v55-preflight.sql`, four blocks, every `ok` true: v54 is the
   last migration and v55 absent; the body in force is v16's (md5); a quiet moment; ownership of the function.
2. Deploy. `npm start` runs `node src/migrate.js` first; v55 touches one function row (no table lock).
3. Post-check (read-only): `team-dashboards-club-variables-v55-postcheck.sql`, four blocks, every `ok` true.

## Rollback

`team-dashboards-club-variables-v55-rollback.sql` (not a migration, never automatic). Only with a fresh restore-verified
backup, after the deployed commit no longer contains the v55 file, and with the owner's approval for that database. It
refuses once a team dashboard series uses a club variable: the way forward is then a new migration.

## Known limitations

- **No retroactive check** (the *Rukovodilac*, decision (c)). The rule is checked when a series is inserted or its
  metric or widget changes (the trigger's `BEFORE INSERT OR UPDATE OF metric_definition_id, widget_id`), as in v16. A
  series that already names a club variable keeps working after its team moves to another club or the variable is
  archived; an unrelated edit of the series is not refused. A team moved to another club keeps seeing charts built on
  its old club's variables.
- **Hiding is not an access boundary.** A club hides only OptiMove's variables (`hide_not_system`); the club archives its
  own. An archived club variable is not offered by the picker (the list returns active definitions) and cannot be newly
  bound (the active-state trigger), while a series already on it stays valid. A hidden OptiMove variable is still listed
  (flagged `hiddenInClub`, which the pickers drop) and a series on it stays valid, as before.
- **Template clones in a team workspace are unchanged.** A template's key hints resolve against OptiMove's variables
  there (`trainingLoadDashboardWidgets.js`): a club's copy usually shares its key, so resolving to the copy as well
  would make every such hint ambiguous. The coach adds the copy by hand.
- **Trigger message.** For a club variable that is not visible the trigger's message names the definition's owner fields,
  as v16's does for every invisible definition; it never reaches a client (the routes answer a fixed 404). A missing
  definition reaches the same final exception with empty owner fields: that difference in the database message is v16's
  and is unchanged.
- **Not in v55.** A club dashboard charting a team's events (J15 section 1.7, third point); the events stay team-owned.
