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

## 10. V-3 as built (Calendar)

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
- **Older suites:** `startCalendarApp` (`backend/tests/support/calendar-fixture.mjs`) builds its database with
  `roleRead: true`. `central-calendar-k2b-settings` builds only up to v51, so a coach's `can(calendar.view)` failed
  closed there (`503 permissions_unavailable`). It is a no-op for the suites whose list has v84 and v92.

**Review notes, recorded (not built).**
- LOW (security): non-event cards keep their `links` (session, activity and schedule ids), as a coach's reader sees
  them. They are not usable: the target routes refuse a view workspace.
- LOW (security): on the non-view path the workspace is resolved twice (the gate read-only, then the route), as in
  V-1. It can only fail closed.

## 11. V-4 as built (Tests)

Branch `feature/roles-v4-tests-view`, stacked on V-3 (`feature/roles-v3-calendar-view`). No migration.

**The gate.** `routes/tests.js` mounts `viewEntryGate("tests", …)` with seven reads:
- `GET /library`, `/schedules`, `/weekly` and `/schedules/:scheduleId`;
- `GET /schedules/:scheduleId/group`, `/results` and `/results/:assessmentId`.

Its refusal depends on the route:
- **The athlete's own routes** (`/athlete/*`, `/assignments/*`) go on as before. They decide by the athlete profile, not
  the workspace.
- **Every other route** answers `403 {error:"Forbidden"}`, what `requireCoachWorkspace` answers an account without a
  coach role. That includes `GET /today` (plan choice 2: it writes the day's occurrences) and every write.
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
  0. The day's completion counts (`counts`) are the schedule's state and stay with `tests.view`.
- **Names (P-1):** a view workspace gets no athlete names without `canView(athletes)`, which stays false until V-2:
  - the schedule's athlete targets are dropped and counted (`hiddenAthleteTargets`);
  - the group's and the results' `athleteId` and `athleteName` are null;
  - the group's rows carry no `assignmentId`;
  - the rows are no longer sorted by name (the group by state and window, the results newest first);
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
- `roles-v-sweep` test 8:
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
  (`backend/tests/support/role-read-migrations.mjs`, a second runner call over a folder named `migrations_v2`). Test 8
  also checks the club admin's link, names and scores, and the team coach's list, results and Today. No full-body
  comparison against `main` is made.
- e2e: `roles-v4-view-tests.test.mjs` at 1280, 390 and 360 px.

**Follow-ups (not built).**
- A coach whose club version keeps `tests.view` but drops `tests.results.view` is not set up in a test (no fixture
  for club role versions here); the rule is covered by the view holders and the mutation of `holds()`.
- The weekly view's "Open in calendar" stays visible for a view holder without `calendar.view`; the calendar tab is
  then not available to it.
- The remaining reads of `routes/tests.js` that branch on the athlete (`/athlete/*`) are not part of V.
