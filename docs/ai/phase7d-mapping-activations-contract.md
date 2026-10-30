# J10 — phase 7d: activating a mapping version on a team binding (T5) (proposed ★★ contract)

This is the contract of phase 7d of `docs/ai/metrics-core-plan.md` (section 5, phase 7: "7d: T5 activations"). It
extends `docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*): sections D (lock order), D3,
D6, D7, D8, D10, G and the decisions C8, C23, C30, C35, C49, C55, C57, C58 and C76. It takes over what the phase 7b
contract (`docs/ai/phase7b-mapping-transitions-contract.md`, J8) left to 7d.

It is reviewed together with the 7c contract (`docs/ai/phase7c-unit-conversions-contract.md`, J9) in one ★★ round.
The implementation is its own pull request, 7d-B, with migration v48, **after 7c-B**: v48 replaces a function body
that v47 writes. 7d-B may start as soon as 7c-B has both GOs, without waiting for its deploy.

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-30, on the *Rukovodilac*'s orders of that day (queued at 15:56:56 and 16:04:13 UTC). |
| Verified against commit | `70e9e2b` (merge of PR #287), the code and migrations of the base `3d4cd12`. Every file and line reference below is to that commit. |
| The owner's decision | **C106** (2026-10-30): „klupski admin treba takođe da ima mogućnost to da uradi” (owner turn `715938df`, 16:03:47 UTC, in the *Rukovodilac*'s chat; the executor checked it in the transcript). Section 2 records the *Rukovodilac*'s reading of it. It supersedes D7's "only a platform admin in the first scope" and C30 for T5. |
| Decides | The *Rukovodilac*: R1–R7 (section 12), inside the plan. The owner: no open question blocks 7d (section 11). |
| Migration | **v48**, proposed as `migrations_v2/<YYYYMMDDHHMM>_training_load_v48_mapping_activations.sql`, after v47 (7c). |

---

## 0. In short

- **T5 rows get their writers.** A T5 row says "this team binding may import through exactly this mapping version", as
  `required` or `optional`.
- **Who:** an active platform admin, and since C106 also the active admin of the club that owns the binding, in that
  club's workspace. A club admin works only on its own club's bindings, and only with system mappings or its own
  club's mappings. Everyone else gets the identical 404. Section 2's table is the one scope rule of every route,
  replay and list.
- **A system version can always be stopped:** the ends that A1, A2 and the pinned step write are a platform admin's
  and pass even on an archived club's binding. A club's own version on an archived club stays as 7b decided (section
  2.3). A start, and an end by S2, need the binding's club active.
- **The new routes:**
  - S1 `POST /activations`: start one version on one or more explicitly listed bindings, in one operation;
  - S2 `POST /activations/:activationId/end`: end one activation;
  - S3 `GET /activations`: the list, in pages.
- **7b's refusals are replaced by D6's steps:**
  - A1, a replacement: end every open activation of the old version (`mapping_version_replaced`), then the 7b
    transition, then optionally start the new version on listed bindings;
  - A2, a disable: end every open activation (`mapping_version_disabled`), then disable;
  - the revision lifecycle's pinned step (O5): end, disable, retire, in one transaction.
- **v48** is the database actor guard of every T5 write (C76), with the `club_admin` basis C106 adds: the acting user on
  the row, the derived basis, the T8 chain, and the deferred audit links.
- **No owner question blocks it** (section 11). **No frontend:** the screens come with phase 8.

---

## 1. What exists (verified at `70e9e2b`)

### 1.1 T5 (v34, `migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql`)

- **The anchor:** `source_team_bindings_id_team_key unique (id, team_id)` on the v27 binding table (lines 1290–1291).
- **The table** `source_metric_mapping_activations` (lines 1293–1333):
  - the checked copies of the version, `(mapping_version_id, mapping_id, source_metric_definition_id,
    metric_definition_id, parameter_fingerprint)`, with a foreign key to T4;
  - `(source_team_binding_id, team_id)`, with a foreign key to the anchor;
  - the level copies;
  - `requirement` in `required | optional`, with no default (C23);
  - `activated_by_user_id`, `activated_basis` (CHECK `= 'platform_admin'`), `activated_at`, `reason` (the text rule,
    1–500);
  - `ended_at`, `ended_by_user_id`, `ended_basis` (null or `platform_admin`), `end_reason` (`admin_ended |
    mapping_version_replaced | mapping_version_disabled`), null together;
  - the T6 anchor `unique (id, mapping_version_id, source_team_binding_id)`.
- **The partial uniques** (lines 1337–1349), while open:
  - one row per binding, source field and parameter fingerprint;
  - one source per binding and canonical variable, for the session level and for the drill level;
  - an index of the open rows per version, and an index per binding.
- **The insert guard** (lines 1354–1407):
  - the row is created open;
  - T4 `FOR SHARE`: the version must be `active`, and the levels must equal the version's;
  - T2a (plain): the field is active;
  - T3 (plain): the owner;
  - the binding, the connection and the host catalog (plain): an active binding of the field's source and API family;
  - **C35:** a club mapping only on a binding of a connection owned by that club; a team-owned connection hosts a
    system mapping only for its own team;
  - last, `source_metric_require_platform_admin(activated_by)`.

  It does not compare the creator with the transaction's acting user.
- **The update guard** (lines 1410–1432): a DELETE is refused, an ended row is immutable, and only the end is written,
  with `source_metric_require_platform_admin(ended_by)` (line 1429). There is no actor comparison and no check of the
  end's time.
- **Other readers:**
  - the T2a retire guard refuses while an activation is open (lines 338–341);
  - the T4 disable guard refuses *"a mapping version with an open activation is not disabled"* (lines 1200–1203);
  - the T6 insert guard takes the T5 row `FOR SHARE` and refuses an ended one (C49), then the binding and the Metrics
    Core connection `FOR SHARE` (C55) (lines 1536–1589).
- **T8:**
  - `source_metric_audit_row_ok` (lines 1662–1665): `activation_start` and `activation_end` name exactly the version,
    the activation and the team (`00011001`, no `mapping_id`), with basis `platform_admin` only. The start needs a
    reason; the end does not;
  - `source_metric_audit_insert_guard` (lines 1748–1761): a `club_admin` row must name a club mapping through
    `mapping_id`, and an activation row must name its own version and team.
- **No later migration has a trigger on T5** (v35–v46). v40 tightened the text rule its `reason` uses (v40 lines
  124–125).

### 1.2 The guards on T8 today

- **v35's actor guard** (`…_v35_source_metric_actor_guards.sql` lines 216–288): an action other than the four mapping
  actions must be written by the acting user, an active platform admin, with the `platform_admin` basis (lines
  227–234).
- **The revision guard** (v39's body, lines 166–239; v47 adds the conversion branch): *"no writer of this action exists
  yet"* for `activation_start` and `activation_end` (line 211). **So no T5 audit row can be written today.**
- **v43:** G1 (the replacement link, lines 51–84) and G2 (the transition facts, lines 89–121) read no T5.

### 1.3 What 7b and the lifecycle do with T5 now

- **`sourceMetricMappingService.js`:**
  - `lockVersions` (lines 1267–1276) locks the T4 rows FOR UPDATE and counts the open T5 rows plainly;
  - **A1** `activateVersion` (lines 1325–1424) refuses `409 activation_open` (line 1375) when the old or the new
    version has an open activation;
  - **A2** `disableVersion` (lines 1430–1468) does the same (line 1455);
  - v34's disable text maps to `activation_open` (line 324; message line 351).
- **`sourceRevisionLifecycleService.js`:**
  - `lockPinned` (lines 193–215) counts the open T5 rows of the pinned versions plainly;
  - `pinnedDecisions` (lines 231–239) refuses `409 activation_open` (line 232) before it disables the pinned
    `needs_review` and `active` versions;
  - they serve L2/L5 (`retireRevision`, lines 421–428) and L4 (`replaceRevision`, lines 494–507).
- **The 7b contract leaves this to 7d:**
  - D6's steps (lines 139–145, 258–262);
  - R4 (line 596): `activation_open` is replaced by D6's steps;
  - O5 (lines 149–151): the pinned step ends the activations;
  - Q5 (lines 545–549): D3's prepared replacement in L4;
  - the G1 obligation (lines 613–618): a prepared replacement writes `mapping_version_replaced` for each version it
    activates, with the replaced version's `mapping_status` row in the same operation;
  - Q4 (lines 581–582): the ownership of zone and threshold mappings, for 7d and 7e.
- **Tests:**
  - `source-metric-mapping-m2.test.mjs` lines 1005–1007 asserts that no backend file writes T5;
  - the 7b and v39 suites create T5 rows with `session_replication_role = replica` ("Phase 7d simulation",
    `source-metric-mapping-transitions-7b.test.mjs` lines 261–282; `source-revision-lifecycle-v39.test.mjs` line 409).

### 1.4 Bindings and their administrators (v27, F3c2e/f)

- **`source_team_bindings`** (v27 lines 240–277): `active` or `ended`; one active binding per team and source; a bind
  and an unbind take the team's import try-lock inside the trigger; a team cannot leave its club while bound through
  its club's connection (v27 lines 410–430). After an Unbind the team may move, so `teams.club_id` can then differ
  from the connection's owner.
- **A connection's owner, source and host are immutable once any binding exists** (v27 lines 437–484). So the owner
  club of a binding's connection never changes.
- **A club archive ends no binding.** No migration (v27, v32) and no service ends a binding when its club is archived;
  only the four services that read bindings touch the table. An archived club's binding can therefore hold open T5
  rows.
- **`sourceConnectionService.js`** (not changed by 7d):
  - `resolveConnectionAdmin` (lines 184–200): a platform admin in the platform or a club workspace, or a club admin in
    its own club's workspace;
  - `rightsStillHold(client, ctx, clubId)` (lines 207–221) and `clubVisible(ctx, clubId)` (lines 222–225), neither
    exported. Its context carries `workspace`, not `owner`, and its `rightsStillHold` has no promotion probe;
  - `unbindTeam` (lines 391–554) takes the per-user lock, the connection `FOR NO KEY UPDATE`, the team lock and the
    binding `FOR UPDATE`, under `lock_timeout` 2 s, and reads neither T5 nor T6 (C58).
- **`sourceMetricAccess.js`** exports another `rightsStillHold(client, ctx)` (lines 80–112), on the mapping context
  (`owner`). It probes a club admin's promotion to platform admin (`409 try_again`, C79), and it locks a club only for
  a club scope.
- **`source_metric_actor_basis(actor, club)`** (v35 lines 82–114) returns NULL for a platform admin when `club` is
  given and inactive. With a NULL club it returns `platform_admin` for an active platform admin and NULL for anyone
  else.
- **Only club-owned connections exist.** No route creates a team-owned one.

---

## 2. C106: who may write T5 (the *Rukovodilac*'s reading of the owner's word)

**May start and end an activation on a binding B:**
- **An active platform admin:**
  - in the platform workspace: system mappings on any club's binding;
  - in club X's workspace (support): system mappings and club X's mappings, on club X's bindings.
- **An active club admin of club X, in club X's workspace:** system mappings ("a reference") and club X's own mappings,
  on club X's bindings.

**Never:**
- another club's mapping;
- another club's binding;
- a team-owned connection (none exists; refused fail-closed);
- a coach, an athlete, or a club admin outside its own club's workspace.

They all get the identical 404 (ADR-006).

### 2.1 The scope rule (one table for S1, S2, S3, A1's listed starts and every replay)

| Caller | Mapping owner allowed | Binding's club allowed |
|---|---|---|
| `platform_admin`, platform workspace | system | any club, active |
| `platform_admin`, club X's workspace | system or X | X, active |
| `club_admin`, club X's workspace | system or X | X, active |

- The version must belong to the named mapping (`versionId` of `mappingId`).
- For S2, the mapping and the binding are the activation's own.
- For S3, a row is listed only when both columns admit it. In the platform workspace this means system mappings only,
  so a club mapping's activation never appears there (C60, as `readableOwnerKeys`).
- **Anything else is the identical 404.** That includes an archived club, for both bases and on every route.
- **The facts the rule reads are immutable:** a version's mapping, a mapping's owner, a binding's connection, and the
  connection's owner once bound (v27 lines 437–484). So the rule is first decided on an unlocked read, and decided
  again under the locks (section 4).
- This matches A1 and A2: 7b runs them in the workspace of the mapping's owner (7b R3). A2 of a system version in the
  platform workspace therefore ends that version's activations on every club's binding. A1 or A2 of a club X version
  in club X's workspace meets only club X's bindings (C35).

### 2.2 The binding's club: one definition

**The binding's club** is the owner club of the binding's connection, `source_credential_connections.owner_club_id`
through `source_team_bindings.connection_id`:
- v48 gives it one SQL function, `training_load.source_metric_binding_club(binding_id)`. It returns NULL for a
  connection that is not club-owned.
- The T5 guards, the T8 insert guard and the T8 actor guard all use that function, and the services read the same
  join.
- It never goes through the team, whose club can change after an Unbind. An activation left on an ended binding
  therefore keeps the scope it had.
- **A connection that is not club-owned is refused fail-closed:** the database refuses a start, and the route answers
  the identical 404.

### 2.3 The basis on the row

The basis is the one the database derives for the acting user. Which club it is derived for depends on the write:

| Write | Derived as | Result |
|---|---|---|
| A start (S1, A1's listed starts) and an S2 end (`admin_ended`) | `source_metric_actor_basis(actor, the binding's club)` | `platform_admin` for an active platform admin, `club_admin` for that club's active admin, both only while the club is active |
| An end written by A1, A2 or the pinned step (`mapping_version_replaced`, `mapping_version_disabled`) | `source_metric_actor_basis(actor, NULL)` | `platform_admin` for an active platform admin, **whatever the state of the binding's club**; NULL for anyone else (`42501`) |

`activated_basis`, `ended_basis` and the T8 `basis` carry it.

**Why the second row:**
- A1, A2 and the pinned step stop a version, or every version pinned to a source field. An open activation of a
  **system** version on an archived club's binding must never stop them (O5; 7b Q7).
- **A club's own version on an archived club is unchanged by 7d:** 7b decided it (7b Q1(a), O7(ii)(a), C104).
  - A1 and A2 in that club's workspace are the identical 404, because `resolveMappingAdminWith` admits no archived
    club (`sourceMetricAccess.js` lines 69–72).
  - The pinned step answers `409 club_archived` (`archivedPinnedClubs`, `sourceRevisionLifecycleService.js` lines
    219–237) and ends nothing, because it rolls back whole.
  - So that version's activations stay open until the club is restored. This is the one case where "a field can
    always be stopped" waits for a restore, as 7b already records.
- The NULL club cannot widen a club admin's reach: a club admin gets no basis from it.
- An S2 end on an archived club's binding is the identical 404, as everywhere else. The activation stays open, as the
  club's binding does (section 1.4), and S2 reaches it again if the club is restored. A2 and the pinned step still end
  it (R9). Whether an import may run for an archived club's team is M4's question, not 7d's.

**Unchanged:** A1, A2 and the revision lifecycle stay the platform admin's (7b, O1).

**Why D7 said "platform admin" and why C106 is consistent:** an activation changes what an import writes for a whole
team. The club admin already manages the club's connection and its team bindings (F3c2e, 2026-10-03), so starting and
ending the club's own activations sits with the same role. **C106 supersedes D7's first-scope sentence and C30 for T5,
recorded both ways in the discovery document.**

---

## 3. Routes (HTTP contract)

All under `/api/training-load/sources/metrics`, M2's conventions (`requireAuth`, `no-store`, `runWrite`, the request
record).

