# Phase 5: the zone model (C89) — options for the owner's decision

| | |
|---|---|
| Status | **Draft for the *Rukovodilac*'s review, then the owner's decision.** No code, no migration. |
| Plan | `docs/ai/metrics-core-plan.md` §5, phase 5: "An owner decision only; the executor prepares the variants. Red zone: the decision. If it needs a schema, that is a separate ★★ phase on the pattern of phase 4." |
| Verified against | `3532bc5` (merge of PR #249). Every fact below names its file and line. |

## 1. The question

A source revision (T2b, `training_load.source_metric_definition_versions`) proves **one** `bound_operator` for its
parameter. A GPEXE zone field delivers a list of zones, and the zones do not share one operator:

- **Power** (`more.complementary_data.power.distance`): three canonical zone variables, `25–60` and `60–75` W/kg
  (closed: `between`) and `≥ 75` W/kg (open top zone: `>=`). Discovery table, `gpexe-metric-variable-mapping-discovery.md:272`.
- **Speed** (`more.complementary_data.speed.distance`): one canonical variable, `[7, ∞)` m/s (open top zone only).
  Same table, line 273.

A mapping version is valid only when its operator equals the revision's proven operator, on both sides
(`source_metric_check_parameters`, v34, `migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql:983`).
So with one operator per revision the power field can map either its closed zones or its open zone, never both.
C89 (`gpexe-metric-variable-mapping-discovery.md:769`) therefore blocks a zone's meaning act until this is decided.

## 2. What stands today (all merged and deployed)

- **v34:** `bound_operator` is one of `between`, `>=`, `>`, `<=`, `<` (`…v34…sql:389-391`). It is NULL until the
  meaning is verified, and required for `verified` (`…v34…sql:448`, `:451`).
- **v37:** the database refuses every zone meaning act (`23514`,
  `migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql:90-92`).
- **F3:** the API answers `409 verification_model_unresolved` for every zone revision
  (`backend/src/sourceFieldVerificationService.js`). The phase 6 screen shows the button as not possible yet, with that
  code.
- **A zone's unit:** it may be confirmed now, with its bound unit (F2).
- **The canonical side:** a zone variable's `condition_description` is `between` with `min` and `max`, or one
  one-sided operator with a value (M3-0, `gpexe-metric-variable-mapping-discovery.md:745`). Each zone is its own
  canonical variable (`:1670`).
- **What the import compares:** the mapper compares the zone `extremes` GPEXE delivers with the version's bounds
  exactly (`:1676-1680`). OptiMove never sorts single samples into zones: GPEXE delivers each zone's distance already
  summed. So the inclusivity of a bound (`[25, 60)` against `(25, 60]`) changes no number OptiMove stores. It is part
  of the meaning, and so of the evidence.

## 3. What every option needs

- **The guard.** A migration replaces v37's blanket zone refusal with a rule for the zone operators the option allows.
  F3's `verification_model_unresolved` goes away, or is narrowed.
- **The evidence.** For each zone field, a merged document that proves the operator and the inclusivity convention
  GPEXE applies (C97's pattern: the GPEXE UI or documentation against the server3 answer, sanitized). This is
  owner-run; the executor only prepares the procedure.
- **The phase 6 screen.** The zone meaning form gets an operator choice, limited to what the option allows.
- **A ★★ phase.** Any of the options is one: a contract approved by the owner before code, external review, and the
  owner's order naming the migration. This follows the pattern of phase 4.

## 4. The options

### A. One source field per zone shape (recommended)

The power field is split by the shape of its zones:
- the existing `more.complementary_data.power.distance` keeps the **closed** zones (`between`);
- a new field, for example `more.complementary_data.power.distance.open_top`, holds the **open top** zone (`>=`).

The speed field stays one field (`>=`), since it has only the open zone.

- **Migration:**
  - one seeded T2a field and its revision 1, through v39's seed path (O9: a seeding migration replaces
    `source_metric_require_seed_window()`, `…v39…sql:18-23`);
  - v37's zone refusal replaced by "a zone's meaning act takes `between` or `>=`" (or `>`, see Z3).
- **Unchanged:**
  - v34's CHECKs, the T4 trigger and its operator equality (`…v34…sql:983`);
  - the parameter fingerprint;
  - the mapping contract (D6, D7).
- **The importer (M4, phase 9):** for the power key, the extractor reads only the zones whose upper extreme is set, and
  for the `.open_top` key only the zone whose upper extreme is null. It is a selection rule in the extractor registry
  (7f), with its own test.
- **For:**
  - the guarded core of the mapping stays as it is (one proven operator per revision, equality in the trigger);
  - each zone shape has its own evidence and its own write-once proof;
  - it is the smallest database change.
- **Against:**
  - one GPEXE array becomes two OptiMove fields, a modelling convention that must be documented and kept in the
    extractor;
  - one seeded row.

### B. The zone operator moves from the revision to the mapping version

For a zone revision, the meaning act confirms a convention ("closed zones are `between`, the top zone is open") with no
single operator. The T4 trigger then derives the operator from each zone: `between` when an upper bound is set,
otherwise the confirmed open operator.

- **Migration:**
  - v34's CHECKs for zones change: `bound_operator` is NULL even when verified (`:448`, `:451`);
  - a new column for the open-zone operator, or a convention marker;
  - `source_metric_check_parameters` changes for `zone_bounds` (`:983`);
  - v37's guard changes.
- **Changed besides:**
  - F3's body for zones;
  - M2's version create;
  - the phase 6 form.
- **For:** one OptiMove field per GPEXE array, as the source delivers it.
- **Against:**
  - it changes the operator equality, the core check of the mapping contract that C38 accepted (one proven operator,
    and `>` never confused with `>=` silently);
  - the largest database change;
  - the longest review.

### C. A new operator value for zone fields

`bound_operator` gains a value such as `zones`: "closed zones `between`, the top zone `>=`". The T4 trigger accepts,
under a `zones` revision, a version with `between` (upper set) or `>=` (upper null).

- **Migration:**
  - v34's operator CHECK set (`:389-391`) and D3's closed set;
  - `source_metric_check_parameters` (`:983`). Under a `zones` revision, `source_parameters.operator` then no longer
    equals the revision's operator;
  - v37's guard.
- **Changed besides:** F3's body; the phase 6 form.
- **For:**
  - one field per GPEXE array;
  - the convention is explicit in one value.
- **Against:**
  - like B, it changes the core equality check and the closed operator set that the fingerprint and the shape CHECKs
    rely on;
  - a value with two meanings needs care in every reader.

### Not proposed

- **Two active revisions of one field.** At most one active revision per field is a v34 unique index
  (`gpexe-metric-variable-mapping-discovery.md:1193`).
- **Leaving the open power zone out of the import.** That changes the import scope the owner set on 2026-09-17 (each
  power zone imported separately, `docs/ai/CURRENT_STATE.md:2593`).

## 5. Recommendation

**Option A.** It lifts C89 without touching the mapping contract's core check (the operator equality, C38) or v34's
CHECKs. The migration is contained: one guard function and one seeded field. The convention it adds, one field per
zone shape, lives where the source's shape is already read (the extractor).

## 6. Decisions for the owner

- **Z1.** Option A, B or C.
- **Z2** (for A). The key and the label of the new field. Proposal: `more.complementary_data.power.distance.open_top`,
  label "Power zone distance (open top zone)".
- **Z3.** The operators a zone's meaning act may confirm. Proposal: `between` and `>=` only. `>` only if the evidence
  shows that GPEXE's top zone excludes its lower bound.
- **Z4.** The evidence each zone field needs: the operator, the inclusivity of its bounds and the bound unit, owner-run
  as in C97. The first real confirmation stays a separate order (plan, phase 6).

After the decision, the ★★ contract of the chosen option (its migration, F3's change and the phase 6 form) is written
for the owner's approval before any code, following phase 4's pattern.
