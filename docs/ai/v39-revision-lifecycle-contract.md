# J5 — v39 and v40: the source-field revision lifecycle (C91) and Q10 part B

**Accepted on 2026-10-27 (C100 of the discovery document), not implemented.** This is phase 4's discovery delta of
`docs/ai/metrics-core-plan.md` (★★): the owner approves the contract before any code. It extends
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*), whose sections D3, J1, J2 and J4 it
builds on; its decisions are written into that document's section C as C100, as R2's were (C99). The owner's answers
to O1–O9 are the *Rukovodilac*'s reading of the owner's words (C100); the owner's own word on the merge of the pull
request that records them confirms it.

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-27, on the *Rukovodilac*'s order of that day; revised the same day after two rounds of internal reviews (`code-reviewer`, `db-reviewer`, `security-reviewer`) and the *Rukovodilac*'s R5 decision (two migration files); then reviewed by the *Rukovodilac* and the *Nezavisni revizor* at `93f22d3` (no BLOCKER, HIGH or MEDIUM), with their notes and the *Rukovodilac*'s R decisions applied. Accepted on 2026-10-27: O1–O9 as proposed (C100, the *Rukovodilac*'s reading of the owner's words) and R1–R7 as decided. Not implemented: no code, migration or data change. |
| Verified against commit | `fdc2c2e` (merge of PR #237). Every file and line reference below is to that commit. |
| Decides | The owner: the questions marked **[OWNER]** (red zone). The *Rukovodilac*: the questions marked **[RUKOVODILAC]** (inside the plan). |
| Reviewers of this document | The *Rukovodilac* and the *Nezavisni revizor* (★★), `code-reviewer`; `db-reviewer` for J5.2's transactions, J5.3 and J5.4; `security-reviewer` for the access, actor and cross-owner parts. |

**Gates before the implementation** (plan, phase 4 "Input"):
1. the owner's answers to O1–O9 (J5.6): given on 2026-10-27, as the *Rukovodilac* reads them (C100);
2. the v37 production post-check passed (phase P): **closed** by the owner's statement of 2026-10-27 (C100);
3. the old Render service clarified (phase 1, b): **closed** by the same statement (C100). It runs on Supabase, is
   inactive and no longer deployed, and stays inactive during and after the deploy of v39 and v40;
4. the plan names both migrations: phase 4's gate line "migrations v39 and v40" and section 6 (part B in v40). In this
   pull request, after PR #238 is merged (the *Rukovodilac*'s process of 2026-10-27), so the owner's order names
   both.

---

## J5.1 What exists (verified at `fdc2c2e`)

**T2b, `training_load.source_metric_definition_versions`** (v34, `migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql:357-597`; its guard `source_metric_revisions_guard`, lines 481-596):
- states `draft → active → retired` and `draft → retired`; at most one active and one draft revision per field
  (partial unique indexes `source_metric_revisions_one_active`, `…_one_draft`, lines 473-476), and one number per
  field (`source_metric_revisions_number_key`, line 469);
- a revision is inserted as `draft`, without proof, only for an active field (T2a); only a seed migration inserts
  one `active` (lines 490-512). A row names either its creator or its seed migration, never both
  (`source_metric_revisions_actor_or_seed`, lines 467-468), and a seed marker passes only inside the seeding
  migration's own window (`source_metric_require_seed_window`, lines 201-207, which refuses every marker once v34 is
  recorded);
- the contract of a revision (shape, parameter kind, levels, the hypothesis, the creator, the seed marker) is
  immutable; the proof is written once; the evidence status only rises (lines 518-545). Of the four statuses only
  `verified` is derived by the database: it holds exactly when the unit and the meaning are proven
  (`source_metric_revisions_verified_iff_proven`, lines 449-452). `documented` and `observed` are asserted by the
  writer with a reference in the `docs/…#anchor` form;
- **activation** needs an active field, no other active revision, and `activated_by_user_id` an active platform
  admin (lines 556-567, 587-589). The "no other active revision" check reads the table, so in one transaction the
  old revision must be retired by an earlier statement than the activation;
- **retirement** needs `retired_by_user_id`, `retired_at` and `retired_reason` (the state-facts CHECK) and is
  refused while a mapping version pinned to the revision is `needs_review` or `active` (lines 568-575). v34 checks
  no actor for a retirement;
- a verification is its own act, never together with a state change (lines 546-550).

**v37** (`migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql`):
- the function `source_metric_revisions_actor_guard()` (lines 63-103), fired by the trigger
  `source_metric_revisions_v37_actor_guard` (lines 105-107), refuses every T2b INSERT (a seed inside its window
  included) and every state change: the only T2b writes are the two verification acts (C90);