### 3.1 The order of the answer

1. 401 without a session.
2. `resolveMappingAdmin`, then `mayManageActivations(ctx)`:
   - `platform_admin` in the platform workspace or a club workspace;
   - or `club_admin` in its own club's workspace.

   Otherwise the identical 404, before the body. Each service function checks it again first.
3. 415, then 400 for a non-object body.
4. A malformed id: the identical 404.
5. The body's shape: `400 invalid_body`.
6. The write:
   - **The scope first, before any lock:** a plain read of the version with its mapping (S1), of the bindings with
     their connection's club and team (S1), or of the activation (S2), then section 2.1's rule. Out of scope is the
     identical 404, so a busy lock can never tell an existing resource from a missing one.
   - **Then the locks**, and the rule decided again under them (section 4).
   - A state refusal is answered only after the right is confirmed again (the 7b rule).
   - **An archived team** follows F3c2e and F3c2f: S1 and A1's listed starts answer the identical 404, as a bind does.
     S2 ends an activation on an archived team's binding, as an Unbind does; it is a remedy. An archived club is the
     identical 404 on both.

### 3.2 S1 `POST /activations` — start

Body (no other key):

```json
{ "requestKey": "<uuid>", "mappingId": "<uuid>", "versionId": "<uuid>",
  "bindings": [ { "bindingId": "<uuid>", "requirement": "required" } ],
  "reason": "<1–500, one line>" }
```

