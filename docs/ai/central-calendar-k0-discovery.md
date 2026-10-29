# Central calendar — K0 discovery

Status: **discovery and proposal only.** Nothing here is built or applied to any database. The owner's
decisions are D1–D14 (section 0); everything marked *proposal* or *manager default* is not an owner
decision. Read-only reading of the checked-out code; no database was queried.

- Last verified against commit: `aaf150a` (merge of PR #269).
- Author: the Calendar stream's executor, 2026-10-29; revised the same day after the stream's independent
  review (1 HIGH, 3 MEDIUM, 10 LOW, all addressed here) and the owner's answers to Q1–Q10.
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

The owner's answers to Q1–Q10 (2026-10-29), recorded as written; a line marked *proposal*, *manager
default* or *OPEN* is not an owner decision:

- **D5** (Q1) The athlete's weekly plan does not change. The central calendar opens an athlete's weekly plan on the day (`openWeeklyPlanOnDate`). The athlete sees general events such as a match (K2). Manager default: only events of the athlete's own teams or addressed to the athlete (name, time, place), never teammates' data, RPE or attendance.
- **D6** (Q2) A team coach sees the team's activities and opens their athletes' weekly plans. A team coach creates events for their own team; the club admin creates events for the whole club (owner, 2026-10-29).
- **D7** (Q3) A private coach schedules joint activities for their athletes or groups of them and opens their weekly plans. The group model is a K2 proposal: present both options — the existing Tags (check how they are owned) and a new group table — and give a recommendation.
- **D8** (Q4) The club SEES its teams' activities, in the active club workspace only. The same rule applies to TL Activities and to the activity detail, so a calendar click never ends in a 404. The O2 precedent belongs here. In K1 this needs security-reviewer plus external review (trigger 2).
- **D9** (Q5) The club adds its own event types. Proposal: each type maps to one base kind from D2, and the kind decides what is expected (attendance, RPE).
- **D10** (Q6) Club absence reasons are allowed: the club adds its own. The six shared reasons stay (v25 contract). This is a later phase, with db-reviewer. Proposal, not in the owner's answer: the club may hide a shared reason.
- **D11** (Q7) The club picks team colours; an automatic palette is used until then.
- **D12** (Q8) No year view: month with arrows, week and day.
- **D13** (Q9) Two modes. The default is a simple list ordered by slot (AM/PM, then Before/Training/After, then order, exactly as the weekly plan sorts). The time grid is the second mode. Replace "Team lanes" in the mock with the list mode.
- **D14** (Q10) No metrics on the card. The card shows the status (Done / Awaiting entry / Cancelled) and attendance x/y. The event panel has a button to the TL activity. Remove "Card metrics" from Settings → Calendar.

## 1. The most important findings

1. **Today's Calendar menu item is not a calendar of the club: it is one athlete's weekly plan.** For a coach
   it opens the weekly plan of whichever athlete was last picked in the Athletes list, with the month picker
   open; with no athlete picked it shows only *No athlete selected.* (`frontend/weekly-data.js:37-38`,
   `frontend/app.js:1675-1697`). Everything it offers is also reachable through **Athletes → an athlete**,
   which opens the same view (`frontend/app.js:3109-3123`).
2. **There is no team-level planned "event" anywhere.** A weekly plan belongs to one athlete
   (`plans.plans.athlete_id`); a team training for 20 athletes is 20 plans, linked only by
   `builder_batch_id` when they were created together (`backend/src/routes/builder.js:436-437`), and each
   sibling session gets its **own** `logical_session_id` (header of
   `migrations_v2/202608320900_training_load_v2_logical_session_identity.sql:26-31`). Location, opponent,
   home/away and a *cancelled* state do not exist for trainings. The nearest thing to an event today is an
   **external schedule** (Training Load → Schedule): a name, a fixed event type, a time window, team/club
   targets and a cancelled status — but it exists to collect RPE, not to plan.
3. **An RPE turns a team training into up to N single-athlete activities.** Submitting RPE for a planned
   session materializes, in the same transaction, one confirmed activity with **one** participant, keyed by
   athlete + `logical_session_id` (`backend/src/routes/trainingLoad.js:480-484`,
   `backend/src/trainingActivityMaterialize.js:812-819, 837-845, 873`). Its owner is the plan's ownership
   snapshot (`training_load.plan_workspace_ownership`). So a 20-athlete training becomes up to 20 one-person
   activities plus the planned rows of athletes who have not rated yet. A calendar that shows "activities by
   activity" would show N cards for one training. A central calendar has to group them (section 7).
4. **The existing calendars use four different access models.** The weekly plan uses the user's global
   athlete access (`canAccessAthlete`, `backend/src/access.js:87-101`); Coach Home uses that access narrowed to
   the active workspace's memberships (`backend/src/athleteRosterScope.js:5-21`); Training Load uses the
   *active workspace* with owner scope (`backend/src/trainingActivityAccess.js:63-78`); Tests uses the user's
   *global* manageable clubs/teams (`backend/src/routes/tests.js:1031-1058`, `backend/src/testsAccess.js:47-56`).
   In a **club workspace the Training Load calendar and the activity detail hide activities owned by the
   club's own teams** (every GPEXE import and every RPE activity of a plan made in a team workspace is
   team-owned), and their planned rows disappear once linked (`trainingLoad.js:1641-1644`,
   `backend/src/trainingActivityResults.js:16-22, 45-46`) — so past trainings vanish athlete by athlete. Yet
   owner decision **O2** (2026-09-25) already lets that club admin read and decide the **roster** of those same
   team-owned activities (`backend/src/activityRoster.js:8-18`). D8 aligns the calendar, TL Activities and
   the detail with O2.
