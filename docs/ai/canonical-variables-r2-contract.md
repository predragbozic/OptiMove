# R2 — renaming, archiving and restoring a canonical variable: proposed contract (J3b)

| | |
|---|---|
| Status | **Proposed — not accepted.** Phase 2b of `docs/ai/metrics-core-plan.md` (★★). By A3 of the plan, no code is written before the owner approves this contract and answers section 3. On approval, decision C99 and section J3b move into `docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*), and this file is retired. "R2" is the plan's name for this request; it is not the Cloudflare R2 media track. |
| Verified against commit | `e489eeb` (merge of PR #223) |
| The owner's request | 2026-10-26, in the *Rukovodilac*'s chat: „Stavio sam ali bilo bi dobro da mogu preimomenovati kanonsku varijablu i arhivirati”; „Zašto trener ne moze imati opciju da moze da menja.” |
| The owner's choice | The *Rukovodilac*'s proposal of 22:13:40 UTC had three points: bringing `main` into #218, R2 option 2, and the executor as the one who merges. The owner answered all three in one reply (22:16:26 UTC): „Slažem se sa tobom idemo za sada tako pa ćemo menjati ako bude potrebe”. The plan records that reply for option 2 (phase 2b) and for the merges (section 1). |
| Option 2, as the plan records it | Rename (label, short label, description), archive and restore a canonical variable through the M3-0 admin API. The key never changes. A **coach of a team of the club** may rename, archive and restore that **club's** variables. **System** variables stay the platform admin's. Every change is audited: who, when, the old and the new value. |
| Triggers (`CLAUDE.md`) | 1 (migration), 2 (role, `owner_scope`, info hiding), 4 (idempotency, transactions, lock order). External review by the *Rukovodilac* and the *Nezavisni revizor*. |

## 1. Facts at `e489eeb`

**Where the names and the state live.**
- `label`, `short_label`, `description`, `icon_url` and `state` (`active` / `archived`) are columns of
  `training_load.metric_definitions` itself (v10, `202609041400_…_v10_metrics_catalog.sql:102-128`), not of a version.
- A version (`metric_definition_versions`) holds the semantics only, and is append-only.
- So a rename or an archive changes the definition row and never creates a version.
- The key is part of the owner-scoped unique `unique nulls not distinct (owner_scope, …, key)`. The unique covers
  archived rows too, so a restore can never collide.
- Metrics Core text is unbounded and unchecked in the database (v10). A label, short label or description written
  through the older API before C98 may be longer than the admin API's output bounds, or span several lines.

**The M3-0 admin API.**
- Routes: `backend/src/routes/sourceMetrics.js:144-182`; service: `backend/src/canonicalVariableAdminService.js`.
- It reads, creates and versions. It has no rename, archive or restore.
- Its audience is `resolveMappingAdmin()` (`sourceMetricMappingService.js:202-220`): a platform admin (platform
  workspace: the system scope; a club workspace: that club), or the club's own active admin in that club's workspace.
- Everyone else, a team workspace included, gets the identical `404 {"error":"notFound"}`. That 404 comes before the
  body is looked at (`sourceMetrics.js:177-181`), and a malformed id is a 404 before the body too
  (`canonicalVariableAdminService.js:535`).
- The rights are checked again inside every write, on a replay and before the answer after a COMMIT, by
  `rightsStillHold()` (`sourceMetricMappingService.js:227-258`). Its branches are `platform_admin` and `club_admin`
  only. A club admin who has become a platform admin answers `409 try_again`.

**The request record v36** (`migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql`).
- It allows only `variable_create` and `variable_version_create`.
- It requires a version written by the same transaction (`metric_definition_version_id not null`,
  `one_per_version`).
- It allows only the bases `platform_admin` and `club_admin`, derived by v35's
  `training_load.source_metric_actor_basis()`: platform admin first, as one joined `FOR SHARE`.
- Its insert guard requires an active definition and a version of this transaction (v36:106-133). A row written
  inside a savepoint is refused through the xmin comparison with v35's `source_metric_current_xmin()`.

**Decision 9** (v34, `…_v34_source_metric_mapping.sql:1225-1238`).
- A BEFORE UPDATE OF `current_version_id, state` trigger refuses a new version, and any state change, while an
  active mapping version pins the current version. It answers `23514`, which M3-0 maps to `409 variable_pinned`
  (`canonicalVariableAdminService.js:423`).
- A rename does not fire it.
- The activation of a mapping version takes the canonical definition `FOR SHARE` and refuses one that is not active
  or whose pinned version is not current (v34:1178-1182). So an archive (`FOR UPDATE`) and an activation already
  serialize in both orders.
- A mapping (T3) targets only a `system` or `club` definition of the same owner, active at its creation (D4).

**C98 (PR #219).** The older API `/api/training-load/metrics` refuses every write to a `system` or `club` definition
with `409 canonical_variable_read_only` (`trainingLoadMetricsCatalog.js:37-41, 240, 325, 386, 425, 465`). No other
code under `backend/src` changes the four columns of a canonical definition. The GPEXE writer updates only
team-owned rows (`gpexeImportWriter.js:216`), and no migration updates them.

**What archiving does, everywhere.**
- The older catalog's default list shows only `active` definitions (`trainingLoadMetricsCatalog.js:163-168`).
- A dashboard series may be newly bound only to an active metric (`trainingLoadDashboardWidgets.js:52-56`). An
  already bound series keeps reading its full history (`trainingLoadDashboardQuery.js:34-36`).
- Cloning a template resolves its metrics among active definitions only (`trainingLoadDashboardWidgets.js:109`).
- **A new value can no longer be entered** for an archived definition: `400 … is archived and cannot accept new
  values` (`trainingLoadMetricsMeasurements.js:200`, the create path `:429` with `requireActive`).
- Existing values and versions are never touched. Restoring undoes all of this.

**Who sees a club variable today.** The older catalog shows a `club` definition only to that club's admins and to a
platform admin (`catalogVisibilitySql`, `trainingLoadMetricsAccess.js:116-134`). It manages one through
`canManageCatalogRow` (`:61-67`, the club admin). **A team coach sees no club variable today.**

**A team workspace.**
- It carries the team and its `club_id`, which may be null (`backend/src/workspace.js:60`).
- The coach role is `public.user_team_roles` (`role = 'team_coach'`, `is_active`). `public.teams` has `club_id` and
  `is_active`.
- The repository's only team-coach database lock is `training.lock_activity_decider`, as redefined by v26
  (`…_v26_activity_roster_decisions.sql:732-766`). It locks the team, then the club (`coalesce(is_active, true)`),
  then the role and the user in one joined `FOR SHARE`.
- A value entry for a definition takes it `FOR SHARE` (`trainingLoadMetricsMeasurements.js:178-181`), so an entry
  and an archive (`FOR UPDATE`) serialize.

## 2. The owner decision to record (proposed C99)

**C99. Who may rename, archive and restore a canonical variable.** It changes C80, C81 and C88, for club variables
only.

**A system variable:** an active platform admin in the platform workspace, as for M3-0.

**A club variable:**
- the club's active admin in that club's workspace, or a platform admin there, as for M3-0;
- **new:** an active **coach of an active team of that club, in that team's workspace**. The team's club is taken
  from `public.teams.club_id` in the database, never from the request.

**What the coach sees, in a team workspace.** The Variables view only, with the club's variables offering *Rename*,
*Archive* and *Restore*. What the coach reads is question Q7 (section 3).

**What the coach never gets,** each answered with the identical 404:
- create a variable, a new version, the key suggestion;
- the Source fields and Mappings views, and the M2 routes.

A coach of a team without a club, or of an archived team or club, gets the identical 404, as everyone else does.

**What R2 never changes:** the key, the owner, the levels and the semantics.

**The rule this departs from.** A club-owned catalog row has been managed only by the club's admin
(`canManageCatalogRow`, C80, C81, C88). Here a coach in a team workspace manages a club-owned row. A Metrics Core
definition has no data workspace, so ADR-002's second contract does not apply to it. The exception is the owner's
decision, not derived.

## 3. Questions for the owner (A3)

Each question carries a recommendation; the owner decides each with the contract.

**Already decided by option 2, listed for confirmation only:**
- the coach gets rename, archive and restore — not create or a new version;
- a coach may archive a club variable that other teams of the club use.

**What archiving means for the club.** In the club, an archived variable:
- leaves the pickers;
- cannot be added to a new widget;
- is skipped by template copies;
- **accepts no new values**, from anyone, admins included.

History stays. An admin or a coach of the club can restore it.

| # | Question | Recommendation |
|---|---|---|
| Q3 | Is a reason required for archive and restore? Archiving stops new values for the whole club. | **Required for archive** and optional for restore. At most 500 characters, kept in the audit. |
| Q4 | May a pinned variable (an active mapping version uses it) be renamed? Labels are not versioned, so a coach would relabel a variable fed by active mappings, for the whole club. | **Only by an admin.** A coach gets `409 variable_pinned` for a rename of a pinned variable; the R2 request guard refuses it for the `team_coach` basis too (§6.3). Archiving a pinned variable stays refused for everyone (decision 9). |
| Q5 | May an archived variable be renamed? | No. An archived variable stays read-only (C88); restore it first. |
| Q6 | Does a platform admin or a club admin get these actions in a team workspace too? | Only if they hold the coach role on that team. Otherwise they use their own workspace. The basis written is always the strongest the database derives (§6.2). |
| Q7 | What does a coach read? Today a coach sees no club variable. | A **reduced view**: id, key, label, short label, description, state, owner scope, `truncated`, `actions` and the rename precondition token. No versions, no semantics, no reasons, no mapping readiness. The system reference uses the same reduced view. **Every answer** that carries a variable to a coach uses it: the writes, a replay, `commitConfirmation`, and `409 variable_changed`. **Accepted disclosure:** `actions`, `409 variable_pinned` and `409 restore_by_admin` tell a coach that a mapping pins a variable, or that an admin archived it. |
| Q8 | May a coach restore a variable that an admin archived? | **No.** A coach restores only what a coach archived; an admin restores anything. **The deciding row** is the request linked to the definition's most recent `archive` change row. When there is none (an archive by the older API before C98, by a migration or by raw SQL), the archive counts as an admin's: a coach gets `409 restore_by_admin`. The service checks this, and the R2 request guard checks it again for the `team_coach` basis (§6.3). |
| Q9 | Who reads the change history (the audit)? | The club's admins and a platform admin, through a later read. R2 itself builds no history route. The rows are written from the first change. |
| Q10 | The admin APIs' invisible-character list has a known gap (Separate tasks, LOW: U+3164, U+2800, U+115F/1160, U+FFA0, U+034F, variation selectors, tag characters). R2 lets every coach of the club write club-wide labels. | **Close it in R2:** extend the service rule and its database twin `training_load.source_metric_text_ok()` in v38, for every admin API. The M2 and M3-0 labels are covered too. |
| Q11 | A write quota for coaches? | None, as for M2 (C68). The audit is append-only; abuse is visible to the admins. |

## 4. HTTP contract (J3b)

All routes sit under `/api/training-load/sources/metrics`, behind `requireAuth`, with `Cache-Control: no-store`,
same-origin JSON and the M3-0 error envelope. Every write is idempotent by `requestKey`, and the request hash covers:
- the contract version `metric-variables/v1`;
- the operation;
- the variable id;
- the normalized body, the precondition token included, as M3-0 includes `expectedCurrentVersionId`.

**Answers.**
- `200 { variable }`. A replay adds `replayed: true`, and a verified lost COMMIT adds `commitConfirmation`.
- A read that fails after a COMMIT keeps the status, with `readError`, as in M3-0.
- `503 outcome_unknown` carries only `{ error, message, requestKey }`: repeat with the same key. There is no verify
  path, as in M3-0.

**The order of the answers, for every R2 route:**
1. the identical 404 when the caller has no right to this route in this workspace — before the body;
2. `415 jsonRequired`;
3. a JSON body that is not an object: `400 invalid_body` (the router's `jsonObjectBody`, before the service);
4. a malformed `variableId`: the identical 404;
5. `400 invalid_body` for an object of the wrong shape;
6. *inside the write:*
   - a replay of the same key answers here, before any precondition;
   - then the definition: not visible or not writable by this caller is the identical 404 (an unlocked read first,
     so a refused caller never waits for the lock);
   - the definition `FOR UPDATE`;
   - **the rights again, `FOR SHARE` (§7)**: lost means the identical 404, never a 409;
7. the 409s of each route below.

**Reads, for a coach in a team workspace** (`GET /variables`, `GET /variables/:variableId`):
- the owner is the team's club;
- the view is the reduced one of Q7;
- `editable` is true only for that club's variables;
- `actions` lists what this caller may do now.

For the admins the reads are unchanged, except that they gain the same `actions` field, which then also names
`newVersion`.

**Admin-only routes.** `GET /variables/key-suggestion`, `POST /variables`, `POST /variables/:id/versions` and the M2
routes answer a coach the identical 404 (step 1).

**The rename precondition token.** Every read of a variable carries `labelsToken`: the server's SHA-256 of the JSON
array `[label, shortLabel, description, state]` of the **stored** row (a NULL is JSON `null`, never `""`). The server
compares it only under the definition lock. The client sends it back. The server never
compares the client's text with the stored text, so a stored value that the output cut (`truncated`), or that spans
several lines, can still be renamed.

**`POST /variables/:variableId/rename`**

```
{ "requestKey": uuid, "labelsToken": text,
  "label"?: text, "shortLabel"?: text|null, "description"?: text|null }
