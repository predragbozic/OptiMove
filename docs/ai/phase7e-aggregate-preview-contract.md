# J11 — phase 7e: the aggregate preview of a mapping version (proposed ★★ contract)

This is the contract of phase 7e of `docs/ai/metrics-core-plan.md` (phase 7: "7e: the aggregate preview"). It extends
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*): the M2 row of the plan table (line
1976: "the aggregate preview over a saved candidate (count of athletes with a value, min, max, units before and
after; `snapshot_expired` when the raw snapshot is purged)" and its tests: never `raw_bundle` or a row per athlete,
the identical 404 before `snapshot_expired` to a caller outside the candidate's club), section H (lines 1941–1948:
who may see it) and two open items of section K (line 3840: its fields; lines 3853–3854: the minimum count of
athletes for min and max).

It is reviewed together with the 7f contract (`docs/ai/phase7f-extractor-registry-contract.md`, J12) and the 7g
contract (`docs/ai/phase7g-source-instance-end-contract.md`, J13) in one ★★ round. **It reads values only through
7f's registry, so 7e-B comes after 7f-B** (J12, R1).

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-30, on the *Rukovodilac*'s order of that day (queued at 18:31:50 UTC). |
| Verified against commit | `6a94ce29` (merge of PR #294). Every file and line reference below is to that commit unless it names another. |
| Migration | **None.** A read over existing rows; no table, column, trigger or audit row. |
| **Pending owner** | **P1** the preview's fields (section 3) and **P2** the minimum count of athletes for min and max (section 4) are section K's open items. The *Rukovodilac* put both to the owner on 2026-10-30 with these recommendations: P1 exactly the four facts below and nothing more; P2 = 3. Until the owner answers, the contract is written with the recommended options, marked **pending owner**. **P3**, whether a system zone or threshold mapping may show one team's bounds, is J13's neighbour item in K (line 3850); it does not change this contract (section 6). |
| Decides | The *Rukovodilac*: R1–R5 (section 9). The owner: P1, P2. |

---

## 0. In short

- **What it is:** before a mapping version is activated (7d), an administrator checks it against one saved GPEXE
  session: how many athletes the version would give a value, the smallest and the largest value, and the units before
  and after the version's conversion. Nothing is written.
- **The route:** `GET /api/training-load/sources/metrics/mappings/:mappingId/versions/:versionId/preview?candidateId=…`.
- **Who:** the mapping admins of the mapping's workspace, and only over a candidate of a team they may see: a platform
  admin in the platform workspace (a system mapping, any club's candidate) or in club X's workspace, and club X's
  active admin in its own workspace (a system mapping or club X's own, over club X's candidates). Everyone else gets
  the identical 404, decided **before** `snapshot_expired` is answered.
- **Never** a raw answer, a row per athlete, an athlete id or name, or a value below the minimum count (pending owner).
- **The values are the ones M4 would write:** the same session and athlete gates as today's mapper, the version's field
  through 7f's extractor, at the version's levels, converted by the version's own factors with D8's storage rule.

## 1. What exists (verified)

- **The candidate store** `training_load.gpexe_import_candidates`
  (`migrations_v2/202609191000_training_load_v22_gpexe_in_app_import.sql:250-280`; v33 adds `superseded_by_check_id`
  and `drill_parameter_effect`, `migrations_v2/202610111000_training_load_v33_gpexe_check_finalization.sql:55-57`):
  - its team is `owner_team_id` only; its club is the team's `club_id` (nullable; `gpexeImportAccess.js:22,34`);
  - status `pending | blocked | superseded | imported` (v22 `:262`);
  - `raw_bundle` is NULL exactly when `raw_purged_at` is set (v22 `:274`), and a purged row has no `preview` (`:277`);
  - expiry is separate from the purge: the application treats `raw_expires_at <= now()` as gone before the purge runs
    (`snapshotState`, `backend/src/gpexeImportService.js:1293-1297`, reasons `purged` / `expired`);
  - the purge (`purge_expired_gpexe_raw`, v22 `:345-361`) runs at every check, every 6 hours and from the CLI
    (`gpexeImportService.js:312-390, 694-708`); retention 30 days unapproved, 90 after import (`:33-34`); the row stays
    (v22 `:288-295`), and a later check that sees the same content restores the bundle (`:2054`).
- **Today's candidate reads** (`backend/src/routes/gpexeImport.js`): `resolveGpexeTeamAccess`
  (`backend/src/gpexeImportAccess.js:18-35`) admits a team's coach too; the narrower administrator right already exists
  as `identityAdminBasis` (`backend/src/gpexeAthleteIdentityService.js:142-149`): a platform admin in the platform or
  the team's club workspace, the club's active admin in its own; `null` when the team has no club. No route returns
  `raw_bundle` (`CANDIDATE_COLUMNS`, `gpexeImportService.js:1356-1360`); today's code for a gone snapshot is
  `snapshot_expired_check_again` (`:1308, 2202`).
- **The stored bundle on the binding path** (`backend/src/gpexeRestV1Adapter.js:1721-1726`, `BUNDLE_FIELDS` `:88-97`):
  athlete rows (whole session and drills), `more`, `teamThresholds`, `details.full` / `details.drills[n]`. The candidate's
  source family is not in the bundle; it is the candidate's last check's `source_path` / `source_host_key`
  (`migrations_v2/202610041200_training_load_v31_gpexe_import_checks_source_path.sql:65-78`; candidate →
  `last_seen_check_id`, v22 `:267-268`): `legacy_env` is `e03` / `api`, which has no seeded field.
- **The mapper's gates** (`backend/src/gpexeImportMapper.js`): the whole plan is refused for `is_stats_valid`, a
  category other than `FULL TRAINING`, thresholds, track or timezone errors (`:280-289, 318-321, 385-386`); an athlete
  is left out for multiple tracks (`:313-316`), invalid row statistics (`:324-328`) or a whole-row count ≠ 1
  (`:329-333`); then every spec runs on the whole-session row and on each drill row (`:344-361`).
- **The version's conversion** (v34 `:716, 842, 925-945, 153-161`): canonical = source × `scale` ÷ `scale_divisor` +
  `offset`, in normal form, stored at scale 9 half away from zero (`source_metric_value_matches`); `source_unit` is the
  revision's proven unit and `target_unit` the canonical version's.
- **The mapping's scope** (`backend/src/sourceMetricAccess.js:55-76`): the platform workspace reads system mappings;
  club X's workspace reads system mappings and club X's; `getMapping` filters by `owner_key` and answers 404
  otherwise (`backend/src/sourceMetricMappingService.js:683-696`).
- **No aggregate exists anywhere** in code; the stored candidate `preview.counts` are import outcomes
  (`backend/src/gpexeImportPreview.js:253`).

## 2. The route and its order of answers

`GET /api/training-load/sources/metrics/mappings/:mappingId/versions/:versionId/preview?candidateId=<uuid>`

The router's usual sequence (`adminContext`, then the gate), with no body:

1. **401** without a session (`requireAuth`).
2. **The identical 404** (`{ "error": "notFound" }`) for every one of these, in this order, each a plain read:
   1. no mapping-admin context (`resolveMappingAdmin`), or `mayManageActivations(ctx)` false (the same audience as 7d);
   2. a malformed `mappingId`, `versionId` or `candidateId`; an unknown query parameter;
   3. the mapping not readable in the workspace, or the version not of that mapping;
   4. the candidate missing; its team missing, archived, or without a club; its club archived;
   5. **the scope rule** (R1): the platform workspace (a platform admin) admits a **system** mapping over any club's
      candidate; club X's workspace (its admin, or a platform admin there) admits a system mapping or club X's own,
      over **club X's candidates only**. Everything else is outside the scope.
3. **409 `snapshot_expired`** when the candidate's raw snapshot is purged **or** past `raw_expires_at` (R2: as the
   application treats it today), with `{ current: { reason: "purged" | "expired" } }`. A caller who reached this step
   may see the candidate, so its snapshot's state hides nothing.
4. **409 `candidate_source_mismatch`** when the candidate was read from another source family than the version's field
   (a `legacy_env` candidate, or a host whose `api_family` differs).
5. **409 `source_metric_unsupported` / `parameters_unsupported`** from 7f's registry (J12, section 3).
6. **409 `candidate_not_importable`** with `{ current: { reason: "<the mapper's stable code>" } }` when the mapper
   refuses the whole session (section 1).
7. **200** with the preview (section 3).

Every step is in one read-only transaction (`boundedRead`: the read's statement and lock timeouts). The candidate row
is read without a lock; a concurrent purge either lands first (step 3) or after the read (the preview stands for the
snapshot it read).

## 3. The answer (P1, pending owner)

```
{ "preview": {
    "candidateId": "<uuid>", "versionId": "<uuid>",
    "sourceUnit": "<the version's source unit>", "targetUnit": "<the version's target unit>",
    "minimumAthletes": 3,
    "levels": {
      "session": null | { "athletesWithValue": <n>, "min": "<dec>" | null, "max": "<dec>" | null,
                          "minCanonical": "<dec>" | null, "maxCanonical": "<dec>" | null },
      "drill":   null | { same } } } }
```

- A level is `null` when the version does not apply to it (`applies_to_session` / `applies_to_drill`).
- **`athletesWithValue`:** the number of distinct GPEXE athletes of the session, after the mapper's athlete gates, for
  whom 7f's extractor returns a value at that level. At the drill level, an athlete counts once whatever the number of
  their drills with a value.
- **`min` / `max`:** over every value of the level (at the drill level, every athlete-drill value), in the source unit,
  as canonical decimal text; **`null` when `athletesWithValue` < `minimumAthletes`** (P2).
- **`minCanonical` / `maxCanonical`:** the same two values through the version's own conversion, computed in decimal
  and rounded to scale 9 half away from zero (D8's rule, the one `source_metric_value_matches` checks). No other
  rounding.
- **Nothing else** (P1): no athlete id, name or position; no value list or histogram; no skip codes or counts per
  reason; no `raw_bundle`; no session label beyond what the candidate list already shows (the answer names the
  candidate by id only). A count of 0 is an answer, not an error.

The recommendation the *Rukovodilac* put to the owner is exactly these four facts (the count, min, max, units before
and after) and nothing more. Two options the owner may prefer instead, not built unless chosen: the count of athletes
left out by each stable skip code (useful to explain a low count, it reveals no value), or the athletes the session
has in total.

## 4. The minimum count (P2, pending owner)

`minimumAthletes` = **3** (recommended). With fewer athletes with a value, `min` and `max` (and their canonical forms)
are `null` and only the count is answered, because a min or max of one or two athletes is a single athlete's value.
The number is a constant of the service (`PREVIEW_MINIMUM_ATHLETES`), echoed in every answer; changing it is a code
change.

## 5. How a value is computed

For the version's field, through `extractorFor(field)` (J12) with the version's `source_parameters`:

1. Read the candidate's `raw_bundle` once (it is at most a few MiB; the projection bounds every answer at 5 MiB,
   `gpexeRestV1Adapter.js`).
2. Apply the mapper's session gates and athlete gates exactly as M4 will (the same functions, exported for this use;
   R3), so the preview never counts an athlete the import would leave out.
3. For each remaining athlete: at the session level the whole-session row; at the drill level each drill row; call
   `extract({ row, more, playerDetails, thresholds }, sourceParameters)`. A skip is not a value.
4. Aggregate per level as in section 3, then convert min and max.

The preview reads the version's parameters, not the team's settings: for a zone or threshold mapping the extractor
checks the team's own thresholds in the bundle against the version's bounds (`team_threshold_missing`, `_split`),
exactly as the import will. A version whose bounds do not fit the team gives a count of 0, which is the useful answer.

## 6. Security and privacy

- **Info-hiding:** the candidate exists for the caller only inside the scope rule; outside it every case, including a
  purged snapshot, is the identical 404 (section 2). A test per role and workspace pins it (section 8).
- **No value of fewer than `minimumAthletes` athletes** leaves the server (P2). Above it, min and max are still values
  of single athletes; the owner's choice of the number is the accepted bound (it is a K item for exactly that
  reason).
