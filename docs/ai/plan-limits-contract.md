# Plan limits contract: per-club limits on teams, athletes, staff seats, storage and features

Discovery and contract for subscription plan limits. Where this document goes beyond the owner's words, the point is
marked **(recommendation)** and, when it needs the owner, listed in section 7.

| | |
|---|---|
| Status | **Proposed.** Documentation only. No code and no migration file. |
| Mark | Risky when built: external-review triggers 1 (a migration), 2 (club scope, info hiding) and 4 (lock order, concurrency) of `CLAUDE.md`. |
| Written against | `origin/main` at `d75a1ba` (2026-11-23). Every `file:line` is at that commit; each implementation PR re-checks its rows at its own base. |
| Depends on | `docs/ai/roles-r4-contract.md` (R4-1, migration v92, `202611241000`): the club ceiling (its 7.1), the club lock order (its 7.6) and the effective holdings (its 3.2, 3.4). Section 5 says which PRs wait for R4-1. |
| Migration | One foundation migration, number after R4-1's (provisionally v94 or later; the *Rukovodilac* gives the number). |

## 1. Owner's decisions (2026-11-23, relayed by the *Rukovodilac*)

| # | Decision |
|---|---|
| L1 | Limits are **per club** and enforced **on the server** at every point that adds something. |
| L2 | Limited: max teams; max active athletes; max staff seats (coaches and specialists, by role); media storage (reuse the R2 quota idea); optional features per plan (for example GPS import, advanced dashboards). |
| L3 | A downgrade **never deletes** anything. It only blocks new additions, with a clear message to the club's admin. |
| L4 | Archived athletes and archived teams do not count. |
| L5 | A platform admin can grant a club an **exception**. |
| L6 | Plan names and numbers come from the owner later; this document uses placeholders (`Plan A`, `Plan B`, `Plan C`). |

## 2. Every add point (current `main`)

All paths are in `backend/src/routes/organization.js` unless named otherwise. "Add" means the club's count can go up.

### 2.1 Teams (count: active teams of the club)

| # | Path | `file:line` | Who | Today's write | Note |
|---|---|---|---|---|---|
| T1 | `POST /api/organization/teams` | `:1113`, insert `:1124` | `org.teams.manage` on the club (`:1122`) | a bare `query()`, no transaction | must become a transaction |
| T2 | `PUT /teams/:teamId/restore` | `:1242`, update `:1259` | same | a bare `query()` | an archived team back = an add |
| - | `POST /clubs` | `:1052` | platform admin | a club, no team | not an add of a counted thing |
| - | `PUT /teams/:teamId` | `:1186` | | rename; club fixed (D43) | not an add |

### 2.2 Athletes (count: active athletes of the club; section 3.2)

Every club-membership activation goes through `ensureActiveMembership` (`:4044`, insert `:4067`, reactivation `:4058`)
except the two direct restores (A6, A7) and the profile restore (A8).

| # | Path | `file:line` | Who | What can make the athlete newly active in club C |
|---|---|---|---|---|
| A1 | `POST /athletes` | `:1357`; club and team from `resolveAthleteClubTeam` `:3996`; memberships `:1391-1392` | `athletes.manage` on the club or team | a new athlete with a club or team. **Without** a club or team it is a private athlete of the coach (`user_athletes`, `:1378`): no club counts it |
| A2 | `PUT /athletes/:athleteId` | `:1407`; memberships `:1436-1437` | `canManageAthlete` | editing the club / team fields only **adds** a membership |
| A3 | `POST /teams/:teamId/athletes` | `:1526`; memberships `:1556-1557` | `athletes.manage` on the team | the club membership is made if the athlete was not in the club |
| A4 | `POST /athlete-join-applications/:applicationId/approve` | `:1968`; athlete created `:2085` / `:2136`; memberships `:2162`, `:2168-2169` | a holder of a club / team role who reviews the link | club or team join link. A `private_coach` link (`:2154`) adds to no club. `POST /api/auth/join-links/:token/apply` (`routes/auth.js:1109`, `:1246`) only makes a pending application: not an add |
| A5 | `PUT /teams/:teamId/athletes/:athleteId/restore` | `:2494`; team row `:2546`, club `:2553` | `athletes.manage` on the team | the club membership is reactivated with the team one |
| A6 | `PUT /clubs/:clubId/athletes/:athleteId/restore` | `:2620`; update `:2651` | `athletes.manage` on the club | direct reactivation, not through `ensureActiveMembership` |
| A7 | (same as A6 for a team row) | `:2546` | | direct reactivation of the team row (the count is per club, so only `:2553` matters) |
| A8 | `PUT /athletes/:athleteId/restore-profile` | `:2409`, update `:2413` | platform admin only (`athletes.remove`, global) | `athletes.is_active = true` makes the athlete count again in **every** club where its membership stayed active - possibly several clubs at once; a bare `query()` |
| - | `POST /athlete-invites` `:1583`, `POST /api/auth/invites/:token/accept` (`routes/auth.js:896`, `:979`), `/link` (`:1012`, `:1050`), `POST /athlete-logins` `:3152` | | | a login for an existing athlete; no membership. Not an add |
| - | GPEXE import (`routes/gpexeImport.js`) | | | links GPEXE ids to existing athletes; creates no athlete or membership. Not an add |
| - | `PUT /athlete-library-access/bulk` `:1508` | | | not an add |
| - | `coach-relationship/restore` `:2444` | | | a private-coach relationship only; no club |

