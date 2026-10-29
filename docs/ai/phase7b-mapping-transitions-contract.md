# J8 — phase 7b: activating, disabling and replacing a mapping version (accepted ★★ contract, C104)

**Accepted on 2026-10-29 (C104 of the discovery document): the owner accepted the contract as a whole and answered
Q1, Q2, Q3, Q5, Q6 and Q7 as recommended. Not implemented yet: no code, and no migration file.** It is the contract of
phase 7b of `docs/ai/metrics-core-plan.md`
(section 5, phase 7: "7b: T4 activate, disable and replacement"). It extends
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*): sections D6, D10, J1, J2 and J5, and
the open points of section K. It follows phase 4's pattern (`docs/ai/v39-revision-lifecycle-contract.md`):
- the contract goes to the *Rukovodilac* and the *Nezavisni revizor*;
- then the owner approves it as a whole and answers the numbered questions of section 9;
- only then is code written.

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-29, on the *Rukovodilac*'s order of that day (phase 7, package 2). Revised the same day after the internal reviews of `484553c` (section 12). Merged as a proposal (PR #266, `69d824f`) after the GO of the *Rukovodilac* and the *Nezavisni revizor* on `f9f6bec`. **Accepted on 2026-10-29 (C104).** This revision adds the decisions and the external reviewers' LOW notes (section 12). |
| Verified against commit | `311d9e4` (merge of PR #264). Every file and line reference below is to that commit. |
| Decides | The owner: the contract as a whole and Q1, Q2, Q3, Q5, Q6, Q7 (section 9), decided (C104). The *Rukovodilac*: R1–R8 (section 10), inside the plan, accepted as written. |
| Accepted | 2026-10-29 (C104). The owner's words: „A1 DA, I SVE PO PREPORUKAMA” (owner turn `f505ec21`, 2026-10-29 13:32:57 UTC, in the *Rukovodilac*'s chat; the executor checked it in the transcript). The *Rukovodilac* reads „sve po preporukama” as the acceptance of the contract as a whole and of every question as recommended, as C103 did for J7; that reading is the *Rukovodilac*'s, not the owner's own words. |
| Migration | **v43**, name `migrations_v2/202610301000_training_load_v43_source_metric_mapping_transitions.sql` (no other file carries the label v43 at `311d9e4`). The file is written in the implementation pull request; its merge needs the owner's order naming the pull request, the exact file name and its sha256, with the preflight the same day. |

---

## 0. In short

- Two new routes in the M2 API:
  - **activate** a submitted version. When the request names the mapping's active version, the same transaction
    replaces it (D6);
  - **disable** a version.
- Only an active platform admin may do either, in the workspace of the mapping's owner (C60).
- The database already decides almost everything:
  - v34 checks every condition of an activation and a disable, and allows only `draft → needs_review → active →
    disabled` (forward only);
  - v35 checks the acting user, the basis and the audit row at COMMIT.
- **v43 is small.**
  - It always makes the audit tell the truth about a replacement (G1).
  - It also checks a transition's audit row against the version's own reason and time (G2; the owner's Q2, C104).
  - A third guard (G3, a platform admin's disable of an archived club's version) was option (b) of Q1 and was not
    chosen (C104).
- **The revision lifecycle changes in the same release.** As soon as a version can be active, the pinned step of L2,
  L4 and L5 must disable an active pinned version too (O5 of J5: "a field can always be stopped"). For a club's active
  version this widens O7(i); the owner decided it as Q7 (C104).
- **Nothing reads an active version yet.** T5 (7d) and the importer (M4) come later, so in 7b an activation changes no
  imported value.

---

## 1. What already exists (verified at `311d9e4`)

### 1.1 The database rules (v34, `migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql`)

- **A status change is the only change a version allows.** Every other column is immutable (lines 1119-1138), and a
  version is never deleted (lines 1116-1118).
- **A status fact is written once, by its own transition** (lines 1140-1153):
  - `submitted_*`, `activated_*`, and `disabled_*` with `disable_reason`;
  - `source_metric_mapping_versions_disabled_facts` makes a disable carry a reason;
  - v34 does not bound a fact's time: a writer chooses `*_at`.
- **`needs_review → active`** (lines 1168-1192):
  - the active `unit_conversions` rows of both pairs are locked first by `source_metric_lock_conversions`
    (lines 952-959): one statement over the value pair and the bound pair, `order by id for share`, and the factors are
    checked again (C52);
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
  - `source_metric_mapping_versions_one_active_per_mapping`;
  - `source_metric_mapping_versions_one_active_target_per_owner`: within one owner, one active canonical target per
    source field and parameter fingerprint (C33, D11.5).
- **Decision 9** (`source_metric_guard_canonical_definition`, line 1225): while an active version pins a canonical
  definition's current version, that definition gets no new current version and no state change.
  - M3-0 and R2 answer `409 variable_pinned` for a new version, an archive, a restore and a team coach's rename
    (`backend/src/canonicalVariableAdminService.js`: the guard's text `PIN_GUARD` at line 70; the refusals at lines
    522, 878, 908 and 928).
- **The audit row's shape** (`source_metric_audit_row_ok`, line 1633, checked by the constraint
  `source_metric_audit_action_shape`, line 1720; its branches at lines 1655-1661):
  - `mapping_status` covers `needs_review → active` (no reason needed) and `draft | needs_review | active →
    disabled`, which needs a reason;
  - `mapping_version_replaced` covers `needs_review → active` and needs a reason;
  - both take the basis `platform_admin` only, apart from a submission.
