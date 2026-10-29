# J8 — phase 7b: activating, disabling and replacing a mapping version (proposed ★★ contract)

**A proposal only: no code and no migration file.** It is the contract of phase 7b of `docs/ai/metrics-core-plan.md`
(section 5, phase 7: "7b: T4 activate, disable and replacement"). It extends
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*): sections D6, D10, J1, J2 and J5, and
the open points of section K. It follows phase 4's pattern (`docs/ai/v39-revision-lifecycle-contract.md`):
- the contract goes to the *Rukovodilac* and the *Nezavisni revizor*;
- then the owner approves it as a whole and answers the numbered questions of section 9;
- only then is code written.

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-29, on the *Rukovodilac*'s order of that day (phase 7, package 2). Not accepted. |
| Verified against commit | `311d9e4` (merge of PR #264). Every file and line reference below is to that commit. |
| Decides | The owner: the contract as a whole and Q1–Q6 (section 9). The *Rukovodilac*: R1–R7 (section 10), inside the plan. |
| Migration | **v43**, proposed name `migrations_v2/202610301000_training_load_v43_source_metric_mapping_transitions.sql`. The file is not created until the owner's order names it. |

---

## 0. In short

- Two new routes in the M2 API:
  - **activate** a submitted version. When the mapping already has an active version, the same request replaces it
    (D6);
  - **disable** a version.
- Only an active platform admin may do either, in the workspace of the mapping's owner (C60).
- The database already decides almost everything:
  - v34 checks every condition of an activation and a disable, and allows only `draft → needs_review → active →
    disabled` (forward only);
  - v35 checks the acting user, the basis and the audit row at COMMIT.
- **v43 is small:** it makes the audit tell the truth about a replacement (G1, always), and, depending on the owner's
  answers, it checks the reason of a disable (G2, Q2) and lets a platform admin disable a version of an archived club
  (G3, Q1).
- **The revision lifecycle has to change in the same release.** As soon as a version can be active, the lifecycle's
  pinned step (L2, L4, L5) must disable an active pinned version too. This was decided in O5 (J5): "a field can always
  be stopped".
- **Nothing reads an active version yet.** T5 (7d) and the importer (M4) come later, so in 7b an activation changes no
  imported value.

---

## 1. What already exists (verified at `311d9e4`)

### 1.1 The database rules (v34, `migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql`)

- **A status change is the only change a version allows.** Every other column is immutable (lines 1119-1138), and a
  version is never deleted (lines 1116-1118).
- **A status fact is written once, by its own transition** (lines 1140-1153):
  - `submitted_*`, `activated_*`, and `disabled_*` with `disable_reason`;
  - `source_metric_mapping_versions_disabled_facts` makes a disable carry a reason.
- **`needs_review → active`** (lines 1168-1192):
  - the active `unit_conversions` rows of the value pair and of the bound pair are locked `FOR SHARE` first and the
    factors checked again (C52);
  - the revision must be `active` and `verified`;
  - the canonical definition must be `active`, with the version's pinned canonical version as its current one;
  - the parameter equivalence and the levels are checked again;
  - `activated_by` must be an active platform admin.
- **`draft`, `needs_review` or `active` → `disabled`** (lines 1193-1205):
  - refused while an open T5 activation names the version;
  - `disabled_by` must be an active platform admin;
  - a disable never adds a submission or an activation that did not happen.
- **Nothing leaves `disabled`**, and every other transition is refused (lines 1206-1207).
- **Two partial unique indexes** (lines 888-893):
  - one active version per mapping (D11.4);
  - within one owner, one active canonical target per source field and parameter fingerprint (C33, D11.5).
- **Decision 9** (`source_metric_guard_canonical_definition`, line 1225): while an active version pins a canonical
  definition's current version, that definition gets no new current version and no state change.
  - M3-0 and R2 answer this with `409 variable_pinned`: a new version, an archive, and a team coach's rename
    (`backend/src/canonicalVariableAdminService.js:70`, `:522`, `:878`, `:908`, `:928`).
- **The audit row's shape** (`source_metric_audit_shape_ok`, lines 1655-1661):
  - `mapping_status` covers `needs_review → active` (no reason needed) and `draft | needs_review | active →
    disabled`, which needs a reason;
  - `mapping_version_replaced` covers `needs_review → active` and needs a reason;
  - both take the basis `platform_admin` only, apart from a submission.

### 1.2 The actor guards (v35, `migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql`)

- **T4 transition** (`source_metric_mapping_versions_actor_guard`, line 145):
  - `activated_by` or `disabled_by` must be the acting user, and its basis the derived one;
  - the derived basis is `platform_admin` for an active platform admin, and for a club mapping only while that club is
    active (`source_metric_actor_basis`, line 82).
- **T8 row of a transition** (`source_metric_audit_actor_guard`, line 216):
  - the version it names was written in this transaction, by this user, with this basis;
  - its status equals the row's `to_status`;
  - there is one such row per (version, `to_status`).
- **Not checked yet** (section K, from the v35 reviews):
  - the row's `reason` against the version's `disable_reason`;
  - the row's time against the version's `*_at`;
  - whether `mapping_version_replaced` really replaced something.
- **At COMMIT** (deferred, line 311): every T4 status change needs a `mapping_status` or `mapping_version_replaced` row
  with the same from and to status.
- **Archived club:** while a club is archived no one writes a transition or an audit row of its mappings, not even a
  platform admin (J2; open question in K).

### 1.3 The services

- **M2** (`backend/src/sourceMetricMappingService.js`) writes `draft → needs_review` only (`submitVersion`, line 1221).
  - Its write machinery (`runWrite`, line 812; `insertRequestRecord`, line 938) is the pattern for 7b: bounds, the
    per-user lock, the request record, the v35 actor setting, the bounded COMMIT, and the answer read again after the
    right is checked again.
  - The version shape a read returns (`publicVersion`, line 664) carries `submittedAt` but no `activatedAt`,
    `disabledAt` or reason.
- **The revision lifecycle** (`backend/src/sourceRevisionLifecycleService.js`), the pinned step (`pinnedDecisions`,
  line 229; `disablePinned`, line 242):
  - L2, L4 and L5 disable every `needs_review` version pinned to the retired revision, with the fixed reason "Source
    revision retired.";
  - they **refuse** an `active` pinned version (`409 version_active`) and an open activation (`409 activation_open`),
    because "neither can exist before phase 7" (J5, O4, O5).

### 1.4 The decided model this contract implements

- **D6, version replacement:** activating N+1 is one bounded transaction:
  - end every open T5 activation of N;
  - disable N;
  - activate N+1;
  - new T5 rows only for the bindings listed explicitly.

  Disabling without a replacement is the same sequence without the last two steps.
- **D10 / C48:** the audit actions and their shapes, as in 1.1.
- **O5 (C100, J5):** "When phase 7 makes an `active` version or an open activation possible, it extends the pinned
  step of L2 and L5 in the same release (end the activations, disable the versions, retire, in one transaction), so
  that a field can always be stopped." O4 adds: "Phase 7 extends L4 to D3's prepared replacement."
- **C59:** T4 activate, disable and replacement were left out of the first M2 PR on purpose.
- **C76:** every future writer of T2a, T2b, `unit_conversions` or T5 gets its own database actor guard. T4's
  transitions are already covered by v35 (C76 names `activated_by` and `disabled_by`), so 7b needs no actor guard of
  its own.

---

## 2. Routes (HTTP contract)

Both routes are mounted in `backend/src/routes/sourceMetrics.js` with M2's conventions (J1):
- `requireAuth`;
- `Cache-Control: no-store` on every answer;
- `415 jsonRequired`;
- `400 invalid_body` for an unknown key or a missing one;
- the identical `404 {"error":"notFound"}` for every caller and resource that may not be written (section 6).

| # | Route | Who / workspace | Body | Server-derived | Success |
|---|---|---|---|---|---|
| A1 | `POST /mappings/:mappingId/versions/:versionId/activate` | an active platform admin, in the workspace of the mapping's owner (platform workspace for a system mapping; club X's workspace for a club X mapping) | `requestKey` (uuid); `expectedActiveVersionId` (the mapping's active version the caller saw, or `null`); `reason` (1–500, C41/C53; required when `expectedActiveVersionId` is not null, refused otherwise) | `activated_by` / `_at` / `_basis`; for a replacement N's `disabled_by` / `_at` / `_basis` and `disable_reason` = the request's `reason`; T8 rows; `operation_id` | `200 {version, replaced: <id> or null, replayed: false}`; replay or verified COMMIT `200` |
| A2 | `POST /mappings/:mappingId/versions/:versionId/disable` | as A1 | `requestKey`; `expectedStatus` (`draft`, `needs_review` or `active`: the status the caller saw); `reason` (1–500, required) | `disabled_by` / `_at` / `_basis`, `disable_reason`; T8 row | `200 {version, replayed: false}`; replay or verified COMMIT `200` |

**Refusals, in the order they are decided** (the order of J1 and J5.2: the path, the body, the request record, the
locks, the right again, then the states):

| Code | When |
|---|---|
| `404 notFound` | the path is not a uuid; the version is not of this mapping; the mapping's owner is not the workspace's; the caller is not an active platform admin (a club admin, a team coach, anyone else); the right is lost during the write |
| `400 invalid_body` | an unknown key, a missing key, `reason` not a bounded single-line text (C41, C53), `reason` on A1 without a replacement, `expectedStatus` outside the three values |
| `409 request_key_reused` | the key was used with another body (C65) |
| `409 version_not_submitted` (+`current.status`) | A1 on a version that is not `needs_review` |
| `409 active_version_changed` (+`current.activeVersionId`, null when none) | A1: the mapping's active version is not `expectedActiveVersionId` |
| `409 version_status_changed` (+`current.status`) | A2: the version's status is not `expectedStatus` (also when it is already `disabled`) |
| `409 revision_not_verified` | A1: the pinned revision is not `active` and `verified` (a retired revision included) |
| `409 canonical_version_changed` | A1: the canonical definition is not `active`, or its current version is no longer the pinned one; a new mapping version is needed |
| `409 conversion_unavailable` / `bound_conversion_unavailable` | A1: the unit conversion of the value or bound pair was retired, or its factors changed (C52) |
| `409 level_not_allowed` | A1: a level the version covers was removed from the canonical definition |
| `409 parameters_not_equivalent` | A1: the parameter equivalence fails again |
| `409 source_metric_target_taken` | A1: another mapping of the same owner holds an active version of the same source field and parameters (D6, C33); names only the owner scope of this mapping |
| `409 activation_open` | an open T5 activation names the version (A2, or N in A1). It cannot exist before 7d; refused fail-closed (R4) |
| `409 try_again` | `55P03`, `40P01`, `57014`, a busy pool, the `23505` of a race the locks did not see |
| `503 outcome_unknown` | the COMMIT's answer was lost and the request key could not be verified (C65, C79) |
| `500 internal_error` | anything else; a v35 or v43 guard reached through the service is a programming error (C79) |

**Answers:**
- The `version` shape of J1 row 5, with `activatedAt` and `disabledAt` added (R2). It never carries the reason or an
  acting user (C63).
- `replaced` names N on a replacement; N is a version of the same mapping, which the caller may read.
- The answer after a COMMIT follows C69: the right is checked again first; then the version is read; otherwise
  `readError`.

---

## 3. Transitions

| Operation | From → to | Audit rows (one `operation_id`) | Keyed row (request record) |
|---|---|---|---|
| A1 activation | N+1 `needs_review → active` | `mapping_status` `needs_review → active`, no reason | that row |
| A1 replacement | N `active → disabled`, then N+1 `needs_review → active` | `mapping_status` N `active → disabled` (reason), then `mapping_version_replaced` N+1 `needs_review → active` (the same reason) | `mapping_version_replaced` |
| A2 disable | `draft`, `needs_review` or `active` → `disabled` | `mapping_status` with the reason | that row |
| Pinned step (L2, L4, L5) | every pinned `needs_review` **or `active`** version → `disabled` | `mapping_status` per version, the fixed reason "Source revision retired." | the lifecycle's own row (unchanged) |

- **A replacement is one transaction, in this order:**
  1. disable N, so the one-active-per-mapping index allows the next step;
  2. activate N+1;
  3. write N's audit row, then N+1's keyed row last.

  If any step fails, everything rolls back. N stays active, and N+1 stays `needs_review`.
- **A replacement is explicit** (Q3):
  - the caller names the active version it replaces (`expectedActiveVersionId`);
  - activating with `expectedActiveVersionId: null` while a version is active is `active_version_changed`, never an
    automatic replacement of a version the caller did not see.
- **T5:**
  - D6's T5 steps (end N's open activations; start new ones for listed bindings) are not in 7b. T5 has no writer
    before 7d and needs its own actor guard (C76).
  - 7b refuses while an open activation exists (R4). 7d replaces that refusal with D6's steps: `end_reason`
    `mapping_version_replaced` or `mapping_version_disabled`.
