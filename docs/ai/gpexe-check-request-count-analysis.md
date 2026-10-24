# Why a GPEXE check sends so many requests per session (read-only analysis)

Owner order 2026-10-22: analyse why a check (*Find new sessions*) sends so many GPEXE requests per session (the
owner's first estimate was about 90)
and where requests could be cut, cached or dropped - **analysis only; nothing here is implemented**, and
every reduction below needs its own owner decision (the standing rule: "any change to the number of
requests is its own decision", `docs/ai/CURRENT_STATE.md`).

Last verified against commit: `12beb86` (origin/main), plus the rate-limit branch
`fix/gpexe-check-rate-limit`, which changes no request of a check that meets no 429. Code only; no GPEXE
request. Paths below are under `backend/src/`.

## 1. The numbers

A local check through the real code against a fake server3 (14 days, 12 sessions, 20 linked athletes,
drills in 6 sessions, a whole list of 360 rows) sent **805 requests**: `list_sessions` 8, `parent_session`
12, `athlete_list` 12, `athlete_detail` 240, `more` 240, `track` 240, `whole_details` 12, `drill` 23,
`brief_tags` 6, `thresholds` 12.

The formula (A athlete rows of a session, K distinct tracks, D the parent's `drills_count`, N rows of the
team's whole session list):

- per check: `2 * ceil(N / 100)` list pages (the whole list read twice, snapshot A and B);
- per session: `1` parent + `ceil(A / 100)` athlete-list pages + **`A` row reads + `A` `/more/` + `K`
  tracks** + `1` whole-session details + `D` drills + (`D >= 1`: `1` brief, plus the tag list when the
  brief maps tags) + `1` thresholds.

With rows per athlete and drill (see below) a session with 22 athletes and 3 drills costs about 206
requests; the row and `/more/` reads are most of them. Everything is strictly serial and has no pacing
(`gpexeImportService.js` `runCheckBody`; `gpexeRestV1Adapter.js` `fetchSessionBundle`).

**Confirmed on server3 by the production timing line (2026-10-22, the owner's check of 18.10 - 19.10.2026 at
17:11, sanitized):** a session lists **one athlete row per athlete for the whole session and one per
drill**, so the row count is `A = athletes * (1 + D)`, not `athletes`. The line read: `outcome=failed;
code=source_unavailable; total_ms=290684; sessions_found=2; sessions_done=1; athletes=22; tracks=22; drills=3;
requests=list_sessions:8, parent_session:2, athlete_list:3, athlete_detail:193, more:193, track:43,
whole_details:2, drill:7, brief_tags:2, thresholds:2` - 455 requests in 4 min 51 s; 193 rows are consistent with 22 * (1 + 3) +
21 * (1 + 4) for the two sessions (3 and 4 drills); the eight list pages alone took 143 s of network time (about 18 s each).
GPEXE answered 429 on the last of those 455 requests (by the order of the reads, probably the second
session's thresholds). So a production session costs **about 200 - 330 requests** (22 - 25 athletes, 3 - 5 drills),
not 90, and the row and `/more/` reads are about 85 % of them.

## 2. Each request kind

| Kind | Per session | Read for | Consumed downstream |
|---|---|---|---|
| `parent_session` | 1 | confirms the session (bound team, drill count 0-30, day); every later read depends on it | stored `teamSession` (mapper: category, stats valid, start / end / `updated_on`, drill count) |
| `athlete_list` | `ceil(A/100)` | which rows may be read; every row must name the parent | **only the row ids** - the projected list rows are thrown away |
| `athlete_detail` | A | the row again; the only place a row and its track become "confirmed" | the 9 projected row fields (`id, athlete, track, teamsession, drill, is_stats_valid, total_time, total_distance, max_v`) |
| `more` | A | per row | events (counts, thresholds, durations) and power / speed zones |
| `track` | K (de-duplicated per session) | per row's track | timezone, `utc_timestamp`, athlete cross-check (mapper UTC and mixed-timezone guards; writer timezone snapshot) |
| `whole_details` | 1 | | whole-session burst / brake |
| `drill` | D | the complete drill set; the drill-parameter guard (v33) | drill burst / brake; `drill_parameter_effect` |
| `brief_tags` | 1 (+ tag pages) when D >= 1 | drill names | **nothing on the import path**: `drillLabels` is stripped before storage (`sourceImportCredentialResolver.js` `importClientFor`), the mapper always names a drill `Drill N` (`gpexeImportMapper.js`) |
| `thresholds` | 1 | `team/<bound team>/thresholds/?valid_on=<day>` | reference set (zones, provenance hash in the writer) |

Verified by reading the code: the athlete list and the row read use the **same projection**
(`pick(..., BUNDLE_FIELDS.athleteSession)`, `gpexeRestV1Adapter.js` list and row reads); the per-row read is
a holdover from the e03 pilot ("The list rows are enough for the ids; the full row is what the pilot read",
`gpexeClient.js`); the thresholds URL depends only on the bound team and the session's day.

## 3. Reduction options (none implemented)

| Option | Saving | Risk / evidence needed | Owner decision |
|---|---|---|---|
| **Take the row fields from the athlete list** instead of `A` row reads; move the row / track confirmation to the list | about `-A` per session (193 of the 455 requests of the production check, about 42 %) | needs owner-run evidence that server3's list rows carry all 9 fields with the same values as the row read (never compared; plan and probe mode: `docs/ai/gpexe-athlete-list-nine-fields-plan.md`); the stored bundle and its hash stay identical if they do | yes - the largest safe saving |
| **Skip the brief and tag reads in a check** (their output is discarded) | `-1` (or more) per session with drills | removes the brief's failure modes too; drill-label storage is still an open decision | yes - low risk |
| **Thresholds once per day per check** (cached in the one adapter instance) | sessions minus distinct days | none for the data (same URL, same answer); touches the "one bundle is the re-validation window" principle | yes - narrow |
| **Stop a bundle at the first failed drill** before brief / thresholds | 1-2 per failure | none; already true for a rate-limit stop on this branch | yes - low |
| **One track per session** instead of one per athlete | about `-A` per session | loses the per-track UTC, timezone and athlete cross-checks and mixed-timezone detection; mapper and bundle shape change, so every stored session reads as changed once | yes - higher risk |
| **Skip unchanged sessions** (compare list fields such as `updated_on` with the stored candidate) | most of a repeat search | the v33 finalization needs every session of the window staged (else it withdraws them), retention re-arms on each sighting, previews follow link changes; the code itself expects values to change without a newer `updated_on` (`needs_review`, drill details filled later); needs proof that server3 moves `updated_on` on every change | yes - redesign |
| **Skip sessions the mapper always blocks** (not FULL TRAINING, stats not valid) | their whole bundle | loses the raw athlete rows *Link athletes* uses | yes |
| **One whole-list read instead of two**, or the server's date filter | `ceil(N/100)` per check | reopens the paging race (owner decision 2026-10-09) or trusts a filter seen ignoring the window (2026-10-08) | yes - reverses earlier decisions |

**What decides the order:** the shape of GPEXE's limit. If it is a count per time window, even about 60
requests per session will meet it after a few sessions; the rate-limit line of a failed check
(`first_429_request`, `first_429_elapsed_s`, `retry_after`; runbook section "When GPEXE asks to slow down
(429)") is the first evidence of that shape. A pacing between requests is a further option once it is known.

## 4. Tests a reduction would have to update

`backend/tests/gpexe-check-timing.test.mjs` (`EXPECTED_REQUESTS`, the exact call order, heartbeat and
re-validation counts), `gpexe-rest-v1-adapter-reads.test.mjs` (B2.1 path order, B5.1 brief / tags, B7.4,
B9.x), `gpexe-import-credential-resolver.test.mjs`, `gpexe-check-finalization.test.mjs` (withdrawal and
staging counts) and `gpexe-in-app-import.test.mjs` (a repeat check counts unchanged).

## 5. The reduction (owner order 2026-10-23)

### Done now, without new evidence

On branch `feature/gpexe-check-request-reduction`, on top of #209. The stored bundle stays the same, and so does its
hash:
- **No brief and no tag list in a check.** The check strips the drill labels before storing (`importClientFor`).
  The adapter option is `bundleDrillLabels: false`, set by `openImportSource(…, { checkBundle })`.
- **The thresholds of a day are read once per check** (`thresholdsByDay`, one adapter instance per check). Every
  later answer is a copy, so nothing a caller changes reaches the next session.
- **Rows from the athlete list, behind `CHECK_ROWS_FROM_LIST` (`gpexeImportService.js`).**
  - **What it does:** it reads one canary row per session instead of every row. If the canary's own read differs
    from its list row, the session is refused (`source_answer_unexpected`, reason `list_row_differs_from_row_read`).
    A list row whose track cannot be read is refused before the canary.
  - **It stays `false`** until the owner-run athlete-list comparison returns `same`. Its rules are in
    `docs/ai/gpexe-athlete-list-nine-fields-plan.md` section 5, and the tool is PR #210. The one sitting that
    runs it is section 6 of `docs/ai/gpexe-details-coverage-plan.md`, added by PR #211 (merged as `8e20da1`).
  - Turning it on is that one line; its tests are already here.

### Measured on the same fixture

`gpexe-check-timing.test.mjs` uses three sessions of one day, one with five drills, and 20 athletes, through the real
check route on a disposable database:

| | Requests |
|---|---|
| Before (main + #209) | 206 |
| Now (no brief or tags, thresholds once per day) | **203** |
| With rows from the list (after the athlete-list comparison returns `same`) | **146** |

Test 8 proves the stored bundles are the same: after a check with every row read, a check with the rows from the
list finds all three sessions unchanged.

### Estimated for the owner's check of 2026-10-22, 17:11

That check had two sessions, 22 and 21 athletes, 3 and 4 drills, 455 requests.

| Step | Requests |
|---|---|
| Brief and tags dropped | about 453 |
| Rows from the list (athlete-list comparison `same`) | about 262 |
| `/more/` from the grouped details (details-coverage `same` for every family) | about 71, close to the 67 estimated |

### After the owner-run sitting (each step only for a `same`)

1. **The athlete-list comparison (PR #210) returns `same`:** `CHECK_ROWS_FROM_LIST = true`, then one controlled
   check with its timing line.
2. **The details-coverage probe (PR #211) returns `same`** for events, both zone families, the mapping and the
   drill level:
   - **Mapper:** it takes events and zones from the details answers the check already reads (`details.full` and
     the drill answers), with the same thresholds, bands and readiness guards.
   - **Reads:** the per-row `/more/` read is dropped, except one `/more/` canary per session compared with the
     details.
   - **Report before building:** this changes the stored value provenance (`sourceContext.field`) of those six
     metrics and the bundle's shape. Stored candidates would read as changed once. Nothing has been imported yet.
3. **Anything `insufficient` or `differs`:** that data keeps its present read. Zone readiness is the likely case,
   since the old script shows no zone-level `is_ready`. In that case `/more/` stays for every row, because the zones
   need it.
