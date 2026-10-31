# J12 — phase 7f: the extractor registry (proposed ★★ contract)

This is the contract of phase 7f of `docs/ai/metrics-core-plan.md` (phase 7: "7f: the extractor registry"). It
extends `docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*): the M2 row of the plan table
(line 1976, "the extractor registry keyed by `source_metric_key` (`source_metric_unsupported` otherwise)"), the M4 row
(line 1978), sections E (units, zones and thresholds; lines 1791–1795), F (the fail-closed table) and I (multiple
tracks), and the zone model J7 (`docs/ai/phase5-zone-model-contract.md`, section 4 lines 121–125: the obligations it
leaves to 7f).

It is reviewed together with the 7e contract (`docs/ai/phase7e-aggregate-preview-contract.md`, J11) and the 7g
contract (`docs/ai/phase7g-source-instance-end-contract.md`, J13) in one ★★ round. The implementations stay separate
pull requests.

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-30, on the *Rukovodilac*'s order of that day (queued at 18:31:50 UTC); revised after the internal reviews (section 10); merged with PR #297. Built by 7f-B (section 11): PR #301, merged as `59c2192` and deployed with `be0fe1b` on 2026-10-30. |
| Verified against commit | `6a94ce29` (merge of PR #294). Every file and line reference below is to that commit unless it names another. |
| Migration | **None.** The registry is code; the database cannot bind a key to code (P4 of J7, `migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql:28-31`). Section 6 says why nothing is lost. |
| Order | **7f-B before 7e-B**: the aggregate preview (J11) reads values only through this registry. The plan lists 7e before 7f; section 8 asks the *Rukovodilac* to swap them. |
| **Owner decisions** | **OD1** (team-relative zones; section 4.1) and **OD4** (a system mapping carrying zone or threshold bounds; section 4.1), **decided on 2026-10-30** (J11 section 0.1, with the owner's words): fixed bounds now, and yes. **OD6** (a club's admin approves its club's mapping versions, phase 7h) changes who runs A1 for a club mapping, not this registry's check (section 4.1). |
| Decides | The *Rukovodilac*: R1–R4 (section 8). The owner: OD1, OD4 (decided); the operators of the two event fields wait for the C97 evidence, as before (section 4, item 3). |

---

## 0. In short

- **One extractor per source field.** A code registry keyed by `(source_system, api_family, source_metric_key)` holds,
  for every seeded field, the one function that reads that field's value for one athlete from a stored bundle, with
  the mapping version's parameters. A field without an extractor is `source_metric_unsupported`.
- **It replaces the hard-coded reads of `GPEXE_METRIC_SPECS`** (`backend/src/gpexeImportMapper.js:125-178`) for the
  mapped path. Today's skip codes and checks stay as they are; only the bounds, thresholds and units come from the
  version instead of being hard-coded. The extractor returns the value **in the field's source unit**: the arithmetic
  of today's mapper (seconds ÷ 60, m/s × 3.6) moves to the mapping version's conversion (D6, the seeded `unit_conversions`).
- **It closes J7's open obligation:** the power key reads only closed zones, `.open_top` only the zone whose upper
  extreme is null, the speed key only its open zone; a version whose operator does not fit its key's shape is refused
  before it is written.
- **Where it runs:** at T4 create and A1 activate (a refusal), in the 7e preview (J11), and in M4's import. No route of
  its own; `GET /fields` gains one boolean.
- **No migration, no production write.**

## 1. What exists (verified)

- **The ten seeded fields** (`rest_v1` only; v34 `migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql:1778-1817`,
  v42 `:73-86`), each `gpexe` / `rest_v1`, revision 1, `observed`, session and drill, no proven unit yet:

  | `source_metric_key` | Shape / parameter kind | Expected unit (bound) | Today's spec (`gpexeImportMapper.js`) |
  |---|---|---|---|
  | `athlete_session.total_time` | number / none | s | `gpexe_time_min` (:126-133, ÷ 60) |
  | `athlete_session.total_distance` | number / none | m | `gpexe_total_distance` (:134-141) |
  | `athlete_session.max_v` | number / none | m/s | `gpexe_max_speed` (:170-177, × 3.6) |
  | `more.complementary_data.power.distance` | zone_distance / zone_bounds | m (W/kg) | `gpexe_power_zone_25_60_distance`, `_60_75_` (:76-87, :142-143) |
  | `more.complementary_data.power.distance.open_top` (v42) | zone_distance / zone_bounds | m (W/kg) | `gpexe_power_zone_75_plus_distance` (:144) |
  | `more.complementary_data.speed.distance` | zone_distance / zone_bounds | m (m/s) | `gpexe_sprint_distance_7mps` (:155-159) |
  | `more.events.acceleration_events_count` | event_count / event_threshold | count | `gpexe_acceleration_events` (:145-149; 2.5, 0.3 s hard-coded) |
  | `more.events.deceleration_events_count` | event_count / event_threshold | count | `gpexe_deceleration_events` (:150-154; −2.5, 0.3 s) |
  | `details.players.tot_burst_events` | unit_value_object / none | count | `gpexe_burst_events` (:160-164) |
  | `details.players.tot_brake_events` | unit_value_object / none | count | `gpexe_brake_events` (:165-169) |

- **The checks of today's reads**, kept as they are:
  - `zoneDistance` (`:64-74`), in order: `team_threshold_missing`, `team_threshold_split`, `zones_missing`,
    `zone_boundary_ambiguous` / `zone_boundary_missing` (a zone is chosen by `extremes[0] === lower` and
    `(extremes[1] ?? null) === upper`), `zones_not_ready`, `zone_distance_missing`. Nothing is summed.
  - `eventCount` (`:102-109`): `events_missing`, `threshold_mismatch`, `duration_mismatch`, `count_missing`.
  - `detailsNumber` (`:111-118`): `details_not_fetched`, `field_missing`, `unexpected_unit`, `value_missing`.
  - Every spec runs on the whole-session row (level `full`) and on each drill row (`:344-361`); a skip is recorded and
    the value omitted, never zero (`:356-358`).
- **How a version stores its parameters** (v34 `:108-131`, `:983-1030`): a zone `{lower, operator, unit, upper}`,
  `upper` a number exactly when the operator is `between`; an event threshold `{duration_seconds, operator,
  threshold_value, unit}`. The operator equals the revision's confirmed `bound_operator`; v42's Z3 allows a zone's
  meaning act only `between` or `>=` (v42 `:155-160`) and an event threshold a one-sided operator (`:161-164`).
- **What the database cannot check:** nothing binds a key to code or to a zone shape (v42 `:28-31`, J7's P4). A `>=`
  wrongly confirmed on the power field would today reach an activation unchecked.
- **The stored bundle's shape** on the binding path (`backend/src/gpexeRestV1Adapter.js:88-97`, `:1721-1726`): the
  athlete rows (`total_time`, `total_distance`, `max_v`, `drill`), `more[athleteSessionId]` (`events`, the six count /
  threshold / duration fields; `complementary_data.power[]` / `.speed[]` as `{extremes, distance, is_ready}`),
  `teamThresholds` (`power_thresholds`, `speed_thresholds`, finite numbers or nulls by the projection), and
  `details.full` / `details.drills[n]` with `players[athleteId].tot_*_events = {unit, value}`. The legacy `e03` / `api`
  family has no seeded field (discovery line 1710).
- **No extractor, registry or `source_metric_unsupported` exists in code** (only `v42:31` names the registry). The
  nearest pattern is `SOURCE_ADAPTERS`, keyed by `(source_system, apiFamily)`, answering `adapter_not_available`
  (`backend/src/sourceAdapters.js:16-37`).

## 2. The registry

`backend/src/sourceMetricExtractors.js` (new), imported by the M2 service, the 7e preview and, later, M4:

- `EXTRACTORS`: a frozen map keyed by `"<source_system>/<api_family>/<source_metric_key>"`, with exactly the ten
  `gpexe/rest_v1/…` entries of section 1. Nothing else; the `api` family has none.
- `extractorFor({ sourceSystem, apiFamily, sourceMetricKey })` → the entry, or `null`.
- Every entry is a frozen object:

  ```
  { key, valueShape, parameterKind, zone: null | "closed" | "open_top" | "open",
    direction: null | "up" | "down",
    checkParameters(sourceParameters) -> null | "parameters_unsupported",
    extract({ row, more, playerDetails, thresholds }, sourceParameters) -> { value } | { skip: <code> } }
  ```

  - `valueShape` and `parameterKind` must equal the field's T2b revision (a mismatch is a code defect; a unit test
    asserts all ten against the seed).
  - `value` is a finite JavaScript number **in the field's source unit**, exactly as stored in the bundle; the
    extractor never converts. Its decimal text (the shortest round-trip form) is what the version's conversion and
    D8's storage rule (S = 9, half away from zero) work on.
  - `skip` is one of today's codes (section 1), unchanged, so F's table (discovery lines 1834–1843) still applies.

### 2.1 The entries

| Key | `zone` / `direction` | `checkParameters` refuses unless | `extract` reads |
|---|---|---|---|
| `athlete_session.total_time`, `.total_distance`, `.max_v` | — | `sourceParameters` is `null` (kind none) | `row.<field>`; a non-finite or missing value → `total_time_missing` / `total_distance_missing` / `max_v_missing` |
| `more.complementary_data.power.distance` | closed | operator `between`, `upper` a number | `more.complementary_data.power` and `thresholds.power_thresholds`, with today's `zoneDistance` and the version's `lower` / `upper` |
| `more.complementary_data.power.distance.open_top` | open_top | operator `>=`, `upper` null | the same list, and only the zone whose upper extreme is null; its `extremes[0]` must equal `lower` (else `zone_boundary_missing`); more than one such zone → `zone_boundary_ambiguous` |
| `more.complementary_data.speed.distance` | open | operator `>=`, `upper` null | `more.complementary_data.speed` and `thresholds.speed_thresholds`, the zone `[lower, null]` |
| `more.events.acceleration_events_count` | — / up | operator `>=` or `>` | `more.events.acceleration_events_*`: the answer's `threshold_value` and `duration` must equal the version's `threshold_value` and `duration_seconds` as decimals (else `threshold_mismatch` / `duration_mismatch`); the value is `acceleration_events_count` |
| `more.events.deceleration_events_count` | — / down | operator `<=` or `<` | the same with `deceleration_events_*` |
| `details.players.tot_burst_events`, `tot_brake_events` | — | `sourceParameters` is `null` | `playerDetails.tot_*_events`: `{unit: "number", value: <finite>}` → `value`; otherwise today's `detailsNumber` codes |

- **One decimal comparison for every bound and threshold** (R2): a zone's `lower` / `upper` against the answer's
  `extremes` and the team's `power_thresholds` / `speed_thresholds`, and an event's `threshold_value` /
  `duration_seconds` against the answer's, are compared after both sides are written as canonical decimal text (no
  exponent, no trailing zeros), so `25` equals `25.0`, `2.5` equals `2.50`, and `2.5` never equals `2.4999999`.
  Today's mapper compares JSON numbers with `===`, `!==` and `includes` (`gpexeImportMapper.js:65, 68, 104-105`); the
  result is the same for every value the probes saw.
- **The operator of an event field** is the one the meaning act confirms (C97 still owes its evidence). The registry
  accepts both one-sided operators of the field's direction and never interprets the difference: the GPEXE answer
  carries no operator (`gpexeRestV1Adapter.js:92`), only the threshold the count was computed with, and that is what
  the extractor compares.
- **Team thresholds** are read only from the bundle's `teamThresholds`, which the `rest_v1` projection guarantees to be
  arrays of finite numbers or nulls (`gpexeRestV1Adapter.js:97-108`). The mapper's number normalisation
  (`gpexeImportMapper.js:249-256`) stays a snapshot-payload concern.

## 3. Where the registry is enforced

All in the services; no route, table or trigger is added.

1. **T4 create** (`createVersion`, M2): after the field and revision are read and before the insert, a field without
   an extractor answers `409 source_metric_unsupported`; parameters the entry refuses answer `409
   parameters_unsupported` (both with nothing written; neither depends on a lock: the key and the parameters are
   immutable).
2. **A1 activate** (activation and replacement, 7b): the same two checks on the version to be activated, after its
   rows are locked **and after `rightsStillHold`** (7b's rule: a state refusal only after the right is confirmed
   again), before any write; the answer is the same `409`. A draft created before 7f-B is caught here.
3. **The listed starts** (S1, A1's listed starts, 7d): only an `active` version can be started, and every active
   version passed (2), so nothing more is checked.
4. **The 7e preview** (J11): an unsupported field answers `409 source_metric_unsupported`.
5. **M4's import** reads values only through `extractorFor`; a version whose field has none is a configuration error
   that (1) and (2) make unreachable.

The order of the new refusals among the existing ones (R3): at T4 create, after every `404` and with its other
`409`s (which today come before its rights check, `sourceMetricMappingService.js:1068-1108`); at A1, after every `404`,
after `rightsStillHold` and after its existing state refusals, before the first write. So a caller who may not see
the mapping learns nothing new.

`GET /fields` (and `GET /fields/:fieldId`) add `extractorAvailable: true | false` per field (R4), so the phase 8
screen can offer only supported fields. No other read changes.

## 4. What is unchanged or deferred

1. **The importer.** `GPEXE_METRIC_SPECS`, the writer and the import switch stay as they are until M4 (phase 9); 7f-B
   adds the registry and its uses (section 3) only. M4 then reads the open activations and calls the registry.
2. **Units.** The extractor returns the source unit; the version's conversion does the rest. Today's `÷ 60` and `× 3.6`
   correspond to the seeded conversions `s → min` and `m/s → km/h` (v34 `:1819-1827`); the characterisation test of
   section 7 shows the equality.
3. **The event operators and the burst / brake meaning** stay owed to C97 (J4's table, discovery lines 3171–3180).
   The registry accepts what the meaning act confirms; it does not decide meaning.
4. **Multiple tracks, invalid row statistics, a whole-row count ≠ 1, a session that is not `FULL TRAINING`**: the
   athlete and session gates stay the mapper's (`gpexeImportMapper.js:280-333`). The registry reads one row; who is
   read is not its question.

### 4.1 Different zones for different teams (OD1, OD4: decided)

The owner asked on 2026-10-30 how a U15 team and a senior team with different speed or power zones are handled.

- **With the existing design (OD1, decided: no new model now):** a mapping version's bounds are fixed (its
  `source_parameters`). Two teams with different zones use **two canonical variables** (for example "Sprint distance ≥
  22 km/h" and "Sprint distance ≥ 25.2 km/h"), each with its own mapping and active version, and each team's binding
  activates the one that fits its own GPEXE zone settings (T5, per binding).
- **A team whose GPEXE settings do not contain the version's bounds is refused fail-closed:** the extractor answers
  `team_threshold_missing` or `team_threshold_split` for a zone, `threshold_mismatch` or `duration_mismatch` for an
  event, and no value is written from a wrong zone (F's table). The 7e preview shows it as a count of 0 before
  anything is activated (J11 section 5).
- **A team-relative zone** (one canonical variable whose bounds follow each team's own settings) would be a new
  parameter kind and a new mapping model; it is **not built** (OD1). The owner's example, a club variable such as
  "80 % of Vmax", is a derived variable of phase 11 with its own discovery, not a zone mapping: GPEXE's zone
  distances are per team and absolute, and OptiMove stores no speed samples (the track projection keeps its id, the
  athlete, the time zone and the timestamps only, `BUNDLE_FIELDS.track` in `backend/src/gpexeRestV1Adapter.js`), so
  that discovery must first find where such a value can come from.
- **OD4 (decided: yes):** a system mapping may carry zone or threshold bounds; the bounds are not personal data, and a
  team's own settings are shown only to that team's club and a platform admin (the phase 8 screen's rule).
- **The club's own names, the same physics** (the product rule beside OD1, J11 section 0.1): a club names its
  variables as it likes and its admin chooses which field fills each; the version's bounds and thresholds must still
  match what GPEXE computes for the team, or this registry's extractor refuses the value as above.
- **OD6 (decided; built in phase 7h):** a club's admin will also approve, disable and replace its club's mapping
  versions. A1 then has two kinds of actor; the registry checks of section 3 (`source_metric_unsupported`,
  `parameters_unsupported`) run the same for both, after `rightsStillHold`.

## 5. Security and privacy

- No new route. The `GET /fields` boolean is a fact of code, the same for every reader of the list.
- The registry reads only fields the projection keeps; it never sees an athlete name or a raw answer outside the
  stored bundle. Its skips carry codes only, never a value.
- A refusal text names the code only (`source_metric_unsupported`, `parameters_unsupported`), never the key's
  parameters or a number.

## 6. Why no migration

- The key → code binding cannot live in the database (J7's P4). The guarantee is the service refusal at T4 create and
  A1 activate (section 3), tested and mutated.
- A raw SQL writer that bypasses M2 is the case v35 already accepts as out of contract (C74, the separate-roles task in
  `CURRENT_STATE.md`); it could write a version with an unsupported key, and M4 would then refuse that version's value
  as a configuration error (a test pins that the importer never writes a value without an extractor).

## 7. Tests (7f-B)

- **The registry against the seed:** the ten keys, their shape and kind, on a disposable database through v47
  (or the current last migration); a seeded key without an entry fails the test.
- **Characterisation against today's mapper** on the existing GPEXE fixtures (`backend/tests/gpexe-import.test.mjs`
  and the `rest_v1` adapter fixtures): for every spec with a key, the extractor with the spec's own bounds (25 / 60
  `between`; 60 / 75 `between`; 75 `>=` on `.open_top`; 7 `>=` on speed; 2.5 / 0.3 `>=`; −2.5 / 0.3 `<=`) returns the
  same raw value (before the spec's `÷ 60` or `× 3.6`) and the same skip code, row by row, at both levels.
- **The zone rules of J7:** closed zones only for the power key; exactly one null-top zone for `.open_top` (none →
  `zone_boundary_missing`, two → `zone_boundary_ambiguous`); the open zone for speed; each wrong operator / shape →
  `parameters_unsupported`.
- **The decimal comparison:** a zone bound `25.0` in the version against `extremes [25, 60]` and team thresholds
  `[25, 60]` gives the same distance as `25`; `2.5` = `2.50`; `2.5` ≠ `2.4999999`; a threshold of another sign.
- **Two teams, two variables** (OD1): one team's settings match the version's bounds and give values, the other's do
  not and give `team_threshold_missing` with nothing written.
- **Enforcement through the real routes:** T4 create and A1 activate answer `409 source_metric_unsupported` and `409
  parameters_unsupported` with nothing written; the order after the `404`s (a caller outside the mapping's scope
  still gets the identical `404`); `GET /fields` carries `extractorAvailable`.
- **Architecture:** no module but `sourceMetricExtractors.js` reads a `more.complementary_data` or `more.events` field
  on the mapped path (the B7-style guard), and the registry's `extract` never returns a value that is not a finite
  number.
- **Mutations** of every `checkParameters`, the zone choice, the decimal comparison and the two service refusals.

## 8. Decisions for the *Rukovodilac*

- **R1 — order:** 7f-B before 7e-B (the preview needs the registry). Recommended: swap 7e and 7f in the plan's order.
- **R2 — one decimal comparison for every bound and threshold** (section 2.1). Recommended.
- **R3 — the place of the new refusals** in T4 create and A1 (section 3). Recommended.
- **R4 — `extractorAvailable` on `GET /fields`.** Recommended; it is the only read change.

No owner decision is needed for 7f. The owner's K items for 7e and 7g are in J11 and J13.

## 9. Not in this contract

M4 (the importer reading activations), the import switch, the phase 8 screen, any GPEXE request, a new source field
or revision, the `e03` / `api` family, derived values (`gpexeImportMapper.js:180-186`), multiple tracks (section I).

## 10. Review record

- **Internal round 1 (head `e8060485`):** `code-reviewer`, `db-reviewer`, `security-reviewer`, each READY WITH
  NON-BLOCKING NOTES, no BLOCKER or HIGH. Applied in this revision: one decimal comparison for zone bounds and team
  thresholds too (code LOW); A1's new refusals after `rightsStillHold` (security LOW); OD1 (with the owner's U15 /
  seniors question answered by the existing design) and OD4, marked pending owner (the *Rukovodilac*'s note of 19:29
  UTC).
- **External round and the owner's decisions:** GO from the *Nezavisni revizor* and the *Rukovodilac* on `fedabc65` and
  `d85160e0`; then OD1 and OD4 written as decided, with OD6's effect on A1's actors and the note on "80 % of Vmax"
  (section 4.1); a narrow re-review of the delta by both.
- **Narrow re-reviews of `e8060485..f8768e3a`:** `code-reviewer`, `db-reviewer`, `security-reviewer`, each READY WITH
  NON-BLOCKING NOTES, every earlier finding closed. Their LOW notes applied without a further review: the preview's size
  bound measures the uncompressed text (J11 R7); the 7g guard takes the owner team's lock itself and step 6 re-compares
  the owner (J13); `.gitattributes` for v49's runbook SQL (J13); the C97 blocks drop the read-only wrapper (the editor
  may show only the last statement), cast safely, count every whole-session row per athlete, and say they approximate
  the mapper's gates.

## 11. As built (7f-B)

PR #301, merged as `59c2192` (2026-10-30 23:39:12 UTC) and deployed with `be0fe1b` (live 23:55:23 UTC). Branch
`feature/7f-extractor-registry`, from `6568cf7` (merge of PR #299; the *Rukovodilac* ordered `39b4b52`, and
`39b4b52..6568cf7` changed only documents); no migration, no production write. Where the build differs from sections
2, 3 and 7, this section says so. The line references of sections 1 to 7 are to `6a94ce29`; 7d-B (PR #295) moved the
service's lines since, and the code below is named by function.

- **The module** `backend/src/sourceMetricExtractors.js`: `EXTRACTORS` (frozen, null prototype, the ten
  `gpexe/rest_v1/…` entries of section 2.1), `extractorFor()`, `extractabilityCode()`, and the decimal helpers
  `canonicalDecimal()`, `compareDecimal()` and `sameDecimal()` (R2: a `BigInt` comparison of canonical decimal text,
  no binary floating point). `extract()` throws `ExtractorError` (`parameters_unsupported`) for parameters its entry
  refuses, and otherwise returns `{ value }` or `{ skip }` with today's codes.
- **Kind none** accepts `null` and `{}`: the stored form of a version without parameters is `{}` (v34), not `null` as
  section 2.1 says.
- **A revision with another value shape or parameter kind** than the entry's is `source_metric_unsupported`
  (`extractabilityCode()`): a later revision R+1 of a seeded field may change them (the lifecycle of phase 4), and the
  entry reads only its own shape.
- **T4 create** (`createVersion`): the check runs after every `404`, after the revision's `409`s and the input check of
  `sourceParameters` (`400`), and before the target, conversion and parameter `409`s, the locks and the rights check
  (R3). It reads the field's key and the revision's value shape; a kind-none version is checked with `{}`.
- **A1** (`activateVersion`, activation and replacement): the check runs after `rightsStillHold` and every existing
  state refusal (`source_metric_target_taken` last), before the first write. R3's "after every `404`" holds for every
  `404` before the first write; since 7d-B the listed starts' binding `404`s come after A1's first write (the end of
  the open activations), as before 7f. It reads the stored parameters as exact
  text (`PARAMS_AS_TEXT`, the form A1 already uses), so the stored decimals are compared, never a binary double.
- **R2 changes one result on purpose.** The `rest_v1` projection lets an event's threshold and duration be short
  strings (`gpexeRestV1Adapter.js`, `scalar`); today's mapper compares them with `!==`, so `"2.5"` against `2.5` is
  `threshold_mismatch`, and the registry, comparing decimals, accepts it. Zone extremes and team thresholds are
  numbers by the projection, so nothing else differs. `.open_top`'s rule (one null-top zone) is J7's and differs from
  today's exact match by design.
- **Versions activated before 7f-B are not checked again** (section 3, items 3 and 5). In production none exists: no
  source field is confirmed (C97 is still owed, `CURRENT_STATE.md`), so A1 refuses every activation with
  `revision_not_verified`, and the v43 post-check found no active mapping version. On a database where one exists
  (a test database built with the seam), `extract()` parses the parameters again and throws `ExtractorError`, so no
  value can be read through it; M4 meets that as the configuration error of section 3, item 5.
- **T4 answers the new `409` before its rights re-check**, like every other `409` of T4 (R3); A1 answers it after.
- **Two `canonicalDecimal` functions:** the service's one normalises a request's decimal input; the registry's
  one compares JSON numbers and decimal text. They are not interchangeable, and the registry imports nothing from
  the service (that would pull the database module into a pure module).
- **`extractorAvailable`** is on every field of `GET /fields` and on `GET /fields/:fieldId`
  (`sourceFieldVerificationService.js`); the same boolean for every reader. It is decided by the field's key alone:
  a later revision of another shape is still refused at T4 (the shape check above).
- **A test seam, not in section 7.** The suites written before 7f build their mappings on synthetic fields keyed
  `<suite>.test.<id>`, which the registry refuses. `setExtractorFallbackForTests()` lets such a key, and only a key of
  that form, be answered by a test's own entry; a seeded key never reaches it. Eleven existing suites call
  `allowSyntheticTestFields()` (`backend/tests/support/test-extractors.mjs`: an entry that declares no shape and
  accepts every parameter), and the architecture test proves that no module of `backend/src` sets the seam. The new
  route suite sets the seam itself in three cases: to build two versions as they were made before 7f (A1 then
  refuses them, once with the permissive entry removed and once through the real closed-power entry), and to read a
  closed zone (between 25 and 60 W/kg) through the real closed-power entry at A1, since the one seeded closed key is
  confirmed with `>=` earlier in the suite.
- **Tests:**
  - `backend/tests/source-metric-extractors-7f.test.mjs` (unit): the table, decimals, every `checkParameters`, J7's
    zone rules, the decimal comparison in zones and events, two teams with two variables, the characterisation
    against `GPEXE_METRIC_SPECS` on six bundle variants at both levels and on a bundle whose `more` went through the
    adapter's `projectMore` and whose team thresholds are the stored GPEXE answer
    `fixtures/gpexe-team-thresholds-1473.json`, `extractabilityCode()`, the seam, the architecture guard.
  - `backend/tests/source-metric-extractors-routes-7f.test.mjs` (a disposable database): the registry against the
    seed, `extractorAvailable`, T4 create's two refusals with nothing written and their place after the `404`s and
    before the target side's `409`s (a field the registry does not read and a missing conversion answer the
    registry's code; a supported field still answers `conversion_unavailable`), the shape of a later revision, A1's
    two refusals after the `404`, the right and the state refusals, A1 accepting the stored parameters of an open top
    zone, an acceleration count and a closed zone (a broken read of the stored decimals at A1 fails it), and every
    answer free of a parameter.
- **An existing guard extended:** `gpexe-rest-v1-adapter-reads.test.mjs` B7.8 refused any module but the adapter and
  the mapper naming `details.players`; the registry's two keys do. B7.8 now exempts the registry and pins it instead:
  its only such text is its two keys, its details entries are exactly `DETAILS_CONSUMED_FIELDS`, and it reads one
  property of an athlete's details (`playerDetails[`), never another.
- **Not built here (section 6):** the test that "the importer never writes a value without an extractor" belongs to
  M4, which is the first importer that reads through the registry.
