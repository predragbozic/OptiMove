# J7 — phase 5: the zone model, option A (accepted ★★ contract, C103)

**Accepted on 2026-10-28 (C103 of the discovery document): the owner approved the contract as a whole (gate 1), and
the plan names phase 5b ★★ with its migration v42 (gate 2). Not implemented: no code, no migration yet.** This is the ★★ contract of option A, which the owner chose on
2026-10-28 (C102 of the discovery document, as the *Rukovodilac* reads the owner's words; the variants are
`docs/ai/phase5-zone-model-options.md`). It extends `docs/ai/gpexe-metric-variable-mapping-discovery.md` (the
*discovery document*), sections D3, J1, J4 and J5. Once accepted, it becomes section J7 there and its decisions become
C103. It follows phase 4's pattern (`docs/ai/v39-revision-lifecycle-contract.md`): the owner approves the contract
before any code.

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-28, on the *Rukovodilac*'s order of that day. Revised the same day after the *Rukovodilac*'s review of `d783a3f` (GO WITH CHANGES: one MEDIUM and four LOW, applied in this text; its decisions on P1–P6 are recorded in section 7). The *Nezavisni revizor* reviewed `d783a3f` and `1b1fb8a` (GO, READY WITH NON-BLOCKING NOTES); its LOW notes (the rollback's comments, forward-only after the first zone confirmation, the recovery after a lock timeout) are applied too. |
| Verified against commit | `cf387f2` (merge of PR #251). Every file and line reference below is to that commit. |
| Decides | The owner: the contract as a whole (gate 1) and the plan's ★ and gate line (gate 2). The *Rukovodilac*: P1–P6, inside the plan (section 7). |
| Accepted | 2026-10-28 (C103). Gate 1: ⟦PENDING: the owner's gate 1 words, verbatim, with turn id and time⟧. Gate 2: the owner's own word in the executor's chat, or the owner's own merge of the pull request that records the acceptance. Both reviews gave GO on `8c2b383`. |
| Reviewers of this document | The *Rukovodilac* and the *Nezavisni revizor* (★★). The implementation adds `db-reviewer` (section 3), `security-reviewer` (the replaced actor guard), `code-reviewer`, and `mobile-qa` and `ux-design-reviewer` (section 5). |

**Gates before the implementation:**
1. The owner approves this contract as a whole. P1–P6 are decided inside the plan by the *Rukovodilac* (section 7).
2. The plan names the phase and its migration. The pull request that records the acceptance adds phase 5b ★★ to the
   plan with the gate line "migration v42". A ★ mark and a gate line are never set by relay: that pull request needs
   the owner's own word in the executor's chat, or the owner's own merge (as with PR #240).
3. PR #252 is merged, so C102 is on `main`: done (`0b947ab`).

---

## 1. What exists (verified at `cf387f2`)

### 1.1 The database
- **T2a** (`training_load.source_metric_definitions`, v34
  `migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql:259-352`):
  - one row per field a source offers, identified by `(source_system, api_family, source_metric_key)` (unique, line
    293);
  - the key format `^[a-z][a-z0-9_.]{1,120}$`;
  - created `active` and never deleted (its guard, lines 306-346);
  - a row names its creator or its seed migration, never both.
- **T2b** (`training_load.source_metric_definition_versions`, v34 lines 357-598):
  - `parameter_kind` is `none`, `zone_bounds` or `event_threshold`;
  - `bound_operator` is one of `between`, `>=`, `>`, `<=`, `<` (line 391). It is confirmed in the same act as the
    meaning (`source_metric_revisions_operator_with_meaning`, line 447), and `verified` needs it for a bound
    (`…_verified_iff_proven`, line 449);
  - the v34 guard (lines 481-592) lets a revision be inserted `active` only by a seed migration, without proof;
  - at most one active revision per field (line 473).
- **The seed path.**
  - `source_metric_require_seed_window(p_marker)` (v34 lines 201-207) accepts only v34's own marker, and only while
    v34 is not recorded. So today it refuses every marker.
  - The T2a and T2b guards call it for every row that carries a marker.
  - v39's T2b actor guard lets a seed row through without an acting user (O9 of J5; v39 lines 84-88). Its comment
    says: "inert until a seeding migration replaces `source_metric_require_seed_window()`, and every such migration
    needs its own owner order".
  - A seed writes no T8 row, and v39's deferred links skip it (line 264).
- **The zone refusal (C89).** `source_metric_revisions_actor_guard()`, v39's body (lines 76-153, fired by v37's
  trigger `source_metric_revisions_v37_actor_guard`), refuses every meaning act on a `zone_bounds` revision
  (lines 140-142, `23514`). An event threshold's meaning act needs a one-sided operator (lines 143-146).
- **The mapping side.**
  - The parameter shape (`source_metric_parameters_shape_ok`, v34 lines 108-131) gives a zone an `upper` bound
    exactly when its operator is `between`.
  - A mapping version's source and canonical operators must equal the revision's proven operator
    (`source_metric_check_parameters`, v34 lines 983-985). The canonical side must equal the canonical variable's
    condition (`between` with `min` and `max`, or a one-sided operator with `value`; lines 993-1008).

### 1.2 The API
- **F3** (`backend/src/sourceFieldVerificationService.js`):
  - a zone revision's meaning act answers `409 verification_model_unresolved` (line 278). That happens right after
    the revision is locked, before its state, the operator and the reference are checked;
  - the operator rules: `invalid_operator`, `operator_required` for an event threshold, `operator_not_allowed` for
    a plain field, one-sided for an event threshold (lines 285-288);
  - the request hash names the contract `source-fields/v1` (line 48).
- **M2's version create** (`backend/src/sourceMetricMappingService.js`):
  - it needs the revision's proven bound unit and operator (`409 parameters_not_proven`, lines 1098-1100);
  - it builds a zone's source parameters with `upper` set exactly for `between` (lines 1016-1022);
  - it refuses a canonical operator other than the revision's (`409 parameters_not_equivalent`, line 1139).

  So today no mapping version of a zone field can exist: its revision never gets an operator.

### 1.3 The frontend (phase 6, `cf387f2`, not yet deployed)
- `frontend/source-fields-data.js`:
  - `meaningActOffered` leaves a zone out (lines 95-97), and `meaningBlockedByZoneModel` marks it (lines 99-101);
  - the operator list `OPERATORS` and its labels hold the one-sided operators only (lines 79-80);
  - `buildSourceFieldRequest` sends `boundOperator` only for an event threshold (lines 169-172);
  - `confirmQuestion` names the operator by its symbol (lines 228-234).
- `frontend/source-fields-view.js` shows the disabled *Confirm the meaning* button with "waits for a decision on
  zones" and the code (lines 143-159).

### 1.4 Production (by the owner's statements; the v42 preflight counts it again)
- The nine fields seeded by v34, each with revision 1 `active` and `observed`, no unit or meaning proven (C97).
- No zone revision can carry a meaning proof, because v37 and v39 refuse it.
- No field has been confirmed through F2 or F3 yet.

---

## 2. The model (C102 as built)

- **Three zone fields:**

  | Field | Zones it carries | The operator its meaning act confirms |
  |---|---|---|
  | `more.complementary_data.power.distance` (seeded by v34) | the closed zones, those with an upper extreme | `between` |
  | `more.complementary_data.power.distance.open_top` (new, seeded by v42) | the open top zone, the one whose upper extreme is null | `>=` |
  | `more.complementary_data.speed.distance` (seeded by v34) | the open zone `[7, ∞)` m/s | `>=` |

- **Nothing existing is rewritten.** The two seeded zone fields and their revision 1 stay as they are; their meaning
  act gets an operator, as any meaning act does.
- **The operator is the revision's proven fact**, written once with the meaning by a platform admin, on evidence
  (Z4, C97). A zone's meaning act takes `between` or `>=` (Z3; `>` follows Z3 too, P1).
- **No binding of a field to its operator in the database** (P4). The database cannot tell a closed-zone field from
  an open one without a new column.
  - **What the operator equality catches:** the mapping version's operator must equal the revision's (v34 line 983).
    So a `>=` on the power field can never map a closed zone, and a `between` on `.open_top` can never map the open
    zone.
  - **What it does not catch (the residual):** a `>=` wrongly confirmed on the power field can still be mapped to a
    canonical variable of the open shape, for example ≥ 25 W/kg. The operator equality passes and M2 accepts it.
    Nothing refuses it until the extractor registry (7f) reads the power key by its zone shape (below). Until M4 no
    fact is written, so today this changes no data.
  - The correction of a wrong proof is a new revision (C91, phase 4). The form explains the choice (section 5).
- **Unchanged:** v34's CHECKs and parameter shape, the T4 trigger and its operator equality (C38), the parameter
  fingerprint, the mapping contract (D6, D7), M2, F1 and F2.
- **For later phases (not built here):**
  - **7f, the extractor registry — an obligation of its contract, with its own test:** the rule "key → zone shape".
    For the power key it reads only the zones whose upper extreme is set; for the `.open_top` key, exactly the zone
    whose upper extreme is null. More than one such zone, or a zone of the wrong shape, is a refusal, never a guess.
    The speed key reads its open zone. A mapping version whose operator does not fit its key's shape (the residual
    above) is refused there.
  - **M4, the importer:** the current GPEXE mapper (`GPEXE_METRIC_SPECS`) is unchanged until M4.
  - **A closed speed zone**, if one is ever wanted, gets its own field by a later seeding migration, on the same
    convention.

