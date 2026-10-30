# Central calendar — K1a plan: the read-only read API and the club's view of team activities (D8)

Status: **plan accepted by the manager (GO of 2026-10-30, decisions in section 8); built in the K1a pull request.**
Read-only reading of the checked-out code at `96f829c` (merge of PR #276) and, after the GO, `835e462` (merge of
PR #275, migration v44); no persistent database was queried.

- Inputs: `docs/ai/central-calendar-k0-discovery.md` (D1–D14 in its section 0, the K1 proposal in its
  section 7), the owner's D15 of 2026-10-30 (an event declares what it expects; RPE is not attached to
  every activity) and the owner's **D16** of 2026-10-30: **grouping by Builder batch only** — the same Builder
  batch, day, slot and session name make one card; a plan without a batch is a group of one; trainings made
  separately for several athletes are **not** merged by name (the Builder already lets the coach select several
  athletes at once, so the batch is the intended way to make a team training).
- Scope of K1a: one source-neutral read endpoint, its service, the D8 access change in the Training Load
  Activities calendar and the activity detail, tests. **No UI** (K1b), no table, no migration, no write.

## 1. The endpoint

`GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD[&clubIds=&teamIds=&athleteIds=&kinds=&today=&include=athletes]`,
mounted in `backend/src/server.js` beside the other `requireAuth`-only readers (`:113`, `:123`), no
`requireCoach` (the athlete workspace reads its own rows, as `GET /api/training-load/calendar` does).

| Rule | Detail | Evidence / precedent |
|---|---|---|
| Range | `from` ≤ `to`, both valid Gregorian dates with a year in 2000–2100, at most **62 days** (a six-week month grid is 42); otherwise `400` | `CALENDAR_MAX_RANGE_DAYS`, `backend/src/routes/trainingLoad.js:1482`, `:1488-1500` |
| Filters | `clubIds` / `teamIds` / `athleteIds`: comma-separated UUIDs, `400` when malformed; they **narrow** the workspace scope and never widen it (a union across kinds, as Training Load) | `athleteExtraFilterSql`, `trainingLoad.js:1055-1070` |
| `kinds` | optional subset of `planned,activity,external,test`; default all | — |
| `today` | optional `YYYY-MM-DD`, the caller's local date; default the server's UTC date; refused (`400`) when more than 2 days away from the server's UTC date. Only the **status** derivation reads it (section 2.5) | Tests derive its buckets from `now()` (`tests.js:1093-1101`); a client date is deterministic and testable |
| `include=athletes` | adds the per-athlete rows of every item (section 2.6); default: ids and counts only | keeps a 62-day answer small |
| Workspace | `resolveActiveWorkspace()` **once** per request; the same object scopes every kind | `backend/src/workspace.js`; the one-read discipline of `trainingLoad.js:1006-1047` |
| **No write on read** (no domain write; the workspace fallback of `resolveActiveWorkspace()` may persist a preference, as on every route) | the service never calls `ensureCurrentExternalOccurrence*` (`backend/src/trainingLoadOccurrenceService.js:48, 117, 153`) nor `ensureCurrentOccurrence` (`backend/src/testsOccurrenceService.js:85`); schedule days without a generated occurrence are projected **in memory**, as Tests' week does | the TL calendar writes on read at `trainingLoad.js:1522, 1557`; Tests' pure projection `tests.js:1011-1024` |
| Errors | `400` with a stable code in `error` and the sentence in `message` — `invalid_range`, `range_too_long`, `invalid_today`, `invalid_kinds`, `invalid_include`, `invalid_ids`; `403` no coach workspace / athlete account without a profile (as TL); `503 database_busy` from the global handler | `trainingLoad.js:1510-1511`; the newer routes' stable codes |

Response:

```json
{
  "from": "2026-10-26", "to": "2026-11-01", "today": "2026-10-30",
  "workspace": { "type": "club", "scopeId": "<club id>" },
  "teams": [{ "teamId": "…", "name": "U19", "athleteCount": 21 }],
  "days": [{ "date": "2026-10-28", "items": [ /* section 2 */ ] }]
}
```