5. **The Training Load calendar endpoint is a useful reference, not the K1 endpoint.** It already merges
   actual activities, planned sessions and external assignments with club/team/athlete filters and a 62-day
   cap (`trainingLoad.js:1482-1746`). It returns one planned row **per athlete** (no grouping, no team id),
   only for sessions with Training Load switched on (`:1637`; the column defaults to off, v14), and it
   **writes** on every read (it generates external occurrences first, `:1557`).
6. **"Awaiting entry" can be derived today, "cancelled" cannot (except Tests and external schedules).** RPE
   lives in one table (`training_load.session_feedback`, ADR-004) keyed by the plan session, so "RPE x/y per
   training" is computable. Roster states and completion exist **only for team-owned activities**
   (`training.activity_roster()` reads `owner_scope = 'team'`, `…v25_activity_roster_foundation.sql:231-238`;
   `activity_completions.owner_team_id not null`, `:524-526`). The roster is the whole team on that day
   (`:240-262`), so a **one-athlete RPE activity owned by a team** would list every team member as *Needs a
   state* — including the athlete who gave the RPE, because only `api_import` / `csv_import` values count as
   measured (`training.activity_roster_needs_state()`, `…v26_activity_roster_decisions.sql:119-140`) — read
   from the code, not observed in a database; an existing behaviour outside K0, reported as a follow-up. Event
   types, locations and absence reasons exist only as global, code-owned catalogs; per-club catalogs
   (D9–D11) are new schema.

## 2. The four calendars today

### 2.1 Calendar menu item = the athlete's weekly plan (`state.activeTab === "weekly"`)

| | |
|---|---|
| Files | `frontend/weekly-plan.js` (week/month helpers), `weekly-actions.js` (week arrows, Today, month picker; client-side only), `weekly-data.js` (loader, cache namespace `weekly`), `program-view.js:134-163` (`renderWeeklyRootHtml`), `app.js:3246-3300` (`renderWeeklyRoot`, `renderWeekCalendarPicker`) |
| Endpoint | `GET /api/athletes/:athleteId/program-data?program=__weekly__` (`backend/src/routes/athletes.js:196-271`) — every week of one athlete at once, no date range (`weekly-data.js:10-25` comment) |
| Data | `plans.v_weekly_plan_items` (latest definition `migrations_v2/202608231700_weekly_calendar_draft_hidden_and_session_name.sql:35-106`): active, published weekly plans only; days → sessions (`am_pm`, `bta`, optional `session_time`, `name`) → items (exercises and their hierarchy) |
| Access | `canAccessAthlete()` (`backend/src/access.js:87-101`) — the user's athlete access, not the active workspace; answers 403 for both a missing and a forbidden athlete |
| Who | Coach (any workspace with a picked athlete); athlete (own plan, `frontend/athlete.html:27` "Weekly plan") |
| Views | One week (seven day cards), week arrows, Today, a month picker of weeks that have a plan, drill-in to sessions and exercises |
| Good at | The real content of training: exercises, sets/reps/load, media, per day and session, ordered by slot (AM/PM, then Before/Training/After, then order) |

