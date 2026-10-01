# GPEXE `server3` / `rest_v1` against the importer's `e03` / `api`: compatibility

Status: F3c2a merged (PR #131); F3c2b, the owner-run probe, in review (owner order 2026-10-01).
Read-only adapter profile only
(`backend/src/gpexeRestV1Adapter.js`, selected by `backend/src/sourceAdapters.js`). No route, no
database write, no credential storage, no binding, no import, no request to GPEXE by the main
session. The existing `e03` importer (`backend/src/gpexeClient.js`,
`backend/src/gpexeImportService.js`) is unchanged and does not use the adapter.

## 1. How this table was made

1. **The existing `e03` / `api` client was traced** (`backend/src/gpexeClient.js`): it sends nine
   kinds of request, all `GET`, all relative to `https://e03.gpexe.com/api/`, with
   `Authorization: Token`, redirects refused, header paging (`X-Total-Count`, `Link rel=next`)
   read to the end or refused, and a drop list of personal fields.
2. **The legacy endpoint map** is the one recorded in `docs/ai/gpexe-f3c-auth-discovery.md`
   section 2 (endpoint strings). That section elides the session list's parameters; their
   **names** (`team`, `limit`, `start_timestamp_gte`, `start_timestamp_lte`) were read from the
   legacy file's endpoint strings on 2026-09-29 by a search that printed parameter names only,
   before the file was moved out of the repository. The file was not opened for this work.
3. **The owner-run read-only verification of 2026-09-29** on `server3`
   (`docs/ai/source-connections-f3c2-contract.md` section 1.8) is the only evidence of what
   `rest_v1` answers: three reads, their status, body shape and field names.
4. **The owner-run read-only capability probe of 2026-10-01** (`--mode full`, section 4):
   one exchange and ten reads, `stoppedBy: null`, 11 requests in all; only the sanitized report
   (statuses, shapes, field names, counts, booleans) came back and only its verdicts are
   recorded here — no id, no date, no value, no field list is copied into this document.

Words used: **same** — same resource name and parameters, only the family prefix differs, and the
answer was seen; **mapped** — a different path or parameter gives the same information, and the
answer was seen; **missing** — a probe showed the family does not have it; **unknown** — not
verified. The probe's report adds two words of its own: **proven** for the list it starts from
(the one read verified before), and **observed** for a read that answered 200 but has no
importer counterpart to be "same" as (the tags). *Legacy-attested* means the owner's working integration uses that path or parameter,
but OptiMove has never seen its answer: it is still **unknown** for the adapter.

## 2. The table

| # | Importer operation (what `e03` / `api` does) | `e03` / `api` request | `server3` / `rest_v1` | Evidence | Adapter |
|---|---|---|---|---|---|
| — | Team list (not used by the importer; used to check visibility) | not used | **same**: `team/` | probe: 200, array, `X-Total-Count` 8, contains 980 | `countVisibleTeams()` — count and a boolean only |
| — | Team read (not used by the importer; used to check the binding) | not used | **same**: `team/<id>/` | probe: 200, object | `verifyBoundTeam()` |
| 1a | Sessions of a team, by team and page size (**not an importer request**: the importer always sends the date window, row 1b) | not sent without a date window | the resource and its paging are proven: `team_session/?team=&limit=` | probe: 200, array of 1, `X-Total-Count` 308, `Link` header; field names include every field the importer's list reads (`id`, `team`, `category_name`, `start_timestamp`, `updated_on`, `drills`, `drills_count`, `is_stats_valid`) | `listSessions({ limit, maxPages })` — the whole list or a refusal; drills left out as the importer does |
| 1b | Sessions of a team **in a date window** | `…&start_timestamp_gte=&start_timestamp_lte=` | **same** | probe 2026-10-01: the filter is applied under the section-4 rule (every row of team 980 and inside the window, the chosen session among them, the filtered count smaller than the unfiltered count of the same run) | still `source_capability_unavailable` (`session_list_by_date`) until the adapter implements it |
| 2 | One session (its team, `drills_count`, start) | `team_session/<id>/` | **same** | probe 2026-10-01: 200, object, team 980, `drills_count` and `start_timestamp` present; **no `drills` list** on this read (the list rows carry it) | unavailable (`session_read`) until implemented |
| 3 | Athlete rows of a session | `athlete_session/?teamsession=<id>&limit=` | **same** | probe 2026-10-01: 200, every row of the asked session | unavailable (`athlete_session_list`) until implemented |
| 4 | One athlete row | `athlete_session/<id>/` | **same** | probe 2026-10-01: 200, names the same session | unavailable (`athlete_session_read`) until implemented |
| 5 | Burst and brake events of an athlete row | `athlete_session/<id>/more/` | **same** | probe 2026-10-01: 200 | unavailable (`athlete_session_more`) until implemented |
| 6 | Track (time zone, device restarts) | `track/<id>/` | **same** | probe 2026-10-01: 200, id from the confirmed athlete detail | unavailable (`track_read`) until implemented |
| 7 | Whole-session values per athlete | `team_session/<id>/details/` | **same** | probe 2026-10-01: 200 | unavailable (`session_details`) until implemented |
| 8 | Values per drill | `team_session/<id>/details/?drill=<n>` | **`not_observed`** (still **unknown**) | probe 2026-10-01: no request was sent — the parent's own read carries `drills_count > 0` but no `drills` list, so the parent could not be confirmed under the precondition of section 4; the drill-only run (section 4) confirms the parent from the list row's `drills` and the parent's `drills_count` instead | unavailable (`session_drill_details`) |
| 9 | Threshold set valid on the session day | `team/<team>/thresholds/?valid_on=` | **same** | probe 2026-10-01: 200 on the confirmed session's day | unavailable (`team_thresholds`) until implemented |
| — | Units | no endpoint (numbers are SI on `e03`, verified in the pilot) | **unknown** | none; that `rest_v1` numbers are SI is not verified (the probe records no value) | unavailable (`units`) |
| — | Session tags | not used by the importer | **observed** (legacy-attested path `team_session_tag/?team=&limit=`) | probe 2026-10-01: 200, asked for team 980; no returned tag named another team (one would have stopped the run); whether `team` is honoured is not shown | unavailable (`session_tags`) |

Nothing is **mapped** and nothing is **missing**: both words need an answer that was seen and
differs from the importer's form, and no read was refused. **The adapter column has not moved:**
a proven read becomes available only when the adapter implements it with its own tests (the
next step after the drill-only run, on the owner's order).

## 3. What is proven compatible today

**Eight of the importer's nine request kinds are proven on `rest_v1` by the owner-run probe of
2026-10-01 (rows 1b–7 and 9: same paths, same parameters, 200 for team 980); the drill read
(row 8) is `not_observed`.** The adapter still implements only the three reads verified on
2026-09-29, two of which the importer does not send at all and one of which is the importer's list
without its date window:
- the credential reads the bound team (`verifyBoundTeam`);
- how many teams the account sees (`countVisibleTeams`);
- the team's sessions can be listed by team and page size, the whole list or a refusal, with the
  header paging the `e03` client already understands (`listSessions`). Like the importer, it
  leaves out a session that another session names in its `drills`.

**Not implemented, so the importer cannot run on `server3` yet:** everything a session bundle is
made of (rows 2–9) and the date window (row 1b) are proven but not written into the adapter,
and the drill read (row 8) is not proven at all. `fetchSessionBundle()` therefore still answers
`source_capability_unavailable`.

Also not proven, and not a matter of paths: that the **values** of `rest_v1` mean what the
importer's mapper assumes for `e03` — naive timestamps in UTC, numbers in SI units, drills as
separate sessions named in their parent's `drills`, `athlete_session.drill` null for the whole
session. Field names look alike; meanings were verified on `e03` only.

## 4. What needs an owner-run read-only probe

**The probe is built (F3c2b): `backend/scripts/gpexe-rest-v1-capability-probe.mjs`**, owner-run
only, with the same rules as before: own-terminal input, one exchange in the host's confirmed
form, then GET requests only for Team ID 980, at most 14 requests in all, a timeout per request,
answers bounded at 5 MiB, redirects never followed, no retry, no database. Only statuses, body
shapes, field names, counts and booleans are returned, nothing of any body. Each line below is
one request; ids are taken from the previous answers of the same run, never typed and never
guessed, and a chain stops as soon as the previous answer gives no safe next id (the tag list,
which needs no derived id, still runs, asked for team 980; thresholds run only on the day of the
session's own confirmed read, otherwise `not_observed` with `session_not_confirmed` or
`no_confirmed_day`). A row of
another team, or an athlete row of another session, stops the whole run
(`stoppedBy: team_isolation_failed`); a row whose `team` is in a shape the probe cannot read (an
object, a URL, a list) stops it too (`team_unknown_shape`), because an unreadable team is not a
confirmed team. Nothing after the session's own read runs unless that read confirmed team 980,
except the tag list.
The host and the team cannot be changed by an option. Masked paths show no id of any length and
no date; the importer's drop list of personal fields applies before anything is described, so a
dropped field (such as an athlete's name) is not even named. **The PowerShell commands for the run are handed over only after the
external review of the probe tool** (owner, 2026-10-01). Its contract tests
(`backend/tests/gpexe-rest-v1-capability-probe.test.mjs`) run against a fake server only.

**Result of the first owner-run probe (2026-10-01, `--mode full`, sanitized by the owner):**
`stoppedBy: null`, 11 requests (one exchange, ten reads; the two drill reads were not sent).
Verdicts: `session_list` proven; `session_list_by_date`, `session_read`, `session_details`,
`athlete_session_list`, `athlete_session_read`, `athlete_session_more`, `track_read` and
`team_thresholds` **same** (8 of the importer's 9 reads); `session_tags` observed; `units`
`not_observed` (no endpoint, no value is read); `session_drill_details` **`not_observed`** with the
reason `no_confirmed_parent`: the list rows carry a `drills` list, but the parent's own read
(`team_session/<id>/`) carries `drills_count > 0` **without** a `drills` list, so the precondition
of the table row below (a non-empty `drills` list on the parent's own read) could not be met and
no drill request was sent. No id, date, value or field list of the report is copied here.

**The drill-only run (`--mode drill`, owner order 2026-10-01, built, not yet run):** the full
run is not repeated. One exchange, then at most six reads, each one only after the previous
answer confirmed the identity it depends on, and the chain stops **without the next request** at
the first identity or team that is not confirmed: (1) the unfiltered list of team 980 gives a
parent row for certain — a row of team 980 with a non-empty `drills` list — and the first
canonical id of that list is the drill id (no such row: `no_parent_with_drills_in_list`, nothing
else is read); (2) the parent's own read must answer 200 with the **same** `id`, `team` 980 and
`drills_count > 0` — a `drills` list is not required there, that is what the full run found
missing (another id: `parent_id_mismatch`; no readable id, no `drills_count > 0`, a non-200 or a
list-shaped body: `parent_not_confirmed`; another team: `team_isolation_failed`; a team in an
unreadable shape: `team_unknown_shape`; a list row that names itself as its drill is refused
before any read: `drill_is_parent`); (3) the drill session's own read must answer 200 with the
**same** drill `id` and `team` 980, and if it names its parent (`teamsession`) it must name the
chosen one (`drill_id_mismatch`, `drill_parent_mismatch`, `drill_not_confirmed`, the two team
stops); (4) the parent's whole-session details (not 200:
`whole_session_details_unavailable`); (5) the drill by its
position on the parent, the importer's exact form of the table row below; (6) the drill by its
real id; (7) the matrix of the table row below, unchanged. The report carries `mode: "drill"`,
`session_read` (the verdict word with the full run's meaning — team, `drills_count` and
`start_timestamp` present — beside the gate booleans `idMatchesList`, `teamIs980`,
`drillsCountPositive`, `drillsListPresent`, `parentConfirmed`), `drill_session_read` (**observed**
or `not_observed`, never **same**: the importer never reads a drill session by its id; with
`idMatchesParentList`, `teamIs980`, `namesParent`, `drillConfirmed`), `session_details` and
`session_drill_details` (on every early stop `not_observed` with the stop code as its reason);
nothing of the athlete chain, the date window, the thresholds or the tags is read again. The request cap of this
mode is 7 whatever is asked (`DRILL_MODE_MAX_REQUESTS`). Its PowerShell commands are handed over
only after the owner's external review of the mode.

The report, per capability: a verdict (`proven` for the list this run starts from; `same`,
`mapped`, `observed`, `not_observed`), the status, counts and booleans such as `parentConfirmed`,
`parameterApplied`, `equivalent`, `allRowsInsideWindow`, `filteredCountSmallerThanUnfiltered`,
`athleteIdDerived`, `hasTimezoneField`; per request the masked path, status, shape, field names
and counts. `stoppedBy` names why a run ended early (`exchange_failed`,
`session_list_unavailable`, `no_safe_session_id`, `team_isolation_failed`, `request_limit`).

**How the probe chooses what to read (deterministic, no guessing):**
- *The unfiltered list of this run.* The run first reads `team_session/?team=980&limit=<n>` and
  keeps its `X-Total-Count` as **the unfiltered count of this run**. No number from an earlier
  run is used (the 308 of 2026-09-29 is history, not a reference value).
  `<n>` is 100, one page; the run does not follow further pages, and "the list read" below
  means that one page.
- *The session.* The list holds drills as rows of their own, so "the first row" could be a drill.
  `<id>` is the first row, in the order the source returned it, that is a parent for certain: a
  row whose own `drills` list is not empty. If no row of the list read has a drill, `<id>` is
  the first row that no other listed row names in its `drills` (the rule the adapter's
  `listSessions` applies), and the report says that the choice could not be confirmed as a
  parent. If the rows carry no `drills` list at all, that is reported and `<id>` is the first
  row.
- *The day.* `<day>` is the date part of the `start_timestamp` of the session's **own confirmed
  read** (`session_read`, team 980), never of the list row. If the list and the detail disagree
  about the day, the source changed under the run: the date window is `not_observed`
  (`source_changed_between_list_and_detail`) and no window request is sent. Thresholds use that
  confirmed day only.
- *The drill.* `<drill id>` is the first id in the chosen session's own `drills` list. If no row
  of the list read has a drill, the drill capability is reported **`not_observed`**: no request
  is sent for it and no index or id is invented.
- *A day the filter can be judged on.* The window is judged on a `<day>` for which the same
  run's unfiltered list holds at least one row **outside** that day. If every row of the list
  read is of one day, the date window is reported `not_observed`.

| Capability | Request to try (for team 980) | What the answer must show |
|---|---|---|
| `session_list_by_date` | `team_session/?team=980&start_timestamp_gte=<day> 00:00:00&start_timestamp_lte=<day> 23:59:59&limit=<n>` | 200. **Proven only when all of these hold:** every returned row's `team` is 980; every returned row's `start_timestamp` lies inside the asked window; and the filtered `X-Total-Count` is **smaller** than the unfiltered count of this same run (so at least one row was really left out). Rows that satisfy the window prove nothing alone: an ignored filter returns the same first rows. Equal counts, or a row outside the window, mean the filter is not applied: reported as not proven, never as **same** |
| `session_read` | `team_session/<id>/` | **same** only when 200, object, `team` is 980, and `drills_count` and a `start_timestamp` are present (what the importer reads from it); nothing after this read runs unless `team` is 980 |
| `session_details` | `team_session/<id>/details/` | status; body shape; field names |
| `session_drill_details` | **Precondition (full mode), checked first:** the chosen session `<id>` is a confirmed parent — its own read (`session_read`, above) answered 200 with `team` 980, `drills_count > 0` and a non-empty `drills` list (the drill-only run confirms the parent from the list row's `drills` plus the own read's `id`, `team` 980 and `drills_count > 0`, see above). Only then, three read-only requests on that session: **(1) the importer's exact form, by position:** `team_session/<id>/details/?drill=0` — the `0` is the position of the first drill in the confirmed `drills` list, not an invented value; **(2) the same drill by its real id:** `team_session/<drill id>/details/`, where `<drill id>` is the first id of that `drills` list; **(3) the parent's whole-session values** `team_session/<id>/details/` (the `session_details` request of this run; not sent twice). Approved by the owner on 2026-09-30 | **Classification, one rule set (owner, 2026-10-01).** Two booleans are computed in the run and printed as booleans only, never with the values they were computed from: `parameterApplied` = the drill answer (1) differs from the whole-session answer (3) in at least one value (an identical answer means the `drill` parameter was ignored); `equivalent` = answers (1) and (2) have the same top-level field names, the same row count and, field by field, the same values. **same** = (1) is 200, `parameterApplied` is true, and, if (2) is also 200, `equivalent` is true. **mapped** = (1) is not 200, (2) is 200, and the id answer (2) differs from the whole-session answer (3) in at least one value. **`not_observed`** = everything else: (1) 200 with the parameter ignored; (1) and (2) both 200 but not equivalent; (2) 200 but identical to (3); neither 200; or no listed session is a confirmed parent. Never **missing** |

| `athlete_session_list` | `athlete_session/?teamsession=<id>&limit=<n>` | status; `X-Total-Count`; field names; whether every row's `teamsession` is `<id>` (a row naming another session stops the run; rows naming no session in a readable way are not used and the chain stops there) |
| `athlete_session_read` | `athlete_session/<athlete session id>/` | status; field names; whether the detail names the same canonical session (`rowOfSession`). A detail naming **another** session stops the run; a missing or unreadable session, or a non-200, ends this chain: no `/more/` and no track are read |
| `athlete_session_more` | `athlete_session/<athlete session id>/more/` — only after a 200 detail that names the same session | status; field names |
| `track_read` | `track/<track id>/` — `<track id>` taken **only from the confirmed detail's** `track` field, never from the list row | status; field names (a `timezone` field) |
| `team_thresholds` | `team/980/thresholds/?valid_on=<day>` — `<day>` is the confirmed detail's day only; no request without it | status; body shape; field names |
| `session_tags` | `team_session_tag/?team=980&limit=5` | status; field names; whether a tag names a team (whether the endpoint honours `team` is part of what is observed; a tag of another team stops the run) |

Note for the date window: its values carry a space and colons (`<day> 00:00:00`), which
`sourceApiUrl()` and the adapter's query builder refuse today on purpose. The probe sends the
value percent-encoded in full, `<day>%2000%3A00%3A00` (the `e03` client encodes only the space,
`<day>%2000:00:00`; both decode to the same value). The form the probe proves is the one the
adapter later reproduces, with its own test; the general rules are not loosened.

After each probe a row becomes **same**, **mapped**, **missing** or stays `not_observed`
(still **unknown**) — the first run moved rows 1b–7 and 9 to **same** and left row 8
`not_observed` (section 2); the adapter implements the proven ones, and only then can the importer's mapper be compared value by value on one
session (on a disposable database, as the pilot did for `e03`).

## 5. Rules the adapter keeps, whatever is added later

- Selected by `(source_system, apiFamily)`; a family without an adapter is
  `adapter_not_available`. No adapter is made from another by rewriting paths.
- Every URL comes from `sourceApiUrl()` with the key's own approved catalog row.
- The bound source team id is fixed when the adapter is created. No operation accepts a team; an
  option that names one in any spelling is refused; a query never carries `team` twice.
- An answer, a row or a next-page link that names another team is refused
  (`source_team_mismatch`), and a team in an unknown shape is refused
  (`source_answer_unexpected`). Nothing of a refused answer is returned.
- Resources without a team parameter (athlete rows, tracks) are reachable only from a session
  that was first read and found to belong to the bound team; this rule binds the reads that are
  still unavailable.
- GET only; one closure talks to the network; no generic request helper exists.
- Stable codes, OptiMove's own sentences, never the source's text; the credential only in the
  `Authorization` header. `401` is `source_auth_rejected`, `403` is `source_access_refused` (on
  the bound team's own read both `403` and `404` are `source_team_not_visible`; what `rest_v1`
  really answers for a team the account cannot see is part of the next probe).
- Attempts (1–5), timeout and retry delay are bounded; `429` is never repeated. An answer is at
  most 5 MiB (5 242 880 bytes) **as received**: the body is read from its stream chunk by chunk,
  the bytes are counted (after decompression, so a small compressed answer that unpacks large is
  stopped too), and the stream is cancelled when the count passes the limit; `Content-Length` is
  only an early guard; part of an answer is never returned or parsed. What can be in memory at
  most is the limit plus the one chunk that passed it. The caller's own deadline must still cover
  attempts × timeout per read.
- The team count is account metadata: a future route shows it to platform administrators only.

## 6. The adapter's codes, and how the F3c2 routes will use them

The contract (`docs/ai/source-connections-f3c2-contract.md` section 2.3, condition 6) lists the
codes a route answers. The read adapter is one level below; its interface is `verifyBoundTeam`,
`countVisibleTeams` and `listSessions` (the contract's `testConnection` and `listTeams` are built
from the first two). Its codes and what a route makes of them:

| Adapter code | Meaning | Route code (contract 2.3) |
|---|---|---|
| `host_not_allowed` | no approved catalog row, or a key the code does not know | `host_not_allowed` |
| `adapter_not_available` | the host's API family has no read adapter | `source_capability_unavailable` |
| `source_capability_unavailable` | the read is not verified on this family | `source_capability_unavailable` (new in the route list) |
| `source_auth_rejected` | 401: the credential was refused | `source_auth_rejected` |
| `source_access_refused` | 403: the credential may not read that | `source_auth_rejected`, except on the bound team |
| `source_team_not_visible` | the bound team cannot be read (403 or 404 on its own read) | `source_team_not_visible` |
| `source_team_mismatch` | an answer names another team | `source_answer_unexpected` |
| `source_not_found` | 404 elsewhere | `source_answer_unexpected` |
| `source_unavailable` | network, timeout, 5xx, 429 | `source_unavailable` |
| `source_answer_unexpected`, `source_list_changed`, `source_list_incomplete` | an answer of another shape, or a list that is not whole | `source_answer_unexpected` |
| `team_param_not_allowed`, `duplicate_param`, `path_not_allowed`, `invalid_options`, `invalid_bound_team`, `credential_missing` | a caller's mistake inside OptiMove, never a user's input | `internal_error` (logged with the code, never with a value) |

The routes create one adapter per request, from the catalog row read in that request, so a key
retired between two requests fails the second one (contract condition 7).
