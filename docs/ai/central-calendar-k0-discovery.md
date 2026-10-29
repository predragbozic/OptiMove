# Central calendar — K0 discovery

Status: **discovery and proposal only.** Nothing here is built, decided beyond D1–D4, or applied to any
database. Read-only reading of the checked-out code; no database was queried.

- Last verified against commit: `aaf150a` (merge of PR #269).
- Author: the Calendar stream's executor, 2026-10-29.
- Scope: the four calendars the app has today, what the main **Calendar** menu item does, the data a
  central club calendar could read, the gaps against the owner's vision, a K1 proposal (read-only) and a K2
  sketch (events). The clickable mock is a private Artifact, not part of the repository.

## 0. Owner decisions (2026-10-29)

| | Decision |
|---|---|
| **D1** | The central calendar **replaces** the current **Calendar** menu item. |
| **D2** | Event kinds: training, match, travel, meeting, day off, camp, test. A Settings → Calendar section defines them, in a later phase. |
| **D3** | The first built version (**K1**) is **read-only** over existing data. Creating events comes in **K2**. |
| **D4** | A club admin creates events for the whole club. A few default event types exist from the start and can be edited or deleted. Not wanted for now: badges, finance, membership counting. |

Everything else in sections 7–9 is a proposal; every open product question is collected in section 10.

## 1. The five most important findings

1. **Today's Calendar menu item is not a calendar of the club: it is one athlete's weekly plan.** For a coach
   it opens the weekly plan of whichever athlete was last picked in the Athletes list, with the month picker
   open; with no athlete picked it shows only *No athlete selected.* (`frontend/weekly-data.js:37-38`,
   `frontend/app.js:1675-1697`). That explains why its purpose is unclear. Everything it offers is also
   reachable through **Athletes → an athlete**, which opens the same view (`frontend/app.js:3109-3123`).
2. **There is no team-level planned "event" anywhere.** A weekly plan belongs to one athlete
   (`plans.plans.athlete_id`); a team training for 20 athletes is 20 plans, linked only by
   `builder_batch_id` when they were created together (`backend/src/routes/builder.js:436-437`). Location,
   opponent, home/away and a *cancelled* state do not exist for trainings. The nearest thing to an event
   today is an **external schedule** (Training Load → Schedule): a name, a fixed event type, a time window,
   team/club targets and a cancelled status — but it exists to collect RPE, not to plan.
3. **The existing calendars use three different access models.** Coach Home and the weekly plan scope by
   the athlete roster, Training Load by the *active workspace* with owner scope, Tests by the user's
   *global* manageable clubs/teams (`backend/src/routes/tests.js:1031-1058`,
   `backend/src/testsAccess.js:47-56`). In a **club workspace the Training Load calendar shows only
   club-owned activities**: team-owned activities of that club's own teams (every GPEXE import is
   team-owned) are not shown, and their planned sessions disappear once linked
   (`backend/src/trainingActivityAccess.js:63-78`, `backend/src/routes/trainingLoad.js:1640-1643`). A club
   calendar must decide this rule first (ADR-002); it is the main reason K1 needs a security review.
4. **The Training Load calendar endpoint is the right base, but not as it is.** It already merges actual
   activities, planned sessions and external assignments with club/team/athlete filters and a 62-day cap,
   and carries RPE and metric coverage (`backend/src/routes/trainingLoad.js:1482-1746`). It returns one
   planned row **per athlete** (no grouping, no team id), only for sessions with Training Load switched on,
   and it **writes** on every read (it generates external occurrences first, `:1557`). A central calendar
   needs a grouped, team-aware read on top of the same scope helpers.
5. **"Awaiting entry" can be derived today, "cancelled" cannot (except Tests and external schedules).**
   Roster completion (`training.activity_completions.status`, `training.activity_roster_needs_state()`),
   RPE requested/rated and metric coverage exist per activity. Event types, locations and absence reasons
   exist only as global, code-owned catalogs (`training.activity_types`, the external `event_type` CHECK
   list, `training.participation_reasons`); per-club, editable catalogs (D4) are new schema — K2.

## 2. The four calendars today

### 2.1 Calendar menu item = the athlete's weekly plan (`state.activeTab === "weekly"`)

