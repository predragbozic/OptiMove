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
  club's mappings. Everyone else gets the identical 404.
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
  - `lockVersions` (lines 1265–1276) locks the T4 rows FOR UPDATE and counts the open T5 rows plainly;
  - **A1** `activateVersion` (lines 1324–1424) refuses `409 activation_open` (line 1375) when the old or the new
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
  its club's connection (v27 lines 410–430).
- **`sourceConnectionService.js`:**
  - `resolveConnectionAdmin` (lines 184–200): a platform admin in the platform or a club workspace, or a club admin in
    its own club's workspace;
  - `rightsStillHold(client, ctx, clubId)` (lines 207–221) and `clubVisible(ctx, clubId)` (lines 222–225), neither
    exported;
  - `unbindTeam` (lines 391–554) takes the per-user lock, the connection `FOR NO KEY UPDATE`, the team lock and the
    binding `FOR UPDATE`, under `lock_timeout` 2 s, and reads neither T5 nor T6 (C58).
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

**The basis on the row** is the one the database derives for the acting user and the binding's club:
- `source_metric_actor_basis(actor, club of the binding)` gives `platform_admin` for an active platform admin, even in
  a club workspace, and `club_admin` for a club admin;
- `activated_basis`, `ended_basis` and the T8 `basis` carry it.

**The binding's club** is the owner club of the binding's connection. v27 keeps the team inside it while the binding is
active.

**Unchanged:** A1, A2 and the revision lifecycle stay the platform admin's (7b, O1). The T5 rows they end are written
with the `platform_admin` basis.

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
6. The write. A version, a mapping or a binding outside the caller's scope (section 2) is the identical 404, decided
   under the locks. A state refusal is answered only after the right is confirmed again (the 7b rule).

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
- **201 `{ activations: [ … ], replayed }`:** one row per binding, in ascending binding id.
- **Each row:** `{ id, mappingId, versionId, bindingId, teamId, requirement, appliesToSession, appliesToDrill, basis,
  activatedAt, endedAt, endReason }`. It carries no acting user and no reason (C63, G).
- **One operation:** N T5 rows, inserted in ascending binding id (D), and N T8 `activation_start` rows. The keyed T8 row
  (the request record) is the last.

### 3.3 S2 `POST /activations/:activationId/end` — end

Body: `{ "requestKey", "expectedState": "open", "reason": "<1–500>" }`.
- **200 `{ activation, replayed }`.**
- `end_reason` is `admin_ended`. The reason goes to the T8 `activation_end` row (R5); the T5 row has no free-text end
  reason.
- An activation that is already ended: `409 activation_not_open` with `current`.

### 3.4 S3 `GET /activations` — the list

- **Filters:** `bindingId` or `versionId` (one of them is required), and `state` (`open | ended | all`, default
  `open`).
- **Pages** (C68): 100 a page, an opaque `nextCursor`.
- **The fields** of S1's rows, never the acting user (G).
- **The audience:** the writers of section 2, each over the bindings its scope covers. A club admin sees its own club's
  bindings only. A binding or version outside the scope is the identical 404.

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
- **`409 activation_open` disappears from A1 and A2** (R4 of J8). Only a raw writer outside these routes can still meet
  v34's disable refusal.

### 3.6 The revision lifecycle (L2, L5 and L4), extended (O5)

- **The pinned step** (`pinnedDecisions` / `disablePinned`) first ends every open T5 row of the versions pinned to the
  revision, with `mapping_version_disabled` and an `activation_end` row each.
- **Then it continues as today:** it disables the versions, then retires (L2/L5) or replaces (L4), all in one
  transaction.
- **`409 activation_open` disappears from the lifecycle.**
- **D3's prepared replacement in L4** (Q5: the versions on R+1 activated in the same transaction and T5 moved) is
  proposed as its own pull request, **7d-C** (R1, section 12).

### 3.7 The refusals

| Code | Status | Route | When |
|---|---|---|---|
| `invalid_body` | 400 | all | the shape; `requirement` missing or not `required` / `optional`; duplicate bindings; more than 50; `reason` / `activationReason` not the text rule |
| (identical 404) | 404 | all | a caller outside 3.1 step 2; a version, mapping or binding outside the scope; a team-owned connection; a right lost during the write |
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

