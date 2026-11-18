# Roles and permissions plan (R0)

Status: **Proposed** (2026-11-18). Documents only; nothing is built. It needs the owner's decisions of
section 9 before any code. Every code step touches external-review trigger 2 (auth, roles) and R2 also
triggers 1 and 4.

Origin: the owner's future task recorded in `docs/ai/j19-u5-undo-contract.md` section 9 ("a roles and
delegated permissions system ... only up to the level the granting admin holds"), and the owner's
direction of 2026-11-18: club directors and similar people who watch more than they use the app; role
names the owner and admins define themselves, with abilities ticked within the limits of their own;
the Builder's abilities among them.

## 1. What exists today (checked on `8288b38`)

**Roles.** Five, one per scope, each a fixed word:

| Scope | Table | Accepted value(s) |
|---|---|---|
| Global | `public.user_global_roles` | `platform_admin`, `independent_coach` (CHECK) |
| Club | `public.user_club_roles` | `club_admin` only (the routes refuse any other word; no CHECK in the table) |
| Team | `public.user_team_roles` | `team_coach` only (same) |
| Athlete | `public.athletes.user_id` | the account's own profile |
| Coach of an athlete | `public.user_athletes` | `relationship_type` `coach` |

One account may hold several at once (`backend/src/authz.js`, `loadAuthorizationContext`). Each role
row records who granted and who revoked it.

**Who assigns.** `organization.js`: global roles by a platform admin; `club_admin` by a platform admin
or that club's admin (`canAssignClubRole`); `team_coach` by a platform admin or the admin of the
team's club, never by the team's own coach (`canAssignTeamRole`).

**Special rights, each in its own table, with no shared view:** GPEXE import approver per team
(`training_load.gpexe_import_approvers`), the import switch per team, media storage quota per
account, exercise block access (`library.exercise_collection_users`), test access links, program and
library access of athletes.

**Checks are written into the code.** `isPlatformAdministrator` is used in 22 backend files;
`canManageClub` in 7, `canManageTeamById` in 10. About 15 migrations carry SQL functions that check
`platform_admin` or `club_admin` inside the database (the actor guards of v35, v38, v41, v54, v56,
v57 and others).

**Facts a first non-admin role runs into:**

1. `computeCapabilities` gives `organizationManagement`, `canCreateAthlete` and `canCreatePlan` to
   ANY club or team role row, whatever its word.
2. `loadAvailableWorkspaces` offers a club workspace only for `club_admin` and a team workspace only
   for `team_coach`.
