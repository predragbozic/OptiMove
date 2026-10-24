# Plan: can the grouped details answer replace each row's /more/ read? (details-coverage probe)

**Result (owner-run sitting, 2026-10-24, run once, 11 requests, no 429): `differs`.**
- `events`, `mapping` and `drillLevel`: `same`.
- `powerZones`: `differs`. The details carry 4 zones and `/more/` carries 5, and no numbering reproduces them.
- `speedZones`: `insufficient`.
- So `/more/` stays for every row. Details: `docs/ai/gpexe-check-request-count-analysis.md` section 5.

Status before that sitting: **prepared and tested against a fake server only. No GPEXE request had been sent.** Owner order 2026-10-23,
after the read-only analysis of the request count and of the old Google Apps Script. The owner-run read happens
only on a separate owner order, after the owner has reviewed this preparation.

Last verified against commit: `12beb86` (`origin/main`). Sources: `backend/src/gpexeImportMapper.js` (the rules
compared), `backend/src/gpexeRestV1Adapter.js` (the reads and projections a check uses), and the old script's
use of `team_session/<id>/details/` and `?drill=<i>` (attested by its code only).

## 1. The question

A check reads `rest/v1/athlete_session/<id>/more/` once per athlete row. There is one row per athlete for the
whole session and one per drill, so these reads are about 42 % of a check (193 of 455 in the owner's check of
2026-10-22, 17:11). The importer takes from `/more/`:
- the acceleration and deceleration event counts, only when `/more/` says the threshold is ±2.5 m/s² and the
  duration 0.3 s;
- the distance of the power zones 25–60, 60–75 and ≥75 W/kg and of the speed zone ≥7 m/s. A zone is used only
  when the team thresholds of the day hold both bounds and do not split the band, and exactly one ready zone has
  those bounds.