### 2.2 Coach Home day calendar

| | |
|---|---|
| Files | `frontend/coach-home.js`, `coach-home-data.js`, `coach-home-actions.js` |
| Endpoints | `GET /api/athletes/today[?date=]` (`athletes.js:82-140`) and `GET /api/athletes/training-days?from&to` (≤ 42 days, `athletes.js:33, 144-175`) |
| Data | `plans.v_weekly_plan_items`: per athlete the number of sessions and items that day; per day the number of athletes with a session (every published session, tracked or not) |
| Access | `currentAthleteRosterScope()` (`backend/src/athleteRosterScope.js:5-27`): the athlete access filter, then private coach → own athletes, club/team → active memberships, athlete → self; **any other workspace type, the platform workspace included, gets `and false`** (no athletes) |
| Views | A month grid with dots, one day's athletes with or without training, search; a click opens that athlete's weekly plan on that day (`coach-home-open-athlete`, `app.js:2630-2650`) |
| Good at | "Who trains today", fast, cheap, scoped by the roster |

### 2.3 Training Load calendar (Data & Analysis → Activities)

| | |
|---|---|
| Files | `frontend/training-load-calendar-view.js`, `training-load-calendar-data.js` |
| Endpoint | `GET /api/training-load/calendar?dateFrom&dateTo[&clubIds&teamIds&athleteIds]` (`backend/src/routes/trainingLoad.js:1488-1746`), at most 62 days (`:1482`) |
| Data | Kind `activity`: `training.activities` (not superseded) with participants, RPE requested/rated, metric coverage, conflicts, open match suggestions (five LATERAL subqueries, `:1570-1627`). Kind `planned`: `plans.plan_sessions` with `training_load_enabled = true` and no confirmed activity link, **one row per athlete** (`:1629-1648`). Kind `external`: external assignments with no confirmed link, one row per athlete (`:1650-1668`) |
| Access | Athlete workspace → own rows. Coach: activities by owner scope of the active workspace (`trainingActivityAccess.js:63-78`: club → `owner_scope = 'club'` only, team → `'team'` only, private coach → `'user'`, platform → all); planned/external by roster membership (`trainingLoad.js:1006-1032`), narrowed by the filter as a union across kinds (`:1055-1070`). The activity detail applies the same owner rule (`trainingActivityResults.js:16-22, 45-46`) |
| Side effect | Generates current external occurrences before reading (`:1557`, `trainingLoadOccurrenceService.js:153-174`); the only other generator is the CLI worker (`backend/package.json:12`, `trainingLoadNotificationWorker.js:60`) |
| Views | Week strip and month grid toggle, a day agenda, an activity detail with Overview / Athletes / Components / Sources / Roster tabs, a results table, an athlete drawer, *Analyze this activity* (`training-load-calendar-view.js:46-813`) |
| Good at | Plan against done, data completeness, drill-in to the activity and the athlete; already merges three kinds |

Training Load has a second weekly shell, **Schedule / Today / Results**, on `GET /api/training-load/weekly`
(`trainingLoad.js:1072`); it is a K3 candidate together with the views below.

### 2.4 Tests weekly calendar (Tests → Today / Schedule / Results)

| | |
|---|---|
| Files | `frontend/tests-view.js`, `tests-actions.js`, `tests-data.js:222` |
| Endpoint | `GET /api/tests/weekly?weekStart[&includeCancelled]` (`backend/src/routes/tests.js:1026-1211`), exactly one week |
| Data | `tests.test_schedules` (one-time or daily) projected onto the week **in memory, without writing** (`:998-1024`), with `opens_time`/`closes_time`, target summary (team and club **names**, athlete count) and per-day counts: total, completed, skipped, not yet open, open, missed, results |
| Access | `requireCoachWorkspace` + the user's **global** manageable club and team ids (`tests.js:1031-1058`, `testsAccess.js:47-56`), not the active workspace |
| Views | One week shell shared by Today / Schedule / Results; athletes have their own Today / Upcoming / History lists |
| Good at | Group scheduling (team/club targets), a real time window, a **cancelled** status, completion state per day |