---

## 3. Migration v42

### 3.1 The file
`migrations_v2/<timestamp>_training_load_v42_source_metric_zone_model.sql`. The timestamp is set at implementation and
sorts after v41 (`202610281000`). It is one transaction (the runner's), under the runner's lock timeout.

### 3.2 What it does, in order
1. **Fail closed.**
   - It locks T2a and T2b `SHARE ROW EXCLUSIVE`, so no revision or field is written between its checks and its
     seed. Those writes are F2 / F3 and L1–L5, all short. If a lock is not granted within the runner's lock timeout,
     the migration fails, nothing of it is written, and it runs again on the next start.
   - It refuses (`23514`, a fixed message) when a T2a row with the new key already exists, or when any `zone_bounds`
     revision already carries a meaning proof or an operator.
2. **The seed window.** It replaces `source_metric_require_seed_window(p_marker)`: v42's own marker passes while v42
   is not recorded, and every other marker is refused (`42501`), as v34's body does for v34. Once v42 is recorded,
   every marker is refused again, so the seed path closes behind it.
3. **The seed (Z2).**
   - One T2a row:
     - `gpexe` / `rest_v1` / `more.complementary_data.power.distance.open_top`;
     - the label "Power zone distance (open top zone)";
     - v42's marker.
   - Its T2b revision 1, as v34 seeded its parent:
     - `zone_distance` / `zone_bounds`, session and drill;
     - the expected unit `m` and expected bound unit `W/kg` (a hypothesis);
     - the unit note of P3;
     - `observed`, with the reference of P2;
     - `active`, `activated_at` now, v42's marker, no proof.
   - No T8 row, as for every seed.
4. **The zone rule (Z3).** It replaces `source_metric_revisions_actor_guard()` with v39's body, changed in one
   branch only. A meaning act on a `zone_bounds` revision needs `bound_operator` in (`between`, `>=`); otherwise it is
   refused with `23514`, 'source_metric_definition_versions: a zone takes the operator between or >='. Every other
   branch stays byte for byte as in v39: the insert path, the seed exception, the lifecycle, the actor checks, the
   event threshold and the first reference.
5. **Comments** on the two functions name v42 and C102.

### 3.3 What it does not touch
- No table, column, constraint, index or trigger is added or dropped. The trigger names stay, and only the two
  function bodies change.
- v34's T2a and T2b guards, v37's and v39's T8 guard and deferred links, v35, v36, v38, v40 and v41 stay as they are.

### 3.4 Rollback (`docs/runbooks/source-metric-zone-model-v42-rollback.sql`)
- **It refuses, changing nothing, when:**
  - v42 is not recorded, or a later `migrations_v2` migration is;
  - any `zone_bounds` revision carries a meaning proof or an operator (only v42 allows one, and the restored v39 rule
    would forbid it);
  - the `.open_top` field is not exactly its seed: another revision, a proof, a retirement, a changed label, or any
    T3, T4, T5, T6 or T8 row naming the field or its revision.
  - any trigger of T2a or T2b is already disabled when it starts (fail closed on the state it finds).
- **Then, in one transaction** (run as `psql --single-transaction` in a quiet moment):
  - it disables exactly the two v34 guards that refuse a DELETE, by name (`alter table … disable trigger
    source_metric_revisions_guard` and `… source_metric_definitions_guard`), for this transaction only;
  - it deletes the seeded revision, then the field;
  - it enables both again and checks `tgenabled` of every trigger of the two tables before COMMIT;
  - it restores v39's body of `source_metric_revisions_actor_guard()` and v34's body of
    `source_metric_require_seed_window()`, and their comments as v41 has them (none: `comment on function … is null`
    for both), since `create or replace` keeps a comment;
  - it deletes v42's record.
- **After it, v41's catalog and data come back exactly**, so v42 can be applied again. This is rehearsed in the tests.
- **v42 is forward-only once any zone revision carries a meaning proof**, the seeded power and speed fields included,
  which is the normal path after the first real confirmation of a zone: the rollback refuses, and a correction is a
  later migration (as v37 after a verification and v39 after a lifecycle write).
- A restoring rollback was decided by the *Rukovodilac* (P5).

### 3.5 Preflight and post-check (read-only, in the Supabase SQL Editor)
- **Preflight** (`…-v42-preflight.sql`):
  1. PostgreSQL 15 or later, as v41 already needs;
  2. v41 is the last migration, recorded once with the repository's checksum, and v42 is absent;
  3. v34's seed-window body and v39's actor-guard body are the current ones;
  4. the nine v34 fields and no other T2a row; no T2a row with the new key;
  5. no `zone_bounds` revision with a meaning proof or an operator;
  6. the migrator's role owns T2a and T2b and may replace the two functions;
  7. informational: the T3, T4, T5, T6 and T8 counts (numbers only);
  8. no actor default;
  9. a quiet moment: no lock on T2a or T2b held by another session, no idle transaction.
- **Post-check** (`…-v42-postcheck.sql`):
  1. v42 recorded once with its checksum, and it is the last migration;
  2. the two function bodies carry v42's rules;
  3. the seed window refuses every marker, v42's included;
  4. ten T2a rows; the new one exactly as seeded; the nine v34 rows and their revisions unchanged;
  5. every trigger of T2a and T2b is enabled;
  6. no T8 row names the new field, and no proof was written;
  7. no actor default and no lock left.

### 3.6 Deploy order (runbook `docs/runbooks/source-metric-zone-model-v42.md`)
1. The owner's preflight the same day.
2. The owner's order naming the pull request and v42.
3. The merge from exactly the reviewed head.
4. The deploy, started by the owner by hand. `npm start` runs the migration before the server, so the new server
   never meets v41.
5. The *Rukovodilac*'s smoke.
6. The owner's post-check.

While the old server still serves during the deploy, it refuses a zone's meaning act (`409`), and its database
refuses it too until v42 commits. No mixed state can save a zone operator outside Z3.

**Recovery when v42 fails on the lock timeout during the deploy** (in the runbook, as for v40). The new server does not
start until the migration passes (`npm start` is the migration and then the server), nothing of v42 is written (one
transaction), and the old server keeps serving.
1. Check that no session holds a lock on T2a or T2b (the preflight's block 9).
2. Run the deploy again in a quiet moment.
3. If it fails the same way again, report to the owner. No manual change in the database.

---

## 4. The API (F3)

| | Today | With v42 |
|---|---|---|
| A zone's meaning act | `409 verification_model_unresolved`, whatever the body | needs `boundOperator`: `between` or `>=` |
| A zone without `boundOperator` | the `409` | `400 operator_required`, with a zone text |
| A zone with `>`, `<=` or `<` | the `409` | `400 invalid_operator`, with a zone text: "A zone takes between (a closed zone) or >= (the open top zone)." |
| An unknown operator | `400 invalid_operator` for a plain field and an event threshold; for a zone, the `409` | `400 invalid_operator` for every kind |
| An event threshold, a plain field | as J4 | unchanged |

- **Order of the checks:**
  1. as today, the right (`404`), the path ids, the body's keys and `requestKey`, the request record and the
     revision (`404`);
  2. then the state (`revision_retired`) and `meaning_already_verified`;
  3. then the operator rules, by the revision's kind;
  4. then the reference, the right's re-check and the write.

  The code `verification_model_unresolved` is no longer answered.
- **The request hash** keeps the contract `source-fields/v1`. A zone's meaning act was never saved before v42 (its T8
  row is the request record, and it is written only on success), so no saved key can meet a new rule.
- **The status** follows C92: `verified` when the unit (with its bound unit) is already proven.
- **No route is added, and no other route changes.** M2's version create works for a zone once both proofs exist,
  with no change.

---

## 5. The frontend (the phase 6 meaning form)

- **The act.** *Confirm the meaning* is offered for a zone revision on the same terms as any other: a platform admin
  in the platform workspace, an active field, a revision that is not retired, and no meaning yet.
  `meaningBlockedByZoneModel` and the "waits for a decision on zones" texts go.
- **The operator choice for a zone**, required and with nothing preselected:
  - "Between its lower and upper bound — a closed zone (between)";
  - "At least its lower bound — the open top zone (>=)".

  The form says: "A closed zone and the open top zone are separate source fields. Choose what this field's evidence
  shows. It is saved for good; a wrong choice cannot be mapped, and the correction is a new revision."
- **The last question names the operator in words**, for a zone and for an event threshold. This also closes phase
  6's LOW note.
- **The detail** shows a confirmed zone operator in the same words. The code text of `invalid_operator` depends on the
  revision's kind.
- **Unchanged:** the unit act, the outcomes (*Result not confirmed* · *Check result* with the same request), the
  leave guards, and the club admin's read-only view.

---

## 6. Tests and acceptance

- **The migration** (a new disposable suite, `source-metric-zone-model-v42.test.mjs`, from a database migrated
  through v41):
  - the preflight on v41;
  - v42 applies: the seed row and revision exactly;
  - after COMMIT the seed window refuses v42's marker and every other;
  - the post-check passes;
  - each rollback refusal; the rollback itself, after which v41's catalog (the two function bodies and their
    `obj_description` included) and the T2a / T2b content digests match exactly;
  - v42 re-applies;
  - a dump and restore of a v42 database.