- **The audit row's time:** `performed_at` defaults to `now()`, the transaction's start (line 1707). A transition's
  `*_at` is written with `clock_timestamp()` by the services.

### 1.2 The actor guards (v35, `migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql`)

- **The derived basis** (`source_metric_actor_basis(p_actor, p_owner_club)`, line 82):
  - `platform_admin` for an active platform admin, and for a club mapping only while that club is active;
  - it has no transition input, and it is shared by every guard of the chain: T3 (line 131), T4 (line 162) and T8
    (line 240) here, and by v36, v37, v39, v41 and v42.
- **T4 transition** (`source_metric_mapping_versions_actor_guard`, line 145): `activated_by` or `disabled_by` must be
  the acting user, and its basis the derived one.
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
- **Archived club:** while a club is archived, no one writes anything of its mappings, not even a platform admin
  (J2). The service refuses it first: `resolveMappingAdmin` gives an archived club's workspace no context
  (`backend/src/sourceMetricMappingService.js:215-219`), and `rightsStillHold` refuses an archived club
  (lines 254-257).
- **No route restores a club.** `public.clubs.is_active` is set to `false` by `DELETE /clubs/:id`
  (`backend/src/routes/organization.js:1045`) and to `true` only at creation (line 1011). The lifecycle's own
  `club_archived` sentence ("restore the club, then repeat this request", `backend/src/sourceRevisionLifecycleService.js:83`)
  therefore points to a direct database write.

### 1.3 The services

- **M2** (`backend/src/sourceMetricMappingService.js`) writes `draft → needs_review` only (`submitVersion`, line 1221).
  - Its write machinery is the pattern for 7b: `runWrite` (line 812) for the bounds, the per-user lock, the request
    record, the v35 actor setting, the bounded COMMIT and the answer read again after the right is checked again.
  - Two small extensions are needed for 7b (R7):
    - `insertRequestRecord` (line 938) writes no `reason`, and a disable and a replacement need one (v34 line 1659
      and line 1661);
    - the request lookup `MAPPING_REQUESTS.find` (line 806) returns no `operation_id`, which the replay of a
      replacement needs to name the version it replaced. The lifecycle's `operationAnswer` (`backend/src/sourceRevisionLifecycleService.js:125`)
      reads an operation's rows this way.
  - `publicVersion` (line 662) carries `submittedAt`, but no `activatedAt`, `disabledAt` or reason.
- **The routes** (`backend/src/routes/sourceMetrics.js`): the lifecycle routes answer a caller without the right with
  the identical 404 **before the body is looked at**, then `415`, then a body shape `400` (lines 293-330). 7b keeps this
  order.
- **The revision lifecycle** (`backend/src/sourceRevisionLifecycleService.js`), the pinned step:
  - `pinnedDecisions` (line 229) refuses an `active` pinned version (`409 version_active`) and an open activation
    (`409 activation_open`), because "neither can exist before phase 7" (J5, O4, O5);
  - `disablePinned` (line 242) disables `needs_review` versions only, with the fixed reason "Source revision
    retired.";
  - `disabledAuditRows` (line 251) writes their `mapping_status` rows with `from_status` fixed to `needs_review`.

### 1.4 The decided model this contract implements

- **D6, version replacement:** activating N+1 is one bounded transaction:
  - end every open T5 activation of N;
  - disable N;
  - activate N+1;
  - new T5 rows only for the bindings listed explicitly.

  Disabling without a replacement is the same sequence without the last two steps.
- **D10 / C48:** the audit actions and their shapes, as in 1.1.
- **O4, O5 and O7 of J5** (accepted with C100):
  - O5: "When phase 7 makes an `active` version or an open activation possible, it extends the pinned step of L2 and
    L5 in the same release (end the activations, disable the versions, retire, in one transaction), so that a field can
    always be stopped."
  - O4: "Phase 7 extends L4 to D3's prepared replacement."
  - O7(i): the automatic disable of club-owned versions from the platform workspace was accepted for
    "only `needs_review` → `disabled`", with answers that carry counts only. Its alternative was the platform admin
    disabling a club's version in that club's workspace through a T4 disable route, which A2 now is.
  - O7(ii)(a): a pinned version of an archived club answers `409 club_archived` until the club is restored.
  - O7(iii): the club's admins are not told.
- **C59:** T4 activate, disable and replacement were left out of the first M2 PR on purpose.
- **C76:** every future writer of T2a, T2b, `unit_conversions` or T5 gets its own database actor guard. T4's
  transitions are already covered by v35 (C76 names `activated_by` and `disabled_by`), so 7b needs no actor guard of
  its own.

---

## 2. Routes (HTTP contract)

Both routes are mounted in `backend/src/routes/sourceMetrics.js` with M2's conventions (J1): `requireAuth`, and
`Cache-Control: no-store` on every answer.