`team_session/<id>/details/` (and `…/?drill=<i>`) answers with the values of every athlete at once. If it carries
the same numbers, a check could read `1 + D` answers per session instead of `athletes × (1 + D)`. Together with
the rows taken from the athlete list (PR #210), that is about 67 requests instead of 455 for the same check.

**What this probe must prove, and what a field's name never proves:** the details' field names come from the old
script (`acceleration_events`, `deceleration_events`, `athletesessionpowerzone_distance_<n>`,
`athletesessionspeedzone_distance_<n>`, `average_time`, `total_distance`, `max_values_speed`). They are
hypotheses. A pair is equal only when both reads carry a finite number and the numbers are the same.

## 2. The tool: `backend/scripts/gpexe-details-coverage-probe.mjs`

**Why a separate script.** It is a file of its own, not a mode of the capability probe, so it does not touch the
file PR #210 changes. It uses only exports that are already on `main`.

**Requests** (`DETAILS_COVERAGE_MAX_REQUESTS` = 12: the 11 below, plus one only when the drill's `rest/v1` form does
not answer):

| # | Request | Count |
|---|---|---|
| 1 | the exchange, in the host's confirmed form (form-encoded `api-token-auth/`) | 1 |
| 2 | `rest/v1/team_session/?team=980&limit=100`, first page | 1 |
| 3 | the parent's own read | 1 |
| 4 | the parent's athlete list `rest/v1/athlete_session/?teamsession=<id>&limit=100`, first page | 1 |
| 5 | `rest/v1/team_session/<id>/details/` (the whole session) | 1 |
| 6 | `rest/v1/team_session/<id>/details/?drill=0`; only if that does not answer with players, once more as `api/team_session/<id>/details/?drill=0`, the drill read a check sends today | 1 (2) |
| 7 | `rest/v1/team/980/thresholds/?valid_on=<day>` | 1 |
| 8–11 | `rest/v1/athlete_session/<row>/more/` for two athletes, their whole row and their drill-0 row | 4 |
| | **total** | **11 (12)** |

**Pace, 429 and boundaries:**
- a pause of 2 s before every read (about 20 s for the run), none before the exchange; the pause has no option;
- the first 429, the exchange's included, ends the run with no repeat. The report keeps the request number and
  `Retry-After` as a kind word with bounded seconds;
- GET only after the exchange, one host, redirects never followed, a timeout per request, answers bounded at
  5 MiB, no database, nothing written.

**Choices, each from an answer already checked:**
- **The parent:** a row of the page of team 980 with a readable id, named in no other row's `drills`, with an
  explicit `drills` list of **at least two** entries and `is_stats_valid: true`; repeats of one id count once.
  - **At least two drills:** a drill can then never be the whole session.
  - **Which one:** the parent with the **fewest** drills, the first on the page among equals, so its athlete list
    (athletes × (1 + drills) rows) most likely fits the one page read.
- **Its own read must confirm:** the same id, team 980, a drill count from 2 to 30, valid statistics and a day.
- **The two athletes:** in the athlete list's order, those with exactly one whole row and one drill-0 row, both
  with valid statistics, and an entry in both details answers.

**Stops before the next request:**
- an unreadable list;
- a row of another team or session, or a team in an unknown shape;
- an unconfirmed parent;
- an empty list, a repeated row id, or a row whose drill the session does not have;
- a details answer without a `players` object;
- unreadable thresholds;
- no comparable athlete;
- a `/more/` that names another row;
- the request cap.

## 3. What is compared (in memory) and the verdicts

The importer's rules are read from its own metric specs (`IMPORTED_MORE_RULES`, `IMPORTED_ROW_SCALARS`), and its
number rule is the mapper's `finiteNumber`. So the probe cannot compare against a rule the importer does not
apply.

| Family | Compared | `same` only when |
|---|---|---|
| **events** | each `/more/` count against `acceleration_events` / `deceleration_events` | every pair equal, the `/more/` rule as imported, the team's own event rule as imported, at least one count not zero, all four pairs |
| **powerZones**, **speedZones** | every `/more/` zone against the details key at its position | see below |
| **mapping** | the whole and drill-0 players against the athletes of the list's rows; player keys canonical; `/more/` names its row | see below |
| **drillLevel** | per athlete, the drill's numbers against the whole session's, in `/more/` and in the details | for both athletes, both differ, so a server that ignored `?drill=` cannot pass for a drill |
| **rowScalars** (reported, not deciding) | list row `total_time`, `total_distance`, `max_v` against `average_time`, `total_distance`, `max_values_speed` | every pair the same number |

**A zone family is `same` only when:**
- every `/more/` zone is ready;
- exactly one numbering (from zero or from one) reproduces every zone of every pair, with at least one distance
  not zero;
- the importer's guards could run without `/more/`:
  - its bands pass in every pair;
  - the zones' bounds follow the team thresholds in every pair, so a details zone can be placed by its number;
  - the details carry each zone's readiness at the zone's own level (`is_ready` on the zone value), equal to
    `/more/`'s. A flag on the player is reported (`details_readiness_player_level_only`) and never accepted,
    since it cannot say that one zone is not ready while others are.

**The verdict on a zone family otherwise:**
- details calling a ready zone not ready is `differs`;
- readiness the details do not carry is `insufficient` (`details_readiness_not_carried`): the importer's
  `zones_not_ready` guard could not run.

**The mapping is:**
- **`differs`** when a player key is not canonical, or when an athlete with a valid row of that level is missing
  from a non-empty players map;
- **`insufficient`** for an empty players map (a drill not computed yet), an incomplete page, or fewer than two
  athletes.

Athletes whose rows the importer skips (statistics not valid) are not required, and players without a row are
counted but are not a difference.

**The overall verdict on replacing `/more/`:**
- **`same`:** events, both zone families, the mapping and the drill level are all `same`, in a run that ended as
  built.
- **`differs`:** any of them has a confirmed difference. This holds even when the run stopped later.
- **`insufficient`:** everything else, with its reason. That includes a stop code, values missing or not ready,
  zeros only, two numberings that both fit, an incomplete page, and fewer pairs than planned.

**Why the row scalars do not decide.** A check would keep reading them from the rows; the probe only says whether
the details carry them and in which relation and unit (`equal`, `times_3_6`, `divided_by_60`, `divided_by_1000`,
`other`). A consistent unit conversion stays `insufficient`. Equal-looking values are never equal by name.

**Printed:** statuses, kinds, closed words, counts and booleans:
- each request's answer key names, only from a closed list, the others counted;
- unit words, only from a closed list, otherwise `<other>`;
- no header text: a JSON content-type boolean, a version only in a numeric shape, a header count;
- a request error only as a closed-shape word (a system code or a class name), else `error`.

**Never printed:** an id, a name, a date, a value, a URL or a key outside the list. The players' `athlete` objects
(names) are dropped as soon as an answer is read. The final guard refuses a report that contains the credential or
the issued token.

**Tests:** `backend/tests/gpexe-details-coverage-probe.test.mjs` (DC1–DC16, fake fetch only), with mutations of
the key guards, all killed.

## 4. What the result can and cannot prove

- **The drill form.** The probe reads `rest/v1/…/details/?drill=0`, as the old script did. Only if that does not
  answer with players does it read the `api/` form, which a check has read in production since 2026-10-11. The
  report names the form compared (`drillForm`).
  - Taking events and zones from the drill answer a check already reads would add no request.
  - Moving the drill read to the `rest/v1` form would be a change of its own.
  - Whichever form is used, the v33 guard against a `?drill=` that does not tell drills apart stays.
- **Readiness.** If the details carry no zone-level readiness, both zone families stay `insufficient` whatever
  their values. The importer's `zones_not_ready` guard would then need another source, and that is the owner's
  decision, not this probe's.
  - **What `same` proves:** the readiness of ready zones only. A zone `/more/` calls not ready makes the family
    `insufficient`, so `notReadyCaseObserved` is always false next to `same`.
  - **The not-ready case stays unproven.** An implementation must stay fail-closed for it: for example, read
    `/more/` when the details do not carry a zone-level `is_ready`.
- **A refused credential** (401 or 403) on a details read ends the run. No `api/` read follows it.
- **The sample.** One session (the one with the fewest drills, at least two), its drill 0 and two athletes are a
  sample, not every row. Like the athlete-list plan,
  an implementation needs a **canary**: one `/more/` per session compared with the details, stopping the check
  fail-closed on any difference.
- **Metrics Core.** Taking events and zones from the details changes their source field. That is a new mapping
  version of the source metric (`metrics-core-mapping.md`), with `definition: confirmed` proven again. It is not
  part of this probe.
- **Stored candidates.** If the stored bundle changes shape, every stored candidate reads as changed once. That is
  a decision for the implementation PR.

## 5. Order of work (each step on the owner's order)

1. **This PR** (Draft): the tool, its tests and this plan. No change to the check, the import, the database or
   Metrics Core.
2. **#209 and #210 merged first**, then this PR, so that one checkout of `main` carries both tools. A section 4d of
   `docs/ai/gpexe-rest-v1-compatibility.md` follows once #210 is merged, so the two PRs never edit the same place.
3. **One owner-run sitting** with both tools (section 6), at most 24 requests.
4. **Decision per question:**
   - **A** (athlete list): `same` means the check takes its rows from the list, keeping a canary row read per
     session. Otherwise the row reads stay.
   - **B** (details): a `/more/` read can go only when every family the importer reads from it is `same`: events,
     both zone families, the mapping and the drill level. Otherwise `/more/` stays for those rows.
   - **`insufficient` is no stop of the work:** that data keeps its present, proven read.

## 6. The owner-run sitting: both tools, at most 24 requests

**What it answers:**
- **A.** Does the athlete list carry the nine row fields with the same values as each row's own read? That is
  `capabilities.athlete_list_fields.verdict` of the first tool (PR #210).
- **B.** Which of the metrics the importer reads from `/more/` the grouped details carry with the same values and
  the same validation? That is `coverage.families` of the second tool:
  - `events`, `powerZones`, `speedZones`, with `mapping` and `drillLevel` for the identities;
  - `rowScalars`, reported only.

**Before it:**
- `main` carries #209, #210 and this PR;
- no check, identity load, Connect, Reconnect, Test or Bind is running, and no deploy is in progress (a deploy
  ends a running check);
- at least 60 minutes have passed since the last 429.

**Budget:**
- **The first tool:** at most 12 requests (1 exchange + 11 GET).
- **The second tool:** at most 12 (1 exchange + 10 GET, plus 1 only if the drill's `rest/v1` form does not
  answer).
- **Together:** never more than 24. Each pauses 2 s before every read.
- **On a 429:** the first 429 ends that tool, and the second tool is not started.

**The commands** (PowerShell, in the repository folder; the credential typed masked, in this terminal only):

```powershell
Set-PSReadLineOption -HistorySaveStyle SaveNothing
$u = Read-Host "GPEXE username" -AsSecureString; $env:GPEXE_USERNAME = [System.Net.NetworkCredential]::new("", $u).Password; Remove-Variable u
$p = Read-Host "GPEXE password" -AsSecureString; $env:GPEXE_PASSWORD = [System.Net.NetworkCredential]::new("", $p).Password; Remove-Variable p
try {
  node backend/scripts/gpexe-rest-v1-capability-probe.mjs --mode athlete-list > "$env:TEMP\gpexe-probe-a.json"
  $a = if ($LASTEXITCODE -eq 0) { Get-Content "$env:TEMP\gpexe-probe-a.json" -Raw | ConvertFrom-Json } else { $null }
  if ($null -eq $a -or $a.stoppedBy -eq "rate_limited") { Write-Host "Stopped after the first tool: the second is not run." }
  else { Start-Sleep -Seconds 2; node backend/scripts/gpexe-details-coverage-probe.mjs > "$env:TEMP\gpexe-probe-b.json" }
} finally { Remove-Item Env:GPEXE_USERNAME, Env:GPEXE_PASSWORD -ErrorAction SilentlyContinue }
Test-Path Env:GPEXE_USERNAME; Test-Path Env:GPEXE_PASSWORD
```

**What comes back:**
- Only the two JSON files, `gpexe-probe-a.json` and `gpexe-probe-b.json`. Both carry only verdicts, statuses,
  kinds, closed words, counts and booleans by construction, and both refuse to print a credential or the issued
  token.
- Nothing else is copied: no screenshot of GPEXE and no terminal history.
- The two `Test-Path` lines must print `False`.
