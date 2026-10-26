# R2 — renaming, archiving and restoring a canonical variable: proposed contract (J3b)

| | |
|---|---|
| Status | **Proposed — not accepted.** Phase 2b of `docs/ai/metrics-core-plan.md` (★★). By A3 of the plan no code is written before the owner approves this contract; on approval, decision C99 and section J3b move into `docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*) and this file is retired. |
| Verified against commit | `e489eeb` (merge of PR #223) |
| Owner's request | 2026-10-26, in the *Rukovodilac*'s chat: „Stavio sam ali bilo bi dobro da mogu preimomenovati kanonsku varijablu i arhivirati”; „Zašto trener ne moze imati opciju da moze da menja.”; to the *Rukovodilac*'s option 2: „Slažem se sa tobom idemo za sada tako pa ćemo menjati ako bude potrebe” (recorded in phase 2b of the plan) |
| Option 2, as the plan records it | rename (label, short label, description), archive and restore a canonical variable through the M3-0 admin API; the key never changes; a **coach of a team of the club** may rename, archive and restore that **club's** variables; **system** variables stay the platform admin's; every change is audited (who, when, the old and the new value) |
| Triggers (`CLAUDE.md`) | 1 (migration), 2 (role, `owner_scope`, info hiding), 4 (idempotency, transactions, lock order) — the external review of the *Rukovodilac* and the *Nezavisni revizor* |

## 1. Facts at `e489eeb`

- **Where the names and the state live.** `label`, `short_label`, `description` and `state` (`active` / `archived`) are
  columns of `training_load.metric_definitions` itself (v10, `202609041400_…_v10_metrics_catalog.sql:102-128`), not of a
  version. A version (`metric_definition_versions`) holds the semantics only and is append-only. So a rename or an
  archive changes the definition row and never creates a version; the key is part of the owner-scoped unique
  (`unique nulls not distinct (owner_scope, …, key)`), which holds for archived rows too, so a restore can never collide.
- **The M3-0 admin API** (`backend/src/routes/sourceMetrics.js:144-182`, `backend/src/canonicalVariableAdminService.js`)
  reads, creates and versions; it has no rename, archive or restore. Its audience is `resolveMappingAdmin()`
  (`sourceMetricMappingService.js:202-220`): a platform admin (platform workspace: the system scope; a club workspace:
  that club) or the club's own active admin in that club's workspace. Everyone else, a team workspace included, gets
  the identical `404 {"error":"notFound"}`.
- **The request record v36** (`migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql`) allows only
  `variable_create` and `variable_version_create`, requires a version written by the same transaction
  (`metric_definition_version_id not null`, `one_per_version`), and only the bases `platform_admin` / `club_admin`
  (derived by v35's `training_load.source_metric_actor_basis()`, platform admin first).
- **Decision 9 (v34, `…_v34_source_metric_mapping.sql:1227-1239`):** a BEFORE UPDATE OF `current_version_id, state`
  trigger refuses a new version **and an archive** (any state change) while an active mapping version pins the current
  version — `23514`, the text M3-0 already maps to `409 variable_pinned` (`canonicalVariableAdminService.js:423`). A
  rename (label columns only) does not fire it. A mapping (T3) targets only a `system` or `club` definition of the same
  owner, active at its creation (D4).
- **C98 (PR #219):** the older API `/api/training-load/metrics` refuses every write to a `system` or `club` definition
  with `409 canonical_variable_read_only`, so the admin API is the only application path that changes one.
- **What archiving does elsewhere:** the older catalog's default list shows only `active` definitions
  (`trainingLoadMetricsCatalog.js:163-168`); a dashboard series may be newly bound only to an active metric
  (`trainingLoadDashboardWidgets.js:52-56`), and an already bound series keeps reading its full history
  (`trainingLoadDashboardQuery.js:34-36`). Values and versions are never touched. Restoring undoes the hiding.
- **A team workspace** (`backend/src/workspace.js:60`) carries the team and its `club_id` (which may be null). The
  coach role is `public.user_team_roles` (`role = 'team_coach'`, `is_active`); `public.teams` has `club_id` and
  `is_active`.

## 2. The owner decision to record (proposed C99)

**C99. Who may rename, archive and restore a canonical variable** (changes C80 and C88 for club variables only):
- a **system** variable: an active platform admin in the platform workspace (as for M3-0);
- a **club** variable:
  - the club's active admin in that club's workspace, or a platform admin there (as for M3-0);
  - **new:** an active **coach of an active team of that club, in that team's workspace**.

  The team's club is taken from `public.teams.club_id` in the database, never from the request.
- For that coach, in a team workspace, the Variables view shows:
  - the club's variables, with *Rename*, *Archive* and *Restore*;
  - the system variables, as a read-only reference.

  The coach does not get create, a new version, the key suggestion, the Source fields and Mappings views, or the M2
  routes; each answers the identical 404.
- A coach of a team without a club, or of an archived team or club, gets the identical 404, as everyone else does.
- The key, the owner, the levels and the semantics never change through R2.

This is a deliberate exception to "a club-owned resource is managed by the club's admin" (ADR-002 keeps
`owner_scope` and `data_workspace` apart; here a team workspace manages a club-owned row). It is recorded as the
owner's decision, not derived.

## 3. Open questions for the owner (A3)

Each has a recommendation. The owner decides it with the contract.

| # | Question | Recommendation |
|---|---|---|
| Q1 | Does the coach get only rename, archive and restore (option 2), or also create and a new version? | Only the three (option 2 as decided); create and version stay with the admins. |
| Q2 | May a coach archive a club variable that other teams of the club use? Their dashboards keep their history, but the variable disappears from the pickers for new widgets. | Yes, as decided. The audit names who did it, and a club admin can restore it. |
| Q3 | Is a reason required for archive and restore? | Optional, at most 500 characters, kept in the audit. |
| Q4 | May a pinned variable (used by an active mapping version) be renamed? | Yes. The label is cosmetic and the semantics do not change. Archiving it stays refused (`409 variable_pinned`). |
| Q5 | May an archived variable be renamed? | No. An archived variable stays read-only (C88); restore it first. |
| Q6 | Does a platform admin or a club admin get these actions in a team workspace too? | Only if they are that team's coach; otherwise they use their own workspace. The basis written is always the strongest the database derives (§6). |

## 4. HTTP contract (J3b)

All under `/api/training-load/sources/metrics`, behind `requireAuth`, `Cache-Control: no-store`, same-origin JSON,
the M3-0 error envelope. Every write is idempotent by `requestKey`. Answers: `200 { variable }` (also for a
replay, `replayed: true`), and `200` with `commitConfirmation` when a lost COMMIT answer is verified, as M3-0.

**Reads, widened for C99 (a coach in a team workspace):**
- `GET /variables?scope=own|system&state=…` and `GET /variables/:variableId`:
  - unchanged for the admins;
  - for a coach, the owner is the team's club. The variable's `editable` is true only for that club's variables, and a
    new field `actions` lists what this caller may do (`rename`, `archive` / `restore`, and for an admin also
    `newVersion`).
- `GET /variables/key-suggestion`, `POST /variables` and `POST /variables/:id/versions` answer a coach the identical
  404 before the body is looked at.

**`POST /variables/:variableId/rename`**
```
{ "requestKey": uuid,
  "expected": { "label": text, "shortLabel": text|null, "description": text|null },
  "label": text, "shortLabel": text|null, "description": text|null }
