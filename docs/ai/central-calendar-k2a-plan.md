# Central calendar — K2a plan: events (the model, the Builder link, expectations, who writes)

Status: **accepted — the manager decided the eleven technical points of section 9 as recommended (2026-10-30) and
the owner answered the six product points as D18–D23 (section 10); K2a-1a is built in this pull request.** Written
against the checked-out code at `6a94ce2` (merge of PR #294, `main`); no persistent database was touched, the
migration ran only on disposable databases.

- Inputs: `docs/ai/central-calendar-k0-discovery.md` (D1–D14, the K2 sketch in its section 8),
  `docs/ai/central-calendar-k1-plan.md` (the item model, `expects` and `status` as built, the access rules of
  its section 3), `docs/ai/central-calendar-k1b-plan.md` (the screen), the owner's D15, D16 and D17 of
  2026-10-30, ADR-001, ADR-002 and ADR-006, and the v44 record (`docs/ai/phase5a-discovery-and-contract.md`
  section 12).
- Scope of K2a: **events** in the central calendar — a table, the write API, the read extension, the Builder
  link, the first UI. Not in it: Settings → Calendar (K2b), colours, locations, groups, notifications
  (section 8).
- **Migration number.** `main` already holds v46 (`202610301300_training_load_v46_classification_icons.sql`)
  and v47 (`202610301700_training_load_v47_unit_conversion_guards.sql`), so the K2a migration is **v48**,
  named `202610311000_calendar_v48_events.sql` (a new `calendar` schema, the count kept as `training_activity_v1`
  kept its own). Every choice below that touches it is marked ★ (external review, triggers 1 and 2; also 3 and
  4 — see section 7).

## 0. The recommendations at a glance

| # | Question | Recommendation |
|---|---|---|
| 1 | Event model vs the existing schedules | **(a)** a new parent (`calendar.events`) that may *reference* one external schedule and one test schedule; nothing migrated, nothing merged by name |
| 2 | Builder ↔ event (D17) | order **a → b' → c**: attach an existing planned group now; "Make an event" from the Builder as a small later step; "New training from the event" with K3 |
| 3 | Expectations (D15) | the event **declares**; on attach the coach may **align** the linked sessions' RPE flags to the declaration; the roster functions (v44) are **unchanged** in K2a |
| 4 | Who writes | the owner of the active workspace (D4 / D6 / D7); a club admin also manages its teams' events; a DB lock function in the v25 style; `requestKey` on every command, the create included; an append-only change log |
| 5 | The athlete (D5) | the **API** answer in K2a-1 (name, time, place, nothing else); the athlete's screen in K2b (a list on Athlete Home) |
| 6 | Seeded defaults | seven types, one per D2 kind, as a **system** set plus a **copy per club**; expects by kind: training and match `rpe`, test `test_result`, the rest nothing |
| 7 | Slices | K2a-1a schema + events + read; K2a-1b the links; K2a-2 UI; K2b Settings → Calendar |

## 1. The event model

### 1.1 Why a new table, and how it relates to what exists

Two event-like models exist, both with the same owner and target shape:

| | `training_load.external_schedules` | `tests.test_schedules` |
|---|---|---|
| Purpose | collect RPE outside the plan | collect a test result |
| Shape | `schedule_kind` one_time / recurring / dates (v8), IANA `timezone`, `start_date` / `end_date`, an **RPE window** `opens_time` / `due_time` / `closes_time`, `status` active / paused / cancelled, `event_name`, `event_note`, `owner_scope` system / club / team / user with the shape check | the same, minus the name, plus `test_version_id` / `test_battery_version_id` |
| Evidence | `migrations_v2/202609011000_training_load_v4_external_scheduling.sql:69-128`; `event_type` a nullable label in a fixed list (`…v6_external_schedule_event_type.sql:13`) | `migrations_v2/202608240900_tests_v42_phase1_scheduling_execution.sql:24-78` |
| Targets | `(schedule_id, target_kind athlete / team / club, …)`, `unique nulls not distinct` (`v4:160-180`) | the same (`phase1:138-160`) |
| Writes | occurrences and assignments, generated on read by the TL calendar and by the worker (K0 §2.3) | the same, projected in memory by `GET /api/tests/weekly` |

Neither is an event: an external schedule's time is an **RPE window**, not the event's time; a test schedule has
no name, no place, no kind. Both are *collections* an event may want. So the options for the relation:

| Option | What | Cost | Verdict |
|---|---|---|---|
| **(a) a new parent that references them** | `calendar.events.external_schedule_id` and `test_schedule_id`, each nullable, at most one active event per schedule; the read folds the referenced schedule's day card under the event (section 1.4) | one table family, two columns, one fold rule; nothing in TL / Tests changes; the owner's "Match" is one card with its RPE x/y | **recommended** |
| (b) migrate external schedules into events | a new generator reading events, the athlete's Home and the TL Schedule rewritten, v4–v8 occurrences / assignments / notifications re-homed | weeks; trigger 1 on live data | not now; possible later on top of (a) |
| (c) both stay, the read merges | K1 today: a "Match" event and its "Match RPE" schedule are two cards; no relation stored | nothing now; a duplicate for every match with RPE | rejected |

With (a) the event's own `title`, `start_time`, `location` and `status` are what the card shows; the referenced
schedule keeps collecting. **Cancelling an event does not cancel the referenced schedule in K2a** (no
cross-domain write; the panel says so) — choice 9.12.

### 1.2 Tables (★ migration v48, schema `calendar`)

Every text column passes `boundedText()` and `TEXT_FORBIDDEN` (`backend/src/metricTextRules.js:17-39`), with the
database twins v40 already installed (`training_load.source_metric_text_ok`).

**`calendar.event_types`** — the catalog D4 / D9 (K2a seeds it; K2b edits it).

| Column | Rule |
|---|---|
| `owner_scope`, `owner_club_id` | `system` (null club) or `club` (a club); the v4 shape check |
| `kind` | one of D2: `training, match, travel, meeting, day_off, camp, test`; **write-once** (trigger) — the kind decides the default expectations (D9) |
| `key` | `^[a-z][a-z0-9_]{1,40}$`, unique per owner (`nulls not distinct`) |
| `label` | 1–60; unique per owner among non-archived rows (`lower(label)`) |
| `default_expects` | `text[]`, each in `rpe / device_data / test_result`, no duplicates (trigger) |
| `icon_key` | null in K2a (the icon library, `frontend/icon-library.js`, K2b) |
| `sort_order`, `seed_key` | `seed_key` unique per owner; a seeded row carries it, a club-made row (K2b) does not |
| `archived_at`, `archived_by_user_id`, `created_by_user_id` (null for seeds), timestamps | K2b archives a type in use, deletes one without events |
| K2a guard | a trigger refuses every `UPDATE` / `DELETE` (K2b's migration replaces it): the catalog is read-only until Settings → Calendar exists |

**`calendar.events`**

| Column | Rule |
|---|---|
| `owner_scope`, `owner_*_id` | `club`, `team` or `user` with the v4 shape check (`v4:103-108`); **no `system` owner**: a platform admin creates in the club's workspace (choice 9.11) |
| `event_type_id` | not null → `event_types`; trigger: the type's owner is the event's club, or `system` (a team-owned event uses its club's set; a user-owned event the system set) |
| `title` | 1–120 |
| `day`, `end_day` | local dates; `end_day` null or ≥ `day` (a camp, travel, a day off span days; one card per day, choice 9.7) |
| `start_time`, `end_time` | `time`, both optional; `end_time > start_time` when both are set on a one-day event |
| `timezone` | IANA, validated by the v4 trigger pattern (`v4:132-152`); the client sends `Intl.DateTimeFormat().resolvedOptions().timeZone` as the TL form does (`frontend/training-load-actions.js:2024`). Stored for later use (notifications); the read keeps local days as K1a does |
| `location` | text ≤ 120 (a catalog is K2b) |
| `status` | `planned` / `cancelled`; `cancelled_at`, `cancelled_by_user_id`, `cancel_reason` (≤ 500) all null unless cancelled (CHECK) |
| `expects` | `text[]` as `default_expects`, copied from the type at create, editable per event (D15) |
| `notes` | ≤ 2000, coach-internal (never in the athlete's answer) |
| `external_schedule_id` | null → `training_load.external_schedules` (FK, `on delete restrict`); one planned event per schedule (partial unique) |
| `test_schedule_id` | null; a **trigger-checked** reference to `tests.test_schedules` instead of an FK, because the shared disposable fixture (`backend/tests/_gpexe-disposable-db.mjs:26-75`) carries no Tests schema and an FK would stop every suite that applies the whole list; the K1a suite adds the Tests files itself (`central-calendar-k1a.test.mjs:36-51`). Choice 9.13 |
| `revision` | integer, +1 per write (`expectedRevision` on every edit) |
| `created_by_user_id`, timestamps | |
| Indexes | owner columns; `day`; `end_day` |

**`calendar.event_targets`** `(event_id, target_kind athlete / team / club, target_*_id)`, `unique nulls not
distinct` as v4. The invariant (K0 LOW-6), checked by a **trigger whoever writes** and by the service (the
identical answer for a foreign id):

| Owner | Allowed targets |
|---|---|
| club C | the club itself; an active team of C (`public.teams.club_id = C`); an athlete with a membership period in C or in a team of C (`public.athlete_membership_periods`, v25 `:61-79`) |
| team T (D6) | T itself; an athlete with a period in T. Never a club, never another team |
| user U (D7) | athletes in `public.user_athletes` active for U. Never a team or club. Groups are open (K0 Q-C): K2a targets athletes one by one; the UI offers "all my athletes" as a shortcut that expands to athlete rows |

At least one target (the external-schedule rule, `routes/trainingLoad.js:1829`). The trigger checks
*existence* of the membership; the service checks membership **on the event's first day** with
`membershipOnDaySql` (`backend/src/calendarAccess.js:90-104`), the calendar's one rule.

**`calendar.event_session_links`** — the Builder link (section 2): `(event_id, plan_id → plans.plans on delete
cascade, day, am_pm, bta, session_order, logical_session_id_at_link, session_name_at_link, linked_by,
linked_at, ended_at, ended_by)`; one active link per `(plan_id, day, am_pm, bta, session_order)`.

**`calendar.event_activity_links`** `(event_id, activity_id → training.activities on delete restrict,
link_method 'manual' in K2a ('automatic' reserved), linked_by, linked_at, ended_at, ended_by)`; one active link
per activity; trigger: the activity is not `superseded` at link time; the read follows
`training.resolve_canonical_activity_id()` forward (ADR-001). Choice 9.8.

**`calendar.event_requests`** — the request record, the v25 / v36 pattern (`…v25…sql:374-399`,
`…v36…sql:68-93`): `(request_key uuid, request_hash sha256, operation in (create, update, cancel,
attach_sessions, detach_sessions, attach_activity, detach_activity, set_schedule, clear_schedule),
performed_by_user_id, event_id, result jsonb)`, `unique (performed_by_user_id, request_key)`, append-only.

**`calendar.event_changes`** — the audit: `(event_id, kind = the operation, basis in (platform_admin, club_admin,
team_coach, private_coach), performed_by_user_id, performed_at, reason ≤ 500, details jsonb — a flat object of
changed columns and ids, never an athlete name —, request_id → event_requests unique)`, append-only; a trigger
refuses a row without an actor or without its request. The v27 audit shape (`…v27…sql:533-563`).

**`calendar.lock_event_writer(p_user, p_owner_scope, p_owner_id, p_basis)`** — the v25 pattern
(`training.lock_activity_decider`, `…v25…sql:272-302`): the role rows `FOR SHARE`, `42501` otherwise; bases
`platform_admin` (`user_global_roles`), `club_admin` (`user_club_roles` of the owner club, or of the owner
team's club), `team_coach` (`user_team_roles` of the owner team), `private_coach` (`user_global_roles` role
`independent_coach` and `owner_user_id = p_user` — the same fact `authz.isIndependentCoach` reads,
`backend/src/authz.js:88`). Every write transaction calls it first.

Not changed: `training.activity_types` (`…v1_core_tables.sql:39-48`). An event's `kind` is a calendar concept;
when an activity is one day created *from* an event, the mapping is `training → training_session`, `match →
match`, `test → testing_session`, the rest none — documented here, no code in K2a.

### 1.3 Seeded defaults (D4, D9) — section 6.

### 1.4 The read extension — `GET /api/calendar`

- A fifth kind, **`event`**, in `CALENDAR_KINDS` (`backend/src/calendarQuery.js:41`), on by default.
- **Scope**, per workspace, the schedule helpers reused with `calendar.event_targets` as the targets table
  (`calendarScheduleStructuralSql`, `calendarScheduleCandidateSql`, `readScheduleTargetAthletes`,
  `calendarAccess.js:144-214`, `calendarQuery.js:339-364`; they take the id column name as a parameter — today
  `tg.schedule_id` is hard-coded): the workspace's own events (owner, or the scope's club / team as a target)
  on every day; an event reached only through athletes on the days an athlete was a member (the P1 rule of
  PR #281); the athlete workspace its own targets (section 5).
- **Item**: `key: event:<id>:<day>`, `kind: "event"`, `eventKind` (D2), `eventTypeId`, `eventTypeLabel`,
  `title`, `startTime`, `endTime`, `location`, `span: {from, to}` (multi-day), `status`, `cancelled`,
  `expects` (declared), `rpe` / `attendance` / `results` (rolled up from the links, section 2.3), **`gaps`**
  (section 3.2), `teamIds` (the targets' teams ∩ the workspace's teams on the day), `athleteIds` /
  `athleteCount` (the targets expanded on the day, inside the scope), `links: {eventId, planIds,
  logicalSessionIds, activityIds, externalScheduleId, testScheduleId, orphanedSessionLinks}`, **`canManage`**
  (section 4.1 — so K2a-2 shows Edit / Cancel / Attach only where the server would accept them), `notes` only
  for a coach scope with `canManage`.
- **Folding** (D16, D17): a planned group whose sessions are linked to an event folds **under the event card**
  (its `planIds`, `logicalSessionIds`, and its folded RPE activities' `activityIds`); a linked activity folds;
  the referenced external schedule's and test schedule's day cards fold on the event's days. A folded thing is
  never emitted alone (the K1a rule, `calendarQuery.js:639-657`): events are read whenever any other kind is,
  and emitted only when `kinds` holds `event`.
- **Order**: an event sorts by `startTime`, else among the AM / PM items of its day by the K1a rule
  (`sortKey`, `calendarQuery.js:429-435`); an all-day event (no time) first in its day.
- **Status**: `deriveStatus` (`calendarQuery.js:394-425`) unchanged; the event's checks come from its
  channels (section 3.2). `cancelled` wins; an event with `expects: []` is `none`.
- **Statement count** stays independent of the item count: one read of the window's events, one of their
  targets' athletes per (event, day), one of the session links, one of the activity links.

## 2. Builder ↔ event (D17)

### 2.1 The three options and the order

| Option | What | Where it hooks | Verdict |
|---|---|---|---|
| **(a) attach an existing planned group** | from the planned card (`links.planIds`, `slot`, `date` — K1a §2.3) or from the event's panel: one command links every plan session of that day and slot | `POST /api/calendar/events/:id/sessions` (section 4.2); nothing in the Builder changes | **first (K2a-1b + K2a-2)** |
| (b') "Make an event" from the Builder | a button in the Builder's session editor creates the event and links the sessions in one request | the same create route with `sessions` in the body; one Builder action | second, a small frontend step after (a) is in use |
| (b) create an event on every team-training save | `POST /plans` / `submit` (`backend/src/routes/builder.js:422-498, 501`) would create an event per session of every week | six events a week per team, whether the coach wants them or not | rejected as automatic; (b') is its explicit form |
| (c) create the Builder session from the event | "New training" on the event opens the Builder for the targets on that week; the Builder's one-weekly-plan-per-athlete rule (`ensureWeeklySlot`, `builder.js:463-472`) means "add a session to the existing plans of these athletes" when they already have the week | the Builder's week model and a return context | K3, with the Builder's own plan |

### 2.2 The link's identity — choice 9.9

The planned card is a group of Builder siblings on a day and slot (`plannedGroupKey`, `calendarQuery.js:104-107`).
Two keys could identify a linked session:

- **`logical_session_id`**: stable through an edit cycle, but a **batch sync** (`POST /plans/:id/sync-batch`,
  `builder.js:412`) mints new ids on the siblings by design (the v2 header: "sync a batch-assigned plan's edits
  out to its sibling plans … must never inherit", `…v2_logical_session_identity.sql:22-36`) — after one sync a
  20-athlete link would keep one athlete.
- **`(plan_id, day, am_pm, bta, session_order)`** — recommended: the live plan's id survives both the edit cycle
  (the live tree is replaced inside the same plan) and the sync; the slot is what the coach sees. The read
  resolves the current live session of that slot (`WEEKLY_PLAN_SESSION_FILTER_SQL`,
  `backend/src/trainingLoadAccess.js:239-244`); a slot that no longer has a session is an **orphaned link**
  (`links.orphanedSessionLinks`, a panel note in K2a-2), never an error. A plan deletion cascades the link away
  (the audit keeps the attach). `logical_session_id_at_link` and `session_name_at_link` are kept as
  information only.

### 2.3 What the card shows for an event with linked plans

- Title, kind and type from the event; `athletes` = the targets on the day; per athlete `rpe` from the linked
  session of that athlete (`submitted` / `missing` / `not_asked`, the K1a rule with the workspace switch,
  `calendarQuery.js:496-506`, `trainingLoad.js:395-423`), `null` for a target without a linked session.
- `rpe {asked, submitted}` over the linked sessions, athletes counted once; `attendance` from the linked
  imported activities (K1a §2.7, v44 — the activity's roster, read through `training.activity_has_roster()`
  as today, never copied); `results` from the referenced test schedule's day.
- `links.activityIds` = the folded RPE activities of the linked sessions plus the linked activities.
- **The K1 batch card disappears into the event**: it is not emitted; the event carries its facts. Detaching
  makes it a planned card again.
- A linked session of an athlete who is **not** a target (left the team after the attach) stays linked and is
  shown in `athletes` with `targeted: false`; the attach itself refuses a non-target (`409 athlete_not_targeted`).

## 3. Expectations (D15) and the roster

### 3.1 What exists and what the event replaces

K1a derives `expects` from stored facts only (`docs/ai/central-calendar-k1-plan.md` §2.4): a planned group asks
RPE when a session has `rpe_enabled` **and** the workspace switch is on (`plans.plan_sessions.rpe_enabled`,
v3 `:31`; `training_load_enabled`, v14 `:54`; `training_load.planned_rpe_effective_for_plan`, v9 `:52-55`); an
external card always asks RPE; a test card a result; an imported activity *is* its device data; a self-report
activity waits for nothing (v44). The RPE submit route is gated by the same two flags (`trainingLoad.js:395-423`),
so **a session nobody can answer is never "awaiting"** — the one principle K2a must keep.

### 3.2 The rule for an event — choice 9.3

The event **declares** (`expects`); the calendar judges by the **channels** that exist:

| Declared | Channel | Met when | No channel after the day |
|---|---|---|---|
| `rpe` | the linked sessions that ask (flags + switch); the referenced external schedule's assignments | `submitted = asked` | **`gaps: ["rpe"]`** — "RPE expected, but no attached training asks for it"; not awaiting (nobody can answer) |
| `device_data` | a linked activity of origin `api_import` / `source_import` | the activity exists; its roster (where one exists) needs no state | **awaiting** — the import is the coach's own next step (Imports), so the wait is real |
| `test_result` | the referenced test schedule's day | `completed = expected` | `gaps: ["test_result"]` — no test is attached |
| nothing | — | — | `none`; never awaiting (a meeting) |

So `deriveStatus` is unchanged; the event card feeds it `rpe` / `results` / `attendance` from its channels and
the `device_data` check from its links, and carries `gaps` for the declared-but-impossible cases. K2a-2 shows a
gap as a quiet note in the panel, not as a status badge (choice 9.3, option B of the badge).

**Alignment on attach (option A, recommended).** The declaration becomes operative where it can in K2a: the
attach command takes `alignSessions: true | false`. With `true`, for an event that expects `rpe` it sets
`training_load_enabled = true, rpe_enabled = true` on the linked sessions that do not ask yet; for an event
that does not expect `rpe` it sets `rpe_enabled = false` on the ones that do (the v14 CHECK keeps `rpe →
training_load`). The update is the per-session toggle the TL routes already make (`PATCH
/sessions/:id/rpe-enabled`, `trainingLoad.js:527`; `/training-load-enabled`, `:655`), extracted into one
service function both call, under the plan row `FOR SHARE` and only for plans the scope **manages**
(`canManagePlanTrainingLoadInScope`, `trainingLoadAccess.js:204`); a plan the scope only reads (decision 4 of
K1a: a private coach's plan read by the club) is linked but reported `alignment: "not_allowed"` and the gap
stays. The workspace switch is never flipped by the attach; when it is off the answer says `switch_off` and
the gap stays. Option B (informational only: the gap note, no write) costs nothing and leaves D15 without
effect in K2a; option C (the event's declaration overrides the session flags in the calendar) would show
"awaiting" for a session the submit route refuses — rejected.

### 3.3 What does NOT change in Training Load

- The roster functions (`training.activity_has_roster()`, `activity_roster()`, v44 `:76-96, 103`;
  `activity_roster_needs_state()`, v26 `:119-140`), the roster read and commands, the Roster tab.
- The RPE submit routes and their gates; `session_feedback` (ADR-004); the GPEXE import and its team-owned
  activities; the TL calendar and Schedule.
- K1a's derivation for a planned group **without** an event, for external and test cards, and for activity
  cards.

**Later (K2c), on the owner's order:** the roster follows the event — `activity_has_roster()` reads the
activity's event link and its `expects` (an event expecting nothing gives its linked activity no roster; a
training event with 20 RPE results becomes **one** team session, option C of the v44 decision). That is a
migration on the roster functions (triggers 1, 2, 3) and is deliberately not K2a.

## 4. Who may write (D4, D6, D7), concurrency, idempotency, audit

### 4.1 The authorization rule

Routes live in a **separate router** `backend/src/routes/calendarEvents.js` at `/api/calendar/events` (the K1a
router is read-only by contract, `routes/calendar.js:7`, `server.js:125-129`), `requireAuth`, with the
service `backend/src/calendarEventService.js` and the scopes in `backend/src/calendarEventAccess.js`. One
`resolveActiveWorkspace()` per request (`backend/src/workspace.js:110-133`), threaded through, as every TL
access helper does.

| Active workspace | Create | Manage (edit, cancel, attach, detach, schedule reference) | Basis |
|---|---|---|---|
| club C | club-owned, owner C | club-owned by C; **and team-owned by an active team of C** (choice 9.1, the D8 / O2 line: the club is the hierarchy's parent, D4 "for the whole club") | `club_admin` (`holdsClubAdminRole`, `authz.js:118`), or `platform_admin` |
| team T | team-owned, owner T (D6) | team-owned by T only; a club-owned event is read, never edited (the panel offers nothing) | `team_coach` (`holdsTeamCoachRole`, `:122`); a club admin who opened the team workspace (`loadAvailableWorkspaces` lists only teams with a `team_coach` role, `workspace.js:47-60`, so today only a real team coach gets here) |
| private coach | user-owned (D7) | own | `private_coach` |
| platform | **refused**, `403 workspace_required` ("Open the club's workspace to create its events") | all (support) | `platform_admin` |
| athlete, none | `403` | `403` | — |

Row rule `canManageEventInScope(scope, event)`: the external-schedule rule (`canManageExternalScheduleInScope`,
`trainingLoadAccess.js:175-181`) widened for the club branch exactly as `canReadActivityInScope` widens the
club's read (`trainingActivityAccess.js:110-117`): `owner_scope = 'team' and owner_team_club_id = C and the
team active`. Every manage route re-reads the event with a `left join public.teams` and answers the
**identical** `404 {error: "notFound", message: "Not found."}` for a missing id, another owner, an archived team
or club, the wrong workspace (ADR-006). A foreign or non-existent **target id** in a body answers the same
`400 target_not_available` ("One of the chosen targets is not available in this workspace.") — the K1a
convention (a foreign filter id never confirms existence), not the external route's `403 "outside your
access"` (`trainingLoad.js:1841`). The read's `canManage` is computed by the same function.

**An archived owner (manager decision of 2026-10-30, after the independent review of K2a-1a):** the events of an
archived team or club must stay cancellable, so a write on them passes to the **next level up** only — an archived
team of an active club: its club's admin (`club_admin`) or the platform admin, never the team coach; an archived
club (an archived team's club included): the platform admin only. `eventWriteBasis` and
`calendar.lock_event_writer()` both refuse the other bases (so `canManage` and the write verdict agree), the write
is audited on its basis as usual, and nothing can be created for an archived owner: a team workspace of an archived
club lists no types and its create answers the one 404 (an archived team's own workspace is never offered at all).

### 4.2 Routes (every write: `requestKey`, one transaction, stable codes, no SQL text)

| Route | Body | Notes |
|---|---|---|
| `GET /api/calendar/events/types` | — | the types the active workspace may use (the club's set, or `system`), non-archived; for pickers |
| `POST /api/calendar/events` | `requestKey, eventTypeId, title, day, endDay?, startTime?, endTime?, timezone, location?, expects?, notes?, targets[], sessions?` | `expects` defaults to the type's; `sessions` (option b') links in the same transaction |
| `PATCH /api/calendar/events/:id` | `requestKey, expectedRevision, …fields, targets?` | `409 event_changed {current}` on a stale revision (the R2 `variable_changed` and roster `expectedRevision` pattern); a cancelled event is not editable (`409 event_cancelled`) |
| `POST …/:id/cancel` | `requestKey, expectedRevision, reason` | idempotent by key; already cancelled → `409 event_cancelled` with `current` |
| `POST …/:id/sessions` / `DELETE …/:id/sessions` | `requestKey, planIds[], day, slot {amPm, bta, order}, alignSessions` | every plan: published weekly plan, a session in that slot on that day (`409 session_not_found`), the day inside the event's span (`409 day_mismatch`), the athlete a target on that day (`409 athlete_not_targeted`), in the reader's scope (K1a decision 4), not linked to another planned event (`409 session_already_attached`) — all or nothing |
| `POST …/:id/activities` / `DELETE …` | `requestKey, activityId` | the canonical activity, readable in the scope (`activityReadScopeSqlForWorkspace`, `trainingActivityAccess.js:97-105`), same day, not superseded (`409 activity_superseded {canonicalActivityId}`), not linked elsewhere |
| `POST …/:id/schedule` / `DELETE …/:id/schedule` | `requestKey, externalScheduleId?, testScheduleId?` | the schedule manageable in the scope (`canManageExternalScheduleInScope`; Tests: `canManageSchedule`, `backend/src/testsAccess.js:16`), not referenced by another planned event; a test schedule only on a `test` kind event (`409 schedule_kind_mismatch`) |

### 4.3 Transaction and lock order (trigger 4)

```
1. calendar.lock_event_writer(user, owner, basis)      FOR SHARE on the role rows; 42501 → 403 not_allowed / the 404
2. the event row FOR UPDATE                            lock_timeout 15 s (the roster commands' bound) → 409 try_again
3. the requestKey replay (same key + same hash → the saved answer, after 1-2 so the caller is authorized again;
   another body → 409 request_key_reused; a refused request writes no row, so its key stays free)
4. attach only: the plan rows FOR SHARE, ascending by id; the activity row FOR SHARE; the schedule row FOR SHARE
5. checks → writes → the change row → the request row last
6. a bounded COMMIT (the F2 discipline): 15 s, then the request row is looked for on a new connection (5 s);
   200 with verifiedAfterCommitError, or 503 outcome_unknown — never "nothing was saved" after a sent COMMIT
```

Never the team import lock: an attach writes no metric data; a later merge or supersede of a linked activity is
followed forward on read (ADR-001). Never a lock on `plans.plan_sessions` beyond the plan row: the Builder's
delete locks the plan row `FOR UPDATE` (`builder.js:936`), so an attach and a delete of the same plan serialize
there; an edit cycle keeps the plan id, so a link survives it (section 2.2). `55P03` / `40P01` → `409 try_again`.

### 4.4 Audit

Every successful command writes one `event_changes` row (kind, basis, actor, reason, the changed columns' before /
after as ids and scalars) and one `event_requests` row; a refusal writes nothing. Nothing of it is returned to an
athlete. The v35-style transaction-local actor guard is **not** proposed for K2a (choice 9.15): the v25 pattern
(a lock function + append-only triggers + the request record) is what the roster already uses, and the v35
guard's own stated limit (it binds row, actor and right; it does not stop whoever holds the database
credentials) does not change here.

## 5. What the athlete sees (D5) — choice 9.4

- **K2a-1 (API):** in the athlete workspace `GET /api/calendar` lists the events that target the athlete
  directly, or a team or club they were a member of **on that day** (the athlete branch of
  `calendarScheduleCandidateSql`, `calendarAccess.js:186-199`, and the per-day athlete check); the item carries
  **`title, eventKind, eventTypeLabel, date, span, startTime, endTime, location, status (planned / cancelled),
  teamIds`** and nothing else — no `athletes`, no counts, no `notes`, no `links` but `eventId`, no
  `canManage`. Never a teammate's anything. The filters stay ignored as today.
- **The screen is not K2a:** the athlete shell has no central calendar (K1b §1) and D5 keeps the Weekly plan
  unchanged, so where the athlete reads events is K0's open Q-B. Recommendation: a short **"Upcoming events"**
  list on Athlete Home (`backend/src/routes/athleteHome.js:30-60` already reads the athlete's week) in **K2b**,
  reading `GET /api/calendar` for the coming 14 days. Until then an athlete sees no event, and nothing of K2a-1
  depends on it.

## 6. Seeded defaults (D4, D9) — choice 9.2

Seven types, **one per D2 kind**, as a `system` set (used by a private coach and as the parent of every club copy)
and a **copy per existing club** written by the migration; `POST /clubs` (`backend/src/routes/organization.js:1005-1019`)
gains a transaction that seeds the copy for a new club. K0 LOW-5 holds: seeded once, never on read; a copy a club
later deletes or archives (K2b) never comes back (`unique (owner, seed_key)`, the row kept as archived).

| `seed_key` | `kind` | Label | `default_expects` | Why |
|---|---|---|---|---|
| `training` | training | Training | `['rpe']` | the normal case; the workspace switch still gates who is asked |
| `match` | match | Match | `['rpe']` | RPE after a match; `device_data` where GPS is worn is a per-event edit (choice 9.14) |
| `travel` | travel | Travel | `[]` | |
| `meeting` | meeting | Meeting | `[]` | D15's own example |
| `day_off` | day_off | Day off | `[]` | |
| `camp` | camp | Camp | `[]` | a container; its trainings are their own events |
| `test` | test | Test | `['test_result']` | met through a referenced test schedule |

Team coaches pick from their club's copy; a type archived by the club stays on old events and leaves the picker
(K2b). K2b's Settings → Calendar (`frontend/index.html:154`'s `data-organization-section` pattern) edits labels,
icons (`frontend/icon-picker.js`), `default_expects`, order, archive / delete, and adds club types with a chosen
base kind.

## 7. Slices, reviewers, tests

| Slice | Content | Reviewers | External review |
|---|---|---|---|
| **K2a-1a** ★ | migration v48 (every table of 1.2, the seed, the lock function, the guards, the rollback script and a read-only preflight / post-check in `docs/runbooks/calendar-events-v48*.sql`); `GET …/types`; create, edit, cancel; the read extension (`event` cards, the athlete's answer, `canManage`); the fixture list appended (`GPEXE_TEST_MIGRATIONS`, `_gpexe-disposable-db.mjs:75`; every slicing suite uses `indexOf`, none the list's end — verified) | `db-reviewer` + `security-reviewer` + `code-reviewer` | **yes**: triggers 1 (migration), 2 (owner_scope, workspace, info-hiding), 4 (lock order, idempotency) |
| **K2a-1b** | the links: attach / detach sessions with `alignSessions` (the toggle extracted into one shared function), attach / detach an activity, set / clear a schedule reference; the folding; `gaps` | `security-reviewer` + `code-reviewer` (+ `db-reviewer` only if the extracted toggle or a trigger changes) | **yes**: triggers 3 (linking) and 4 |
| **K2a-2** | UI — **first item:** the deployed K1b screen gets a kind label and a chip for `kind: "event"` (LOW-8 of the K2a-1a independent review: the `event` cards this API already serves would otherwise render unlabelled there); then "New event" in the toolbar and on a day; the event card (type label, team stripe, time, location, status, counts, gap note); the panel with Edit / Cancel / Attach a training / Attach an activity / Detach for `canManage`; "Attach to event…" on a planned card's panel; the kind chips: `event` → **Events**, `external` → **RPE requests** (choice 9.10; today `external` is labelled "Events", `frontend/central-calendar-view.js:13`); a lost answer is *Result not confirmed · Check result* with the same `requestKey` (the roster and F3c3 pattern) | `code-reviewer` + `mobile-qa` + `ux-design-reviewer`; browser QA at 1280 / 360 / 375 / 390 px on the K1b harness | no (the server decides; no access change) |
| **K2b** | Settings → Calendar: types CRUD with the archive rule, team colours (D11), locations (a catalog); the athlete's Upcoming events; v49 | `db-reviewer` + `security-reviewer` + `code-reviewer` + UI reviewers | yes (trigger 1) |

**Why two backend slices and one migration:** the reviewers read one schema once; each PR stays reviewable
(the K1a PR took six rounds at about this size). A single migration with the link tables unused until K2a-1b has
the F3c1 precedent (v27's tables before their routes). Choice 9.5.

**Tests, on disposable databases through the real routes** (`node scripts/test-runner.mjs --project backend --kind
disposable --file central-calendar-k2a-events.test.mjs`, the K1a fixture: Tests files + the GPEXE list + v6 / v8,
sorted; v48 sorts last):

1. Migration: apply → objects, the seed exactly (7 system rows, 7 per club), every trigger enabled → rollback →
   the v47 catalog digest identical → re-apply; the rollback refuses once an event exists or a later migration is
   recorded.
2. Create per workspace and basis (club admin, team coach, private coach, platform admin in a club workspace);
   the platform workspace `403 workspace_required`; the athlete `403`; the type's owner rule; `expects` default
   and override; a multi-day event.
3. Targets: every row of 1.2's table, allowed and refused, through the route **and** through a raw insert (the
   trigger alone); a foreign team id and a random id answer the byte-identical `400`.
4. Idempotency: the same key + body replays (one row, no second change row); another body `409
   request_key_reused`; a refused request leaves the key free; `expectedRevision` stale → `409 event_changed`.
5. Info-hiding: edit / cancel / attach on a missing id, another club's event, a team event from another team
   of the same club, an archived team, the wrong workspace → the identical `404` body; a club admin edits its
   team's event (9.1); a team coach does not edit a club event.
6. The read: event cards per workspace; the athlete's answer carries only the listed fields (a JSON-key
   allowlist test) and no teammate; a former member sees no day after leaving; `kinds` with and without `event`;
   a folded group is never emitted alone; `canManage` equals the write routes' verdicts for each caller.
7. Folding and counts: a 3-athlete batch attached (one request, three links), RPE submitted by two through the
   real `POST …/sessions/:id/rpe` → one event card, `rpe {3, 2}`, `awaiting_entry` with a past `today`; detach →
   the planned card is back; a batch sync (`sync-batch`) keeps the links; a plan delete removes its link and the
   card shows `orphanedSessionLinks` for an emptied slot.
8. Expectations: a meeting → `none` after the day; a training event with sessions not asking → `gaps: ["rpe"]`
   and not awaiting; `alignSessions` turns the flags on (and off for a non-RPE event) only on manageable plans,
   `not_allowed` for a plan the scope only reads; the switch off → `switch_off`; `device_data` with no activity →
   awaiting, with a linked GPEXE import (`importGpexePlan`, as the K1a suite) → `attendance` and `done` after the
   decisions.
9. Schedule references: an external schedule and a test schedule referenced → their day cards fold, `rpe` /
   `results` roll up; a second event on the same schedule refused; cancelling the event leaves the schedule
   active (asserted).
10. Concurrency: two attaches of the same slot to two events (one `409 session_already_attached`); an attach
    racing a plan delete (the plan lock); the lost-COMMIT seam (`verifiedAfterCommitError`, `outcome_unknown`).
11. The audit: one change row and one request row per success; none per refusal; the change row refused without
    an actor (raw insert).
12. No write on read: the K1a digest guard (`central-calendar-k1a.test.mjs`, test 14's thirteen tables) extended to
    the `calendar.*` tables; the statement count equal for 1 and 12 events.
13. Mutations on the key guards (scope widened, basis skipped, the target trigger removed, the replay before the
    lock, the athlete's allowlist), each killed.

Frontend (K2a-2): `frontend/tests/central-calendar-events.actions.test.mjs` through the real handlers with the fetch
mock: the forms, `requestKey` reuse on *Check result*, no control for `canManage: false`, the lost-answer states,
the chip words, no `data-tab` attribute (the K1b guard), every control a button, inputs ≥ 16 px.

Also run and record: `central-calendar-k1a.test.mjs`, `training-load-external-scheduling-routes.test.mjs`,
`activity-roster-self-report.test.mjs`, `tests-weekly-calendar.test.mjs`, the backend unit preset; a failure not
mine is reproduced on a clean detached `origin/main` worktree before it is called pre-existing.

## 8. Risks and what K2a deliberately leaves out

**Risks**

- Two sources of truth for a referenced schedule (its `event_name`, `opens_time`, `status` against the event's
  title, time, status): the event's win on the card; the schedule keeps collecting; the panel says "RPE is
  collected by the schedule *X*". A cancel does not cascade (9.12).
- A link survives an edit and a sync but not a slot move: an orphaned link is visible, not silent (2.2).
- The alignment writes into `plans.plan_sessions` from the calendar — a cross-domain write, limited to the two
  flags the TL routes already toggle, through one shared function, only for manageable plans.
- A dual member (two clubs, two teams) sees both sides' events — by membership on the day, the K1a rule the
  owner's external review already weighed; a team coach sees club events but cannot edit them (by design).
- The platform admin must open the club's workspace to create; support edits work from the platform workspace.
- `timezone` is stored and not yet used; the read stays on local days as K1a (`occurred_local_date`,
  `plan_days.date`).
- No notification is sent for an event (the athlete learns of it only on their Home once K2b lands).
- `end_time` on a multi-day event is not interpreted (one card per day, times shown on each).
- Performance is not a concern: events are tens per month; the reads stay bounded.
- The athlete's cards of the **other** kinds (planned, external, test) still carry `teamIds: []`: K1a computes an
  athlete's team ids against the workspace's teams, which an athlete workspace has none of. The event card (K2a-1a,
  round 2) derives them from the event's own teams instead — the athlete's teams on the day among the event's team
  targets and owner team (D21 "teams"). Aligning the other kinds is a K1a follow-up, not a K2a task.

**Open environment item (not a K2a task; the owner's decision):** the local OPTIMOVE database stands at v21
(CURRENT_STATE, since September), so every shared-kind suite has been unclaimable for every change since v22;
`POST /api/organization/clubs` now also depends on v48 (the club's type copies), so `global-roles.test.mjs` (shared)
would fail there until the local database is migrated. Whether to migrate it is the owner's separate decision. The
club route is covered on a disposable database by the suite's tests 14 and 23 (K2a-1a).

**Left out of K2a on purpose** (each a later slice or an owner decision): Settings → Calendar and every type edit
(K2b); team colours (D11), locations catalog, match fields (opponent, home / away, result — K0 §8 `is_match`;
choice 9.16), recurrence and "copy week" / "copy events", groups of a private coach (Q-C), notifications, the
athlete's screen (API only), automatic matching of a GPEXE activity to an event (manual attach only), the roster
following the event's expectation (K2c, 3.3), the Builder-side "Make an event" (b') and "New training from the
event" (c), migrating external schedules (1.1 b), cancelling a referenced schedule from the event, any change to
`training.activity_types`, to the RPE submit gates, or to K1a's derivation for cards without an event, K3's
re-homing of the other calendars.

## 9. Open points for the owner (not decidable from D1–D17), each with a recommendation

1. **Does a club admin edit and cancel a team-owned event?** Recommended **yes** (the club is the parent, D4
   "for the whole club", the O2 / D8 line); the alternative is owner-only (a team coach's event is the team's).
2. **Default `expects` per kind** — the table of section 6; the owner may want training `[]` (RPE only where a
   coach turns it on) or match `['device_data']`.
3. **Alignment on attach** — option A (the coach may align the sessions' RPE flags to the event, recommended) or B
   (informational gap only). And the gap as a panel note (recommended) or as a status badge.
4. **Where the athlete sees events** — API in K2a-1 (recommended), the screen as an *Upcoming events* list on
   Athlete Home in K2b; or inside the Weekly plan (D5 says it does not change, so not recommended).
5. **One migration v48 with every table** (recommended) or two (v48 events, v49 links).
6. **Schema name `calendar`** (recommended; K0 §8) or `training`.
7. **Multi-day events in K2a** (`end_day`; recommended for camp / travel / day off) or one-day only.
8. **Activity links in K2a** (recommended: the table in v48, manual attach in K2a-1b, so `device_data` can be met)
   or K2c (then `device_data` is dormant in K2a).
9. **The session link's identity** — the slot key (recommended, survives edit and sync) or `logical_session_id`
   (breaks on a batch sync).
10. **The chip words** once real events exist: `event` → "Events", `external` → "RPE requests" (recommended;
    alternatives "Outside-plan sessions", "RPE schedules").
11. **No system-owned events**: the platform admin creates in the club's workspace (recommended) — or allow
    `owner_scope = 'system'` events visible to everyone (not recommended: no scope reads them today).
12. **Cancel semantics**: an event's cancel never cancels its referenced schedule (recommended); or cascade.
13. **The test-schedule reference**: a trigger-checked reference in K2a (recommended, the fixture reason of 1.2)
    or defer it to K2b.
14. **Match default**: `['rpe']` (recommended) or `['rpe', 'device_data']` where GPS is standard.
15. **Audit model**: the v25 pattern (lock function + append-only + request record; recommended) or v35-style
    actor guards from day one.
16. **Match fields** (opponent, home / away, result): K2b with the type's `is_match` (recommended) or in K2a on
    every event of kind `match`.
17. **The private coach's targets** — athletes one by one with an "all my athletes" shortcut (recommended) until
    Q-C decides groups.

Related decisions already recorded and relied on here: D16 (grouping by batch only), K1a decision 4 (plans by
membership on the day, with the fallback) and its dual-member consequence, the read / write asymmetry of D8
(K1a decision 7 — K2a adds the first writes beside the roster commands and keeps the activity write routes as
they are), v44 (a self-report activity has no roster — unchanged by K2a).

## 10. Decisions (2026-10-30)

**The manager's technical decisions, all as recommended:** 9.5 one migration v48 with every table; 9.6 schema
`calendar`; 9.8 the activity link table in v48, manual attach in K2a-1b; 9.9 the session link by slot key; 9.10 the
chip words *Events* and *RPE requests*; 9.11 no system-owned events (the platform admin creates in the club's
workspace); 9.12 an event's cancel never cancels its referenced schedule; 9.13 the trigger-checked test-schedule
reference; 9.15 the v25 audit pattern; 9.17 the private coach targets athletes one by one with an "all my athletes"
shortcut. Also: v44 untouched in K2a (roster-follows-event = K2c); the K1 batch card folds under its event exactly as
section 2 describes.

**The owner's product decisions (through the manager):**

| | Decision |
|---|---|
| **D18** (9.1) | Yes — the club admin edits and cancels team-owned events too. |
| **D19** (9.2, 9.14) | The default expectations are **defined on the event type** in Settings → Calendar (K2b) as ticked checkboxes; when a coach creates or edits an event the type's defaults come pre-ticked and the coach may untick or tick any of them — the set is `rpe`, `device_data` (GPS), `test_result` (a wellness check-in is a test). In K2a, before K2b exists, the seeded types carry the defaults (training `rpe`, match `rpe`, test `test_result`, the rest none) and the create / edit payload carries the per-event `expects` exactly as chosen; the type's defaults become editable in K2b. |
| **D20** (9.3) | Option A — the coach may align the attached sessions' RPE flags to the event (K2a-1b); until then a panel note, never an alarm. |
| **D21** (9.4) | The athlete sees their teams' events (name, kind, date, time, place, status, teams — nothing else) through the API in K2a-1; the screen is an *Upcoming events* list on Athlete Home in K2b; the weekly plan is untouched. |
| **D22** (9.7) | Multi-day events in K2a (`end_day`). |
| **D23** (9.16) | Match fields (opponent, home / away, result) in K2b with the type's `is_match`. |

**K2a-1a as ordered:** migration v48 (every table of 1.2, the seed, `lock_event_writer`), the write routes create /
edit / cancel with `requestKey`, the lock order of 4.3, the identical 404, the audit; the read: events as `kind:
"event"` items of `GET /api/calendar` with `expects` / `status`, the athlete's own view (D21), the fold of a
referenced external / test schedule card under its event — so create and edit take `externalScheduleId` /
`testScheduleId` directly, and the separate set / clear routes of 4.2 are not needed. Reviewers `db-reviewer` +
`security-reviewer` + `code-reviewer`; then the pull request, not merged before the independent review and the
owner's external review (triggers 1, 2, 4).

**As built after the internal reviews (2026-10-30; the three reviews found 1 HIGH, 7 MEDIUM and 9 LOW, all applied):**
- `GET /api/calendar/events/:id` gives a reader who may not manage the event a **reduced view**: the calendar card's
  facts and only the targets inside the reader's own scope (the athletes they may see on the event's days, by the
  calendar's one membership rule; the team / club targets of their structural scope) — never the owner's ids, the
  referenced schedules, the links, the notes or a foreign athlete's name (the HIGH of both reviews).
- The `requestKey` hash binds the body to the event (edit, cancel) or to the owner (create): a key reused on another
  event or in another workspace is `409 request_key_reused`, never another resource's answer. The stored result holds
  ids only; a replay, and the verification after an unconfirmed COMMIT, re-read the event as the caller may see it now
  (no name or note in an append-only table). A same-key race (a double submit, a retry during an in-flight COMMIT)
  ends in the saved answer, never a 500.
- The referenced test schedule is authorized by the **active workspace** (the external schedules' own rule over the
  shared owner columns), not account-wide.
- The database requires the audit pair in both directions (a write of an event needs its change row at that revision
  at COMMIT; a request needs its change); validates a type, a time zone or a test-schedule reference when it is set or
  changed, never again on a later write (a deleted test schedule or a moved team never makes an event uncancellable);
  locks the owner team, then its club (both active), then the role row, then the user (the v25 / v26 order), and lets
  the platform admin write a private coach's event (support, section 4.1); keeps a cancelled event's targets final;
  caps a span at a year; and requires the `coach` relationship for a private coach's target. Every rule is hit raw by
  the suite, not only through the routes.
- A cancelled event folds nothing (the referenced schedule stays its own card, 9.12), and the athlete workspace folds
  nothing either: the athlete's own RPE request stays visible beside the reduced event card (a K2a-1a choice;
  whether K2b's Upcoming events list shows them as one is K2b's).
- A club's type copies go with the club (`on delete cascade`): a hard delete of a club — the application only
  archives, but the shared test suites' cleanup deletes — is stopped only by events or a type in use. A system type
  row is never deleted (a trigger), being the parent of every club copy and the private coach's only set.
- The narrow re-reviews (READY / READY WITH NON-BLOCKING NOTES; one MEDIUM, the system rows above, and LOWs, all
  applied): the service mirrors the database's span and time checks as 400s; a reader who may not manage an event
  gets no type or schedule id on the calendar card either; `canManage` is false for a team-owned event whose club is
  archived, as the lock refuses it; a failed lookup in the same-key race says *try again*, never that the key is
  another's; the rollback locks the tables in the writers' order after the migrator's lock and the record check; the
  preflight and post-check blocks run in the suite against their expected values.
- **The independent review of PR #298 (`6800176`; READY WITH NON-BLOCKING NOTES — 1 MEDIUM, 9 LOW, 1 nit), all
  applied in one round:** the athlete's event card carries the athlete's own teams among the event's teams (D21;
  the other kinds are the follow-up in section 8); an archived owner's events pass to the next level up (section
  4.1); the reduced view carries no type id (the card's contract); a referenced schedule must belong to the event's
  owner or its club whoever writes, the platform admin included; only a reference that changed is validated again
  (a dangling one never blocks a write); the time zone is the database's check alone, its refusal mapped to
  `400 invalid_timezone`; a team workspace of an archived club lists no types and creates nothing (the one 404);
  the router's 404 is `no-store`; two test gaps closed (a right lost between the check and the lock → the 404
  body; one account's key reused across its club and team workspaces → `409 request_key_reused`); K2a-2's first
  item recorded in section 7.
- **Environment:** the shared-kind suites were not run (the local OPTIMOVE database is at v21, pre-existing); the
  open item is recorded in section 8.