`teams` lists the teams the answer may name: the active club's active teams, the one team of a team
workspace, `[]` for a private coach, a platform admin and an athlete. Every `teamIds` value on an item is
one of them.

## 2. The item model — one card per thing that happened or is planned

### 2.1 Kinds and grouping

| `kind` | One item per | Source rows | Key |
|---|---|---|---|
| `planned` | **planned group**: the Builder batch siblings with the same day, slot and session name; a plan outside a batch is a group of one | `plans.plan_sessions` → `plan_days` → `plans` (published weekly plans only: `WEEKLY_PLAN_SESSION_FILTER_SQL`, `trainingLoad.js:49-54`); **every** session, tracked or not (K0 §7; Coach Home counts them all, `backend/src/routes/athletes.js:82-140`) | `planned:<builder_batch_id or plan id>:<date>:<am_pm>:<bta>:<session_order>:<sha1 of name>` |
| `activity` | a canonical activity (`lifecycle_state <> 'superseded'`) **not folded into a planned or external card** (section 2.2) — a GPEXE / imported session, a coach-made activity, a self-report activity whose session is outside the window or the scope | `training.activities` (`migrations_v2/202609071000_…v1_core_tables.sql:87-116`) | `activity:<activity id>` |
| `external` | an external schedule on one day | `training_load.external_schedules` / `_occurrences` / `_assignments` / `_targets` (`…v4_external_scheduling.sql:160`); days without an occurrence projected in memory | `external:<schedule id>:<date>` |
| `test` | a test schedule on one day | `tests.test_schedules` / `_targets` / `_occurrences` / `_assignments` (`…tests_v42_phase1…sql:24, 138, 168, 307`); the same in-memory projection as `tests.js:1011` | `test:<schedule id>:<date>` |

Grouping evidence: a multi-athlete weekly plan is one plan per athlete sharing `plans.plans.builder_batch_id`
(`backend/src/routes/builder.js:426-437`; the column `create_builder_schema.sql:127`); a sibling edited
apart gets another session name and so another group — accepted (K0 §6). **D16 (owner, 2026-10-30):** the
rule is the batch only — plans made one by one for several athletes are never merged by team, day, slot and
name. The rule lives in one named function of `calendarQuery.js` (`plannedGroupKey`), so a later change is
small. An athlete's RPE materializes one
**team-owned one-participant** activity per athlete and logical session
(`backend/src/trainingActivityMaterialize.js:837-880`, origin `planned_session`), linked by
`training.activity_participant_session_links` (`…v2_components_links.sql:213-237`).

### 2.2 Folding activities into cards

An activity whose canonical participant has a **confirmed** session link to a logical session of a planned
group **in the answer** belongs to that group's card (`links.activityIds`), never to its own card — so a
training of 20 athletes with 17 RPE results is **one** card with `rpe {asked: 20, submitted: 17}`. The same
for an activity linked to an external assignment of an external card. Everything else is its own
`activity` card. "In the answer" means: the group is visible to this caller in this window; the edge case
of an activity whose session lies outside the caller's scope stays a plain activity card (documented, not
hidden).

### 2.3 Fields of every item