```
- The fields follow M3-0's rules: one line of visible characters without surrounding spaces; label up to 80,
  short label and description per `TEXT_LIMITS`; the C53 invisible-character rule applies.
- `expected` is the triple the caller saw. It is a precondition, not the request's identity.
- The order of the answers:
  1. `400 invalid_body` (shape only, before any lookup — reveals nothing about the id);
  2. the identical `404` (missing, not visible, not writable by this caller, a system variable for a coach);
  3. `409 variable_not_active` (archived, Q5);
  4. `409 variable_changed` with `current` (the stored triple differs from `expected`);
  5. `409 rename_unchanged` (the new triple equals the stored one).
- A pinned variable may be renamed (Q4).

**`POST /variables/:variableId/archive`** — body `{ "requestKey": uuid, "reason"?: text }`. The order of the answers:
1. `400 invalid_body`;
2. the identical `404`;
3. `409 variable_not_active` (already archived);
4. `409 variable_pinned` (decision 9: an active mapping version pins it).

**`POST /variables/:variableId/restore`** — body `{ "requestKey": uuid, "reason"?: text }`. The order of the answers:
1. `400 invalid_body`;
2. the identical `404`;
3. `409 variable_active` (not archived).

**Common codes**
- `409 request_key_reused` (the same key with another request).
- `409 try_again` (`55P03`, `40P01`, `57014`, and a basis promoted during the request), with `Retry-After`.
- `503 outcome_unknown` with the verify path, as M3-0, when a COMMIT answer is lost and cannot be verified.
- Every other database refusal is a sanitized `500`.

The request hash covers the contract version `metric-variables/v1`, the operation, the variable id and the
normalized body.

## 5. Authorization of a coach, and info hiding

A new resolver for the variable routes, `resolveVariableEditor(req)`, keeps `resolveMappingAdmin()` unchanged for the
M2 routes.
- **Platform and club workspaces:** exactly as `resolveMappingAdmin()`.
- **A team workspace:**
  - the user holds an active `team_coach` role on that team (and an active user);
  - the team is active;
  - its `club_id` is not null and the club is active.

  All of these are read from the database, never from the workspace list. Then the owner is `{ scope: club,
  clubId: team.club_id }`, and the context records the team.
- **Inside every write,** after the request record and the definition lock, the rights are taken again `FOR SHARE`
  in the order user role → user → team → club. A loss of any of them is the identical 404.
- **Cases that answer the identical 404** (`{"error":"notFound"}`, the same bytes as a missing id):
  - a coach of another club's team;
  - a team without a club;
  - an archived team or club;
  - a revoked role;
  - an athlete or private-coach workspace;
  - a system variable for a coach.

## 6. The database: migration v38 (proposed)

**Numbering.** R2 is ready before phase 4, which waits for the owner's v37 post-check and its own decisions.
Proposal: R2 takes **v38**, the revision lifecycle **v39**. The plan's phase 4 heading says "migration v38"; changing
it is a plan change and needs the owner's word, in a separate small PR after #222. The file sorts after
`202610191300_media_upload_lifecycle.sql`.

**6.1 The request record (v36's table, widened):**
- `operation` adds `variable_rename`, `variable_archive` and `variable_restore`.
- `metric_definition_version_id` becomes nullable, with a check: it is required exactly for `variable_create` and
  `variable_version_create`, and null for the three R2 operations.
- `basis` adds `team_coach`, with two new constraints:
  - a new column `basis_team_id` (FK `public.teams`) is required exactly when the basis is `team_coach`;
  - `team_coach` is allowed only for the club scope and the three R2 operations.
- The uniques stay: one row per user and key (so one key namespace for all five operations), one per version
  (nulls excluded), one create per definition.

**6.2 The basis.** A new function `training_load.metric_variable_change_basis(actor, owner_club, team)` derives the
strongest basis:
- `platform_admin` (as in v35);
- else `club_admin` (as in v35);
- else `team_coach`, when the actor holds an active `team_coach` role on `team`, the team is active, its `club_id` is
  `owner_club` and the club is active.

It takes the role, user, team and club rows `FOR SHARE`, in the service's order. v35's
`source_metric_actor_basis()` is not changed. The service writes the basis the database derives; a basis promoted
during the request is `try_again`, as in M2.

**6.3 The change record, written by the database.** A new append-only table
`training_load.metric_variable_changes` holds:
- the definition;
- the operation;
- the old and new `label`, `short_label`, `description` and `state`;
- the acting user;
- the transaction id;
- `changed_at`;
- the `reason`.

How rows get there, and what they are checked against:
- **The audit row.** An AFTER UPDATE trigger on `metric_definitions` writes it. The trigger fires when the row is
  `system` or `club` and any of the four columns changes; the old and new values come from `OLD` and `NEW`, never
  from the client.
- **The acting user.** The trigger requires the v35 acting-user setting of this transaction. Without it, the change
  is refused with `42501`.
- **The request row.** The request insert guard checks the request against its change:
  - for an R2 operation, exactly one change row of this transaction exists for the definition, made by the acting
    user;
  - its kind matches: rename = only label columns changed, state unchanged; archive = `active → archived`, labels
    unchanged; restore = `archived → active`, labels unchanged;
  - the basis is the derived one;
  - violations: `23514`, and `42501` for an actor or basis error.
- **At COMMIT.** A deferred constraint trigger on `metric_variable_changes` requires every change row to have its
  request row in the same transaction (the v35 completeness pattern, `23514`). A rename or archive of a system or
  club variable by any path through the application's pool, without the API's request row, is rolled back.
- **Fixed messages.** A savepoint write is refused (fail closed).

**6.4 Append-only and rollback.**
- Both tables refuse UPDATE, DELETE and TRUNCATE.
- The rollback script (`docs/runbooks/…-v38-rollback.sql`):
  - refuses once any R2 request or change row exists, or a later migration is recorded;
  - otherwise restores v36's checks and drops the new objects;
  - is rehearsed: apply → rollback → identical v37 catalog → re-apply.
- A read-only production preflight and post-check sit beside it, on the v36 pattern.

**6.5 Limits, as v35 and v36.** The guards prove that the row, the actor and the right agree. They are no defence
against whoever controls the shared owner credentials or runs SQL through the application's pool and disables a
trigger. A future migration that changes a canonical definition's label or state must set the acting user or
disable the trigger in the migration itself, and say so.

## 7. Lock order, idempotency, outcome

A write follows M3-0's new-version order:
1. the per-user advisory lock;
2. the request record lookup (a replay checks the right again and answers the current state; the same key with
   another request is `request_key_reused`);
3. the acting-user setting;
4. the definition `FOR UPDATE` (after an unlocked visibility read, so a caller that is not allowed never waits for
   the lock);
5. the checks of §4;
6. the rights `FOR SHARE` (role → user → team → club);
7. the UPDATE, then the AFTER trigger's change row;
8. the request row;
9. a bounded COMMIT whose lost answer is verified by the request record on another connection.

Two writes on one variable serialize on the definition lock. A rename against a new version: both lock the
definition first, and neither changes what the other checks.

**For phase 7b (recorded here, not built in R2):** the future activation of a mapping version must take the canonical
definition `FOR SHARE` and refuse an archived target. Decision 9 reads the mapping versions plainly, so without that
lock an archive and an activation could both commit.

## 8. Tests and mutations

The suite `backend/tests/canonical-variables-r2.test.mjs` (disposable databases, T1 runner) covers:
- **Audience:**
  - the platform admin on a system variable;
  - the club admin on a club variable;
  - the coach in a team workspace on a club variable;
  - the coach on a system variable, another club, a team without a club, an archived team or club, a revoked role, a
    private-coach or athlete workspace: each a byte-identical 404.
- **The coach's other routes:** create, version, key suggestion and the M2 routes each answer 404.
- **Each operation:** the success path, every refusal in §4 in its order, and the audit's old and new values.
- **Pinning:** a pinned archive answers 409; a pinned rename succeeds.
- **Idempotency:** a replay; a reused key across operations; concurrent identical requests; a lost COMMIT verified;
  `try_again` on a held lock.
- **Database guards:** no actor (42501); a wrong basis; `team_coach` on system; a change without a request row
  (23514 at COMMIT); a request without a change; a savepoint; append-only.
- **Rollback:** the rehearsal, and the rollback refused once a row exists.
- **Unchanged contracts:** the older API's C98 answers, the M3-0 create and version, and the dashboards' "bound
  series keeps reading" behaviour after an archive.
- **Mutations:** every guard of §5 and §6 has one the tests kill.

Reviewers: `db-reviewer`, `security-reviewer` and `code-reviewer`, then the *Rukovodilac* and the *Nezavisni revizor*.
Phase 2c (the Variables-tab part) follows as its own PR: `code-reviewer`, `mobile-qa` and `ux-design-reviewer`.

## 9. Not in R2

- Changing the key, the owner, the levels or the semantics. A new version stays the M3-0 route, for admins only.
- Domains, categories and structure links.
- The older API. It stays refused by C98.
- Deleting a variable.
- The phase 2c frontend.
- Any production write. Merge, deploy and the migration need the owner's order that names v38.