| | |
|---|---|
| Files | `frontend/weekly-plan.js` (week/month helpers), `weekly-actions.js` (week arrows, Today, month picker; client-side only), `weekly-data.js` (loader, cache namespace `weekly`), `program-view.js:134-163` (`renderWeeklyRootHtml`), `app.js:3246-3300` (`renderWeeklyRoot`, `renderWeekCalendarPicker`) |
| Endpoint | `GET /api/athletes/:athleteId/program-data?program=__weekly__` (`backend/src/routes/athletes.js:196-271`) — every week of one athlete at once, no date range (`weekly-data.js:10-25` comment) |
| Data | `plans.v_weekly_plan_items` (latest definition `migrations_v2/202608231700_weekly_calendar_draft_hidden_and_session_name.sql:35-106`): active, published weekly plans only; days → sessions (`am_pm`, `bta`, optional `session_time`, `name`) → items (exercises and their hierarchy) |
| Access | `canAccessAthlete()` (`backend/src/access.js:87`) — the user's athlete access, not the active workspace; answers 403 for both a missing and a forbidden athlete |
| Who | Coach (any workspace with a picked athlete); athlete (own plan, `frontend/athlete.html:27` "Weekly plan") |
| Views | One week (seven day cards), week arrows, Today, a month picker of weeks that have a plan, drill-in to sessions and exercises |
| Good at | The real content of training: exercises, sets/reps/load, media, per day and session |

### 2.2 Coach Home day calendar

| | |
|---|---|
| Files | `frontend/coach-home.js`, `coach-home-data.js`, `coach-home-actions.js` |
| Endpoints | `GET /api/athletes/today[?date=]` (`athletes.js:82-140`) and `GET /api/athletes/training-days?from&to` (≤ 42 days, `athletes.js:33, 144-175`) |
| Data | `plans.v_weekly_plan_items`: per athlete the number of sessions and items that day; per day the number of athletes with a session |
| Access | `currentAthleteRosterScope()` (`backend/src/athleteRosterScope.js:5-27`): private coach → own athletes, club/team → active memberships, athlete → self; **any other workspace type, the platform workspace included, gets `and false`** (no athletes) |
| Views | A month grid with dots, one day's athletes with or without training, search; a click opens that athlete's weekly plan on that day (`coach-home-open-athlete`, `app.js:2630-2650`) |
| Good at | "Who trains today", fast, cheap, scoped by the roster |

### 2.3 Training Load calendar (Data & Analysis → Activities)

| | |
|---|---|
| Files | `frontend/training-load-calendar-view.js`, `training-load-calendar-data.js` |
| Endpoint | `GET /api/training-load/calendar?dateFrom&dateTo[&clubIds&teamIds&athleteIds]` (`backend/src/routes/trainingLoad.js:1488-1746`), at most 62 days (`:1482`) |
| Data | Kind `activity`: `training.activities` (not superseded) with participants, RPE requested/rated, metric coverage, conflicts, open match suggestions (five LATERAL subqueries, `:1570-1627`). Kind `planned`: `plans.plan_sessions` with `training_load_enabled = true` and no confirmed activity link, **one row per athlete** (`:1629-1648`). Kind `external`: external assignments with no confirmed link, one row per athlete (`:1650-1668`) |
| Access | Athlete workspace → own rows. Coach: activities by owner scope of the active workspace (`trainingActivityAccess.js:60-78`: club → `owner_scope = 'club'` only, team → `'team'` only, private coach → `'user'`, platform → all); planned/external by roster membership (`trainingLoad.js:1006-1032`), narrowed by the filter as a union across kinds (`:1055-1070`) |
| Side effect | Generates current external occurrences before reading (`:1557`, `trainingLoadOccurrenceService.js:153-174`) |
| Views | Week strip and month grid toggle, a day agenda, an activity detail with Overview / Athletes / Components / Sources / Roster tabs, a results table, an athlete drawer, *Analyze this activity* (`training-load-calendar-view.js:46-813`) |
| Good at | Plan against done, data completeness, drill-in to the activity and the athlete; already merges three kinds |

### 2.4 Tests weekly calendar (Tests → Today / Schedule / Results)