Raw writers outside the routes: `tools/create_local_zija_murina.mjs`, `tools/generate_training_package_migration.mjs` and
the `backend/scripts/*-rehearsal.mjs` files insert athletes and memberships directly (local / disposable databases). Out
of contract; the database backstop (4.4) refuses them only if they would go over a limit of a club that has a plan.

### 2.3 Staff seats (count: section 3.3)

| # | Path | `file:line` | Who | Write |
|---|---|---|---|---|
| S1 | `grantClubAdminRole`, reached from `PUT /users/:userId/club-roles/:clubId/club_admin` `:3076` and `POST /club-roles` `:3121` | `:2916`, insert-or-reactivate `:2939` | `staff.assign` on the club | `user_club_roles` (a re-grant flips the same row) |
| S2 | `grantTeamCoachRole`, reached from `PUT /users/:userId/team-roles/:teamId/team_coach` `:3096` and `POST /team-roles` `:3133` | `:3005`, insert `:3025` | `staff.assign` on the team | `user_team_roles` |
| S3 | `assignRole`, `POST /api/organization/roles/assignments` (`routes/permissionRoles.js:50`) | `permissionRolesService.js:960`, insert `:1027` | `staff.assign` in the club (`gateClub`, `:231`) | `user_role_assignments` (club or team scope) |
| S4 | `PUT /users/:userId/login-status` with `active: true` | `:513` -> `setUserLoginStatus` | the user's manager | a disabled account that holds club / team roles comes back as a seat in each of those clubs |
| - | `POST /users` | `:443` | platform admin or club admin | a user with no club or team role (only an optional global role `platform_admin` / `independent_coach`, `:478`): no seat |
| - | R4's club versions and custom roles (R4 7.2, 7.3) | | | change what a holder may do, never who holds a role: not an add |
| - | `PUT /teams/:teamId/restore` (T2) | | | a restored team brings back its coaches' `team_coach` rows (kept by the archive, `:1293`): **an add of seats too** |

### 2.4 Media storage

| # | Path | `file:line` | Today |
|---|---|---|---|
| M1 | `POST /api/media/uploads` | `mediaUploads.js:136-151`; owner `:51-69`; reservation `mediaStorage.js:179-205` | the storage account is the **content owner**: a new or private exercise is the uploader's personal account (`:54`, `:62`); a club exercise is the club's account, and only exercise admins edit those (`:65-67`); a system exercise is the uploading admin's own (`:61`). Reservation under `lockPolicy` + `lockAccount` (`for update`, `:89`), refusal `429 storage_quota_exceeded` (`:200`), plus `parallel_upload_limit` |
| M2 | Drive import | `mediaUploads.js:168-179` | the platform account (`ensureAccount({type:'platform'})`) |
| M3 | Limits | `mediaStorage.js:35-46`, `:128-153` | `media.storage_policy.default_limit_bytes`, per-account `override_limit_bytes`, audited (`media.storage_limit_audit`) |

So today **a club coach's uploads are charged to the coach personally, not to the club**. A club storage limit acts only
on the club's own account. Q8.