- **The pinned step (O5):**
  - L2 and L5 disable a pinned `active` version as they disable a pinned `needs_review` one, in the same transaction,
    before the retirement;
  - L4 does the same (Q5): D3's prepared replacement waits for 7d;
  - `club_archived` (O7(ii)(a)) covers an active club version too, unless Q1 is answered (b);
  - `activation_open` stays a refusal until 7d;
  - `version_active` is no longer answered.
- **Decision 9 stays as it is.** An active version keeps its canonical variable from getting a new version or being
  archived (`variable_pinned`) until the mapping version is disabled. That is the explicit order of D6: disable → new
  canonical version → new mapping version → activate.

---

## 4. Lock order

A1 and A2 follow M2's order (J1, C57), each step bounded (`statement_timeout` 10 s, `lock_timeout` 2 s on rows):

1. The per-user advisory lock (5 s), then the request record lookup. A replay stops here and writes nothing.
2. A1 only: the active `unit_conversions` rows of the version's value pair, then of its bound pair, `FOR SHARE`, in
   ascending id (C52; the trigger takes them again in the same order).
3. T2a and T2b of the version `FOR SHARE`.
4. T3 (the mapping) `FOR NO KEY UPDATE`. It serializes every transition of one mapping: two activations, an
   activation and a disable, a replacement and a submission. A version create already holds the same lock.