- **`bindings`:** 1–50 entries with distinct `bindingId`s; `requirement` is `required` or `optional`, with no default
  (C23). "Every active binding of this connection" is the client listing them: the server never adds a binding that is
  not named, and never a future one (D, G).
- **201 `{ activations: [ … ], replayed: false }`:** one row per binding, in ascending binding id. A replay, or a
  verified COMMIT, answers `200`: a replay with `replayed: true`, a verified COMMIT with `replayed: false` and
  `commitConfirmation: "verified_after_commit_error"` (`runWrite` lines 765–800, `writeAnswer` in
  `routes/sourceMetrics.js` line 134).
- **Each row:** `{ id, mappingId, versionId, bindingId, bindingState, teamId, requirement, appliesToSession,
  appliesToDrill, basis, activatedAt, endedAt, endReason }`. It carries no acting user and no reason (C63, G).
  `bindingState` is `active` or `ended`, read with the row.
- **Several bindings that fail:** the bindings are checked in ascending id, and the refusal names the first one that
  fails, in `current.bindingId` with its own facts. Nothing is written.
- **One operation:** N T5 rows, inserted in ascending binding id (D), and N T8 `activation_start` rows. The keyed T8 row
  (the request record) is the last.

### 3.3 S2 `POST /activations/:activationId/end` — end

Body: `{ "requestKey", "expectedState": "open", "reason": "<1–500>" }`.
- **200 `{ activation, replayed }`.**
- `end_reason` is `admin_ended`. The reason goes to the T8 `activation_end` row (R5); the T5 row has no free-text end
  reason.
- An activation that is already ended: `409 activation_not_open` with `current`.
- **The scope** is section 2.1's rule on the activation's own mapping and binding. An activation left open on an ended
  binding can be ended: its binding's club is the connection's owner, which never changes (section 2.2).

### 3.4 S3 `GET /activations` — the list

- **Filters:** `bindingId` or `versionId` (one of them is required), and `state` (`open | ended | all`, default
  `open`).