## 3. What the Calendar menu item does today (D1, D5)

- **Coach.** The rail button `#calendarToggle` (`frontend/index.html:37`) calls `openWeeklyCalendarFromRail`
  (`app.js:1675`): it switches to `weekly` for `state.selectedAthleteId` and opens the month picker; pressed
  again on a loaded plan it toggles the picker. With no athlete picked: *No athlete selected.*
  (`weekly-data.js:37-38`). After a sign-in a coach without a picked athlete lands on Home instead
  (`app.js:372-374`), and a workspace switch leaves `weekly` for Home (`app.js:3024`).
- **Athlete.** The athlete shell's first rail item is **Weekly plan** (`frontend/athlete.html:27`,
  `data-athlete-tab="calendar"` → `weekly`, `app.js:442-458`): the athlete's own plan. **D5 keeps it as it is.**

What must stay reachable after the replacement, and where:

| Function today | Code | Where it goes |
|---|---|---|
| One athlete's weekly plan, day by day, with exercises | `renderWeeklyRootHtml`, `makeNode` / `navStack` | Unchanged at **Athletes → athlete** (`app.js:3109-3123`), and from a calendar event → athlete → *Weekly plan* on that day (D5) |
| Week arrows, Today, week title | `weekly-actions.js:5-71` | Stays in the athlete's weekly plan |
| Month picker of weeks with a plan | `app.js:3270-3300` | Stays in the athlete's weekly plan (the week title button); no longer behind the rail button |
| Create a weekly plan for the viewed week | `weekly-create-plan`, `app.js:2711-2735` | Stays in the athlete's weekly plan |
| Edit / Copy / Delete the plan | `plan-actions-view.js:7-23` | Stays in the athlete's weekly plan |
| Specific programs tab | `athlete-view.js:45-53` | Stays in the athlete header |
| Deep links to a date | `openWeeklyPlanOnDate` `app.js:2348`; callers `app.js:2339` (`openWeeklyPlanForAthleteOnDate`), `2648` (Coach Home), `2676` (Athlete Home), `1829` (notifications), `training-load-actions.js:1671` (TL Schedule), `builder-actions.js:147-152, 1468` (return from Builder) | Keep targeting `weekly`; the central calendar's drill-in uses the same function (D5) |

Every place that depends on the tab key `weekly` (none may break):

| Dependency | Code | After D1 (proposal) |
|---|---|---|
| Default tab of a fresh session | `frontend/state.js:959` | Unchanged; sign-in already moves a coach without an athlete to Home (`app.js:372-374`) |
| The coach's Back root | `app.js:2062` | **Home** (`coach-home`), not `weekly` |
| Fallback when Settings access is lost; athlete leaving Builder | `navigation.js:64-65` | Coach → Home; athlete → `weekly` as today |
| Rail highlight of Calendar | `navigation.js:92, 97` | Highlights the new calendar tab, not `weekly` |
| Cache namespace | `frontend/menu-cache-policy.js:58`, `weekly-data.js:8` | Unchanged; the calendar gets its own namespace |
| The deep links in the table above | — | Unchanged |

**Technical consequence:** the central calendar gets a **new tab key** (for example `club-calendar`) behind
`#calendarToggle`; `weekly` stays as the athlete-detail view.

## 4. Data available for a central calendar

- **Planned sessions.** Every session of a published weekly plan (`plans.v_weekly_plan_items`), one row per
  athlete. The time of day is optional — `plans.plan_sessions.session_time` (`time`), set in Builder
  (`frontend/builder-structure.js:153, 392`) — plus `am_pm`, `bta` and `session_order`. **No duration or end
  time.** How many real sessions have a time is **not verified**: the legacy seed files hold none
  (`migrations/20260818_seed_multi_athlete_03_*.sql:308`), and the databases were not queried.