- **The database rule:**
  - a zone's meaning act with `between` or `>=` is saved (with the acting platform admin);
  - `>`, `<=`, `<` and NULL are refused with `23514`;
  - the event-threshold rule, a plain field, the actor checks (`42501`), the first reference and the lifecycle are
    unchanged;
  - the seed path stays closed after v42.
- **F3 through the real route:**
  - `between` on the power field, and `>=` on `.open_top` and on speed;
  - each refusal of section 4;
  - the identical `404` for a club admin;
  - the replay and the request key;
  - the status `verified` after both acts;
  - one T8 row per act.
- **End to end, through M2:**
  - after the unit and meaning proofs, a version of a closed zone (25–60 W/kg) on the power field and of the open zone
    (≥ 75 W/kg) on `.open_top` are created;
  - a version that asks for the other operator is refused (`409 parameters_not_equivalent`; `23514` from T4 if forced).
- **The frontend:**
  - the zone form, its operator choice and request body, the last question and the texts;
  - the existing phase 6 tests that expect the zone block, updated;
  - a browser integration run on a disposable database through v42 at 1280 / 390 / 375 / 360 px.
- **Existing tests** whose expectations change with v42 are updated in the same pull request, each named in it. Known
  today:
  - `backend/tests/source-field-verification-m2b.test.mjs` expects `verification_model_unresolved` in four places:
    test 3 (line 562) and test 7 (its title at line 651, and lines 660 and 667);
  - `frontend/tests/source-fields.actions.test.mjs` expects the zone block in its offered-acts test (line 226, and
    "Meaning waits for the zone decision" at line 173).

  A suite migrated only through an earlier version is unchanged.