5. T4: the target version and, for A1, the mapping's active version, `FOR UPDATE`, in ascending id. Then the
   preconditions are compared again under the locks.
6. T5: the open activations of those versions are counted, not locked (there is no T5 writer before 7d; 7d defines
   their lock).
7. A1 only: `metric_definitions` `FOR SHARE` (its state and current version again), then its scope capability rows
   `FOR SHARE` (the levels again).
8. The acting user's role and user rows, and for a club mapping the club row, `FOR SHARE` (`rightsStillHold`, the v35
   order).
9. The writes: the status changes, then the T8 rows (the keyed one last), then the bounded COMMIT (C79).

The pinned step keeps J5.2's order: T2a → the field's revisions `FOR UPDATE` → the pinned T3 `FOR SHARE` → the pinned
T4 `FOR UPDATE` → the acting user's rows → the pinned clubs.
- **A1 against L2, L4 or L5 on the same revision:**
  - the lifecycle takes the field's revisions `FOR UPDATE` first;
  - A1 takes the revision `FOR SHARE` before its mapping;
  - so whichever starts first holds the revision, and the other waits under the 2 s bound or answers `try_again`.
- **No deadlock between the two orders.** The lifecycle locks T2b → T3 → T4, the same direction as A1.
- Tested in both orders (section 8).