- **Which planned sessions ask for RPE.** Only a session with `training_load_enabled` **and** `rpe_enabled`,
  under the workspace's planned-RPE setting (`trainingLoad.js:401-417`). Both columns default to **off** since
  v14 (`…v14_session_tracking_and_rpe_defaults.sql:54, 75`); Builder sets both explicitly.
- **RPE and duration.** `training_load.session_feedback`: `rpe`, `duration_minutes`, generated `srpe`
  (`…v1_session_feedback.sql:79-82`), keyed by `logical_session_id` (planned) or `external_assignment_id`.
- **Activities from RPE.** Each RPE submit materializes a one-participant activity, owned by the plan's
  ownership snapshot (finding 3). Activities with many participants come from GPEXE metric events
  (team-owned) and from the other materialize paths, which have no frontend (`trainingActivity.js:340-345`).
- **`GET /api/training-load/calendar`** per kind (`trainingLoad.js:1678-1742`):
  - `activity`: `activityId, name, activityTypeKey, occurredLocalDate, startedAt, timezoneSnapshot, origin,
    lifecycleState, participantCount, rpe {requested, rated}, metrics {total, withData}, conflictCount,
    openSuggestionCount`. No end time in the answer (the table has `ended_at`; RPE activities leave it empty),
    no team, no location. A one-participant RPE activity always has `rated = requested`.
  - `planned`: `sessionId, logicalSessionId, planId, sessionName, sessionTime, rpeEnabled, athleteId,
    athleteName`. Only `training_load_enabled` sessions without a confirmed link.
  - `external`: `externalAssignmentId, scheduleId, eventName, scheduleStatus, assignmentStatus, opensAt,
    closesAt, athleteId, athleteName`.
- **Tests:** schedules with a time window, cancelled, group targets and per-day completion counts
  (section 2.4). Recurrence is only daily.
- **External schedules:** `event_name`, `event_type` in a fixed list (`team_training, individual, gym,
  rehabilitation, match, other`, `migrations_v2/202609011200_training_load_v6_external_schedule_event_type.sql:13`,
  labels `frontend/training-load-view.js:775-782`), `opens_time/closes_time` (an RPE window, not the event's
  time), targets athlete/team/club, status `active/paused/cancelled`, occurrence status
  `scheduled/open/closed/cancelled` (`…v4_external_scheduling.sql:88, 198`).
- **Completeness, usable as "awaiting entry":** RPE submitted against RPE asked (any planned session); for a
  **team-owned** activity also the roster (`training.activity_roster_needs_state()`,
  `…v26_activity_roster_decisions.sql:119`) and `activity_completions.status`
  (`not_complete / complete / needs_review`). Club-, user- and system-owned activities have no roster, and
  the roster of a one-athlete RPE activity is not meaningful (finding 6).
- **Group commands that exist:** a multi-athlete weekly plan in one Builder request (`builder.js:426-437`,
  one plan per athlete, `builder_batch_id`); external schedules and Tests schedules with team/club targets
  (`tests.js:824` bulk). **No "make trainings from plans" UI** and no copy of a week across a team (only a
  plan's duplicate and a day's copy-into, `builder.js:1019`).
- **Teams:** `public.teams` (`club_id, name, short_name, logo_url, is_active`, `create_access_schema.sql:38-47`);
  **no team colour**. Athletes belong to teams by `public.athlete_memberships` (one athlete may be in two
  teams, so a card can belong to two groups).
- **Groups of a private coach:** none. The private coach's athletes are `public.user_athletes`
  (`create_access_schema.sql:103`); existing "tags" classify programs and exercises, not athletes (section 8).

## 5. Gaps against the owner's vision

