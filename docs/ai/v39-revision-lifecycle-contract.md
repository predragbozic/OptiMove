# J5 — v39: the source-field revision lifecycle (C91) and Q10 part B

**A proposed contract, not accepted.** This is phase 4's discovery delta of `docs/ai/metrics-core-plan.md` (★★):
the owner approves the contract before any code. It extends `docs/ai/gpexe-metric-variable-mapping-discovery.md`
(the *discovery document*), whose sections D3, J1, J2 and J4 it builds on; when it is accepted, its decisions are
written into that document's section C, as R2's were (C99).

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-27, on the *Rukovodilac*'s order of that day. Not accepted. No code, migration or data change. |
| Verified against commit | `fdc2c2e` (merge of PR #237). Every file and line reference below is to that commit. |
| Decides | The owner: the questions marked **[OWNER]** (red zone). The *Rukovodilac*: the questions marked **[RUKOVODILAC]** (inside the plan). |
| Reviewers of this document | The *Rukovodilac* and the *Nezavisni revizor* (★★), `code-reviewer`; `db-reviewer` for J5.3 and J5.4. |

**Gates before the implementation** (plan, phase 4 "Input"):
1. the owner's answers to O1–O6 (J5.6);
2. the v37 production post-check passed (phase P; not recorded yet);
3. the old Render service clarified: which database it uses (phase 1, b).

---

## J5.1 What exists (verified at `fdc2c2e`)

**T2b, `training_load.source_metric_definition_versions`** (v34, `migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql:357-597`; its guard `source_metric_revisions_guard`, lines 481-596):
- states `draft → active → retired` and `draft → retired`; at most one active and one draft revision per field
  (partial unique indexes `source_metric_revisions_one_active`, `…_one_draft`);
- a revision is inserted as `draft`, without proof, only for an active field (T2a); only a seed migration inserts
  one `active` (lines 490-512);
- the contract of a revision (shape, parameter kind, levels, the hypothesis) is immutable; the proof is written
  once; the evidence status only rises (lines 518-545);
- **activation** needs an active field, no other active revision, and `activated_by_user_id` an active platform
  admin (lines 556-567, 587-589);
- **retirement** needs `retired_by_user_id`, `retired_at` and `retired_reason` (the state-facts CHECK) and is
  refused while a mapping version pinned to the revision is `needs_review` or `active` (lines 568-575). v34
  checks no actor for a retirement;
- a verification is its own act, never together with a state change (lines 546-550).

**v37** (`migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql`) refuses every T2b
INSERT and every state change (`source_metric_revisions_actor_guard`, lines 64-104): the only T2b writes are
the two verification acts (C90). Its T8 guard refuses every action without a built chain, the revision actions
included (lines 132-134). Its rollback refuses once a verification exists.

**T8** (v34: the shapes at lines 1630-1670, the table from line 1675) already defines the revision actions and their shapes:
- `source_metric_revision_create`: T2a and T2b, from nothing to `draft`, `platform_admin`;
- `source_metric_revision_activate`: `draft → active`, `platform_admin`;
- `source_metric_revision_retire`: `draft` or `active` → `retired`, a reason, `platform_admin`;
- `mapping_status` (… `→ disabled` with a reason, `platform_admin`) and `mapping_version_replaced`
  (`needs_review → active`, a reason).

**T4, the mapping versions** (D6; v34 lines 756-1220):
- statuses `draft → needs_review → active → disabled` (`disabled` from any of the other three);
- a version is created only on a `draft` or `active` revision with a **proven unit**, submitted only while its
  revision is not retired (v34 lines 1053-1054, 1156-1159; M2 `backend/src/sourceMetricMappingService.js:1094-1097`);
- `active` needs the revision `active` and `verified` (lines 1168-1176); `disabled` needs no open activation
  (T5) and a platform admin (lines 1193-1205);
- v35 guards every status change by the acting user and its audit row (J2). While a club is archived, no one
  writes a transition of its mappings (J2, "the derived basis").

**What can exist in production today:**
- the routes create a T4 `draft` and submit it (`needs_review`) (J1); **no route activates or disables a
  version, and nothing writes T5**. So a version pinned to a revision is `draft` or `needs_review`, never
  `active`, and no activation is open;
- the nine seeded revisions (D12): revision 1, `active`, seeded, `unproven`; no field is confirmed (C97);
- T3, T4 and T8 were empty at the v36 post-check (2026-10-14); not re-verified since. The v39 preflight counts
  them.

**The text functions** (v34, lines 69-84):
- `source_metric_text_ok(v, max)`: `v = btrim(v)` (which trims only U+0020), 1 to `max` characters, none of
  C53's list;
- `source_metric_unit_token_ok(v)`: 1-30 characters, none of `\s`, `|`, `=` and its own list.

They are used by CHECKs of T2a, T2b, `unit_conversions`, T4, T5, T6 and T8 (v34) and by v38's request and
change guards (`…_v38_metric_variable_changes.sql:283, 359-363`). Q10 part A (PR #229) made the services and
the frontend stricter (`backend/src/metricTextRules.js`, J3b.9); the database still accepts what part A refuses.

---

## J5.2 The lifecycle (proposed)

Every operation is a platform admin's in the platform workspace (O1), with J1's access rules: `401`, the
identical `404 {"error":"notFound"}`, `415 jsonRequired`, `Cache-Control: no-store`, a `requestKey` whose T8
row is the request record (one key space with M2 and M2b), the bounded COMMIT and its check (C79), and the right
checked again before the answer.

| # | Route (under `/api/training-load/sources/metrics`) | What it does | T8 |
|---|---|---|---|
| L1 | `POST /fields/:fieldId/revisions` | creates revision R+1 as `draft` | `source_metric_revision_create` |
| L2 | `POST /fields/:fieldId/revisions/:revisionId/retire` | retires a `draft` (abandoned) | `source_metric_revision_retire` |
| L3 | `POST /fields/:fieldId/revisions/:revisionId/activate` | activates a `draft` when the field has no active revision | `source_metric_revision_activate` |
| L4 | `POST /fields/:fieldId/revisions/:revisionId/replace` | the active R → `retired` and the draft R+1 (`:revisionId`) → `active`, with the versions pinned to R handled by O4 | `source_metric_revision_retire`, `…_activate`, and one `mapping_status` per version |
| L5 | `POST /fields/:fieldId/revisions/:revisionId/retire` on an `active` R | only if O3 allows a field without an active revision | `source_metric_revision_retire` |

**L1, the body:** `requestKey`, `valueShape`, `parameterKind`, `supportsSession`, `supportsDrill`, and optional
`expectedSourceUnit`, `expectedSourceBoundUnit`, `unitNote`, `evidenceStatus` (`unproven`, `documented` or
`observed`) with `evidenceRef` (required unless `unproven`). The server sets `revision_number` (the next number).
It is refused while the field has a draft (`409 draft_exists`) or is not active (`409 field_not_active`). The
shape rules are v34's (`400 invalid_body`, `invalid_unit`, `invalid_evidence_ref`).

**L4, one transaction:**
1. the per-user lock, then the request record;
2. T2a `FOR SHARE`; R and R+1 `FOR UPDATE` (ascending id);
3. the T3 rows of the versions pinned to R `FOR SHARE`, then those versions `FOR UPDATE` (ascending id);
4. the acting user's rows `FOR SHARE` (the right again);
5. by O4: each pinned `draft` or `needs_review` version → `disabled`, with the reason "source revision replaced",
   and its `mapping_status` row;
6. R → `retired` (its reason, the request's), and its row;
7. R+1 → `active`, and its row;
8. the bounded COMMIT.

Refusals:
- `409 revision_not_active` (R) or `revision_not_draft` (R+1);
- `409 activation_open` or `version_active`: a version pinned to R is `active`, or has an open activation. This
  cannot happen before phase 7, which extends L4 to D3's full replacement;
- `409 club_archived`: a pinned version belongs to an archived club (J2: no one writes it);
- `409 evidence_lower`: O2;
- `try_again`, `request_key_reused`, `503 outcome_unknown`, `500 internal_error` as in J1.

Versions created on R+1 before L4 (allowed today: a draft revision with a proven unit) are untouched.

**What does not change:**
- old facts and old versions stay pinned to R;
- R+1 inherits nothing;
- a verification stays a separate act (M2b);
- no route reaches a `needs_review → active` version transition or T5. They stay phase 7's.

---

## J5.3 The database part of v39 (proposed)

- **T2b:** v37's `source_metric_revisions_actor_guard` is replaced (`create or replace`, same trigger). Besides the
  two acts it allows:
  - an INSERT of a `draft`, whose `created_by_user_id` is the acting user (the v35 setting), an active platform
    admin (`42501`). A seed-migration INSERT (`seed_migration` set, no acting user) stays v34's: it is allowed
    only inside the seed window, as before v37. That is **R4**;
  - `draft → active` with `activated_by_user_id` = the acting user;
  - `draft | active → retired` with `retired_by_user_id` = the acting user. v34 checks no actor for a
    retirement, so v39 adds it here;
  - nothing else: a state change and an act are never one update (v34), and every other update stays refused
    (`23514`).
- **T8:** v37's `source_metric_audit_revision_guard` is replaced. A `source_metric_revision_create`, `…_activate`
  or `…_retire` row must follow its own write in the same transaction (`xmin`). It names the revision, its
  field, the matching from / to state and the acting user, and there is one row per transition (a unique partial
  index, as v37's `…_verification_once`). The other actions keep their chains (v35, v37), and actions without a
  writer stay refused.
- **At COMMIT** (deferred, as v37's `…_audit_link`): every revision INSERT has its `…_create` row and every state
  change its `…_activate` / `…_retire` row, or the transaction rolls back (`23514`).
- **A savepoint** fails closed, as in v35 and v37.
- **No table, column or data change.** v34, v35, v36 and v38 objects are unchanged. v37's functions are
  replaced, and their v37 bodies are restored by the rollback.
- **The rollback** refuses once:
  - any revision was written by the lifecycle (a `created_by_user_id`, an `activated_by_user_id` or a
    `retired_by_user_id`), or
  - a later migration is recorded.

  It is forward-only after that, as v37's rollback is after a verification.
- **The tests** of the M1, M2, v35, M3-0 and M2b suites stop switching v37's T2b triggers off. They write their
  revisions through the real lifecycle path (plan, phase 4).

---

## J5.4 Q10 part B: the database twins (a separate part of v39)

The *Rukovodilac*'s decision of 2026-10-27, recorded in J3b.9: part B goes into v39 as its own part. The owner
approves it with this contract (O6).

- **The functions:** `create or replace` with the same signatures and `language sql immutable`:
  - `source_metric_text_ok(v, max_len)`:
    - v34's list plus Q10's groups (J3b.9);
    - `v = btrim(v)` is replaced by "no character of `TEXT_EDGE_BLANK` at either end": U+0020, U+00A0, U+1680,
      U+2000-U+200A, U+202F, U+205F, U+3000;
  - `source_metric_unit_token_ok(v)`: v34's list plus Q10's groups.

  The lists are written with PostgreSQL's `\uXXXX` and `\UXXXXXXXX` escapes inside one bracket expression, and
  are the same characters as `backend/src/metricTextRules.js`. PostgreSQL's regular expressions have no Unicode
  properties, so the list is explicit.
- **Parity, by a test:** every code point is compared between the SQL functions and `metricTextRules.js`, on a
  disposable database, in batches. That covers U+0001-U+10FFFF without the surrogates, which UTF-8 cannot hold,
  and U+0000, which PostgreSQL text cannot hold. It also covers both lengths at the limit (code points, as
  `char_length`).
- **Existing rows:** a CHECK is not re-validated when its function is replaced, so a row the stricter function
  refuses would stay. It could then no longer be updated. The read-only **preflight block** of v39 counts such
  rows, column by column. Expected 0:
  - T2a `source_label`, `retired_reason`;
  - T2b `expected_source_unit`, `source_unit`, `expected_source_bound_unit`, `source_bound_unit`, `unit_note`,
    `retired_reason`;
  - `unit_conversions` `from_unit`, `to_unit`, `retired_reason`;
  - T4 `source_unit`, `target_unit`, `conversion_note`, `disable_reason`, and the `unit` of `source_parameters`
    and `canonical_parameters`;
  - T5 `reason`, T6 `source_unit`, T8 `reason`;
  - `metric_variable_requests.reason` (v38);
  - and, as information only (v38 exempts an unchanged name, J3b.9), the names of every `system` and `club`
    definition and the units of their current versions.

  A count above 0 stops the migration until the owner decides.
- **The rollback** restores v34's two function bodies verbatim. It is allowed while no row depends on the
  stricter rule; that is always true, since the stricter rule only refuses.
- **The services already apply the rule** (part A); after part B the database refuses the same text, whoever
  writes it.

---

## J5.5 Acceptance (plan, phase 4, and Q10 part B)

- The rollback is rehearsed: apply → rollback → an identical catalog → re-apply, for both parts.
- Every guard has a mutation that the tests kill.
- Concurrency, in both orders:
  - L4 against an M2 version create on R and on R+1;
  - L4 against an M2 submit on R;
  - L4 against an M2b act on R and on R+1;
  - L1 against L1.
- None of the nine seeded fields changes.
- Access, the identical 404 and the request record are tested as in J1 and J4.
- The SQL lists are tested for parity with `metricTextRules.js` on every code point.
- The preflight block is run on a disposable copy that holds a row of each listed column.
- The tests run on PostgreSQL 16 and, where possible, 17.

---

## J5.6 Questions

**[OWNER] — red zone, before any code:**
- **O1, who.** Who may create, activate, retire and replace a revision.
  - *Proposed:* an active platform admin in the platform workspace, as for M2b's acts (C94). Never a club admin.
- **O2, what R+1 needs to replace R.**
  - *Proposed:* the active revision's evidence status never goes down. A verified R is replaced only by a verified
    R+1 (its unit and meaning confirmed first, M2b). An unproven R, such as a seed, may be replaced by an R+1 of
    any status.
  - *Alternative:* R+1 must always be verified.
- **O3, a field without an active revision.** May an active R be retired with no successor (L5)? Then no new
  version of that field can become active until a new revision is activated (L3).
  - *Proposed:* yes, with a reason. It is the clean way to stop a field whose proof turned out wrong.
- **O4, the versions pinned to R.**
  - *Proposed:* L4 disables every `draft` and `needs_review` version pinned to R, automatically, with a fixed
    reason. The mapping owners then create versions on R+1 themselves (M2).
  - Today no pinned version can be `active` and no activation can be open, so L4 refuses those cases
    (fail-closed). Phase 7 extends L4 to D3's prepared replacement: new versions on R+1 activated in the same
    transaction, and T5 moved to the listed bindings.
  - *Alternative:* no automatic disable. L4 is refused while a `needs_review` version is pinned to R; a T4 disable
    route would then be needed in v39 (more scope).
- **O5, voiding a confirmation.**
  - *Proposed:* no separate "void" act. A wrong confirmation is corrected by R+1 (L4), or the field is stopped by
    L5 (O3). The wrong proof stays in R's history, with the retirement's reason.
- **O6, Q10 part B in v39.** Approve J5.4: the database refuses what part A's services refuse, including an emoji
  with a variation selector (`❤️`) and blank-edged text. The preflight shows 0 before the migration.

**[RUKOVODILAC] — inside the plan:**
- **R1:** L4 as one route, or as two steps (activate and retire) with a pending state.
  - *Proposed:* one route, one transaction, as D3 describes.
- **R2:** the L1 body. Is the starting evidence status (`documented` / `observed` with a reference) allowed at
  creation, or always `unproven`?
- **R3:** the response shapes (J4's revision shape), the codes and their order. The order follows J1: right,
  path, body keys, request record, then the states.
- **R4:** a future seeding migration. It stays v34's seed window, with no acting user; v39 keeps an explicit
  exception for it.
- **R5:** in one migration file (v39) or two (v39 and v40), the lifecycle part and Q10 part B.
  - *Proposed:* one file with two clearly separated parts, each with its own preflight block and its own rollback
    part.
- **R6:** the frontend of the lifecycle (Source fields tab) stays phase 6. v39 is backend only.

---

## J5.7 Not in v39

- A T4 version's activation or disable route, and T5 writers (phase 7). L4's D3 extension also waits for phase
  7.
- The zone model (C89, phase 5). A zone's meaning act stays refused.
- The first production confirmation of a field (C97, M6).
- A T2a create or retire route: a new source field. The nine seeded fields stay.
- The older catalog API's labels (C82, a separate decision).