| Field | Meaning | Source |
|---|---|---|
| `key`, `kind`, `date`, `title` | as above; `title` = session name / activity name / event name / test name | — |
| `slot` | `{ amPm: "AM"\|"PM"\|null, bta: "B"\|"T"\|"A"\|null, order: n }` for `planned`; `null` otherwise | `plan_sessions.am_pm`, `bta`, `session_order` |
| `startTime` | `HH:MM` local or `null`: a planned session's `session_time`; an activity's `started_at` in its `timezone_snapshot`; a schedule's `opens_time` | K0 §4; no end time and no duration in K1 (K0 MEDIUM-3) |
| `startsAt` | the instant, activities only | `activities.started_at` |
| `teamIds` | the team memberships of the item's athletes **on the item's day**, within the workspace (an athlete in two teams puts the card in two teams, K0 §4); an activity card: its owner team | `public.athlete_membership_periods` (v25) |
| `athleteIds`, `athleteCount` | planned, external and test cards: the athletes of the item **within the caller's scope** (section 3), so a private coach never sees teammates. An activity card: **every canonical participant of a readable activity** (the activity belongs to the team and keeps its history: athletes who left the team stay listed, as on the activity detail) — except in the **athlete workspace**, which gets its own participation only (no teammate id, name, RPE or roster), the rule of the detail's athlete-self branch | — |
| `expects` | section 2.4 | D15 |
| `status` | section 2.5 | D14, D15 |
| `rpe` | `{ asked, submitted }` or `null` | `training_load.session_feedback` by `logical_session_id` / `external_assignment_id` (ADR-004, `…v1_session_feedback.sql:63-96`), never the LATERAL metric joins of the TL calendar (K0 LOW-4) |
| `attendance` | `{ roster, present, needsState }` or `null` — only where a roster exists (section 2.7) | `training.activity_roster()` (v25 `:231`), `activity_roster_needs_state()` (v26 `:119`), `activity_athlete_decisions` (v25 `:410`) |
| `results` | `{ expected, completed }` or `null`, test cards with materialized assignments | `tests.test_assignments`, `test_assessments` as `tests.js:1093-1127` |
| `cancelled` | `true` for a cancelled schedule or occurrence | schedule / occurrence `status` |
| `links` | `{ activityIds, planIds, logicalSessionIds, externalScheduleId, externalOccurrenceId, testScheduleId, testOccurrenceId }` — the ids a drill-in needs: `openWeeklyPlanOnDate(athleteId, date)` (D5), the TL activity detail (D14), the roster | only activities the caller may **read** (section 3), so a click never ends in a 404 |
| `origin` | activity cards only: `planned_session` / `external_assignment` / `api_import` / `source_import` / `manual` | `…v1_core_tables.sql:102` |

### 2.4 `expects` (D15) — derived from stored facts, never invented

| Item | `expects` | Why |
|---|---|---|
| planned group with at least one session where `rpe_enabled = true` **and** the plan's workspace switch is effective for that day | `["rpe"]`; `rpe.asked` counts exactly those athletes | the submit path requires both (`trainingLoad.js:395-423`, `training_load.planned_rpe_effective_for_plan`, v9); `rpe_enabled` implies `training_load_enabled` by the v14 CHECK. The TL calendar reads `rpe_enabled` alone (`trainingLoad.js:1585`); the switch is added so a session nobody can answer is never "awaiting entry" (open point 2) |
| planned group without such a session | `[]` | nothing stored asks for anything |
| `external` card | `["rpe"]`; `asked` = assignments in scope that are not cancelled / excused | an external assignment is always an RPE request (the TL rule, `trainingLoad.js:1585`) |
| `test` card | `["test_result"]` | a test schedule exists to collect a result |
| `activity` card, origin `api_import` / `source_import` | `["device_data"]` — met by its own values; the roster says who still needs a state | the data really says so: the activity **is** the import (`…v4_canonical_functions.sql:671`) |
| `activity` card, origin `planned_session` / `external_assignment` (the edge of 2.2) | `["rpe"]` with `asked` / `submitted` from its own links | the TL rule above |
| `activity` card, origin `manual` | `[]` | a coach-made activity asks for nothing in K1 |

Nothing in K1 says that a **planned** session expects device data: no stored fact states it (a GPEXE
binding is a team fact, not a session fact), so it is not derived. K2's event types become the source of
`expects`; the field's shape is chosen so they can replace this derivation without a contract change.

### 2.5 `status` (D14) — one of `planned`, `done`, `awaiting_entry`, `missed`, `not_opened`, `cancelled`, `none`

- `cancelled`: a cancelled schedule or occurrence (external, test).
- `none`: `expects` is empty and the item has no roster with a measured source — a card without a status
  chip (a self-report activity that stands alone, a coach-made activity, a planned group that asks nothing).
- Otherwise, with `D` the item's date and `T` = `today`:
  - every expectation met (`rpe.submitted = asked`, `results.completed = expected`) → `done`, on any day;
  - `D >= T` and not met → `planned`;
  - `D < T` and not met → `awaiting_entry`.