| | |
|---|---|
| Files | `frontend/tests-view.js`, `tests-actions.js`, `tests-data.js:222` |
| Endpoint | `GET /api/tests/weekly?weekStart[&includeCancelled]` (`backend/src/routes/tests.js:1026-1211`), exactly one week |
| Data | `tests.test_schedules` (one-time or daily) projected onto the week in application code (`:1011-1024`), with `opens_time`/`closes_time`, target summary (team and club **names**, athlete count) and per-day counts: total, completed, skipped, not yet open, open, missed, results |
| Access | `requireCoachWorkspace` + the user's **global** manageable club and team ids (`tests.js:1031-1058`, `testsAccess.js:47-56`), not the active workspace |
| Views | One week shell shared by Today / Schedule / Results; athletes have their own Today / Upcoming / History lists |
| Good at | Group scheduling (team/club targets), a real time window, a **cancelled** status, completion state per day |

## 3. What the Calendar menu item does today (D1)

- **Coach.** The rail button `#calendarToggle` (`frontend/index.html:37`) calls `openWeeklyCalendarFromRail`
  (`app.js:1675`): it switches to `weekly` for `state.selectedAthleteId` and opens the month picker; pressed
  again on a loaded plan it toggles the picker. With no athlete picked: *No athlete selected.*
  (`weekly-data.js:37-38`). After a sign-in a coach without a picked athlete lands on Home instead
  (`app.js:372-374`), and a workspace switch leaves `weekly` for Home (`app.js:3024`).
- **Athlete.** The athlete shell's first rail item is **Weekly plan** (`frontend/athlete.html:27`,
  `data-athlete-tab="calendar"` → `weekly`, `app.js:442-458`): the athlete's own plan with the same week
  navigation. It is the athlete's main training screen.

What must stay reachable after the replacement, and where:

| Function today | Code | Where it goes |
|---|---|---|
| One athlete's weekly plan, day by day, with exercises | `renderWeeklyRootHtml`, `makeNode` / `navStack` | Unchanged at **Athletes → athlete** (`app.js:3109-3123`), and from a calendar event → athlete → *Weekly plan* |
| Week arrows, Today, week title | `weekly-actions.js:5-71` | Stays in the athlete's weekly plan |
| Month picker of weeks with a plan | `app.js:3270-3300` | Stays in the athlete's weekly plan (the week title button); no longer behind the rail button |
| Create a weekly plan for the viewed week | `weekly-create-plan`, `app.js:2711-2735` | Stays in the athlete's weekly plan; later also K2 *Make trainings from plans* |
| Edit / Copy / Delete the plan | `plan-actions-view.js:7-23` | Stays in the athlete's weekly plan |
| Specific programs tab | `athlete-view.js:45-53` | Stays in the athlete header |
| Deep links to a date: Coach Home rows, Training Load Schedule click-through, Athlete Home day / today, weekly-plan notifications, the return from Builder | `openWeeklyPlanOnDate` `app.js:2348`; callers `app.js:2648, 2676, 1829`, `training-load-actions.js:1671`, `builder-actions.js:147-152, 1468` | Keep targeting `weekly`; they keep working if `weekly` stays the athlete-detail view |

**Technical consequence:** the central calendar gets a **new tab key** (for example `club-calendar`) behind
`#calendarToggle`; `weekly` is not renamed or removed — at least nine call sites and the `weekly` cache
namespace (`frontend/menu-cache-policy.js:58`) depend on it. Whether the athlete shell's *Weekly plan* also
changes is open (Q1).

## 4. Data available for a central calendar

- **`GET /api/training-load/calendar`** per kind (`trainingLoad.js:1678-1742`):
  - `activity`: `activityId, name, activityTypeKey, occurredLocalDate, startedAt, timezoneSnapshot, origin,
    lifecycleState, participantCount, rpe {requested, rated}, metrics {total, withData}, conflictCount,
    openSuggestionCount`. No end time in the answer (the table has `ended_at`), no team, no location.
  - `planned`: `sessionId, logicalSessionId, planId, sessionName, sessionTime, rpeEnabled, athleteId,
    athleteName`. Only `training_load_enabled` sessions without a confirmed link.
  - `external`: `externalAssignmentId, scheduleId, eventName, scheduleStatus, assignmentStatus, opensAt,
    closesAt, athleteId, athleteName`.
