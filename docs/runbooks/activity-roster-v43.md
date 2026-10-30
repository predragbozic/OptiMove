# Migration v43 — a self-report activity has no roster

`migrations_v2/202610291300_training_load_v43_activity_roster_self_report.sql`.
Contract: `docs/ai/phase5a-discovery-and-contract.md` (section 12, "As built in v43").
Needs v25 and v26 (`docs/runbooks/activity-roster-v25.md`, `activity-roster-v26.md`).
Owner decision 2026-10-29 (option A).

## What it changes

Two functions, nothing else: no table, column, index, trigger or row.

- `training.activity_has_roster(activity)` — new. A team-owned activity has a
  roster unless it is a **self-report activity**: origin `planned_session` or
  `external_assignment`, at most one canonical participant across its alias
  set, AND no measured value (an effective `api_import` / `csv_import` metric
  value in `training.canonical_activity_results()`, the roster's one definition
  of measured). `NULL` for an id that does not exist. Where such activities
  come from: an athlete's RPE for a planned session makes one team-owned
  activity per athlete (`materializeNaturalKeyActivity`, origin
  `planned_session`); an athlete's RPE for an external schedule makes ONE
  activity per occurrence with a participant for every assignee
  (`materialize_activity_group_from_external_occurrence`, origin
  `external_assignment`) — a self-report activity only when the occurrence
  has one assignee.
- `training.activity_roster(activity)` — redefined: the v25 body with that one
  more condition, so it returns no rows for a self-report activity. Every
  consumer inherits the rule through it: the roster read and its commands
  (`backend/src/activityRoster.js`, which answers `409 roster_not_applicable`
  to a caller who may decide on the team's sessions and the identical 404 to
  everyone else), `activity_roster_needs_state()` (v26), the decision and
  source-observation insert rules (v25) and the completion rules (v26).

Why: under v25/v26 every RPE result on a team plan produced a team-owned
activity with one participant whose roster listed the whole team — the athlete
who gave the RPE included — as *Unknown / needs a state*, and the Roster tab
opened by itself on each of them. Reproduced through the real routes on a
disposable database (`backend/tests/activity-roster-self-report.test.mjs`).

What stays: measured imports (`api_import`, `source_import`) and coach-created
(`manual`) team activities keep their roster whatever their participant count;
a self-report participant merged into a measured one leaves its activity
superseded and addressed through the canonical activity; a measured participant
merged into a self-report participant gives that activity measured values, and
so a roster; a self-report activity that holds a second canonical participant
(a reparent) has a roster again, with its RPE athletes reading *Unknown* as
before; an external occurrence with two or more assignees is one activity for
the whole event and keeps its roster, its RPE athletes reading *Unknown* as
before — both the boundary left to the team-session model.

Rows from before v43: a coach may have recorded decisions on a self-report
activity while its roster was offered (the tab opened by itself). Such
decision, request, completion and log rows are kept untouched and simply have
no roster to show them on; a `complete` completion row of such an activity can
still be moved to `needs_review` by the v26 triggers (a membership change, a
merge), invisibly. The rollback shows them again. Read-only counts (on a
persistent database only with the owner's approval):

```sql
select count(*) from training.activity_athlete_decisions d
 where not coalesce(training.activity_has_roster(d.activity_id), false);
select count(*) from training.activity_completions c
 where not coalesce(training.activity_has_roster(c.activity_id), false);
```

Compatibility: v43 is backward compatible with the pre-v43 application. That
read never calls `activity_has_roster()`, and against a v43 database it reads
an empty roster for a self-report activity (harmless). Reverting the
application alone is therefore a safe first step; the database rollback is
optional, and needs the deployed commit to be without the v43 file as well
(the migrator re-applies any file it finds unrecorded).

## Applying it

Never automatically on a persistent database. Merging the PR applies v43 to
the deployed database on the next deploy (`npm start` runs
`node src/migrate.js` first). The local OPTIMOVE database needs its own
decision and a verified backup first, like every migration before it. The
migration writes no row and takes no table lock beyond the two function
definitions.

Post-check (read-only): `select to_regprocedure('training.activity_has_roster(uuid)')`
is not null; for one known RPE-only activity of a team plan,
`select count(*) from training.activity_roster(<id>)` is 0 and the Roster tab
is not offered on its Activities drawer.

## Rolling it back

`docs/runbooks/activity-roster-v43-rollback.sql`, one transaction: restores the
v25 definition of `activity_roster()` verbatim, drops `activity_has_roster()`,
removes the v43 row of `schema_migrations`. It refuses, changing nothing, when
the migrator is running (advisory lock 822026), when a later `migrations_v2`
migration is recorded, or when v43 is not recorded. Before running it anywhere
real the application must be back on a commit without the v43 read (it calls
the function) and without the v43 file (the migrator re-applies an unrecorded
file), a fresh restore-verified backup must exist and the owner must approve
that database. Rehearsed on a disposable database in test 12 of the suite
above (apply on v42, each refusal, roll back to the identical catalog, apply
again, a failed last statement leaves nothing).

## Known limitation

The rule hides the roster of a self-report activity; it does not change how
such activities come to exist. A team training with 20 RPE results is still 20
activities with one participant each, and a coach cannot record *Did not
participate* on any of them (there is nothing to record: each is one athlete's
own report). One activity per team planned session is a separate phase
(option C, with the central calendar's events).