| Owner's vision | Today | Gap and phase |
|---|---|---|
| A club event with type, time, place, groups | Per-athlete plan sessions; external schedules (RPE) and Tests schedules are group-targeted | No scheduled event layer — K2 |
| Location | None in any table | New catalog — K2 |
| Cancelled | Tests and external schedules only | Trainings cannot be cancelled, only deleted from the plan — K2 |
| Copy events / copy week, make trainings from plans | Plan duplicate, day copy-into; materialize routes without UI | Group commands — K2 or later |
| Event types per club (D4, D9) | Three global, code-owned catalogs | Club types mapped to a base kind — K2 |
| Match: opponent, home/away, result | None | Match fields on an event — K2 |
| Absence reasons (D10) | Global `training.participation_reasons`, keys never removed (`…v25…sql:350-351`) | Club reasons beside them — later phase; hiding a shared one is a proposal |
| Team colours (D11) | None | A palette in K1, a stored colour in K2 |
| Views (D12, D13) | Week and month (TL), week (weekly plan, Tests) | Day / Week (list and time grid) / Month — K1; no Year |
| Groups of a private coach (D7) | None | K2 |
| The athlete's own events (D5) | None | K2 |

## 6. Risks

- **Workspace scope and info-hiding (ADR-002, ADR-006).** D8 widens what a club admin may **read**: activities
  owned by the active club's teams. Owner scope (who manages) and data workspace (whose data is read) stay two
  checks; a team the caller may not see answers like a missing one; an admin of two clubs sees only the active
  club. Tests' global-role model must not leak into the club calendar.
- **Per-athlete activities (finding 3).** Grouping them into one card is K1 logic, not stored data. A Builder
  batch whose sibling plans were later edited apart may split into several groups; a GPEXE team activity and
  the RPE activities of the same training are separate rows unless a match suggestion merged them. A
  team-owned one-athlete RPE activity carries the whole team as its roster (finding 6); K1 must not read it as
  "awaiting entry".
- **Activity merge and supersede (ADR-001).** A superseded row must never appear and a merged participant must
  be counted once (`merge_status = 'canonical'`). The K2 event ↔ activity link must follow `superseded` forward.
- **Write on read.** The TL calendar generates external occurrences before it reads. K1 does not (section 7).
- **Plans made by other workspaces.** Training Load and Coach Home show a club member's plans whoever made
  them (by athlete membership). Showing a private coach's plan of a club athlete in the club calendar is a
  privacy choice (Q-D).
- **The 62-day cap.** Fits Day / Week / Month (a six-week grid is 42 days); D12 removes the Year view.
- **Performance with many teams.** Four teams × 20 athletes × 6 sessions a week is about 480 planned rows a
  week and about 2,900 for a month grid. A central read groups on the server and returns one row per group.
- **Time zones.** Plan sessions are local wall-clock times without a zone; activities carry
  `timezone_snapshot`. The club calendar needs one rule for both.

## 7. Proposal for K1 (read-only)

**Goal:** one Calendar screen for the active club, team or private-coach workspace, over existing data, with
filters and drill-in. No new table, no migration, **no write of any kind**.

**Read-only rule (MEDIUM-2).** K1 never calls the external-occurrence generator. It reads the occurrences and
assignments that exist and projects the rest of a schedule's dates in memory, the way Tests already does
(`tests.js:998-1024`); a projected date shows the schedule, not per-athlete assignments.

**API (proposal):** `GET /api/calendar/club?from&to[&teamIds&types&athleteIds]`, at most 42 days, one batch
read; one item per **group**, never per athlete:

```json
{
  "from": "2026-10-26", "to": "2026-11-01",
  "teams": [{ "teamId": "…", "name": "U19", "colorIndex": 0, "athleteCount": 21 }],
  "counts": { "byTeam": { "<teamId>": 9 }, "byType": { "training": 14, "test": 1 } },
  "days": [{
    "date": "2026-10-28",
    "items": [{
      "key": "planned-group:<batchId>:<date>:<amPm>:<bta>:<sessionOrder>",
      "kind": "planned_group | activity | test | external",
      "type": "training | match | test | other",
      "title": "Team training", "time": "17:30", "slot": { "amPm": "PM", "bta": "T", "order": 1 },
      "teamIds": ["…"], "athletes": 20,
      "recorded": 18, "rpe": { "submitted": 17, "asked": 20 },
      "roster": "complete | needs_state | needs_review | null",
      "status": "planned | done | awaiting_entry | cancelled",
      "links": { "activityIds": ["…"], "planIds": ["…"], "testScheduleId": null }
    }]
  }]
}
```