### 2.5 Optional features (gated)

| Feature | Entry gate(s) | Note |
|---|---|---|
| GPS import | `gpexeImportAccess.js:19-40` (every `/api/training-load/gpexe/teams/:teamId/*` route, `routes/gpexeImport.js:190-713`); source connections `routes/sourceConnections.js:88`; the per-team import switch (v56, `routes/gpexeImport.js:223`) | R4 names a single early ceiling gate in `gpexeImportAccess.js` as possible (R4 7.4) |
| Advanced dashboards | `routes/trainingLoadDashboard.js:333` (create), `:350` (clone), `:497` (widgets), `:594` (series), `:764` (query) | "advanced" is not defined in code; Q9 |
| Others | every module of R4 4.1 | through R4's ceiling |

## 3. Counting rules

### 3.1 Teams

`count(*) from public.teams where club_id = C and coalesce(is_active, true)`. Archived teams do not count (L4).

### 3.2 Active athletes

An athlete A counts in club C when **all** hold:
- A has a `public.athlete_memberships` row with `club_id = C`, `membership_type = 'club'`, `status = 'active'`;
- `public.athletes.is_active` for A is true (a profile archived by a platform admin, `:2399`, counts nowhere).

Consequences:
- **Several teams of one club: counted once.** Every team membership of club C comes with a club membership of C
  (`ensureActiveMembership` is called for the club first at every team add; A5 reactivates the club row), so the club row
  alone is the unit.
- **Two clubs: counted in each** (a club pays for the athletes it trains). **(recommendation, Q3)**
- **A club membership without a team counts** (the athlete is in the club). **(recommendation, Q4)**
- **Private coach athletes** (`user_athletes`, `relationship_type = 'coach'`, no membership) count in **no** club, even if
  the coach is also a club coach. A private coach plan is not in this contract (R4 Q9; Q12).
- The legacy pointer columns `athletes.club_id` / `team_id` are never read for the count.
- A login or no login makes no difference.

### 3.3 Staff seats

A **seat** is one person (user) who holds, in club C, at least one live staff holding:
- an active `user_club_roles` row (`club_admin`, `is_active`, `revoked_at is null`) for C;
- an active `user_team_roles` row (`team_coach`) for an **active** team of C;
- a live `user_role_assignments` row (not revoked, not expired) of club scope C, or of team scope on an active team of C
  (R2; with R4-2 these are also the view-only `club_view` / `team_view` holders);
- and `public.users.is_active` for that person.

Consequences:
- **One person = one seat in that club**, whatever number of roles and teams they hold there. Seats in two clubs count in
  both.
- **Per role:** the owner said "by role". Proposed: a total seat limit, plus optional limits per **system role**
  (`permission_roles` with `owner_scope = 'system'`; the old-table rows count as the basic role they map to, R4 3.2 step
  8; a custom role counts as its base role, R4 3.4; a club's own role, R2 copy, counts under the system role it was
  copied from, or under "other"). A person holding two roles counts once in each role bucket and once in the total.
  **(recommendation, Q5)**
- Platform admins working in a club hold no row there: not a seat. An athlete login is not a seat.
- Club admins count. **(recommendation, Q6)**

### 3.4 Storage

The club's storage account (`media.storage_accounts` with `owner_club_id = C`): the plan sets its limit in place of
`default_limit_bytes` (section 4.1); used and reserved bytes keep the R2 meaning. Personal accounts are untouched (Q8).

### 3.5 Effective limit

For club C and limit kind K: a live exception of (C, K) if one exists, else the club's plan value for K, else no limit.
A null value means unlimited. A club with **no plan row** has no limits (Q1).

## 4. Proposed design

### 4.1 Schema (one migration; all in `public`; the v84 / R4 conventions)

Row-level security without a policy, `REVOKE` from `PUBLIC` / `anon` / `authenticated`, foreign keys `ON DELETE
RESTRICT` with an index, fixed refusal messages (`42501` "may not", `23514` "not allowed"), the acting user through
`permission_context_actor()` (v84), append-only change records written in the same transaction.