- **Documents updated in the implementation pull request:** J4's table of what the seeded fields still need (discovery
  document, section J4) and the C97 list each gain a row for `.open_top`; C89 is marked as lifted by v42.
- **Mutations:** the zone set in the database and in F3, the seed window's marker, the rollback's refusals, and the
  form's offer and body.
- **Acceptance:** all of the above; internal reviews; the *Rukovodilac*'s and the *Nezavisni revizor*'s reviews
  (trigger 1); the owner's order naming the pull request and v42; preflight, merge, deploy, smoke and post-check.
  The first real confirmation of a zone field stays a separate order, with the evidence of Z4 / C97.

---

## 7. Questions and their decisions

The *Rukovodilac* decided P1–P6 in its review of `d783a3f` (2026-10-28), inside the plan. What stays the owner's is
gate 1 (approving this contract as a whole) and gate 2 (the ★ and the gate line, by the owner's own word or merge).
- **P1 — `>` for a zone: follows Z3, not a new question.** v42 accepts `between` and `>=` only. If the evidence ever
  shows that GPEXE's top zone excludes its lower bound, a later migration adds `>`, by the owner's own order. There is
  no such evidence today, and a `>` revision could map only a canonical variable whose condition is `>` (the operator
  equality), so it would bring a canonical change with it.
- **P2 [RUKOVODILAC] — the new field's evidence at seed: decided as proposed.** `observed`, with the parent's
  reference `docs/ai/gpexe-rest-v1-compatibility.md#2-the-table`, as v34 seeded the parent. The open top zone is an
  element of the same observed `/more/` array.
- **P3 [RUKOVODILAC] — the new revision's unit note: decided as proposed.** "Expected unit is a hypothesis from the e03
  pilot; not proven on server3. The open top zone of the power zone list: the zone whose upper extreme is null." Its
  first sentence is the parent's note.
- **P4 [RUKOVODILAC] — no database binding of a field to its operator: decided.** The residual of section 2 is
  recorded, and the rule "key → zone shape" is an obligation of 7f's contract, with its own test. A check keyed on
  the field's key would put a naming convention into the database.
- **P5 [RUKOVODILAC] — a restoring rollback: decided**, with the conditions of section 3.4 (a trigger already disabled
  is a refusal; exactly the two named guards; `psql --single-transaction` in a quiet moment; `tgenabled` checked
  before COMMIT).
- **P6 [RUKOVODILAC] — one ★★ pull request: decided.** Migration v42, F3, the frontend form and the documents together,
  as phase 4 was. A separate frontend pull request would leave a deployed API whose form still says "waits for a
  decision". The owner's order for the migration names the pull request and v42.

Decided already, so not asked again:
- the key and the label of the new field (Z2);
- that nothing existing is rewritten, the power field's label included (the *Rukovodilac*'s LOW note of `d80ca8f`);
- the evidence each zone field needs (Z4).

---

## 8. Not in it

- The owner-run evidence for the zone fields (Z4, C97) and the first real confirmation: a separate order.
- The extractor registry (7f), the importer (M4) and the Mappings tab (phase 8).
- A closed speed zone field (section 2).
- Any change to a seeded field's label, key or revision.
- `>` for a zone (P1, following Z3).
- Any write to a persistent database by the executor.