- **Grouping (HIGH-1).** Planned sessions are grouped by `builder_batch_id` + date + `am_pm` + `bta` +
  `session_order` (a plan outside a batch is its own group). Activities whose participants have a confirmed
  `activity_participant_session_links` row to a session of the group fold into that group's card (the
  `activityIds` above). A team-owned activity with no link (a GPEXE session) is its own card. Tests: one card
  per schedule and day; external schedules: one per schedule and day.
- **Which sessions.** Every session of a published weekly plan, tracked or not (Coach Home already counts them
  all). RPE is expected only where it is asked (section 4).
- **Card numbers (D14).** `recorded / athletes`: athletes with any record — an RPE, a roster state
  *Participated*, or measured values — of those planned. RPE `submitted / asked` from `session_feedback`
  (ADR-004). Roster only for a team-owned activity. **No duration and no end time** in K1: only the start
  (`session_time`) or the slot.
- **"Awaiting entry".** A past item where an athlete who was asked for RPE has none (with or without an
  activity), or a team-owned activity with athletes still needing a roster state — counting the roster only
  for activities that are not one-athlete RPE activities (origin `planned_session`, finding 6).
- **ADR-001.** K1 shows counts, not activity facts. RPE counts come from `session_feedback` by logical session
  (ADR-004), roster counts from the roster functions; K1 does not copy the TL calendar's LATERAL metric joins.
  Every value (RPE, metrics, results) is read only in the activity detail, which uses
  `training.canonical_activity_results()`.
- **Scope (D8, proposal for the security review).** Resolve the active workspace once. Club workspace: the club's
  and its teams' activities, plans and schedules; team workspace: the team's (D6); private coach: own athletes
  (D7). The same read rule is applied to TL Activities (`trainingActivityAccess.js`) and to the activity detail
  (`trainingActivityResults.js`), so a calendar click never ends in a 404. Plans are read by athlete membership
  as Training Load does today, unless Q-D narrows it to plan ownership.
- **Views (D12, D13).** Day; Week in two modes — **list** (default: days in columns, items ordered by AM/PM,
  then Before/Training/After, then order, as the weekly plan sorts) and **time grid**; Month with arrows. Groups
  and Types chips with counts; team colours from the automatic palette (D11).
- **Drill-in.** Event → side panel → *Open the activity* (TL activity detail) and athlete → *Weekly plan* on
  that day (`openWeeklyPlanOnDate`, D5). The new tab key and the Back root as in section 3.
- **Frontend.** A new domain `club-calendar-{view,actions,data}.js`, the `view-cache.js` loader with a context
  key of workspace + range + filters and a generation check.
- **K3 (later).** Coach Home's day calendar, TL Activities, TL Schedule / Today / Results (`/weekly`) and the
  Tests week shell become views of the same source once K1's read is stable.

**Reviewers and triggers for K1.** Backend scope work → `code-reviewer` + `security-reviewer`; the new screen
→ `mobile-qa` + `ux-design-reviewer`. External-review trigger **2** (D8: workspace, owner scope,
info-hiding) is hit. Trigger 3 is not: K1 stores no link (it belongs to K2). No migration, so no `db-reviewer`
unless an index is added.

## 8. K2 sketch — events, types, locations, groups, Settings → Calendar (proposal)

Not decided. Tables in a new `calendar` schema, one migration, ★★ (external review; triggers 1 and 2, and 3
for the event ↔ activity link):

- **Owners.** `owner_scope` + owner ids (ADR-002): `club` (D4), `team` for a team coach's events (D6), `user`
  for a private coach (D7).
- `calendar.event_types` — `owner_*`, `key`, `label`, `kind` (one of the D2 kinds; the kind decides what is
  expected, D9), `default_duration_minutes`, `all_day`, `is_match` (adds opponent, home/away, result),
  `icon_key` (the icon library, `frontend/icon-library.js`), `sort_order`, `seed_key`, `archived_at`, audit
  columns.
  - **Seeded defaults (D4, LOW-5).** Seeded **once**: by the migration for existing clubs and when a club is
    created, never on read; `unique (owner_club_id, seed_key)`. A deleted or archived default never comes back.
  - **Delete.** A type with no event is deleted; a type in use is archived (hidden from pickers, kept on old
    events).