- **Zone and threshold bounds** (P3, line 3850 of the discovery document) are not shown by the preview at all: the
  answer carries no bound, only counts and values in the field's unit. So P3 does not block 7e; it stays the phase 8
  screen's question.
- **No coach** gets the preview: the audience is the mapping admins (R1), narrower than today's candidate reads.
- The answer and every log line carry no reason text, no athlete id and no database text (the 7d test pattern).

## 7. What is unchanged

No write, request key, audit row or migration. The candidate list, its stored `preview` and the import switch are
untouched. The phase 8 screen (the Mappings tab) is the first caller; the API is usable without it.

## 8. Tests (7e-B)

- **Access and info-hiding through the real route:** 401; the identical 404 for a coach, a user with no role, another
  club's admin, an admin of two clubs in the other club's workspace, the platform workspace over a club mapping, a
  version not of the named mapping, a candidate of another team or club, a team without a club, an archived team or
  club; each **also with a purged and with an expired snapshot**, so the 404 always comes before `snapshot_expired`.
- **The order of the 409s** (section 2): `snapshot_expired` (purged, expired) before `candidate_source_mismatch` before
  `source_metric_unsupported` / `parameters_unsupported` before `candidate_not_importable`.
- **The values** on the existing GPEXE fixtures: for each of the ten fields with the bounds of today's specs, the
  counts and min / max equal the values today's mapper would import for the same athletes (before its unit
  arithmetic, then converted by the version); the drill level counts athletes once; a level the version does not apply
  to is `null`.