- **Pages** (C68): 100 a page, an opaque `nextCursor`.
  - The cursor carries a position only (the last row's id), never a scope or a filter.
  - Every page applies the caller's current scope and the filters sent with it again. A cursor taken in another
    workspace can only position the list, never widen it.
- **The fields** of S1's rows, never the acting user (G).
- **The audience:** the writers of section 2. Each row is listed only when section 2.1's table admits both its mapping
  and its binding. A club admin sees its own club's bindings only, and a platform admin in the platform workspace sees
  system mappings' activations only. A `bindingId` or `versionId` outside the scope is the identical 404.

### 3.5 A1 and A2 (7b's routes), extended

- **A1 `POST /mappings/:mappingId/versions/:versionId/activate`** gains two optional keys:
  - `activations: [{ bindingId, requirement }]` (0–50);
  - `activationReason` (required when `activations` is not empty).
- **A1 with a replacement of N:**
  1. every open T5 row of N ends with `mapping_version_replaced`, each with its `activation_end` T8 row;
  2. 7b's disable of N and activation of N+1;
  3. a T5 row for each listed binding, each with its `activation_start` row.
- **A1 without a replacement:** the activation, then the listed bindings (C8: "explicit per binding, in the same
  transaction").
- **A2 `POST …/disable`:** every open T5 row of the version ends with `mapping_version_disabled`, then 7b's disable.
- **The ends of A1 and A2:**
  - they take the platform admin's basis derived without the club gate (section 2.3), so an archived club's binding
    never stops them;
  - each `activation_end` T8 row carries the transition's own reason, which is the version's `disable_reason` (A1
    with a replacement: the request's `reason`; A2: its `reason`). v48 checks it (section 6.3).
- **A1's listed starts** follow S1's rules: section 2.1's scope in the workspace of the mapping's owner, the archived
  team and club, and the first failing binding named.
- **The answers** add two fields to 7b's:
  - A1: `activationsEnded` (the number of N's activations it ended) and `activations` (the rows it started, in S1's
    shape, ascending by binding id);
  - A2: `activationsEnded`.

  The count tells the caller how many bindings stop importing and are not restarted (R8).
- **A1's and A2's replay** reread the operation by the keyed row's `operation_id`: the T5 rows it started, and the
  count of its `activation_end` rows. The scope is that of 7b's replay (`writableVersion`, owner-filtered), and every
  started row must pass section 2.1 in the current workspace; otherwise the identical 404.
- **`409 activation_open` disappears from A1 and A2** (R4 of J8). Only a raw writer outside these routes can still meet
  v34's disable refusal.

### 3.6 The revision lifecycle (L2, L5 and L4), extended (O5)

- **The pinned step** (`pinnedDecisions` / `disablePinned`) first ends every open T5 row of the versions pinned to the
  revision, with `mapping_version_disabled` and an `activation_end` row each:
  - the basis is derived without the club gate (section 2.3);
  - the T8 reason is the fixed `PINNED_DISABLE_REASON`, which is also each version's `disable_reason`.
- **Then it continues as today:** it disables the versions, then retires (L2/L5) or replaces (L4), all in one
  transaction.
- **`409 activation_open` disappears from the lifecycle.**
- **D3's prepared replacement in L4** (Q5: the versions on R+1 activated in the same transaction and T5 moved) is
  proposed as its own pull request, **7d-C** (R1, section 12).

### 3.7 The refusals

| Code | Status | Route | When |
|---|---|---|---|
| `invalid_body` | 400 | all | the shape; `requirement` missing or not `required` / `optional`; duplicate bindings; more than 50; `reason` / `activationReason` not the text rule |
| (identical 404) | 404 | all | a caller outside 3.1 step 2; a version, mapping or binding outside section 2.1's scope; a version not of the named mapping; an archived club (all routes) or an archived team (S1, A1's starts); a connection that is not club-owned; a right lost during the write; a replay or a cursor from a workspace whose scope does not cover the rows |
| `version_not_active` | 409 | S1 | the version is not `active` (+`current.status`) |
| `binding_not_active` | 409 | S1 | the binding has ended (+`current.bindingState`) |
| `binding_source_mismatch` | 409 | S1 | the binding's source or API family is not the field's (v34's two refusals) |
| `field_retired` | 409 | S1 | the source field is retired (v34's C42 backstop) |
| `activation_exists` | 409 | S1, A1 | an open row exists for the binding, field and fingerprint (`source_metric_activations_one_open_per_field`) |
| `variable_taken_on_binding` | 409 | S1, A1 | the binding already imports the canonical variable at that level through another open activation (`…_one_open_session_target` / `…_drill_target`) |
| `activation_not_open` | 409 | S2 | the activation has ended (+`current`) |
| `request_key_reused` | 409 | all writes | — |
| `try_again` | 409 | all writes | `55P03`, `40P01`, `57014` |
| `outcome_unknown` | 503 | all writes | the COMMIT's answer lost and not verified |
| `internal_error` | 500 | all | anything else |

Every T5 refusal of v34 has a fixed text, and the service maps each one exactly. The two `23505`s map through their
index names.

---

## 4. The writes, step by step

### 4.1 S1 (start)

1. **The user lock and the request record.** A replay rereads the operation's T5 rows by the keyed row's
   `operation_id`. It answers them only when the right holds again and section 2.1 admits the mapping and every binding
   in the **current** workspace; otherwise the identical 404 (as 7b's replay through the owner-filtered
   `writableVersion`).
2. **The scope on a plain read** (section 3.1 step 6): the version of the named mapping, the mapping's owner, and each
   binding's club (`source_metric_binding_club`) and team. Out of scope, an archived club or an archived team is the
   identical 404, before any lock.
3. The actor setting.
4. **The locks:**
   - T3 (the mapping) `FOR SHARE`. 7b's transitions take it `FOR NO KEY UPDATE`, so a start and a disable of the same
     mapping serialize;
   - T4 (the version) `FOR SHARE`, its mapping checked again;
   - the binding rows `FOR SHARE`, ascending by id. That is stronger than the `FOR KEY SHARE` the T5 foreign key takes:
     it conflicts with every UPDATE of the binding, so any Unbind, through `unbindTeam` or a raw writer, waits for
     this transaction or lands first (section 5). It is compatible with the importer's and T6's `FOR SHARE` (C55);
   - the bindings' team rows `FOR SHARE`, distinct ids ascending, as a bind locks its team
     (`sourceConnectionService.js` line 965). A team archive therefore waits or lands first.
5. **The rights:**
   - the actor side: the existing `rightsStillHold(client, ctx)` of `sourceMetricAccess.js`, with its C79 promotion
     probe (`409 try_again`);
   - the binding side, for **every** basis: `bindingClubHolds(client, clubIds)`, the bindings' club rows `FOR SHARE`,
     distinct ids ascending. An archived club is the identical 404, and an archive running meanwhile waits or lands
     first (R6);
   - section 2.1's rule again on the locked facts, and the teams again under their lock: an archived team is the
     identical 404, never a named 409.
6. **The state checks**, per binding in ascending id; the first failure is named:
   - the version is active, the binding is active (read under its lock), and the field is active;
   - then the two open-row conditions, as plain reads: an open row for the binding, field and fingerprint
     (`activation_exists`), and an open row for the binding and canonical variable at the level
     (`variable_taken_on_binding`).

   So one ascending pass names the lowest failing binding, whatever the kind of failure. The unique indexes stay the
   backstop: a `23505` at step 7 names the binding of the insert that failed.
7. **The T5 INSERTs**, ascending by binding id. v34's guard and v48's guard run on each.
8. The T8 rows: N `activation_start` rows, the keyed one last.
9. The bounded COMMIT, with v48's deferred links.

**S1's real lock order:** T3 → T4 → the bindings (`FOR SHARE`) → their teams (`FOR SHARE`) → the role and user rows →
the club rows → the new T5 rows → T8.

Against D's order (T3 → T4 → T5 → binding → MC connection → the acting user's rows), the new T5 rows come after the
user and club rows. This forms no cycle, for two reasons:
- no other transaction can lock a row this transaction has not yet inserted;
- the only wait on it is a concurrent S1's insert of the same unique key. That one already holds all its own locks and
  waits on this transaction's id only.

### 4.2 S2 (end)

1. **The user lock and the request record.** A replay rereads the activation and answers it only when the right holds
   again and section 2.1 admits it in the current workspace; otherwise the identical 404.
2. **The scope on a plain read:** the activation with its mapping's owner and `source_metric_binding_club` of its
   binding. Out of scope, or an archived club, is the identical 404.
3. The actor setting.
4. **The locks, in D's order:** the activation's T3 row `FOR SHARE`, its T4 row `FOR SHARE`, then the T5 row
   `FOR NO KEY UPDATE`. The T4 lock must come before the T5 row, for two reasons:
   - S2's T8 row names the version, and T8's single-column foreign key `mapping_version_id → T4(id)` (v34, the T8
     table) takes `FOR KEY SHARE` on that T4 row at the insert;
   - A2 and the pinned step hold T4 `FOR UPDATE` before they lock the T5 rows.

   So an S2 that locked T5 first could deadlock with them (section 5).
5. **The rights:** `rightsStillHold(client, ctx)` (with the promotion probe), then `bindingClubHolds` (the identical 404
   for an archived club), then section 2.1's rule again.
6. `activation_not_open`, if it has ended.
7. **The UPDATE:** `ended_at = now()`, `ended_by_user_id` = the actor, `ended_basis` = the basis derived for the
   binding's club, `end_reason = 'admin_ended'`.
8. The T8 `activation_end` row (keyed), with the request's reason.
9. The COMMIT.

### 4.3 A1, A2 and the pinned step

- **Placement:** 7b's lock order stays. After the T4 rows (`FOR UPDATE`), the open T5 rows of those versions are taken
  `FOR NO KEY UPDATE` in ascending id (D: "then the T5 rows, before its first modification"). They are no longer only
  counted.
- **A1's real order:** the conversion rows (C52, `activateVersion` line 1347) → T2a and T2b `FOR SHARE` → T3
  `FOR NO KEY UPDATE` → T4 `FOR UPDATE` → (metric definitions and scope capabilities) → the open T5 rows `FOR NO KEY UPDATE` → the role and user rows (7b's `rightsStillHold`,
  `activateVersion` line 1362) → the listed bindings `FOR SHARE` → their teams → their club rows → the new T5 rows →
  T8.
  - The listed bindings come after the user rows. No cycle forms: an Unbind holds a binding `FOR UPDATE` and then
    wants only `FOR SHARE` rows that A1 holds `FOR SHARE`, so it never waits back.
  - **A1's listed bindings' scope is read plainly** with 7b's `transitionTarget`, before A1's first lock. A1's caller
    is a platform admin in the workspace of the mapping's owner, so the scope read is 7b's, and section 9's "before
    any lock" holds for A1 as for S1 and S2.
- **The writes, in this order:**
  1. the T5 ends, with `ended_basis` derived without the club gate (section 2.3);
  2. 7b's status changes;
  3. A1's listed bindings: `FOR SHARE` ascending, their teams `FOR SHARE`, `bindingClubHolds` and the state checks,
     as S1's steps 4–6;
  4. any new T5 rows;
  5. the T8 rows: the `activation_end` rows (each with the version's `disable_reason`) and the `activation_start`
     rows, then 7b's own, with the keyed one last.
- **G1 (v43)** is unaffected: it checks only `mapping_status` and `mapping_version_replaced` rows. The activation rows
  share the operation id.

### 4.4 The request hash

- **S1:** `{ op, mappingId, versionId, bindings (sorted by id), reason }`.
- **S2:** `{ op, activationId, expectedState, reason }`.
- **A1:** 7b's hash plus `activations` (sorted) and `activationReason`. A replay of an A1 made before 7d hashes as
  before, because the new keys are absent.

---

## 5. Lock order and concurrency

The order is D's (v34 header, lines 38–49): T3 → T4 → (metric definitions, scope capabilities: A1 only) → T5 → the
binding → the Metrics Core connection → the acting user's rows. S2, A1, A2 and the pinned step take a prefix of it,
followed by the role, user and club rows. S1's order, and why its one difference forms no cycle, is in section 4.1.

| Against | Outcome |
|---|---|
| S1 or S2 against A1 / A2 of the same mapping | Each takes T3 first among the registry rows (S1 and S2 `FOR SHARE`, A1 and A2 `FOR NO KEY UPDATE`): they serialize, and no cycle can form. |
| S2 against an A2 (or the pinned step) ending the same row | All take T3 and T4 before the T5 row (section 4.2 step 4): S2 takes both `FOR SHARE`; A2 takes T3 `FOR NO KEY UPDATE` and T4 `FOR UPDATE` (`disableVersion`, lines 1449–1451); the pinned step takes T3 `FOR SHARE` and T4 `FOR UPDATE` (`lockPinned`, lines 193–215). So S2 and A2 serialize at T3, and S2 and the pinned step at T4, before either holds the T5 row. The second finds the row ended: S2 answers `activation_not_open`, and A2 or the pinned step skips an ended row. |
| S1 against S2 on the same binding and field | S2 ends the open row while S1 inserts a new one. S1 waits only on the open-row unique index entry, which S2's end releases at its COMMIT. S2 waits on nothing S1 holds, so there is no cycle. |
| M4's importer (C57: team lock → T2b → T3 → T4 → T5 FOR SHARE → binding → MC connection → T6) | **S1:** holds T3, T4 and the bindings FOR SHARE, all compatible with the importer's FOR SHARE, and inserts new rows the importer cannot be waiting for. **S2 / A2 / the pinned step:** wait for an importing transaction's FOR SHARE on the T5 row, then end it. The importer's T6 rows stay (C49). No 7d write takes the team lock, so no cycle forms. |
| An Unbind (per-user lock → connection FOR NO KEY UPDATE → team lock → binding FOR UPDATE → its own role, user and club rows FOR SHARE) | S1 holds the binding `FOR SHARE` from step 4, which conflicts with the Unbind's `FOR UPDATE` and with any raw UPDATE of the binding. S1 never waits for the connection or the team lock. The role, user and club rows are FOR SHARE on both sides, so they are compatible. One side waits for the other and the other never waits back, so no cycle forms. A wait beyond 2 s answers `try_again` on either side (C58's bound). If the Unbind commits first, S1 reads the ended binding under its lock and answers `binding_not_active`. S2 takes no binding lock and does not meet an Unbind. |
| A club archive (the club row updated) | S1 and S2 hold the club row FOR SHARE (step 5). The archive waits for them, or lands first, and then S1 or S2 answers the identical 404. The archive takes no T3, T4, T5 or binding lock, so there is no cycle. A1, A2 and the pinned step lock no club row for their ends (section 2.3), so an archive never blocks them. |
| A team archive | S1 and A1's starts hold the bindings' team rows FOR SHARE (step 4). The archive waits for them, or lands first, and then S1 answers the identical 404. S2, A2 and the pinned step lock no team row. |
| A team move | v27 refuses it while the team is bound through its club's connection (lines 410–430). After an Unbind it may move: S2, A2 and the pinned step lock no team row, and the scope stays the connection's club (section 2.2). |
| S1 against the pinned step on the same version | Both take T3 FOR SHARE, which is compatible (`lockPinned` line 198), so they serialize at T4 (S1 FOR SHARE against the pinned step's FOR UPDATE, lines 200–208). If the pinned step is first, S1 then reads the version disabled (`version_not_active`). If S1 is first, the pinned step reads S1's committed new row among the open rows and ends it. |
| A role revocation | The writes meet it only at their user-row FOR SHARE (the 7c argument). |

**Why S2 locks T3 and T4 first:**
- An activation's T8 row (`activation_start`, `activation_end`, shape `00011001`) names the version and carries no
  `mapping_id`.
- T8's composite foreign key `(mapping_version_id, mapping_id)` is MATCH SIMPLE, so it is not checked for such a row.
- T8's single-column foreign key `mapping_version_id → T4(id)` is checked, and it takes `FOR KEY SHARE` on the T4 row.
  That lock conflicts with A2's and the pinned step's `FOR UPDATE`.
- An S2 that held the T5 row and then met that foreign key would wait on A2, while A2 waited on the T5 row: a
  cycle. S2 therefore takes T3 and T4 before T5, in D's order.
- v48's guards read T4 plainly, the deferred link included.
- Test 9 holds S2 and A2, and S2 and the pinned step, against each other in both orders, and expects no `40P01`.

**The Unbind race D accepts is closed for S1 and A1:**
- D (discovery lines 1149–1153) accepted that an activation may land on a binding that has just ended. Such an
  activation applies to nothing, because T6 requires an active binding `FOR SHARE` (C55).
- S1 and A1 now hold the binding `FOR SHARE` before they check its state, so they cannot land on it, whoever ends the
  binding. R4 records the change.
- An activation can still sit open on an ended binding when the Unbind came after the start (C58: an Unbind never
  touches T5). S3 shows such a row with `bindingState: "ended"`, and S2 can end it.

**Deadlock:** none of these orders forms a cycle. `40P01` still answers `try_again`, and every wait is bounded at 2 s.

---

## 6. Migration v48 (specification; the file is written in 7d-B)

`migrations_v2/<YYYYMMDDHHMM>_training_load_v48_mapping_activations.sql`. CHECKs and functions; no table, column or
data change.

### 6.1 The locks

```sql
lock table training_load.source_metric_mapping_activations in access exclusive mode;
lock table training_load.source_metric_audit in share row exclusive mode;
```

- This is the writers' order: a T5 lock before the T8 insert.
- ACCESS EXCLUSIVE comes at once because two CHECKs change on T5.
- No T5 writer exists before 7d-B, so only T5's plain readers wait for the short run.

### 6.2 T5

- **The CHECKs:** `source_metric_activations_activated_basis_check` becomes `activated_basis in ('platform_admin',
  'club_admin')`, and `_ended_basis_check` becomes `ended_basis is null or ended_basis in ('platform_admin',
  'club_admin')`. Dropped and added under the same names, validated.
- **A new function, `training_load.source_metric_binding_club(p_binding uuid) returns uuid`** (section 2.2): the
  `owner_club_id` of the binding's connection when that connection is club-owned, NULL otherwise. It never reads
  `teams.club_id`. Every guard below that needs the binding's club calls it.
- **`source_metric_activations_insert_guard()` is replaced.** v34's checks stay, and these change:
  - `activated_by_user_id` must be `source_metric_context_actor()`;
  - a binding whose club (`source_metric_binding_club`) is NULL is refused (`23514`, fixed text): no team-owned
    connection takes a T5 row until its rule is decided;
  - `activated_basis` must equal `source_metric_actor_basis(actor, binding club)`, which is not NULL: `platform_admin`
    for an active platform admin, `club_admin` for that club's active admin, both only while the club is active
    (`42501` otherwise). This **replaces v34's last line**, `source_metric_require_platform_admin(new.activated_by_user_id)`
    (v34 line 1405);
  - C35 stays as it is: a club mapping only on its own club's connection. v34's team-owned branch stays in the body,
    though no row can reach it;
  - the archived team is the route's check (section 3.1 step 6), not the database's. The database's job here is the
    actor, the basis and the club.
- **`source_metric_activations_update_guard()` is replaced:**
  - `ended_by_user_id` is the actor, and `ended_at = now()`;
  - `end_reason = 'admin_ended'`: `ended_basis` must equal `source_metric_actor_basis(actor, binding club)`, not
    NULL;
  - `end_reason` in (`mapping_version_replaced`, `mapping_version_disabled`): `ended_basis` must equal
    `source_metric_actor_basis(actor, NULL)`, which is `platform_admin` for an active platform admin whatever the
    club's state and NULL for anyone else (section 2.3);
  - a NULL derived basis is `42501`. This **replaces v34's** `source_metric_require_platform_admin(new.ended_by_user_id)`
    (v34 line 1429);
  - every other v34 rule stays.
- **The table comment** (v34 line 1352, *"Written and ended only by a platform admin"*) is replaced: written by a
  platform admin or, since v48 (C106), by the binding club's admin, and ended by them or by a version's disable. The
  rollback restores v34's text.
- **Two deferred links** (AFTER INSERT / AFTER UPDATE of the end, `deferrable initially deferred`):
  - a start has its `activation_start` row, and an end has its `activation_end` row;
  - an end with `mapping_version_disabled` sits in the transaction that disabled its version. The T4 row's `xmin` is
    this transaction and its status is `disabled`. The link compares `xmin`, never a time, because 7b writes
    `disabled_at = clock_timestamp()`;
  - an end with `mapping_version_replaced` meets the same condition, and in addition a T8 `mapping_version_replaced`
    row of the same mapping carries the same `operation_id` as the end's `activation_end` row (v43's G1 pattern, v43
    lines 59–61). So an A2 disable cannot be labelled as a replacement.

  The failure messages are fixed texts.

### 6.3 T8

- **`source_metric_audit_row_ok()`:** `activation_start` and `activation_end` accept the basis `platform_admin` or
  `club_admin`. Every other branch is byte for byte v34's.
  - The function is called by the CHECK `source_metric_audit_action_shape`. Replacing it does not validate the
    existing rows again, and widening it leaves every existing row valid.
  - The rollback restores v34's body only while no `club_admin` activation row exists.
- **`source_metric_audit_insert_guard()`** (v34): a `club_admin` row of an activation action names its club through
  `source_metric_binding_club` of the activation's binding, never through the team and never through `mapping_id`. The
  mapping rule stays for the mapping actions.
- **`source_metric_audit_actor_guard()`** (v35): the activation actions read their T5 row by `activation_id`. The
  basis is then derived as section 2.3 says:
  - `activation_start`, and `activation_end` of an `admin_ended` end: `source_metric_actor_basis(actor, binding club)`;
  - `activation_end` of a `mapping_version_replaced` or `mapping_version_disabled` end: `source_metric_actor_basis(actor,
    NULL)`.

  The row's `basis` must equal it, and NULL is `42501`. Every other non-mapping action keeps `platform_admin` only.
- **The order of the BEFORE triggers on T8** is alphabetical: `source_metric_audit_insert_guard` (v34) fires before
  `source_metric_audit_v35_actor_guard`. So an activation row that names no existing T5 row of its version and team
  is refused first by v34's check (`23514`, *"an activation row must name its own mapping version and team"*, v34
  lines 1754–1758), which v48 keeps. The actor guard's own refusal of a missing row (`42501`) is defence in depth and
  is not reached first.
- **`source_metric_audit_revision_guard()`** (v47's body) gains the activation branch:
  - the T5 row is written in this transaction (xmin);
  - **start:** its activator is the actor, and the T8 reason equals the T5 reason;
  - **end:** its ender is the actor, and the T8 reason is not null. For a `mapping_version_replaced` or
    `mapping_version_disabled` end, the reason equals the version's `disable_reason`;
  - no evidence on either;
  - once per activation and action (`23514`), with a partial unique index `source_metric_audit_v48_activation_once
    (activation_id, action) where action in ('activation_start', 'activation_end')`.

  Every other line of v47's body stays byte for byte, and the final *"no writer of this action exists yet"* still holds
  for `source_instance_end` (7g).

### 6.4 The rollback, the preflight and the post-check

**The rollback refuses, changing nothing:**
- under the migrator's lock `822026`;
- without v48, or under a later migration;
- once any T5 row or any activation T8 row exists;
- with a v48 object missing or disabled;
- with a function body in force that is not v48's (by md5).

**Otherwise it:**
- takes v48's locks in v48's order;
- restores the six replaced bodies byte for byte: v34's two T5 guards, v34's `source_metric_audit_row_ok` and
  `source_metric_audit_insert_guard`, v35's actor guard, and v47's revision guard;
- restores the two CHECKs and v34's table comment;
- drops the two deferred link triggers and their functions, the index, and `source_metric_binding_club`;
- deletes the record.

It is rehearsed as v47's, with a `.gitattributes` LF line from the start.

**The merge order:** v48 embeds v47's final revision-guard body and its md5, and the preflight checks them. 7d-B is
therefore written on v47's merged text, never on a draft, and merges after 7c-B.

**The preflight (about 9 blocks):**
- v47 the last migration with its checksum;
- the md5 of the six bodies v48 replaces;
- no T5 row, and no activation T8 row;
- no v48 object;
- the migrator owns both tables;
- a quiet moment.

**The post-check (about 6 blocks):**
- v48 recorded once with its sha256;
- the new md5s;
- the CHECKs validated;
- the links deferred and enabled;
- the index valid;
- no row yet.

---

## 7. The access helpers (the *Rukovodilac*'s question; revised after round 2)

- **The four remaining copies of 7a are not needed by a T5 writer:** `isOwn`, `readableSql` / `ownSql`, `ownerFilter`
  / `writableSql` and `resolveVariableEditor`.
  - They filter canonical definitions and classification rows by `owner_scope` / `owner_club_id`, and add a coach
    view (`canonicalVariableAdminService.js` lines 269, 353–363, 735–768; `canonicalClassificationService.js` lines
    69–81).
  - T3 and T4 carry the single `owner_key`, compared with `ownerKeyOf(ctx)` (`sourceMetricMappingService.js` lines
    1240–1255).
  - **They stay where they are.** Their consolidation is a later cleanup, with no behaviour change, outside 7d.
- **What 7d-B does need** is on the binding side, which `sourceMetricAccess.js` lacks. Three new functions there, on
  the mapping context (`owner`):
  - **`mayManageActivations(ctx)`:** a `platform_admin` in the platform or a club workspace, or a `club_admin` in its
    own club's workspace (section 3.1 step 2);
  - **`activationInScope(ctx, { mappingOwnerKey, bindingClubId })`:** section 2.1's table, the one rule of S1, S2, S3,
    A1's starts and every replay;
  - **`bindingClubHolds(client, clubId)`:** the binding's club row `FOR SHARE`, for every basis. An inactive club is
    the identical 404.
- **The actor side keeps the existing `rightsStillHold(client, ctx)`** (lines 80–112), unchanged, with its C79
  promotion probe. A club admin granted platform admin during the request therefore answers `try_again`, never
  `42501`.
- **`sourceConnectionService.js` is not touched.** Its `rightsStillHold(client, ctx, clubId)` and `clubVisible` run on
  another context shape (`workspace`) and lack the promotion probe. Moving them would collide with the exported name
  and change behaviour. The first draft's move is withdrawn.

---

## 8. Changes to existing code (7d-B)

- **`sourceMetricMappingService.js`:**
  - `lockVersions` locks the open T5 rows instead of counting them;
  - A1 and A2 lose `activation_open` and gain the D6 steps and A1's `activations`;
  - `DB_REFUSALS` keeps line 324's mapping for a raw writer only;
  - the T5 refusal texts and the two index names are added to `classify`;
  - A1's and A2's replay reread the operation's T5 rows and count (section 3.5).
- **`sourceRevisionLifecycleService.js`:** `lockPinned` and `pinnedDecisions` end the open T5 rows instead of refusing
  (O5); `PINNED_DISABLE_REASON` is also the T8 reason of those ends. `archivedPinnedClubs` stays as it is: it checks the
  owner clubs of the versions being disabled, and the ends need no binding club (section 2.3).
- **`sourceMetricAccess.js`:** the three new functions of section 7. `sourceConnectionService.js` is not touched.
- **The tests:**
  - the M2 architecture test lists the T5 writers;
  - the 7b and v39 cases that expect `activation_open` change to expect the ends;
  - the "Phase 7d simulation" fixtures keep their raw T5 rows with the replica role (7b lines 259–282, 434 and 490;
    v39 lines 391, 427 and 989; M2 line 200). The replica role also skips v48's deferred links;
  - the M1 suite stops at v34 (its line 54), so its raw T5 cases are not affected.

---

## 9. Information hiding

- One identical 404 for every out-of-scope version, mapping, binding, activation and caller, and for an archived club.
- The scope is decided on a plain read before any lock (section 3.1 step 6). A lock wait or a `try_again` can
  therefore never tell an existing resource from a missing one.
- A replay or a cursor answers only what the current workspace's scope admits (sections 3.4 and 4.1).
- A club admin never learns that another club's binding or club mapping exists, whether by a code, a timing or a
  `current`.
- No answer carries an acting user, a reason or a credential fact. S3 shows `basis`: the kind of role, not the person.

---

## 10. Tests (7d-B; `backend/tests/mapping-activations-7d.test.mjs`, disposable, T1 runner)

1. **v48:** applied through the real runner; the post-check; every rollback refusal; the rollback to v47's catalog
   exactly; re-applied identically; atomicity.
2. **Audience** (S1, S2, S3, A1 and A2):
   - a platform admin in the platform workspace and in a club workspace;
   - a club admin in its own club: allowed;
   - a club admin in another club's workspace, on another club's binding, on another club's mapping, in the platform
     workspace;
   - a coach and an athlete;
   - an archived club (both bases, S1 and S2), an archived team (S1), and a role revoked during the call;
   - a platform admin in the platform workspace on a club mapping's activation (S2) and in the list (S3);
   - a version that is not of the named mapping.

   Each refused case gets the identical 404 and nothing written.
3. **S1:**
   - one binding and several bindings (in ascending order);
   - the `required` / `optional` copies, the T8 rows and the keyed row last;
   - every refusal of 3.7, both unique indexes included;
   - several failing bindings of different kinds (a state failure on a higher id, an open-row failure on a lower
     one): the lowest is named, and nothing is written;
   - a club admin's start: `201`, basis `club_admin` on T5 and T8.
4. **S2:**
   - an end, `activation_not_open`, and the reason only in T8;
   - a club admin's end (`200`, basis `club_admin`), including the end of a platform admin's start;
   - an end on an ended binding;
   - Unbind, then move the team to club Y, then end the activation: club X's admin gets `200`, club Y's admin gets the
     identical 404, and in SQL club Y's admin gets `42501`.
5. **S3:** the filters, the pages, the scope, a cursor from another workspace, and `bindingState`.
6. **A1 / A2 / the pinned step:**
   - the open rows ended with the right `end_reason` and T8 rows, then the 7b transition, then A1's listed starts;
   - G1 unaffected;
   - an A1 replay made before 7d still replays;
   - **an archived club:** an open activation of a **system** version on its binding is ended by A2, by A1
     (replacement) and by the pinned step (L2, L4, L5), with basis `platform_admin`;
   - **a club's own version on an archived club:** A1 and A2 answer the identical 404, the pinned step answers
     `409 club_archived`, and the activation stays open (7b Q1(a));
   - each `activation_end` T8 reason equals the version's `disable_reason`;
   - `activationsEnded` and `activations` in the answers and in their replays;
   - a cross-workspace replay of S1, S2 and A1: the identical 404.
7. **Replay, keys and the COMMIT through the real route:**
   - `request_key_reused`;
   - `verified_after_commit_error`;
   - `outcome_unknown`;
   - a definite refusal by a deferred link.
8. **Direct SQL against v48:**
   - no actor (`42501`), another user, a wrong basis, a club admin on another club;
   - a missing T8 row at COMMIT;
   - a second T8 row;
   - a savepoint;
   - a `mapping_version_disabled` end without its disable (the T4 row's `xmin` is not this transaction);
   - a `mapping_version_replaced` end in a disable without a `mapping_version_replaced` T8 row;
   - a club admin writing a version-driven end (`42501`);
   - a version-driven end whose T8 reason is not the version's `disable_reason` (`23514`);
   - an activation T8 row naming no existing T5 row (`23514`, v34's insert guard first);
   - a T5 row on a connection that is not club-owned (`23514`);
   - `ended_at` not `now()`.
9. **Concurrency:**
   - S1 against A2 on the same mapping;
   - S2 against A2, and S2 against the pinned step, on the same row (both orders; the T8 foreign key on the version is
     the reason for S2's order, section 5);
   - S1 against S2 on the same binding and field;
   - S1 against the pinned step on the same version (both orders);
   - S1 against a raw `UPDATE` ending the binding (it waits, then `binding_not_active`), and against a team archive
     (it waits, then the identical 404);
   - S1 against an Unbind of the binding (both orders: the Unbind waits, or S1 answers `binding_not_active`);
   - S1 and S2 against a club archive (both orders);
   - a club admin promoted to platform admin during S1: `409 try_again`;
   - S2 against a T6 insert holding the row (C49);
   - no `40P01`.
10. **Mutations:**
    - each scope check, and each column of section 2.1's table;
    - the derived basis, and the NULL club of a version-driven end;
    - `source_metric_binding_club` read through the team instead of the connection;
    - S2 taking the T5 row before T4;
    - each deferred link;
    - the once-index;
    - the D6 order (end before disable);
    - the pinned step's end;
    - each refusal mapping;
    - the rollback's refusals.
11. **Regression:**
    - M1, M2, v35, M2b, v39, v42, 7b, 7c and the F3c2e/f suites (`sourceConnectionService.js` unchanged);
    - `--preset gpexe` against its baseline;
    - the secret scan.

---

## 11. Owner questions (section K and C106)

**C106 is decided** (section 2). No open question blocks 7d:

| K item | Needed by 7d? | Recommendation |
|---|---|---|
| Q4: system or club ownership of zone and threshold mappings | **No.** An activation copies no bound; both kinds already activate under C35. | Defer to 7e, where the preview shows a team's bounds. |
| Which activations are `required` in the pilot (M6) | **No.** Each call names its `requirement`, with no default (C23). | Decide at M6. |
| The UI shape of "every active binding of this connection" | **No.** The API takes an explicit list. | Phase 8. |

---

## 12. Proposed for the *Rukovodilac* (inside the plan)

- **R1:** D3's prepared replacement in L4 (Q5) as its own pull request, **7d-C**, after 7d-B.
  - It activates new versions inside the lifecycle, so it must meet the G1 obligation of J8's section 11. That is its
    own transaction design and its own tests.
  - 7d-B's L4 ends and disables like L2.
  - Q5's "with 7d" still holds: 7d-C is part of 7d.
- **R2:** at most 50 bindings in one S1 or A1 call.
- **R3:** A1 may start the listed bindings with or without a replacement.
- **R4:** S1 and A1 hold the binding `FOR SHARE` before they check its state (section 4.1). The Unbind race that D
  accepted is therefore closed for them, against `unbindTeam` and a raw UPDATE alike. An activation can still sit open on a binding that ended after its start
  (C58); it applies to nothing, and S2 ends it.
- **R5:** an end needs a reason (1–500), written to T8 only. A version-driven end carries the version's
  `disable_reason`.
- **R6:** every S1 and S2 write locks the binding's club row FOR SHARE, for both bases (`bindingClubHolds`), so an
  archive waits or lands first.
- **R7:** `GET /activations` pages (C68) and needs a `bindingId` or a `versionId`.
- **R8:** A1 and A2 report the number of activations they ended (`activationsEnded`), and A1 also reports the ones it
  started. No acknowledgement is required before they end activations that are not restarted: the screens of phase 8
  show the list before the call. If the *Rukovodilac* wants an explicit precondition (for example
  `expectedOpenActivations`), it is a body key added to the request hash.
- **R9:** an archived club's binding:
  - S1 and S2 answer the identical 404 for both bases (ADR-006, as F3c2e/f for connections);
  - A1, A2 and the pinned step of a **system** version still end its activations (section 2.3);
  - a club's own version on an archived club stays as 7b decided: A1 and A2 are 404, and the pinned step answers
    `409 club_archived` and ends nothing.

  So a platform admin can stop one activation on an archived club only by disabling the whole system version, which
  reaches every club, or by restoring the club.

  The code review proposed that a platform admin's S2 should also pass on an archived club; the security review
  proposed the 404. The contract follows the security review, because the cleanup paths stay open. The *Rukovodilac*
  decides.

---

## 13. Review record

**Round 2** (2026-10-30; the first review of this contract), on head `f75b911`. Each reviewer's verdict on 7d was NOT
READY. Every finding is applied in this revision:

| Finding | Reviewers | Where |
|---|---|---|
| HIGH: a platform admin's ends on an archived club's binding fail (`source_metric_actor_basis` returns NULL), so A2, A1 and the pinned step could get stuck | code, DB, security | 2.3, 3.5, 3.6, 6.2, 6.3, tests 6 and 8 |
| MEDIUM: one definition of the binding's club (the connection's owner, never the team) | code, DB, security | 2.2, 6.2, 6.3, test 4 |
| MEDIUM: v34's `source_metric_require_platform_admin` calls (lines 1405, 1429) and the table comment (line 1352) replaced | code | 6.2, 6.4 |
| MEDIUM: the access helpers. The connection service is not moved; the existing `rightsStillHold` is kept with its promotion probe, and the binding club is locked for every basis | code, DB, security | 4.1, 4.2, 7, R6, test 9 |
| MEDIUM: one scope table, including `versionId ∈ mappingId` and S3's mapping filter | security | 2.1, 3.4, test 2 |
| MEDIUM: a replay is filtered by the current workspace's scope | security | 3.5, 4.1, 4.2, test 6 |
| LOW: the scope is decided before the locks | DB, security | 3.1, 4.1, 4.2, 9 |
| LOW: the T8 reason of a version-driven end | code | 3.5, 3.6, 6.3 |
| LOW: the deferred link by `xmin`, and a "replaced" end tied to a real replacement | code, DB | 6.2 |
| LOW: S1's real lock order, a club archive and a team move in the table | code | 4.1, 5 |
| LOW: `bindingState`, the A1 and A2 answers and replays, S1's replay status | DB | 3.2, 3.5 |
| LOW: S2 against A2 | DB | 4.2, 5 |
| LOW: the count of ended activations | security | 3.5, R8 |
| LOW: the archived team, the first failing binding, the cursor | DB, security | 3.1, 3.2, 3.4 |
| LOW: the rollback's link functions and the merge order after 7c-B | DB | 6.4 |
| NIT: the line numbers of `lockVersions` and `activateVersion` | code | 1.3 |

**One correction to a reviewer's argument:**
- The DB review said S2 and A2 cannot deadlock, because an activation's T8 row has no `mapping_id` and the composite
  foreign key to T4 is then not checked.
- T8 also has a single-column foreign key `mapping_version_id → T4(id)`. It is checked for that row, and it takes
  `FOR KEY SHARE` on T4.
- So S2 must take T3 and T4 before the T5 row (section 4.2 step 4), and the contract says why (section 5).

**Round 3** (2026-10-30), narrow re-reviews of the delta on head `f3d655f`. Each verdict: READY WITH NON-BLOCKING
NOTES. Every round-2 finding is closed, and each reviewer confirmed the correction to the DB review's argument. Applied
in this revision:

| Finding | Reviewers | Where |
|---|---|---|
| MEDIUM: "a version can always be stopped" holds only for system versions; a club's own version on an archived club stays as 7b decided | security (DB as LOW) | 0, 2.3, R9, test 6 |
| LOW: an archived team was a named state check on an unlocked read; the teams are now locked FOR SHARE as a bind does, and an archived team is the identical 404 | code, security | 4.1, 4.3, 5, tests 9 |
| LOW: the bindings FOR SHARE, not FOR KEY SHARE, so a raw UPDATE ending a binding also waits | code | 4.1, 4.3, 5, R4, test 9 |
| LOW: S1 against the pinned step, and A1's real order | code | 4.3, 5, test 9 |
| LOW: the lowest failing binding: the open-row conditions are pre-read in the same pass | security | 4.1, test 3 |
| LOW: the T8 triggers fire alphabetically, so v34's insert guard (`23514`) refuses a missing T5 row first | DB | 6.3, test 8 |
| NIT: `bindingClubHolds` locks distinct clubs ascending; A1's scope read before its first lock; the "replaced" link by `operation_id`; the complete list of replica-role fixtures | DB, security | 4.1, 4.3, 6.2, 8 |

The code re-review said the v35 actor guard fires before v34's insert guard. The trigger names sort the other way
(`…_insert_guard` before `…_v35_actor_guard`), as the DB re-review said, and the contract follows the names.

## 14. Not in 7d

- D3's prepared replacement in L4 (7d-C, R1).
- The preview (7e), the extractor registry (7f), ending a held instance (7g, `source_instance_end`).
- The importer (M4) and the import switch.
- The screens (phase 8).
- A team-owned connection.