---

## 5. Idempotency, replay and the COMMIT

- **A request record per operation:** the keyed T8 row (D10).
  - The request hash covers the route, the mapping, the version, the target status, `expectedActiveVersionId` or
    `expectedStatus`, and the reason (R7).
  - The same user, key and hash replays the current state (C65): the right is checked again, the version is read
    again, `200 replayed: true`.
  - Another body with that key is `409 request_key_reused`. A refusal is no request record.
- **The COMMIT** (C79):
  - awaited a bounded time;
  - a definite PostgreSQL refusal means nothing was written;
  - any other COMMIT error is verified on a second connection by the request key: `200` with `commitConfirmation:
    "verified_after_commit_error"`, or `503 outcome_unknown`.
- **The v35 actor setting** is set right before the first protected write, as in M2 (C75). A replay sets none.

---

## 6. Information hiding

- The identical `404` for:
  - a path that is not a uuid, or names a version of another mapping;
  - a mapping of another owner than the workspace's;
  - a caller who is not an active platform admin;
  - a right lost during the write.
- A club admin can read its club's versions (J1 rows 4–5) but cannot activate or disable them (D6). The routes answer
  the same `404`, so they reveal nothing beyond the reads (R3). The Mappings screen (phase 8) offers the actions only
  to a platform admin.
