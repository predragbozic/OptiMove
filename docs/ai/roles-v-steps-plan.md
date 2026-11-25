# Roles: the V steps (view rights per module) – discovery and plan

Status: **Accepted** (the manager, 2026-11-24: the order, P-3 and the executor's choices of section 6; the owner, 2026-11-24:
P-1 and P-2 as recommended, section 7). Docs only. Base: `main` `2ea5213e`. Author: the executor of the Settings and roles
stream, on the manager's order of 2026-11-24 (the owner's GO for the V steps).

Builds on `docs/ai/roles-r4-contract.md` (section 4.1 the VIEW package, section 6 the six workspace-trusting modules,
section 13 the V-1 … V-n row, section 14 the tests), its as-built sections 16–18, and R4-4
(`docs/ai/roles-r4-4-screens-contract.md`). What a V step is, in one line: a holder of a module's view word, in a
`club_view` / `team_view` workspace, **reads** that module for its club or team; nothing else changes for anyone else,
except that every route of the module also asks for the view word (R4 section 6, decided).

## 1. What is true today (the facts the plan builds on)

- **A view workspace reaches one module.** `organizationEntry.js` lets a view workspace through to `GET /api/organization`
  only; `/me` offers only `org.view` there (`permissions.js:342-345`, `VIEW_WORKSPACE_USABLE_WORDS`). The R4-2 sweep
  (`backend/tests/roles-r4-2-view-workspace.test.mjs` test 11) proves that an account holding every view word gets from
  23 module reads exactly what an account with no role gets, and that no write of 5 lands.
- **Four ways the modules decide today**, and what each does with a view workspace:

  | Way | Where | A view workspace gets |
  |---|---|---|
  | `requireCoach` on the router (any old role row anywhere; **not** the active workspace) | `server.js:142-152` (`/api/exercises`, `/api/exercise-collections`, `/api/builder`, `/api/taxonomy`), `auth.js:158` | 403; a **mixed** account (an old row elsewhere) passes |
  | `requireCoachWorkspace` (the same capability, in the route) | `routes/tests.js:146`, `routes/trainingLoad.js:67` | 403; a mixed account passes |
  | The active workspace as the right (R4 section 6) | `calendarAccess.js:41-51`, `trainingActivityAccess.js:20-27`, `trainingLoadAccess.js:25-86`, `trainingLoadMetricsAccess.js:28-56`, `trainingLoadDashboardAccess.js:46-64`, `sessionTypeService.js:43-55` | `{type:null}` → 403 / 404 (fail closed) |
  | Old role rows only | `gpexeImportAccess.js:19-42`, `sourceMetricAccess.js:93-110`, `activityRoster.js:78-84`, `calendarEventAccess.js:76-101`, `calendarSettingsService.js:51-63`, taxonomy `:234-394`, metrics catalog `trainingLoadMetricsAccess.js:116-135` | 404 / 403 / only system rows |

- **Per user, not per club:** Messages (`routes/messages.js`, participants only) and Notifications
  (`routes/notifications.js`, `recipient_user_id`) already work in a view workspace and need no V step.
- **No club or team scope exists** for the Exercise library (system, own and collection grants: `exerciseAccess.js:11-48`),
  the Program Library (`templates.js:140`: admin, own or public) or Builder drafts (own `created_by_user_id`,
  `builder.js:220`). A club role holder has nothing club-shaped to "view" there yet (owner question P-2).
- **Hazards found** (each V step must handle its own):
  1. **Reads that write.**
     - `resolveActiveWorkspace` writes the fallback preference (`workspace.js:180-199`); every read that calls it can
       write. The view path must use `resolveActiveWorkspaceReadOnly`.
     - Tests `GET /today` materializes occurrences (`routes/tests.js:1645`).
     - Training Load `GET /weekly` and `GET /calendar` call `ensureCurrentExternalOccurrencesForCoach`
       (`routes/trainingLoad.js:1175`, `:1588`).
     - Messages `GET /:conversationId` writes `last_read_at` (per user; not a V route).
  2. **A secret in a read:** Tests `GET /schedules/:id` returns the active link's `publicToken`
     (`routes/tests.js:1192-1213`).
  3. **Owner fallbacks that stamp `user`:**
     - `ownerContextFromWorkspace` and its copies (`trainingActivityAccess.js:33`, `trainingLoadAccess.js:49`,
       `trainingLoadMetricsAccess.js:41`) and `resolveScheduleOwnerContext` (`testsAccess.js:32-41`) give owner `user`
       for an unknown type.
     - They are safe today only because the scope is null first. A V step that maps a view type to a scope must never
       let a write reach them.
  4. **Write helpers trust the workspace with no role check:** `canManageActivityInScope`
     (`trainingActivityAccess.js:51-57`) and `canManageMetricEventInScope` compare the row's owner with the workspace. If
     a view workspace's data context ever reached them, a view holder could write.
  5. **Old role rows ANDed into reads:** `athleteRosterScope.js:5-22` is the role predicate **and** the workspace, so a
     view branch alone still answers an empty list. The taxonomy and metrics-catalog reads are role SQL across **all** the
     caller's clubs, not narrowed to the workspace.
  6. **Non-standard 404 bodies:** Tests answers `{error:"Schedule not found."}` and `{error:"Result not found."}`
     (`routes/tests.js:1189`, `:1858`). They are fine as they are, but a V step must keep "another club's id" and "no such
     id" identical.

## 2. Per module

Size: S under a day, M one to two days, L three or more (each with its tests and reviews). **Risk class** for every V
step: **risky**, trigger 2 (access and info hiding), so internal security and code review plus the *Nezavisni revizor*.
**Migration:** none in any V step. The VIEW package is already storable (v92); `ENFORCED_PERMISSIONS` is a code
constant.

### 2.1 Data configuration – `variables.view`

1. **Today:** `resolveVariableEditor` (`canonicalVariableAdminService.js:1097-1125`) → `resolveMappingAdmin`
   (`sourceMetricAccess.js:93-110`, a platform admin or `holdsClubAdminRole` in a club workspace), or, in a team
   workspace, a live `team_coach` row (C99, reduced view `view:"coach"`). Everyone else gets the identical 404.
2. **Word:** `variables.view` covers it. Nothing is missing.
3. **A view holder sees:** `GET /variables` and `GET /variables/:id` in the reduced C99 shape: the system variables and
   the club's variables, with names, units and categories. Hidden: mappings, fields, sources, the admin actions and every
   write. No athlete data exists here.
   - Also behind this word: the club variable **names** in activity results (`routes/trainingActivity.js:172-180`) and in
     the GPEXE preview (`gpexeImport.js:36-46`). The GPEXE preview stays closed (Imports has no view word). The
     activity-results names follow when Training Load opens.
4. **Risk** risky; **size S**; no migration.
5. **Tests:** the sweep row; the reduced shape is identical to C99's coach view; another club's variable gives the
   identical 404; the admin reads (`/fields`, `/mappings`) stay 404.

### 2.2 Tags, presets and session types – `presets.use`

1. **Today:**
   - Taxonomy: `requireCoach`, then role SQL across all the caller's clubs (`taxonomy.js:234-325`); writes through
     `canManagePreset` / `resolveOwnerScope` (`:346-394`).
   - Session types: `workspaceClub` (`sessionTypeService.js:43-55`, workspace); writes through `writableOwner` (`:62-68`,
     `club_admin`) and the database's `training.session_type_basis`.
2. **Word:** `presets.use` covers tags and presets. Session types have no word of their own. **Decided (executor):** they
   go with `presets.use` (same Settings tab, "Tags & Presets", `organization-view.js:163`). The same word also opens them
   inside Training Load later.
3. **A view holder sees** (read only): `GET /api/taxonomy/node-presets`, `/template-tags`, `/library/:kind` for the system
   and **this club** (and its teams) only – not every club the account touches; and `GET /api/training-activity/session-types`
   for the club. Hidden: every write; other clubs' rows.
4. **Risk** risky; **size S–M** (the taxonomy read needs a scope argument instead of "every role row"); no migration.
5. **Tests:** the sweep row; a mixed account in `club_view` B sees B's presets only; another club's preset id gives the
   identical 404 / 403 today's route answers; old-vs-new for a coach: unchanged lists.

### 2.3 Athletes – `athletes.view`

