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

## 5. The reduction (owner order 2026-10-23) and the owner-run sitting (2026-10-24)

### Built (PR #212)

The stored bundle stays the same, and so does its hash:
- **No brief and no tag list in a check.** The check strips the drill labels before storing (`importClientFor`).
  The adapter option is `bundleDrillLabels: false`, set by `openImportSource(…, { checkBundle: true })`.
- **The thresholds of a day are read once per check** (`thresholdsByDay`, one adapter instance per check). Every
  later answer is a copy, so nothing a caller changes reaches the next session.

### The owner-run sitting (2026-10-24, 08:55 UTC, run once; sanitized reports, as returned by the owner)

**Budget and outcome:**
- Both tools ran to the end, with `stoppedBy: null` for each and no 429.
- 12 + 11 = 23 requests, with a 2 s pause before every read.
- GPEXE reported version 9.11.12, and the team's list held 374 sessions.

**A. The athlete list against each row's own read** (`--mode athlete-list`, two parents with 2 drills each, 6 rows
compared): `differs`.
- Eight of the nine projected fields are in every list row with equal values: `id`, `athlete`, `track`,
  `teamsession`, `drill`, `is_stats_valid`, `total_time`, `total_distance`.
- **`max_v` is absent from every list row** and present in every row's own read.
- The mapper reads `max_v` for every row, whole and drill (SPEEDmax). So the per-row read stays, and rows from the
  list would save nothing. The switch built for it on the first commit of PR #212 was removed again, and it
  stays in that commit's history.
- **Seen in passing:** in one of the two sessions, not every athlete has a row per drill (13 whole rows, 23 drill
  rows for 2 drills). The importer already allows that.

**B. The grouped details against `/more/`** (one parent with 2 drills, two athletes, whole and drill 0; drill form
`rest_v1`): `differs`.

| Family | Verdict | What it means for a check |
|---|---|---|
| `events` (acc/dec at 2.5 m/s², 0.3 s) | `same` | Equal for both athletes at both levels, and the team's event rule is the importer's. But `/more/` is read for the zones anyway, so moving the events saves no request. They stay on `/more/`. |
| `powerZones` | `differs` | The details carry 4 power zones and `/more/` carries 5. Neither numbering reproduces `/more/` (`no_numbering_reproduces_more`), and the units are not the closed words. They stay on `/more/`. |
| `speedZones` | `insufficient` | The details carry 2 speed zones and `/more/` carries 3 (`values_missing_or_not_ready`). They stay on `/more/`. |
| `mapping`, `drillLevel` | `same` | The details name the same athletes as the list, and the drill answer is not the whole session. |
| row scalars (reported only) | — | `total_distance` is equal. The details' `average_time` is not `total_time`. `max_v` could not be compared, because the list rows lack it. |

The details carry no zone-level readiness (`detailsHasReadinessKey: false`).

### What a check reads now

For each row, a check still reads the row (for `max_v`), `/more/` (for the zones and events) and the athlete's
track. The proven saving is only the drill labels and the repeated thresholds:

| | Requests |
|---|---|
| The fake-source check of `gpexe-check-timing.test.mjs` before (main + #209) | 206 |
| The same check with PR #212 | **203** |
| The owner's check of 2026-10-22, 17:11 (455 requests), estimated with PR #212 | about 453 |

### What would still cut the per-row reads (not built, each a new owner decision)

- **The row read:** it could go only if `max_v` came from another answer with proven equal values. The details'
  `max_values_speed` is a candidate, but the sitting could not compare it, and its unit is not one of the closed
  words.
- **`/more/`:** it stays as long as the power and speed zones come from it. The details' zones are not the same
  zones.