| Table | Columns | Rules |
|---|---|---|
| `subscription_plans` | `id`, `key` (unique, stable, e.g. `plan_a`), `name`, `max_teams`, `max_active_athletes`, `max_staff_seats`, `storage_limit_bytes` (all nullable = unlimited, else `>= 0`), `revision`, `is_archived`, `created_at`, `updated_at` | written by a platform admin only (actor guard); every change `revision + 1` with a change row |
| `subscription_plan_role_limits` | `plan_id`, `role_id` FK `permission_roles` (system roles only), `max_holders` (`>= 0`) | primary key (`plan_id`, `role_id`); Q5 |
| `subscription_plan_features` | `plan_id`, `module_word` FK `permission_modules` | primary key; a row = the feature is **in** the plan; Q9 |
| `club_subscriptions` | `club_id` PK FK clubs, `plan_id`, `assigned_by_user_id`, `assigned_at`, `reason` | one current plan per club; no row = no limits (Q1); change = UPDATE with a change row |
| `club_limit_exceptions` | `id`, `club_id`, `limit_kind` (`teams` / `active_athletes` / `staff_seats` / `storage_bytes` / `role:<uuid>` as `role_id` column / `feature`), `value` (nullable = unlimited; for `feature` the `module_word`), `expires_at` (nullable), `granted_by_user_id`, `reason` (required), `created_at`, `ended_at`, `ended_by_user_id` | partial unique (`club_id`, `limit_kind`, `role_id`, `module_word`) where `ended_at is null`; a platform admin only (L5); an expired one is dead at read time |
| `subscription_changes` | append-only: `id`, `kind` (`plan_create`, `plan_change`, `plan_archive`, `club_assign`, `exception_grant`, `exception_end`), `plan_id`, `club_id`, before / after values, `performed_by_user_id`, `reason`, `created_at` | UPDATE, DELETE, TRUNCATE refused |

Request records: the R2 `permission_requests` pattern (a `requestKey` on every write, a lost COMMIT is never a second
write), or its own table if the *Rukovodilac* prefers to keep the roles table to roles.

Storage: the plan's `storage_limit_bytes` is applied to the club's storage account in `mediaStorage.js` by reading the
effective limit in place of `default_limit_bytes` (an account's own `override_limit_bytes` still wins, since that is
the existing per-account exception). No change of `media.*` tables. **(recommendation)**

Count functions (`STABLE`, no `SECURITY DEFINER`, SQL twins of the service): `club_active_team_count(C)`,
`club_active_athlete_count(C)`, `club_staff_seat_count(C, role_id default null)`, `club_effective_limit(C, kind,
role_id default null)`.

### 4.2 Concurrency: count and insert under one lock