- **Time of day of a plan session:** yes, optional — `plans.plan_sessions.session_time` (`time`), set in
  Builder (`frontend/builder-structure.js:153, 392`), plus `am_pm` and `bta`. **No duration or end time.**
  Most seeded sessions have none (`migrations/20260818_seed_multi_athlete_03_*.sql:308`), so most sessions
  can only be placed as AM / PM / all-day, not on a time grid.
- **Tests:** schedules with a time window, cancelled, group targets and per-day completion counts
  (section 2.4). Recurrence is only daily.
- **External schedules:** `event_name`, `event_type` in a fixed list (`team_training, individual, gym,
  rehabilitation, match, other`, `migrations_v2/202609011200_training_load_v6_external_schedule_event_type.sql:13`,
  labels `frontend/training-load-view.js:775-782`), `opens_time/closes_time`, targets athlete/team/club,
  status `active/paused/cancelled`, occurrence status `scheduled/open/closed/cancelled`
  (`migrations_v2/202609011000_training_load_v4_external_scheduling.sql:88, 198`).
- **Completeness, usable as "awaiting entry":** per activity `training.activity_completions.status`
  (`not_complete / complete / needs_review`, `…v25_activity_roster_foundation.sql:524-537`),
  `training.activity_roster_needs_state()` (`…v26_activity_roster_decisions.sql:119`), RPE rated < requested,
  metrics with data < total. The calendar route returns the last two, not the roster state.
- **Group commands that exist:** a multi-athlete weekly plan in one Builder request (`builder.js:426-437`,
  one plan per athlete, `builder_batch_id`); external schedules and Tests schedules with team/club targets
  (`tests.js:824` bulk). **No "make trainings from plans" UI:** the activity materialize routes are
  per athlete and "not driven by any frontend" (`backend/src/routes/trainingActivity.js:340-345`). No copy
  of a week across a team (only a plan's duplicate and a day's copy-into, `builder.js:1019`).
- **Teams:** `public.teams` (`club_id, name, short_name, logo_url, is_active`, `create_access_schema.sql:38-47`);
  **no team colour**. Athletes belong to teams by `public.athlete_memberships` (one athlete may be in two
  teams, so a card can belong to two lanes).

## 5. Gaps against the owner's vision

| Owner's vision | Today | Gap |
|---|---|---|
| A club event with type, time, place, groups | Per-athlete plan sessions; external schedules (RPE) and Tests schedules are group-targeted | No scheduled event layer for trainings, matches, travel, meetings, days off, camps |
| Location | None in any table | New catalog (K2) |
| Cancelled | Tests and external schedules only | Trainings cannot be cancelled, only deleted from the plan |
| Copy events / copy week | Plan duplicate, day copy-into | No copy across days or teams at event level |
| Make trainings from plans | Builder batch create; materialize routes without UI | A group command (K2 or later) |
| Event types per club, defaults editable and deletable | Three global, code-owned catalogs | Per-club types (K2); a mapping from the old keys |
| Match: opponent, home/away, result | None | Match fields on an event (K2) |
| Attendance statuses, absence reasons | `participation_status` and the global, immutable `training.participation_reasons` (keys never removed, `…v25…sql:350-351`) | Club-editable reasons would be a new rule against v25's "never removed" |
| Performance on the card | RPE and metric coverage per activity | Which metrics a card shows is a per-club setting (K2) |
| Team colours | None | A deterministic palette in K1, a stored colour in K2 |
| Day / Week / Month / Year views | Week and month only; 62-day cap | A year view needs a count-only read |

## 6. Risks

- **Workspace scope and info-hiding (ADR-002, ADR-006).** The club calendar must say whether a club
  workspace sees its teams' team-owned activities. Today it does not (finding 3). Widening that is an
  authorization change: owner scope (who manages) and data workspace (whose data is read) must stay two
  checks, and a team the caller may not see must be answered like a missing one. Tests' global-role model
  must not leak into the club calendar: a club admin of two clubs must see only the active club.
- **Activity merge and supersede (ADR-001).** Activities are reparented and merged; a superseded row must
  never appear and a merged participant must be counted once (`merge_status = 'canonical'`, as the route
  already does). Linking an event to an activity must survive a merge — link to the canonical activity and
  follow `superseded` forward.
- **The 62-day cap.** It fits Day/Week/Month (a six-week grid is 42 days). A year view cannot reuse the
  same detailed read; it needs a separate, count-only read per day.