- **The minimum:** 2 athletes with a value give the count and `null` min / max; 3 give all.
- **The conversion:** min / max canonical through `s → min` and `m/s → km/h` at scale 9 half away from zero (a value
  that rounds at the 10th place).
- **No leak:** a secret-scan of every answer of the suite for athlete ids, names, raw keys of the bundle and database
  texts; the answer's keys are exactly section 3's.
- **Mutations** of the scope rule, the 404-before-409 order, the minimum, the athlete gates and the conversion.

## 9. Decisions for the *Rukovodilac*

- **R1 — the audience:** the mapping admins of 7d (`mayManageActivations`), with 7d's scope rule applied to the
  candidate's club. Recommended (section H of the discovery document says the same in words).
- **R2 — `snapshot_expired` covers a purged and an expired-not-yet-purged snapshot** (the M2 row says "purged"; the
  application already treats both as gone). Recommended.
- **R3 — the mapper's session and athlete gates are reused, not copied** (exported from `gpexeImportMapper.js` without a
  behaviour change). Recommended.
- **R4 — the route is a `GET`** with the candidate in the query (a read, no request key). Recommended.
- **R5 — `candidate_source_mismatch`** for a candidate read from another family (no partial preview). Recommended.

## 10. Not in this contract

The phase 8 screen, the importer (M4), the import switch, any GPEXE request, a stored preview, a preview over a live
GPEXE answer, a preview of several candidates at once.
