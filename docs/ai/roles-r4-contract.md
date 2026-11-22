# Roles R4 contract: the club ceiling, club versions of roles, per-user changes, the view-only workspace and the VIEW package

This is the contract of step R4 of `docs/ai/roles-permissions-plan.md` (the *plan*; section 7: "Read / manage split and the
first real role"). The owner changed that step's model on 2026-11-22 (section 1, O1-O8): R4 no longer delivers a ready
Director role; it delivers the **mechanism** in three layers - a club's ceiling, the default roles a platform admin makes, a
club's own changes per role and per user - plus a way into a club for an account that holds only a new-style role, and the
first package of permissions: the "view" words of every module. Where this document goes beyond the owner's words, the
point is marked **(recommendation)** and, when it needs the owner, collected in section 12.

| | |
|---|---|
| Status | **Proposed.** Documentation only. No code and no migration file. |
| Mark | Risky: external-review triggers 1 (a migration), 2 (auth, roles, workspace, info hiding) and 4 (lock order, idempotency) of `CLAUDE.md`. Every code pull request of section 11 that touches the server needs the *Nezavisni revizor*. |
| Written against | `origin/main` at `9ff8c3f5` (2026-11-22), which holds R1 (`can()`, #619), R2 (migration v84 and the Roles API, #676), `/me` permissions (#706), the R3 screens (#710), the tabs from permissions (#716) and the club members list (#717). Every `file:line` below is at `9ff8c3f5`. The implementation re-checks each at its own base. |
| Migration | One foundation migration, **vNN** (the number is given by the *Rukovodilac* of OptiMove when the file is written). The way into a club (section 5) needs no migration. |
| Owner's decisions | O1-O8, 2026-11-22, section 1, relayed by this stream's manager. Nothing in section 1 is the executor's wording of a decision; the wording is the manager's relay, translated. |

## 0. In short

- **Three layers, computed for the resource's club.** (1) The club's ceiling, set by a platform admin: what nobody in the
  club may have, the club's admin included. (2) The default (system) role, made by a platform admin. (3) The club's own
  changes: a club version of a role (all holders in the club) and a custom role of one user. Custom beats the club version,
  the club version beats the default, the ceiling beats all three; a platform admin passes everything, as today
  (`backend/src/permissions.js:279`).
- **One foundation migration (vNN)** adds the ceiling, the club versions, the custom roles, their history and request
  records, opens the **VIEW package** in the database (the "view" word of every module becomes storable in a role) and
  gives the basic Club admin and Team coach roles exactly the view words they already have in practice, so nobody gains or
  loses anything on the first day. The SQL twin `public.user_has_permission()` and `can()` learn the layers.
- **"Storable" is not "checked".** The database may store a view word from vNN on; a word **acts** only where a route calls
  `can()` with it. The service refuses to let anyone tick a word no route checks yet (O6: shown locked, "not available
  yet"). So the database does not need a migration per module; each module's pull request moves the word from "not yet"
  to "checked" in code (section 4).
- **The way into a club** for an account with only a new-style role is a separate workspace type, `club_view` (and
  `team_view`), O8. Six modules today treat an active club workspace as the permission itself (section 6); they do not know
  the new type, so they stay closed for it by construction. Each module learns it only in its own VIEW pull request.
- **Order (O7):** foundation -> VIEW through every module -> MANAGE module by module (Calendar and Training Load first,
  Imports last).

## 1. Owner decisions (2026-11-22, relayed by this stream's manager)

| # | Decision (as relayed) |
|---|---|
| Model | "I build the protection on the server; the platform admin makes the roles and ticks the defaults; the club's admin adds and takes away in its own club." Three layers, computed per resource in the club. |
| O1 | **Club ceiling** (set by the platform admin; for example a club without imports because it has no licence): nobody in the club goes above it, the club's admin included. The platform admin is exempt (D6f; `can()` passes it before anything else, `permissions.js:279`) - the owner asked explicitly that he himself not be limited in the clubs he works in. When a part is switched off for a club, the right ends at once for everyone in the club; the assignments and ticks stay recorded and come back when the part is switched on again. (These are the plan's module switches, sections 3.3 and 5; they now enter this step.) |
| O2 | **Default role** (system; made and changed by the platform admin). R4 does NOT deliver a ready Director, Assistant coach or Analyst; the plan's D8 falls away. |
| O3 | **Club version:** while the club's admin changes nothing, the role in the club follows the default. The admin's FIRST change (adding OR taking away a word) AUTOMATICALLY makes the club's version (no manual "copy"); it acts at once for EVERYONE holding the role in that club, old and new, and for every later assignment in that club. When the platform admin later changes the default, the club's admin gets a QUESTION showing the difference; if they accept, the club moves to the new default (dropping its own version); if not, it stays on its own. |
| O4 | **Per user:** the club's admin opens a user and adds or takes away a word relative to the user's role -> that user's role in that club AT ONCE becomes "custom" (shown "<Role> (custom)", remembers which role it came from, holds only for that user in that club, never appears in the role list as assignable to others). Custom is FROZEN: later changes of the role (the club's or the default) do NOT reach it. Assigning the basic role again = back to what the club has for that role. The screen lists the differences from the current role. A per-user change is STRONGER than the role; the club ceiling is stronger than both. This CHANGES the plan's 2.1 ("No per-user ticks in the first version"). |
| O5 | **Club admin:** may widen and narrow its own club's roles and users, up to the club's ceiling and up to its own level (R2's ceiling and dominance stay). May NOT narrow itself or another admin of the same club; only the platform admin narrows an admin. The plan's 2.1 rules 5 and 7 and "a club never loses its last holder of `staff.assign`" stay. |
| O6 | **Taking away acts on existing coaches and admins too** (the old tables), but a word acts only once its module moves to `can()`. Until then the tick is LOCKED in the editor, marked "not available yet" (it must never look as if something was taken away when it was not). On the first day nobody gains or loses anything: old-vs-new tests per role. |
| O7 | **Order:** (1) foundation; (2) "VIEW" through all modules; (3) "MANAGE" in this order: Calendar + Training Load (activities, RPE schedules, roster, dashboards) -> Builder / programs / exercises -> Tests + messages -> Data configuration -> IMPORTS LAST (the import licence is not needed for at least three months). |
| O8 | **Way into a club** for an account with only an R2 assignment: option (A) of the discovery - a separate type `club_view`; the preference is stored as `club` + scope and mapped in `workspace.js` (no migration for the way in itself); fail-closed by construction; the finding about the six modules that authorize by workspace is a MANDATORY section, with a test "account without an admin row x every workspace helper". |

**Changes to the plan these make** (to be carried into the plan by a later small docs pull request, as R2 did):
- 2.1, "No per-user ticks in the first version" - replaced by O4.
- 2.1 rule 8 ("a club's copy of a system role is a snapshot ... notice") - replaced, for club versions, by O3 (section 3.3
  says what stays of R2's copy).
- 4, the proposed Director, Assistant coach and Analyst rows and D8 - fall away (O2).
- 3.3 and 5, module switches "a later migration of their own" - they enter vNN as the club ceiling (O1). The per-coach
  (private) switch of the plan is not in R4 (Q9).
- 7, the R4 row - replaced by section 11 of this document.

## 2. What exists today (the facts R4 builds on)

| Fact | Evidence |
|---|---|
| A role is a `permission_roles` row with items in `permission_role_items`; system or club owner; a club's copy records `copied_from_role_id` / `copied_from_revision`. | `migrations_v2/202611201300_roles_v84_permission_roles.sql:100-130`, `:134-141` |
| Only a platform admin changes or archives a system role; a club's admin cannot add to a system role without a copy. | `backend/src/permissionRolesService.js:692-693`, `:796-797`, `:845` |
| Ceiling: one may give only words one holds (`permission_not_held`); dominance: a role or assignment stronger than oneself is refused (`role_exceeds_your_permissions`, `user_holds_role_items`). | service `:547-551`, `:665`, `:735-736`, `:818`, `:1010`; v84 `:478` |
| A word may be stored in a role only if "honoured": the code constant and its database twin, 7 words. | `backend/src/permissions.js:211-219`; v84 `permission_word_honoured()` `:397-404`, item guard `:819` |
| The basic roles' items: Club admin 7 words, Team coach 3. | v84 `:350-366` |
| No per-user permissions exist; an assignment carries only a display title. | v84 `:230-260` (`user_role_assignments`) |
| No module switch per club exists; only a per-role display (hidden / locked). | v84 `:145-150` (`permission_role_module_display`) |
| A club workspace is offered only to a `club_admin` row, a team workspace only to a `team_coach` row. | `backend/src/workspace.js:46-61` |
| The organization router is behind `requireCoach`, which passes only an account with a role of the old tables. | `backend/src/server.js:144`, `backend/src/auth.js:158-161`, `backend/src/authz.js:183-196` |
| The saved workspace preference allows exactly five types. | `migrations/20260805_user_workspace_preferences.sql:25` |
| `/me` returns the words of the active workspace from `can()`. | `backend/src/routes/auth.js:84-105`, `backend/src/permissions.js:312-330` |

## 3. The model

### 3.1 Terms

- **Default role** - a system role (`owner_scope = 'system'`), including the basic roles. Made and changed by a platform
  admin (O2).
- **Club version** - the club's own item set for one system role, used for every holder of that role in that club (O3).
  Made automatically by the club admin's first change. It is not a new role a person is assigned: holders stay assigned to
  the system role.
- **Custom role** - one user's own item set for one held role in one scope, frozen at the moment it was made (O4).
- **Club ceiling** - the modules (section 12, Q1: and possibly single words) closed for a club (O1).
- **Checked word** - a word some route calls `can()` with (code constant `ENFORCED_PERMISSIONS`, section 4).
- **Storable word** - a word the database lets a role, a club version or a custom role hold (`permission_word_honoured()`).

### 3.2 The effective permission (the order of evaluation)

For an account U, a word W and a resource scope S (a club C, or a team T of club C):

1. W unknown, or S's type unknown -> a programming error (throws; unchanged).
2. U is a platform admin -> **yes** (O1; unchanged, `permissions.js:279`).
3. The role tables could not be read -> throws `PermissionsUnavailableError` (unchanged).
4. W platform-only, or S global -> **no** (convention 1, unchanged).
5. S without an id -> **no** (convention 3, unchanged).
6. **Ceiling.** W's module (or W itself, if Q1 allows words) is closed for C -> **no**. A team without a club has no
   ceiling (section 12, Q10).
7. **Held roles.** The roles U holds for S: the old tables mapped to the basic roles, and active `user_role_assignments`
   (a club's role reaches its teams, convention 2) - exactly as in R2.
8. **Item set of each held role** (the first that applies):
   1. a live custom role of U for that role in that held scope (section 3.4) -> its frozen items;
   2. the role is a system role and club C has a live club version of it -> the club version's items;
   3. otherwise the role's own items.
9. **yes** if any item set of step 8 holds W; else **no**.

The ceiling is step 6, before the roles, so a club's version or a custom role can never open what the ceiling closed, and
a ceiling that opens again brings back exactly what was recorded (O1).

### 3.3 Club versions and R2's copies

- **What stays of R2.** A club's admin may still copy a system role into a new club role under a new name ("copy as a new
  role", `permissionRolesService.js:845`); such a copy is an independent club role, never follows the default and is
  assigned on its own. **(recommendation, Q7)**
- **What is new.** A club version is not a copy: same identity, same name, the same assignments; the club admin edits "Team
  coach in my club" and every holder there, old-table coaches included (O6), gets the new set the moment the module's word
  is checked.
- **Existing assignments move without a new assignment.** Step 8.2 is read at request time, so an existing assignment (or
  an old-table row) of the system role in club C uses the club version from the moment it exists. Nothing is rewritten.
- **The question after a default change (O3).** A club version records the default's revision it was based on
  (`based_on_revision`) and the last revision the club answered (`answered_revision`). When the default's revision is
  newer than both, the club's admin sees the question with the difference (default before -> default now, and the club's
  version). *Accept*: the club version is ended; the club follows the default. *Keep mine*: `answered_revision` becomes
  the current revision; no question until the next change. **(recommendation, Q6)**
- **Club admin's own role.** By O5 a club admin narrows neither itself nor another admin, and widening Club admin above
  itself is impossible by the ceiling rule. So the club version of the basic **Club admin** role is not offered to a club's
  admin at all; only a platform admin changes Club admin (the default). **(recommendation, Q3)**

### 3.4 Custom roles (O4)

- Made by the first per-user change of one held role in one scope (a club, or one team for a team-scoped role). Its
  items: the item set the user had for that role at that moment (step 8 of 3.2, without the ceiling), plus the words added,
  minus the words taken away. From then on it is frozen.
- Shown "<Role> (custom)"; it remembers the role it came from and the revision it was frozen at; never listed as
  assignable to anyone else.
- **Ends** when: the club admin assigns the basic role again ("back to the club's role"); the underlying assignment or
  old-table row ends (revoked, expired); the user is narrowed back to exactly the club's set by the screen's *Reset*.
  An ended custom stays as history.
- **One custom per (user, role, scope).** A user who is Team coach in two teams can have a custom in one and not the other.
  **(recommendation, Q4)**
- **Admins (O5).** No custom of a holder of the Club admin role (old row or assignment) in that club by a club's admin;
  a platform admin may. **(recommendation: a platform admin may; O5 says only he narrows an admin.)**

### 3.5 What a club's admin may change (O5, with R2's rules)

| Change | Allowed when |
|---|---|
| Add a word to a club version or a custom role | the word is checked (O6), storable, not closed by the club's ceiling, and the admin holds it in the club (R2 ceiling rule) |
| Take a word away | the word is checked (O6); the target is not Club admin (3.3) and not an admin's custom (3.4) |
| Any change | R2's dominance: the admin holds every item of the resulting set (`user_holds_role_items`); the three system-role-only words stay Club admin's (2.1 rule 5); the club keeps a holder of `staff.assign` (rule 7) |

### 3.6 Truth table (word W of a module that is checked, club C)

| # | Platform admin | Ceiling closes W in C | Custom of U | Club version | Default | Answer |
|---|---|---|---|---|---|---|
| 1 | yes | any | any | any | any | yes |
| 2 | no | yes | holds W | holds W | holds W | **no** |
| 3 | no | no | holds W | lacks W | lacks W | yes |
| 4 | no | no | lacks W | holds W | holds W | **no** (custom beats role) |
| 5 | no | no | none | holds W | lacks W | yes |
| 6 | no | no | none | lacks W | holds W | **no** (club version beats default) |
| 7 | no | no | none | none | holds W | yes |
| 8 | no | no | none | none | lacks W | no |
| 9 | no | no | none (club version of role A lacks W) | - | role B (second role) holds W | yes (roles add up, plan 2.3) |
| 10 | no | closed, then reopened | holds W | - | - | yes again, nothing rewritten (O1) |
| 11 | no | no | holds W, but W not checked yet | - | - | the word acts nowhere (no route asks) |

## 4. "Storable" and "checked": the VIEW package without a migration per module

**The problem.** A word must be in `permission_word_honoured()` (v84 `:397-404`, `IMMUTABLE`) to be stored in a role
(`:819`), and the ceiling rule means a club's admin can give only words it holds - and Club admin holds only 7
(`:356-366`). So each new word would need a migration (the function and Club admin's items).

**The proposal.**
- vNN opens the whole **VIEW package** in the database at once: `permission_word_honoured()` is replaced so every view word
  of section 4.1 is storable, and the basic roles get the view words their holders already have in practice (4.1). The
  MANAGE words come with their own later migration, one per O7 module step or one for several **(recommendation, Q11)**.
- A new code constant, `ENFORCED_PERMISSIONS` (`backend/src/permissions.js`), lists the checked words. It starts as today's
  7 honoured words. Each module's VIEW pull request adds its word in the same pull request that adds the `can()` call
  (a test asserts each listed word has a call site, and each call site's word is listed; the R2 equality test of
  `HONOURED_PERMISSIONS` becomes this test).
- **The service refuses every write that adds or takes away an unchecked word** (`permission_not_available_yet`) in a club
  version, a custom role, a club role and a non-basic system role; the editor shows it locked, "not available yet" (O6).
  The only items of unchecked words are the ones vNN seeds into the basic roles, which mirror today's behaviour.
- **Why not a database flag flipped per module.** "Checked" means "a route in the deployed code calls `can()` with it"; that
  is a property of the code release, not of data. A table the platform admin could flip would let a word look checked
  while no route checks it (or the reverse after a rollback of the code). The code constant moves with the code.
- **Why this is safe.** A stored but unchecked word acts nowhere: no route asks for it. The only way to store one outside
  the seed is the service, which refuses. A direct SQL write is out of contract (as R2's raw writes are) and is refused by
  the v84 actor guards anyway.
- **The ceiling is different (Q12).** A club's ceiling closes a module even before its words are checked only where an
  entry gate asks for it (section 7.4).

### 4.1 The VIEW package (the words, and who holds them on day one)

| Module | View word(s) | Club admin today | Team coach today | Evidence of today's reach (module's read gate) |
|---|---|---|---|---|
| Organization | `org.view` | yes (seeded in v84) | yes (seeded) | already checked |
| Athletes | `athletes.view` | yes | yes | `backend/src/access.js:213-243` (role SQL, any role word) |
| Programs | `programs.view` | yes | yes | `requireCoach` on `/api/builder`, `server.js:139`; `canAccessPlan` |
| Exercises | `exercises.use` | yes | yes | `requireCoach`, `server.js:137-138` |
| Tags and presets | `presets.use` | yes | yes | `requireCoach`, `server.js:145`; `routes/taxonomy.js` |
| Calendar | `calendar.view` | yes | yes | `backend/src/calendarAccess.js:41-51` (workspace) |
| Training Load | `load.view.team`, `load.view.athlete` | yes | yes | `trainingActivityAccess.js:20-26`, `trainingLoadAccess.js:25-86`, `trainingLoadMetricsAccess.js:28-56` (workspace) |
| Dashboards | `dashboards.view` | yes | yes | `trainingLoadDashboardAccess.js:46-64`, `:252-257` (workspace) |
| Imports | `import.check` | yes | yes | `gpexeImportAccess.js:31-37` (`canManageTeamById`) |
| Tests | `tests.view`, `tests.results.view` | yes | yes | `testsAccess.js` `canManageSchedule`; `routes/tests.js:146` |
| Data configuration | `variables.view` | yes | yes (C99) | `sourceMetricAccess.js:100-106` |
| Messages | none (`messages.send` is MANAGE) | - | - | per user |

"Yes" in the two role columns is the intent read from the gates above; each module's VIEW pull request proves it for its
module by old-vs-new tests and corrects this table where the code says otherwise (plan 4.1). A word the code shows a
coach does not have today is not seeded for Team coach. The Independent coach role gets no view word in vNN: the private
workspace keeps its workspace-based checks in R4 **(recommendation, Q10)**. Rule 7 (Club admin holds every club-scope word
any system role holds) holds after the seed.

## 5. The way into a club (O8)

### 5.1 Server

- **`loadAvailableWorkspaces`** (`workspace.js:37-67`) also offers, for every club C where the account holds a live
  new-style assignment (club scope, an active club) and **no** active `club_admin` row: `{ type: "club_view", scopeId: C,
  role: "role_holder" }`; and for every team T (active) with a live team-scoped assignment and no `team_coach` row:
  `{ type: "team_view", scopeId: T, clubId }`. It reads the assignments from `authz.roleAssignments`
  (`authz.js:173-179`), already loaded; no new query for the ids, one for the names (the existing pattern, `:48-55`).
- **Preference without a migration.** `user_workspace_preferences` allows five types (`migrations/20260805_…:25`). A
  `club_view` choice is stored as `club` + C; `resolveActiveWorkspace` / `resolveActiveWorkspaceReadOnly` /
  `validateWorkspaceSelection` (`workspace.js:73-150`) map a stored `club` + C to `club_view` + C when the account has no
  admin row for C and has a live assignment there. A later admin row for C makes the same preference resolve to `club`.
  `PUT /api/auth/workspace` accepts `club_view` and stores `club`.
- **`computeCapabilities`, `requireCoach`, `managedTeamIds`, `holdsClubAdminRole`, `canManageClub`, `canManageTeamById`
  are not changed** (plan 2.1 rules 1 and 12). A `club_view` holder does not pass `requireCoach`.
- **The organization router** (`server.js:144`) gets one entry gate in front of `requireCoach`: an account that passes
  `requireCoach` goes on as today; an account whose active workspace is `club_view` or `team_view` reaches **only** the
  read routes on an explicit list (`GET /`; nothing else in R4), and every other method and path answers exactly what it
  answers today (403 `Forbidden`). This keeps every write - `POST /athletes`, whose only gate is `requireCoach` and the
  athlete's club or team (`organization.js:1357`) - closed by construction.
- **`GET /api/organization` for `club_view`.** `loadClubs` / `loadTeams` (`organization.js:3225`, `:3303`) learn a branch for
  `can(org.view)` on the workspace's club (the club and its active teams); `loadManagedAthletes` a branch for
  `can(athletes.view)` (the club's athletes, read-only); `loadUsers` returns the account itself only, as today for an
  account without a role (the members list stays gated on `staff.assign`, #717); join links, invites and applications
  stay empty (`loadJoinLinksForWorkspace` `:229-246` does not match `club_view`). `filterOrganizationDataForWorkspace`
  (`:51-114`) treats `club_view` as `club`. `canCreateTeam` / `canCreateUser` stay `false` (`:380-382`).
- **`/me`** (`routes/auth.js:66-115`): `permissionsForWorkspace` maps `club_view` -> club scope, `team_view` -> team scope
  (`permissions.js:312`), and returns the checked words held there (no longer `HONOURED_PERMISSIONS`: `ENFORCED_PERMISSIONS`),
  plus `closedModules` of the club's ceiling (module words only, never data), so navigation can hide a closed module.

### 5.2 Frontend

| Place | Today | R4 |
|---|---|---|
| `frontend/access.js:33` `STAFF_WORKSPACE_TYPES` | four staff types | unchanged; a new `VIEW_WORKSPACE_TYPES` (`club_view`, `team_view`) |
| `access.js:58` `hasOrganizationAccess` | staff types | also `VIEW_WORKSPACE_TYPES` when `org.view` is held |
| `access.js:36-56` `accessScopeLabel` | five types | the club's or team's name |
| `frontend/navigation.js:69` `isCoachSettings`, `:84-110` `renderLibraryNav` | team / private coach | `club_view` / `team_view` show only Settings sections whose word is held (`permission-nav.js`); every other section (Builder, Calendar, Training Load, Tests, Exercises, Program Library) is hidden until its module's VIEW pull request adds its word to `permission-nav.js` |
| `frontend/permission-nav.js:22-40` | fallback `legacy` when a word list is missing | for a view workspace the fallback is **hidden**, never `legacy` |
| `frontend/coach-home.js` (Home) | lists coaching workspaces | a short Home for a view workspace: the club's name and the sections it may open |
| `workspace-actions.js` | five types in the switcher | the two new types, labelled with the club or team |

19 frontend files branch on the workspace type (53 places, `grep "workspace.type\|activeWorkspace?.type"` at
`9ff8c3f5`). Only the ones above change in R4; the rest do not recognize the new types and show nothing for them, which is
the intended fail-closed state; each module's VIEW pull request opens its own.

## 6. Mandatory: the six modules that authorize by workspace (O8)

Today the active workspace **is** the permission in six modules, contrary to `workspace.js:6-12` ("a workspace never grants
a permission"). It is safe only because a club workspace exists solely for a `club_admin` row (`workspace.js:46`). Had R4
offered a `club` workspace to an account without that row, it would have read - and in four modules written - the club's
data. `club_view` closes this by construction: none of the helpers below recognizes it. Each module's VIEW pull request
then replaces the workspace basis with `can()`.

| Module | Helper (`file:line`) | What it trusts | Would have given a role holder in a `club` workspace | View helpers to move | Manage helpers |
|---|---|---|---|---|---|
| Calendar | `calendarAccess.js:41-51` `resolveCalendarContext`, `:136-140`, `:178-184`, `:285-310`; `routes/calendar.js:51-108`; `calendarEventService.js:584-630` | workspace type and id | plans, sessions, activities, events, tests and athlete names of the club; event types and places | 3 | already by role (`calendarEventAccess.js:76-101`, `calendarSettingsService.js:51-63`): 2 to move to `can()` |
| Training activities | `trainingActivityAccess.js:20-26` `scopeFromWorkspace`; `routes/trainingActivity.js:145-225` (read), `:183-191`, `:341-500` (write) | workspace | club activities and results; **writes**: match suggestions, reparent / merge, materialize | 2 | 2 + roster (`activityRoster.js:77-83`, already by role) + database guard v26 |
| External RPE schedules | `trainingLoadAccess.js:25-86`; `routes/trainingLoad.js:765-784`, `:2111-2808` | workspace | club schedules; **writes**: create, change, reminders to athletes, planned-RPE setting | 1 | the same helper + 2 predicates |
| Measurements | `trainingLoadMetricsAccess.js:28-56`; `routes/trainingLoadMetrics.js:510-599` | workspace | club measurements; **writes**: events, corrections | 2 | 2 + the catalog (already by role) + database guards |
| Dashboards | `trainingLoadDashboardAccess.js:46-64` `dataWorkspaceFromActiveWorkspace`, `:199-210`, `:252-257` `canViewDashboardRow`, `:319-362` (list); `dashboardSimple/previewContext.js:21-84` | data workspace | club dashboards; a private dashboard bound to the club, then queries over any club data | 3 + dashboardSimple | `canManageDashboardRow` (club_admin) + v19's basis |
| Session types | `sessionTypeService.js:43-54` | workspace | the club's session types | 1 | 1 (`:66`, by role) |

The inventory was made by reading the code (the main session read the four central helpers; a search agent listed the
rest); each VIEW pull request re-derives its rows. Modules behind `requireCoach` (Builder, exercises, taxonomy,
organization) or `requireCoachWorkspace` (Tests, `routes/tests.js:146`; Training Load weekly, `routes/trainingLoad.js:67`)
answer 403 to a view workspace today; modules that check a role (imports `gpexeImportAccess.js:31-37`, source metrics
`sourceMetricAccess.js:100-106`, source connections `sourceConnectionService.js:192-202`, roster, event writes, calendar
settings) answer 404.

**Mandatory test (O8):** an account with only a club-scope assignment holding every view word, in a `club_view` workspace,
against every helper of this table and every route behind it: no club row in any answer, no write; after its module's VIEW
pull request, exactly the read that module opens and nothing else. The same test with a forged `club` preference row for
that account (it resolves to `club_view`, never `club`).

## 7. Schema of the foundation migration vNN

All in `public`, the conventions of v84 (`roles-r2-contract.md` section 2): row-level security without a policy, `REVOKE`
from `PUBLIC` / `anon` / `authenticated`, every foreign key `ON DELETE RESTRICT` with an index, fixed refusal messages
(`42501` "may not", `23514` "not allowed"), free text through `permission_text_ok`, the acting user through
`permission_context_actor()` (v84 `:372-384`), append-only change records with the same-transaction rule.

### 7.1 `club_permission_ceiling` and `club_permission_ceiling_changes` (O1)

| Table | Columns | Rules |
|---|---|---|
| `club_permission_ceiling` (current state) | `club_id` FK clubs, `module_word` FK `permission_modules`, `closed_by_user_id`, `closed_at`, `reason` | primary key (`club_id`, `module_word`); a row means "closed"; no row means open (no backfill). INSERT and DELETE only, by a platform admin (actor guard), each with a change row in the same transaction; UPDATE refused. Q1: a `permission_word` column if single words are wanted. |
| `club_permission_ceiling_changes` | `id`, `club_id`, `module_word`, `action` (`close` / `open`), `performed_by_user_id`, `reason` (required), `created_at` | append-only (UPDATE, DELETE, TRUNCATE refused) |

The `organization` module cannot be closed (a club must stay reachable by its admin; `23514`) **(recommendation)**.

### 7.2 `permission_club_role_versions` and their items and changes (O3)

| Table | Columns | Rules |
|---|---|---|
| `permission_club_role_versions` | `id`, `club_id`, `system_role_id` FK `permission_roles`, `based_on_revision`, `answered_revision`, `created_by_user_id`, `created_at`, `ended_at`, `ended_by_user_id`, `end_kind` (`accepted_default` / `reset`) | unique (`club_id`, `system_role_id`) where `ended_at is null`; the system role must be `owner_scope = 'system'`, not Platform admin, not archived; Club admin only by a platform admin (3.3) |
| `permission_club_role_version_items` | `version_id`, `permission_word` | primary key; insert and delete only by the guard's rules (storable, not platform-only, system-role-only words never; covers the role's scope types) |
| `permission_club_role_version_changes` | append-only: `version_id`, `kind` (`create`, `change`, `answer_keep`, `accept_default`, `reset`), words added / removed, reason, actor, basis | the v84 change-record pattern |

An archived system role: its club versions stay as history and give nothing (the role gives nothing, v84 `:138`).

### 7.3 `permission_custom_roles` and their items and changes (O4)

| Table | Columns | Rules |
|---|---|---|
| `permission_custom_roles` | `id`, `user_id`, `base_role_id`, `scope_type` (`club` / `team`), `scope_id`, `club_id` (generated or checked: the scope's club), `frozen_from` (`default` / `club_version` / `club_role`), `frozen_from_revision`, `frozen_from_version_id`, `created_by_user_id`, `created_at`, `ended_at`, `ended_by_user_id`, `end_kind` (`reassigned` / `role_ended` / `reset`) | unique (`user_id`, `base_role_id`, `scope_type`, `scope_id`) where `ended_at is null`; the user must hold `base_role_id` in that scope when it is made; Club admin's custom only by a platform admin |
| `permission_custom_role_items` | `custom_role_id`, `permission_word` | as 7.2 |
| `permission_custom_role_changes` | append-only, as 7.2 | |

A custom role is **not** a `permission_roles` row: it can never be listed or assigned (O4) and needs no name.

### 7.4 The VIEW package and the ceiling entry gates

- `permission_word_honoured()` replaced (`CREATE OR REPLACE`, md5 precondition on the v84 body): v84's seven words plus
  the view words of 4.1.
- The seed: the view words of 4.1 into Club admin and Team coach (`permission_role_items`, one `permission_role_changes`
  row of kind `migration` per role, v84's M15 path `:677-680`).
- **Entry gates of the ceiling for unmoved modules (Q12).** O1 says a closed part ends "at once"; a module whose words are
  not checked yet is not reached by step 6 of 3.2. **Recommendation:** each module's entry check gets one cheap ceiling test
  in its VIEW pull request; until then a closed module still works for coaches and admins of that club. For Imports (O7:
  last) a single gate in `gpexeImportAccess.js` can come earlier if the licence is needed sooner.

### 7.5 The twin and the lock function

- `public.user_has_permission()` replaced (md5 precondition) with steps 6 and 8 of 3.2; `user_holds_role_items()` unchanged
  in shape. Tests prove the twin and `can()` agree over the whole truth table and a random matrix.
- `public.lock_permission_actor()` replaced: the lock order below.

### 7.6 One lock order (extends R2's section 4.3; users first)

1. The acting user's `users` row (a statement of its own); for a write that names another user (a custom role, an
   assignment): both `users` rows in one statement, id order (R2 4.3 place 2).
2. The old tables' rows of the user(s), then `user_role_assignments` by id (R2 place 3).
3. **New:** `permission_custom_roles` rows of the user(s) in the scope, by id.
4. Role rows by id (R2 place 4), then **new:** `permission_club_role_versions` rows of club C, by id.
5. **New:** the club's row in `public.clubs`, `FOR SHARE` for a reader of the ceiling, `FOR NO KEY UPDATE` for a ceiling
   change (absent ceiling rows cannot be locked, so the club row stands for "the ceiling of C").
6. The request record (`permission_requests`).

Recorded-SQL-order tests (the rule of `.claude/rules/migrations.md`) for every new write, and route-against-route tests:
a ceiling close against a holder's guarded write; a club version change against a custom made from it; a custom made
against the target's revocation. **Known cost:** a guarded write share-locks its club row, so a club rename waits for it
(milliseconds). The db review checks this against the existing club writes of `organization.js` (archive, edit) before the
implementation.

### 7.7 Request records, rollback, preflight, post-check

- `permission_requests.operation` widened: `ceiling_close`, `ceiling_open`, `club_version_change`, `club_version_answer`,
  `custom_change`, `custom_end`, with their result columns (the v36 pattern; a lost COMMIT is never a second write).
- **Rollback** (rehearsed): refuses once any ceiling row, club version, custom role or a new request row exists, or a later
  migration is recorded; otherwise restores the v84 bodies by md5 and drops the new objects. Forward-only after first use.
- **Preflight** (read-only): v84 recorded with its checksum; the v84 bodies' md5; no row of a new table; the basic roles'
  items equal v84's seed. **Post-check**: vNN recorded; the new bodies' md5; the seeded words; zero new rows.

## 8. `can()`, `loadAuthorizationContext()` and `/me`

- `ROLE_PERMISSIONS_SQL` (`authz.js:114-138`) returns per held entry the **effective** words of 3.2 step 8 (custom ->
  club version -> role), and once per club the closed modules. One statement, as today.
- `can()` (`permissions.js:272-292`) adds step 6 (the closed modules of the resource's club, from the loaded context).
  No query in `can()`. The comment's three conventions stay.
- `permissionsForWorkspace` (`:312-330`) returns checked words held in the workspace's scope, and the closed modules.
- Old-vs-new: for every existing account and every checked word, the answer is R2's on the day of the deploy (no ceiling,
  no club version, no custom exists yet).

## 9. API and screens

All under `/api/organization/roles` (the R2 router, mounted behind `requireAuth` only, `server.js:140-143`), the R2
conventions: 404 before 403 (rule 11), a `requestKey` on every write, the bounded COMMIT, stable codes.

| Route | Who | What |
|---|---|---|
| `GET /clubs/:clubId/ceiling` | a platform admin; the club's admin reads it (Q2) | the closed modules |
| `POST /clubs/:clubId/ceiling` `{requestKey, close: [...], open: [...], reason}` | a platform admin only; everyone else the identical 404 | closes / opens modules |
| `GET /clubs/:clubId/roles` | holders of `org.view` in the club | the system roles with the club's state (follows default / own version / question pending), and the club's own roles |
| `POST /:roleId/clubs/:clubId/version` `{requestKey, expectedRevision, add, remove, reason}` | the club's admin (3.5); a platform admin | makes or changes the club version |
| `POST /:roleId/clubs/:clubId/version/answer` `{requestKey, systemRevision, choice: "accept_default" \| "keep_mine"}` | the club's admin; a platform admin | the O3 question |
| `GET /users/:userId/clubs/:clubId` | the club's admin; a platform admin; anyone else 404 | the user's held roles there, effective words, custom state and the difference from the role |
| `POST /users/:userId/clubs/:clubId/custom` `{requestKey, roleId, scopeType, scopeId, add, remove, reason}` | as above, 3.4 and 3.5 | makes or changes a custom role |
| `POST /users/:userId/custom/:customId/end` `{requestKey, reason}` | as above | back to the club's role |
| `GET /assignments` (R2) | as R2 | each row carries `custom: true` and "<Role> (custom)" where it applies |

Codes added: `permission_not_available_yet`, `closed_by_club_ceiling`, `admin_not_narrowable`, `custom_exists`,
`version_changed` (stale `expectedRevision`), `question_outdated`.

**Screens (frontend PR, section 11):**
- Settings > Clubs (platform admin): *Club licence* - each module on / off, with a reason.
- Settings > Roles (club's admin): a system role opens as "<Role> in <Club>"; ticking or unticking makes the club version
  at the first Save (O3), with the note "applies to everyone with this role in <Club>"; a pending default change shows the
  difference and *Use the new default* / *Keep ours*.
- Settings > Users (club's admin): a user's roles in the club; ticking or unticking makes "<Role> (custom)" with the list of
  differences, and *Back to <Role>*.
- Every unchecked word is a locked tick, "Not available yet"; every word closed by the club's licence is a locked tick,
  "Not in your club's licence".
- "Who holds what": the custom mark.

## 10. Races and time

| Case | Answer |
|---|---|
| A ceiling close, club version change or custom change while a request of an affected user is in flight | The request's `can()` answer was taken at its start (as R2, `roles-r2-contract.md` 9); a route with a database guard re-checks under the locks of 7.6 and refuses; a route without one finishes under the answer it started with (stated limit, unchanged from R2) |
| An assignment expires during a request | as R2 (`expires_at` read at the request's start; the guard re-reads under lock) |
| A custom made while the target's assignment is revoked | both lock both `users` rows first (7.6 place 1); the second sees the first's result: a custom of an ended role is refused `404` |
| Two admins change the same club version | `expectedRevision` -> `version_changed` |
| The default changes while the club's admin edits its version | the edit carries `expectedRevision` of the version; the question appears after it |
| The active workspace stops being available (assignment ended) | as today: the next `/me` falls back (`workspace.js:119-139`); the frontend reads `/me` after a workspace change (#716) |
| Re-check of a role on a retry | every retry re-evaluates (`backend-security.md`, idempotent retries) |

## 11. Inherited obligations

- **(a) #717, L3 of the *Nezavisni revizor*:** the gate `can(staff.assign, clubScope)` in `clubMembersViewClubId`
  (`organization.js`, GET `/`) has no test that kills it. With view workspaces it is the only thing that keeps the members
  list from a `club_view` holder: a test with a role holder of `org.view` only, in `club_view`, that the list holds only the
  account itself, and a mutation that removes the gate fails it. In R4-2.
- **(b) R2 assignments in Users:** `loadUsers` reads only the old tables, so a role holder is invisible to the club's admin.
  R4-2 adds the club's live assignments to the club members rule of #717 (an account with a live assignment in the club
  or one of its teams is a member), narrowed as #717 narrows.
- **(c) LOW-1 of #706:** a platform admin in a club or private workspace gets every word in `/me`. Kept on purpose (O1:
  the platform admin is not limited); `permission-nav.js` keeps the platform-only sections on the workspace type
  (`:10-12`). Recorded, no change.
- **(d) `permission-nav.js`:** the fallback rule of 5.2; Settings tabs for a view workspace; the "not available yet" state
  is never shown as a hidden tab.

## 12. Open questions for the owner (each with a recommendation; none is decided here)

| # | Question | Recommendation | What it changes |
|---|---|---|---|
| Q1 | Does the club licence close whole parts only, or also single things inside a part (for example "Training Load yes, but no named athletes")? | Whole parts only for now. | Single things later need one more column, no rebuild. |
| Q2 | A part closed by the licence: what does the club's admin see? You decided earlier (D6f) "locked, with a padlock"; the R3 screens decided "no padlock yet" (Q2 of R3). | For now the part is simply not there for everyone in the club; the padlock comes with the screen work after VIEW. The club's admin sees the licence list in Settings. | Only the screens. |
| Q3 | May the club's admin change the Club admin role in its club? | No. Only the platform admin changes Club admin (it would narrow the admin themself or other admins, which O5 forbids). | Club admin is the same in every club unless you change it. |
| Q4 | A person who is coach in two teams: is "custom" per team? | Yes, per team. | A change in one team does not touch the other. |
| Q5 | The club's version of a team role (for example Team coach): one version for all teams of the club? | Yes, one per club. | Different teams of one club cannot have different coach rights except per person. |
| Q6 | You change a default role, the club says "keep ours"; you change it again: does the club get the question again? | Yes, every time the default changes, with the difference since its last answer. | More questions, but nothing changes silently. |
| Q7 | The R2 "copy as a new role" button (a club role with a new name): keep it? | Keep it, for roles the platform does not have. A copy never follows the default. | Two ways for a club: change a default role, or make its own. |
| Q8 | Does the club's admin see what the licence closed, in the role and user screens? | Yes, as locked ticks "Not in your club's licence". | Only the screens. |
| Q9 | A licence for an independent coach (private workspace), like the club's? | Not now; it comes with the subscription levels (plan 3.1). | Nothing in R4. |
| Q10 | A team without a club: does any licence apply? | No licence applies; only the platform admin's own rules. | Nothing. |
| Q11 | The MANAGE words: one migration per part (Calendar, Training Load, ...) or one for several? | One per step of O7 (it ships with the part that starts checking them). | Five small migrations instead of one large one. |
| Q12 | You said a closed part ends "at once". A part that does not check the new rights yet (everything except Settings until its VIEW step) cannot see the licence. Is it enough that each part starts obeying the licence in its VIEW step, with Imports able to get an earlier gate if the licence is needed sooner? | Yes. | Until a part's VIEW step, closing it in the licence has no effect for that part; the screen says so. |
| Q13 | May a platform admin make a "custom" for a club's admin? | Yes (O5 says only the platform admin narrows an admin). | - |

**For the *Rukovodilac* of OptiMove (technical, recommendation of this document):** the "checked" list as a code constant
and not a database flag (section 4); the club row as the lock of the ceiling (7.6 place 5); the migration number vNN.

## 13. Pull requests and order

| PR | What | Level | Reviews | Depends on |
|---|---|---|---|---|
| R4-0 | This contract | docs | code, security, db; the *Rukovodilac* | - |
| R4-1 | Migration vNN (7.1-7.7), the twin, `can()` / `loadAuthorizationContext()` layers, `ENFORCED_PERMISSIONS`, old-vs-new and truth-table tests | **risky** (triggers 1, 2, 4) | db, security, code; *Nezavisni revizor*; the owner's order naming vNN | R4-0 accepted |
| R4-2 | The way in (section 5.1): `workspace.js`, the organization entry gate, the organization read path, `/me`, the members list with assignments, L3's test | **risky** (trigger 2) | security, code; *Nezavisni revizor* | R4-1 |
| R4-3 | The API of section 9 (ceiling, club versions, custom roles) | **risky** (triggers 2, 4) | security, code, db (locks); *Nezavisni revizor* | R4-1; parallel with R4-2 |
| R4-4 | The screens of section 9 and the navigation of 5.2 | ordinary (no server change) | code, ux, mobile; the *Rukovodilac* | R4-2, R4-3 |
| V-1 ... V-n | VIEW per module: one pull request per module of 4.1 / 6, each adding its word to `ENFORCED_PERMISSIONS` and `permission-nav.js`, its ceiling gate (Q12) and its row of the mandatory test of 6 | **risky** (trigger 2) | security, code; *Nezavisni revizor*; with the module's stream manager | R4-2; parallel with each other where the files do not overlap |
| M-1 ... | MANAGE in the order of O7 | risky; with migrations for the database guards (R6, R6a) | as each step's contract | V of that module |

**Stream managers for the VIEW and MANAGE steps:** Calendar - its stream manager (session
`session_01YZANDuH4vg9fEWkHhNJAos`); Training Load, dashboards, Data configuration and Imports - the *Rukovodilac* of
OptiMove; Builder, programs and exercises - the Exercise stream; Tests - to be confirmed.

**Size (rough, from section 6):** VIEW through every module is about 12-15 helper functions and one route gate per module,
no migration beyond vNN. MANAGE is two to three times that, plus the migrations of the database guards that name a role
(38 files of `migrations_v2` name `club_admin`, `team_coach` or `platform_admin`).

## 14. Tests (disposable databases, the T1 runner; real counts in each pull request)

1. **Old-vs-new** for the basic roles and every existing kind of account (platform admin, club admin, team coach,
   independent coach, athlete, mixed): every checked word, every scope, before and after vNN - identical; the
   `/me` words identical apart from the view words a module has not started checking (none in R4-1).
2. **Truth table** of 3.6 in `can()` and in the twin; a random matrix comparing the two.
3. **The ceiling:** a closed module refuses at step 6 for every role, club version and custom; a reopened one brings back
   exactly the earlier answers; a platform admin is never refused; the `organization` module cannot be closed.
4. **Club versions:** made by the first change; acts for old-table coaches and for assignments; the question after a
   default change (accept, keep, answer outdated); Club admin refused for a club's admin.
5. **Custom roles:** frozen against later role and club version changes; ends on reassignment and on the role's end;
   never listed; refused for an admin by a club's admin.
6. **O6:** every write of an unchecked word refused (`permission_not_available_yet`) in every role kind; the seed alone
   carries such words.
7. **The way in (O8):** the mandatory test of section 6; the forged preference; `club_view` reaches only `GET
   /api/organization`; every write behind the organization router answers today's 403; the members list (L3, with the
   mutation); cross-club: a role holder of club A in `club_view` A asking for club B -> the identical 404.
8. **Locks:** recorded SQL order for every new write; the route-against-route races of 7.6 and 10.
9. **Migration:** apply, rollback, re-apply; md5 preconditions refuse a changed body; the preflight and post-check on a
   disposable database.
10. **Mutations** (each must fail a test): drop step 6; swap steps 8.1 and 8.2; accept an unchecked word; treat
    `club_view` as `club` in any helper of section 6; remove the organization entry gate's method check; remove the
    `staff.assign` gate of the members list; let a club's admin narrow Club admin.
11. **e2e:** a platform admin closes Imports for a club and makes a club version of Team coach; a role holder signs in,
    lands in `club_view`, sees Settings > Overview, Clubs, Teams and nothing else; at 1280 and 390 px.

## 15. Not in this contract

- The MANAGE steps and their database guards (R5, R6, R6a, R7 of the plan, in the order of O7).
- The padlock screen (Q2), the private workspace's licence (Q9), the account target rule (plan 2.1 rule 6).
- Any change to `requireCoach`, `computeCapabilities`, `managedTeamIds` or the old role tables.