| # | Route | Who / workspace | Body | Server-derived | Success |
|---|---|---|---|---|---|
| A1 | `POST /mappings/:mappingId/versions/:versionId/activate` | an active platform admin, in the workspace of the mapping's owner (platform workspace for a system mapping; club X's workspace for a club X mapping) | `requestKey` (uuid); `expectedActiveVersionId` (the mapping's active version the caller saw, or `null`); `reason` (1–500, C41/C53; required when `expectedActiveVersionId` is not null, refused otherwise) | `activated_by` / `_at` / `_basis`; for a replacement N's `disabled_by` / `_at` / `_basis` and `disable_reason` = the request's `reason`; T8 rows; `operation_id` | `200 {version, replaced: <id> or null, replayed: false}`; replay or verified COMMIT `200` |
| A2 | `POST /mappings/:mappingId/versions/:versionId/disable` | as A1 | `requestKey`; `expectedStatus` (`draft`, `needs_review` or `active`: the status the caller saw); `reason` (1–500, required) | `disabled_by` / `_at` / `_basis`, `disable_reason`; T8 row | `200 {version, replayed: false}`; replay or verified COMMIT `200` |

**The order of the answers** (R3; the lifecycle routes' order):
1. no session: the router's `401`;
2. no admin context for the active workspace, or a caller who is not an active platform admin (a club admin, a team
   coach, anyone else): the identical `404 {"error":"notFound"}`, **before the body is looked at**. The gate is a new
   helper (for example `mayTransitionMappings(ctx)`: basis `platform_admin`, in the platform or a club workspace), not
   the lifecycle's `mayChangeRevisions`, which admits the platform workspace only (O1);
3. a request without a JSON body: `415 jsonRequired`; a body that is not an object: `400 invalid_body`;
4. a path id that is not a uuid: the identical `404`; then the body's shape: `400 invalid_body`;
5. the request record (`409 request_key_reused`, or a replay);
6. the locks, the version and its mapping (a version of another mapping, or a mapping of another owner than the
   workspace's: the identical `404`);
7. the states below are compared under the locks, but a state refusal is answered only after the right is confirmed
   again (lost: the identical `404`), so a caller whose right was revoked meanwhile never sees `current`. This differs
   on purpose from `submitVersion` (`sourceMetricMappingService.js:1250-1252`), which answers its state refusal first.

| Code | When |
|---|---|
| `400 invalid_body` | an unknown key, a missing key, `reason` not a bounded single-line text (C41, C53), `reason` on A1 without a replacement, `expectedStatus` outside the three values |
| `409 request_key_reused` | the key was used with another body (C65) |
| `409 version_not_submitted` (+`current.status`) | A1 on a version that is not `needs_review` |
| `409 active_version_changed` (+`current.activeVersionId`, null when none) | A1: the mapping's active version is not `expectedActiveVersionId` |
| `409 version_status_changed` (+`current.status`) | A2: the version's status is not `expectedStatus` (also when it is already `disabled`) |
| `409 revision_not_verified` | A1: the pinned revision is not `active` and `verified` (a retired revision included) |
| `409 target_not_active` | A1: the canonical definition is not `active` (J1's code for the same state) |
| `409 canonical_version_changed` | A1: the definition is active, but its current version is no longer the pinned one; a new mapping version is needed |
| `409 conversion_unavailable` / `bound_conversion_unavailable` | A1: the unit conversion of the value or bound pair was retired, or its factors changed (C52) |
| `409 level_not_allowed` | A1: a level the version covers was removed from the canonical definition |
| `409 parameters_not_equivalent` | A1: the parameter equivalence fails again |
| `409 source_metric_target_taken` | A1: another mapping of the same owner holds an active version of the same source field and parameters (D6, C33). It names only the owner scope of this mapping |
| `409 activation_open` | an open T5 activation names the version (A2, or N in A1). It cannot exist before 7d; refused fail-closed (R4) |
| `409 try_again` | `55P03`, `40P01`, `57014`, a busy pool |
| `503 outcome_unknown` | the COMMIT's answer was lost and the request key could not be verified (C65, C79) |
| `500 internal_error` | anything else; a v35 or v43 guard reached through the service is a programming error (C79), a definite COMMIT refusal included |

**The database allowlist** (C66, C72: by exact constraint name or exact message, never by prefix):
- `23505` `source_metric_mapping_versions_one_active_target_per_owner` → `source_metric_target_taken`. Two mappings of
  one owner lock different T3 rows, so the index decides between two concurrent activations of the same field and
  parameters: the second waits for the first's transaction (its `transactionid` lock, not a row), and answers
  `try_again` if its lock bound ends first, or `source_metric_target_taken` after the first commits.
- `23505` `source_metric_mapping_versions_one_active_per_mapping` → `active_version_changed`. It cannot race behind
  the T3 lock; it is mapped as a backstop. Its `current.activeVersionId` is read by a bounded read after the rollback,
  as `createMapping` reads the existing mapping for `mapping_exists` (`sourceMetricMappingService.js:993-999`).
- `23514` with exactly one of v34's transition texts → one code each:
  - "the source revision must be active and verified" (line 1176) → `revision_not_verified`;
  - "the canonical definition must be active with the pinned version current" (line 1181) → `canonical_version_changed`.
    The one text covers both states; the service's own checks under the locks keep `target_not_active` and
    `canonical_version_changed` apart, so the trigger is only the backstop;
  - "a mapping version with an open activation is not disabled" (line 1202) → `activation_open`;
  - the conversion, parameter and level texts of v34's shared check functions → the codes the version create already
    maps them to (J1 row 7).
- Every other database error is the sanitized `500`.

**Answers:**
- The `version` shape of J1 row 5, with `activatedAt` and `disabledAt` added (R2). It never carries the reason or an
  acting user (C63).
- `replaced` names N on a replacement; N is a version of the same mapping, which the caller may read.
- **For phase 8 (the Mappings screen):** A1 refuses a `reason` without a replacement (`400 invalid_body`). The screen
  asks for a reason only when the mapping has an active version, which the activation then replaces (the
  *Rukovodilac*'s L3).
- The answer after a COMMIT follows C69: the right is checked again first; then the version is read through the
  owner-filtered `writableVersion` (`sourceMetricMappingService.js:757`); otherwise `readError`.

---

## 3. Transitions

| Operation | From → to | Audit rows (one `operation_id`) | Keyed row (request record) |
|---|---|---|---|
| A1 activation | N+1 `needs_review → active` | `mapping_status` `needs_review → active`, no reason | that row |
| A1 replacement | N `active → disabled`, then N+1 `needs_review → active` | `mapping_status` N `active → disabled` (reason), then `mapping_version_replaced` N+1 `needs_review → active` (the same reason) | `mapping_version_replaced` |
| A2 disable | `draft`, `needs_review` or `active` → `disabled` | `mapping_status` with the reason | that row |
| Pinned step (L2, L4, L5) | every pinned `needs_review` version and, by Q5 and Q7, every pinned **`active`** one → `disabled` | `mapping_status` per version with its real `from_status`, the fixed reason "Source revision retired." | the lifecycle's own row (unchanged) |

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
- **The pinned step** (O5; Q5 and Q7):
  - the code changes:
    - `pinnedDecisions` no longer refuses an `active` pinned version;
    - `disablePinned`'s one UPDATE covers `needs_review` and `active` versions (today it is filtered on
      `status = 'needs_review'`);
    - `disabledAuditRows` writes each row with its version's real `from_status`, taken from the versions the step read
      under their `FOR UPDATE` lock (today it is fixed to `needs_review`). v35's deferred link requires it.
  - L2 and L5 disable a pinned `active` version as they disable a pinned `needs_review` one, in the same transaction,
    before the retirement (v34 refuses the retirement before, lines 572-575);
  - L4 does the same; D3's prepared replacement waits for 7d (Q5);
  - a club's active version is disabled from the platform workspace too (Q7);
  - the answers keep counts only (`disabledVersions` by owner scope), never a club, mapping or version id;
  - `club_archived` (O7(ii)(a)) covers an active club version too (Q1 (a), C104). Its sentence changes, since no
    route restores a club (R8);
  - `activation_open` stays a refusal until 7d;
  - `version_active` and its sentence are removed (Q5 and Q7 decided as recommended, C104).
- **Decision 9 stays as it is.** An active version keeps its canonical variable from getting a new version or being
  archived (`variable_pinned`) until the mapping version is disabled. That is the explicit order of D6: disable → new
  canonical version → new mapping version → activate.

---

## 4. Lock order

A1 and A2 follow M2's order (J1, C57), each step bounded (`statement_timeout` 10 s, `lock_timeout` 2 s on rows):

1. The per-user advisory lock (5 s), then the request record lookup. A replay stops here and writes nothing.
2. A1 only: the active `unit_conversions` rows of the version's value pair and bound pair, **in one statement,
   `order by id for share`**, exactly as `source_metric_lock_conversions` (v34 lines 952-959) and the version create
   (`sourceMetricMappingService.js:1157-1160`) take them (C52). So a future retirement of two conversions (7c), which
   must take them in id order too, cannot deadlock against it.
3. T2a and T2b of the version `FOR SHARE`. In a replacement, N and N+1 pin the same active revision, because an
   activation needs the active revision and only one exists; locking N+1's is enough.
4. T3 (the mapping) `FOR NO KEY UPDATE`. It serializes every transition of one mapping: two activations, an
   activation and a disable, a replacement and a submission (`FOR SHARE`), and the pinned step (`FOR SHARE`). A version
   create already holds the same lock.
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
- **No deadlock between the two orders.** The lifecycle locks T2b → T3 → T4, the same direction as A1, and decision 9
  reads T4 without a lock.
- Tested in both orders (section 8).

---

## 5. Idempotency, replay and the COMMIT

- **A request record per operation:** the keyed T8 row (D10).
  - The request hash covers the route, the mapping, the version, the target status, `expectedActiveVersionId` or
    `expectedStatus`, and the reason (R7).
  - The same user, key and hash replays the current state (C65): the right is checked again, the version is read
    again through the owner-filtered `writableVersion`, `200 replayed: true`. A replay from another workspace is
    therefore the identical `404`.
  - **The replay of a replacement** names N: the request lookup also returns the keyed row's `operation_id`, and N is
    the version of the operation's `mapping_status` row `active → disabled` (the lifecycle's `operationAnswer` pattern).
  - Another body with that key is `409 request_key_reused`. A refusal is no request record.
- **The COMMIT** (C79):
  - awaited a bounded time;
  - a definite PostgreSQL refusal (a deferred v35 or v43 check) means nothing was written, and answers the sanitized
    `500`;
  - any other COMMIT error is verified on a second connection by the request key: `200` with `commitConfirmation:
    "verified_after_commit_error"`, or `503 outcome_unknown`.
- **The v35 actor setting** is set right before the first protected write, as in M2 (C75). A replay sets none.

---

## 6. Information hiding

- The identical `404` for:
  - a caller who is not an active platform admin, before the body is read (section 2);
  - a path that is not a uuid, or names a version of another mapping;
  - a mapping of another owner than the workspace's;
  - an archived club's workspace (it has no admin context);
  - a right lost during the write.
- A club admin can read its club's versions (J1 rows 4–5) but cannot activate or disable them (D6). The routes answer
  the same `404`, so they reveal nothing beyond the reads (R3). The Mappings screen (phase 8) offers the actions only
  to a platform admin.
- No refusal names another owner's mapping, version or club:
  - `source_metric_target_taken` names only the owner scope of the caller's own mapping (D6);
  - `current.activeVersionId` is a version of the caller's own mapping;
  - the pinned step's answers carry counts only, and its `club_archived` keeps O7(ii)(a)'s rule: club ids, to an
    active platform admin only.
- **The one write across workspaces** is the pinned step: from the platform workspace it disables club-owned versions
  (O7(i); its extension to `active` versions is Q7). A1 and A2 never write outside the workspace's owner.

---

## 7. Migration v43 (specification; the file is written in the implementation pull request)

**What it adds:** functions and triggers only: no table, column, index or data. No existing function is changed;
`source_metric_actor_basis` stays byte-identical. The two triggers are named `source_metric_audit_v43_*`, so they sort
after every earlier T8 trigger (`…_v35_actor_guard`, `…_v37_revision_guard`).

| Guard | Trigger | Rule | Refusal | When |
|---|---|---|---|---|
| **G1, a replacement's label is true** | `source_metric_audit_v43_replacement_link`: AFTER INSERT on T8, `deferrable initially deferred`, for `mapping_status` and `mapping_version_replaced` rows only | A `mapping_version_replaced` row is accepted only when its operation (the same `operation_id`) holds a `mapping_status` row `active → disabled` of **another** version of the same mapping, by the same user, whose version is `disabled` with `disable_reason` equal to the replaced row's `reason`. A `mapping_status` row `needs_review → active` is accepted only when its operation disabled no active version of that mapping. Checked at COMMIT, so the order of the two rows does not matter. | `23514` (fixed text) | always (R6) |
| **G2, a row agrees with its version** | `source_metric_audit_v43_transition_facts`: BEFORE INSERT on T8, for `mapping_status` and `mapping_version_replaced` rows only | It compares the row only with its own T4 row, which the transition already wrote: a `→ disabled` row carries exactly the version's `disable_reason`; `performed_at = now()`; the transition's `*_at` (`submitted_at`, `activated_at` or `disabled_at`) lies within `[now(), clock_timestamp()]`, both bounds included, so it is neither before this transaction nor in the future. | `23514` (fixed text) | in v43 (Q2, C104) |

- **What G1 and G2 are, and are not** (as J2 says of v35): a backstop against an accidental or unintended write that
  bypasses the service. They prove that the rows agree with each other and with the version, not that the writer was
  honest. A direct-SQL writer with the owner credentials can still split one operation into two `operation_id`s, or
  switch the triggers off (C74).
- **G3, not chosen (Q1 option (b); C104 chose (a), with (c) as a separate task before M6). Kept for the record:**
  - a new function, for example `source_metric_actor_may_disable_archived(p_actor, p_club)`, that is true only for
    an active platform admin and an archived club;
  - called only from the `disabled` branch of v35's T4 actor guard and the `to_status = 'disabled'` branch of v35's
    T8 actor guard. So v43 would replace those two v35 function bodies, with no change to `source_metric_actor_basis`.
    It takes the acting user's role and user rows and the club row `FOR SHARE` in v35's order, so a change of the
    club's state cannot race it;
  - its only caller would be the pinned step in the platform workspace. A2 cannot reach an archived club, because the
    club's workspace has no admin context; reaching it would need a service change and a C60 exception;
  - the rollback would restore both v35 bodies, and the post-check would compare their md5;
  - its tests: an archived club still refuses a mapping create, a version create, a submit and an activation by direct
    SQL, and v36 and v41 writes too.
- **What v43 does not change:**
  - v34's forward-only status machine: "a future back to draft needs a new rule" (K);
  - v34's checks of an activation;
  - the one-row-per-(version, `to_status`) rule of v35;
  - the actor setting.
- **Failure codes:** fixed messages without an id, name or value (C79). Through the service they are a sanitized
  `500`. None is reachable when the service works as specified; the tests reach them by direct SQL, and one test
  through the route (section 8).
- **Rollback** (`docs/runbooks/source-metric-mapping-transitions-v43-rollback.sql`):
  - It drops v43's triggers and functions and restores v42's catalog exactly, with no data change. v43 only adds
    checks, and no rule re-checks a row already written, so the rollback refuses nothing because of data.
  - It refuses, changing nothing:
    - while a later migration is recorded;
    - while v43 is not recorded;
    - while a v43 object is missing or a v43 trigger is disabled (as v39's and v42's rollbacks do);
    - while the migrator holds its advisory lock 822026 (taken without waiting, as v42's rollback does).
  - It takes its table lock on T8 before its checks, and is rehearsed: apply → rollback → identical v42 catalog with
    `obj_description` → re-apply.
- **Read-only preflight** (`docs/runbooks/source-metric-mapping-transitions-v43-preflight.sql`, run by the owner block
  by block, the same day as the merge):
  1. the PostgreSQL version;
  2. v42 is the last migration with the repository's checksum, and v43 is absent;
  3. no v43 function or trigger exists, and the md5 of `source_metric_actor_basis` is v35's;
  4. **hard assertions:** no T4 row is `active` and no T5 row exists. If either is not 0, stop and report. The counts
     of T3, T4 by status, and T8 mapping rows are recorded for the post-check;
  5. every trigger of T3, T4 and T8 is enabled;
  6. no actor default exists;
  7. a quiet moment: no lock on T3, T4 or T8, and no M2 session.
- **Read-only post-check** (`…-v43-postcheck.sql`):
  1. v43 recorded once with its checksum, and it is the last migration;
  2. each v43 function body (md5) and its `v43 …` comment, and the md5 of `source_metric_actor_basis` unchanged;
  3. both v43 triggers present and enabled, with their `tgtype`, `tgdeferrable` and `tginitdeferred` as specified;
  4. the counts of preflight block 4, unchanged;
  5. no actor default;
  6. no lock.
- **Runbook** `docs/runbooks/source-metric-mapping-transitions-v43.md`: the order (preflight → merge → deploy → smoke →
  post-check), what to do when a block differs, and the rollback. It also says that a rollback of v43 needs no revert
  of the 7b code, and the reverse (the *Nezavisni revizor*'s LOW-2): the code writes rows that satisfy G1 and G2, and
  without them its routes work unchanged, since G1 and G2 are backstops only.

With Q2 and R6 decided (C104), v43 holds G1 and G2, and no G3.

---

## 8. Tests and mutations

A new suite, `backend/tests/source-metric-mapping-transitions-7b.test.mjs`: disposable databases, the real HTTP stack,
through the T1 runner, on PostgreSQL 16 and, where possible, 17.
- **Routes:**
  - A1 plain activation, A1 replacement, and A2 from each of the three statuses;
  - every refusal of section 2, and the order of the answers (a club admin gets `404`, not `415` or `400`);
  - a replay, the replay of a replacement naming N, `request_key_reused`, and a refusal that writes no request
    record.
- **Information hiding:**
  - a club admin, a team coach, another club, a team workspace, an archived club, a revoked role and an inactive user;
  - a foreign mapping id, and a version of another mapping;
  - each answers the identical `404`, also on a replay from another workspace.
- **Database rules reached through the routes:**
  - the per-owner target uniqueness (`source_metric_target_taken`), with a system mapping and a club mapping of the
    same pair both allowed (C33);
  - an archived canonical variable (`target_not_active`) and a moved current version (`canonical_version_changed`);
  - decision 9: an active version blocks `variable_pinned`, and a disable releases it.
- **Concurrency, in both orders:**
  - two activations of two versions of one mapping;
  - two activations on two mappings of the same owner and target: one `200`, the other `try_again` or
    `source_metric_target_taken`, and a retry answers `source_metric_target_taken`;
  - an activation against a disable;
  - an activation against a canonical new version (M3-0) and an archive (R2);
  - an activation against a conversion retirement, by direct SQL until 7c;
  - an activation against a level removal through the older Metrics API (`trainingLoadMetricsCatalog.js:372`:
    `metric_definitions` `FOR UPDATE`, then the scope capability row, under v34's guard
    `source_metric_guard_scope_capability`, line 1265). Both take the definition, then its capabilities (the
    *Nezavisni revizor*'s LOW-1);
  - an activation against L2, L4 and L5 on the same revision.
- **The pinned step:**
  - L2, L4 and L5 disable an active pinned version (system, and club as Q7 answers), each audit row with its real
    `from_status`;
  - `club_archived` for an active club version;
  - `activation_open` stays refused;
  - the answers carry counts only.
- **The COMMIT:**
  - a lost answer verified, and `outcome_unknown`;
  - a **definite COMMIT refusal** through A1's replacement: a test seam makes the deferred G1 refuse at COMMIT. The
    answer is the sanitized `500`, and nothing is written;
  - a right lost during the write.
- **v43:**
  - each guard refused by direct SQL with its fixed text:
    - G1 in both directions;
    - G2: a reason that differs; `performed_at` not `now()`; a `*_at` one day in the future; a `*_at` before the
      transaction;
  - the rollback's refusals and its rehearsal;
  - the preflight and the post-check run block by block on a disposable database.
- **Existing suites:**
  - M2, v35, M3-0, M2b, R2, 12b and v39 keep passing;
  - the v39 suite's `version_active` expectations change to the new pinned step (the only intended change);
  - the M2 architecture test names the new writers.
- **Mutations, each killed by a test:**
  - the platform-admin-only check and its place before the body;
  - the owner-workspace check;
  - `expectedActiveVersionId`, `expectedStatus` and the reason rules;
  - the replacement order (disable before activate);
  - the keyed row last;
  - the replacement's replay deriving `replaced`;
  - the open-activation refusal;
  - the right checked again;
  - each `23505` mapping;
  - the pinned step's active disable and its real `from_status`;
  - `club_archived` for an active version;
  - each v43 branch, the upper and the lower time bound separately;
  - the rollback's refusals.

**Reviewers:** `db-reviewer` (v43, the lock order, the transactions), `security-reviewer` (the 404s, the
platform-admin-only rule, the pinned step across workspaces), `code-reviewer`, then the *Rukovodilac* and the
*Nezavisni revizor* (triggers 1, 2 and 4).

---

## 9. Questions for the owner (red zone; decided, C104)

Each question has one recommendation and its consequence. The owner decided all six as recommended on 2026-10-29
(C104); the decision is marked under each.

- **Q1. A version of an archived club** (K, J2, O7(ii)). While a club is archived no one may write its mappings (v35),
  and no route restores a club (section 1.2).
  - **Decided (C104): (a) for 7b; (c) scheduled as a separate task before M6 (recorded in `docs/ai/CURRENT_STATE.md`,
    Separate tasks); not (b).**
  - *Recommended (a), for 7b:* no change. A2 cannot reach an archived club (no admin context), and the pinned step
    answers `club_archived` naming the club to a platform admin, as today.
    - *Consequence:* the only way to stop such a version, or to retire a revision it pins, is a direct database write
      that sets the club active again, which needs the owner's confirmation each time (`database-safety.md`). While
      it is active, its admins can write again.
    - Before the first real production confirmation (M6), (b) or (c) should be chosen, because then a club's version
      can hold real data. Before 7d and M4 nothing reads it.
  - *(b):* G3 (section 7): a platform admin may disable an archived club's version from the pinned step only. v43 then
    replaces two v35 guard bodies.
  - *(c):* archiving a club is refused while it holds a `needs_review` or `active` mapping version, so the case no
    longer arises for a club archived after the change. This changes `DELETE /clubs/:id`
    (`backend/src/routes/organization.js`), outside this track. A club archived before it stays as under (a).
- **Q2. The audit row's reason and time against the version's columns** (K, from the v35 reviews).
  - **Decided (C104): the database checks them (G2 in v43).**
  - *Recommended:* the database checks them (G2 in v43): the reason of a disable, and the time of every transition
    within its own transaction.
  - *Consequence:* v43 carries G2, with its tests and mutations. A direct-SQL write cannot record one reason on the
    version and another in its audit row, or a transition time outside its transaction.
  - *Alternative:* the route writes both from one value, and nothing in the database compares them.
- **Q3. Replacing the active version.** D6 already decides that activating N+1 disables N in the same transaction.
  - **Decided (C104): D6 confirmed, with `expectedActiveVersionId` and a required reason.**
  - *Recommended:* confirm D6, with the caller naming the version it replaces (`expectedActiveVersionId`) and a
    required reason. There is no separate replace route, and no replacement of a version the caller did not see.
  - *Consequence:* a stale screen cannot replace a version another admin activated meanwhile
    (`active_version_changed`).
- **Q5. L4 when a version pinned to R is active.**
  - **Decided (C104): L4 disables it like L2 and L5; D3's prepared replacement comes with 7d.**
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
  - **Decided (C104): no rule in 7b.**
  - *Recommended:* no rule in 7b, as O8 decided for revisions. With one platform admin the rule would stop the work,
    and every act stays attributed.
  - *Alternative:* the activator is not the submitter (a service rule, and a check in v43).
- **Q7. The pinned step and a club's active version** (O5 against O7(i)). O7(i) accepted that a revision's retirement
  from the platform workspace disables a club's `needs_review` versions. 7b makes active versions possible.
  - **Decided (C104): as recommended. Showing the fixed reason to the club stays a separate future decision.**
  - *Recommended:* the pinned step disables a club's `active` pinned version too, as O5's "a field can always be
    stopped" requires.
  - *Consequence:*
    - a platform admin stops a club's live mapping without the club's admins acting;
    - the club is not told (O7(iii) stays). Its Mappings screen (phase 8) shows the version `disabled` and when, not
      why: the reason stays out of every answer (C63, R2). O7(iii)'s "with the fixed reason" does not hold under C63;
      showing the fixed reason to the club would be a separate owner decision;
    - the answer carries counts only;
    - after 7d and M4, the club's imports through that mapping stop until a platform admin, in the club's workspace,
      activates a version on the new revision. The club's admin can only create and submit one (D6, R3).
  - *Alternative:* the pinned step refuses while a club's version is active (`version_active` with a count). A
    platform admin first disables it with A2 in the club's workspace, then retires the revision. A field could then be
    stopped only club by club.

**Not a question for 7b:**
- Q4, the system or club ownership of zone and threshold mappings (K), concerns showing one team's bounds through a
  system mapping's activations and the preview. That is 7d and 7e (section 11).
- The pinned step's missing cap on the number of versions (J5, known limit) stays an owner decision before M6, as
  recorded. 7b adds at most one active version per mapping to it.

---

## 10. Inside the plan (the *Rukovodilac* decides)

- **R1:** the route names and bodies of section 2. Activation and replacement are one route (D6), and disable is a
  second one.
- **R2:** `activatedAt` and `disabledAt` are added to the version shape. The disable reason stays out of every answer
  (C63 unchanged; it is readable in the database).
- **R3:** a club admin gets the identical `404` from A1 and A2 (J1's convention for "may not write"), before the body
  is looked at, as the lifecycle routes do.
- **R4:** `activation_open` is a fail-closed refusal in 7b, replaced by D6's T5 steps in 7d.
- **R5:** the code names of section 2. New ones: `version_not_submitted`, `active_version_changed`,
  `version_status_changed`, `revision_not_verified`, `canonical_version_changed`, `source_metric_target_taken`. J1's
  `target_not_active`, `conversion_unavailable`, `bound_conversion_unavailable`, `level_not_allowed` and
  `parameters_not_equivalent` keep their meaning.
- **R6:** G1 is always in v43. It is the audit's own truth, independent of Q1 and Q2.
- **R7:** what the request hash covers (section 5), and the extensions of M2's machinery (section 1.3):
  `insertRequestRecord` takes a `reason`; the request lookup returns `operation_id`; and N's audit row in a replacement,
  which carries no `request_key` or `request_hash` (the constraint `source_metric_audit_request_pair`), has its own
  insert, as the lifecycle's `disabledAuditRows` does.
- **R8:** the lifecycle's sentences: `version_active` is removed (unless Q5's or Q7's alternative keeps it), and
  `club_archived` no longer says "restore the club", since no route does.

---

## 11. Not in 7b

- T5 activations and their actor guard (7d), D6's T5 steps, and D3's prepared replacement in L4 (7d).
  - **An obligation for 7d** (the *Rukovodilac*'s L1): G1 accepts a `mapping_status` row `needs_review → active`
    only when its operation disabled no active version of that mapping. So D3's prepared replacement in L4 must
    write `mapping_version_replaced` for each version it activates, with the replaced version's `mapping_status`
    row in the same operation. Otherwise 7d would need a change of G1 (a v44).
- Q4, the ownership of zone and threshold mappings (7d, 7e).
- `unit_conversions` maintenance (7c), the aggregate preview (7e), the extractor registry (7f), and ending a held
  instance (7g).
- The Mappings screen (phase 8). No frontend changes in 7b.
- The importer (M4). The first real production confirmation of a field (C97, M6).
- Any write to a persistent database by the executor.

---

## 12. Review record

The internal reviews of `484553c` (2026-10-29), all applied in this revision:

| Reviewer | Verdict | Findings, and what changed |
|---|---|---|
| `code-reviewer` | READY WITH NOTES | MEDIUM: G3 on the shared `source_metric_actor_basis` → G3 rewritten as an option on the two guards that see the transition (section 7). MEDIUM: G2 had no upper time bound → `[now(), clock_timestamp()]`, and the replaced row's reason moved to G1, compared with N's column. LOW: the audit shape function's name; `target_not_active` for an inactive definition; the `23505` names; the two machinery extensions (R7). |
| `security-reviewer` | NOT READY | HIGH F1: G3 would widen every guard that uses `source_metric_actor_basis` (v35, v36, v41) → as above, not recommended, with its tests. MEDIUM F2: no route restores a club → stated in 1.2 and Q1, with option (c). MEDIUM F3: the pinned step's widening to a club's active versions → Q7. LOW: the answer order (section 2), the replay through `writableVersion` and `operation_id` (section 5), the `23505` race, G1's limit, the `PIN_GUARD` line. |
| `db-reviewer` | NOT READY | HIGH: Q7, as above. MEDIUM: G3 not implementable as stated → as above. MEDIUM: the conversion lock is one statement `order by id` → section 4. MEDIUM: G1 and G2 timing → G1 deferred holds the replaced-row check, G2 BEFORE compares only with the version, both triggers named. MEDIUM: the route test of a definite COMMIT refusal → section 8. LOW: `publicVersion` line; the `23505` mapping by index name; the lifecycle's code changes (section 3); the 404 before the body; the preflight's hard assertions; the post-check's trigger kind; the rollback's refusal of missing objects; Q4 moved out of the questions. |

The narrow re-reviews of `9639b27` (2026-10-29): `code-reviewer`, `db-reviewer` and `security-reviewer` each READY
WITH NON-BLOCKING NOTES; every earlier finding closed. Their notes, applied in the next revision:
- MEDIUM (security, N1): Q7's consequence named the club's admin as able to activate, and the reason as shown to the
  club. Corrected;
- LOW:
  - the shared v34 text at line 1181 maps to one code;
  - the backstop's `current` is read after the rollback;
  - a state refusal comes after the right is confirmed (section 2, item 7);
  - N's unkeyed audit row has its own insert (R7);
  - Q1(c) covers future archives only;
  - `version_active` stays if an alternative is chosen;
  - the gate is a new helper, not `mayChangeRevisions`;
  - G3 locks the club row in v35's order;
  - the J8 pointer in the discovery document.

The external review of `f9f6bec` (2026-10-29, ★★): GO from both, without a BLOCKER, HIGH or MEDIUM. The proposal was
merged as PR #266 (`69d824f`). Their LOW notes, applied in this revision:
- the *Rukovodilac* (its message queued at 13:27:22 UTC; R1–R8 accepted as written):
  - L1: G1's obligation for 7d's D3 prepared replacement (section 11);
  - L2: the pinned step's one UPDATE over both statuses, with the real `from_status` (section 3);
  - L3: the note for phase 8 on the reason (section 2);
  - L4: Q1 (c) recorded as a separate task before M6;
- the *Nezavisni revizor* (13:29:52 UTC):
  - LOW-1: the race of an activation against a level removal through the older Metrics API (section 8);
  - LOW-2: a rollback of v43 and a revert of the 7b code are independent (section 7, runbook);
  - LOW-3: the per-owner index wait is on the first's transaction (section 2);
  - INFO: the order of the build PR names the exact v43 file and its sha256 (header). Whether the existing suites
    pass under G2 is shown by running them in the build PR.

**Accepted on 2026-10-29 (C104):** the owner's „A1 DA, I SVE PO PREPORUKAMA” (owner turn `f505ec21`, 13:32:57 UTC, in
the *Rukovodilac*'s chat), read by the *Rukovodilac* as the acceptance of the contract and of Q1, Q2, Q3, Q5, Q6 and
Q7 as recommended.
