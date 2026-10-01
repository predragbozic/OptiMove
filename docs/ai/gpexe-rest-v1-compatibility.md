# GPEXE `server3` / `rest_v1` against the importer's `e03` / `api`: compatibility

Status: F3c2a (owner order 2026-09-29). Read-only adapter profile only
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

Words used: **same** — same resource name and parameters, only the family prefix differs, and the
answer was seen; **mapped** — a different path or parameter gives the same information, and the
answer was seen; **missing** — a probe showed the family does not have it; **unknown** — not
verified. *Legacy-attested* means the owner's working integration uses that path or parameter,
but OptiMove has never seen its answer: it is still **unknown** for the adapter.

## 2. The table

| # | Importer operation (what `e03` / `api` does) | `e03` / `api` request | `server3` / `rest_v1` | Evidence | Adapter |
|---|---|---|---|---|---|
| — | Team list (not used by the importer; used to check visibility) | not used | **same**: `team/` | probe: 200, array, `X-Total-Count` 8, contains 980 | `countVisibleTeams()` — count and a boolean only |
| — | Team read (not used by the importer; used to check the binding) | not used | **same**: `team/<id>/` | probe: 200, object | `verifyBoundTeam()` |
| 1a | Sessions of a team, by team and page size (**not an importer request**: the importer always sends the date window, row 1b) | not sent without a date window | the resource and its paging are proven: `team_session/?team=&limit=` | probe: 200, array of 1, `X-Total-Count` 308, `Link` header; field names include every field the importer's list reads (`id`, `team`, `category_name`, `start_timestamp`, `updated_on`, `drills`, `drills_count`, `is_stats_valid`) | `listSessions({ limit, maxPages })` — the whole list or a refusal; drills left out as the importer does |
| 1b | Sessions of a team **in a date window** | `…&start_timestamp_gte=&start_timestamp_lte=` | **unknown** (legacy-attested parameter names) | the legacy integration uses `start_timestamp_gte` / `start_timestamp_lte`; the value format and whether the filter is applied were not seen | `source_capability_unavailable` (`session_list_by_date`) |
| 2 | One session (its team, `drills_count`, start) | `team_session/<id>/` | **unknown** (legacy-attested path) | path used by the legacy integration; answer not seen | unavailable (`session_read`) |
| 3 | Athlete rows of a session | `athlete_session/?teamsession=<id>&limit=` | **unknown** | none | unavailable (`athlete_session_list`) |
| 4 | One athlete row | `athlete_session/<id>/` | **unknown** | none | unavailable (`athlete_session_read`) |
| 5 | Burst and brake events of an athlete row | `athlete_session/<id>/more/` | **unknown** | none | unavailable (`athlete_session_more`) |
| 6 | Track (time zone, device restarts) | `track/<id>/` | **unknown** | none | unavailable (`track_read`) |
| 7 | Whole-session values per athlete | `team_session/<id>/details/` | **unknown** (legacy-attested path, also with `header=true`) | path used by the legacy integration; answer not seen | unavailable (`session_details`) |
| 8 | Values per drill | `team_session/<id>/details/?drill=<n>` | **unknown** | none (the legacy integration does not use `drill=`) | unavailable (`session_drill_details`) |
| 9 | Threshold set valid on the session day | `team/<team>/thresholds/?valid_on=` | **unknown** | none | unavailable (`team_thresholds`) |
| — | Units | no endpoint (numbers are SI on `e03`, verified in the pilot) | **unknown** | none; that `rest_v1` numbers are SI is not verified | unavailable (`units`) |
| — | Session tags | not used by the importer | **unknown** (legacy-attested path `team_session_tag/?limit=`) | path used by the legacy integration; answer and team scope not seen | unavailable (`session_tags`) |

Nothing is **mapped** and nothing is **missing** yet: both words need an answer that was seen.

## 3. What is proven compatible today

**None of the importer's nine request kinds is proven on `rest_v1`.** What is proven is three
reads, two of which the importer does not send at all and one of which is the importer's list
without its date window:
- the credential reads the bound team (`verifyBoundTeam`);
- how many teams the account sees (`countVisibleTeams`);
- the team's sessions can be listed by team and page size, the whole list or a refusal, with the
  header paging the `e03` client already understands (`listSessions`). Like the importer, it
  leaves out a session that another session names in its `drills`.