1. **Today**, five gate families:
   - **A.** `athleteAccessPredicate` (`access.js:208-246`, old rows and the athlete's own login): `canAccessAthlete`,
     `athleteListAccessFilter`, `canAccessPlan`, the Builder, the templates, `tests.js:886`, `linkedSessionTimes.js:23`.
   - **B.** `athleteRosterScope` (A **and** the workspace).
   - **C.** The workspace mappers of the modules (`isAthleteInWorkspaceScope`, `calendarAthleteScopeSql`, …).
   - **D.** The organization athlete read (`organization.js:425-447`, empty for a view workspace in R4-2).
   - **E.** Other membership readers (GPEXE, invites).
2. **Word:** `athletes.view` covers the athlete list, profile and the organization athletes. R4 section 4: it is checked
   only when **every** gate of A, B and D moves at once.
3. **A view holder sees:** `GET /api/athletes` (the club's or team's athletes, on the membership of the day),
   `GET /api/athletes/:id` (profile), the athletes of `GET /api/organization` for its club, and `GET /api/positions`
   (reads). Hidden: `/:id/plans` and `/:id/program-data` (those are `programs.view`), every write (`POST /athletes`,
   logins, join links), other clubs' athletes (identical 403 / 404 as today).
4. **Risk** risky (personal data); **size L** (A–D move together); no migration.
5. **Tests:** the sweep row; old-vs-new for every account kind on every A–D gate; `enforced_word_covers_all_gates`; a
   coach whose club version removes `athletes.view` loses the list **and** the writes (R4 section 6, decided); a minor's
   data appears only in its own club.

### 2.4 Calendar – `calendar.view`

1. **Today:**
   - Reads: `resolveCalendarContext` → `activityScopeForWorkspace` (`calendarAccess.js:41-51`, `{type:null}` for a view
     type), the scope SQL (`:129-240`) and `calendarQuery.js`.
   - Event writes: `eventWriteBasis` (`calendarEventAccess.js:76-101`, workspace and old rows).
   - Settings: `settingsClub` (`calendarSettingsService.js:51-63`, `club_admin`).
2. **Word:** `calendar.view` covers the reads; `calendar.events.manage` and `calendar.settings.manage` are MANAGE. Nothing
   is missing.
3. **A view holder sees:**
   - `GET /api/calendar` (sessions, activities, external and test days, events; counts on the cards);
   - `GET /api/calendar/events/:id` in the **reduced** view the code already has for a non-manager
     (`calendarEventService.js:642-652`);
   - `GET /api/calendar/events/types` (the club's types).

   Hidden:
   - `notes` and `details` (only with `canManage`, as today);
   - event questions (`/events/:id/questions`: managers only);
   - settings, every write, other clubs.

   Athlete **names** (`?include=athletes`, the reduced view's target list) depend on P-1.
4. **Risk** risky; **size M** (17 reviewed branches in `calendarAccess.js`, 11 in `calendarQuery.js`); no migration.
   Stream manager: the Calendar stream (R4 section 13).
5. **Tests:** the sweep row; a forged `club` preference; the reduced event view is byte-identical to today's non-manager
   view; `include=athletes` per P-1; every event write (create, update, cancel, sessions, activities, fields, questions)
   answers today's refusal; another club's event id gives the identical 404.

### 2.5 Tests – `tests.view`, `tests.results.view`

1. **Today:** `requireCoachWorkspace` (`routes/tests.js:146`, old rows anywhere), then
   `manageableClubIds` / `manageableTeamIds` across **all** the account's clubs (`testsAccess.js:47-56`) and
   `canManageSchedule` per row.
2. **Words:** `tests.view` covers the schedule (the library, the schedules list, the weekly counts, a schedule's detail).
   `tests.results.view` covers results and the per-athlete group and today views. Nothing is missing.
3. **A view holder sees:**
   - With `tests.view`: `GET /library`, `/schedules`, `/weekly`, `/schedules/:id` **without `publicToken`** and without
     the link block.
   - With `tests.results.view` as well: `/schedules/:id/group`, `/results`, `/results/:assessmentId`.
   - `GET /today` only in a **read-only variant** (no `ensureCurrentOccurrence`; the occurrence of the day is computed,
     not written), or not at all in V (**decided (executor): not at all in V**; it is a coach's working screen and writes).

   Hidden: every write (create, bulk, patch, delete, link, revoke, remind), the link token, other clubs.
4. **Risk** risky (a secret, and per-athlete wellness and injury data); **size M**; no migration.
5. **Tests:** the sweep row; `publicToken` never in any view answer (a grep of every response); results only with
   `tests.results.view`; `GET /today` answers today's refusal to a view holder; the schedule owner fallback
   (`resolveScheduleOwnerContext`) is never reached by a view workspace (mutation).

### 2.6 Training Load – `load.view.team`, `load.view.athlete`

Four parts (R4 section 6): activities and roster, weekly / RPE / external schedules, measurements, session types (2.2).

1. **Today:**
   - Activities: the workspace (`trainingActivityAccess.js:20-27`, `:97-117`); writes `canManageActivityInScope`
     (workspace only).
   - Roster: old rows (`activityRoster.js:78-84`).
   - Weekly / calendar: `requireCoachWorkspace` plus `coachWorkspaceScopeSqlForWorkspace` (`routes/trainingLoad.js:1012-1034`).
   - Schedules: `resolveExternalScheduleWorkspaceScope`.
   - Measurements: the workspace (`trainingLoadMetricsAccess.js:28-56`); the catalog by old rows (`:116-135`).
2. **Words:** `load.view.team` covers team totals; `load.view.athlete` covers named athletes. Nothing is missing.
3. **A view holder sees** – the split the code allows, read by read:

   | Read | Team totals (`load.view.team`) | Named athletes (`load.view.athlete`) |
   |---|---|---|
   | `GET /training-load/calendar` | the activity items' counts (`participantCount`, `rpe.requested/rated`, `metrics.total/withData`) | planned and external items with `athleteName` |
   | `GET /training-load/weekly` | – (every row is an athlete) | the whole answer |
   | `GET /external-schedules`, `/:id` | the list with `target_count`; occurrences with counts | the targets with names |
   | `GET /training-activity`, `/:id` | – (one row per participant) | the whole answer |
   | `GET /:id/roster` | `counts` only | the rows |
   | `GET /metrics/results`, `/occasions/:id` | – | the whole answer |
   | `GET /metrics/definitions` and the catalog | the club's and system rows (a scope argument instead of the role SQL) | same |

   Hidden: every write, including PATCH RPE settings, schedule actions, roster decisions, estimates, manual values, match
   / merge / reparent / materialize and metric events; the occurrence writes inside `/weekly` and `/calendar` (skipped for
   a view workspace); other clubs.
   - **Decided (executor):** a read that is athlete-only in the table answers today's refusal to a holder of
     `load.view.team` alone. No new "totals" endpoint is built in V.
4. **Risk** risky; **size L** (24 + 17 + 15 + 13 reviewed branches, two write helpers that trust the workspace); no
   migration. Stream manager: the *Rukovodilac* of OptiMove.
5. **Tests:**
   - the sweep rows per read, with each word;
   - the write helpers `canManageActivityInScope` / `canManageMetricEventInScope` and every `ownerContextFromWorkspace`
     copy are never reached with a view workspace (mutation: map the view type to the base in each, and a test must
     fail);
   - no occurrence row is written by a view read;
   - old-vs-new for coaches and club admins on every read and write.

### 2.7 Dashboards – `dashboards.view`

1. **Today (ADR-002, two checks):**
   - The data workspace: `dataWorkspaceFromActiveWorkspace` (`trainingLoadDashboardAccess.js:46-64`).
   - The owner: `canManageDashboardRow` (`:216-222`, old rows).
   - `canViewDashboardRow` (`:252-257`); the list `dashboardVisibilitySql` (`:319-362`).
   - The query layer throws on an unknown data workspace type (`trainingLoadDashboardQuery.js:45-51`).
2. **Word:** `dashboards.view`. The data it charts is Training Load's: an `athlete`-grouped widget needs
   `load.view.athlete`.
3. **A view holder sees:**
   - `GET /dashboards`: the system templates and the club's dashboards whose data workspace is its club or team;
   - `GET /dashboards/:id`;
   - `POST /:id/query` (a read) over its club's data;
   - `GET /active`.

   Hidden:
   - every write; `POST`/`DELETE /active` (a write of a personal selection: **decided (executor), closed in V**);
   - private dashboards of others; the preview (a manage gate).

   **Decided (executor):** without `load.view.athlete`, a widget grouped by athlete answers a fixed "needs Named athletes"
   result, never the rows.
4. **Risk** risky; **size M**; no migration. **After** Training Load (it reads the same data).
5. **Tests:** the sweep row; the data workspace stays the club's (ADR-002: the view holder's query never reads another
   workspace); athlete grouping with and without `load.view.athlete`; another club's dashboard gives the identical 404.

### 2.8 Programs, exercises (and the Program Library) – `programs.view`, `exercises.use`

1. **Today:** `requireCoach` on `/api/builder`, `/api/exercises`, `/api/exercise-collections`. Plans by creator or
   athlete access (`canAccessPlan`, `access.js:69-173`). The Program Library by owner or public. Exercises by system, own
   or collection grant. **No club scope.**
2. **Words:** `programs.view` and `exercises.use` exist, but what they mean for a club is not decided (P-2).
3. **A view holder sees:** per P-2. The recommendation:
   - `programs.view`: the weekly plans and programs **assigned to the club's athletes** (`GET /api/plans/:id/weekly`,
     `/program`, the athlete's plans) and the public Program Library, read only;
   - `exercises.use`: the system exercise library, read only.

   Hidden: drafts, every Builder route (42 routes, 36 writes), favorites / hide / personal tags (per-user writes), every
   other coach's private items.
4. **Risk** risky; **size L** (a new scope for plans); no migration. Stream manager: the Exercise stream. **Last**, and
   only after P-2.
5. **Tests:** the sweep rows; a mixed account; a draft of another coach never shown; `requireCoach` still answers 403 for
   every Builder write.

### 2.9 Imports, Messages, Notifications, Settings

- **Imports:** no view word (R4 Q16). It stays closed (404) for a view workspace and gets no V step. The sweep keeps
  asserting it.
- **Messages and Notifications:** per user. They already work and need no V step.
  - **Decided (executor):** once a module opens, the frontend lets that module's notification links through in a view
    workspace (today `notInViewWorkspace` sends every module link Home, `app.js:2531-2542`); each V step adds its own.
- **Settings:** Organization is done (R4-2, R4-4). The Settings sections follow their module:
  - *Tags & Presets* opens with 2.2.
  - *Athletes* and *Positions* with 2.3.
  - *Calendar* settings stays closed (MANAGE).
  - *Storage* stays platform-only; *Icons* is static.

## 3. One shared helper: every module asks the same question

New `backend/src/moduleView.js` (one file, pure plus one read-only workspace resolve):

```js
// The view word of each module (R4 4.1); a module enters here in its V pull request.
export const MODULE_VIEW_WORDS = { data_configuration: ["variables.view"], presets: ["presets.use"],
  athletes: ["athletes.view"], calendar: ["calendar.view"], tests: ["tests.view"], tests_results: ["tests.results.view"],
  load_team: ["load.view.team"], load_athlete: ["load.view.athlete"], dashboards: ["dashboards.view"], ... };

// canView(authz, workspace, module) -> boolean
//   platform workspace + platform admin -> true; private_coach -> true (R4 Q10: unchanged);
//   club / team / club_view / team_view -> can(authz, word, scope of the workspace) (the ceiling is inside can());
//   anything else -> false.
// viewReadScope(workspace) -> { type: "club" | "team", id } for club_view / team_view, else null.
// viewEntryGate(module, READ_ROUTES) -> express middleware, the generalization of organizationEntry.js:
//   an account whose active workspace (read-only resolve, never a preference write) is NOT a view one goes on exactly as
//   today; a view workspace reaches ONLY the listed GET routes of the module and only with canView(); everything else
//   answers what that router answers today to an account with no role (403 or the identical 404).
```

How a module uses it:

- **The entry gate first.** Every write route stays closed to a view workspace by construction, the way
  `organizationEntry.js` closes `POST /athletes`. This is the answer to hazards 3 and 4: a view workspace never reaches a
  write helper or an owner fallback.
- **On a listed read,** the route takes `viewReadScope(workspace)` as its **data context** (ADR-002: the workspace stays
  the data context) and maps it where it maps `club` / `team` today. This is the only new branch in each scope helper,
  and it is used by reads only.
- **For every workspace** (coach workspaces included), each route of the module also requires `canView()` (R4 section 6,
  decided). Old-vs-new: a basic Club admin or Team coach holds every seeded view word, so nobody loses anything until a
  club version takes a word away.
- **Registration:**
  - `ENFORCED_PERMISSIONS` gets the word with its gate files (`roles-r4-checked-gates` A1, A2);
  - `VIEW_WORKSPACE_USABLE_WORDS` gets the word (so `/me` offers it);
  - `VIEW_TYPE_FILES` (B3) and the `REVIEWED` counts (B1) get the module's files;
  - `permission-nav.js` gets the tab.

Why a gate and not only `canView()` inside each helper: the six helpers of R4 section 6 already have 100+ reviewed
branches; one gate per router makes "a view workspace never writes" true by one list per module, provable by one sweep.

## 4. The fail-closed sweep, extended per module

New `backend/tests/roles-v-sweep.test.mjs` (disposable database, the real server), built in V-0 and extended by every V
step. Each module adds one table row: `{ module, words, reads: [paths], writes: [[method, path, body]], hidden: [paths] }`.

1. **Without the word** (holder of every other view word): every read and write answers exactly what an account with no
   role gets (status and body). This is R4-2 test 11, kept.
2. **With the word**: every listed read answers 200 with rows of club A only (no id of club B in the text); every `hidden`
   path and every write answers today's refusal; no row is written in any table the module owns (a row count before and
   after); no `user_workspace_preferences` write.
3. **A forged `club` preference** resolves to `club_view` and gives the same answers.
4. **A mixed account** (club admin of A, holder in B) in `club_view` B gets nothing of A from any read.
5. **The ceiling:** the module closed for club A answers like "without the word".
6. **Old-vs-new:** a basic Club admin and Team coach get byte-identical answers before and after the V step on every read
   and write of the module (a golden capture from `main`).
7. **The word taken from a coach** (a club version without it): the module's reads **and writes** answer the refusal
   (R4 section 6).
8. **Mutations**, each failing a test:
   - drop `canView()` from the gate;
   - add a write to the module's `READ_ROUTES`;
   - map a view type to its base type in any write helper or owner fallback of the module;
   - use `resolveActiveWorkspace` (the writing one) in the gate;
   - drop the `publicToken` strip (Tests);
   - drop the athlete-grouping check (Dashboards).
9. **Info hiding:** another club's id on every `/:id` read answers exactly what a missing id answers.

The e2e of each V step: a role holder with the word opens the module, sees its club's data read-only, sees no write
control, at 1280 and 390 px.

## 5. Order and pull requests

Smallest and safest first; a batch shares one pattern. Every PR is risky (trigger 2): internal security and code review,
`ux-design-reviewer` and `mobile-qa` where a screen changes, and the *Nezavisni revizor*.

| PR | Contents | Pattern | Size | Depends on |
|---|---|---|---|---|
| **V-0** | `moduleView.js` (`canView`, `viewReadScope`, `viewEntryGate`), the sweep test file with today's rows, the frontend plumbing (`permission-nav.js` per word, `notInViewWorkspace` per module). No module opens. | foundation | S | – |
| **V-1** | Data configuration (2.1) + Tags, presets and session types (2.2) | read-only catalogs, no athlete data | S–M | V-0 |
| **V-2** | Athletes (2.3) | personal data, every gate at once | L | V-0, P-1 |
| **V-3** | Calendar (2.4) | schedule reads, reduced views | M | V-0, P-1 (names) |
| **V-4** | Tests (2.5) | schedule reads, a secret, results split | M | V-0, P-1 |
| **V-5** | Training Load (2.6) | team totals against named athletes | L | V-0, V-1 (session types), P-1 |
| **V-6** | Dashboards (2.7) | ADR-002 data workspace | M | V-5 |
| **V-7** | Programs and exercises (2.8) | a new club scope | L | V-0, P-2 |

V-3 and V-4 do not share files and may run in parallel with different stream managers. V-2 goes before the modules that
show names if P-1 is answered "names need `athletes.view`".

## 6. Small choices decided by the executor (for the manager's review)

1. Session types go with `presets.use` (2.2); no new word.
2. Tests `GET /today` is not opened in V (it writes occurrences); a read-only variant can come later.
3. Tests `publicToken` and the link block are never in a view answer.
4. Training Load reads that are athlete-only answer today's refusal to a holder of `load.view.team` alone; no new totals
   endpoint in V.
5. The occurrence writes inside Training Load `/weekly` and `/calendar` are skipped for a view workspace.
6. Dashboards: `POST` / `DELETE /active` (a personal selection) stay closed in V; an athlete-grouped widget needs
   `load.view.athlete`.
7. The view path always resolves the workspace read-only (no preference write).
8. Imports, Messages and Notifications get no V step; module notification links open per V step.
9. A V step changes no MANAGE gate; event questions, calendar settings and the roster stay managers'.

## 7. Questions for the owner (only real product decisions) – decided

**Decided (the owner, 2026-11-24, relayed by the manager):**
- **P-1:** athlete names appear in a module only with `athletes.view`; without it, counts only.
- **P-2:** `programs.view` and `exercises.use` for a club cover the programs and weekly plans assigned to the club's
  athletes, the public program library and the system exercise library, all read-only.
- **P-3:** the order of section 5 (the manager).

**Decided (the owner, 2026-11-25, relayed by the manager): P-4, a licence hierarchy. Not built yet; it is built in
V-5.**
- Training Load is a parent module. Closing `training_load` in a club's licence closes every module under it. Each child
  can still be closed on its own, as today.
- The rule is server-side: the ceiling check of `can()` and of `public.user_has_permission` treats a closed parent as
  closing its children. It is not only a UI rule.
- The Club licence screen shows the children of a closed parent as closed, with the note "closed because Training Load
  is closed".
- Production already holds one club with `training_load`, `dashboards`, `data_configuration` and `imports` closed (the
  owner's own test). Nothing there needs to change.

For V-5 to settle (from the code at this branch, not yet a contract):
- **The children.** The R4 modules of `permissions.js` are flat: `training_load` holds only the `load.*` words (team and
  athlete load views, schedule, roster decisions, estimates, activities). The owner names `dashboards`, `imports` and
  `data_configuration` as children. V-5 lists the final set and asks the owner about the edge cases. `data_configuration`
  also serves the variables of other modules. `calendar` and `tests` are separate modules today and are not named.
- **Where the ceiling lives.** In two places:
  - SQL: `public.permission_club_closed_modules(club)` (v92), read by `public.user_has_permission` and by
    `loadAuthorizationContext` (`authz.js`, `closedModules` per held entry);
  - code: `can()`'s `closedModules.includes(entry.module)` (`permissions.js`), `closedModulesForWorkspace` and the
    frontend.

  The simplest single place is `permission_club_closed_modules` returning the children of a closed parent too. Every
  reader would then follow, and the screen still needs to tell "closed by itself" from "closed because Training Load is
  closed". That is a migration (v96 is reserved for roles), with md5 preconditions on the bodies it replaces.
- **v95's closed-module dominance** (`permission_club_role_version_items_guard`, `permission_custom_role_items_guard`
  and their completeness checks) decides which words a club version or custom role may hold or drop while a module is
  closed. With the hierarchy, a word of a child module counts as closed whenever `training_load` is closed. V-5
  re-states and re-tests those guards with the derived set.
- **The view steps.** `canView` and the module gate read the same `closedModules` through `can()`, so they follow
  without their own change once the derived set is in place. `roles-v95-closed-module-dominance` and the sweep's licence
  checks gain a "closed by the parent" case.

The questions as they were asked:

**P-1. Imena sportista u modulima.** Kada osoba ima pravo da gleda neki modul (npr. kalendar, testove ili trenažno
opterećenje), da li u tom modulu sme da vidi i **imena sportista** ili samo brojeve (npr. „12 sportista, 9 uneli RPE")?
Pravo „Sportisti – pregled" (`athletes.view`) već postoji kao posebno pravo.

*Preporuka:* **imena samo uz pravo „Sportisti – pregled"**. Bez njega osoba vidi brojeve i datume, a mesto imena piše
„Sportista". Ovako jedno pravo jasno kaže „ova osoba sme da vidi ko su sportisti", a ostala prava ne otkrivaju imena
(maloletnici, zdravstveni podaci u testovima). Za trenažno opterećenje ovo se poklapa sa već postojećom podelom „Ukupno
za tim" / „Imenovani sportisti".

**P-2. Šta znači „Programi – pregled" i „Vežbe – korišćenje" za osobu iz kluba.** Danas programi i vežbe pripadaju
treneru koji ih je napravio (ili su sistemske i javne), a ne klubu. Šta treba da vidi osoba sa tim pravom u klubu?

*Preporuka:*
- **„Programi – pregled":** samo programe i nedeljne planove **dodeljene sportistima tog kluba**, plus javnu biblioteku
  programa, sve samo za čitanje. Nikada tuđe nacrte.
- **„Vežbe – korišćenje":** sistemsku biblioteku vežbi, samo za čitanje.

Ovo je poslednji korak (V-7), pa se može odlučiti i kasnije.

**P-3. Redosled.** Predlog je: prvo podešavanja bez podataka o sportistima (varijable, oznake), zatim sportisti,
kalendar, testovi, trenažno opterećenje, tabele (dashboards), a programi i vežbe na kraju.

*Preporuka:* **ovako**, osim ako vam neki modul treba ranije za konkretnu osobu u klubu. Tada taj modul ide odmah posle
V-0.

## 8. V-1 as built (Data configuration; Tags, presets and session types)

Branch `feature/roles-v1-config-presets` from `1e83d9c6`. No migration.

**The gate (V-0's reviewer LOW).** `compileRoute` (`moduleView.js`) wraps a custom `:param` pattern whole,
`^(?:…)$`, so an alternation such as `/^a|b$/` admits only `a` and `b`. It refuses the `g`, `y` and `m` flags
(`module-view-v0` test 11).

**Data configuration (`variables.view`).**
- **Reads:** `routes/sourceMetrics.js` mounts `viewEntryGate("data_configuration", …)` with three reads:
  `GET /variables`, `GET /variables/:variableId` and `GET /classification`. Everything else answers the identical
  `404 {error:"notFound"}`.
- **The view context:** `canonicalVariableAdminService.js` `resolveVariableViewer` builds the context of a view
  workspace from the gate's scope, never resolving the workspace again: `{ basis: "role_holder", owner: the club,
  view: "coach", readOnly: true }`. The club must be active; for `team_view`, the team and its club.
- **Answers:** C99's reduced view. `reducedOut` offers nothing editable for a `readOnly` context: `editable: false`,
  `actions: []`.
- **The coach paths (checked word):**
  - the club admin's branch of `resolveMappingAdminWith` (`sourceMetricAccess.js`) asks `can(variables.view)` at the
    club;
  - the team coach's branch of `resolveVariableEditor` asks it at the team.

**Tags, presets and session types (`presets.use`).**
- **Taxonomy:**
  - `server.js` mounts `taxonomyViewGate` (`routes/taxonomy.js`) before `requireCoach`. A view workspace reaches only
    `GET /node-presets`, `GET /template-tags` and `GET /library/:kind` (the five kinds); every other request is `403`,
    as `requireCoach` answers.
  - A view workspace reads the system rows plus its club's and its teams' rows (`club_view`), or its team's rows
    (`team_view`). It never reads a person's own rows or another club's, and always with `can_manage: false`.
  - The coach path keeps its query. A club or team row counts only with `can(presets.use)` there, and
    `canManagePreset` asks the same.
- **Session types:**
  - `routes/sessionTypes.js` mounts the gate on `GET /`; every write answers the identical 404.
  - `sessionTypeService.js` gives a view workspace its club's types, read only.
  - A club or team workspace without `presets.use` (the licence) sees the system types only and writes none.

**Word lists.**
- `ENFORCED_PERMISSIONS` adds `variables.view` (`sourceMetricAccess.js`, `canonicalVariableAdminService.js`) and
  `presets.use` (`routes/taxonomy.js`, `sessionTypeService.js`). `STORABLE_PERMISSIONS` lists them once.
- `VIEW_WORKSPACE_USABLE_WORDS` adds both words.
- `OPEN_VIEW_MODULES` is `["data_configuration", "presets"]` on both sides.

**Frontend.**
- **Training Load:**
  - `variablesContext` gives a view workspace the reduced, read-only context, with the intro sentence "You can look at
    them here".
  - A view workspace shows only the Data configuration space, with no Filter (`viewTrainingLoadSections`), and
    `setTrainingLoadSection` keeps it on `variables`.
- **Tags & Presets:**
  - The panel reads only: no Add, no remove, no positions (positions belong to the Athletes module and are not
    loaded).
  - The taxonomy rows are read again after a workspace switch, because they now depend on the workspace.
  - The Settings tab and the Home button of an opened section carry their labels (`VIEW_SETTINGS_LABELS`). V-0
    labelled only Overview, Clubs and Teams.

**The executor's choices (accepted by the manager, 2026-11-24).**
1. **`GET /classification` is opened too.** It is the variable editor's reduced read, the same audience as a team
   coach's, and offers no action there. Without it, Data configuration's start screen (the Domains and Categories
   cards) and the categories of a variable would not load. Plan 2.1 named only the two variable reads.
2. **The licence now also limits the club's old roles here: a visible behaviour change for a club that is licensed out.**
   A club whose licence closes Data configuration or Tags & Presets no longer shows it to its own club admin and team
   coaches either: Data configuration answers them the identical 404, and Tags & Presets keeps only the system rows
   and their own rows, with no club write. Their paths ask `can()`, and `can()` applies the ceiling, as the R4 design
   makes the ceiling the club's licence. A platform admin is not limited. No club had a closed module in production
   when this was decided (the manager's v95 preflight: `closed_modules = 0`).
3. **Session types under a closed licence.** In a club or team workspace whose club closed Tags & Presets, the
   session-type list shows the system types only (not a 404), so a screen that offers types keeps working.
4. **Unchanged:** a club admin without a team role still does not see a team's presets in the coach list (today's
   query), while a `club_view` holder of the club does. The sweep test pins both.

**Tests.**
- `backend/tests/roles-v-sweep.test.mjs` tests 5 and 6 cover the open rows:
  - only the listed reads;
  - club A only, including a mixed account in `club_view` B;
  - C99's shape;
  - the identical 404 and 403;
  - every write lands nothing (a row-count snapshot);
  - the word taken away;
  - the licence, for role holders and for the old roles;
  - old-vs-new for the coaches.
- `source-metric-access-7a-context` test 7 covers the club admin's word and the licence.
- On the frontend: `roles-v1-view.test.mjs` and `view-modules.test.mjs` (3, 3b).
- e2e: `roles-v1-view-config-presets.test.mjs` at 1280, 390 and 360 px.
- **Older suites on earlier migrations (the manager's option A, test only).** Seven suites build their database only
  up to their own migration, before the role tables, so the new `can()` failed closed there
  (`503 permissions_unavailable`):
  - `source-metric-mapping-v35`;
  - `source-metric-mapping-club-admin-7h`;
  - `source-metric-variables-club-7i`;
  - `calculated-variables-v77`;
  - `lock-order-lo1`;
  - `team-dashboards-club-variables-o7`;
  - `source-metric-confirmations-v65`.

  `createGpexeDisposableDb({ roleRead: true })` (`backend/tests/_gpexe-disposable-db.mjs`) has the runner apply v84 and
  v92 after the suite's list, then sets their two records aside. Every assertion about the migration record (the last
  migration, "later migrations are applied", the list of names) still sees the suite's own list, and no assertion was
  changed. `applyGpexeTestMigrations` puts the records back before it brings such a database up to date.
- The word lists of five role suites now include the two checked words: `me-permissions-r3`, `permission-roles-v84`
  2b, `roles-api-r2` 17-honoured, `roles-r4-2-view-workspace` 11 and `roles-r4-api` 1.

**Internal review notes (code and security, READY WITH NON-BLOCKING NOTES; recorded, not built).**
- **MEDIUM (security, documented, not fixed in V-1).** `variables.view` gates the club admin's whole Data configuration
  administration, because `resolveMappingAdminWith` is the one context for mappings, activations, the board,
  confirmations, classification and variable writes. A club whose licence closes Data configuration closes all of it
  for its admin: that is choice 2, as intended. A club whose own version of the Club admin role drops `variables.view`
  closes it too, although the word is a view word. The words `variables.manage`, `variables.rename_archive` and
  `mappings.manage` exist but are not checked yet; a later MANAGE step gates those writes with them.
- **Fixed in V-1, with tests:**
  - `viewScopeSql` leaves an archived team's rows out of a `club_view` read. Sweep test 6 checks it, and the mutation
    that drops the filter is killed.
  - `resolveOwnerScope` lower-cases a body's club or team id before `can()`, so a coach's upper-case id is accepted as
    before. A non-uuid id is outside the caller's access (403).
  - Sweep test 6 reads all five library kinds.
- **LOW, recorded:**
  - A coach whose club closed Tags & Presets can still hide a system preset in their own lists (a per-user row, with no
    `can()`).
  - A role-assignment account's workspace is resolved twice: by the gate, and again by the module's own resolver for a
    non-view workspace. This fails closed.
  - The taxonomy rows carry `created_by_user_id` / `owner_user_id`, as on the coach path.
  - A platform admin in a view workspace is limited to the listed reads.
  - The coach-path writes read the ceiling from the request's snapshot without the ceiling lock (R4 contract 7.6
    requires the lock only from `lock_permission_actor` callers). A licence close that commits while one such write is
    in flight lets that one write land.
  - Creating an attractor through `POST /api/taxonomy/library/attractor` fails (a NOT NULL `kind` column the route never
    fills). This predates V-1.

**Follow-ups (not built).**
- A Home entry for Training Load's Data configuration in a view workspace (today the menu opens it).
- A Positions read for the Athletes step (V-2).

## 9. V-2 design notes (Athletes; the executor's discovery, before code)

Branch `feature/roles-v2-athletes` from `f45ee0f9`. Built as section 10 records; this section is the design it followed.

### Where the gates are (checked at `f45ee0f9`)

- **A, the predicate:** `athleteAccessPredicate(alias, userParam)` (`access.js:213`) is SQL. An athlete is readable
  through four branches:
  - the athlete's own login;
  - an active `user_athletes` link (a private coach);
  - an active team membership matching a `user_team_roles` row;
  - an active club membership matching a `user_club_roles` row.

  Its callers:
  - inside `access.js`: `athleteListAccessFilter(req, …)`, `canAccessAthlete(query, req, id)` and
    `canAccessPlan(query, req, id)`;
  - the raw predicate is called directly in two places, `routes/builder.js:353` and `:3853`;
  - through those wrappers: `routes/builder.js` (5), `routes/templates.js` (3), `routes/plans.js` (3),
    `routes/athletes.js` (3), `routes/tests.js` (2), `linkedSessionTimes.js` (2), `exerciseMedia.js` (2),
    `athleteRosterScope.js` (2) and `routes/organization.js` (1).
- **B, the roster scope:** `athleteRosterScope` (`athleteRosterScope.js`) is A's filter plus the workspace's own
  membership. A view workspace gets `and false` today.
- **D, the organization read:** `viewWorkspaceOrganization` (`routes/organization.js`, R4-2) returns `athletes: []`.
  The coach path of `GET /api/organization` reads its athletes through A.

### Mechanism (the executor's choice)

- **The id arrays.** The role branches of A stop reading `user_club_roles` / `user_team_roles` in SQL. Instead they take
  two id arrays computed in JS for the request:
  - the clubs of the account's old `club_admin` rows where `can(authz, "athletes.view", clubScope(id))`;
  - the teams of its old `team_coach` rows where `can(authz, "athletes.view", teamScope(id))`.

  The SQL becomes `tm.team_id = any($teams)` and `cm.club_id = any($clubs)`. The membership rule stays the same
  (active rows only).
- **The signature.** `athleteAccessPredicate` takes the parameter positions of the two arrays. The `access.js` wrappers
  and the two raw calls in `builder.js` pass them, and every gate file calls `can()` through one helper,
  `athleteViewScopes(req)`.
- **Why not the SQL twin `public.user_has_permission` per row:** it would run once per athlete and role, and it costs
  a `permission_user_holdings` read each time. On a pre-v84 test database it fails as a missing function (a 500, not a
  503).
- **Consequences:**
  - The word now limits every reader of A: Builder, templates, plans, tests, linked session times, exercise media and
    organization. A club whose own version of a role, or whose licence, takes `athletes.view` away removes its
    athletes from all of them for that role. This is R4 section 6, decided.
  - Every suite whose database stops before v84 and whose coach paths reach A needs `roleRead: true`. The full
    disposable kind finds them; a filter does not.

### What a view workspace gets (plan section 2.3, P-1)

- **`GET /api/athletes` (the list):** the club's or team's athletes, by active membership of the day, in the roster
  shape.
  - **Open question for the manager:** the list carries `weekly_plan_count` and `program_count`, which are program
    data (`programs.view`).
  - **Proposal:** a view workspace gets them as `null`, and the screen shows no count.
- **`GET /api/organization`, athletes of its club or team:** with `athletes.view`; otherwise `[]`, as today.
- **`GET /api/positions` and `GET /api/positions/athletes` (reads):** the club's positions and its athletes' positions.
- **Stay closed** (not `athletes.view`): `/today` and `/training-days` (plan data), `/:id/plans` and `/:id/program-data`
  (`programs.view`), every write, and `athlete-profile` (the athlete's own).

### Tests to write

- **The sweep row `athletes`:**
  - the listed reads, club A only;
  - a mixed account;
  - a minor's data only in its own club;
  - every write lands nothing;
  - the word taken away;
  - the licence closes it for role holders and old roles alike.
- **Old-vs-new on every gate A, B and D:** for a club admin, a team coach, a private coach, an athlete and a platform
  admin.
- **The rule's own tests:** checked-gates A1/A2 with the new gate files, and `enforced_word_covers_all_gates`.
- **Frontend:** the menu place `athletes`; Settings → Athletes, read only; e2e at 1280, 390 and 360 px.

## 10. V-2 as built (Athletes)

Branch `feature/roles-v2-athletes` from `f45ee0f9`. No migration. The manager's decisions on section 9 (2026-11-25): the
id-array mechanism; plan counts `null` in a view workspace; a view workspace opens only the athlete list, the
organization's athletes and the two positions reads; the R4 section 6 consequence accepted; P-1.

**Gate A, the access predicate (`access.js`).**
- `athleteViewScopes(req)`: the clubs of `req.authz.clubRoles` and the teams of `req.authz.teamRoles` where
  `can(athletes.view)` holds there. Pure, from the request's snapshot; `can()` throws `503 permissions_unavailable` for
  an account with an old row when the role tables could not be read.
- `athleteAccessPredicate(alias, user, clubs, teams)`: the two parameters are required (a caller not moved fails
  loudly). **One deviation from section 9, stricter:** the role branches keep the LIVE `user_club_roles` /
  `user_team_roles` join and add `club_id = any($clubs)` / `team_id = any($teams)`. The word narrows, the live row still
  decides, so a role revoked during a request closes access as before (the weekly-plans read relies on that, PR #681
  test 10).
- Moved: `athleteListAccessFilter`, `canAccessAthlete`, `canAccessPlan`, and Builder's two raw calls (the weekly-plans
  read and `editablePlanAccessSql`, three callers).

**Gate B, the roster scope (`athleteRosterScope.js`).** A `club_view` / `team_view` workspace reads its active
memberships (in an active club, and an active team for `team_view`) only when the athletes gate let THIS request through
(`req.moduleView.module === "athletes"`, the same workspace object); any other view-workspace read stays `and false`.
`currentAthleteRosterScope` uses the gate's workspace and never resolves again.

**Gate D, the organization read (`routes/organization.js`).**
- Coach path: every club / team branch of `loadManagedAthletes` (active access, the list and the archived rows) also
  requires the club / team in `athleteViewScopes`.
- View path: `viewWorkspaceOrganization` lists the workspace's athletes when `canViewAthletesAt` (`access.js`, the one
  scope-level check) holds, from `loadViewAthletes`: a fixed key list (`VIEW_ATHLETE_KEYS`): ids, name, picture, this
  club's or team's active memberships only, `has_active_access: true`. Never a login, invite, library setting, account
  fact or the legacy club / team pointer. `club_view` lists athletes with an active club membership (as the athlete list
  and a club admin's own list); `team_view` those with the team's.
- The check lives in `access.js` so `permissions-r1`'s oracle of organization.js's `can()` calls (the R1 world) is
  unchanged.

**The routes.**
- `routes/athletes.js`: `viewEntryGate("athletes", [GET /])`. Every other request of a view workspace is handed on with
  `next()` and no `req.moduleView` (`refuse(req, res, next)`, a one-line extension of `moduleView.js`), so it answers
  exactly what it answered before V-2 (`/today`, `/training-days` empty; `/:id/plans`, `/:id/program-data` 403). In a
  view workspace `weekly_plan_count` and `program_count` are `null`.
- `routes/positions.js`: the gate with `GET /` and `GET /athletes`; everything else of a view workspace is the router's
  identical 404. `positionService.js`: the view context reads its club's list and its athletes' positions with
  `canSet: false`; the coach path of `GET /athletes` also asks `can(athletes.view)` at its club or team.

**Word lists.** `ENFORCED_PERMISSIONS["athletes.view"]` = `access.js`, `positionService.js`; `VIEW_WORKSPACE_USABLE_WORDS`
and `OPEN_VIEW_MODULES` (both sides) add it. `roles-r4-checked-gates`: B3 adds `athleteRosterScope.js`; B1
`athleteRosterScope.js` 4 → 7, `positionService.js` 8 → 11.

**Frontend.** The sidebar's athlete list in a view workspace is plain rows (no button, no counts); Settings → Athletes (and
a chosen club or team) is `renderViewAthleteListHtml`: name, ID, team and club, the position badge; no control. Positions
are read for it. Home's buttons add Athletes (V-0's plumbing).

**Tests.** `roles-v-sweep` test 7 (club_view and team_view; another club and an archived membership never; the plain
counts; the hidden reads equal to an account with no role; no preference write; writes land nothing; a mixed account;
the word taken away; the licence closes it for role holders, the club admin and the team coach, and a platform admin is
never limited; reopened). `athlete-roster-scope` (the view branch fails closed without the gate's pass). Frontend
`roles-v2-view.test.mjs`; e2e `roles-v2-view-athletes.test.mjs` at 1280, 390 and 360 px.

Test 7 also pins the two branches the word never narrows (a private-coach link and the athlete's own login: their
`/plans` stays 200 with the licence closed) and the mixed account's hand-on reads (below). Section 9's "a minor's data
only in its own club" has no test of its own: no rule reads an athlete's age, so it is the same check as "another club's
athletes never", which test 7 makes for every read.

**Recorded, not built.**
- A mixed account (club B's admin, a view role in club A) in `club_view` A can still write to club B's athletes through
  the organization routes: those writes check the old roles, not the active workspace, as before V-2.
- The same account's reads that the athletes gate hands on unchanged (`/:id/plans`, `/:id/program-data`, `/today`,
  `/training-days`) still answer from its old roles in club B while `club_view` A is active, as before V-2 (pinned in
  test 7: club B's athlete's plans 200, club A's 403). Closing it means answering those routes in a view workspace with
  what an account without a role gets, instead of `next()`; a manager's decision.
- A view-workspace read the gate hands on unchanged (`/today`, `/training-days`) still resolves the workspace with the
  preference-writing resolver, as before V-2.

## 11. V-3 as built (Calendar)

Branch `feature/roles-v3-calendar-view` from `f45ee0f`. No migration. (Numbered 10 so it does not collide with the
parallel V-2 section.)

**The gate.**
- `routes/calendar.js` (`GET /`), `routes/calendarEvents.js` (`GET /types`, `GET /:eventId`) and
  `routes/calendarSettings.js` (no read) mount `viewEntryGate("calendar", …)`.
- Its refusal (`calendarViewRefused`, `calendarModuleContext.js`) does not answer by itself. It marks the request and
  passes it on without `req.moduleView`, and the route then answers what it answered a view workspace before V-3,
  without resolving the workspace again:
  - `GET /api/calendar`: 403 `Forbidden`;
  - an event read or write that names an id: the 404;
  - a create: 403;
  - the questions and the settings: their own answers.
- `viewEntryGate` now passes `next` to `refuse` (one line in `moduleView.js`; `module-view-v0` test 7 pins it).

**The view context** (`calendarModuleContext.js` `resolveCalendarModuleContext`, used by every calendar router).
- A listed read of a view workspace gets `{ type: "coach", workspace: <the club_view / team_view one>, view: { type,
  id, clubId }, readOnly: true, activityScope: { club | team } (no owner context) }`.
- The workspace stays the view one, so `eventWriteBasis`, `eventOwnerForWorkspace` and the settings' club recognize
  nothing. Both write helpers also return null for a `readOnly` / `view` context.
- The read scopes of `calendarAccess.js` (`calendarAthleteScopeSql`, `calendarScheduleStructuralSql`,
  `calendarScheduleCandidateSql`, `loadWorkspaceTeams`) and the reduced event view read the `view` through
  `calendarReadWorkspace(ctx)`.
- The catalog of `GET /types` (`eventCatalogOwner`) is the view's club or team's.
- The context lives in its own file so that `calendarAccess.js`, which other modules import, does not load
  `moduleView.js` (two unit suites mock `workspace.js`).

**The coach paths (checked word).** A club or team workspace keeps today's context only with
`can(calendar.view)` at its scope; the platform and a private coach keep theirs (R4 Q10). Without the word, or with the
club's licence closed, every calendar route (reads, events, settings) answers as for no context, as R4 section 6
decided.

**P-1 (names).**
- A view workspace names athletes only with `canView(athletes)`, which stays false until V-2 opens the Athletes
  module.
- Without it:
  - `?include=athletes` is left out of the answer (no `athletes` key);
  - every card's `athleteIds` is empty and its `athleteCount` stays (counts only; the security review's MEDIUM);
  - the reduced event view lists no athlete target and counts them in `hiddenAthleteTargets`.
- With it, the reduced view is the non-manager view a team coach gets today.
- **For V-2:** when `athletes.view` is enforced, the calendar's name gate is `canView(athletes)` in
  `calendarModuleContext.js`, a call through `canView`, not a literal `can()`.

- **The athlete's own questions** (`routes/calendarQuestions.js`, `/questions/mine` and *Later*) keep the plain
  calendar context, with no gate and no word: they have no coach side (the code review's LOW).

**Word lists.**
- `ENFORCED_PERMISSIONS` gets `"calendar.view": ["calendarModuleContext.js"]`.
- `VIEW_WORKSPACE_USABLE_WORDS` gets `calendar.view`.
- `OPEN_VIEW_MODULES` gets `calendar` on both sides.
- `roles-r4-checked-gates` B1: `calendarModuleContext.js` 2 and `calendarEventService.js` 5. `calendarAccess.js`
  stays 17, the same branches renamed to the read workspace's type.

**Frontend.**
- `OPEN_VIEW_MODULES` opens the Calendar place (`#calendarToggle`, tab `central-calendar`).
- The calendar already offers New event only to club, team and private-coach workspaces, and an event's write
  controls only on `canManage`, so a view workspace sees the calendar read only. Its panel says "No athlete names
  were returned."
- No notification opener is mapped to `calendar`; the coach side has none.

**Tests.**
- `roles-v-sweep` test 7:
  - club_view and team_view read club A's calendar, types and the reduced event view: no club B id, no name, no
    notes, never `canManage`;
  - the reduced view equals the team coach's reduced view of the same event, without its athlete targets;
  - another club's event and a missing id give the identical 404;
  - the questions, the settings and nine writes give the same status and body as an account with no role, and land
    nothing;
  - no read writes anything;
  - a forged `club` preference;
  - a mixed account (club B's admin in club_view A);
  - old-vs-new for the club admin and the team coach;
  - the word taken away;
  - the licence closing reads and writes for role holders and the club's old roles.
- Mutations killed: the coach path's `calendar.view` check dropped; the name gate forced open.
- e2e: `roles-v3-view-calendar.test.mjs` at 1280, 390 and 360 px.
- After the independent review of #768 (LOW, carried into V-4): without the athletes' names the calendar read also
  ignores `athleteIds` (`routes/calendar.js`), so filtering by an athlete id cannot tell whether that athlete has events.
  `roles-v-sweep` test 7 compares the filtered answer, for a real and a random id, with the unfiltered one (mutation
  killed). `module-view-v0` test 12 calls `eventOwnerForWorkspace` and `eventWriteBasis` directly with a view context and
  a platform admin's authz (mutation killed).
- The suites that list the checked words take `calendar.view`, as V-1 did for its words: `me-permissions-r3` (both
  basic roles), `roles-r4-2-view-workspace` test 11 (/me; the calendar reads leave its list), `roles-r4-api` tests 1
  and 2, `roles-r4-3-api` tests 1, 2 and 6 (`dashboards.view` is now their unchecked word), `permission-roles-v84` 2b
  (`LATER`).
- **Older suites:** `startCalendarApp` (`backend/tests/support/calendar-fixture.mjs`) builds its database with
  `roleRead: true`. `central-calendar-k2b-settings` builds only up to v51, so a coach's `can(calendar.view)` failed
  closed there (`503 permissions_unavailable`). It is a no-op for the suites whose list has v84 and v92.

**Review notes, recorded (not built).**
- LOW (security): non-event cards keep their `links` (session, activity and schedule ids), as a coach's reader sees
  them. They are not usable: the target routes refuse a view workspace.
- LOW (security): on the non-view path the workspace is resolved twice (the gate read-only, then the route), as in
  V-1. It can only fail closed.

## 12. V-4 as built (Tests)

Branch `feature/roles-v4-tests-view`, on `main` with V-2 and V-3 merged in. No migration.

**The gate.** `routes/tests.js` mounts `viewEntryGate("tests", …)` with seven reads:
- `GET /library`, `/schedules`, `/weekly` and `/schedules/:scheduleId`;
- `GET /schedules/:scheduleId/group`, `/results` and `/results/:assessmentId`.

Its refusal depends on the route:
- **The athlete's own routes** (`/athlete/*`, `/assignments/*`) go on as before. They decide by the athlete profile, not
  the workspace.
- **Every other route** answers `403 {error:"Forbidden"}`, what `requireCoachWorkspace` answers an account without a
  coach role. That includes `GET /today` (plan choice 2: it writes the day's occurrences) and every write. The gate
  marks the request (`req.testsViewRefused`) and `requireCoachWorkspace` answers, so a path the router does not have
  still gets the app's 404, as for an account with no role (`roles-r4-2-view-workspace` test 11 reads `/api/tests`).
- **A mixed account** (an old role row elsewhere) in a view workspace is refused too. Before V-4 it passed
  `requireCoachWorkspace` and read every club it administers.

**The view reads.**
- **Scope:** `scheduleReadScope` gives a view workspace `viewScheduleScope(req.moduleView)` (`testsAccess.js`): never a
  person's own schedule (`userId` null), never every schedule. The club must be active (and for a team, the team and
  its club).
  - club view: the club's schedules and its active teams'.
  - team view: the team's own schedules. Like its team's coach, a team view does not read the club's own schedules.
- **One schedule:** `loadManageableSchedule` checks a GET of a view workspace with `viewScopeReadsSchedule`. A write
  never takes that branch. Another club's schedule gives the 404 of a missing one.
- **`GET /schedules/:id`:** never reads the group link. A view answer has no `link` block and so no `publicToken`
  (plan choice 3); it carries `readOnly: true`.
- **Results and the group:** a view workspace also needs `tests.results.view` (`canView(tests_results)` in the route),
  otherwise 403.
- **The week:** `GET /weekly` counts a schedule's results (`resultsCount`) only with `tests.results.view`; without it,
  0. The day's completion counts (`counts`: completed, open, missed) are deliberately visible with `tests.view`, and
  `counts.completed` is in practice the same number as `resultsCount`. So `tests.results.view` hides the scores, the
  injuries and the per-athlete rows, not how many athletes answered.
- **Names (P-1):** a view workspace gets no athlete names without `canView(athletes)` (open since V-2; with
  `athletes.view` it gets the coach's shape: names, ids and targets). Without it:
  - the schedule's athlete targets are dropped and counted (`hiddenAthleteTargets`);
  - the group's and the results' `athleteId` and `athleteName` are null;
  - the group's rows carry no `assignmentId`;
  - the rows are no longer sorted by name (the group by state, window, then a hash of the assignment id; the results
    newest first);
  - the result's `athleteName` is null.

**The coach paths (checked words).**
- `manageableClubIds` / `manageableTeamIds` keep only the clubs and teams where the account holds the word:
  `tests.view`, or `tests.results.view` for results.
- `canManageSchedule` asks the same word at the schedule's club or team (`holds`, two literal `can()` calls).
- **The group and Today keep their reach for a coach.** A coach opens a schedule's group (`GET /schedules/:id/group`,
  the Today detail and its reminder) and its Today with `tests.view`. The scores and injuries need
  `tests.results.view` at the schedule's club or team: without it they are null, and the group says `resultsHidden`.
- A new schedule (`POST /schedules`, `/schedules/bulk`) needs `tests.view` at its owner scope.
- A platform admin and a person's own schedule are unchanged (R4 Q10).
- A licence that closes Tests therefore leaves the club out of its admin's lists, makes its schedules and results the
  404, and refuses a new schedule there. Another club is unaffected.

**Word lists.**
- `ENFORCED_PERMISSIONS`: `tests.view` and `tests.results.view` → `testsAccess.js`.
- `VIEW_WORKSPACE_USABLE_WORDS` gets both words.
- `OPEN_VIEW_MODULES` gets `tests` and `tests_results` on both sides.
- The frontend Tests place opens with `tests` only: results alone open nothing.
- `roles-r4-checked-gates` B1: `testsAccess.js` 3.

**Frontend** (`tests-view.js` `testsReadOnly`, `testsCoachSections`).
- In a view workspace the sections are Schedule, Results (with `tests.results.view`) and Test Library; there is no
  Today. Loading or a section click never lands on a missing section.
- Schedule has no New check-in schedule. A schedule's detail is a read-only card: the targets (athletes counted), the
  time and the state, with no action and no group link.
- A result says "Athlete" where the name would be, and offers no Schedule again.
- The Tests Today notification link stays Home in a view workspace (`viewModuleOfOpener`).

**Tests.**
- `roles-v-sweep` test 9:
  - club_view and team_view, each against its own schedules;
  - the token never in any answer, and no athlete name or id;
  - another club's schedule and a missing id give the same 404;
  - Today, the athlete's route and seven writes give the same status and body as an account with no role, and land
    nothing; no read writes anything;
  - one word without the other;
  - a forged `club` preference;
  - a mixed account;
  - old-vs-new for the club admin (the link and the names);
  - the licence closing the admin's list, reads and writes.
- Mutations killed: the view branch that drops the link and the names; the coach path's word check forced true.
- **Old-vs-new for the coaches:** the coach paths' regression is the Tests suites (`tests-module-*`,
  `tests-weekly-calendar`, `tests-manual-reminder`, `tests-notification-worker`, `tests-athlete-device-timezone`),
  which pass unchanged. They build their databases from the Tests migrations only, so they now also apply v84 and v92
  (`applyRoleReadMigrations` of `_gpexe-disposable-db.mjs`, from V-2, a second runner call over a folder named `migrations_v2`). Test 9
  also checks the club admin's link, names and scores, and the team coach's list, results and Today. No full-body
  comparison against `main` is made.
- e2e: `roles-v4-view-tests.test.mjs` at 1280, 390 and 360 px.
- The suites that list the checked words take `tests.view` and `tests.results.view` (as for V-3 in section 11);
  `roles-r4-2-view-workspace` test 11's /me list gets both.

**Follow-ups (not built).**
- A coach whose club version keeps `tests.view` but drops `tests.results.view` is not set up in a test (no fixture
  for club role versions here); the rule is covered by the view holders and the mutation of `holds()`.
- The weekly view's "Open in calendar" stays visible for a view holder without `calendar.view`; the calendar tab is
  then not available to it.
- The remaining reads of `routes/tests.js` that branch on the athlete (`/athlete/*`) are not part of V.

## 13. V-5 design (Training Load, and the licence hierarchy P-4)

Status: **Accepted** (the manager's GO, 2026-11-25: the split into V-5a and V-5b; choices 1–6 accepted, choice 3
matching the owner's "close part by part"; choice 7 decided by the owner as option (a), see 13.4). Written by the
executor on base `cf48c11e`, after V-4's section 12; P-4's own text is in section 7 (recorded with V-4, PR #769).

### 13.1 P-4, the licence hierarchy (the owner's decision of 2026-11-25, as relayed by the manager)

- **The children.** `training_load` is a parent module. Its children are `dashboards`, `imports` and
  `data_configuration`. The `load.*` words (RPE, activities, schedules, roster) are `training_load`'s own module, so they
  close with it already. Nothing else is a child (`presets`, including session types, is not).
- **One level only.** A child has no children; a parent has no parent. A closed parent closes every child; each child
  can still be closed on its own; opening the parent brings back exactly the children that were not closed on their own.
- **The rule.** The *effective* closed set of a club = the rows of `club_permission_ceiling` ∪ every child of a parent
  that has a row there. Every reader that applies the ceiling uses the effective set; the ceiling **writer** and its
  table stay as they are (the stored rows are the decisions, the effective set is derived).

**SQL (migration v96, `202611281000_roles_v96_licence_hierarchy.sql`).** Needed: the ceiling's database twin reads the
table itself, not a function.
1. Step 0: v95 recorded; md5 gate on the three bodies replaced below (v92's `user_has_permission` and
   `permission_club_rule7_ok`, v95's `permission_actor_holds_in_club`); the two new functions absent; the four module
   words exist.
2. New `public.permission_module_parent(p_module text) returns text` (immutable SQL, a fixed `case`: the three children →
   `training_load`, everything else null). A closed list in code rather than a column, because `permission_modules`
   is fixed by v84's trigger.
3. New `public.permission_club_effective_closed_modules(p_club uuid) returns text[]`: the explicit rows plus the
   children of a closed parent, distinct, sorted.
4. `CREATE OR REPLACE` of the three bodies, each changing only its ceiling test to the effective set:
   - `user_has_permission` step 6 (a child word in a club whose `training_load` is closed answers no);
   - `permission_club_rule7_ok` ("minus the closed modules" becomes minus the effective ones);
   - `permission_actor_holds_in_club` (v95's dominance: a child word passes for an admin who would hold it once the
     parent opens).
5. `permission_club_closed_modules` is **unchanged** (the explicit rows; the licence writer and screen read it).
6. Revokes as v92 / v95 for the two new functions. Rollback (md5 of the new bodies, restore v92 / v95's, drop the two
   functions), read-only preflight and post-check SQL, the rehearsal script (.mjs, .sh, .ps1), `eol=lf`, `db-reviewer`.

Every change only **adds** closed modules to a club that has `training_load` closed: `user_has_permission` gets
stricter there, rule 7 and dominance only get looser. No row is written or rewritten.

**Existing rows (the owner's test club in production).** It has explicit rows for `training_load`, `dashboards`,
`data_configuration` and `imports`. The effective set is the same four, so nothing changes for it. If the parent is
opened later, the three children stay closed, because they were also closed on their own; the screen shows that, and
the owner opens them one by one. No backfill and no rewrite (rewriting the owner's decisions would lose their
history).

**JavaScript.**
- `permissions.js`: `MODULE_PARENTS = { dashboards, imports, data_configuration → training_load }` and
  `effectiveClosedModules(explicit)`. A test pins it equal to `permission_module_parent` for every module word.
- `authz.js` `ROLE_PERMISSIONS_SQL` reads `permission_club_effective_closed_modules` into `closedModules`, so `can()` and
  `/me`'s `closedModulesForWorkspace` follow the effective set with no change of their own.
- `permissionLayersService.js`: the role-change paths (`checkedItemChange`, the word locks, `stillHeldThrough`) take the
  effective set (they mirror the SQL dominance and rule 7); `setCeiling` keeps the explicit set (what can be closed or
  opened); `ceilingView` adds per module `parent`, `closedByParent` (the parent is closed) and `effectivelyClosed`.

**The Club licence screen.** A child of a closed parent shows "Not included", its switch disabled, and the note
"Closed because Training Load is closed". If it is also closed on its own, the note says so ("also taken out on its
own"), so reopening the parent is not mistaken for reopening it. The draft follows the same rule (closing Training Load
in the draft greys the children at once). The parent's switch stays usable. The server is the rule; the screen only
shows it.

**What it changes today.** Closing Training Load now closes Data configuration too (checked since V-1) and,
from this step, the Training Load reads below. Dashboards and Imports follow once their own words are checked
(their row keeps "This part does not follow the licence yet" until then).

### 13.2 Training Load view reads (plan 2.6)

**Words and P-1.**
- *Team totals* = `canView(load_team)` (`load.view.team`).
- *Named athletes* = `canView(load_athlete)` **and** `canView(athletes)` (P-1: a name needs `athletes.view`). Until V-2
  opens Athletes, a view workspace never has named access, so V-5 opens team totals only for a view workspace; the named
  branch is built and tested with V-2 merged in (V-2 merges before this freezes).

**The gates** (`viewEntryGate`, refuse = each router's own pre-V answer through the V-3 "mark and next()" pattern, so a
view workspace gets byte-identical refusals on everything not listed):

| Router | Listed reads | Team totals | Named athletes |
|---|---|---|---|
| `/api/training-load` | `GET /calendar` | activity items with counts; planned and external items **left out** | all items, with `athleteName` |
| | `GET /weekly` | refusal (403, as today) | the whole answer, **without** the occurrence write |
| | `GET /external-schedules`, `GET /external-schedules/:scheduleId` | list and detail with `target_count` / counts, no target names or athlete ids | with targets |
| `/api/training-activity` | `GET /`, `GET /:activityId` | refusal | the whole answer (club variable names per V-1: `variables.view` and the club) |
| | `GET /:activityId/roster` | `counts` only, `rows: []` | the rows (read only, no `actions`) |
| `/api/training-load/metrics` | `GET /results`, `GET /occasions/:id` | refusal | the whole answer |
| | `GET /definitions`, `GET /definitions/:id`, `GET /domains`, `GET /categories`, `GET /structure-links` | system + the club's and its teams' rows (`team_view`: the team's and its club's), never a person's own rows | same |

Not opened (refusal as today): `/athlete/today`, `/planned-rpe-setting`, `/training-activity/self`, the estimate
proposal and manual-value form (both run through the write context), `/occasions/:id/history`, definition versions,
every write. Session types are V-1's.

**Hazards.**
- *Reads that write:* the view branch of `/weekly` and `/calendar` never calls
  `ensureCurrentExternalOccurrencesForCoach`; the sweep counts the occurrence rows before and after.
- *Owner fallbacks and the two workspace-trusting write helpers:* a view workspace never reaches them, because the gate
  admits only the listed GETs and each read builds its scope from `req.moduleView.scope` through new read-only helpers
  (`viewActivityReadScope`, `viewMetricsReadScope`, `viewCoachAthleteScopeSql`) that carry **no** `ownerContext`. The
  existing `scopeFromWorkspace` / `ownerContextFromWorkspace` copies stay untouched. Mutations: map `club_view` to
  `club` in each fallback and in `canManageActivityInScope` / `canManageMetricEventInScope`, and a sweep test fails.
- *The roster* (`activityRoster.js`, old rows): a view read gets its own branch keyed on the activity's owner being
  the view's club or team (and, for a club, a team of the club), counts unless named.
- *The catalog* (`catalogVisibilitySql`, the role SQL across all clubs): the view branch takes the scope argument; the
  coach branch keeps its SQL plus `can(load.view.team)` per club or team.

**The coach paths (checked words, R4 section 6).** A club or team workspace keeps today's answers only with
`can(load.view.team)` at its scope on every Training Load route (reads and writes), and additionally
`can(load.view.athlete)` on the athlete-row reads (`/weekly`, the activity list and detail, the roster rows, results,
occasions). The platform and a private coach are unchanged (R4 Q10). A basic Club admin and Team coach hold both
words (v92 seed), so nobody loses anything until a club version takes a word away or the licence closes Training Load.
The **athlete workspace** (an athlete's own RPE, weekly and results) is not a role, but it IS licence-gated in V-5b (the
owner's option (a) for choice 7, 13.4): an athlete of a club whose licence closes `training_load` gets no RPE prompt, no
RPE entry and no own load; one named server-side check, with a test.

**Registration.** `ENFORCED_PERMISSIONS` gets `load.view.team` and `load.view.athlete` with their gate files;
`VIEW_WORKSPACE_USABLE_WORDS` both; `OPEN_VIEW_MODULES` gets `load_team`, `load_athlete` (both sides); B1 / B3 counts.

**Frontend.** A view workspace's Training Load shows, besides Data configuration (V-1), the Calendar tab and the
external-schedules list read only (no write control; the sections that need named access stay hidden until it is
held). The licence screen as in 13.1. `ux-design-reviewer` and `mobile-qa` for both.

### 13.3 Tests
- `roles-v-sweep` test 8 (Training Load), the plan's section 4 rows 1–9 for both words, the occurrence count, the
  roster counts, the catalog scope, the mixed account, the forged preference, the word taken from a coach, the licence.
- `roles-v5-licence-hierarchy` (disposable, with v96): SQL and JS give the same answers for every module × explicit
  ceiling combination; rule 7 and v95's dominance with a closed parent; the owner's production shape (four explicit
  rows) before and after reopening the parent; the migration, its rollback and re-apply; md5 gates; a mutation per
  replaced body.
- Old-vs-new for the basic roles on every Training Load route; the full disposable kind; frontend tests for the
  licence screen and the view sections; e2e at 1280, 390 and 360 px.

### 13.4 Small choices made by the executor (for the manager)
1. The hierarchy is a fixed function in SQL and a constant in JS (pinned equal), not a table column.
2. The stored ceiling rows are not rewritten; the effective set is derived on read.
3. A child closed on its own stays closed when its parent reopens.
4. "Named athletes" needs `athletes.view` too (P-1), so a view workspace gets team totals only until V-2.
5. `/weekly` (every row an athlete) is not opened for team totals; no totals endpoint is built (plan section 6, 4).
6. The coach paths check `load.view.team` on every route and `load.view.athlete` on the athlete-row reads.
7. ~~The athlete workspace is not licence-gated in V-5.~~ **Decided by the owner (2026-11-25, relayed by the manager):
   option (a).** When a club's licence closes `training_load`, the athlete workspace is gated too: that club's athletes
   get no RPE prompts and no RPE entry, and do not see their own load. Built in V-5b, server-side, with a test; the RPE
   gate is ONE named check, so it can later be pointed at its own licence item.
   - **Future option, not designed now (plan-limits work):** RPE may become its own licence item that stays open while
     Training Load is closed (an RPE-only package). Nothing beyond the one named check is built for it.
8. **Split recommended:** V-5a = the hierarchy (v96, JS, licence screen; small, reviewable with `db-reviewer`, one
   production rehearsal); V-5b = the Training Load view reads (no migration). One PR if the manager prefers.

### 13.5 V-5a as built (the licence hierarchy)

Branch `feature/roles-v5-training-load` from `cf48c11e`, with `main` merged in at `2aada5d` (V-2). Migration v96;
runbook `docs/runbooks/roles-licence-hierarchy-v96.md`.

- **SQL (v96)**, as 13.1 says, with one change of name: the effective test is
  `public.permission_club_module_closed(club, module)` (one module at a time, what the three bodies need), not a list
  function. `public.permission_module_parent(module)` is the fixed hierarchy. The three bodies are md5-gated; the
  rollback restores them verbatim and refuses after a later migration or over a changed body.
- **JavaScript.** The hierarchy is `backend/src/permissionModules.js` (`MODULE_PARENTS`, `effectiveClosedModules`),
  its own file so that `authz.js` and `permissions.js` do not import each other (`permissions.js` re-exports it).
  `authz.js` turns each holding's stored rows into the effective set, so `can()` and `/me` need no change and the
  older role-read suites (built to v84 and v92 only) are unaffected: authz reads no v96 function.
- **`permissionLayersService.js`:** `closedModulesOf` is now the effective set (the role and custom-role checks, the
  club roles read, a user's holdings); `storedClosedModulesOf` is the stored rows (only `setCeiling` reads them, so the
  writer closes and opens exactly the rows asked for and answers `ceiling_unchanged` for a child with no row of its
  own). `ceilingView` adds `parent`, `closedByParent` and `effectivelyClosed` per module.
- **The licence screen** (`frontend/react/club-licence.jsx`, `club-licence-data.js`): a child of a part that is not
  included in the draft shows "Not included", its switch disabled (`aria-describedby` the note), and "Closed because
  Training Load is closed."; when the child is also taken out on its own, the note adds "It is also taken out on its
  own, so it stays out when you put it back." The count of included parts follows the effective state. The data side
  ignores a toggle of a greyed child.
- **Older suites and tools.** v96 replaces bodies of v92 and v95, so the v92 suite leaves v96 out with v95
  (`V92_DEPENDENTS`), the v95 suite and the v95 rehearsal stop at v95 (the rehearsal had a second bug of the same
  kind fixed here: its re-apply now reads a folder named `migrations_v2` that ends at v95). `permissions-r1` c1 lists
  the v96 rehearsal among the files that plant `club_admin` / `team_coach` rows in their own database.
- **Tests:** `roles-v96-licence-hierarchy` (8), `roles-v96-rehearsal-guards` (6), frontend
  `club-licence-hierarchy.actions` (3), e2e `roles-v5a-licence-hierarchy` (3, at 1280, 390 and 360 px). Mutations
  killed: `authz.js` without the effective set (tests 2 and 5); `closedModulesOf` reading the stored rows (test 5).
  The rehearsal passed every step on PostgreSQL 16; PostgreSQL 17 is the owner's run.
- **Review fixes (one round):**
  - mobile-qa MEDIUM: a child closed with its parent gets `is-closed-by-parent`, a default cursor and a muted name;
  - security MEDIUMs: the catalog check of the hierarchy in test 0; the runbook's rollback order (code first);
  - db MEDIUMs: test 5b (reopening Training Load refused as `409 club_admin_would_lack`, nothing changed); the
    post-check's derived, attribute and API-role checks;
  - code MEDIUMs: a parent's `ceilingEffective` counts its children's checked words (Training Load reads "follows the
    licence" since closing it closes Data configuration); the rollback refuses when a club would break v92's rule 7
    (test 4);
  - code LOW: the v92 rehearsal leaves out v95 and v96 (it had been broken since v95); it passes again.
- **After `main` took v97 (P3 references, `202611291000`):** production applies v96 after v97. The v96 suite and the
  rehearsal now build in that order; test 1c covers the fresh order (v96 first, the same bodies, and the v96 rollback
  refusing after the later v97). v97 touches none of v96's functions.


## 14. Mixed-account central fix (before the last V step)

Owner-approved order, 2026-11-25: this fix first, then V-6 (#772), V-7 (#773), V-5b (section 13), then close the V package. M steps and PL-1..PL-5 remain later.

The central rule is **roleless handoff**. When a resolved club_view/team_view request is not an authorized listed read, viewEntryGate replaces only that request's authorization context with a fresh no-old-role context before invoking the router's refusal/handoff callback. Legacy role arrays, permission holdings, managed teams and independent-coach authority are cleared. Capabilities are recomputed from the reduced context. A verified athlete identity remains available for personal endpoints; stale moduleView is removed. The authenticated user/session identity and stored role rows are never changed. This supersedes section 10's recorded behavior where a handed-on athlete plan read could still use club B's old role while club_view A was active.

organizationEntryGate applies the same rule **before** its coach-capability shortcut. Its allowed GET / retains the existing R4 reduced, workspace-scoped read; other view requests cannot reach an organization write through roles elsewhere.

The resolved read-only workspace snapshot is associated with the fresh authorization object and actor id in a WeakMap. Both workspace resolvers reuse it: a legacy handler cannot re-resolve a different coach workspace, write a fallback preference, or borrow another actor/request's snapshot. The cache is not keyed by a user id globally and no shared user object is modified.

**Boundary:** this does not open any V-6/V-7/V-5b read, add a permission word, change MANAGE rights or add a migration. Currently mounted module entry gates inherit it; future V steps inherit it when their gates are mounted. Ungated legacy routers are not claimed to have been converted by this slice. Router-specific refusal statuses/bodies and unknown-route behavior remain their existing no-old-role answers, not a new blanket 403. Personal/self relationships that the same authenticated actor can read without old roles remain unchanged; there is no invented actor id or claim that roleless always means an empty answer.

**Evidence contract:** the unit sweep applies the shared gate to every MODULE_VIEW_WORDS entry and both view types, including listed GET refusal for a missing word/closed licence, cleared cached capabilities, stale context and actor/request isolation. One real HTTP sweep covers every currently mounted gate (data configuration, presets, athletes, calendar, tests/results, plus organization), both view types, and a mixed actor with platform/independent/club/team roles elsewhere. It compares the SAME actor with those old rows temporarily disabled in the disposable fixture, checks a legitimate personal relationship, snapshots all application row counts/digests and preferences, and leaves auth/workspace selection intact. Temporary source/body mutations are run separately from the clean full gate.