- No refusal names another owner's mapping, version or club:
  - `source_metric_target_taken` names only the owner scope of the caller's own mapping (D6);
  - `current.activeVersionId` is a version of the caller's own mapping;
  - the pinned step's `club_archived` keeps O7(ii)(a)'s rule: club ids, to an active platform admin only.

---

## 7. Migration v43 (specification; the file waits for the owner's order)

**What it changes:** functions and triggers only: no table, column, index or data. v34's and v35's functions are not
changed, except `source_metric_actor_basis` if Q1 is answered (b). v43 adds a deferred check on T8 (G1) and, if Q2
is answered "the database", a BEFORE INSERT guard on T8 that runs after v35's (trigger order is by name).

| Guard | Rule | Refusal | When |
|---|---|---|---|
| **G1, a replacement's label is true** | A `mapping_version_replaced` row is accepted only when its operation (the same `operation_id`, written in this transaction) holds a `mapping_status` row `active → disabled` of another version of the same mapping, by the same user, whose version this transaction disabled. A `mapping_status` row `needs_review → active` is accepted only when its operation disabled no active version of that mapping. Checked at COMMIT (deferred), so the order of the two rows does not matter. | `23514` (fixed text) | always (R6) |
| **G2, the reason and the time agree** | A `mapping_status` row `→ disabled` carries exactly the version's `disable_reason`. A `mapping_version_replaced` row carries the same reason as the disabled version's row. A transition's audit row carries the transaction's own time (`performed_at = now()`, its default; T8 rows are written after the transition), and the transition's `*_at` (`clock_timestamp()`) is not earlier than it. v35 already proves that both are in this transaction. | `23514` | if Q2 is answered "the database" |
| **G3, an archived club** | For a club mapping whose club is archived, an active platform admin may write `→ disabled` (and its `mapping_status` row) only. Every other transition stays refused. This is a narrow change of `source_metric_actor_basis` for that one transition, so v35's basis check passes. | — | if Q1 is answered (b) |

- **What v43 does not change:**
  - v34's forward-only status machine: "a future back to draft needs a new rule" (K);
  - v34's checks of an activation;
  - the one-row-per-(version, `to_status`) rule of v35;
  - the actor setting.
- **Failure codes:** fixed messages without an id, name or value (C79). Through the service they are a sanitized
  `500`. None is reachable when the service works as specified; the tests reach them by direct SQL.
- **Rollback** (`docs/runbooks/source-metric-mapping-transitions-v43-rollback.sql`):
  - It restores v42's catalog exactly: it drops v43's functions and triggers and, if G3 was built, restores v35's body
    of `source_metric_actor_basis`, with no data change. v43 only adds checks (G3 aside, which only allows), and no rule
    re-checks a row already written, so the rollback refuses nothing because of data.
  - It refuses, changing nothing:
    - while a later migration is recorded;
    - while v43 is not recorded;
    - while the migrator holds its advisory lock 822026 (taken without waiting, as v42's rollback does).
  - It takes its table locks before its checks, and is rehearsed: apply → rollback → identical v42 catalog with
    `obj_description` → re-apply.
- **Read-only preflight** (`docs/runbooks/source-metric-mapping-transitions-v43-preflight.sql`, run by the owner block
  by block, the same day as the merge):
  1. the PostgreSQL version;
  2. v42 is the last migration with the repository's checksum, and v43 is absent;
  3. no v43 function or trigger exists;
  4. the T3 / T4 / T8 mapping row counts and T4's status counts, recorded for the post-check (expected 0 in
     production: no revision has a proven unit, so no version exists);
  5. every trigger of T3, T4 and T8 is enabled;
  6. no actor default exists;
  7. a quiet moment: no lock on T3 / T4 / T8 and no M2 session.