- its T8 guard (`source_metric_audit_revision_guard`, trigger `source_metric_audit_v37_revision_guard`) refuses every
  action without a built chain, the revision actions included (lines 132-134);
- its deferred link (`source_metric_revisions_v37_audit_link`, lines 185-190) fires only AFTER UPDATE of the two
  proof timestamps. There is no INSERT link and no state-change link;
- two indexes: `source_metric_audit_v37_revision_idx` (lookups) and the unique `…_v37_verification_once`;
- its rollback refuses once a verification exists.

**T8** (v34: the shapes at lines 1630-1670, the table from line 1675) already defines the revision actions and their
shapes (targets `11000000`: the field and the revision):
- `source_metric_revision_create`: from nothing to `draft`, `platform_admin`;
- `source_metric_revision_activate`: `draft → active`, `platform_admin`;
- `source_metric_revision_retire`: `draft` or `active` → `retired`, a reason, `platform_admin`;
- `mapping_status` (targets `00110000`: it cannot name the revision; … `→ disabled` with a reason,
  `platform_admin`) and `mapping_version_replaced` (`needs_review → active`, a reason).

At most one T8 row of a user carries a given `request_key`, and one operation has at most one keyed row
(`source_metric_audit_one_request_per_key`, `…_one_request_per_operation`, lines 1734-1738). v35 requires one
`mapping_status` row per version and target status and refuses a second (v35, lines 272-286), but does not compare its
`reason` with the version's `disable_reason`.

**T4, the mapping versions** (D6; v34 lines 756-1220):
- statuses `draft → needs_review → active → disabled` (`disabled` from any of the other three);
- a version is created only on a `draft` or `active` revision with a **proven unit** (M2
  `backend/src/sourceMetricMappingService.js:1094-1097`), and submitted only while its revision is not retired
  (v34 lines 1156-1159; M2 `:1251`, `409 revision_not_usable`). A club admin may create and submit a version of
  the club's own mapping on a draft revision;
- `active` needs the revision `active` and `verified` (lines 1168-1176); `disabled` needs no open activation
  (T5) and a platform admin (lines 1193-1205);
- v35 guards every status change by the acting user and its audit row (J2). `source_metric_actor_basis` returns
  NULL for an archived club even for a platform admin (v35, lines 88-95), so the T4 guard (lines 160-165) and the
  T8 guard (lines 239-243) refuse every transition of an archived club's mapping with `42501`: while a club is
  archived, no one writes it.

**What can exist in production today:**
- the routes create a T4 `draft` and submit it (`needs_review`) (J1); **no route activates or disables a
  version, and nothing writes T5**. So a version pinned to a revision is `draft` or `needs_review`, never
  `active`, and no activation is open;
- the nine seeded revisions (D12; v34 lines 1790-1795): revision 1, `active`, seeded, `evidence_status`
  `observed` with the reference `docs/ai/gpexe-rest-v1-compatibility.md#2-the-table`, the expected unit a
  hypothesis, no proven unit or meaning; no field is confirmed (C97);
- T3, T4 and T8 were empty at the owner's v36 preflight and v35 post-check (both 2026-10-14); not re-verified
  since. The v39 preflight counts them.

**The text functions** (v34, lines 69-84):
- `source_metric_text_ok(v, max_len)`: `v = btrim(v)` (which trims only U+0020), 1 to `max_len` characters, none
  of C53's list;
- `source_metric_unit_token_ok(v)`: 1-30 characters, none of `\s`, `|`, `=` and its own list.