- **One per-club advisory lock** for limits: `(CLUB_LIMITS_LOCK_NAMESPACE, hashtext(clubId))`, transaction-scoped, a
  namespace of its own (distinct from R4's ceiling lock, the club-admin headcount lock `organization.js:2761`, the team
  import lock and R2's request-key lock). Helper `lockClubLimits(client, clubIds)` and its twin
  `public.lock_club_limits(uuid[])`.
- **Every add transaction** of section 2 takes it, then counts, then compares with the effective limit, then writes -
  all in the same transaction. Two parallel adds to the same club serialize on the lock; the second counts the first's
  row. Several clubs (A8): in club id order.
- **Order (every advisory lock before the first row lock, R4 7.6):** R2's request-key lock -> the join-link lock
  (`lockJoinLinkActions`, A4) -> R4's club ceiling lock (only paths that call `lock_permission_actor`: S3) -> **the club
  limits lock** -> rows in the existing orders (D45's team, club membership, team membership; the users-first rights
  locks of LO-1 / R4 7.6). The club is known before `BEGIN`: a team's club is read unlocked (teams never move, D43); A8
  reads the athlete's active club memberships unlocked, locks those clubs, then re-reads them under lock and answers
  `409 try_again` if the set changed.
- **Paths that only lower a count** (archives, revocations, plan upgrades) do not take the lock.
- **A plan or exception change for club C** takes the club limits lock too, so an add in flight sees either the old or the
  new limit, never a mix. A plan **definition** change (many clubs) does not take club locks: adds read the plan row `FOR
  SHARE` after the club lock; the plan edit takes it `FOR UPDATE` and no club lock, so no cycle.
- Bounded waits: `lock_timeout` as in the route today (5 s in the D45 routes); a `55P03` is `409 try_again`, nothing
  written.
- T1, T2 and A8 become explicit transactions (today a bare `query()`).

### 4.3 Downgrade (L3)

Changing a club's plan writes only `club_subscriptions` and a change row. Nothing is archived or deleted. A club over a
limit keeps everything; every new add of that kind is refused until the count is below the limit (an add is refused when
**count after the add > limit**). Removing a feature from the plan closes its module (Q9) without deleting data; reopening
brings everything back (R4 O1).

### 4.4 Database backstop (recommendation)

A deferred constraint trigger on `public.teams` (insert, and `is_active` false -> true), `public.athlete_memberships`
(club rows made active), `public.athletes` (`is_active` false -> true), and on the three role tables and `users.is_active`
for seats, that for each touched club with a plan (a) requires the club limits lock held (the `pg_locks` check of R4 7.6,
`55000` otherwise) and (b) refuses `23514` "club limit not allowed" when the count is over the effective limit **and**
this transaction raised it. Like R4, the service answers before the trigger ever fires; the trigger catches a forgotten
path. Its cost (a count per touched club at COMMIT) is measured in PL-1. If it proves too costly, the alternative is the
grep test alone (5, PL-1 tests). Q11.

### 4.5 Answers and codes

On every add path the existing rights check (and its identical 404 / 403, ADR-006) runs **first**; only a caller with
the right to add in that club learns the club's limit.

| Case | HTTP | Body |
|---|---|---|
| Team, athlete or seat limit reached | `409` | `{ "error": "plan_limit_reached", "limit": "teams" \| "active_athletes" \| "staff_seats" \| "staff_role", "roleId"?: ..., "used": n, "max": m, "message": "..." }` |
| A8 over in some club | `409` | the same, with `clubId` of the first club over (the platform admin may see every club) |
| Bulk / multi-step (A4 approval: club + team; T2: team + its coaches' seats) | `409` | the first limit hit; nothing written (one transaction) |
| Storage | `429` | the existing `storage_quota_exceeded` (`r2-upload-api-v1.md` Q10), unchanged |
| Feature not in plan | as R4's ceiling: the module answers what a closed module answers (R4 Q2: it does not exist for anyone in the club) | - |
| Busy | `409` | `try_again` |

UI sentences (English, the app's style; `<n>`, `<m>` from the answer):

| Who | Sentence |
|---|---|
| Club's admin, teams | "Your club's plan allows `<m>` teams, and the club has `<n>`. Archive a team, or ask OptiMove to change your plan." |
| Club's admin, athletes | "Your club's plan allows `<m>` active athletes, and the club has `<n>`. Archive an athlete from the club, or ask OptiMove to change your plan." |
| Club's admin, seats | "Your club's plan allows `<m>` staff members, and the club has `<n>`. Remove someone's access, or ask OptiMove to change your plan." |
| Club's admin, a role | "Your club's plan allows `<m>` people with the role `<Role>`, and the club has `<n>`." |
| A coach (not the club's admin) | "The club has reached its plan's limit (`<n>` of `<m>`). Ask your club's administrator." |
| A join approval | "The club has reached its athlete limit, so this request can't be approved now. It stays pending." (the application stays `pending`, Q13) |
| Platform admin | the club admin's sentence plus *Grant an exception* (a link to the club's plan screen) |

**What the club's admin sees:** Settings > Clubs > *Plan*: the plan's name; a table *Teams / Active athletes / Staff
members / per role / Storage* with `used of max` (or "No limit"), a mark on any row over the limit ("Over the plan:
nothing was removed, but you can't add more"), live exceptions with their end date, and the features the plan includes.
Read route `GET /api/organization/clubs/:clubId/plan` for a holder of `staff.assign` in the club and a platform admin;
everyone else the identical 404. The add forms read it to say the limit before the click where cheap (Teams and Athletes
lists show "`n` of `m`").

**Platform admin:** Settings > *Plans* (create, change, archive a plan; features; role limits), and on each club: assign
a plan with a reason, grant or end an exception with a reason and an optional end date. Every write has a `requestKey`.

## 5. Implementation pull requests

| PR | What | Level | Waits for |
|---|---|---|---|
| PL-0 | This contract | docs | - |
| PL-1 | Migration (4.1, 4.4 for teams and athletes), the count functions, `lockClubLimits`, the service `clubLimits.js`; T1, T2 and A1-A8 wired; `GET /clubs/:clubId/plan`; platform admin write routes (plans, assignment, exceptions). Tests: parallel adds (two adds at the last free place: one commits, one `plan_limit_reached`), a downgraded club keeps data and refuses adds, archived things do not count, an athlete in two teams counts once, recorded-SQL lock order per path, info hiding, a grep test that every `insert into public.teams` / `ensureActiveMembership` / `status = 'active'` writer in `backend/src` is on the reviewed list | **risky** (1, 2, 4) | R4-1 **merged** (migration numbering and the shared lock order of R4 7.6); no R4 code is needed |
| PL-2 | Staff seats: S1-S4 and T2's coaches, the seat count over the effective holdings, role limits; the backstop on the role tables | **risky** (2, 4) | R4-1 (holdings, custom roles' base role, ceiling-lock order with `lock_permission_actor`); counts R4-2's view holders if R4-2 is in |
| PL-3 | Storage: the club account's limit from the plan (`mediaStorage.js`) | ordinary-to-risky (a quota rule) | PL-1; Q8 decided |
| PL-4 | Features: a module missing from the club's plan is closed in R4's step 6 (`can()` and the twin read plan features beside `club_permission_ceiling`); the early GPS import gate in `gpexeImportAccess.js` | **risky** (2) | R4-1; each module acts from its VIEW step (R4 Q12); GPS earlier through its own gate |
| PL-5 | Screens: Plans (platform admin), the club's Plan panel, `n of m` on the add forms, the refusal sentences | ordinary | PL-1 (PL-2-PL-4 for their rows) |

## 6. Races and time

| Case | Answer |
|---|---|
| Two adds at the last free place | the club limits lock: one commits, the other counts it and is refused |
| An add while the platform admin downgrades | the downgrade takes the same lock: the add sees the old plan (and may finish) or the new one |
| An exception expires during a request | `expires_at` is compared with the transaction's time under the lock |
| An athlete is archived and added again in one minute | archive frees a place at COMMIT; the add counts after |
| A team restore with coaches | one transaction: team and seats counted together; refused as a whole |

## 7. Open questions for the owner (each with a recommendation)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Existing clubs on the day of the deploy: which plan? | No plan = no limits, so nothing changes at the deploy; you assign plans club by club. |
| Q2 | Can a limit be "unlimited"? | Yes (empty value), per limit. |
| Q3 | An athlete in two clubs: counted in each? | Yes. |
| Q4 | An athlete in the club but in no team: counted? | Yes. |
| Q5 | "Staff by role": one total seat number, per-role numbers, or both? | Both: a total, and optional numbers for chosen default roles (for example at most 2 specialists). A person counts once in the total. |
| Q6 | Do the club's admins take seats? | Yes. |
| Q7 | Is the platform admin also refused when a club is full? | Yes, he gets the same refusal and uses *Grant an exception* - the numbers stay honest. (The alternative: he is never refused, and the club simply shows "over the plan".) |
| Q8 | Storage: today a club coach's uploads use the coach's personal storage, not the club's. Should the club's plan pay for its coaches' uploads? | Not in this step: the plan sets the club's own storage account; moving coaches' uploads to the club's account is a separate decision and change. |
| Q9 | Features per plan: reuse the club licence of R4 (a module missing from the plan is closed like a module you close by hand)? What exactly is "advanced dashboards"? | Yes, reuse the licence (one mechanism). "Advanced dashboards" needs your definition (for example: own dashboards beyond the templates, or widgets beyond a list); until then dashboards stay a whole module. |
| Q10 | Exceptions: per limit, with a number and an optional end date? | Yes; an ended or expired exception goes back to the plan's value, nothing is deleted. |
| Q11 | A database guard behind the server check (a little slower adds, but nothing can slip past)? | Yes, as R4 does. |
| Q12 | Plans for independent coaches (private workspace)? | Later, with the private coach licence (R4 Q9). |
| Q13 | A join request when the club is full? | It stays pending; the approver sees why; approving works again once there is room. |
| Q14 | Payment, invoices, trial periods? | Out of this contract. |

## 8. Not in this contract

Payment and billing; plan prices and names (L6); private coach plans; moving coach uploads to club storage; the
reference-aware media GC; a per-team limit (all limits are per club).