- **Performance with many teams.** Four teams × 20 athletes × 6 sessions a week is about 480 planned rows a
  week and about 2,900 for a month grid, each activity with five LATERAL aggregates. A central read should
  group planned rows on the server and aggregate per event, not ship per-athlete rows to the browser.
- **The GET that writes.** `/calendar` generates external occurrences before it reads. A new club calendar
  should not add more write-on-read; if it reuses the helper, that write stays inside the existing,
  workspace-scoped generator.
- **Time zones.** Plan sessions are local wall-clock times without a zone; activities carry
  `timezone_snapshot`. A club calendar shown in the club's zone needs one rule for both.
- **Plans without a time.** Most sessions have no `session_time`; a time-grid week view will put many of
  them in an AM / PM / all-day band.

## 7. Proposal for K1 (read-only)

**Goal:** one Calendar screen for the active club, team or private-coach workspace, over existing data, with
filters and drill-in. No new table, no migration, no write.

**API (proposal):** `GET /api/calendar/club?from&to[&teamIds&types&athleteIds]`, at most 42 days (a month
grid), one batch read:

```json
{
  "from": "2026-10-26", "to": "2026-11-01",
  "teams": [{ "teamId": "…", "name": "U19", "colorIndex": 0, "athleteCount": 21 }],
  "counts": { "byTeam": { "<teamId>": 9 }, "byType": { "training": 14, "test": 1 } },
  "days": [{
    "date": "2026-10-28",
    "items": [{
      "key": "planned-group:<batchId>:<date>:<sessionOrder>",
      "kind": "planned_group | activity | test | external",
      "type": "training | match | test | other",
      "title": "Team training", "time": "17:30", "timeBand": "PM",
      "teamIds": ["…"], "athleteCount": 20,
      "attendance": { "recorded": 18, "expected": 20 },
      "rpe": { "rated": 15, "requested": 20 },
      "roster": "complete | needs_state | needs_review | null",
      "status": "planned | done | awaiting_entry | cancelled",
      "links": { "activityId": "…", "planIds": ["…"], "testScheduleId": null }
    }]
  }]
}
```

- **Scope:** resolve the active workspace once (`resolveActiveWorkspace`) and reuse
  `coachWorkspaceScopeSqlForWorkspace` and `athleteExtraFilterSql` (`trainingLoad.js:1006-1070`) for plans,
  external assignments and Tests targets, and `activityScopeSqlForWorkspace` for activities — moved into a
  shared access module rather than copied. The club-sees-team-activities rule (Q4) is decided before K1 is
  built; until then K1 shows exactly what Training Load shows.
- **Grouping:** planned sessions grouped on the server by `builder_batch_id` + date + `session_order` (and by
  the plan for a single athlete); activities by activity; Tests by schedule and day; external by occurrence.
  A group's team is the team of its athletes' active memberships (two teams → two lanes).
- **"Awaiting entry":** a past item with an open roster state, RPE rated < requested, or metrics with data <
  total. **"Cancelled":** only Tests and external schedules in K1.
- **Frontend:** a new domain `club-calendar-{view,actions,data}.js`, the `view-cache.js` loader with a
  context key of workspace + range + filters and a generation check; Day / Week / Month views, Groups and
  Types chips with counts, a side panel per event with drill-in to the athlete (the existing `weekly` view)
  and to the activity (the existing Training Load activity detail). No Year view in K1 (Q8).
- **Later (K3):** Coach Home's day calendar, the Training Load Activities calendar and the Tests week shell
  become views of the same source (same endpoint, other filters), once K1's read is stable. The athlete's
  own view reads the same endpoint scoped to self.

**Reviewers and triggers for K1.** Backend scope work → `code-reviewer` + `security-reviewer`; the new
screen → `mobile-qa` + `ux-design-reviewer`. External-review trigger **2** (workspace, owner scope,
info-hiding) is hit by the scope rule; trigger 3 is touched if the event ↔ activity link follows merges.
No migration, so no `db-reviewer` unless an index is added.

## 8. K2 sketch — events, types, locations, Settings → Calendar (proposal)

Not decided. Tables in a new `calendar` schema, one migration, ★★ (external review; triggers 1 and 2):

