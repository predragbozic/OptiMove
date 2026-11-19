# Roles R2 contract: the roles schema, the SQL twin and the Roles API

This is the contract of step R2 of `docs/ai/roles-permissions-plan.md` (the *plan*; section 7: "The migration of
section 5, the SQL twin, the Roles API"). It makes the plan's sections 2.1 and 5 concrete. Where the plan does not
decide something, this document does not decide it either: the point is marked **OPEN** with options and a
recommendation, and collected in section 10. The owner's decisions of 2026-11-19 are in section 10.0 and are
written into the sections below.

| | |
|---|---|
| Status | **Proposed.** Not accepted; nothing is built. The owner decided O1-O6 and O8 on 2026-11-19 (section 10.0). Before any code: the owner's acceptance and the open points O7, O9, O10 and the plan's D4, a migration number agreed with the *Rukovodilac* of OptiMove (M1-M14), and both external reviews (the *Rukovodilac* and the *Nezavisni revizor*). |
| Mark | ★★: external-review triggers 1 (a migration), 2 (auth, roles, info hiding) and 4 (transactions, lock order, idempotency) of `CLAUDE.md`. |
| Written against | The plan at `3a6723a` (branch `docs/roles-permissions-plan`) and the R1 code at `f4dd289` (branch `feature/roles-r1-can`, PR #619, not merged when this was revised). Every `file:line` below is of `f4dd289` unless it names another commit. R2's implementation re-checks each at its own base. |
| Depends on | R1 merged (`backend/src/permissions.js`, `can()`), and the read-only production count of the plan's section 2.1 rule 2 (rows of `user_club_roles` / `user_team_roles` with another word; expected 0). |
| Migration | One file, number and name **not chosen** (M1). On 2026-11-19 the newest file of `migrations_v2/` on `f4dd289` and on `origin/main` is `202611191000_calendar_v81_athlete_questions.sql`. Working name: `<YYYYMMDDHHMM>_roles_v<N>_permission_roles.sql`. "vN" below means this migration. |
| Decides | The owner: O7, O9, O10 and the plan's D4, all open (section 10.1); O1-O6 and O8 are decided (section 10.0). The *Rukovodilac*: M1-M14, open (section 10.2). |

## 0. In short

- R2 adds nine tables in `public` (sections 2.1-2.7 and 2.9), the functions `public.user_has_permission()` and
  `public.lock_permission_actor()`, one CHECK on each of the two old scoped role tables, the Roles API (backend
  only), and moves `can()` from the code constant `BASIC_ROLE_PERMISSIONS` (`backend/src/permissions.js:200-215`)
  to the database. Module switches are not in R2: they are a later migration of their own (O6 (b), section 2.8).
- The migration assigns no role to anyone and reads no existing row to build its seed. The three old role tables stay
  the only way today's four roles are granted and revoked. For every existing account, every answer of `can()` on
  the day of the deploy is the answer R1 gives, with one stated exception: `roles.manage` now passes for a club's
  admin in its club (O1 (b)), a word no route checked before R2. A test proves it against the R1 constant
  (section 6).
- New behaviour exists only through the new routes: a platform admin makes system roles; a club's admin makes and
  assigns its club's roles, within the ceiling and dominance rules. An assignment of a non-basic role acts on the
  organization routes from R2 (O8 (a), section 6). Until a module moves (R4-R7) its words are in no starting set,
  a basic role takes none of them (O1 (b), section 3.3), and nothing checks them.

## 1. Scope

### 1.1 What R2 delivers

1. The migration vN: the tables, guards, functions, seed, row-level security and revokes of sections 2-4.
2. The backend Roles API of section 5 (a new service and router). No frontend (R3).
3. `can()` and `loadAuthorizationContext()` reading role items and non-basic assignments from the database
   (section 6).
4. A runbook with a read-only preflight, a post-check and a rehearsed rollback (section 7), and the tests of section 8.

### 1.2 What R2 does not deliver

| Not in R2 | Where |
|---|---|
| Any screen: Settings > Roles, assignment in Users, "My team", navigation by permission | R3 |
| The read / manage split, a workspace for a holder of a non-basic role, the fixes of the plan's section 1 facts 1-4 | R4 |
| Any change to `computeCapabilities`, `loadAvailableWorkspaces`, `managedTeamIds`, `requireCoach` or `/me` | R4 (rule 1 of the plan's 2.1: the old helpers never read the new context fields) |
| The system roles Director, Assistant coach, Analyst | R4, R5 (no row is seeded for them; section 3.3 says why they could not be valid yet) |
| Module switches: the tables `module_switches` and `module_switch_changes`, the twin's subtraction of closed modules, their two routes, and the display rule of the plan's D6f | A later migration of their own (O6 (b)), with its own contract; O4 (a) takes effect there. Section 2.8 keeps what that migration must do |
| The starting sets of any module but organization | The step that moves the module (plan section 4.1) |
| Replacing a database actor guard that names `club_admin` or `platform_admin` (v35, v38, v41, v52-v57 and later) | R6, R6a, with md5 preconditions |
| The account target rule (plan 2.1 rule 6), any change to the e-mail-change, password-reset or login-status routes, and `accounts.manage` in the Club admin role | Its own step, with its own migration (O1 (b), O5; plan D6e). Until then those actions stay platform-only |
| Granting or revoking `platform_admin`, `independent_coach`, `club_admin`, `team_coach` through the new tables | Not planned: the old routes stay (`backend/src/routes/organization.js:929`, `:972`, `:2986-3022`) |
| Aligning `organization.js` to 404-before-403 (it answers 403 first today, e.g. `:1101`, `:2827`) | A later, separate change (plan section 7, "What R1 must not do") |

## 2. The tables

All in schema `public`. Every table: row-level security enabled with no policy; `REVOKE ALL` from `PUBLIC` and,
where the roles exist, from `anon` and `authenticated` (the conditional form of
`migrations_v2/202611091000_app_error_events.sql:120-131`). Every function of vN: `REVOKE EXECUTE` from `PUBLIC`.
Every foreign key is `ON DELETE RESTRICT` and has an index on its referencing column(s). Every trigger refusal
carries a fixed message with no id, name, value or SQL text; `42501` means "the acting user may not", `23514`
means "the row or its chain is not allowed".

Free text is checked by `public.permission_text_ok(v text, max_len integer)`, a copy of the body of
`training_load.source_metric_text_ok` as v40 left it (`migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql:59-64`),
so `public` does not depend on a `training_load` function (M3).

### 2.1 `permission_modules` (lookup, 12 rows)

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `word` | text | no | - | PK; `word ~ '^[a-z_]{1,40}$'` |
| `label` | text | no | - | `permission_text_ok(label, 60)` |
| `sort_order` | smallint | no | - | unique; `> 0` |

INSERT only by a migration. `BEFORE UPDATE OR DELETE` (row) and `BEFORE TRUNCATE` (statement) raise `23514`
"permission modules: the list is fixed".

### 2.2 `permissions` and `permission_scope_types` (lookup, 52 and 89 rows)

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `word` | text | no | - | PK; `word ~ '^[a-z_]+(\.[a-z_]+){1,2}$'` and `char_length(word) <= 60` |
| `module_word` | text | no | - | FK `permission_modules(word)`; indexed |
| `platform_only` | boolean | no | `false` | - |
| `system_role_only` | boolean | no | `false` | `not (platform_only and system_role_only)` |
| `sort_order` | smallint | no | - | unique; `> 0` |

`permission_scope_types`: `permission_word` text not null FK `permissions(word)`; `scope_type` text not null,
`scope_type in ('club', 'team', 'private', 'global')`; PK `(permission_word, scope_type)`.

The plan names "allowed scope types" as an attribute of a permission. It is a child table here because both lookup
tables refuse UPDATE: a later step that opens a word for the private workspace adds one row by an INSERT migration
(M4). A deferred constraint trigger on `permissions` requires at least one scope-type row per word, and
`platform_only = (its only scope type is 'global')` (R1's test a2), else `23514`. Both tables refuse UPDATE, DELETE
and TRUNCATE (`23514` "permissions: the catalog is fixed").

### 2.3 `permission_roles`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `owner_scope` | text | no | - | `in ('system', 'club')` |
| `owner_club_id` | uuid | yes | - | FK `clubs(id)`; `(owner_scope = 'system') = (owner_club_id is null)`; indexed |
| `name` | text | no | - | `permission_text_ok(name, 80)` (O7, open) |
| `description` | text | yes | - | null or `permission_text_ok(description, 500)` |
| `assignable_club`, `assignable_team`, `assignable_private`, `assignable_global` | boolean | no | `false` | at least one true; a club's role: `private` and `global` false; `assignable_global` only where `basic_key = 'platform_admin'` |
| `is_basic` | boolean | no | `false` | `is_basic = (basic_key is not null)` (O10, open); a basic role is `system` |
| `basic_key` | text | yes | - | `in ('platform_admin', 'club_admin', 'team_coach', 'independent_coach')`; unique where not null |
| `copied_from_role_id` | uuid | yes | - | FK `permission_roles(id)`; indexed; only on a club's role |
| `copied_from_revision` | integer | yes | - | null exactly when `copied_from_role_id` is null |
| `revision` | integer | no | `1` | `>= 1`; raised by exactly 1 by every change |
| `archived_at` | timestamptz | yes | - | null together with `archived_by_user_id`; a basic role is never archived |
| `archived_by_user_id` | uuid | yes | - | FK `users(id)`; indexed |
| `created_by_user_id` | uuid | yes | - | FK `users(id)`; indexed; null exactly for the four seeded rows |
| `created_at`, `updated_at` | timestamptz | no | `now()` | - |

Indexes: unique `(coalesce(owner_club_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) where
archived_at is null` (O7, open; written as its recommendation (a)); `(owner_club_id) where archived_at is null`.

Triggers:

| Trigger | Refuses | SQLSTATE, message |
|---|---|---|
| `BEFORE INSERT OR UPDATE`, actor guard | no acting user for this transaction (section 5.4); the row names another user; the acting user is neither an active platform admin nor, for a club's role, a holder of `roles.manage` for that active club | `42501` "permission role: the acting user may not write this role" |
| same | any change of `id`, `owner_scope`, `owner_club_id`, `is_basic`, `basic_key`, `copied_from_*`, `created_*`; a revision that is not the old one plus 1; any write to the row with `basic_key = 'platform_admin'`; a change of an archived role; `archived_at` going back to null | `23514` "permission role: this change is not allowed" |
| same | an `assignable_*` flag going from true to false while any row of `user_role_assignments` names the role (the plan: scope types "may only widen after the first assignment") | `23514` "permission role: a scope type cannot be removed once the role was assigned" |
| same | a widened `assignable_*` flag that an existing item's scope types do not cover | `23514` "permission role: an item does not cover the role's scope types" |
| same | `archived_at` set while an active assignment of the role exists (O3 (b); "active" as in 2.7). Revoked and lapsed rows do not count | `23514` "permission role: a role that is assigned cannot be archived" |
| `AFTER INSERT OR UPDATE`, deferred constraint | no `permission_role_changes` row of this transaction for this role and revision | `23514` "permission role: the change has no change record" |
| `BEFORE DELETE` (row), `BEFORE TRUNCATE` | always | `23514` "permission role: roles are archived, never deleted" |

### 2.4 `permission_role_items`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `role_id` | uuid | no | - | FK `permission_roles(id)`; PK `(role_id, permission_word)` |
| `permission_word` | text | no | - | FK `permissions(word)`; indexed |
| `added_by_user_id` | uuid | yes | - | FK `users(id)`; indexed; null only for seeded rows |
| `created_at` | timestamptz | no | `now()` | - |

A role's items are a set: INSERT and DELETE are the writes; UPDATE and TRUNCATE are refused. The role row serializes
its items (written under the role's `FOR UPDATE`, read under `FOR SHARE`).

| Guard (`BEFORE INSERT OR DELETE`, row) | SQLSTATE, message |
|---|---|
| the role row was not updated by this transaction (its `xmin` is not this transaction's id), or the acting user fails the role's actor guard | `42501` "permission role item: the acting user may not write this role" |
| the role is the Platform admin role (it has no item rows, M5) or is archived | `23514` "permission role item: this role's items cannot change" |
| INSERT of a `platform_only` word into any role | `23514` "permission role item: a platform-only permission belongs to no role" |
| INSERT of a `system_role_only` word into a club's role (plan 2.1 rule 5) | `23514` "permission role item: this permission exists only in system roles" |
| INSERT of a word whose scope types do not include every scope type the role is assignable for | `23514` "permission role item: the permission does not cover the role's scope types" |
| **ceiling**: INSERT of a word the acting user does not hold for the role's owner (`user_has_permission(actor, word, 'club', owner_club_id)`; for a system role: an active platform admin) | `42501` "permission role item: the acting user does not hold this permission" |
| **dominance**: any INSERT or DELETE while the acting user does not hold every item the role has at that moment (plan 2.1 rule 3) | `42501` "permission role item: the acting user does not hold every permission of this role" |
| rule 7, at COMMIT (deferred): the Club admin role lacks a required word, or a system role holds a club-scope word that the Club admin role lacks. The required list is a literal in the guard function: `staff.assign` and `roles.manage` (O1 (b)). It grows only by a later migration that replaces the function, `accounts.manage` first, when account actions move with their target rule | `23514` "permission role item: the Club admin role must hold this permission" |

### 2.5 `permission_role_module_display`

`role_id` uuid not null FK; `module_word` text not null FK (indexed); `display` text not null,
`in ('hidden', 'locked')`; PK `(role_id, module_word)`. No row means `hidden` (the plan's default, D6b). INSERT,
UPDATE of `display` and DELETE are allowed under the same actor and same-transaction rule as items; TRUNCATE is
refused. R2 stores and returns it; nothing reads it before R3. This is the display of a section closed for a
**role**. The display of a module the platform closed for a **club** (plan D6f) is not this table's; it comes with
the module-switch migration (section 2.8).

### 2.6 `permission_role_changes` (append-only)

| Column | Type | Null | Constraint |
|---|---|---|---|
| `id` | uuid | no | PK, `gen_random_uuid()` |
| `role_id` | uuid | no | FK; unique `(role_id, revision_after)` |
| `revision_after` | integer | no | `>= 1` |
| `kind` | text | no | `in ('create', 'copy', 'change', 'archive')` |
| `performed_by_user_id` | uuid | no | FK `users(id)`; indexed |
| `basis` | text | no | `in ('platform_admin', 'club_admin')`; a system role: `platform_admin` only |
| `reason` | text | yes | `permission_text_ok(reason, 500)`; not null for `change` and `archive` |
| `name_before`, `name_after` | text | yes | both null or both set |
| `description_changed` | boolean | no | default `false` |
| `items_added`, `items_removed` | text[] | no | default `'{}'`; no word in both |
| `scope_types_added` | text[] | no | default `'{}'` |
| `display_after` | jsonb | yes | a flat object module word -> `hidden` / `locked`, checked by a function |
| `copied_from_role_id` | uuid | yes | FK; set exactly for `copy` |
| `created_at` | timestamptz | no | default `now()` |

A `change` row must change at least one thing (CHECK). `BEFORE INSERT`: the acting user is `performed_by_user_id`
(`42501`); the basis is the one the database derives (`42501`); the role row carries `revision_after` and was written
by this transaction, and the item rows of this transaction agree with `items_added` (`23514` "permission role
change: the record must follow its own change in the same transaction"). UPDATE, DELETE, TRUNCATE: `23514`
"permission role change: the record is append-only". The pattern is v35's and v38's
(`migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql:1-58`).

### 2.7 `user_role_assignments`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `user_id` | uuid | no | - | FK `users(id)` |
| `role_id` | uuid | no | - | FK `permission_roles(id)`; indexed |
| `scope_type` | text | no | - | `in ('club', 'team', 'private', 'global')` |
| `scope_id` | uuid | no | - | `global`: the nil UUID; `private`: equals `user_id`; `club`, `team`: not the nil UUID |
| `scope_club_id`, `scope_team_id` | uuid | yes | generated, stored | `scope_id` when `scope_type` is `club` / `team`; FK `clubs(id)` / `teams(id)`; indexed (M7) |
| `display_title` | text | yes | - | null or `permission_text_ok(display_title, 80)` |
| `granted_by_user_id` | uuid | no | - | FK `users(id)`; indexed |
| `grant_basis` | text | no | - | `in ('platform_admin', 'club_admin')` |
| `grant_reason` | text | no | - | `permission_text_ok(grant_reason, 500)` (M10) |
| `expires_at` | timestamptz | yes | - | null or `> created_at` (the plan's D4, open: written as its recommendation, an optional end date) |
| `revoked_at` | timestamptz | yes | - | null together with the three columns below |
| `revoked_by_user_id` | uuid | yes | - | FK `users(id)`; indexed |
| `revoke_kind` | text | yes | - | `in ('revoked', 'expired', 'replaced')` |
| `revoke_reason` | text | yes | - | `permission_text_ok(revoke_reason, 500)`; may be null only for `expired` |
| `created_at` | timestamptz | no | `now()` | - |

Indexes: unique `(user_id, role_id, scope_type, scope_id) where revoked_at is null`; `(user_id) where revoked_at is
null`; `(scope_type, scope_id) where revoked_at is null`.

"Active" everywhere means `revoked_at is null and (expires_at is null or expires_at > now())`. `now()` is the
transaction's start, on purpose: a transaction in flight when a row expires finishes under the answer it started
with (plan section 5). No job stamps an expired row; the next grant of the same (user, role, scope) first stamps it
`expired` and then inserts.

| Guard | SQLSTATE, message |
|---|---|
| `BEFORE INSERT`: no acting user, or the row's `granted_by_user_id` is another user | `42501` "role assignment: the row names another user than the acting user" |
| the acting user holds neither `staff.assign` for the scope's club nor the platform admin role; `grant_basis` is not the derived one | `42501` "role assignment: the acting user may not assign roles here" |
| the acting user does not hold every item of the role in that scope (ceiling and dominance; a platform admin holds everything) | `42501` "role assignment: the acting user does not hold every permission of this role" |
| the role has a `basic_key` (the old tables stay their only source); `scope_type = 'global'` | `23514` "role assignment: this role is not assigned here" |
| the role is archived; not assignable for `scope_type`; a club's role outside its club (club scope: `scope_id` is not `owner_club_id`; team scope: the team's `club_id` is not) | `23514` "role assignment: the role cannot be assigned for this scope" |
| the user is inactive; the club or team (or the team's club) is missing or archived; a `private` scope whose user holds no active `independent_coach` row | `23514` "role assignment: the user or the scope takes no assignment" |
| `user_id = granted_by_user_id` (M11) | `23514` "role assignment: nobody assigns a role to themselves" |
| `BEFORE UPDATE`: anything but the four revocation columns going from null to a value, together; the acting user is not `revoked_by_user_id`; the acting user is neither a platform admin, nor the scope's club's admin (basic Club admin), nor a `staff.assign` holder who holds every item of the role | `23514` "role assignment: only a revocation may change the row" / `42501` "role assignment: the acting user may not revoke this assignment" |
| `AFTER INSERT OR UPDATE`, deferred: no `permission_requests` row of this transaction names the assignment | `23514` "role assignment: the write has no request record" |
| `BEFORE DELETE`, `BEFORE TRUNCATE` | `23514` "role assignment: assignments are revoked, never deleted" |

### 2.8 Module switches: not in R2 (O6 (b))

The owner decided on 2026-11-19 that module switches are a later migration of their own. R2 creates neither
`module_switches` nor `module_switch_changes`, ships no route for them, and its twin subtracts nothing. This section
keeps its number so that the other section numbers stay as they were; it is a note for that later step, not part of
what R2 delivers.

What the later migration must do:

- create the two tables of the plan's section 5 (a switch per club and per independent coach; no row means on, so no
  backfill; an append-only change table), with the actor guard, the change record and the exposure rules of this
  section 2;
- replace the body of `public.user_has_permission()` (and of `public.user_holds_role_items()`) under an md5
  precondition on the body vN leaves, so that step 7 of 4.1 also requires the word's module not to be switched off
  for the scope's owner; and give `can()` the same subtraction, with its own old-vs-new test;
- keep step 3 of 4.1 first: a platform admin is exempt from a club's module switch, with the basis on the audit row
  (O4 (a), plan 2.1 rule 4);
- carry the display rule of the plan's D6f: the platform admin still sees and opens a module it closed for a club;
  the club's admin sees it locked; coaches and everyone else of the club do not see it;
- add the switch row to the lock order at place 5 of 4.3, the operation and result column of a switch write to
  `permission_requests` (2.9), and its routes to the Roles API;
- decide whether `organization` can be switched off (this contract's earlier recommendation: no, a club must keep
  its people and role management).

### 2.9 `permission_requests` (the request record, append-only; the v36 pattern)

| Column | Type | Null | Constraint |
|---|---|---|---|
| `id` | uuid | no | PK |
| `request_key` | uuid | no | unique `(requested_by_user_id, request_key)` |
| `requested_by_user_id` | uuid | no | FK `users(id)` |
| `operation` | text | no | `in ('role_create', 'role_copy', 'role_change', 'role_archive', 'assignment_grant', 'assignment_revoke')` |
| `request_hash` | text | no | `~ '^[0-9a-f]{64}$'` |
| `owner_scope` | text | no | `in ('system', 'club', 'private')` |
| `owner_id` | uuid | yes | null exactly for `system` |
| `basis` | text | no | `in ('platform_admin', 'club_admin')` |
| `role_change_id` | uuid | yes | FK `permission_role_changes(id)`; unique where not null |
| `assignment_id` | uuid | yes | FK `user_role_assignments(id)`; indexed |
| `created_at` | timestamptz | no | default `now()` |

Exactly one of the two result columns is set, the one the operation names (CHECK). Unique
`(assignment_id, operation)`. `BEFORE INSERT`: the acting user is `requested_by_user_id` and holds the derived basis
(`42501`); the result row was written by this transaction (`23514` "permission request: the request must follow its
own operation in the same transaction"). The row is the last write of every write transaction of section 5. A row
written inside a savepoint is refused (its result row carries the subtransaction's id): fail closed, as v36
(`migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql:49-53`).

### 2.10 The two old scoped role tables

Today `public.user_global_roles` has a CHECK on its word and the other two have none
(`backend/tests/support/legacy-schema.sql:14409`, `:14386-14397`, `:14424-14435`); their routes refuse any other word
before anything else (`backend/src/routes/organization.js:2988`, `:2998`, `:3008`, `:3018`), and R1's tests c1-c3
(`backend/tests/permissions-r1.test.mjs:938-1059`) prove that no code path writes another one. vN adds:

```sql
alter table public.user_club_roles add constraint user_club_roles_role_word check (role = 'club_admin');
alter table public.user_team_roles add constraint user_team_roles_role_word check (role = 'team_coach');
```

Before them, a `DO` block counts every row (active or not) with another word in each table and, above 0, raises
`23514` "vN refused: public.user_club_roles holds a role word other than club_admin" (or the team sentence). The
whole migration then rolls back: the runner applies a file in one transaction (`backend/src/migrate.js:780-791`) and
`npm start` stops on the deploy. The count is also preflight block 3, so the refusal is never met in production.
The two `ALTER TABLE` statements are the last statements of the file (section 7.4). The column defaults, the unique
keys and the indexes of the three tables stay as they are.

## 3. The seed (a fixed literal list)

vN reads no row of any existing table to build the seed. The four role ids are literal UUIDs written in the file.

### 3.1 Modules

| sort | Word | Label |
|---|---|---|
| 1 | `organization` | Organization and staff |
| 2 | `athletes` | Athletes |
| 3 | `programs` | Programs (Builder) |
| 4 | `exercises` | Exercises |
| 5 | `presets` | Tags and presets |
| 6 | `calendar` | Calendar |
| 7 | `training_load` | Training Load |
| 8 | `dashboards` | Dashboards |
| 9 | `imports` | Imports |
| 10 | `tests` | Tests |
| 11 | `messages` | Messages |
| 12 | `data_configuration` | Data configuration |

These are the keys, labels and order of `PERMISSION_GROUPS` (`backend/src/permissions.js:128-185`). The groups'
**levels** stay a code constant: a level is an editor shortcut and a role is stored as its words (plan section 3.0).

### 3.2 Permissions (52 words, 89 scope-type rows)

Generated from `PERMISSIONS` (`backend/src/permissions.js:40-107`) at `f4dd289`; `sort_order` is the row number.
The 52nd word is `org.club.edit` (O2), row 3. The 89 scope-type rows are: 37 words for club and team (74), 9 for a
club only, 2 for a team only, 4 global. `platform.admin` belongs to the module `organization` in R1's catalog
(`:50`), although the plan's table lists it under "Platform only".

| # | Word | Module | Scope types | platform_only | system_role_only |
|---|---|---|---|---|---|
| 1 | `org.view` | `organization` | club, team | no | no |
| 2 | `org.teams.manage` | `organization` | club | no | no |
| 3 | `org.club.edit` | `organization` | club | no | no |
| 4 | `accounts.manage` | `organization` | club | no | yes |
| 5 | `staff.assign` | `organization` | club | no | yes |
| 6 | `roles.manage` | `organization` | club | no | yes |
| 7 | `platform.admin` | `organization` | global | yes | no |
| 8 | `athletes.view` | `athletes` | club, team | no | no |
| 9 | `athletes.manage` | `athletes` | club, team | no | no |
| 10 | `athletes.remove` | `athletes` | club, team | no | no |
| 11 | `athletes.logins.manage` | `athletes` | club, team | no | no |
| 12 | `athletes.library_access` | `athletes` | club, team | no | no |
| 13 | `join_links.manage` | `athletes` | club, team | no | no |
| 14 | `programs.view` | `programs` | club, team | no | no |
| 15 | `programs.edit` | `programs` | club, team | no | no |
| 16 | `programs.assign` | `programs` | club, team | no | no |
| 17 | `programs.publish` | `programs` | club, team | no | no |
| 18 | `programs.rpe_settings` | `programs` | club, team | no | no |
| 19 | `presets.use` | `presets` | club, team | no | no |
| 20 | `presets.manage` | `presets` | club, team | no | no |
| 21 | `exercise_lists.manage` | `presets` | club, team | no | no |
| 22 | `exercises.use` | `exercises` | club, team | no | no |
| 23 | `exercises.add` | `exercises` | club, team | no | no |
| 24 | `exercises.media.upload` | `exercises` | club, team | no | no |
| 25 | `exercises.remove` | `exercises` | club, team | no | no |
| 26 | `exercises.blocks.manage` | `exercises` | global | yes | no |
| 27 | `calendar.view` | `calendar` | club, team | no | no |
| 28 | `calendar.events.manage` | `calendar` | club, team | no | no |
| 29 | `calendar.settings.manage` | `calendar` | club | no | no |
| 30 | `load.view.team` | `training_load` | club, team | no | no |
| 31 | `load.view.athlete` | `training_load` | club, team | no | no |
| 32 | `load.schedule.manage` | `training_load` | club, team | no | no |
| 33 | `load.roster.decide` | `training_load` | club, team | no | no |
| 34 | `load.estimates.manage` | `training_load` | club, team | no | no |
| 35 | `load.activities.manage` | `training_load` | club, team | no | no |
| 36 | `dashboards.view` | `dashboards` | club, team | no | no |
| 37 | `dashboards.manage` | `dashboards` | club, team | no | no |
| 38 | `import.check` | `imports` | club, team | no | no |
| 39 | `import.link` | `imports` | club, team | no | no |
| 40 | `import.approve` | `imports` | team | no | no |
| 41 | `import.undo` | `imports` | team | no | no |
| 42 | `tests.view` | `tests` | club, team | no | no |
| 43 | `tests.results.view` | `tests` | club, team | no | no |
| 44 | `tests.schedule.manage` | `tests` | club, team | no | no |
| 45 | `tests.library.manage` | `tests` | global | yes | no |
| 46 | `messages.send` | `messages` | club, team | no | no |
| 47 | `variables.view` | `data_configuration` | club, team | no | no |
| 48 | `variables.rename_archive` | `data_configuration` | club, team | no | no |
| 49 | `variables.manage` | `data_configuration` | club | no | no |
| 50 | `mappings.manage` | `data_configuration` | club | no | no |
| 51 | `sources.connect` | `data_configuration` | club | no | no |
| 52 | `platform.metrics.manage` | `data_configuration` | global | yes | no |

No word has the scope type `private` in the seed: R1's catalog has none, and R1's `can()` throws for a scope type
other than `global`, `club`, `team` (`backend/src/permissions.js:262-264`). Which words exist in a private workspace
is O9 (open). This section follows its recommendation (a): none in R2.

### 3.3 Basic roles and their starting items

| `basic_key` | Name | Assignable for | Items seeded |
|---|---|---|---|
| `platform_admin` | Platform admin | global | none; holds everything by rule, not by rows (M5); not editable |
| `club_admin` | Club admin | club | `org.view`, `org.teams.manage`, `org.club.edit`, `athletes.manage`, `athletes.remove`, `staff.assign`, `roles.manage` (7) |
| `team_coach` | Team coach | team | `org.view`, `athletes.manage`, `athletes.remove` (3) |
| `independent_coach` | Independent coach | private | none (O9, open) |

So the seed has 10 item rows.

**What is proven and what is not.** Six of the seven Club admin words and the three Team coach words are R1's
`BASIC_ROLE_PERMISSIONS` (`backend/src/permissions.js:200-215`), each word derived from the predicate it replaced and
proven by R1's old-vs-new tests (b2, b5). The seventh, `roles.manage`, is new in R2 (below). R1 has no Independent
coach set at all. Every other cell of the plan's section 4.1 is the intent, not a derived set; each item is added by
the step that moves its module, by an INSERT in that step's migration, with its own old-vs-new test. Until then
nothing but a platform admin passes `can()` for a word of an unmoved module, as R1's test b4 states.
`import.approve` is in no starting set (plan section 5).

**Rule 7, as the owner decided it (O1 (b), O5; plan D6e and 2.1 rule 7).** The Club admin role always contains
`staff.assign` and `roles.manage`, and every club-scope permission any other system role carries. `accounts.manage`
joins the list once account actions leave the platform. Against the code at `f4dd289`:

- `staff.assign` is proven and seeded.
- `roles.manage` is checked by no route today. The Roles API is its first use, so R2 is the step that moves it:
  seeding it gives a club's admin the role editor, which is D1, through new routes only. It is the one word whose
  answer differs from R1's on the day of the deploy (section 6).
- `accounts.manage` is **not** seeded into Club admin. It is checked only at global scope today
  (`organization.js:673`, `:730`, `:785`, `:817`, `:836`, `:880`), which is "a platform admin only, whatever the
  word". Creating an account (`POST /users`, `:436`) and the login switch (`:584-593`) do not go through `can()` at
  all. E-mail change and password reset stay platform-only. The word stays in the catalog as system-role-only; the
  step that moves account actions adds it to Club admin and to the rule-7 list by its own migration, together with
  the target rule (plan 2.1 rule 6).
- The second half of rule 7 means: a system role can hold a club-scope word only after the Club admin role holds
  it. In R2 a basic role takes no word of a module that has not moved: the service refuses it with
  `module_not_adjustable_yet`. The list of moved modules is a code constant that starts with `organization`; each
  later step adds its module. So in R2 no system role, basic or made by a platform admin, carries a club-scope word
  of an unmoved module beyond the two `athletes` words of the seed. This is why Director, Assistant coach and
  Analyst are made in R4 and R5, with their modules.

## 4. The functions

### 4.1 `public.user_has_permission(p_user uuid, p_permission text, p_scope_type text, p_scope_id uuid) returns boolean`

`STABLE`, `LANGUAGE plpgsql`, not `SECURITY DEFINER`, `SET search_path = pg_catalog, public`. It takes no lock (a
row lock is not allowed in a non-volatile function) and caches nothing in a session setting. In order:

1. `p_permission` not in `permissions`, or `p_scope_type` not one of `global`, `club`, `team`, `private`: raises
   `22023` "permission check: unknown permission or scope type". `can()` throws for both, also for a platform admin
   (`permissions.js:259-264`, R1's test b6) (M12).
2. `p_user` is null, unknown or inactive (`users.is_active`): `false` (M13).
3. `p_user` holds an active `platform_admin` row of `user_global_roles`: `true`. O4 (a) keeps this step first
   when module switches arrive (section 2.8).
4. The word is `platform_only`, or `p_scope_type = 'global'`: `false`. **Convention 1** of `can()`: global scope is
   a platform admin only, whatever the word (`permissions.js:244-247`, `:266`).
5. `p_scope_id` is null or the nil UUID: `false`. **Convention 3**: a club or team scope without an id is no
   resource (`permissions.js:252-255`, `:267`).
6. The user's roles for the scope are the union of two sources:

   | Scope | (b) old tables, mapped by word to the basic role | (a) active rows of `user_role_assignments` |
   |---|---|---|
   | `club` X | an active `user_club_roles` row (X, `club_admin`) -> Club admin | scope `club` X |
   | `team` T of club X | an active `user_team_roles` row (T, `team_coach`) -> Team coach; an active `user_club_roles` row (X, `club_admin`) -> Club admin | scope `team` T; scope `club` X |
   | `private` U | `p_user = U` and an active `independent_coach` row -> Independent coach | scope `private` U, only where `p_user = U` |

   The `private` row depends on O9 (open). Under its recommendation (a) no word has the scope type `private` and
   the Independent coach role has no items, so in R2 a check at private scope is `false` for everyone but a
   platform admin.

   The team row is **convention 2**: a club's word holds at a team under that club, so a word assignable only for a
   club may be checked at team scope (`permissions.js:248-251`, `:271-272`). The catalog's scope types say where a
   role may be assigned, not which scopes a check may name; the function does not consult them. A team that does not
   exist gives no role. As `managedTeamIds` today (`backend/src/authz.js:74-76`), the club's reach covers an
   archived team too; an archived club or team is the route's resource check, not this function's (M13).
7. `true` if any of those roles, not archived, has the word in `permission_role_items`; else `false`. Nothing is
   subtracted in R2: the plan's "minus the modules closed for that club or coach" (2.1 rule 4) is added by the
   module-switch migration, which replaces this body under an md5 precondition (O6 (b), section 2.8).

A companion `public.user_holds_role_items(p_user, p_role_id, p_scope_type, p_scope_id) returns boolean` (same
attributes) answers "holds every item of this role in this scope" for the guards of 2.4 and 2.7.

For the two basic sets of 3.3 and no assignment, steps 3-7 return exactly what `can()` returns at `f4dd289`
(`permissions.js:265-272`), apart from `roles.manage`, which R1's constant does not hold and the seed gives to
Club admin; test 31 of section 8 proves it over the whole matrix.

### 4.2 `public.lock_permission_actor(p_user uuid, p_scope_type text, p_scope_id uuid) returns text`

`VOLATILE`, not `SECURITY DEFINER`, the same `search_path`. Called once per transaction, before the first write. It
locks `FOR SHARE` every row the answer of 4.1 for that user and scope rests on, in the order of 4.3, and returns the
basis (`platform_admin`, `club_admin`, or null). After it, calls of 4.1 in the same transaction read rows that a
concurrent revocation or role edit must wait for.

### 4.3 The one lock order

For the lock function, the guards, the role editor, assignment and revocation:

1. The acting user's `users` row, `FOR SHARE`, in a statement of its own (as v54:
   `migrations_v2/202611041100_training_load_v54_rights_locks_users_first.sql:57-58`).
2. For an assignment or a revocation: the other user's `users` row, `FOR SHARE` (M6).
3. Assignment rows: first the acting user's rows of the old tables (`user_global_roles`, then `user_club_roles`,
   then `user_team_roles`), `FOR SHARE`; then rows of `user_role_assignments` by `id` ascending (the acting user's
   `FOR SHARE`; the row being revoked `FOR NO KEY UPDATE`).
4. Role rows of `permission_roles` by `id` ascending: `FOR UPDATE` for the role being edited or archived,
   `FOR SHARE` for every role only read. The role row serializes its items and its display rows.
5. (Not in R2.) The module switch row takes this place when the module-switch migration adds it (section 2.8), as
   the plan's section 5 orders it. Nothing is locked here in R2.
6. The request record: the last write.

The editor's own rights (1 and 3) are locked before the role it edits (4), so a right lost at the same moment
cannot be handed on. Every lock is taken before the first write. No club or team row is locked; the existing
headcount advisory locks (`organization.js:534-536`, `:2739-2741`) are not taken by any R2 route, because no R2
route grants or revokes a basic role.

Required proofs (`.claude/rules/migrations.md`, "Lock order: rights rows"):

- a recorded-SQL-order test per write route: the statements the service sends, in order; no locking clause between
  the first write and the COMMIT;
- route-against-route tests, each asserting no `40P01` in the log: a role edit against a holder's guarded write; a
  revocation (the old `DELETE …/club-roles/…` route and the new revoke) against a role save by the same user; an
  assignment against the old revocation of the granter.

## 5. The API

A new router and service, mounted at `/api/organization/roles` behind `requireAuth` and `requireCoach`, as the
organization router is (`backend/src/server.js:138`) (M8). No frontend. Identity comes only from the session; a body
never names an actor, a basis or an owner other than the `clubId` of the resource.

**Scope of a call.** `clubId` (query or body) names the club whose roles are meant; without it the call is about
system roles. The active workspace is never read (plan 2.1 rule 10). **404 before 403** (rule 11): the service first
resolves the club (exists, active) and the caller's standing there; a missing club, an archived club, a club where
the caller holds nothing the route accepts, and a role or assignment id of another club all answer the identical
`404 {"error": "notFound"}` (the shape of `backend/src/routes/sourceMetrics.js:47-49`). There is no 403.

### 5.1 Who may call what

| # | Route | Platform admin | Holder of `roles.manage` for the club | Holder of `staff.assign` for the club | Anyone else |
|---|---|---|---|---|---|
| P1 | `GET /catalog?clubId=` | yes | yes | yes | 404 |
| P2 | `GET /?clubId=&state=` | yes (all system roles; with `clubId`, that club's too) | system roles read-only + its club's | same, read-only | 404 |
| P3 | `GET /:roleId` | yes | a system role, or its club's | same | 404 |
| P4 | `POST /` (create) | system or any active club | its club only | 404 | 404 |
| P5 | `POST /:roleId/change` | any role but Platform admin | its club's roles | 404 | 404 |
| P6 | `POST /:roleId/archive` | a non-basic role | its club's roles | 404 | 404 |
| P7 | `POST /:roleId/copy` | into any active club | a system role into its club | 404 | 404 |
| P8 | `GET /assignments?clubId=&roleId=&userId=` ("who holds what") | yes | yes | yes | 404 |
| P9 | `POST /assignments` | yes | - | yes, within ceiling and dominance | 404 |
| P10 | `POST /assignments/:assignmentId/revoke` | yes | - | yes, per 2.7 | 404 |

There is no route for module switches in R2 (O6 (b)); the earlier draft's P11 and P12 come with that migration.

R2 seeds `roles.manage` and `staff.assign` into the Club admin role only (O1 (b)). Both words are
system-role-only, so no club's role can carry them, and R2 ships no other system role with them.

### 5.2 Bodies and answers

Every write body carries `requestKey` (a UUID). Text is trimmed nowhere: a value the text rule refuses is a `400`.

| # | Body | `200` returns |
|---|---|---|
| P1 | - | modules; permissions with scope types and flags; groups and levels (the code constant); `held`: the words the caller holds for the scope; `delegable`: `held` minus system-role-only words (for a club's role) |
| P2 | - | roles: `id`, `owner`, `name`, `description`, `scopeTypes`, `isBasic`, `basicKey`, `revision`, `archived`, `items`, `holderCount` (for a club caller: holders in that club only), `actions` the caller may take |
| P3 | - | P2's row plus `moduleDisplay`, `copiedFrom` (with `sourceChangedSince: true` when the system role's revision is above `copied_from_revision`, rule 8), and the change history |
| P4 | `clubId?`, `name`, `description?`, `scopeTypes[]`, `items[]`, `moduleDisplay?` | the role, revision 1 |
| P5 | `expectedRevision`, `reason`, and any of `name`, `description`, `items[]` (the full new set), `scopeTypes[]`, `moduleDisplay` | the role at its new revision, `affected: { people, clubs }` |
| P6 | `expectedRevision`, `reason` | the archived role; refused with `role_has_assignments` while an active assignment exists (O3 (b)) |
| P7 | `clubId`, `name?` | the new club role: a snapshot of the source's items, minus system-role-only words and minus words the caller does not hold; `dropped[]` lists them |
| P8 | - | rows "user - role - scope" from both sources: the old tables (as basic roles, `source: "basic"`) and `user_role_assignments`, with title, granted by, expiry and state; keyset pages of 100 |
| P9 | `userId`, `roleId`, `scopeType`, `scopeId`, `displayTitle?`, `expiresAt?` (the plan's D4, open), `reason` | the assignment; a lapsed row of the same key is stamped `expired` first |
| P10 | `reason`, `expected: { userId, roleId }` | the revoked assignment |

`400` (nothing locked, nothing written): a malformed id or `requestKey`, a missing or refused text, an unknown
permission or module word, an unknown scope type, `expiresAt` not in the future, an empty change.

`409`, each with a stable `code` and a fixed sentence; a refusal is never database text (rule 15):

| Code | When |
|---|---|
| `staleRevision` | `expectedRevision` is not the row's revision; the answer carries the current role |
| `role_name_taken` | the owner already has a non-archived role of that name (O7, open) |
| `role_not_editable` | the Platform admin role; a basic role on archive |
| `role_archived` | a change, a copy or an assignment of an archived role |
| `role_has_assignments` | an archive while an active assignment of the role exists (O3 (b)); the answer carries the count the caller may see. A role whose assignments are all revoked or lapsed can be archived |
| `permission_not_held` | ceiling: `words[]` names the words of the request the caller does not hold |
| `role_exceeds_your_permissions` | dominance: the caller does not hold every item of the role (edit, archive, assign, revoke) |
| `permission_not_delegable` | a system-role-only word in a club's role |
| `permission_platform_only` | a platform-only word in any role |
| `permission_scope_mismatch` | a word that does not cover the role's scope types |
| `module_not_adjustable_yet` | a word of a module that has not moved, added to a basic role (O1 (b)). A service check against a code constant of moved modules, which holds `organization` in R2 |
| `club_admin_requires` | rule 7: the change would leave the Club admin role without `staff.assign` or `roles.manage`, or would give a system role a club-scope word the Club admin role lacks |
| `scope_types_narrowed` | a scope type removed from a role that was assigned |
| `role_not_assignable_here` | a basic role (use the existing routes), a global scope, a scope type the role does not have |
| `assignment_exists` | an active assignment of the same user, role and scope, under another `requestKey`; carries its id |
| `assignment_already_revoked` | a revoke of a revoked or lapsed row under a new key; carries the current state |
| `assignment_mismatch` | `expected` does not name the row's user and role |
| `self_assignment` | the caller names itself (M11) |
| `user_inactive` | the target account's login is off |
| `request_key_reused` | the same key with another body or operation |
| `try_again` | a bounded lock wait (`55P03`) or a deadlock (`40P01`); nothing was written |

### 5.3 The write, and the COMMIT's outcome

One transaction per write, `READ COMMITTED`, bounded right after `BEGIN` (`lock_timeout` 5 s, `statement_timeout`
10 s, `idle_in_transaction_session_timeout` 10 s):

1. Replay: a request row of (caller, `requestKey`) with the same hash and operation answers the current state of its
   result, after the caller's standing is evaluated again (`backend-security.md`: a retry never reuses the first
   decision); another hash or operation is `request_key_reused`.
2. The acting-user setting (4.4), then `lock_permission_actor()` and the remaining locks of 4.3.
3. Every check of 5.2, again, under the locks.
4. The writes; the change row; the request row last.
5. `SET CONSTRAINTS ALL IMMEDIATE`, so a deferred refusal is a definite failure before the COMMIT is sent.
6. COMMIT, awaited for a bounded time.

| Outcome | Answer |
|---|---|
| Not written: a refusal or an error before the COMMIT was sent | the `400` / `404` / `409` above, or a sanitized `500 internal_error` for an unmapped guard refusal |
| Written: the COMMIT answered | `200` |
| The COMMIT's answer was an error other than an ordinary refusal by PostgreSQL, or never came: the connection is closed and the request row is looked up on another connection (bounded) | found: `200` with `verified_after_commit_error: true`; not found or not readable: `503 outcome_unknown`, never "nothing was written" |

After `outcome_unknown` the client repeats the same request with the same `requestKey`; it can never write twice. A
failed read after a confirmed COMMIT still answers `200`, with `readError: true`.

### 5.4 The acting user in the database

Before its first protected write the service sets the transaction-local `optimove.permission_actor` =
`<user uuid>:<id of this transaction>` from the session, and `public.permission_context_actor()` returns it or raises
`42501` "permissions: no acting user is set for this transaction" (missing, malformed, or of another transaction).
This is v35's mechanism under its own name (`…v35_source_metric_actor_guards.sql:64-75`) (M2). The known limit is
v35's too: the guards keep an unintended write that bypasses the service out; they are no defence against whoever
controls the shared database credentials (`…v35…:38-47`).

## 6. How `can()` changes

- `loadAuthorizationContext()` (`backend/src/authz.js:23`, called once per request at `backend/src/auth.js:140`)
  gains two fields, read by one extra statement: `rolePermissions` (the item words of the basic roles the account
  holds and of its active non-basic assignments, per scope) and `roleAssignments` (the active non-basic
  assignments). The existing fields keep their shape and meaning. A third field for closed modules comes with the
  module-switch migration (O6 (b)), not in R2.
- By rule 1 of the plan's 2.1, `holdsClubAdminRole`, `canManageClub`, `canManageTeamById`, `computeCapabilities`,
  `managedTeamIds` and `loadAvailableWorkspaces` never read the new fields. A static test asserts it.
- `can(authz, permission, scope)` keeps its signature, its two throws and its conventions. The platform-admin
  short-circuit stays first and reads no new field. For everyone else the answer is section 4.1's steps 4-7 over the
  context. It accepts the scope type `private` (answering as 4.1; O9, open); `privateScope(userId)` is added beside
  `clubScope` / `teamScope`.
- `PERMISSIONS` and `PERMISSION_GROUPS` stay in the code as the catalog the routes name; a test asserts that the
  database's 52 rows and 89 scope rows equal the constant. `BASIC_ROLE_PERMISSIONS` leaves the request path and
  stays only as the oracle of the equivalence test.
- **The old-vs-new test.** On a disposable database migrated through vN, for every authorization context of R1's
  matrix, every one of the 52 words and every scope (global; club and team, held and foreign; no id): the new
  `can()`, the SQL twin and R1's `can()` over the constant give the same answer, apart from exactly one word,
  `roles.manage` (O1 (b)): R1 answers `false` and R2 `true` for a club's admin at its own club and, by convention
  2, at a team under it; every other cell of that word is equal. R1's per-call-site table (test b1: 29 handlers and
  36 call sites in `organization.js`, `backend/tests/permissions-r1.test.mjs:444-445`) is re-run unchanged; no call
  site names `roles.manage`.
- **Unreadable tables: fail closed.** If the extra statement fails (a missing table, a permission error, a timeout),
  the context is marked unavailable. `can()` then still answers `true` for a platform admin, whose answer rests on
  `user_global_roles` alone, so the platform can repair; for anyone else it throws, and the request ends in
  `503 permissions_unavailable`. It never falls back to the code constant and never answers a wrong 404. Readable
  tables with a basic role's rows missing give that role nothing.
- No cross-request cache in R2: a changed role acts on the holder's next request (M14).
- **A holder of a non-basic role and the organization routes (O8 (a), decided).** From the moment an assignment
  exists, `can()` answers `true` for its words on the call sites of `organization.js`. Of the 36 call sites, 17
  name the global scope and stay a platform admin's only (convention 1); the other 19 name a club or a team and are
  the ones a non-basic holder can pass. R1 proved those call sites only for the audiences of the old predicates.
  **Merge condition of R2:** a per-call-site review of those 19, written into the pull request, of what each
  handler does after the check for a holder who is not in the old tables (the SQL role filters of the list queries,
  `managedTeamIds`, the headcount rules), with test 35. A handler the review finds unsafe is fixed before the merge;
  if it cannot be, the finding goes back to the owner before any narrower shipping of P9. The router is behind
  `requireCoach` (`backend/src/auth.js:158-161`), which reads `computeCapabilities`, and R2 does not change that
  (section 1.2): which accounts reach the routes at all is part of the same review.

## 7. The migration procedure

Runbook `docs/runbooks/permission-roles-vN.md`, with the three SQL files below, as v48, v50 and v58 have. Applying
vN to any persistent database needs the owner's order naming the file (`database-safety.md`); under the standing
order of the Metrics Core plan the *Rukovodilac* runs the preflight and the post-check, read-only.

### 7.1 Preflight (read-only, each block in `begin transaction read only; … rollback;`)

1. Server version; the last recorded migration and its checksum; vN not recorded; no checksum of a recorded file
   differs from the repository's.
2. No object of vN exists (the nine tables, the functions, the two constraints).
3. `user_club_roles` rows with a word other than `club_admin`: 0. `user_team_roles` rows other than `team_coach`: 0.
   (All rows, active or not.)
4. `user_global_roles` holds only its two words (its CHECK is in force).
5. The roles `anon` and `authenticated`: present or not (decides which revokes run); the owner of `public.users`.
6. No function or setting named `optimove.permission_actor`, `user_has_permission`, `lock_permission_actor` exists.
7. A quiet moment: no idle-in-transaction session, no lock wait, no long transaction on the three role tables.
8. The unique-prefix check of `.claude/rules/migrations.md` on the merge tree (run in git, not in SQL).

### 7.2 Post-check (read-only)

1. vN recorded once, its checksum the file's sha256, no later migration.
2. The nine tables, their constraints and indexes by name and count; row-level security on for each; no privilege of
   `PUBLIC`, `anon`, `authenticated` on any table or function.
3. Every trigger of vN present and enabled; the md5 of each function body.
4. The seed: 12 modules, 52 permissions, 89 scope rows, 4 roles; the 10 item rows exactly those of 3.3; a fingerprint
   (md5 over the ordered seed) equal to the runbook's.
5. No row in `user_role_assignments`, `permission_role_changes`, `permission_requests`; no role beyond the four;
   no table named `module_switches` or `module_switch_changes`.
6. Both CHECKs present and validated on the old tables.
7. `user_has_permission` spot rows: a known platform admin `true` at global scope; the nil user `false`.

### 7.3 Rollback

`docs/runbooks/permission-roles-vN-rollback.sql`, rehearsed on a disposable database (apply -> rollback -> the
catalog identical to before -> apply again). It refuses (`23514`, fixed message) once any of these holds: a row of
`user_role_assignments`; a role without a `basic_key`; a row of `permission_role_changes` or `permission_requests`; a seed fingerprint other than the runbook's; a later migration recorded. From then on vN
is forward-only. The rollback drops the two CHECKs too. The application rollback is a deploy of the previous
commit: R1's `can()` reads nothing of vN, and the two CHECKs refuse nothing R1 writes. After it a club's admin
no longer passes `roles.manage`, which only the Roles API checks.

### 7.4 Locks, the quiet moment, PostgreSQL 16 and 17

- The new tables lock nothing existing, except the foreign keys to `users`, `clubs` and `teams`
  (`SHARE ROW EXCLUSIVE` on each for the moment of the statement).
- The two `ADD CONSTRAINT … CHECK` take `ACCESS EXCLUSIVE` on `user_club_roles` and `user_team_roles` until the
  migration's COMMIT. Every signed-in request reads both (`authz.js:45-51`), so they are the last statements of the
  file, after `set local lock_timeout`, and the deploy is made at a quiet moment. Whether to use `NOT VALID` plus
  `VALIDATE` is the db review's call; both tables are small.
- A request of the old instance that meets the lock waits for the COMMIT; nothing it writes is refused by vN.
- The executor and the reviewers run PostgreSQL 16; production runs 17.6 (`docs/ai/CURRENT_STATE.md`). To rehearse on
  both where possible: foreign keys on stored generated columns (M7); `pg_current_xact_id()`; and every CHECK
  written in the form `pg_dump` reads back, so the backup verifier does not report a difference as it does for v32's
  CHECK (`CURRENT_STATE.md`, "Known baseline/environment test issues").

## 8. Tests (disposable databases, the T1 runner; real counts in the pull request)

**Schema and seed**

1. vN applied by the runner on the snapshot schema; applied twice is a no-op; the rollback rehearsal of 7.3.
2. The seed equals `PERMISSIONS` (52 words, 89 scope rows), `PERMISSION_GROUPS` (keys, labels, order) and the
   sets of 3.3 (10 item rows; Club admin is R1's set plus `roles.manage`, and holds no `accounts.manage`); no scope
   row `private` (O9, open); no item row for Platform admin or Independent coach; no module-switch table.
3. vN refuses to run with a planted `user_club_roles` row of another word (active, then inactive), and the same for
   teams; the fixed message; nothing of vN remains.
4. After vN, an INSERT or UPDATE of another word into either old table is `23514` by the named constraint.
5. Lookup tables: UPDATE, DELETE, TRUNCATE refused; an INSERT of a word without a scope row fails at COMMIT.
6. Row-level security and revokes: as a role without ownership, every table and function is refused.
7. Every preflight and post-check block returns the expected value before and after; each hard value flipped once
   shows the refusal.

**Guards, direct SQL (each asserts the SQLSTATE, the fixed message and which guard fires first)**

8. No acting user; a malformed one; one of another transaction (a session-level SET): `42501` on every table.
9. A role row naming another user; a club's role by another club's admin; by a team coach; by an inactive admin.
10. Every immutable column of a role; a revision skipped; the Platform admin row; an archived role; un-archive;
    an archive while an active assignment exists (O3 (b)), and the same archive passing once every assignment is
    revoked or lapsed.
11. Items: a platform-only word; a system-role-only word in a club's role; a scope mismatch; an item write without
    the role's update in the same transaction; a write inside a savepoint.
12. Rule 7: removing `staff.assign`, then `roles.manage`, from Club admin; a system role given a club-scope word
    Club admin lacks; `accounts.manage` is not required and not seeded (O1 (b)).
13. A role or item write without its change row fails at COMMIT; a change row that disagrees with the items.
14. Assignments: each refusal of 2.7, one case per row; the UPDATE rule (only the revocation stamp, once).
15. Append-only: UPDATE, DELETE, TRUNCATE of the change and request tables.
16. A multi-row `VALUES`, an `INSERT … SELECT` and a data-modifying CTE cannot write two change or request rows for
    one operation.

**Ceiling and dominance (through the routes and by direct SQL)**

17. A club's admin adds a word it does not hold (`permission_not_held`); a platform-only word; a non-delegable
    word. A platform admin adds a word of an unmoved module to a basic role (`module_not_adjustable_yet`).
18. A club's admin edits, archives, assigns and revokes a role that holds a word it lacks
    (`role_exceeds_your_permissions`), after a platform admin's copy put it there.
19. Losing the word mid-request: the admin's club role revoked between the route check and the lock; the write is
    refused (404), nothing written.
20. Self-assignment; assigning a basic role; a global scope; a role of club A at club B or at a team of club B.
    Through P6: `role_has_assignments`, also for a platform admin.
21. A widened Club admin never lets a club's role exceed it; narrowing Club admin below a system role is refused.

**Cross-club and info hiding**

22. The actors x routes matrix: platform admin; admin of A; admin of A and B; admin of B; coach of a team of A;
    independent coach; athlete; inactive admin; admin of an archived club. Every cell not allowed is the identical
    404 (status and `error`), also for a role id and an assignment id of another club and for random ids.
23. P2, P3 and P8 never return a role, a holder or a count of another club; `holderCount` for a club caller counts
    that club only.
24. No answer and no log line carries database text of a guard refusal.

**Expiry** (follows the plan's D4, open)

25. An assignment past `expires_at` gives nothing in `can()` and in the twin; a transaction opened before the expiry
    finishes under its first answer; a new grant stamps the lapsed row `expired` and inserts.
26. (Not in R2.) The module-switch tests belong to the module-switch migration (O6 (b)): a module switched off
    gives nothing to the club's admin and to every holder there, in `can()` and in the twin; another club is
    untouched; the platform admin is exempt (O4 (a)).
27. (Not in R2.) The switch write's own tests, with the same migration. The numbers 26 and 27 are kept so that the
    other test numbers of this contract stay as they were.

**Lock order, races and COMMIT outcomes**

28. The recorded SQL order of every write route equals 4.3; no locking clause after the first write.
29. Races, each run in both orders with no `40P01` logged: role edit against a holder's guarded write; old
    club-admin revocation against that admin's role save; old revocation against a new assignment by the same
    granter (M6); two saves of one role (`staleRevision`); two grants of one key and of one (user, role, scope);
    grant against archive; grant against the user's login switched off.
30. COMMIT outcomes through a fault seam, per operation: an error before the COMMIT (nothing written); the COMMIT
    never answering (`verified_after_commit_error`, or `503 outcome_unknown`, then the same key replays); a replay
    after the right was lost (404); `request_key_reused`; `try_again` on a held lock.

**The R1 equivalence**

31. The old-vs-new test of section 6: R1's `can()` over the constant, the new `can()` and the SQL twin, over every
    context, each of the 52 words and every scope; the three conventions each with a named case; the one stated
    difference, `roles.manage` for a club's admin, asserted cell by cell.
32. R1's suite (`backend/tests/permissions-r1.test.mjs`) passes unchanged where it tests the catalog, the call
    sites and the constant (a1-a6, b1-b3, b5-b9, c1-c3). Its test b4 ("a permission no module has moved to passes
    for nobody else") holds for the new `can()` for every word but `roles.manage`; that one changed expectation is
    listed in the pull request.
    `scoped-role-management`, `global-roles`, `role-authorization` and `lock-order-lo1` pass unchanged.
33. The old helpers never read the new context fields (static); the shape of the old fields is unchanged.
34. Tables unreadable: a platform admin still passes; anyone else gets `503 permissions_unavailable`; no fallback.
35. A holder of a non-basic role on each of the 19 club- and team-scope call sites of `organization.js` (of 36;
    the 17 global ones are refused, convention 1), with the per-call-site review of section 6 (O8 (a)).

**Mutations** (each killed by a named test): every guard clause of 2.3-2.7 and 2.9; the three conventions in the
twin; the union's two sources; the expiry comparison; the order of two locks in 4.3; the re-check
under the locks; the replay's re-evaluation; the 404 mapping of a foreign id; the rollback's refusals.

Commands: the suite's own files during the work; `test:backend:fast` and the role suites before the first review;
`test:backend:shared` is owed before the pull request (`agent-efficiency.md` section 6) and writes to the local
development database, so it needs the owner's approval for that session or is reported as not run.

## 9. Risks and known limits

- **The guards are not a defence against the shared database credentials** (v35's limit). Separate migration and
  runtime roles stay a recorded infrastructure task. With row-level security and no policy, a future runtime role
  that is not the owner loses every read of these tables: `can()` then fails closed and loudly (section 6); that
  task must add policies or grants.
- **The twin is not used by any existing guard in R2.** The actor guards of other streams keep naming `club_admin`;
  R6 and R6a replace them. Until then a non-basic role is refused by those guards: the safe direction.
- **A changed basic role acts for every club on the next request.** The change record allows the previous set to be
  put back; P5 returns the affected counts, and R3 shows them before Save.
- **A club's roles can hold few words until modules move.** After R2 a club's admin holds the seven words of 3.3.
  Under rule 5 and the ceiling it can delegate five of them: `org.view`, `org.teams.manage`, `org.club.edit`,
  `athletes.manage` and `athletes.remove`.
- **Nothing closes a module until the module-switch migration** (O6 (b)). Until then the plan's rule 4 ("minus the
  modules closed") has nothing to subtract, in `can()` and in the twin alike, and no screen offers a switch (R3
  comes later). That migration replaces a function every guard of vN calls, so it carries an md5 precondition and
  its own old-vs-new test (section 2.8).
- **A club's admin gains the role editor on the day of the deploy** (`roles.manage`, O1 (b)), through the new
  routes only and before any screen exists. `accounts.manage` is held by no role but Platform admin, so "who holds
  what" shows nobody else as holding e-mail change or password reset.
- **`import.approve` and `import.undo` are team-only** in the catalog, so the Club admin role (assignable for a
  club) cannot carry them under the coverage rule of 2.4, although the plan's 4.1 gives a club's admin "Approve".
  R6 decides it (a scope row added, or the rule changed).
- **Two user rows are locked by an assignment** (M6). Reasoned from the code, not reproduced: the old revocations
  lock every qualifying admin of a club in id order (`organization.js:2750-2761`), so "acting user first" can meet
  them in the opposite order. Nothing is written (`40P01`, `try_again`).
- **The theoretical gap of v54** (a user reactivated between two statements of the lock function) applies here too.
- **Role names are data shown to others.** The text rule refuses invisible characters; a club's role named like a
  system role is O7 (open).
- **A target id tells active from inactive** (`user_inactive` against 404) to a caller who already knows the id.
  Today's grant answers 404 "User not found." for an unknown id and accepts an inactive one (`organization.js:2832-2844`).
- **Not exercised:** PostgreSQL 17 by the executor; `test:backend:shared` without the owner's approval.

## 10.0 Decided by the owner (2026-11-19)

| Point | Decision |
|---|---|
| O1, O5 | E-mail change and password reset of an account stay with the platform admin for now. A club's admin keeps what it does today: adding athletes, inviting them to sign in, join links. So option (b) of O1: the Club admin role is seeded with `staff.assign` and `roles.manage`; `accounts.manage` stays outside it and the rule-7 list grows by a migration when account actions move with their target rule. |
| O2 | Editing a club's own details is done by the platform admin and the club's admin: the 52nd word `org.club.edit` (club scope), added to R1's catalog and to the Club admin set before the seed is written. Every "51" of this contract reads 52, and section 3's seed gains that row. |
| O3 | As recommended, (b): an archive is refused while an active assignment exists. |
| O6 | As recommended, (b): module switches are their own later migration; R2 ships without section 2.8 and the points that depend on it. |
| O4 | (a), with a display rule (plan D6f): the platform admin still sees a module it closed for a club; the club's admin sees it locked; coaches and everyone else of the club do not see it. It takes effect with the module-switch migration (O6), not in R2. |
| O8 | As recommended, (a): non-basic assignments act on the organization routes from R2, with the per-call-site review as a merge condition. |

Still open: the owner's O7, O9 and O10 and the plan's D4 (section 10.1), and the manager's M1-M14 (section 10.2).

**Revised for 10.0 on 2026-11-19 at `f4dd289`** (the head of R1, branch `feature/roles-r1-can`), against the plan
at `3a6723a`. Sections 0-9 and 11 now follow the decisions above. Every count was recomputed from R1's code at that
head: 52 words and 89 scope-type rows (`backend/src/permissions.js`), 29 handlers and 36 call sites (R1's test b1),
17 of them global and 19 at club or team scope (the `can()` calls of `organization.js`). The earlier draft's "ten
tables" was a miscount of eleven; without the two module-switch tables R2 has nine.

## 10. Open points

### 10.1 For the owner

O1, O2, O3, O4, O5, O6 and O8 are decided: see section 10.0. The points below are **open**. Each is written into
the sections above as its recommendation, and the place names the point it depends on.

| # | Question | Options | Recommendation |
|---|---|---|---|
| O7 | Role names: uniqueness and length. | Length: name 80, description 500, title 80, reasons 500. Uniqueness: (a) per owner among non-archived roles, case-insensitive (2.3); (b) per owner including archived; and whether a club's role may take the name of a system role. | **(a)**; a club's role may not take the name of a current system role (checked one way only, when the club's role is named, so a system role's name never reveals a club's). |
| O9 | Which words exist in a private workspace (scope type `private`)? The plan's 3.1 names areas, 4.1 leaves two cells "to verify". | (a) None in R2; each module's step adds its rows. (b) Seed the plan's list now. | **(a).** R1 has no private scope and no Independent coach set. |
| O10 | "A platform admin adds a new basic role" (plan section 4): is a platform-made role "basic"? | (a) `is_basic` means one of the four seeded roles that mirror the old tables; a platform-made role is a system role. (b) `is_basic` is a flag a platform admin sets on any system role. | **(a)** in R2; the CHECK is relaxed later if a separate badge is wanted. |
| D4 (the plan's) | Does an assignment have an optional end date? Open in the plan's section 9. | Yes, optional; or no end date. | **Yes, optional** (the plan's). Depends on it: `expires_at` and the `expired` revoke kind (2.7), the definition of "active", `expiresAt` in P9, tests 25 and 10. Without it those parts are removed and nothing else changes. |

### 10.2 For the *Rukovodilac* of OptiMove

All **open**. The sections above follow each recommendation.

| # | Point | Recommendation |
|---|---|---|
| M1 | The migration's number, prefix and name; its place relative to the open migration pull requests. | Agreed when the file is written; the unique-prefix check on the merge tree. |
| M2 | The acting-user setting: own (`optimove.permission_actor`) or v35's `optimove.source_metric_actor`. | Own: no dependency of `public` on `training_load`, independent rollbacks. |
| M3 | The text rule: a `public` copy of v40's function, or a call of `training_load.source_metric_text_ok`. | The copy, with a test that the two bodies agree. |
| M4 | Scope types as a child table instead of a column of `permissions`. | The child table (2.2). |
| M5 | Platform admin: no item rows and a short-circuit, or 52 rows refused for change. | No rows: a later word needs no maintenance, and the platform admin's answer never depends on these tables. |
| M6 | Two user rows in an assignment: the plan's "acting user, then the other user", or both in one statement in id order. | Reproduce first (test 29); if the deadlock is real, id order for the pair, recorded as a deviation from the plan's section 5. |
| M7 | Foreign keys of the polymorphic `scope_id` / `owner_id` through stored generated columns, or trigger checks only. | Generated columns if the rehearsal passes on 16 and 17; else triggers, with the stated gap that a hard delete of a club is not refused. |
| M8 | The router's mount and file (`/api/organization/roles`, a new router before the organization router), and the 404 body `{"error":"notFound"}` although `organization.js` answers `{"error":"Not found","path":…}` (`:413`). | As written; the new router follows rule 11. |
| M9 | A cap on a club's non-archived roles; a write quota. | A cap of 50 per club in the service; no quota (as the mapping API, C68 of the mapping discovery document). |
| M10 | Is the reason mandatory on a grant (the plan's section 2: "with a reason")? Today's grants have none. | Mandatory. |
| M11 | Self-assignment for a platform admin. | Refused for everyone: a platform admin gains nothing by it. |
| M12 | An unknown word or scope type in the twin: raise (as `can()` throws), or `false`. | Raise `22023`: a guard that names a wrong word must fail its tests, not refuse silently forever. |
| M13 | The twin requires an active user and does not check an archived club or team; `can()` relies on the session (a disabled login loses its sessions) and checks neither. | As written; each difference has a named test and is not part of the equivalence claim. |
| M14 | No cross-request cache of role items. | None in R2; measure the extra statement per request before adding one. |

## 11. Not in this contract

Module switches (O6 (b)): their two tables, the twin's and `can()`'s subtraction of closed modules, their routes,
the platform admin's exemption (O4 (a)) and the display rule of the plan's D6f. They are a later migration with its
own contract; section 2.8 lists what it must do. `accounts.manage` in the Club admin role and the account target
rule (O1 (b), O5): the step that moves account actions.

The role editor's screens and wording (R3); the group levels as stored data; athlete-side roles (D6); subscription
levels (D6a); notifications about a changed role; a restore of an archived role; moving a role between clubs; a
per-user tick (plan section 2: none in the first version); any change to a stream's actor guard.