- **Read-only post-check** (`…-v43-postcheck.sql`):
  1. v43 recorded once with its checksum, and it is the last migration;
  2. each v43 function body (md5) and its `v43 …` comment;
  3. the triggers enabled;
  4. the counts of preflight block 4, unchanged;
  5. no actor default;
  6. no lock.
- **Runbook** `docs/runbooks/source-metric-mapping-transitions-v43.md`: the order (preflight → merge → deploy → smoke →
  post-check), what to do when a block differs, and the rollback.

If the owner answers Q2 "the route" and Q1 (a), v43 holds G1 only. Without G1 (if the *Rukovodilac* decides R6
otherwise), 7b would need no migration.

---

## 8. Tests and mutations

A new suite, `backend/tests/source-metric-mapping-transitions-7b.test.mjs`: disposable databases, the real HTTP stack,
through the T1 runner, on PostgreSQL 16 and, where possible, 17.
- **Routes:**
  - A1 plain activation, A1 replacement, and A2 from each of the three statuses;
  - every refusal of section 2;
  - a replay, `request_key_reused`, and a refusal that writes no request record.
- **Information hiding:**
  - a club admin, a team coach, another club, a team workspace, an archived club, a revoked role and an inactive user;
  - a foreign mapping id, and a version of another mapping;
  - each answers the identical `404`.
- **Database rules reached through the routes:**
  - the per-owner target uniqueness (`source_metric_target_taken`), with a system mapping and a club mapping of the
    same pair both allowed (C33);
  - decision 9: an active version blocks `variable_pinned`, and a disable releases it.
- **Concurrency, in both orders:**
  - two activations of two versions of one mapping;
  - an activation against a disable;
  - an activation against a canonical new version (M3-0) and an archive (R2);
  - an activation against a conversion retirement, by direct SQL until 7c;
  - an activation against L2, L4 and L5 on the same revision.
- **The pinned step:**
  - L2, L4 and L5 disable an active pinned version (system and club);
  - `club_archived` for an active club version;
  - `activation_open` stays refused;
  - the answers' counts.
- **The COMMIT:** a lost answer verified, `outcome_unknown`, and a right lost during the write.
- **v43:**
  - each guard refused by direct SQL with its fixed text (G1 in both directions; G2 and G3 as answered);
  - the rollback rehearsal;
  - the preflight and the post-check run block by block on a disposable database.
- **Existing suites:**
  - M2, v35, M3-0, M2b, R2 and v39 keep passing;
  - the v39 suite's `version_active` expectations change to the new pinned step (the only intended change);
  - the M2 architecture test names the new writers.
- **Mutations, each killed by a test:**
  - the platform-admin-only check;
  - the owner-workspace check;
  - `expectedActiveVersionId`, `expectedStatus` and the reason rules;
  - the replacement order (disable before activate);
  - the keyed row last;
  - the open-activation refusal;
  - the right checked again;
  - the pinned step's active disable;
  - `club_archived` for an active version;
  - each v43 branch;
  - the rollback's refusals.

**Reviewers:** `db-reviewer` (v43, the lock order, the transactions), `security-reviewer` (the 404s, the
platform-admin-only rule, G3), `code-reviewer`, then the *Rukovodilac* and the *Nezavisni revizor* (triggers 1, 2 and
4).

---

## 9. Questions for the owner (red zone)

Each question has one recommendation and its consequence.

