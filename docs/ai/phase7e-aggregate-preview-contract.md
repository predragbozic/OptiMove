# J11 — phase 7e: the aggregate preview of a mapping version (proposed ★★ contract)

This is the contract of phase 7e of `docs/ai/metrics-core-plan.md` (phase 7: "7e: the aggregate preview"). It extends
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*): the M2 row of the plan table (line
1976: "the aggregate preview over a saved candidate (count of athletes with a value, min, max, units before and
after; `snapshot_expired` when the raw snapshot is purged)" and its tests: never `raw_bundle` or a row per athlete,
the identical 404 before `snapshot_expired` to a caller outside the candidate's club), section H (lines 1941–1948:
who may see it) and two open items of section K (line 3840: its fields; lines 3853–3854: the minimum count of
athletes for min and max).

It is reviewed together with the 7f contract (`docs/ai/phase7f-extractor-registry-contract.md`, J12) and the 7g
contract (`docs/ai/phase7g-source-instance-end-contract.md`, J13) in one ★★ round. **7e-B comes after 7d-B** (it uses
7d's `mayManageActivations` and its scope rule, section 2.1 of `docs/ai/phase7d-mapping-activations-contract.md`) **and
after 7f-B** (it reads values only through 7f's registry; J12, R1).

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-30, on the *Rukovodilac*'s order of that day (queued at 18:31:50 UTC); revised after the internal reviews (section 11); accepted with PR #297. **Built by 7e-B** (section 12, "As built"): PR #303, merged as `e6ca433` and deployed on 2026-10-31. |
| Verified against commit | `6a94ce29` (merge of PR #294). Every file and line reference below is to that commit unless it names another. |
| Migration | **None.** A read over existing rows; no table, column, trigger or audit row. |
| **Owner decisions** | **OD2** (the preview's fields, section 3), **OD3** (the minimum count of athletes, section 4) and **OD4** (a system mapping carrying zone or threshold bounds, section 6): **decided on 2026-10-30 as recommended** — section 0.1, with the owner's words. |
| Decides | The *Rukovodilac*: R1–R7 (section 9). The owner: OD2, OD3, OD4 (decided). |

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
- **Never** a raw answer, a row per athlete, an athlete id or name, or a value below the minimum count (OD3).
- **The values are the ones M4 would write:** the same session and athlete gates as today's mapper, the version's field
  through 7f's extractor, at the version's levels, converted by the version's own factors with D8's storage rule.

## 0.1 The owner's decisions of phases 7e–7g (OD1–OD7, decided on 2026-10-30)

The *Rukovodilac* put OD1–OD5 to the owner on 2026-10-30 with its recommendations; OD6 and OD7 came from the owner's
own remarks the same evening. The owner's words are in the *Rukovodilac*'s chat; the executor checked each turn in its
transcript. Where the owner's words are short ("to smo rekli"), the reading is the *Rukovodilac*'s, as marked. They are
also recorded as C107–C109 of the discovery document.

| | Decision | Decided | The owner's words | Where |
|---|---|---|---|---|
| **OD1** | Team-relative zones as a canonical variable of their own (bounds that follow each team's settings) | **Not now, fixed bounds**: two teams with different zones (for example U15 and seniors) use two canonical variables, each team's binding activating the one that fits it, a mismatch refused fail-closed. A relative variable such as "80 % of Vmax" is a later derived variable (phase 11), not a zone mapping | „svaki klub kada napravi kanonske varijable za svoj tim moze relativne da stavi to nije toliko ni bitno on ce da napise npr 80% od vmax …” (turn `396e7078`, 22:06:19 UTC) | J12 section 4.1 |
| **OD2** | The preview's fields | **As recommended**: the count of athletes with a value, min, max, the units before and after, and `snapshot_expired`; nothing more | „Sto se tice pregleda varijabli tokom povezivanja to je ok” (turn `347e2f96`, 21:57:20 UTC); „2. pregled smo odredili  kroz diskusiju” (turn `396e7078`) | J11 section 3 |
| **OD3** | The minimum count of athletes for min and max | **3** | „3. moze” (turn `396e7078`) | J11 section 4 |
| **OD4** | May a system mapping carry zone or threshold bounds | **Yes**, confirmed by the owner: the bounds are not personal data; a team's own settings are shown only to that team's club and a platform admin | „4. to smo rekli” (turn `396e7078`); the explicit confirmation „oba pitanja po tvoojoj preporuci, e915a5b9 je deployed” (turn `e21a1604`, 22:19:50 UTC) | J11 section 6, J12 section 4.1 |
| **OD5** | The shape of the operation that ends a held source instance (D9) | **As recommended, the narrower reading** (the *Rukovodilac*'s reading): only an active platform admin in the platform workspace, with a mandatory reason, refused while the owner team has an active binding of that source team or an open activation on one | „5. to smo vec rekli dole” (turn `396e7078`) | J13 sections 2–4 |
| **OD6** | Who approves and disables a club's mapping versions | **The club's own admin** for its club's mappings (`needs_review → active`, disabling, replacing); system mappings, the source fields' unit and meaning, the unit conversions and D9 stay the platform admin's. A migration: phase 7h, its own contract (J14) | „Rekli smo da sam mogu da klupski admin da radi mapiranja, i da preuzima sistemske varijable” (turn `a73981ac`, 22:08:40 UTC); „znaci promeni u skladu sta sam hteo, ne vidim problem, da li ti vidis” (turn `88ad60ca`, 22:09:13 UTC) | plan, phase 7h |
| **OD7** | A club takes a system variable into its own set | **Yes, in two forms, both offered** (the forms are the *Rukovodilac*'s decision of 2026-10-30, queued at 22:17:27 UTC; the owner is not asked separately): **(a) use as is**: the system variable is mapped and activated for the club's teams without a copy, and the club may hide it; **(b) copy to own**: a club variable with the system variable's mappings as the club's draft versions, approved by the club's admin (OD6). Phase 7i, its own contract (J15) | the same turns `a73981ac` and `88ad60ca`; the owner's guideline of turn `bf4c6ce7` (21:59:39 UTC) and turn `d1b4e6e5` (22:12:14 UTC) (C109) | plan, phase 7i |

**Comparing clubs** (C109): not a goal now (the owner, turn `67e1025c`, 22:15:23 UTC: „nemoj sada da se zamaramo sa
uporedjivanjem izmedju klubova …”). If it is ever wanted, it is possible only through system variables a club uses as
they are (OD7 a); a club's copy (OD7 b) is the club's own. Nothing is built for it.

**The product rule beside OD1** (the *Rukovodilac*'s reading of turn `a73981ac`: „moje zone mogu da se zovu kako hocu, a
da preuzimam u njih sta hocu”): a club variable's name and description are the club's choice, and which GPEXE field
fills it is the club admin's mapping choice. What stays fixed is that its physical definition (the unit, a zone's
bound, an event's threshold) matches what GPEXE computes for that team; otherwise the import refuses fail-closed
(ADR-007, J12 section 4.1).

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
2. **The identical 404** (`{ "error": "notFound" }`) for every one of these, in this order (steps 4 and 5 inside the
   read-only transaction below):
   1. no mapping-admin context (`resolveMappingAdmin`), or `mayManageActivations(ctx)` false (the same audience as 7d);
   2. a malformed `mappingId` or `versionId`;
   3. a missing, repeated (an array) or malformed `candidateId`; any other query parameter;
   4. the mapping not readable in the workspace, or the version not of that mapping;
   5. **the candidate outside the scope**, decided in **one statement**: the candidate, its team and the team's club
      read together, with the scope in the `WHERE` clause — the team and the club active, and `ctx.owner.scope =
      'system'` (a platform admin in the platform workspace, a **system** mapping) or `team.club_id =
      ctx.owner.clubId` (club X's workspace, its admin or a platform admin there; a system mapping or club X's own).
      Zero rows is the 404: a missing candidate, a missing, archived or club-less team, an archived club, another club's
      candidate all look the same (R1).

   `ctx` (from `resolveMappingAdmin`, once per request) is the only workspace fact; the route never calls
   `resolveGpexeTeamAccess`, which would resolve the workspace a second time. The candidate's club is **the team's
   current club**, as every candidate read uses today (`gpexeImportAccess.js:22, 34`), not 7d's "the binding's
   connection's club" (7d section 2.2): a candidate names a team, not a binding, and its scope follows the team, so a
   team moved to another club (no route moves a team today) takes its candidates' visibility with it (R6).
3. **409 `snapshot_expired`** when the candidate's raw snapshot is purged **or** past `raw_expires_at` (R2: as the
   application treats it today), with `{ current: { reason: "purged" | "expired" } }`. A caller who reached this step
   may see the candidate, so its snapshot's state hides nothing.
   Then **409 `candidate_too_large`** when the stored bundle is over the size bound (R7).
4. **409 `candidate_source_mismatch`** when the candidate was read from another source family than the version's field
   (a `legacy_env` candidate, or a host whose `api_family` differs).
5. **409 `source_metric_unsupported` / `parameters_unsupported`** from 7f's registry (J12, section 3).
6. **409 `candidate_not_importable`** with `{ current: { reason: "<the mapper's stable code>" } }` when the mapper
   refuses the whole session (section 1).
7. **200** with the preview (section 3).

Every step up to 5 is in one read-only transaction (`boundedRead`, `REPEATABLE READ READ ONLY` with the read's
statement and lock timeouts, `backend/src/sourceMetricMappingService.js:160-168`), so the scope, the snapshot state and
the bundle are one snapshot: a concurrent purge either lands before it (step 3) or not at all for this read. The
candidate row is read without a lock. The same statement refuses a bundle whose **uncompressed** text is larger than a
fixed bound (`octet_length(raw_bundle::text)`, R7; `pg_column_size` would measure the possibly compressed stored size)
with `409 candidate_too_large`, before the bundle leaves the database. The
extraction and the aggregation (section 5) run in Node after the transaction has ended.

## 3. The answer (OD2, decided)

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
  as canonical decimal text; **`null` when `athletesWithValue` < `minimumAthletes`** (OD3).
- **`minCanonical` / `maxCanonical`:** the same two values through the version's own conversion, computed in decimal
  and rounded to scale 9 half away from zero (D8's rule, the one `source_metric_value_matches` checks). No other
  rounding.
- **Nothing else** (OD2): no athlete id, name or position; no value list or histogram; no skip codes or counts per
  reason; no `raw_bundle`; no session label beyond what the candidate list already shows (the answer names the
  candidate by id only). A count of 0 is an answer, not an error.

The recommendation the *Rukovodilac* put to the owner is exactly these four facts (the count, min, max, units before
and after) and nothing more. Two options the owner may prefer instead, not built unless chosen: the count of athletes
left out by each stable skip code (useful to explain a low count, it reveals no value), or the athletes the session
has in total.

## 4. The minimum count (OD3, decided)

`minimumAthletes` = **3** (OD3, decided). With fewer athletes with a value, `min` and `max` (and their canonical forms)
are `null` and only the count is answered, because a min or max of one or two athletes is a single athlete's value.
The number is a constant of the service (`PREVIEW_MINIMUM_ATHLETES`), echoed in every answer; changing it is a code
change.

## 5. How a value is computed

For the version's field, through `extractorFor(field)` (J12) with the version's `source_parameters`:

1. Read the candidate's `raw_bundle` once, inside the size bound of section 2 (every source answer is bounded at 5
   MiB by the adapter; the stored bundle has no database bound of its own, hence R7).
2. Apply the mapper's session gates and athlete gates exactly as M4 will (the same functions, exported for this use;
   R3), so the preview never counts an athlete the import would leave out. **Only the stable `error.code` of a
   refusal crosses that boundary:** the mapper's messages and its `anomalies` list carry athlete, track and session ids
   (`gpexeImportMapper.js:282, 303, 318-331`) and never reach an answer or a log line.
3. For each remaining athlete: at the session level the whole-session row; at the drill level each drill row; call
   `extract({ row, more, playerDetails, thresholds }, sourceParameters)`. A skip is not a value.
4. Aggregate per level as in section 3, then convert min and max.

The preview reads the version's parameters, not the team's settings: for a zone or threshold mapping the extractor
checks the team's own thresholds in the bundle against the version's bounds (`team_threshold_missing`, `_split`),
exactly as the import will. A version whose bounds do not fit the team gives a count of 0, which is the useful answer.

## 6. Security and privacy

- **Info-hiding:** the candidate exists for the caller only inside the scope rule; outside it every case, including a
  purged snapshot, is the identical 404 (section 2). A test per role and workspace pins it (section 8).
- **No value of fewer than `minimumAthletes` athletes** leaves the server (OD3). Above it, min and max are still values
  of single athletes (with 3 athletes, two of the three values, unattributed); the number is a product guard, not an
  authorization boundary. As recorded for OD3: the same per-athlete values are already visible to the team's coach
  and admins today (the source-athletes helper values and the stored candidate preview,
  `backend/src/gpexeImportPreview.js:146, 272, 308`).
- **Zone and threshold bounds** (OD4, decided: a system mapping may carry them, and a team's own settings are shown
  only to that team's club and a platform admin) are not
  shown by the preview at all: the answer carries no bound, only counts and values in the field's unit. So OD4 does
  not change 7e; it is the phase 8 screen's question.
- **No coach** gets the preview: the audience is the mapping admins (R1), narrower than today's candidate reads.
- The answer and every log line carry no reason text, no athlete id and no database text (the 7d test pattern).

## 7. What is unchanged

No write, request key, audit row or migration. The candidate list, its stored `preview` and the import switch are
untouched. The phase 8 screen (the Mappings tab) is the first caller; the API is usable without it.

## 8. Tests (7e-B)

- **Access and info-hiding through the real route:** 401; the identical 404 for a coach, a user with no role, another
  club's admin, an admin of two clubs in the other club's workspace, a platform admin in a team workspace, a platform
  admin in club X's workspace over a club Y candidate, the platform workspace over a club mapping, a version not of the
  named mapping, a candidate of another team or club, a team without a club, an archived team or club, a missing or
  repeated `candidateId`, an unknown parameter; each **also with a purged and with an expired snapshot**, so the 404
  always comes before `snapshot_expired`.
- **The order of the 409s** (section 2): `snapshot_expired` (purged, expired) before `candidate_too_large` before
  `candidate_source_mismatch` before
  `source_metric_unsupported` / `parameters_unsupported` before `candidate_not_importable`.
- **The values** on the existing GPEXE fixtures: for each of the ten fields with the bounds of today's specs, the
  counts and min / max equal the values today's mapper would import for the same athletes (before its unit
  arithmetic, then converted by the version); the drill level counts athletes once; a level the version does not apply
  to is `null`.
- **The minimum:** 2 athletes with a value give the count and `null` min / max; 3 give all.
- **The conversion:** min / max canonical through `s → min` and `m/s → km/h` at scale 9 half away from zero (a value
  that rounds at the 10th place).
- **No leak:** a secret-scan of every answer **and every captured console line** of the suite for athlete, track and
  session ids, names, raw keys of the bundle and database texts (a session refused by the mapper included); the
  answer's keys are exactly section 3's.
- **The bounds:** a highly repetitive bundle whose stored (compressed) size is under the bound but whose text is over
  it is `409 candidate_too_large`, and nothing of it is read into Node.
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
- **R6 — the team's current club** decides the candidate's scope (section 2), not 7d's connection-owner club.
  Recommended.
- **R7 — a fixed bound on the bundle's uncompressed size** read by the preview (proposed 16 MiB of
  `octet_length(raw_bundle::text)`, a constant of the service), `409 candidate_too_large` above it. Recommended.

## 10. Not in this contract

The phase 8 screen, the importer (M4), the import switch, any GPEXE request, a stored preview, a preview over a live
GPEXE answer, a preview of several candidates at once.

## 11. Review record

- **Internal round 1 (head `e8060485`):** `code-reviewer`, `db-reviewer`, `security-reviewer`, each READY WITH
  NON-BLOCKING NOTES, no BLOCKER or HIGH. Applied in this revision: the candidate's scope in one statement with `ctx` as
  the only workspace fact, and the team's current club stated as a choice (security MEDIUM); OD4 written with its
  recommended option and marked pending owner (code MEDIUM); the dependency on 7d-B (code and security LOW); a missing
  or repeated `candidateId` is the 404 (security LOW); only the mapper's stable code crosses, with a console-capture
  test (security LOW); the isolation stated and a size bound on the stored bundle, the extraction after the transaction
  (db LOW); the five owner decisions under one numbering (the *Rukovodilac*'s note of 19:29 UTC).
- **Narrow re-reviews of `e8060485..f8768e3a`:** `code-reviewer`, `db-reviewer`, `security-reviewer`, each READY WITH
  NON-BLOCKING NOTES, every earlier finding closed. Their LOW notes applied without a further review: the preview's size
  bound measures the uncompressed text (J11 R7); the 7g guard takes the owner team's lock itself and step 6 re-compares
  the owner (J13); `.gitattributes` for v49's runbook SQL (J13); the C97 blocks drop the read-only wrapper (the editor
  may show only the last statement), cast safely, count every whole-session row per athlete, and say they approximate
  the mapper's gates.
- **External round (heads `fedabc65`, `d85160e0`):** the *Nezavisni revizor* and the *Rukovodilac*, GO with
  non-blocking notes, then a narrow re-GO of the notes applied (J13 and the C97 procedure).
- **The owner's decisions (head `b5c4f7e9`):** OD1–OD7 written as decided, with the owner's words (section 0.1). The
  *Nezavisni revizor*'s narrow re-review: GO, one NIT (a shortened quote without a mark); the *Rukovodilac*'s: one
  MEDIUM (the owner's later turn `d1b4e6e5` contradicts "not comparable by design"). Both withdrew the GO as a merge
  basis.
- **The next head:** the comparison sentence per the owner's turns `d1b4e6e5` and `67e1025c`; OD7's two forms (the
  *Rukovodilac*'s decision); the guideline on several sources; the full quote of `88ad60ca`; the order of 7h and 7i
  pending owner (head `c3193ca7`). Then the owner's turn `e21a1604` (22:19:50 UTC) confirmed OD4 and the order as the
  *Rukovodilac* recommended; written in the following head, with a narrow re-review of the delta by both.

## 12. As built (7e-B)

PR #303, merged as `e6ca433` (2026-10-31 01:42:32 UTC) exactly from `ee873f53` and deployed the same night (live
01:43:55 UTC). **Base** `0117912` (merge of PR #298, the calendar's events and migration v49; no Metrics Core file). The sections above were verified against `6a94ce29`; their references into
code moved since: `boundedRead` is `backend/src/sourceMetricMappingService.js:168-199`; `mayManageActivations` is
`backend/src/sourceMetricAccess.js:46-49` and `readableOwnerKeys` `:109` (7a's module, not `:55-76`); `getMapping` is
`sourceMetricMappingService.js:720-746`. **No migration, no write, no importer change.**

**Files.**
- `backend/src/gpexeImportMapper.js`: `gpexeLevelValues(bundle, extract)`, after `buildGpexeImportPlan`, which is
  unchanged byte for byte.
- `backend/src/sourceMetricPreview.js` (new, pure): `PREVIEW_MINIMUM_ATHLETES` (3, OD3), `STORAGE_SCALE` (9, D8),
  `convertAtStorageScale()` and `previewLevel()`. In its own module, so its tests need no database.
- `backend/src/sourceMetricPreviewService.js` (new): `previewVersion()` and `PREVIEW_MAX_BUNDLE_BYTES` (16 MiB, R7).
- `backend/src/routes/sourceMetrics.js`: the route, after the submit route; `adminContext`, then
  `mayManageActivations`, then the service (which asks `mayManageActivations` again first).
- `backend/src/sourceMetricMappingService.js`: the M2 kit also hands out `PARAMS_AS_TEXT` (one word).

**R3, the mapper's gates, as built.** No refactor: `buildGpexeImportPlan(bundle, { metricSpecs })` already takes its
specs (the seam M4 will use: the discovery document's M4 row has the mapper read the activations instead of
`GPEXE_METRIC_SPECS`), and `gpexeLevelValues` calls it with one spec whose `extract` is the version's extractor with the
version's parameters. So the session gates, the athlete gates, the per-row input and the drill rows are the import's
own. It returns `{ code }` for a `GpexeMappingError` and `{ code: null, athletes: [{ session: [values], drill:
[values] }] }` otherwise: no id, message, anomaly or skip crosses. Any other error is thrown (a `500`). The guard tests
on the mapper's text (B7.7, B7.8, B8.2 and the reasons scan) pass unchanged.

**The order of answers, as built** (section 2):
1. `401` (`requireAuth`); no mapping-admin context, or `mayManageActivations` false: the identical `404`.
2. The path ids (a string UUID each) and the query, read from the **raw query string** with `URLSearchParams`, never
   from Express's parsed `req.query` (its `qs` parser drops a key named like an `Object.prototype` member, such as
   `constructor` or `__proto__`, and nests brackets): exactly one entry, `candidateId`, a UUID. A repeated, empty,
   missing or bracketed one and any other key, those names included, are the `404`. The ids are lowercased (an
   upper-case id is the same candidate).
3. One `boundedRead` (REPEATABLE READ READ ONLY, the read's bounds):
   - **Statement V:** the version of the named mapping, with `owner_key = any(readableOwnerKeys(ctx))`; its factors as
     `trim_scale(…)::text`, its stored parameters through `PARAMS_AS_TEXT` (exact decimal text), its levels, and the
     field's key, family and revision shape. No row: `404`.
   - **The registry** (`extractabilityCode`) is decided from that row alone (pure, no lock), so the bundle is read only
     for a version that may read it; its refusal is still answered in section 2's place, below.
   - **Statement C:** a `MATERIALIZED` CTE holds the candidate with its team and the team's club, both active, and
     the scope in its `WHERE`: `(scope 'system' and no club id) or (scope 'club' and team.club_id = the workspace's
     club)`; it also derives `purged` and `expired` (`raw_expires_at <= now()`). Then, each in a lateral with
     `OFFSET 0` (evaluated once), the uncompressed size `octet_length(raw_bundle::text)` — measured only for a stored,
     unexpired snapshot — and the one decision `too_large` (size above the bound). Then the candidate's last check (of
     its own team) and the GPEXE catalog's `api_family` of that check's host. `raw_bundle` is returned only when
     `too_large` is false, the check read through `source_connection`, the host's family is the version's and the
     version may read it (a GPEXE field the registry accepts); otherwise NULL. No row: `404`. The CTE is the fence
     that applies the scope before anything of the row is measured.
   - Still inside the transaction: `409 snapshot_expired` (`purged`, then `expired`), `409 candidate_too_large`,
     `409 candidate_source_mismatch`, `409 source_metric_unsupported` / `parameters_unsupported`.
4. After the transaction: a bundle that is not an object here fails closed (`500`); the mapper
   (`409 candidate_not_importable` with `current.reason`); then the two levels and `200`.

**Where the build differs from or settles the sections above.**
1. **The family** (R5) is a mismatch also when the version's field is not of `gpexe`, and when the candidate's last
   check is of another team (no constraint ties them; it reads as no path). Both fail closed.
2. **No status gate** (open question): `pending`, `blocked`, `superseded` and `imported` candidates are previewed
   while their snapshot is stored and not expired; a superseded one is tested. The v33 rule that only a candidate
   last seen by a succeeded check is approvable is the approval's, not the preview's.
3. **A candidate whose `drill_parameter_effect` is `not_observed`** is previewed with its drill values, although its
   approval is refused (v33). Recorded; no code without the *Rukovodilac*.
4. **A count of 0 against `candidate_not_importable`:** when the mapper leaves every athlete out it refuses the
   session (`no_importable_participants`), so the answer is that `409`, as M4 will behave. A count of 0 means athletes
   passed the gates and the extractor skipped every value (tested with bounds of 22–55 W/kg, which fit no threshold
   of the fixture's team).
5. **Section 1's list of the mapper's refusals is incomplete.** The twenty `new GpexeMappingError(` sites are at
   `gpexeImportMapper.js` lines 190, 193, 225, 236, 238, 243, 259, 279, 280, 282, 288, 303, 318, 319, 321, 337, 340,
   349, 385 and 386; each becomes `candidate_not_importable` with its code. Section 5's list of messages that carry ids
   is incomplete too (also 236–259, 280, 337, 340, 349 and 386; an anomaly at 378 carries values). None of them
   crosses: only `error.code` leaves `gpexeLevelValues`.
6. **Exact values.** `raw_bundle` is `jsonb`, parsed by node-pg with `JSON.parse`, so a source number reaches the
   extractor as a double and its text is that double's shortest round-trip form (J12 states the same). min and max
   are compared as exact decimals; only those two are converted, exactly (BigInt), and rounded once to 9 decimals half
   away from zero. Every canonical min and max of the value tests passes `training_load.source_metric_value_matches`
   and fails it one unit away.
7. **Messages.** Four new, none naming an id, a parameter or a value: `snapshot_expired`, `candidate_too_large`,
   `candidate_source_mismatch`, `candidate_not_importable`. The registry's two use M2's existing messages.
8. **An existing test changed:** `source-metric-access-7a.test.mjs` test 5 lists the M2 kit's users; the preview
   service is added, and checked to take the bounded read and neither `runWrite` nor `rightsStillHold` (a read has no
   right to re-check under a lock).
9. **The candidate's scope lives in SQL only** (R1: one statement), with no JavaScript second check: a second check
   would make every single-point mutation of the SQL rule equivalent, so the rule could no longer be shown to be
   tested. Its 7d sibling, `activationInScope` (`sourceMetricAccess.js`), decides by the binding's club; the preview
   decides by the team's current club (R6, tested with a team moved to another club). A later phase that changes the
   scope (OD6's club approvals, phase 7h; OD7's system variables used as they are, phase 7i) changes both.
10. **A limit:** the size is measured by serializing the stored value. For any bundle the importer stores (each source
    answer is bounded at 5 MiB) that is cheap; a pathological stored value far above the bound could run past the
    read's 5 s statement bound and answer `409 try_again` instead of `candidate_too_large`. No guard by the stored
    (compressed) size is added, because jsonb's binary size can be several times its text and would refuse a valid
    bundle.

**Tests** (section 8):
- `backend/tests/source-metric-preview-math-7e.test.mjs` (unit, no database): the constants; the conversion on the
  seeded pairs (s → min, m/s → km/h, km/h → m/s), a tie at the 10th place in both signs, an offset, a number written
  with an exponent, no negative zero; one level (an athlete counted once, min / max as decimals, the minimum, a count
  of 0); `gpexeLevelValues` against today's plan for every spec of `GPEXE_METRIC_SPECS` with its own bounds at both
  levels (the athlete on two tracks left out), its exact output keys and per-row input, and each whole-session refusal
  returning `{ code }` only.
- `backend/tests/source-metric-preview-7e.test.mjs` (a disposable database, the real route): `401`; the exact `200`
  shape; the identical `404` with `no-store` for every caller and case of section 8, each with an available, a purged
  and an expired candidate; the path and query cases; who may, by workspace (another team of the same club included,
  R6); the order of every `409`, each pair adjacent; the values of eleven versions over the ten seeded fields equal to
  today's plan, with every canonical min and max checked by `source_metric_value_matches` exactly and one unit away;
  the minimum, a level that is `null`, a count of 0; the size bound with a bundle whose stored size is under the bound
  and its text over it, with every row the request reads recorded (the bundle never leaves the database), and exactly
  the bound (previewed) against one byte more (refused); a family or registry refusal answered without the bundle
  leaving the database; R6 with a team moved to another club; a superseded candidate previewed and nothing written;
  the service's own audience check and its raw query string (prototype-named keys included); the architecture (no
  write, no workspace resolution, one candidate statement, its two fences, the route never reading `req.query`); and
  no preview answer or log line carrying an athlete, track or session id, a raw key of the bundle, a stack or a
  database text. The fixtures' bundles (`backend/tests/support/preview-bundles.mjs`)
  are the rest_v1 stored form with planted 12-digit athlete and track ids.
- **Mutations** of the scope (each half of the rule, both active flags, the clubs join, the owner keys, the version's
  mapping, the whole rule, the connection's owner club in place of the team's), every adjacent pair of the order of
  answers, the family (the bundle guard; the JavaScript check), the registry's bundle guard, the expiry, the size (the
  stored size; the bundle guard; the boundary `>` → `>=`; the refusal), the service's audience check, the query
  (another key; the first of a repeated one; Express's `req.query`), a level's `applies_to`, the gates (athletes from
  the raw rows), the minimum (3 → 2, `<` → `<=`), the count per value, min / max by text, the conversion (the tie, the
  offset, the divisor's scale, the sign, binary floating point) and the seam (a message, every error, drill values at
  the session level): each one fails a test. Equivalent, recorded: the route's own `mayManageActivations` (the
  service asks again), the `no club id` half of the system branch (a system scope never carries one),
  `compareDecimal` against `Number` (every extracted value is a double), measuring the size of an expired row too
  (a cost only: `snapshot_expired` is answered first) and checking `candidate_too_large` before `snapshot_expired`
  (the size is measured only for a stored, unexpired snapshot, so `too_large` is never true where `snapshot_expired`
  applies: the order is held by the statement itself).

**Review record.** Internal round on `aa315883`: `code-reviewer`, `security-reviewer` and `db-reviewer`, each READY WITH
NON-BLOCKING NOTES, no BLOCKER, HIGH or MEDIUM. Applied in the next head: the registry decided inside the read before
the bundle can leave the database (code, LOW); R6 tested with a moved team (security, LOW); the raw query string
(security, NIT); one size decision with its exact boundary tested, the size measured only for a stored, unexpired
snapshot, the catalog joined by GPEXE's own source system, and the two fences explained and pinned (db, LOW / NIT).
Recorded without code: the scope in SQL only (item 9) and the size limit (item 10). Answered: a platform admin
without a club role has no club workspace (`workspace.js` lists a club workspace only for an active `club_admin`
role), so the suite's platform admin in club A's workspace holds that role and still resolves with the
`platform_admin` basis.

**After the external round** (GO on `ee873f53` from the *Nezavisni revizor*, its turn `88e691e3`, and the
*Rukovodilac*, its turn `3bf1249e`, 2026-10-31; no BLOCKER, HIGH or MEDIUM; no new head):
- **The *Rukovodilac*'s answers to the open questions:** (a) no status gate, accepted (the snapshot is the only
  condition); (b) a candidate whose `drill_parameter_effect` is `not_observed` is previewed, accepted, with an
  obligation on phase 8: its screen marks such a candidate as not for import (recorded in the plan, phase 8); (c) a
  count of 0 against `candidate_not_importable`, accepted (the same as the import); (d) the wider list of the mapper's
  refusals, accepted as documented in item 5.
- **The *Rukovodilac*'s optional LOW** (a test that would kill its mutation removing the JavaScript `source_path`
  check): that mutation is equivalent by the schema. v31's `gpexe_import_checks_source_path_facts`
  (`migrations_v2/202610041200_training_load_v31_gpexe_import_checks_source_path.sql:81-89`) gives a `legacy_env`
  check no `source_host_key`, so no catalog row joins and `api_family` is NULL; the family check refuses it anyway, and
  no row with another path but the same family can exist.
- **The *Nezavisni revizor*'s optional LOW-1:** no test pinned that the candidate's last check must be of its own team
  (its mutation dropping `k.owner_team_id = s.owner_team_id` survived; v22 ties the two by a plain foreign key only).
  The test (a candidate whose last check is another team's: `409 candidate_source_mismatch`, the bundle left in the
  database) was written and checked by the executor (the route suite 14/0, that mutation killed), and is kept as a
  follow-up for the next pull request that touches the preview, since both GOs were on `ee873f53`.