They are used by CHECKs of T2a, T2b, `unit_conversions`, T4, T5, T6 and T8 (v34 lines 273, 281, 375-417, 675-687,
778-821, 856-858 through `source_metric_parameters_shape_ok`, 1312, 1496, 1700) and by v38's request and change
guards (`…_v38_metric_variable_changes.sql:283, 359-363`). At run time they are also called by
`canonicalVariableAdminService.js:536` and `:768`, `sourceFieldVerificationService.js:181` and
`sourceMetricMappingService.js:575` and `:583`, which become stricter the moment part B is applied. No index,
partial-index predicate or generated column uses them. Q10 part A (PR #229) made the services and the frontend
stricter (`backend/src/metricTextRules.js`, J3b.9); the database still accepts what part A refuses.

---

## J5.2 The lifecycle (proposed)

### Common to L1-L5

**Access.** Every operation is a platform admin's in the platform workspace (O1), with J1's and J4's rules:
- the workspace is resolved once per request (`resolveMappingAdmin`);
- the router checks the right **before** the body (M2b's `mayVerify`, `routes/sourceMetrics.js:233-234`), and the
  service checks it again on entry. A club admin, a platform admin in a club workspace, a coach and a user
  without a role get the identical `404 {"error":"notFound"}` whatever the body, never `415 jsonRequired`; an
  anonymous request gets `401`;
- `Cache-Control: no-store`; a malformed id is the identical 404.

**The request record.** One T8 row per operation carries `request_key` and `request_hash` (the indexes allow
exactly one):
- L1: the `…_revision_create` row; L2 and L5: the `…_revision_retire` row; L3 and L4: the `…_revision_activate`
  row. L4's other rows (`…_retire`, one `mapping_status` per disabled version) share its `operation_id`;
- a replay finds the keyed row, checks the right again and answers the current state of the operation, read by
  `operation_id` (for L4 both revisions and the disable count);
- the hash covers a contract tag and the route: `{ contract: "source-revisions/v1", route: "create" | "retire" |
  "activate" | "replace", fieldId, revisionId, body }`. L3 and L4 write the same action, so without the route a key
  used on L3 would replay as a success of L4; with it, that is `409 request_key_reused`;
- `try_again` carries `Retry-After: 5` (J4); the bounded COMMIT and its check are C79's (`503 outcome_unknown`
  only when the key cannot be read back).

**Answers** use M2b's revision shape (`revisionOut`, `sourceMetricMappingService.js:524-532`): no reason and no
actor id. An answer and a `409` never name another owner's mapping or version, and name a club only as O7(ii)(a)
proposes; the pinned step below answers counts only.

**The order inside the transaction** (the global order of `sourceMetricMappingService.js:16-21`: T2a → T2b → T3 →
T4 → the acting user's role, user and club rows):
1. the per-user lock, then the request record (a replay ends here);
2. T2a `FOR SHARE`; then **every** revision of the field `FOR UPDATE`, ascending id. This serializes L1 against
   L1 and every L-route against M2's version create and submit and M2b's acts on that field;
3. the pinned step's locks (below), if the route retires a revision;
4. the acting user's rows `FOR SHARE` (`rightsStillHold`; lost → the identical 404), then the clubs of the pinned
   club-owned mappings `FOR SHARE`, ascending id (v35's order: the user, then the club);
5. only now the `409` decisions, each by a pre-check under these locks. A refusal that reaches a database trigger
   would be a sanitized `500`, so every condition a trigger checks (v34 lines 564-575, the open activation) has
   its own pre-check;
6. the writes, **each its own statement**, in this order: the disables, the retirement, the activation. Never one
   CTE: v34's guards read the table and must see the earlier statements;
7. the T8 rows, the keyed one last (the route table names it first only to say which it is); the bounded COMMIT.

M2's own writers stay correct against this order. A version create re-reads the revision under `FOR SHARE`
(`sourceMetricMappingService.js:1165-1166`) and a submit takes that lock before it decides (`:1243-1251`). So when an
L-route holds the revision first, M2 waits and then answers `409 revision_not_usable`. A trigger refusal that slips
past those pre-checks is mapped to the same `409` (`:401-403`), never a `500`.

A `23505` on `source_metric_revisions_one_draft` is `409 draft_exists` and on `…_number_key` `try_again`, matched by
the exact constraint name, as M2b's `RETRY_CONSTRAINTS` (`sourceFieldVerificationService.js:62`).

**The pinned step** (L2, L4 and L5: every route that retires a revision R). For the mapping versions pinned to R:
- locks: their T3 rows `FOR SHARE`, then the versions `FOR UPDATE`, ascending id (step 3);
- `needs_review` → `disabled`, by O4 and O7: `disabled_by_user_id` the acting user, `disabled_at`,
  `disabled_basis = 'platform_admin'` (the basis v35 derives) and `disable_reason` the fixed text "Source revision
  retired." (v34 lines 871-872 tie the four together), and one `mapping_status` row each whose `reason` is the same
  text;
- `draft` stays as it is: it can never be submitted once R is retired (v34 lines 1156-1159; M2
  `409 revision_not_usable`), and v34 does not refuse the retirement for it. Disabling drafts too would make every
  archived club's draft block the field (O7);
- `active`, or an open activation: `409 version_active` / `activation_open` (fail-closed). Neither can exist before
  phase 7 (O5);
- a pinned `needs_review` version of an archived club: by O7, proposed `409 club_archived` with the ids of those
  archived clubs (O7(ii)(a));
- the answer counts the disabled versions only: `disabledVersions: { system: n, club: n }`.

### The routes

| # | Route (under `/api/training-load/sources/metrics`) | What it does | T8 (the keyed row named first, written last) |
|---|---|---|---|
| L1 | `POST /fields/:fieldId/revisions` | creates revision R+1 as `draft` | `source_metric_revision_create` |
| L2 | `POST /fields/:fieldId/revisions/:revisionId/retire` on a `draft` | retires an abandoned draft, with the pinned step | `source_metric_revision_retire`, `mapping_status` × n |
| L3 | `POST /fields/:fieldId/revisions/:revisionId/activate` | activates a `draft` when the field has no active revision | `source_metric_revision_activate` |
| L4 | `POST /fields/:fieldId/revisions/:revisionId/replace` | the active R → `retired` and the draft R+1 (`:revisionId`) → `active`, with the pinned step on R | `source_metric_revision_activate`, `…_retire`, `mapping_status` × n |
| L5 | `POST /fields/:fieldId/revisions/:revisionId/retire` on an `active` R | retires R with no successor (O3), with the pinned step | `source_metric_revision_retire`, `mapping_status` × n |

**L1, the body:** `requestKey`, `valueShape`, `parameterKind`, `supportsSession`, `supportsDrill`, and optional
`expectedSourceUnit`, `expectedSourceBoundUnit`, `unitNote`, `evidenceStatus` and `evidenceRef` (R2). The server
sets `revision_number` (the next number). It is refused while the field has a draft (`409 draft_exists`), is not
active (`409 field_not_active`), or already has 20 revisions (`409 revision_limit`, R7). The shape rules are v34's (`400 invalid_body`, `invalid_unit`,
`invalid_evidence_ref`).

**L2 and L5, the body:** `requestKey` and `reason` (`source_metric_text_ok(…, 500)`), the reason written to
`retired_reason` and to the `…_retire` row.

**L3, the body:** `requestKey`. Refused unless the revision is a `draft` (`409 revision_not_draft`) and the field
has no active revision (`409 revision_active_exists`). O2 does not apply to L3 (see O3).

**L4, the body:** `requestKey`, `reason` (for R's retirement), `expectedActiveRevisionId` (R; a stale one is
`409 revision_changed`). The transaction is the common order with: R and R+1 among the field's locked revisions;
the pinned step on R; then R → `retired` (its reason, the request's); then R+1 → `active`. Refusals:
- `409 revision_not_active` (R) or `revision_not_draft` (R+1);
- `409 successor_not_verified` (O2: R is `verified` and R+1 is not);
- the pinned step's `version_active`, `activation_open`, `club_archived`;
- `try_again`, `request_key_reused`, `503 outcome_unknown`, `500 internal_error` as in J1.

Versions created on R+1 before L4 (allowed today: a draft revision with a proven unit) are untouched.

**What does not change:**
- old facts and old versions stay pinned to R;
- R+1 inherits nothing;
- a verification stays a separate act (M2b);
- no route reaches a `needs_review → active` version transition or T5. They stay phase 7's.

---

## J5.3 Migration v39: the lifecycle's database part (proposed)

- **T2b actor guard.** `source_metric_revisions_actor_guard()` is replaced (`create or replace`); its trigger keeps
  the name `source_metric_revisions_v37_actor_guard`, so it still fires after v34's
  `source_metric_revisions_guard`. Besides the two acts it allows exactly:
  - an INSERT of a `draft` whose `created_by_user_id` is the acting user (the v35 setting), an active platform admin
    (`42501` otherwise);
  - **the seed exception (O9):** `tg_op = 'INSERT' and new.seed_migration is not null and new.created_by_user_id is
    null`. That branch reads no actor and leaves the row to v34's seed window, which refuses every marker once its
    migration is recorded. This **widens v37**, which refused a seed too; it restores v34's behaviour, not v37's.
    Today the branch is inert: v34's window refuses every marker;
  - `draft → active` with `activated_by_user_id` = the acting user;
  - `draft | active → retired` with `retired_by_user_id` = the acting user. v34 checks no actor for a
    retirement, so v39 adds it here;
  - for the INSERT, the activation and the retirement alike, the acting user is an active platform admin
    (`source_metric_actor_basis(actor, null) = 'platform_admin'`, `42501` otherwise). v35's T8 guard (line 230) is
    only the backstop;
  - a state change writes only the state and its own facts: every other column, `evidence_status` included, is
    unchanged (v34 alone would let the status rise in the same update);
  - nothing else: a state change and an act are never one update (v34), and every other update stays refused
    (`23514`).
- **T8 guard.** `source_metric_audit_revision_guard()` is replaced. A `source_metric_revision_create`, `…_activate`
  or `…_retire` row must follow its own write in the same transaction (`xmin`): it names the revision and its field,
  `from_status` / `to_status` match the transition, `performed_by_user_id` is the acting user, an active platform
  admin, with `basis = 'platform_admin'` (every branch). For `…_retire` its `reason` equals the revision's
  `retired_reason` and `from_status = 'active'` exactly when the revision has an `activated_at`. For `…_create` and
  `…_activate` the `reason` is NULL; a `…_create` row's `evidence_ref` is NULL or the revision's own, and an
  `…_activate` row's is NULL. A seed writes no T8 row. The other actions keep their chains (v35, v37); actions without a writer
  stay refused.
- **One row per transition:** a new unique partial index `source_metric_audit_v39_revision_once` on
  `(source_metric_version_id, action)` where the action is one of the three revision actions (v37's
  `…_verification_once` covers only the two acts).
- **At COMMIT:** two new deferred constraint triggers, named `…_v39_…` so they sort after v37's:
  - AFTER INSERT on T2b, `WHEN (new.seed_migration is null)`: the revision has its `…_create` row;
  - AFTER UPDATE on T2b, `WHEN (old.state is distinct from new.state)`: the row's `…_activate` or `…_retire` row
    exists with `from_status = old.state` and `to_status = new.state` (as v35's link, lines 316-321).

  Otherwise the transaction rolls back (`23514`). Replacing the functions alone would not do this: v37's link fires
  only on the proof timestamps.
- **A savepoint** fails closed, as in v35 and v37.
- **No table, column or data change.** v34, v35, v36 and v38 objects are unchanged (O7's option (b) would change
  v35's guards and is not proposed). v37's two functions are replaced; the rollback restores their v37 bodies.
- **The rollback** drops the two new triggers and the new index, restores v37's functions, and refuses:
  - once any revision was written by the lifecycle (a `created_by_user_id`, an `activated_by_user_id` or a
    `retired_by_user_id`; v37 refuses all three today and the seeds carry none), or
  - while a v39 trigger or index is missing or a v39 trigger is disabled (v37's rollback pattern), or
  - once a later migration is recorded. v40 (J5.4) is later, so it is rolled back first. v40's rollback never
    depends on v39's state (it only loosens), so it never blocks v39's.

  It is forward-only after that, as v37's rollback is after a verification.
- **The tests** of the M1, M2, v35, M3-0 and M2b suites stop switching v37's T2b triggers off. They write their
  revisions through the real lifecycle path (plan, phase 4). The M1 suite's databases stop at v34, so its test 4,
  which expects U+2065 to pass `source_metric_text_ok` (`backend/tests/source-metric-mapping-m1.test.mjs:561`), is
  not affected by v40.

---

## J5.4 Migration v40: Q10 part B, the database twins (proposed)

The *Rukovodilac*'s decision of 2026-10-27, after the security review of this contract, replaces J3b.9's "no v40":
part B is its own migration file, v40, in the same pull request as v39 (R5). Each has its own rollback, read-only
preflight and post-check, so either can be rolled back alone; one owner order names both („merge PR #… sa migracijama
v39 i v40“). The owner approves part B with this contract (O6).

- **The functions:** `create or replace` with the same signatures, the same parameter names (`v`, `max_len`;
  PostgreSQL refuses a renamed parameter) and `language sql immutable`. The OID stays, so every CHECK stays
  attached:
  - `source_metric_text_ok(v, max_len)`:
    - v34's list plus Q10's groups (J3b.9);
    - `v = btrim(v)` is replaced by "no character of `TEXT_EDGE_BLANK` at either end": U+0020, U+00A0, U+1680,
      U+2000-U+200A, U+202F, U+205F, U+3000. A strict superset of the `btrim` rule;
  - `source_metric_unit_token_ok(v)`: v34's list plus Q10's groups. `\s` is replaced by an explicit U+0020 (the
    *Rukovodilac*'s NIT of 2026-10-27): PostgreSQL's `\s` depends on the locale, and the explicit list already holds
    every other JavaScript `\s` code point, so the rule stays the same and the parity test no longer depends on the
    locale.

  The lists use **only** PostgreSQL's fixed-width `\uXXXX` and `\UXXXXXXXX` escapes inside one bracket expression,
  never `\x` (variable length: it would swallow following hex digits). They are the same characters as
  `backend/src/metricTextRules.js`. PostgreSQL's regular expressions have no Unicode properties, so the list is
  explicit. The migration asserts `server_encoding = 'UTF8'` first.
- **Fail-closed inside the migration.** After the replacement, a `DO` block counts the rows the new functions
  refuse, column by column (the list below), and raises if any count is above 0. The runner applies each migration
  in its own transaction and stops at the first failure (`backend/src/migrate.js:780-800`), so the raise rolls back
  v40 only: v39 stays applied, the runner aborts, and the server does not start (`npm start` runs the migration step
  first). That is why the preflight must show 0 before the merge, and is run right before the merge and deploy
  (the same day, after the last admin write). The v40 runbook states the rest:
  - the runner stops at the first failure, and the server does not start while v40 keeps failing;
  - the recovery if the `DO` block refuses anyway is either (a) a commit that removes the v40 file, then a redeploy:
    v39 stays applied, and the column is decided afterwards; or (b) if the refused row is in a column that is not
    append-only, the owner's order to correct that row, then a redeploy of the same code;
  - v40's rollback script is only for a v40 that is recorded: a refused v40 is never recorded (its transaction rolls
    back), so there is nothing to roll back. A count above 0 in an append-only column (T6, T8,
  `metric_variable_requests`) cannot be corrected by an update: it is a new owner decision (exempt that column, or
  loosen part B), never something the migration resolves. A CHECK is not re-validated when its function is
  replaced, so without the `DO` block a refused row would stay and could no longer be updated; a later `pg_dump`
  restore, which does re-validate, would fail.
- **The read-only preflight** counts the same rows before the migration, expected 0. A read-only transaction cannot
  create a function (not even in `pg_temp`), so the preflight carries an inline copy of the two new expressions:
  a third copy beside JavaScript and the migration, covered by the parity test. The columns:
  - T2a `source_label`, `retired_reason`;
  - T2b `expected_source_unit`, `source_unit`, `expected_source_bound_unit`, `source_bound_unit`, `unit_note`,
    `retired_reason`;
  - `unit_conversions` `from_unit`, `to_unit`, `retired_reason`;
  - T4 `source_unit`, `target_unit`, `conversion_note`, `disable_reason`, and the `unit` of `source_parameters`
    and `canonical_parameters`;
  - T5 `reason`, T6 `source_unit`, T8 `reason`;
  - `metric_variable_requests.reason` (v38);
  - and, as information only (v38 exempts an unchanged name, J3b.9; not part of the `DO` block): the names of
    every `system` and `club` definition, the units of their current versions (a mapping version's insert checks the
    canonical unit with `source_metric_unit_token_ok`, v34 line 1092, C56), and the `unit` of their
    `condition_description` (tied to the canonical parameters' unit, v34 line 1003, whose shape lines 973-974 check;
    read by M2 at `sourceMetricMappingService.js:583`).
- **Parity, by a test** on a disposable database: every code point U+0001-U+10FFFF except the surrogates (UTF-8
  cannot hold them; U+0000 PostgreSQL text cannot hold) is compared between the SQL functions, the preflight's
  inline expressions and `metricTextRules.js`, in batches; the edge set separately as `chr(i) || 'a'` and
  `'a' || chr(i)`; both lengths at the limit (code points, as `char_length`).
- **Lone surrogates** (outside v40): the JavaScript lists do not refuse a lone surrogate, and the `pg` driver
  turns one into U+FFFD, which both layers accept. A later JavaScript change adds `\ud800-\udfff` to the lists
  (with the `u` flag it matches only a lone surrogate). LOW; no database change.
- **The rollback** restores v34's two function bodies verbatim. The stricter rule only refuses, so no row depends
  on it, and v34's lists are a subset of the new ones. Whatever v39's state, it can run, even after the lifecycle has
  written revisions. Its only refusal is a migration later than v40.
- **The services already apply the rule** (part A); after part B the database refuses the same text, whoever
  writes it.

---

## J5.5 Acceptance (plan, phase 4, and Q10 part B)

- The rollbacks are rehearsed, each alone: v39 and v40 applied → v40 rolled back → the v39 catalog → v40 re-applied;
  and v40 rolled back → v39 rolled back → the v38 catalog → both re-applied. v40's rollback also runs after the
  lifecycle has written a revision.
- v40's `DO` block refuses a copy with a refused row: v40 rolls back, v39 stays applied, and the catalog is v39's
  (the two text functions still v34's).
- Every guard has a mutation that the tests kill. The seed predicate's `created_by_user_id is null` term is
  redundant outside a window (v34's own guard refuses every marker first, v34 lines 506-507) and is covered by the
  CHECK `source_metric_revisions_actor_or_seed` inside one. Its test therefore runs inside a simulated window
  (`source_metric_require_seed_window` replaced on the disposable database) with a marker and a creator, and asserts
  the v39 guard's own refusal, not the CHECK's.
- **The seed exception:** inside a seed window an `active` revision with a marker and no actor COMMITs (no T8 row);
  after it, a marker with an acting user, a marker without one, and neither marker nor actor are each `42501`.
- **The actor:** a club admin, or a platform admin no longer active, as the acting user of an INSERT, an activation
  or a retirement is `42501` in the T2b guard itself (not only at the T8 row).
- **The pinned step**, for L2, L4 and L5: a club admin's `needs_review` version pinned to R is disabled with the fixed
  reason in `disable_reason` and in its `mapping_status` row, and counted; a pinned draft stays a draft; an archived
  club's pinned version gives O7's answer; an L5 refusal never names the club.
- **The COMMIT outcome of L4** through the real route: a refusal at COMMIT by a deferred link is a definite `23514`
  (nothing written; a correct route never causes one, so the test uses a seam that leaves out an audit row); a lost COMMIT answer is verified by the request key on another connection; the same key
  repeats the same answer, a different body is `request_key_reused`, and a key used on L3 is `request_key_reused` on
  L4.
- **The request record:** after an L4 with one disabled version there is exactly one keyed T8 row and three rows with
  that `operation_id`.
- Concurrency, in both orders:
  - L4 against an M2 version create on R and on R+1;
  - L4 against an M2 submit on R;
  - L4 against an M2b act on R and on R+1;
  - L2 and L5 against an M2 version create or submit on the retired revision;
  - L4 and L5 against the archive of a club whose `needs_review` version is pinned to R;
  - L1 against L1 (`409 draft_exists`, never a `500`);
  - the M2 side answers `409 revision_not_usable`, never a `500`.
- None of the nine seeded fields changes: before and after v39 each has revision 1 `active`, `observed`, with no
  proof.
- Access, the identical 404 and the request record are tested as in J1 and J4, for L1-L5: a club admin, a platform
  admin in a club workspace, a coach, a user without a role and an anonymous request, each with valid JSON, a non-JSON
  body and a malformed id.
- The SQL lists and the preflight's copy are tested for parity with `metricTextRules.js` on every code point, in the
  v40 suite (the M1 suite's databases stop at v34, so its test 4 never sees v40).
- The preflight block is run on a disposable copy that holds a row of each listed column, and the migration's `DO`
  block refuses that copy.
- The tests run on PostgreSQL 16 and, where possible, 17.

---

## J5.6 Questions

**[OWNER] — red zone, answered on 2026-10-27 (C100): every question as proposed.** That is the *Rukovodilac*'s
reading of the owner's words (C100). So each *Proposed* below is the decision; no *Alternative* is taken. O7 is
(i) yes, (ii)(a) and (iii) no notice in v39; O8 is "not required".
- **O1, who.** Who may create, activate, retire and replace a revision.
  - *Proposed:* an active platform admin in the platform workspace, as for M2b's acts (C94). Never a club admin.
- **O2, what R+1 needs to replace R (L4).**
  - *Proposed:* if R is `verified`, R+1 must be `verified` (its unit and meaning confirmed first, M2b, which works
    on a draft); no other comparison. The other statuses are asserted by their writer (J5.1), so ranking them
    would gate nothing. The seeds are `observed`, so any R+1 may replace a seed.
  - *Alternative:* R+1 must always be `verified`.
  - A service rule only, with no database twin; L5 then L3 reaches the same end without it (O3).
- **O3, a field without an active revision.** May an active R be retired with no successor (L5)? Then no new
  version of that field can become active until a new revision is activated (L3).
  - *Proposed:* yes, with a reason. It is the clean way to stop a field whose proof turned out wrong.
  - L3 after L5 may activate an unverified revision, even after a verified R. That is safe: no mapping version can
    become `active` on a revision that is not `verified` (v34 lines 1168-1176).
- **O4, the versions pinned to a retired revision** (L2, L4 and L5).
  - *Proposed:* the pinned step disables every `needs_review` version pinned to the retired revision,
    automatically, with a fixed reason; drafts stay drafts (they can no longer be submitted). The mapping owners
    then create versions on R+1 themselves (M2).
  - Today no pinned version can be `active` and no activation can be open, so the step refuses those cases
    (fail-closed). Phase 7 extends L4 to D3's prepared replacement: new versions on R+1 activated in the same
    transaction, and T5 moved to the listed bindings.
  - *Alternative:* no automatic disable; the routes are refused while a `needs_review` version is pinned, and a T4
    disable route is added to v39 (more scope).
- **O5, voiding a confirmation.**
  - *Proposed:* no separate "void" act. A wrong confirmation is corrected by R+1 (L4), or the field is stopped by
    L5 (O3). The wrong proof stays in R's history, with the retirement's reason. `revisionOut` carries no reason, so
    today that reason is readable in the database only; phase 6 may need a read of a retired revision's facts.
  - **L5 must never depend on phase 7's routes.** When phase 7 makes an `active` version or an open activation
    possible, it extends the pinned step of L2 and L5 in the same release (end the activations, disable the
    versions, retire, in one transaction), so that a field can always be stopped, except while O7(ii)(a) holds it
    for an archived club.
- **O6, Q10 part B in v40.** Approve J5.4: the database refuses what part A's services refuse, including an emoji
  with a variation selector (`❤️`) and blank-edged text. The preflight shows 0 before the migration, and the
  migration itself refuses if not.
- **O7, other owners' versions and archived clubs.** The pinned step is the first write of club-owned rows from the
  platform workspace (every M2 write is bound to its own workspace's owner).
  - (i) Is an automatic disable of club-owned `needs_review` versions allowed at all?
    - *Proposed:* yes, only `needs_review` → `disabled`, with the fixed reason, one `mapping_status` row each, and
      answers with counts only (no club, mapping or version id, no `current` in a `409`).
    - *Alternative:* the routes refuse with a count, and the platform admin disables each club's versions in that
      club's workspace through a T4 disable route (more scope; it keeps the owner-scope rule).
  - (ii) A pinned `needs_review` version of an **archived** club, which no one may write (J5.1):
    - (a) *proposed:* `409 club_archived` until the club is restored. The field is then stopped by restoring the
      club, running L2 / L4 / L5, and archiving it again. The `409` names the ids of the blocking archived clubs to
      this caller, an active platform admin who may already list every club. Without them the admin cannot tell
      which club to restore, because an archived club's workspace cannot be opened (`resolveMappingAdmin`,
      `sourceMetricMappingService.js:215-219`). It names no mapping or version;
    - (b) a narrow change of v35's T4 and T8 guards that lets a platform admin write only `→ disabled` with the
      fixed reason for an archived club;
    - (c) archiving a club is refused while it has a `needs_review` or `active` version (a change outside this
      track).
  - (iii) Are the club's admins told? *Proposed:* not in v39. Their Mappings view (phase 6) shows the version
    `disabled` with the fixed reason; a notification is a separate decision.
- **O8, separation of duties.** One platform admin can today create R+1, confirm its unit and meaning (M2b),
  activate it and retire R. The columns `created_by`, `unit_verified_by`, `meaning_verified_by`, `activated_by` and
  `retired_by` are separate, so a rule such as "the activator is not the verifier" is cheap to add.
  - *Proposed:* not required in v39: with one platform admin it would stop the lifecycle. Every act stays
    attributed.
  - *Alternative:* the activator (L3, L4) is neither the unit nor the meaning verifier of that revision.
- **O9, the seed exception** (moved from R4 to the owner by the *Rukovodilac* on 2026-10-27, after the *Nezavisni
  revizor*'s LOW-1: it widens a database authorization guard against v37).
  - *Proposed:* the exception of J5.3 as written (a seed migration's INSERT, with no acting user, inside v34's seed
    window). Every future seeding migration needs its own owner order that names it; this is the rule for every
    migration (plan, section 2), stated here explicitly. The exception is inert until such a migration replaces
    `source_metric_require_seed_window`. `security-reviewer` confirmed the predicate in round 2.

**[RUKOVODILAC] — inside the plan.** Decided by the *Rukovodilac* on 2026-10-27 (its review `425977cd` of this
contract): R1, R2, R3, R6 and R7 as below; R5 as recorded; R4 moved to the owner as O9. They are in C100 with the
owner's answers.
- **R1 — decided:** L4 is one route and one transaction, as D3 describes (not two steps with a pending state).
- **R2 — decided:** a starting status `documented` or `observed` with a reference is allowed at creation, as the
  seeds carry `observed`; the L1 route's default, for a body without `evidenceStatus`, is `unproven` (the column has
  no default, v34 lines 402-404). Under O2 the starting status gates nothing; only `verified`
  does, and the database derives it.
- **R3 — decided as proposed:** the response shapes (J4's revision shape plus `disabledVersions`), the codes and
  their order. The order follows J1 and J5.2: right, path, body keys, request record, locks, the right again, then
  the states.
- **R4 — moved to the owner as O9** (the *Rukovodilac*, 2026-10-27).
- **R5 — decided (the *Rukovodilac*, 2026-10-27, replacing J3b.9's "no v40"):** two migration files in the phase 4
  pull request: v39 the lifecycle, v40 Q10 part B, each with its own rollback, preflight and post-check. The
  reason is `security-reviewer`'s, from round 1. With one file, once the lifecycle had written a revision the
  rollback would be refused, so part B could then only be loosened by a new forward migration. With two files, v40
  can always be rolled back on its own.
- **R6 — decided:** the frontend of the lifecycle (Source fields tab) stays phase 6. v39 is backend only.
- **R7 — decided:** the reads cap a field at 20 revisions (`LIST_CAPS.revisionsPerField`,
  `sourceMetricMappingService.js:78`); with a 21st, `/fields` and `GET /fields/:fieldId` would answer
  `409 result_too_large`. L1 refuses a 21st revision (`409 revision_limit`) until those reads are paged; paging is
  a small separate pull request when it is needed, not part of v39.

---

## J5.7 Not in v39 or v40

- A T4 version's activation or disable route, and T5 writers (phase 7). L4's D3 extension and the phase-7 extension
  of the pinned step (O5) also wait for phase 7.
- The zone model (C89, phase 5). A zone's meaning act stays refused.
- The first production confirmation of a field (C97, M6).
- A T2a create or retire route: a new source field. The nine seeded fields stay.
- The older catalog API's labels (C82, a separate decision).
- The lone-surrogate change of the JavaScript lists (J5.4).