- `calendar.event_types` — `id, owner_club_id` (or `owner_scope` + owner ids, ADR-002), `key`, `label`,
  `kind` (D2: `training, match, travel, meeting, day_off, camp, test`), `default_duration_minutes`,
  `is_match` (adds opponent, home/away, result), `icon_key` (the existing icon library,
  `frontend/icon-library.js`), `color`, `sort_order`, `seed_key` (null for a club's own type),
  `archived_at`, `created_by`, audit columns.
  - **Seeded defaults, editable and deletable (D4):** seeded per club on first use (copied rows, not one
    shared global row), so a club can rename or delete its copy without touching another club.
  - **Delete:** a type with no event is deleted; a type in use is archived (hidden from pickers, kept on old
    events), never hard-deleted. A restore is a later choice.
- `calendar.locations` — `id, owner_club_id, name, address, archived_at` (same archive rule).
- `calendar.events` — `id, owner_club_id, event_type_id, title, starts_at, ends_at, all_day, timezone,
  location_id, status (scheduled | cancelled), cancelled_reason, note, opponent, home_away, result,
  created_by, request_key`; targets in `calendar.event_targets (event_id, team_id | athlete_id)`.
- `calendar.event_activity_links` — an event ↔ the canonical activity that recorded it (zero or one per
  athlete group), followed forward on a supersede (ADR-001). An event never stores RPE or results itself
  (ADR-004): they stay on the activity.
- Absence reasons: either club-owned reasons beside `training.participation_reasons`, or a club label over
  the global keys (keys stay immutable, v25). Q6.
- **Who edits (D4):** the club admin of the active club workspace for the whole club; platform admin for
  support. Whether a team coach creates events for their own team is open (Q2).
- **Settings → Calendar:** Event types, Locations, Absence reasons, Card metrics (which counts a card shows),
  as a new Settings sub-tab beside Data sources, Source connections and Icons.
- **Commands (later than the tables):** New event, Copy events (a day or a week to other days or teams),
  Make trainings from plans (create events from a week of plans, linked to them).

## 9. What K0 delivers

- This document (the only file in the pull request).
- A clickable mock with made-up data (one club, U19/U17/U15/U13, about 20 athletes each, one week): Week
  (time grid with team lanes), Month (density and team load), Day agenda, Groups and Types chips with counts,
  event cards (plan against done, attendance x/y, missing RPE, awaiting entry, cancelled), a side panel with
  drill-in to an event, its activity and an athlete, Settings → Calendar, and a phone layout. A switch
  previews **K1** (only what OptiMove stores today) against **K2** (with events); the week has a *Time grid*
  and a *Team lanes* layout to compare. Published as a private Artifact
  (<https://claude.ai/artifact/GCq2rA2Eb4vjzruE4L4KQi>); not in the repository. Checked in a browser at
  1366 px (light and dark) and at 360, 375 and 390 px (no horizontal overflow, no control under 44 px).

## 10. Open questions for the owner

1. **Q1 — The athlete's own Weekly plan.** Does D1 also replace the athlete shell's *Weekly plan*, or only the
   coach's Calendar? Recommendation: the athlete keeps *Weekly plan* (their training content) and later gets
   a personal calendar of events.
2. **Q2 — Team coaches.** May a team coach see the whole club calendar, or only their team? May they create
   events for their team (D4 names only the club admin)?
3. **Q3 — Private coaches.** A private coach has no club or team: do they get the same calendar of their own
   athletes, without Groups?
4. **Q4 — Team activities in the club view.** Should a club admin's calendar show activities owned by the
   club's teams (GPEXE imports are team-owned)? Today Training Load does not. This is an authorization rule
   and needs the external review.
5. **Q5 — Seeded types.** Are the D2 kinds fixed system kinds (a club can rename and hide, not invent a new
   kind), or can a club add any type? Which defaults are seeded, and with which durations?
6. **Q6 — Absence reasons.** Club-editable reasons, or club labels over today's global reasons?
7. **Q7 — Team colours.** Chosen by the club admin in Settings, or automatic?
8. **Q8 — Year view.** Needed in K1, or later?
9. **Q9 — Plans without a time.** Show them in an AM / PM / all-day band, or ask coaches to set a time?
10. **Q10 — What a card shows.** Attendance and RPE by default; which metrics may a club add?