**Not proven, so the importer cannot run on `server3` yet:** everything a session bundle is made
of (rows 2–9) and the date window (row 1b). `fetchSessionBundle()` therefore answers
`source_capability_unavailable`.

Also not proven, and not a matter of paths: that the **values** of `rest_v1` mean what the
importer's mapper assumes for `e03` — naive timestamps in UTC, numbers in SI units, drills as
separate sessions named in their parent's `drills`, `athlete_session.drill` null for the whole
session. Field names look alike; meanings were verified on `e03` only.

## 4. What needs an owner-run read-only probe

One more run of the discovery script in a new read-only mode (to be added on the owner's order),
with the same rules as before: masked or own-terminal input, one exchange, GET only, only
statuses, body shapes, field names and counts returned, nothing of any body. Each line below is
one request; ids are taken from the previous answers of the same run, never typed and never
guessed.

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
- *The day.* `<day>` is the date part of that row's `start_timestamp`.
- *The drill.* `<drill id>` is the first id in the chosen session's own `drills` list. If no row
  of the list read has a drill, the drill capability is reported **`not_observed`**: no request
  is sent for it and no index or id is invented.
- *A day the filter can be judged on.* The window is judged on a `<day>` for which the same
  run's unfiltered list holds at least one row **outside** that day. If every row of the list
  read is of one day, the date window is reported `not_observed`.

| Capability | Request to try (for team 980) | What the answer must show |
|---|---|---|
| `session_list_by_date` | `team_session/?team=980&start_timestamp_gte=<day> 00:00:00&start_timestamp_lte=<day> 23:59:59&limit=<n>` | 200. **Proven only when all of these hold:** every returned row's `team` is 980; every returned row's `start_timestamp` lies inside the asked window; and the filtered `X-Total-Count` is **smaller** than the unfiltered count of this same run (so at least one row was really left out). Rows that satisfy the window prove nothing alone: an ignored filter returns the same first rows. Equal counts, or a row outside the window, mean the filter is not applied: reported as not proven, never as **same** |
| `session_read` | `team_session/<id>/` | 200; object; `team`, `drills_count`, `start_timestamp` present; `team` is 980 |
| `session_details` | `team_session/<id>/details/` | status; body shape; field names |
| `session_drill_details` | **Precondition, checked first:** the chosen session `<id>` is a confirmed parent — its own read (`session_read`, above) answered 200 with `team` 980, `drills_count > 0` and a non-empty `drills` list. Only then, three read-only requests on that session: **(1) the importer's exact form, by position:** `team_session/<id>/details/?drill=0` — the `0` is the position of the first drill in the confirmed `drills` list, not an invented value; **(2) the same drill by its real id:** `team_session/<drill id>/details/`, where `<drill id>` is the first id of that `drills` list; **(3) the parent's whole-session values** `team_session/<id>/details/` (the `session_details` request of this run; not sent twice). Approved by the owner on 2026-09-30 | **Classification:** (1) 200 → **same**; (1) not 200 and (2) 200 → **mapped**; neither 200 → **`not_observed`**, never **missing**. When both are 200 the report adds two booleans and no value: `equivalent` — the two answers have the same top-level field names, the same row count and, field by field, the same values (compared in the run, never printed); `parameterApplied` — the drill answer (1) differs from the whole-session answer (3) in at least one value (an identical answer means the `drill` parameter was ignored, which is reported as not applied and the row stays `not_observed`). `not_observed` also when no listed session is a confirmed parent |
| `athlete_session_list` | `athlete_session/?teamsession=<id>&limit=5` | status; `X-Total-Count`; field names; whether every row's `teamsession` is `<id>` |
| `athlete_session_read` | `athlete_session/<athlete session id>/` | status; field names |
| `athlete_session_more` | `athlete_session/<athlete session id>/more/` | status; field names |
| `track_read` | `track/<track id>/` | status; field names (a `timezone` field) |
| `team_thresholds` | `team/980/thresholds/?valid_on=<day>` | status; body shape; field names |
| `session_tags` | `team_session_tag/?limit=5` | status; field names; whether a tag names a team |

Note for the date window: its values carry a space and colons (`<day> 00:00:00`), which
`sourceApiUrl()` and the adapter's query builder refuse today on purpose. When the capability is
proven it gets its own tested encoding of exactly that value shape; the general rules are not
loosened.

After that probe each row becomes **same**, **mapped**, **missing** or stays `not_observed`
(still **unknown**); the adapter implements the proven ones, and only then can the importer's mapper be compared value by value on one
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