- A roster card (section 2.7) with a **measured source** (origin `api_import` / `source_import`, or an
  effective measured value) and `attendance.needsState > 0` → `awaiting_entry` once the day has passed
  (`planned` on the day itself); `needsState = 0` → `done`.
- `missed`: the day has passed, the expectation is unmet, and **every** unanswered entry can no longer be
  made — its assignment is in the terminal status `missed` (external and test assignments, v4 / v42) — so
  the day never stays `awaiting_entry` forever; one entry still open keeps `awaiting_entry`. A planned
  session's RPE has no terminal state (the athlete may answer later), so a planned group is never `missed`.
  Per athlete the row reads `missed` too. K1b labels it.
- An external or test day whose occurrence was never generated and `D < T` → `not_opened` (nobody could
  enter anything; never `awaiting_entry`); `D >= T` → `planned`.
- **Never** `awaiting_entry` for a self-report activity (origin `planned_session` / `external_assignment`,
  one canonical participant): its one athlete's RPE is the activity, so there is nothing to wait for; its
  group card carries the wait. Standing alone it reads `done` (its one expectation met) or `none`.

### 2.6 `include=athletes`

Per item `athletes: [{ athleteId, name, teamIds, rpe: "submitted"|"missing"|"missed"|"not_asked"|null (planned,
external), result: "completed"|"missing"|"missed"|"not_asked"|null (test), planId, sessionId, logicalSessionId
(planned), assignmentId, assignmentStatus (external, test) }]`, the same scope filter as `athleteIds`. No
roster state per athlete in K1a (K1b may ask for it through the roster read). Names through the same `coalesce(display_name, full_name, …)` the TL calendar uses
(`trainingLoad.js:1632`). Off by default.

### 2.7 Attendance x/y — only where a roster exists

`attendance` is filled only when the activity has a roster: a **team-owned** activity that is not a
self-report activity. The database rule is `training.activity_has_roster()` of migration **v44** (PR #275, merged as
`835e462` on 2026-10-30); K1a calls that function and never copies its rule (decision 1). `roster` = rows of `training.activity_roster()`; `needsState` = rows of
`training.activity_roster_needs_state()`; `present` = roster athletes whose current decision is not
`did_not_participate` and who are not in `needsState`. A planned group carries no `attendance` in K1
(its x/y is `rpe`); K2's team-session model gives it one.

### 2.8 Order inside a day (D13 list mode)

By `slot.amPm` (AM, PM, none), then `slot.bta` (B, T, A, none), then `slot.order`, then `startTime`, then
`title` — the weekly plan's own order (`frontend/weekly-plan.js:12-20`). An item without a slot sorts among
the AM items when its start is before 12:00, among the PM items otherwise (at the Training rank), and last
without a start. The client may re-sort for the time grid.

## 3. Access per workspace (D6–D8) and the exact D8 change

One `resolveActiveWorkspace()`, then per kind:

| Workspace | Activities (own cards and `links.activityIds`) | Planned groups, external and test assignments (by athlete) | Projected schedule days (no occurrence yet) |
|---|---|---|---|
| platform | all (today's rule) | all | all |
| **club** C | **D8: owned by C, or by an active team of C** (new) | athletes with a club membership period in C **or** a team membership period in an active team of C **covering the item's day** (the TL calendar reads today's club membership only, `trainingLoad.js:1011`) | owned by C or a team of C, or targeting C, a team of C or one of those athletes (the athletes judged over the window) |
| team T (of club C) | owned by T (today's rule, D6) | athletes with a team membership period in T covering the item's day | owned by T, or targeting T, C or a member of T (over the window) |
| private coach | `owner_scope = 'user'`, own id (today's rule, D7) | `public.user_athletes` active (`trainingLoad.js:1023`; that relationship keeps no history, so it is today's) | owned by me, or targeting one of my athletes |
| athlete | own canonical participation only, and of a shared activity only the own participant (never a teammate); filters ignored (as `trainingLoad.js:1510-1522`) | own plans, own assignments | own targets: schedules targeting the athlete, or a team or club membership of theirs within the window (never by owner) |
| none / athlete account without profile | `403` | | |

Plans and assignments are read by **membership on the item's day** — the v25 periods
(`public.athlete_membership_periods`, the same periods `training.activity_roster()` reads), not by plan or
schedule ownership — K0's Q-D, decided by the manager as decision 4 (section 8) inside D1–D15. The one rule is
`membershipOnDaySql` (`calendarAccess.js`): a period **covers** a day when its start is on or before the day and
its end on or after it (an open period never ended) — compared at **date granularity in one stated zone, UTC**
(the boundary instant read as a UTC date, unlike `activity_roster()`, which compares instants in the activity's
own time zone); the **joining day and the leaving day both count**. One defined **fallback** (option b, below):
for a day **before the athlete's first membership period in that club** (their OptiMove history there has not
started: imported history, an athlete added late), the **current** membership decides, so a current member's
older plans stay visible, exactly as Coach Home shows them today. Consequences: an athlete who leaves a team is
on its cards through the leaving day and on none after (a former member gets no fallback); an athlete who moves
from team X to team Y inside the club is X's through the leaving day and Y's from the joining day, never Y's
before it (the club history already existed); a current member's plans from before `starts_at` are on the
team's past days (tests 23 and 25). The three options the manager weighed — (a) strict periods (the calendar's
past empties before every `starts_at`), **(b) periods with the fallback to the current membership before the
first club period (chosen)**, (c) today's membership only (Training Load and Coach Home today) — are the owner's
to change. **What this means for a dual member**, honestly, for the
owner's external review to confirm — the club admin and the team coach read, for an athlete who was theirs on
that day, the session names, times and RPE state of **every** published plan of that athlete on that day,
whoever made it: (1) a private coach's plan (test 20), (2) another team's plan for an athlete in two teams, (3)
another club's plan for an athlete in two clubs. Activities are not read that way (owner scope, D8); the plan's
own routes still answer such a reader by their ownership rule; `links.activityIds` of such a card carries only
the activities the reader may open. Switching to plan ownership later is one WHERE clause. The `clubIds` /
`teamIds` / `athleteIds` filters narrow inside the scope and follow the same day rule for club and team
(`calendarAthleteFilterSql`); a projected schedule day whose targets leave nobody in the filter is not shown.

**Exactly where D8 changes code** (reads only; every write path keeps `canManageActivityInScope`):

| Place | Today | Change |
|---|---|---|
| `backend/src/trainingActivityAccess.js:63-78` `activityScopeSqlForWorkspace` | club → `owner_scope = 'club'` only | **new** `activityReadScopeSqlForWorkspace(scope, alias, params)`: the same, plus for a club `or (alias.owner_scope = 'team' and alias.owner_team_id in (select id from public.teams where club_id = $n and coalesce(is_active, true)))`; **new** `canReadActivityInScope(scope, row)` for a row carrying `owner_team_club_id` / `owner_team_active`. `activityScopeSqlForWorkspace` and `canManageActivityInScope` (`:51`) stay as they are for writes |
| `backend/src/trainingActivityResults.js:34-46` the activity detail | `canManageOwnerRow` (`:16-22`) → `404` for a club admin on a team activity | the activity row is read with a `left join public.teams`; `canReadActivityInScope` decides; a missing row, another club's team, an archived team and every other caller keep the **identical** `404 "Activity not found."` (ADR-006) |
| `backend/src/trainingActivityResults.js:151` `listActivities` (`GET /api/training-activity`) | `activityScopeSqlForWorkspace` | `activityReadScopeSqlForWorkspace` |
| `backend/src/routes/trainingLoad.js:1484` `calendarActivityOwnerScopeSql` (Training Load → Activities, the calendar behind `frontend/training-load-calendar-view.js`) | `activityScopeSqlForWorkspace` | `activityReadScopeSqlForWorkspace`, so the club workspace lists its teams' activities and the click on one opens the detail (`frontend/training-load-calendar-data.js:302`) |
| `backend/src/activityRoster.js:65` the roster read | O2 already admits the club admin of the team's club | unchanged — this is the precedent D8 follows |
| the activity write routes (`POST /materialize`, `/materialize/external-occurrence/:id`, `/participants/:id/reparent`, `/participants/:id/merge`, the match-suggestion accept / dismiss, the metrics link) | unchanged | unchanged: a club admin reads a team activity but still cannot change it through these routes (`404` as today, the same answer as for a stranger) — a **deliberate asymmetry of the read-only phase** (manager decision 7), accepted by `security-reviewer` with 404 kept (a 403 would need a read check inside every write path and reveals nothing new); writes are decided with K2's events; K1b shows no write control to a reader. The **roster commands** are the one write the club admin already has, through O2 (`activityRoster.js`). Noted for the owner's external review: D8 gives the club admin the athlete-level facts of the activity detail (RPE values, metric values, names) |