- **Q1. A platform admin's disable of an archived club's version** (K, J2).
  - *Recommended (a):* no change. While a club is archived no one writes its mappings (v35). A stuck version is
    disabled by restoring the club, disabling it and archiving the club again. The pinned step answers `club_archived`
    as today (O7(ii)(a)).
  - *Consequence:* v43 has no G3. Before 7d and M4 an active version of an archived club changes no data, because
    nothing reads it. What an archived club's activations mean for an import is 7d's contract.
  - *Alternative (b):* G3, a narrow exception for `→ disabled` only.
- **Q2. The audit row's reason and time against the version's columns** (K, from the v35 reviews).
  - *Recommended:* the database checks them (G2 in v43). A direct SQL write cannot record one reason on the version
    and another in the audit.
  - *Consequence:* v43 carries G2, with one more mutation and its test.
  - *Alternative:* the route writes both from one value, and nothing in the database compares them.
- **Q3. Replacing the active version.** D6 already decides that activating N+1 disables N in the same transaction.
  - *Recommended:* confirm D6, with the caller naming the version it replaces (`expectedActiveVersionId`) and a
    required reason. There is no separate replace route, and no replacement of a version the caller did not see.
  - *Consequence:* a stale screen cannot replace a version another admin activated meanwhile
    (`active_version_changed`).
- **Q4. System or club ownership of zone and threshold mappings** (K).
  - *Not needed for 7b.* It decides whether one team's bounds are visible through a system mapping's activations and
    the preview, which is 7d and 7e. Recommended: leave it to 7d.
- **Q5. L4 when a version pinned to R is active.**
  - *Recommended:* in 7b, L4 disables it like L2 and L5 (the pinned step, the fixed reason). D3's prepared replacement
    (versions on R+1 activated in the same transaction, T5 moved) comes with 7d, when T5 exists.
  - *Consequence:* after L4 the mapping has no active version until an admin activates a version on R+1. Before 7d and
    M4 nothing reads it, so no data changes.
  - *Alternative:* L4 refuses while an active version is pinned (`version_active`). The field would then be replaced
    only after its versions are disabled by hand.
- **Q6. Separation of duties.** One platform admin can today:
  - create a version (or a club admin can);
  - submit it;
  - confirm the revision's proof (M2b);
  - activate the version.

  The columns are separate, so a rule such as "the activator is not the submitter" is cheap to add.
  - *Recommended:* no rule in 7b, as O8 decided for revisions. With one platform admin the rule would stop the work,
    and every act stays attributed.
  - *Alternative:* the activator is not the submitter (a service rule and a G4 in v43).

**Not a question for 7b:** the pinned step's missing cap on the number of versions (J5, known limit) stays an owner
decision before M6, as recorded. 7b adds at most one active version per mapping to it.

---

## 10. Inside the plan (the *Rukovodilac* decides)

- **R1:** the route names and bodies of section 2. Activation and replacement are one route (D6), and disable is a
  second one.
- **R2:** `activatedAt` and `disabledAt` are added to the version shape. The disable reason stays out of every answer
  (C63 unchanged; it is readable in the database).
- **R3:** a club admin gets the identical `404` from A1 and A2 (J1's convention for "may not write").
- **R4:** `activation_open` is a fail-closed refusal in 7b, replaced by D6's T5 steps in 7d.
- **R5:** the code names of section 2. New ones: `version_not_submitted`, `active_version_changed`,
  `version_status_changed`, `revision_not_verified`, `canonical_version_changed`, `source_metric_target_taken`.
- **R6:** G1 is always in v43. It is the audit's own truth, independent of Q1 and Q2.
- **R7:** what the request hash covers (section 5).

---

## 11. Not in 7b

- T5 activations and their actor guard (7d), D6's T5 steps, and D3's prepared replacement in L4 (7d).
- `unit_conversions` maintenance (7c), the aggregate preview (7e), the extractor registry (7f), and ending a held
  instance (7g).
- The Mappings screen (phase 8). No frontend changes in 7b.
- The importer (M4). The first real production confirmation of a field (C97, M6).
- Any write to a persistent database by the executor.