- `calendar.locations` — `owner_*, name, address, archived_at` (same archive rule).
- `calendar.events` — `owner_*, event_type_id, title, starts_at, ends_at, all_day, timezone, location_id,
  status (scheduled | cancelled), cancelled_reason, note, opponent, home_away, result, created_by,
  request_key`; targets in `calendar.event_targets (event_id, team_id | athlete_id | group_id)`.
  - **Target invariant (LOW-6).** A target team belongs to the owning club; a target athlete is an active
    member of the owning club (or one of the private coach's own athletes); a team-owned event targets only
    that team or its members (D6); checked by the database, with the same 404 for a foreign id.
- `calendar.event_activity_links` — an event ↔ the canonical activities that recorded it, followed forward on a
  supersede (ADR-001). An event never stores RPE or results (ADR-004).
- **Groups of athletes (D7).** Two options:
  - *Reuse tags.* The existing tags classify **programs and exercises** (`library.program_tag_definitions`,
    owner `system | club | team | user`, `alter_program_tags_scope.sql:9-28`; Settings → *Tags & Presets*,
    `frontend/index.html:154`); none tags athletes. Reusing them means a new athlete ↔ tag table and mixing two
    meanings in one picker.
  - *A new group table* `calendar.athlete_groups (owner_*, name, archived_at)` + `athlete_group_members`, a
    member always one of the owner's athletes (`user_athletes` for a private coach).
  - **Recommendation: the new group table** — one meaning, its own invariant, usable by a club too (e.g.
    "Goalkeepers").
- **Team colours (D11).** A club-chosen colour per team (a column or a settings row); the automatic palette
  until then.
- **The athlete's events (D5).** The athlete sees general events (D5). *Manager default:* events targeted to the
  athlete's teams, groups or to the athlete, with name, time and place only — never roster, attendance or RPE of
  others. *Open:* where the athlete sees them. D5 keeps the Weekly plan unchanged, so *proposal:* a short list
  on the athlete's Home, not a new menu (Q-B).
- **Who edits.** The club admin of the active club workspace for the whole club (D4, D6); the team coach of the
  active team workspace for the own team (D6); the private coach for own athletes (D7). *Proposal, not an owner
  decision:* a platform admin for support.
- **Settings → Calendar.** Event types, Locations, Team colours. No card metrics (D14).
- **Commands (later than the tables).** New event, Copy events, Make trainings from plans.

**Later phase (D10).** Club absence reasons beside the six shared ones (v25 contract unchanged). *Proposal, not
in the owner's answer:* the club may hide a shared one. It touches the roster decisions, so `db-reviewer` and
trigger 1.

## 9. What K0 delivers

- This document (the only file in the pull request).
- A clickable mock with made-up data (one club, U19/U17/U15/U13, about 20 athletes each, one week): Week in
  **list** mode (default, D13) and **time grid**, Month (density per group, D12), Day, Groups and Types chips
  with counts, cards with status and `x/y` (D14), a side panel with drill-in to an event, its activity and an
  athlete, Settings → Calendar (types, locations, team colours, absence reasons), a *View as* switch (club
  admin, U17 coach, an athlete), and a phone layout. A switch previews **K1** (only what OptiMove stores today:
  start times only, no durations, RPE groups) against **K2** (with events). The grouping in K1 is shown as K1
  logic, not as stored data; in K1 a GPEXE team activity is its own card beside the planned training, because
  the GPEXE import creates no session links (in K2 the event links both). Published as a private Artifact
  (<https://claude.ai/artifact/GCq2rA2Eb4vjzruE4L4KQi>); not in the repository.

## 10. Open questions for the owner

- **Q-B (D5).** Confirm the manager's default: an athlete sees only events of the own teams, groups or
  addressed to them (name, time, place), never teammates' data. And where: a short list on the athlete's Home
  (recommended), since the Weekly plan does not change?
- **Q-C (D7).** Groups of athletes: a new group table (recommended) or athlete tags?
- **Q-D.** Should the club calendar show plans that another coach (for example a private coach) made for a club
  athlete? Recommendation: no — only plans owned by the club or its teams; Training Load and Coach Home show
  them today.