3. `managedTeamIds` (a club's teams) is loaded only for `club_admin`.
4. The dashboard list admits any club role while the single read needs `club_admin` (Open risks of
   `CURRENT_STATE.md`: "decide the contract first" when a non-admin club role appears).
5. "May see" and "may manage" are the same check on nearly every club- and team-scoped route.

**What is missing:** staff roles (director, assistant coach, analyst, medical), fine-grained rights,
an expiry of a grant, one place that shows who holds what.

## 2. The model

Three things, kept apart:

1. **Permission** - a fixed word the code and the database know (section 3). Closed list. Only
   development adds one, because each needs its check.
2. **Role** - a name plus a set of ticked permissions. Data, not code. The five roles of today
   become basic roles that start with exactly today's abilities; new roles are made in Settings.
3. **Assignment** - a role given to a user for a scope (a club or a team; global for the two global
   roles), by someone, with a reason, an optional end date and a revocation. History is append-only.

**Who makes roles (the owner, 2026-11-18, D1).** A platform admin makes system roles, offered to
every club. A club's admin makes roles for its own club, so a role nobody foresaw is added by the
club that needs it, without waiting for the platform.

**The ceiling rule.** A person may put into a role, and assign, only permissions they hold
themselves in that scope. Platform-only permissions can never be in a club's role.

**Several roles on one account stay the normal case.** How they combine:

- in one scope the permissions add up: a person holds what any of their roles there gives; a role
  never takes away what another gives, so a person is narrowed by replacing the wider role, not by
  adding a narrower one;
- a role assigned for a club holds in every team of that club (as `club_admin` does today);
- scopes stay apart: the active workspace decides which roles count, and a permission held in one
  club gives nothing in another; the ceiling rule is evaluated per scope the same way;
- the athlete's own workspace follows the profile and is independent of staff roles;
- a platform admin passes every check in every workspace, as today. So an account that is a
  platform admin and a club's admin is not narrowed in that club by an adjustment of the basic
  "Club admin" role; the effect of an adjustment is checked with the "what this role sees" preview
  or an account without the platform role.

Example (the owner's own account): platform admin, club admin of two clubs and independent coach
are four workspaces. Roles made in one club do not exist in the other; a role wanted in both is
made as a basic role from the platform workspace. The private workspace holds only the coach's own
athletes and programs.

**Ownership stays above permissions.** A permission answers "may this person do this kind of thing
in this scope". `owner_scope` (ADR-002) still answers "whose is this row". A coach's private
program is not opened by another person's "edit programs" in the team.

**One check, two places.** `can(authz, permission, scope)` in the backend and its SQL twin
`public.user_has_permission(user, permission, scope_type, scope_id)` for the actor guards, with the
users-first lock order of `.claude/rules/migrations.md`. A route check without the database twin is
an optimization, not the guard (`testing-evidence.md`).

**No per-user ticks in the first version.** A special case gets a role of its own. Who holds what is
then always "user - role - scope", readable in one list.

## 3. The permission catalog (proposed, 49 permissions)

Names are working names. "Scope" says where a role carrying it may be assigned.

| Area | Permission | What it covers | Scope |
|---|---|---|---|
| Organization | `org.view` | Clubs, teams, staff list of the scope | club, team |
| | `org.teams.manage` | Create, rename, archive, restore teams | club |
| | `athletes.view` | Roster and athlete profiles | club, team |
| | `athletes.manage` | Add and edit athletes, add to a team or a club | club, team |
| | `athletes.remove` | Remove from a team or a club, archive and restore a profile, end a coach relationship | club, team |
| | `athletes.logins.manage` | Create an athlete's login, switch it on and off, invites | club, team |
| | `athletes.library_access` | What an athlete may open in the Program and Exercise libraries | club, team |
| | `accounts.manage` | Staff accounts of the scope: create, e-mail change, password reset, login on and off | club |
| | `staff.assign` | Assign and revoke roles in the scope (ceiling rule) | club |
| | `join_links.manage` | Join links and applications | club, team |
| Builder and programs | `programs.view` | Open plans and programs | club, team |
| | `programs.edit` | Create and change plans, blocks, sessions, items; copy | club, team |
| | `programs.assign` | Assign to athletes; approve, reject, revoke access | club, team |
| | `programs.publish` | Submit to Program Library, templates | club, team |
| | `programs.rpe_settings` | A plan's Training Load settings | club, team |
| Tags and presets | `presets.use` | See and use the scope's Builder presets (domain, category, section), program tags and exercise classification lists | club, team |
| | `presets.manage` | Create, change and remove the scope's Builder presets and program tags | club, team |
| | `exercise_lists.manage` | Create, change and remove the scope's exercise classification entries (domains, categories, sections, tags, attractors) | club, team |
| Exercises | `exercises.use` | Open the Exercise Library, favourites, hide for oneself; add an exercise to a program | club, team |
| | `exercises.add` | Add a new exercise, copy one, change, classify and tag one's scope's exercises | club, team |
| | `exercises.media.upload` | Upload a video or a picture of an exercise (within the storage quota, which stays a separate setting) | club, team |
| | `exercises.remove` | Archive, restore and permanently delete exercises | club, team |
| | `exercises.blocks.manage` | Blocks (collections): create, change, move exercises between them, grant accounts access to a block | global |
| Calendar | `calendar.view` | The scope's calendar | club, team |
| | `calendar.events.manage` | Create, change, cancel events | club, team |
| | `calendar.settings.manage` | Event types, details, places, colours | club |
| Training Load | `load.view.team` | Team-level and aggregated data | club, team |
| | `load.view.athlete` | Named athletes' RPE, load and metric values | club, team |
| | `load.schedule.manage` | External RPE schedules, reminders | club, team |
| | `load.roster.decide` | Roster states of a session, complete and reopen | club, team |
| | `load.estimates.manage` | Estimated values for an athlete without a recording | club, team |
| | `load.activities.manage` | Session identity: match suggestions, merge and reparent participants | club, team |
| | `dashboards.view` | Open dashboards of the scope | club, team |
| | `dashboards.manage` | Create, change, delete dashboards | club, team |
| Imports | `import.check` | Find new sessions, read candidates | club, team |
| | `import.link` | Link and unlink source athletes | club, team |
| | `import.approve` | Approve an import (replaces the approver grant) | team |
| | `import.undo` | Undo an imported session | team |
| Tests | `tests.view` | The test library and the schedule (what is planned, for whom, when) | club, team |
| | `tests.results.view` | Named athletes' answers and results | club, team |
| | `tests.schedule.manage` | Schedule, change and cancel tests (single and bulk), reminders, access links | club, team |
| | `tests.library.manage` | Define tests and batteries (no screen today; the library is read-only) | global |
| Messages | `messages.send` | Write to athletes and staff | club, team |
| Data configuration | `variables.view` | The Variables view (the club's and OptiMove's variables), read-only | club, team |
| | `variables.manage` | Create a club variable, a new version, calculated variables; rename, icon, archive, restore; domains and categories; use, copy or hide an OptiMove variable | club |
| | `mappings.manage` | Map source fields to variables (the board and Mappings): save, activate, replace, disable, switch on for teams | club |
| | `sources.connect` | The club's source connection: Connect, Test, bind and unbind teams, session time zone | club |
| Platform only | `platform.metrics.manage` | System variables, source fields, confirmations | global |
| | `platform.admin` | Users, clubs, quotas, App health, the import switch | global |

Not a permission: the athlete's own workspace (it follows the profile).

**Tags and presets today** (`routes/taxonomy.js`, Settings > Tags & Presets; R1 verifies it): three
kinds of lists, each with an owner (system, club, team or one's own): the Builder's presets
(domain, category, section, with a colour and an icon), program tags, and the Exercise Library's
classification entries. A system entry is changed only by a platform admin; a club's, a team's and
one's own by whoever manages that owner; the read lists a club's entries to anyone holding a role
in that club. System entries stay the platform's (`platform.admin`). The split lets a club decide
who shapes the lists everyone picks from, apart from who only picks. One finding for R1: the
club and team branches of that read admit any role word (the same shape as the dashboard list of
section 1, fact 4), so it is settled before the first non-admin club role exists.

**Exercises today** (`routes/exercises.js`, `routes/exerciseCollections.js`, the media routes; R5
verifies it route by route): every coach reads the library and may add, copy, change, archive and
delete exercises of their own scope; an upload needs a storage quota above zero, which a platform
admin sets per account; blocks and which accounts see a block are a platform admin's. The split
lets a club keep adding exercises to a few people while everyone else only uses the library, and
keeps deleting apart from adding. Whether `exercises.blocks.manage` can ever be a club's is the
Exercise stream's decision, so it starts as platform only.

**Tests today** (`backend/src/testsAccess.js`, `routes/tests.js`): a schedule is managed by a
platform admin, the club's admin, the team's coach or the independent coach who owns it
(`canManageSchedule`); whoever manages it also reads its results; the library is read by every
coach and no route defines a test; an athlete answers their own assignment, which follows the
profile and is not a permission. The split lets a club give someone results without scheduling
(a director, medical staff) or scheduling without results. Athlete questions on a calendar event
(K2b-2 of the Calendar stream) go through this module, so R7 for tests is agreed with that
stream's manager.

**Variables today** (as `CURRENT_STATE.md` records it; R1 verifies it route by route): OptiMove's
system variables, source fields and their confirmations are a platform admin's; a club's variables,
mappings, activations and its source connection are the club admin's (and a platform admin's); a
team coach has the reduced Variables view and may rename, archive and restore a club variable (C99).
The four permissions above split that single "club admin" right, so a club can, for example, let an
analyst map and create variables without making that person a club admin. The coach's C99 abilities
become `variables.view` plus a narrower basic set, kept exactly as today. The database actor
guards of these writes (v35, v38, v41, v52, v53 and later) check `club_admin` by name, so this area
moves only with a migration and with the *Rukovodilac* of OptiMove (step R6a).

**Completeness pass (2026-11-18).** Every write route of `backend/src/routes/` was listed and
placed under a permission of the table; the rows for athletes' removal, logins and library access,
staff accounts, estimates and session identity came from it. Not permissions, because they follow
the person's own account: one's profile and public coach page, notifications, hiding and blocking
in Messages, an athlete's own answers. The pass read route names, not each route's check; R1 and
each later step replace it with a route-by-route table (route, today's check, permission) that the
old-vs-new tests are generated from.

**Keeping 49 ticks usable.** The role editor works with the groups and levels of section 3.0 and the
"what this role sees" preview; most roles are made by copying one and changing a level or two. If the owner finds an area too fine (D7), two rows merge before R2 fixes the list in the
database; merging later is a migration, splitting later is too.

### 3.0 Groups first, fine-tuning second (the owner, 2026-11-18)

The 49 permissions are what the code checks; a person making a role works with **groups**. A group
is one area of the app, given at one of a few levels; each level is a fixed set of the area's
permissions. Fine-tuning opens a group and ticks single permissions.

| Group | Levels (each includes the ones before it) |
|---|---|
| Organization and staff | Off - View - Manage teams - Manage staff and accounts |
| Athletes | Off - View - Add and edit - Full (remove, logins, library access) |
| Programs (Builder) | Off - View - Edit - Full (assign, publish, RPE settings) |
| Exercises | Off - Use - Add (with media) - Full (remove) |
| Tags and presets | Off - Use - Manage |
| Calendar | Off - View - Manage events - Full (settings) |
| Training Load | Off - Team totals - Named athletes - Manage (schedule, roster, estimates, session identity) |
| Dashboards | Off - View - Manage |
| Imports | Off - Check and link - Approve - Full (undo) |
| Tests | Off - View schedule - Results - Schedule |
| Messages | Off - Send |
| Data configuration | Off - View - Variables - Full (mappings, source connection) |

- A role is stored as its permissions, never as "group X at level Y": a level is a shortcut of
  the editor that ticks a set. A fine-tuned group shows as "Custom" with its ticks.
- A level that is not a simple ladder (Tests: results without scheduling, or the reverse) is made
  by fine-tuning; the ladders above are the common cases.
- Whole-section closing (section 3.3) is the group at "Off", shown invisible or locked.
- The ceiling rule works per permission, so a level the editor does not fully hold is offered
  only up to what they hold.

**The first version (R2-R3) is the basic roles with group levels.** The basic roles, Director,
Assistant coach and Analyst, each described by its group levels; a platform admin and a club's
admin make a role by picking a level per group. Fine-tuning single permissions is in the same
editor behind "Fine-tune", and can ship with it or right after; the data model is the same either
way, so nothing is redone.

### 3.1 The independent coach (the owner, 2026-11-18)

An independent coach is a coach without a club who has athletes. The same catalog applies to that
coach's private workspace: scope type `private`, the scope being the coach's own account. The
permissions with scope "club, team" are the ones that make sense there (athletes, programs,
exercises, calendar, Training Load, tests, messages); the club-only ones do not exist in a private
workspace.

**Levels by subscription: an option for later, not built now.** The platform admin may later make
several private-scope roles ("levels") with different permission sets and give a coach the level of
their subscription. The model allows it without a change: a level is an ordinary system role whose
scope is `private`, and the basic "Independent coach" is the first of them, with today's
abilities. What a level contains, and anything about payment, is the platform admin's later
decision; this plan only keeps the door open (the scope type exists from R2 on).

### 3.2 What a role sees (the owner, 2026-11-18)

A role limits what a person **sees**, not only what they may change. Every area has its own "view"
permission, separate from its "manage" ones, and a section without its view permission does not
exist for that person:

- it is not in the navigation, on Home, in search, in notifications or in links from other screens;
- its routes answer the same 404 as for a missing row (ADR-006), so the section cannot be opened by
  address either; hiding a menu item alone is never the protection;
- a manage permission includes seeing: the role editor ticks the view permission with it and does
  not let it be unticked alone.

| Section of the app | Shown with |
|---|---|
| Athletes | `athletes.view` |
| Coaches / staff | `org.view` |
| Calendar | `calendar.view` |
| Builder | `programs.edit` |
| Program Library | `programs.view` |
| Exercise Library | `exercises.use` (the *Add exercise* form and the upload: `exercises.add`, `exercises.media.upload`) |
| Tests | `tests.view` (results inside it: `tests.results.view`) |
| Training Load: Overview, Activities, Athletes | `load.view.team` (named rows and the athlete pages: `load.view.athlete`) |
| Training Load: Schedule | `load.schedule.manage` |
| Training Load: Dashboards | `dashboards.view` |
| Training Load: Imports | `import.check` |
| Training Load: Data configuration | `variables.view` |
| Messages | `messages.send` (a person without it still reads what is sent to them) |
| Settings > Tags & Presets | `presets.manage` or `exercise_lists.manage` (each shows its own lists) |
| Settings | each tab by its own permission; a person with none of them sees only Account |

Inside a section the same rule holds for its parts: a tab, a column or a card that shows data of a
permission the person lacks is left out, not shown empty or greyed. A person whose roles give no
section at all sees Home with Account and their notifications only.

### 3.3 A whole section off: invisible or locked (the owner, 2026-11-18)

A whole section (Training Load, Tests, Builder, Calendar, ...) can be closed in two places:

1. **For a club or an independent coach** - a module the platform admin has not switched on for
   them. Nobody there has it, the club's admin included, and no role of that club can contain its
   permissions (the ceiling rule covers it: the club's admin does not hold them). This is also the
   lever for the later subscription levels of section 3.1.
2. **For a role** - the role has none of the section's permissions (section 3.2).

A closed section is shown in one of two ways, chosen per module by whoever closes it:

- **Invisible** (the default): not in the navigation, nowhere mentioned; its routes answer the 404.
- **Locked** ("blurred"): the section stays in the navigation with a lock; opening it shows a fixed
  sample picture of the screen, blurred, with one sentence ("Training Load is not part of your
  access. Ask your club's administrator.") and nothing else.

**A locked section never receives real data.** The blurred picture is a static illustration shipped
with the app, not the person's or the club's data under a CSS blur: the server answers the
section's routes with the same 404 as for an invisible one, so nothing can be read from the page,
the network or the page source. A count, a name or a date of the closed section is not shown
around the lock either.

Schema (R2): a small table of module switches per club and per independent coach (module word,
state `on` / `off`, shown as `hidden` / `locked`, who changed it and when, append-only history);
for a role, one "show as locked" flag per module in the role. Modules are a closed list beside the
permission catalog; every permission belongs to exactly one module.

## 4. Built-in roles and the first new ones

**Basic roles (the owner, 2026-11-18).** The basic roles are system roles. They start with exactly
today's abilities (section 4.1), so nobody gains or loses anything on the first day. From then on:

- **a platform admin adjusts a basic role** (changes its levels and ticks) and **adds a new basic
  role**; a change acts for every club and is recorded, and the editor names how many people and
  clubs it affects before Save;
- **a club's admin does the same inside its club, up to its own level**: makes the club's roles,
  from scratch or as a copy of a basic one, and assigns them; it cannot change a basic role itself;
- **Platform admin is the one role nobody edits** (always everything), so the platform cannot lock
  itself out; the last active platform admin cannot be revoked (as today);
- **Club admin keeps role assignment and the role editor in every version of it**, so a club cannot
  be left without anyone able to manage its people.

A basic role's permissions in a module that has not yet moved to permissions (section 7) are shown
as "not adjustable yet": there the old check still decides, so an adjustment would have no effect.

| Role | Scope | Permissions |
|---|---|---|
| Platform admin (basic, not editable) | global | everything |
| Club admin (basic) | club | everything with scope "club" or "club, team" |
| Team coach (basic) | team | everything with scope "club, team", plus `import.approve` only if granted today |
| Independent coach (basic) | private | everything with scope "club, team", in the coach's own private workspace; unchanged from today |
| **Director** (proposed) | club | `org.view`, `calendar.view`, `load.view.team`, `dashboards.view`; `athletes.view`, `load.view.athlete`, `programs.view`, `tests.view`, `tests.results.view` for the club's admin to tick or not |
| **Assistant coach** (proposed) | team | `athletes.view`, `programs.view`, `programs.edit`, `exercises.use`, `calendar.view`, `calendar.events.manage`, `load.view.team`, `load.view.athlete`, `load.roster.decide`, `dashboards.view`, `tests.view`, `tests.results.view`, `tests.schedule.manage`, `messages.send` |
| **Analyst** (proposed) | club or team | `athletes.view`, `load.view.team`, `load.view.athlete`, `dashboards.view`, `dashboards.manage`, `import.check`, `tests.view`, `tests.results.view` |

**A club's admin restricts or frees a role for its club (the owner, 2026-11-18).** A system role is
a starting point: the club's admin copies it, ticks or unticks permissions within the ceiling rule,
and assigns the copy. So how much a Director sees is each club's own choice, changed at any time
and recorded.

**Restricting someone who is a coach today.** A club cannot change a basic role, so it narrows a
coach (for example: no adding of exercises, no Tests) by assigning its own copy of Team coach with
those permissions unticked in place of the basic one. The change of role is one act in Users
and is recorded.

A role carries a free display title per assignment (Director, Sports director, President), so one
role serves several functions.

### 4.1 The basic roles' starting levels (today's behaviour, by group)

| Group | Platform admin | Club admin (its club) | Team coach (its team) | Independent coach (own workspace) |
|---|---|---|---|---|
| Organization and staff | Full | Manage staff and accounts | View | - |
| Athletes | Full | Full | Full | Full (own athletes) |
| Programs (Builder) | Full | Full | Full | Full |
| Exercises | Full, and blocks | Full | Full | Full |
| Tags and presets | Manage, and system entries | Manage | Manage (team's) | Manage (own) |
| Calendar | Full | Full | Manage events | to verify |
| Training Load | Manage | Manage | Manage | Manage |
| Dashboards | Manage | Manage | Manage | Manage |
| Imports | Full | Check and link; Approve with the team's grant | Check and link; Approve with the team's grant | Off |
| Tests | Schedule, results | Schedule, results | Schedule, results | Schedule, results |
| Messages | Send | Send | Send | Send |
| Data configuration | Full, and system variables and source fields | Full (club's) | View; rename, archive and restore a club variable (Custom) | to verify |

This table is the intent, read from the code's helpers and `CURRENT_STATE.md`. The exact starting
sets are derived in R1, route by route, and proven by tests that compare the old and the new answer
for every role on every route; where the two differ, the code of today wins and this table is
corrected. "To verify" marks cells the first pass did not establish.

## 5. Schema sketch (R2; one migration, ★★)

- `public.permission_roles` - id, name, description, owner (`system` or a club), the scope types it
  may be assigned for (`club`, `team`, `private`), `is_basic`, `built_in_key`, archived state,
  created by. A club's role is visible and assignable only inside that club.
- `public.permission_role_items` - role, permission word (CHECK against the closed list, a new
  permission is a migration).
- `public.permission_role_changes` - append-only: who, when, which permission added or removed,
  rename, archive; the actor guard pattern of v35.
- `public.user_role_assignments` - user, role, scope type and id, display title, granted by, reason,
  `expires_at`, revoked at and by; one active row per user, role and scope; append-only history.
- `public.user_has_permission(...)` and a lock function `public.lock_user_permission(...)` (users
  row first, then the assignment) for the guards.
- The three existing role tables stay and keep working; a basic role is read from them. No data
  is moved in R2. Runbook, preflight, post-check and a rehearsed rollback as for every migration.

Its number is agreed with the *Rukovodilac* of OptiMove when it is written (v78 is in an open pull
request today).

## 6. Screens (R3)

- **Settings > Roles** (new tab), for a platform admin (system roles) and a club's admin (its club's
  roles, with the system roles shown read-only and "copy as a new role"): the roles with the number
  of people holding each; a form with name, description and permissions grouped by area; a permission the editor does
  not hold is shown locked with the reason.
- **Settings > Users**: assigning a role for a club or a team where club admin and team coach are
  assigned today, with the display title, optional end date and reason; one list "who holds what"
  with a filter by role.
- **The coach's Settings as "My team"** (U1 of the backlog): the tabs follow the permissions held,
  instead of eight organization tabs.
- **Navigation and Home follow the permissions** (section 3.2): the sidebar, the phone's navigation,
  Home's cards and the Settings tabs are built from the permissions the server returns with `/me`
  for the active workspace; the role editor shows "what this role sees" as a preview of the menu.
- A read-only person sees no write control anywhere; the server decides again on every request.

## 7. Steps

| Step | What | Files | Review |
|---|---|---|---|
| **R0** | This plan and the owner's decisions | docs only | the owner, the *Rukovodilac* |
| **R1** | `can()` in `authz.js`, the basic roles' starting sets, Settings / organization routes moved to it; no behaviour change, proven by old-vs-new tests | `authz.js`, `routes/organization.js`, tests | code, security; external (trigger 2) |
| **R2** | The migration of section 5, the SQL twin, the Roles API | migration, new service and route | db, security, code; ★★ |
| **R3** | Settings > Roles, assignment in Users, "My team" | `organization-*` and new frontend files | code, ux, mobile |
| **R4** | Read / manage split and the first real role, **Director**: a club workspace in read mode, the fixes of section 1 facts 1-4 | `authz.js`, `workspace.js`, then module by module | security; external |
| **R5** | Builder and exercises on permissions; Assistant coach | `routes/builder.js`, `plans.js`, `templates.js`, `exercises.js` | code, security |
| **R6** | Imports: `import.approve` and `import.undo` replace the approver grant and the platform-only undo | GPEXE files, a migration for the guards | ★★, with the *Rukovodilac* |
| **R6a** | Data configuration: `variables.*`, `mappings.manage`, `sources.connect` in the services and their actor guards | Metrics Core files, a migration | ★★, with the *Rukovodilac* |
| **R7** | Calendar, Training Load, dashboards, tests, messages | their own files | with each stream's manager |

R1 to R3 stay inside Settings and organization. R5 touches the Builder, which no session works on
today. R4, R6 and R7 change files of the Metrics Core and Calendar streams and are scheduled with
their managers; until a module is moved, it keeps today's checks, and a new role simply has no
access there (fail closed).

## 8. Risks

- **A changed role acts at once for everyone holding it.** Every change is recorded; the form names
  how many people it affects before Save.
- **A database guard that does not know a permission refuses the write.** That is the safe
  direction; it is why modules move one at a time with their guards.
- **A hidden section leaks through another one** (a link, a name in a notification, a count on
  Home, a dashboard widget of data the person may not see). Each module's move (R4-R7) lists its
  cross-references and tests them for a person without the view permission.
- **A blurred section that carries real data** would be a leak with a filter over it. The locked
  view is a static picture and its routes answer 404; a test loads the locked section and proves no
  request for its data succeeds.
- **Read access is new surface.** Info-hiding (ADR-006) is re-checked per route when "view" is
  separated from "manage": a person without the view permission gets the same 404 as for a missing
  row.
- **A club's own roles multiply.** Each club sees only the system roles and its own; an archived
  role keeps its history and can no longer be assigned.
- **A platform admin's change of a basic role reaches every club at once.** The editor shows the
  affected count and asks for a reason; the change record allows the previous set to be put back.
- **Privilege escalation through the role editor.** The ceiling rule is enforced in the service and
  in the database guard, with tests for: adding a permission one does not hold, assigning a role
  stronger than oneself, editing a role after losing a permission, a platform-only permission in a
  club's role.
- **Named athlete data for people outside the coaching staff** (`load.view.athlete`): a separate
  permission, off for Director unless the owner decides otherwise.
- **Performance.** Permissions are loaded once per request with the authorization context, as
  roles are today.

## 9. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | Who may create roles? | **Decided (2026-11-18): a platform admin (system roles) and a club's admin (its own club's roles), under the ceiling rule.** |
| D2 | Director: named athlete data (`load.view.athlete`, `athletes.view`, `tests.results.view`) or team totals only? | **Decided (2026-11-18): the club's admin decides.** The system role Director starts narrow (team totals only); a club's admin widens or narrows it for its club by its own copy of the role. |
| D3 | May a Director write messages? | **Decided (2026-11-18): as D2.** Off in the system role; a club's admin may tick it in its club's copy. |
| D4 | Does an assignment have an optional end date? | Yes, optional. |
| D5 | May a club's admin hand on `staff.assign` (someone else assigns roles)? | No in the first version. |
| D6 | Athlete-side roles (parent, guardian)? | Not in this plan. |
| D6a | Levels of an independent coach by subscription | **Decided (2026-11-18): an option kept open (section 3.1); the platform admin designs the levels later.** |
| D6b | A whole section closed for a club, a coach or a role, shown invisible or locked (blurred) | **Decided (2026-11-18): both ways exist (section 3.3).** The platform admin chooses it for a club or a coach, and a club's admin for a role of its club, each at its own level. Open: the default (recommended: invisible). |
| D6c | Groups with levels as the way a role is made, fine-tuning behind it; basic roles first | **Decided (2026-11-18), section 3.0.** Open: the group list and the ladders of that table. |
| D6d | Basic roles: start as today; a platform admin adjusts them and adds new ones; a club's admin does the same in its club up to its own level | **Decided (2026-11-18), section 4.** Platform admin stays not editable. |
| D7 | The catalog of section 3: anything missing, or too fine? | - |
| D8 | The three proposed roles of section 4: the ticks for each. | As in the table. |
| D9 | Order after R3: Director first (R4) or Builder first (R5)? | Director first. |