Info-hiding (ADR-006): the body of every `404` on the detail stays the one string for every refusal; the
calendar read never answers `404` (a scope that sees nothing gets empty days); a team id of another club in
`teamIds` filters to nothing, never to an error that confirms the id exists.

## 4. Readers that could later share this source (K3; named, not changed)

- Coach Home's day calendar: `GET /api/athletes/today` and `/training-days` (`backend/src/routes/athletes.js:82-175`).
- Training Load → Activities: `GET /api/training-load/calendar` (`trainingLoad.js:1488`); Schedule / Today / Results: `GET /api/training-load/weekly` (`trainingLoad.js:1072`).
- Tests → Today / Schedule / Results: `GET /api/tests/weekly` (`tests.js:1026`).
- The athlete's Home week: `backend/src/routes/athleteHome.js:30-60`.

## 5. Modules (the Access / Query split of `backend/src/trainingLoad*`)

- `backend/src/routes/calendar.js` — validation, the one workspace read, the answer.
- `backend/src/calendarAccess.js` — the read scopes per workspace of section 3, built from
  `activityScopeForWorkspace`, the new `activityReadScopeSqlForWorkspace`, and its own day-aware athlete
  predicate and filter over the v25 periods (`periodCoversSql`; the club branch is wider than
  `coachWorkspaceScopeSqlForWorkspace`'s, decision 5). The one thing shared with `routes/trainingLoad.js`
  is `WEEKLY_PLAN_SESSION_FILTER_SQL`, moved into `backend/src/trainingLoadAccess.js` unchanged and imported
  by both; the Training Load picker's own `athleteExtraFilterSql` stays where it was (it reads today's
  membership, the calendar reads the day's).
- `backend/src/calendarQuery.js` — the reads: one statement per kind for the window (planned sessions,
  activities with their links, external assignments and targets, test assignments and targets), the
  roster counts for the roster activities of the window in one statement, then grouping, folding, `expects`
  and `status` in memory. The number of statements does not depend on the number of items.

## 6. Tests (disposable databases through the real routes; `node scripts/test-runner.mjs --project backend --kind disposable --file central-calendar-k1a.test.mjs`)

`backend/tests/central-calendar-k1a.test.mjs` on `createGpexeDisposableDb` with the Tests v42 files
(`202608220900…202608300900`, they sort before the training_load files) plus the GPEXE list (and v44, open
point 1); the suite adds `plans.plans.builder_batch_id` to its own database before the migrations.

1. Every workspace: club admin sees its teams' team-owned activities and nothing of another club; team coach
   the team's; private coach own athletes; athlete own rows with filters ignored; platform admin all;
   no workspace `403`.
2. Grouping: a 3-athlete batch with `rpe_enabled` and 2 RPE submits (real `POST …/sessions/:id/rpe`) → one
   card, `rpe {asked: 3, submitted: 2}`, `links.activityIds` the two activities, `awaiting_entry` with a
   past `today`, `planned` with `today` on the day; the same batch with `rpe_enabled = false` → `expects []`,
   `status none`; a plan outside a batch → a group of one; two teams in one batch → the team coach sees
   only own athletes.
3. `expects` per kind; the workspace switch off → not asked.
4. A self-report activity never `awaiting_entry`; standing alone (its session outside the window) it is an
   `activity` card with `status none`.
5. A GPEXE import (`importGpexePlan`, as `activity-roster-5a1.test.mjs`) → its own card, `expects
   ["device_data"]`, `attendance {roster, present, needsState}`, `awaiting_entry` while states are
   missing, `done` after decisions.
6. External: a generated occurrence with 2 assignments and 1 RPE → one card `1/2`; a projected future day →
   one card, `planned`, no counts; a cancelled schedule → `cancelled`.
7. Test: materialized assignments → `results`, `done` / `awaiting_entry`; projected → `planned`; past
   without an occurrence → `not_opened`.
8. The 62-day cap, `to < from`, malformed ids, bad `today`, unknown `kinds` → `400`.
9. **No write on read**: an active external schedule and a test schedule whose current occurrence is
   missing — the K1 read leaves `external_schedule_occurrences`, `external_assignments`,
   `test_schedule_occurrences` and `test_assignments` unchanged (counts before / after), while the TL
   calendar creates the occurrence (the control); plus a static test that `calendarQuery.js` and
   `calendarAccess.js` import neither occurrence service.
10. D8 contract: club admin → `200` on the detail and the roster of a team activity of its team, the
    activity listed by `GET /api/training-activity` and `GET /api/training-load/calendar`; another club's
    admin → `404` byte-identical to a random UUID's; an archived team → `404`; a reparent by the club
    admin → `404` as today.
11. Statement count independent of the number of items (12 vs 1 sessions).
12. After the internal reviews (`code-reviewer`, `security-reviewer`, 2026-10-30): the athlete workspace on a
    shared team activity sees only itself (no teammate id or name anywhere in the answer, no roster); one
    account with four roles reads only its active workspace's scope; team X's coach against team Y's activity
    of the same club (the identical 404, absent from the list and the calendars); a foreign `athleteIds`
    filter → an empty 200; a schedule of another club by target (invisible without a target of mine, visible
    when it addresses my athlete); decision 4 pinned (a private coach's plan read by the club and the team);
    the athlete's own projected schedule days; an external day with only excused assignments expects nothing;
    the self-report predicate follows v44's roster answer; the slot order of an item without a slot; the
    weekly-plan rule imported, not copied; a year outside 2000–2100 → 400.
13. After the independent review (2026-10-30): D16 under every `kinds` filter — `kinds=activity` shows no RPE
    activity of a training (the groups are read whenever activities are, and folded activities are never
    emitted alone; a coach-made activity stays its own card); test 9 retargeted to a session no longer in the
    answer (the plan taken back to a draft, an assignment outside the window); membership on the day (an athlete
    who left yesterday is on the past card and not on the future one, the club still reads them by the club
    membership; a new member's earlier plan is not on the team's past days, their later one is; the Team filter
    follows); `missed` for external and test days whose unanswered entries are terminal, `awaiting_entry` while
    one is still open; the roster wait only after the day (`deriveStatus`); the no-write guard compares a
    content digest of thirteen tables, not counts; the statement count is asserted positive and equal across
    1 session + 1 activity against 12 sessions + 2 RPE + 4 roster activities; every 400 carries its code.
14. After the independent review's second round: the membership rule's boundary days (the leaving day and the
    joining day count), the fallback for a current member's plans before their first period, and the Club /
    Team filter on the day for an athlete who moves from team X to team Y inside the club (tests 23, 25).

Also run and record: `training-load-calendar.test.mjs`, `training-activity.test.mjs`,
`activity-roster-5a1.test.mjs`, `tests-weekly-calendar.test.mjs`; a failure not mine is reproduced on a
clean detached `origin/main` worktree before it is called pre-existing.

## 7. Reviewers and triggers

`code-reviewer` + `security-reviewer` (D8: owner scope, workspace, info-hiding). External-review trigger
**2** is hit (access): the PR is prepared for the owner's external review and is not merged before it.
Trigger 3 (identity / linking) is not: K1 stores no link. No migration, so no `db-reviewer`.

## 8. The manager's decisions on the open points (GO of 2026-10-30; none needed the owner, all inside D1–D15)

1. **v44.** PR #275 is merged (`835e462`); the branch is brought up to date with `main` and K1a **calls**
   `training.activity_has_roster()`. The rule is never inlined.
2. **The planned-RPE workspace switch** is part of `expects` (`rpe_enabled` AND
   `training_load.planned_rpe_effective_for_plan`) — the real submit route's own gate.
3. **`today` from the client**, validated as `YYYY-MM-DD` and refused (`400`) when more than 2 days away from
   the server's UTC date. The status enum `planned / done / awaiting_entry / not_opened / cancelled / none`
   stands: `done` = every expectation met, `none` = nothing was expected (K1b shows no badge), `awaiting_entry`
   only after the day passed with an unmet expectation or a roster (where one exists) that still needs a
   state; a self-report activity is never awaiting. K1b decides the labels. After the independent review:
   `missed` joins the enum (the day passed and every unanswered entry is terminal), and the roster wait too
   starts only after the day.
4. **Q-D:** plans by **membership on the item's day**, not by plan ownership — read from the v25 membership periods (the manager's reading of the plan as approved, after the independent review found the first build reading today's membership as Training Load and Coach Home do), with the fallback to the current membership for the days before the athlete's first period in the club (option b, the manager's decision after the independent review's second round); UTC date granularity, boundary days inclusive. The dual-member consequence and the fallback in section 3 stay points for the owner.
5. **Club workspace** reads the plans of club members **and** of members of the club's teams (the spirit of D8).
6. **Projected schedule days by target** (team / club / athlete in scope), not only by owner, the way
   `tests.js` projects them.
7. **The read / write split after D8** is accepted for K1 (read-only phase), stated in section 3 as a
   deliberate asymmetry and handed to `security-reviewer` explicitly; writes are decided with K2's events.

Standing rules restated with the GO: the no-write-on-read guarantee stays strict (no external-occurrence
generator call; projection in memory); the SQL statement count stays independent of the item count; one
`resolveActiveWorkspace` per request; the plan is committed with the code in the same pull request.

## 9. Risks and limits

- Performance: four teams × 20 athletes × 6 sessions a week is about 2,900 planned rows in a month grid,
  grouped on the server into about 500 cards; `include=athletes` multiplies the answer, so it stays opt-in.
- A Builder batch edited apart splits into several cards (K0 §6); a GPEXE team activity and the RPE
  activities of the same training are separate cards in K1 (no link exists; K2's event links both).
- Rosters of sessions older than the athletes' OptiMove membership start are short (K0 open risk);
  unchanged here.
- Local dates: a planned session is `plan_days.date`, an activity `occurred_local_date`, an assignment its
  own `local_scheduled_date`; `today` is the caller's date. No instant is converted on the server.
- `public.user_athletes` (a private coach's athletes) keeps no history, so the private coach's scope is today's
  relationship; `teams[].athleteCount` is today's active team membership count.
- Decision 4's consequence (section 3): a membership period starts at `starts_at`, the moment the athlete was added
  in OptiMove (v25), not at a sporting join date; without the fallback every plan dated before it would vanish from
  the club and team calendars while the weekly plan and Coach Home still show it. The fallback (option b) keeps a
  current member's history visible and still removes a former member after the leaving day; the owner may choose
  option (a) or (c) instead — one function changes (`membershipOnDaySql`).
- Recorded by the security review, outside this change: the existing `GET /api/training-load/calendar` still
  returns `participantCount` and the RPE requested / rated totals across every participant to an athlete
  (`routes/trainingLoad.js`, the activity query and its item); the new read gives an athlete their own
  participation only. A separate task.
- Not covered by a test (recorded): the number of `training.activity_has_roster()` calls per read (statement
  count is bounded by test 16; the function runs only for own-card activities by construction), and the
  `present` reconciliation under a two-states conflict after a merge (holds by construction: `did_not_participate`
  is counted outside the needs-state group).