1. The user lock and the request record (a replay answers the operation's rows after the right is checked again).
2. The actor setting.
3. **The locks, in D's order:**
   - T3 (the mapping) `FOR SHARE`. 7b's transitions take it `FOR NO KEY UPDATE`, so a start and a disable of the same
     mapping serialize;
   - T4 (the version) `FOR SHARE`;
   - the binding rows, read with their connection and club, ascending by id.
4. The scope checks of section 2 (otherwise the identical 404).
5. `rightsStillHold` for the mapping side, and, for a club admin, the club's row `FOR SHARE` (the binding side, R6).
6. The state checks (version active, binding active, field active).
7. **The T5 INSERTs**, ascending by binding id. Each runs v34's guard and v48's guard, and its foreign key takes the
   binding `FOR KEY SHARE`.
8. The T8 rows: N `activation_start` rows, the keyed one last.
9. The bounded COMMIT, with v48's deferred links.

### 4.2 S2 (end)

1. The user lock and the request record.
2. The actor setting.
3. The T5 row `FOR NO KEY UPDATE`.
4. Its binding and club, read plainly, then the scope check.
5. The rights.
6. `activation_not_open`, if it has ended.
7. The UPDATE: `ended_at = now()`, `ended_by_user_id`, `ended_basis`, `end_reason = 'admin_ended'`.
8. The T8 `activation_end` row (keyed).
9. The COMMIT.

### 4.3 A1, A2 and the pinned step

- **Placement:** 7b's lock order stays. After the T4 rows (`FOR UPDATE`), the open T5 rows of those versions are taken
  `FOR NO KEY UPDATE` in ascending id (D: "then the T5 rows, before its first modification"). They are no longer only
  counted.
- **The writes, in this order:**
  1. the T5 ends;
  2. 7b's status changes;
  3. any new T5 rows;
  4. the T8 rows (the `activation_end` and `activation_start` rows, then 7b's own, with the keyed one last).
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
binding → the Metrics Core connection → the acting user's rows. Each 7d write takes a prefix of it.

| Against | Outcome |
|---|---|
| A1 / A2 of the same mapping | Both take T3 first (FOR SHARE against FOR NO KEY UPDATE): they serialize, and no cycle can form. |
| S2 against an A2 ending the same row | Both lock the T5 row FOR NO KEY UPDATE. The second finds it ended: S2 answers `activation_not_open`, and A2 skips an ended row. |
| M4's importer (C57: team lock → T2b → T3 → T4 → T5 FOR SHARE → binding → MC connection → T6) | **S1:** holds T3 and T4 FOR SHARE (compatible) and inserts new rows the importer cannot be waiting for. **S2 / A2 / the pinned step:** wait for an importing transaction's FOR SHARE on the T5 row, then end it. The importer's T6 rows stay (C49). No 7d write takes the team lock, so no cycle forms. |
| An Unbind (connection → team lock → binding FOR UPDATE) | S1's foreign-key `FOR KEY SHARE` on the binding conflicts with the Unbind's `FOR UPDATE`. Neither needs the other's earlier locks, so no cycle forms; a wait beyond 2 s answers `try_again` on either side (C58's bound). |
| A role revocation | The writes meet it only at their user-row FOR SHARE (the 7c argument). |

**Unbind, the race D accepts:** if an Unbind commits while S1 waits on the binding, S1's trigger has already read the
binding as active (a plain read), so the activation lands on a binding that has just ended. It applies to nothing,
because T6 requires an active binding `FOR SHARE` (C55). D (discovery lines 1149–1153) calls this harmless and so does
this contract (R4). S3 shows such a row as open on an ended binding, with `bindingState: "ended"`.

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
- **`source_metric_activations_insert_guard()` is replaced.** v34's checks stay, and three things change:
  - `activated_by_user_id` must be `source_metric_context_actor()`;
  - `activated_basis` must equal `source_metric_actor_basis(actor, club)`, where `club` is the owner club of the
    binding's club-owned connection: `platform_admin` for an active platform admin (with the club active),
    `club_admin` for that club's active admin (`42501` otherwise);
  - a `club_admin` row is refused on anything but a club-owned connection of the actor's own club.
- **`source_metric_activations_update_guard()` is replaced:**
  - `ended_by_user_id` is the actor, `ended_basis` is the derived basis, and `ended_at = now()`;
  - `end_reason = 'admin_ended'` is the only end a `club_admin` writes;
  - every other v34 rule stays.
- **Two deferred links** (AFTER INSERT / AFTER UPDATE of the end, `deferrable initially deferred`):
  - a start has its `activation_start` row, and an end has its `activation_end` row;
  - an end with `mapping_version_replaced` or `mapping_version_disabled` sits in the transaction that disables its
    version (the version's `disabled_at` written here).

  The failure messages are fixed texts.

### 6.3 T8

- **`source_metric_audit_row_ok()`:** `activation_start` and `activation_end` accept the basis `platform_admin` or
  `club_admin`. Every other branch is byte for byte v34's.
  - The function is called by the CHECK `source_metric_audit_action_shape`. Replacing it does not validate the
    existing rows again, and widening it leaves every existing row valid.
  - The rollback restores v34's body only while no `club_admin` activation row exists.
- **`source_metric_audit_insert_guard()`** (v34): a `club_admin` row of an activation action names its club through the
  activation's binding (team → club), not through `mapping_id`. The mapping rule stays for the mapping actions.
- **`source_metric_audit_actor_guard()`** (v35): the activation actions take the derived basis for the activation's
  binding club (`platform_admin` or `club_admin`). Every other non-mapping action keeps `platform_admin` only.
- **`source_metric_audit_revision_guard()`** (v47's body) gains the activation branch:
  - the T5 row is written in this transaction (xmin);
  - **start:** its activator is the actor, and the T8 reason equals the T5 reason;
  - **end:** its ender is the actor, and the T8 reason is not null;
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
- restores the two CHECKs;
- drops the links and the index;
- deletes the record.

It is rehearsed as v47's, with a `.gitattributes` LF line from the start.

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

## 7. The access helpers (the *Rukovodilac*'s question)

- **The four remaining copies of 7a are not needed by a T5 writer:** `isOwn`, `readableSql` / `ownSql`, `ownerFilter`
  / `writableSql` and `resolveVariableEditor`.
  - They filter canonical definitions and classification rows by `owner_scope` / `owner_club_id`, and add a coach
    view (`canonicalVariableAdminService.js` lines 269, 353–363, 735–768; `canonicalClassificationService.js` lines
    69–81).
  - T3 and T4 carry the single `owner_key`, compared with `ownerKeyOf(ctx)` (`sourceMetricMappingService.js` lines
    1240–1255).
  - **They stay where they are.** Their consolidation is a later cleanup, with no behaviour change, outside 7d.
- **What 7d-B does need** is on the binding side, which `sourceMetricAccess.js` lacks:
  - the binding's club in the caller's scope;
  - the club admin's right on that club, held FOR SHARE.

  7d-B moves `clubVisible` and `rightsStillHold(client, ctx, clubId)` out of `sourceConnectionService.js`, unexported
  today, into `sourceMetricAccess.js`, as a refactor with no behaviour change. The connection service then imports
  them; its F3c2e/f suites prove the move.
- **`mayManageActivations(ctx)`** is new in `sourceMetricAccess.js`.

---

## 8. Changes to existing code (7d-B)

- **`sourceMetricMappingService.js`:**
  - `lockVersions` locks the open T5 rows instead of counting them;
  - A1 and A2 lose `activation_open` and gain the D6 steps and A1's `activations`;
  - `DB_REFUSALS` keeps line 324's mapping for a raw writer only;
  - the T5 refusal texts and the two index names are added to `classify`.
- **`sourceRevisionLifecycleService.js`:** `lockPinned` and `pinnedDecisions` end the open T5 rows instead of refusing
  (O5); `PINNED_DISABLE_REASON` is also the T8 reason of those ends.
- **The tests:**
  - the M2 architecture test lists the T5 writers;
  - the 7b and v39 cases that expect `activation_open` change to expect the ends;
  - the "Phase 7d simulation" fixtures keep their raw T5 rows with the replica role.

---

## 9. Information hiding

- One identical 404 for every out-of-scope version, mapping, binding, activation and caller.
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
   - an archived club, and a role revoked during the call.

   Each refused case gets the identical 404 and nothing written.
3. **S1:**
   - one binding and several bindings (in ascending order);
   - the `required` / `optional` copies, the T8 rows and the keyed row last;
   - every refusal of 3.7, both unique indexes included.
4. **S2:** an end, `activation_not_open`, an end by a club admin of a platform admin's start, the reason only in T8.
5. **S3:** the filters, the pages and the scope.
6. **A1 / A2 / the pinned step:**
   - the open rows ended with the right `end_reason` and T8 rows, then the 7b transition, then A1's listed starts;
   - G1 unaffected;
   - an A1 replay made before 7d still replays.
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
   - a `mapping_version_disabled` end without its disable;
   - `ended_at` not `now()`.
9. **Concurrency:**
   - S1 against A2 on the same mapping;
   - S2 against A2 on the same row;
   - S1 against an Unbind of the binding (both orders);
   - S2 against a T6 insert holding the row (C49);
   - no `40P01`.
10. **Mutations:**
    - each scope check;
    - the derived basis;
    - each deferred link;
    - the once-index;
    - the D6 order (end before disable);
    - the pinned step's end;
    - each refusal mapping;
    - the rollback's refusals.
11. **Regression:**
    - M1, M2, v35, M2b, v39, v42, 7b, 7c and the F3c2e/f suites (the moved helpers);
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
- **R4:** the Unbind race that D accepts stays accepted. An activation on a binding that ended in the same instant
  applies to nothing.
- **R5:** an end needs a reason (1–500), written to T8 only.
- **R6:** a club admin's write locks the club's row FOR SHARE (`rightsStillHold` of the binding side), so an archive
  waits or lands first.
- **R7:** `GET /activations` pages (C68) and needs a `bindingId` or a `versionId`.

---

## 13. Not in 7d

- D3's prepared replacement in L4 (7d-C, R1).
- The preview (7e), the extractor registry (7f), ending a held instance (7g, `source_instance_end`).
- The importer (M4) and the import switch.
- The screens (phase 8).
- A team-owned connection.