```

- At least one of the three fields is present.
- A field that is left out stays unchanged. `null` clears the short label or the description.
- The new values follow M3-0's text rules: one line of visible characters without surrounding spaces; at most 80
  for the label, 20 for the short label and 500 for the description; C53 and Q10.

The 409s, in this order:
1. `409 variable_not_active`: archived (Q5);
2. `409 variable_changed`: `labelsToken` is not the stored one. The answer carries the current reduced view and
   token;
3. `409 rename_unchanged`: the new values equal the stored ones;
4. a coach on a pinned variable: `409 variable_pinned` (Q4).

**`POST /variables/:variableId/archive`**

```
{ "requestKey": uuid, "reason": text }
```

`reason` is required if Q3 is accepted. The 409s, in this order:
1. `409 variable_not_active`: already archived;
2. `409 variable_pinned`: decision 9.

**`POST /variables/:variableId/restore`**

```
{ "requestKey": uuid, "reason"?: text }
```

The 409s, in this order:
1. `409 variable_active`: not archived;
2. a coach on a variable an admin archived: `409 restore_by_admin` (Q8);
3. `409 variable_pinned`: decision 9 also fires on a restore. It is not reachable today, since an activation needs
   an active definition, but it is mapped and tested.

**Common codes.**
- `409 request_key_reused`.
- `409 try_again`, with `Retry-After`. It covers `55P03`, `40P01` and `57014`, and a stronger basis that appeared
  during the request.
- Every other database refusal is a sanitized `500`.

## 5. Authorization of a coach, and info hiding

**The resolver.** A new resolver for the variable routes, `resolveVariableEditor(req)`, keeps `resolveMappingAdmin()`
unchanged for the M2 routes.
- In the platform workspace and in a club workspace it works exactly as `resolveMappingAdmin()`.
- In a team workspace it reads from the database, never from the workspace list:
  - the team: active, with a non-null `club_id`;
  - the club: active;
  - the user's active `team_coach` role on that team;
  - the user: active.
- The owner is then `{ scope: club, clubId: team.club_id }`.
- **The basis is the strongest the user holds for that club**, by the database's own precedence: platform admin,
  then the club's admin, then the team's coach.
- `teamId` (and later `basis_team_id`) is recorded only when the basis is `team_coach`.
- Under Q6, holding the coach role on the team is required to act in a team workspace at all. The database cannot
  check that requirement when the basis is not `team_coach`, so it is the service's. Inside the write it is not
  checked again for an admin basis, which is harmless: the admin could act from the club workspace.
- An active team or club means `coalesce(is_active, true)`, as v26 and v35 do.

**The shared rights check gets a `team_coach` branch.** `rightsStillHold()` is used by the write, the replay and the
answer after a COMMIT; its existing branches stay as they are. The new branch:
1. probes the stronger bases in v35's order, as separate statements:
   - the platform role → the user;
   - the club's admin role → the user → the club.

   Either found means `409 try_again`.
2. then, in v26's order (`lock_activity_decider`): the team, then the club, then the coach role and the user in one
   joined statement, all `FOR SHARE`. The team must be active, with `club_id` equal to the owner club.

All these locks are `FOR SHARE`, and each writer that contends with them is a single-row UPDATE (a team or club
archive, a role revoke). A deadlock therefore needs such a writer, and would surface as `40P01`, which is `try_again`.

The same order is used by the database function of §6.2. The M2 routes never reach the new branch, because their
resolver never returns `team_coach`.

**The identical 404.** Every case below answers `{"error":"notFound"}`, the same bytes as a missing id, whatever the
route and the body:
- a coach of another club's team;
- a team without a club;
- an archived team or club;
- a revoked role;
- an athlete or private-coach workspace;
- a system variable for a coach's write;
- a right lost during the request.

## 6. The database: migration v38 (proposed)

**Numbering.**
- R2 is ready before phase 4, which waits for the owner's v37 post-check and its own decisions.
- **Proposal:** R2 takes **v38**, and the revision lifecycle becomes **v39**.
- The plan's phase 4 heading says "migration v38". Changing it is a plan change and needs the owner's word, in a
  separate small PR after #222.
- The migration runner orders files by their unique 12-digit prefix (`migrate.js:722-742`). "v38" is a label; the
  file must sort after the newest file on `main` when the branch is finished (today
  `202610191300_media_upload_lifecycle.sql`).

### 6.1 The request record (v36's table, widened, v36's guard untouched)

**What changes in the table:**
- `operation` adds `variable_rename`, `variable_archive` and `variable_restore`.
- `metric_definition_version_id` becomes nullable, with an "iff" check: it is not null exactly when the operation is
  `variable_create` or `variable_version_create`.
- The composite FK `(version_id, definition_id)` is `MATCH SIMPLE`: a null version id skips it, which is intended.
  The plain definition FK still applies.
- `basis` adds `team_coach`, with a new column `basis_team_id` (FK `public.teams`, RESTRICT). Two "iff" checks:
  - `(basis = 'team_coach') = (basis_team_id is not null)`;
  - `team_coach` only for the club scope and the three R2 operations.
- New: `metric_variable_change_id` (unique, FK to §6.3): not null exactly for the three R2 operations.
- New: `reason`, nullable and only for the R2 operations, checked by `training_load.source_metric_text_ok(reason, 500)`
  in the database.
- A partial index on `basis_team_id where basis_team_id is not null`.

**What stays as it is:**
- The existing constraint names. The M3-0 tests snapshot them (`metric-variables-m3-0.test.mjs:325-333`).
- The uniques. There is still one row per user and key, so one key namespace covers all five operations, and the
  database itself refuses a key reused across operations. `one_per_version` still holds, nulls excluded.

**v36's insert guard function is not changed.** Its trigger is recreated with
`WHEN (new.operation in ('variable_create', 'variable_version_create'))`. A separate R2 guard function and trigger
run with `WHEN (new.operation in ('variable_rename', 'variable_archive', 'variable_restore'))`.

### 6.2 The basis

A new function, `training_load.metric_variable_change_basis(actor, owner_club, team)`. v35's
`source_metric_actor_basis()` is not changed.
- **Precedence:** `platform_admin` → the club's `club_admin` → `team_coach` (the team is active, its `club_id` is
  `owner_club`, the club is active, and the actor holds an active `team_coach` role on it).
- **Locks:** taken in the order of §5, as separate statements, `FOR SHARE`.
- The service writes the basis the database derives.

### 6.3 The change record, written by the database

A new append-only table, `training_load.metric_variable_changes`. Each row holds:
- `id`, the definition, `owner_scope` and `owner_club_id` (the guard checks them against the definition);
- the kind (`rename` / `archive` / `restore`);
- the old and new `label`, `short_label`, `description` and `state`. These carry no length or text check, since
  Metrics Core text is unbounded, and a check would make a legacy variable impossible to rename;
- the acting user;
- the full 64-bit `pg_current_xact_id()`;
- the row's own xmin, checked as below;
- `changed_at`.

Indexes on the definition and on the acting user.

**Who writes it.** An AFTER UPDATE row trigger on `metric_definitions` (`UPDATE OF label, short_label, description,
state`) writes it.
- Its `WHEN` clause fires it only when OLD or NEW is `system` or `club`, and any of the four columns `IS DISTINCT
  FROM` its old value. Because that is tested first, the older API's writes to team and user rows
  (`trainingLoadMetricsCatalog.js:391, 430`) never reach the actor check.
- The values come from `OLD` and `NEW`, never from the client.
- It requires the v35 acting-user setting of this transaction, or it refuses with `42501`.
- `icon_url` is not audited; R2 does not change it.

**A BEFORE INSERT guard on the changes table** admits a row only when all of these hold:
- the row is written from inside a trigger, at depth 2 or more (`pg_trigger_depth() > 1`, because the guard itself
  is depth 1);
- `xact_id = pg_current_xact_id()`;
- the acting user is the v35 actor;
- the definition's xmin equals `source_metric_current_xmin()`.

This proves "some trigger in this transaction", not "that trigger", and the limits in §6.5 say so. A forged row is
still caught by the request guard and by the COMMIT check below: it would need a definition updated in this
transaction, exactly one change row, and its own request.

**The key, in the database.** A BEFORE UPDATE OF `key` trigger refuses a change of the key when OLD or NEW is
`system` or `club` (`23514`). Its name sorts after v34's `metric_definitions_source_metric_owner_guard`, so v34's
messages keep winning wherever both fire.

**The owner and the levels stay as they are:**
- the owner is C51 for a mapped definition (v34) and a service rule otherwise;
- the levels are a service rule;
- R2 writes neither, and C98 refuses both in the older API.

An owner freeze for unmapped canonical rows would change C51 and break its tested interleavings
(`source-metric-mapping-m1.test.mjs` test 21), so it is not proposed.

**The R2 request guard checks, at insert:**
- the request names the acting user (`42501`);
- the request's owner equals the definition's owner and the change row's owner, and the request's definition is the
  change row's;
- the basis is the one `metric_variable_change_basis()` derives from **the definition's** owner, with `basis_team_id`
  for `team_coach` (`42501`);
- that exactly one change row of this transaction exists for this definition;
- that the request's `metric_variable_change_id` names that row;
- that the change row was made by the actor;
- that the change row's xmin and the definition's xmin equal `source_metric_current_xmin()`, so a write inside a
  savepoint is refused;
- that the definition's current four values equal the change row's new values;
- that the kind matches the operation:
  - a rename changes label columns only, with the state `active`;
  - an archive is `active → archived`, with the labels unchanged;
  - a restore is `archived → active`, with the labels unchanged;
- for a rename, the new label (80), short label (20) and description (500) with `source_metric_text_ok()`; the old
  values are exempt;
- for the `team_coach` basis:
  - Q4: no rename of a pinned variable;
  - Q8: a restore only when the definition's most recent `archive` change row has a request with the `team_coach`
    basis.

Any of these fails with `23514`.

**At COMMIT.** A deferred constraint trigger on `metric_variable_changes` requires the request row that points at
**that exact change** (`metric_variable_change_id`), in the same transaction (`23514`).
- So a rename or archive of a canonical variable by any path through the application's pool, without its own request
  row, is rolled back. An earlier request for the same definition does not count.
- A refusal at COMMIT is a definite failure (`commitCertainlyRefused`).

### 6.4 Append-only and rollback

- Both tables refuse UPDATE, DELETE and TRUNCATE.
- The rollback script (`docs/runbooks/…-v38-rollback.sql`):
  - refuses once any R2 request or change row exists, or a later migration is recorded;
  - otherwise drops the R2 objects explicitly, under a bounded `lock_timeout`;
  - restores v36's checks and recreates v36's trigger without `WHEN`;
  - if Q10 is accepted, restores v34's exact body of `source_metric_text_ok()`;
  - is rehearsed: apply → rollback → the catalog identical to the one before v38 → re-apply.
- A read-only production preflight and post-check, on the v36 pattern, cover:
  - v37 recorded and v38 absent (preflight);
  - the constraint definitions, the triggers enabled (`tgenabled = 'O'`) and their deferred flags;
  - the indexes valid;
  - no R2 or change row;
  - no actor setting;
  - if Q10 is accepted, the number of stored values that the stricter rule would refuse, expected 0, and the function
    body after the migration (the rehearsal compares it too).

### 6.5 Limits, and what v38 changes for existing code

**Limits, as v35 and v36.** The guards prove that the row, the actor and the right agree. They are no defence against
whoever holds the shared owner credentials, or runs SQL through the application's pool and disables a trigger. The
changes table's own guard can be satisfied by any other trigger of the same transaction (§6.3).

**A future migration** that changes a canonical definition's label or state must set the acting user, or disable the
trigger inside itself, and say so.

**Existing test statements that v38 breaks.** Found by searching every raw update of the four columns. Each one is
rewritten to disable the trigger inside its own fixture, as the v37 suites did, and none changes what it asserts:
- `source-metric-mapping-m1.test.mjs:960` and `:1341` (raw renames);
- `metric-variables-m3-0.test.mjs:665` and `:866` (`state = 'archived'` fixtures).

**Not affected:**
- `source-metric-mapping-m1.test.mjs:959` and `:1271`: decision 9 refuses them first, with the same message;
- test 21 of the same file (owner changes): no key change and none of the four columns;
- `metrics-core-canonical-guard.test.mjs:471` (user → system): the same reason;
- if Q10 is accepted, test 4 of `source-metric-mapping-m1.test.mjs` (`:551-561`, the exact C53 list) gains the new
  characters.

No production writer is affected.

**Q10, if accepted:**
- the migration refuses to apply when a stored value fails the stricter rule;
- the JavaScript rule gains the `u` flag for the astral tag characters (U+E0000–U+E007F), and the database class
  `\U000E0000`;
- a test compares the JavaScript and database rules over the code point ranges;
- `metric_definitions` has no text check of its own (v10). The service and the R2 request guard check the new labels;
  no constraint does.

## 7. Lock order, idempotency, outcome

A write follows M3-0's machinery:
1. the per-user advisory lock;
2. the request record lookup:
   - a replay re-checks the right and answers the current state, before any precondition;
   - the same key with another request is `request_key_reused`;
3. the acting-user setting;
4. the unlocked visibility read, then the definition `FOR UPDATE`;
5. **the rights `FOR SHARE`** (§5), before any answer that carries data;
6. the 409 checks of §4;
7. for the text rule: `source_metric_text_ok` again inside the write;
8. the UPDATE, and the AFTER trigger's change row;
9. the request row;
10. a bounded COMMIT, whose lost answer is verified by the request record on another connection.

Step 5 before step 6 deliberately departs from M3-0, where the rights follow the 409s
(`canonicalVariableAdminService.js:569-579`): `variable_changed` carries data. The same ordering in M3-0's
version route is recorded as a follow-up; R2 does not change M3-0.

The COMMIT bound and the verify window are M3-0's. After an unknown COMMIT, the connection is closed, never returned to
the pool, and its locks end when the server ends the transaction.

**Concurrent writes.**
- Two writes on one variable serialize on the definition lock.
- A rename and an M3-0 new version both lock the definition first, and neither changes what the other checks.
- An archive and a mapping activation serialize through v34 (§1). R2 adds the two interleaving tests.
- An archive and a value entry serialize on the definition row (§1). R2 tests both orders: an entry after the archive
  is refused, and an archive after the entry leaves the entry stored.

## 8. Tests and mutations

One suite, `backend/tests/canonical-variables-r2.test.mjs`, runs on disposable databases with the T1 runner. It
covers the following.

**Audience and the identical 404:**
- the platform admin on a system variable;
- the club admin on a club variable;
- the coach in a team workspace on a club variable;
- a coach on a system variable (write), another club, a team without a club, an archived team or club, a revoked
  role, a private-coach or athlete workspace: a byte-identical 404;
- a coach on the admin-only routes and on the M2 routes: 404.

**The order of the answers** (§4):
- no right plus a bad body is 404;
- a coach with a non-JSON body is 415;
- a non-object JSON body is 400;
- a bad UUID plus an object body is 404;
- a coach's right revoked mid-request (the rights-hold seam) is 404, never a 409 with data.

**Reads:**
- the coach's reduced view (Q7): a field allowlist on both reads, the system reference, every write answer, a
  replay, `commitConfirmation` and `409 variable_changed`;
- `actions` and `editable` for each caller and state;
- a truncated or multi-line stored value can still be renamed through `labelsToken`.

**Each operation:**
- success, with the change row's old and new values;
- every 409 in its order;
- Q4 (a coach on a pinned variable versus an admin);
- Q8:
  - a coach restoring an admin's archive;
  - a legacy archive with no change row (raw, trigger off): coach 409, admin 200;
  - archive by a coach, restore by an admin, archive by an admin, then a coach's restore: 409;
- a restore of a pinned archived row;
- archive against activation in both orders (archive first: the activation refuses with `23514`; activation
  first: `409 variable_pinned`);
- archive against a value entry, in both orders.

**Basis:**
- a coach only (`team_coach`, `basis_team_id` set);
- a club admin who is also the coach (`club_admin`, `basis_team_id` null);
- a platform admin who is also the coach;
- a promotion mid-request: `409 try_again`.

**Idempotency and outcome, through the real routes:**
- a replay, also for a coach;
- a replay after the role is revoked: 404;
- a key reused across operations;
- concurrent identical requests;
- a lost COMMIT verified (the commit-fault seam);
- `503 outcome_unknown` with exactly `{error, message, requestKey}`;
- `readError` after a COMMIT;
- a deferred refusal at COMMIT;
- `try_again` on a held lock.

**Database guards:**
- no actor gives `42501`; a wrong basis; `team_coach` on system;
- a change without its request row gives `23514` at COMMIT, even with an earlier request for the same definition;
- a request without a change;
- a change row inserted outside the trigger (a direct INSERT; the mutation `> 1 → > 0` is killed);
- the request guard's identity checks (another owner, another definition, another user);
- the Q4 and Q8 database checks for the `team_coach` basis;
- a savepoint;
- a key change on a system or club row (OLD or NEW); v34's owner messages unchanged;
- append-only;
- the text rule (Q10).

**Rollback.** The rehearsal, and a rollback refused once a row exists.

**Unchanged contracts:**
- the older API's C98 answers;
- the M3-0 create and version, and the constraint-name snapshot;
- the dashboards' "bound series keeps reading" after an archive;
- the rewritten fixtures of §6.5.

**Mutations.** Every guard of §5 and §6 has a mutation that the tests kill.

**Reviewers.**
- For R2: `db-reviewer`, `security-reviewer` and `code-reviewer`, then the *Rukovodilac* and the *Nezavisni revizor*.
- For phase 2c (the Variables-tab part), its own PR: `code-reviewer`, `mobile-qa` and `ux-design-reviewer`. Its
  acceptance includes J4's escaped-text rendering.

## 9. Not in R2

- Changing the key, the owner, the levels or the semantics. A new version stays the M3-0 route, for admins only.
- Moving the rights check before the 409s in M3-0's version route (§7): a follow-up of its own.
- A route that reads the change history (Q9).
- Domains, categories and structure links.
- The older API, which C98 keeps refused.
- Deleting a variable.
- The phase 2c frontend.
- Any production write. Merge, deploy and the migration need the owner's order that names v38.
