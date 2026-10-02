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
5. **The owner-run drill-only probe of 2026-10-01** (`--mode drill` as first built, section 4):
   stopped after three reads on `drill_id_mismatch`; the same sanitization and the same rule
   for what is recorded.
6. **Structural evidence from the owner's legacy integration on `server3`** (the owner's review
   of its code, 2026-10-01, reported as paths and field use only; the file itself holds
   credentials and was not opened for this work): the session list is read as
   `api/team_session/`; the whole session and `drills_count` as
   `rest/v1/team_session/<parent id>/details/`; a drill's results as
   `api/team_session/<parent id>/details/?drill=<zero-based index>`; `drills` is not used as a
   list of `team_session` ids. This is legacy-attested: OptiMove has not seen these answers.
7. **The owner-run drill-only probe of 2026-10-01, second form** (head `9c702ff`, section 4):
   `stoppedBy: null`, 5 requests; the same sanitization and the same rule for what is recorded.

Words used: **same** — same resource name and parameters, only the family prefix differs, and the
answer was seen; **mapped** — a different path or parameter gives the same information, and the
answer was seen; **missing** — a probe showed the family does not have it; **unknown** — not
verified. The probe's report adds two words of its own: **proven** for the list it starts from
(the one read verified before), and **observed** for a read that answered 200 but cannot be
called "same": it has no importer counterpart (the tags, the drill-only run's legacy parent read),
or its form is outside the `rest_v1` family and no reference shows what it selects (the second
drill-only run's single legacy drill read). In the third drill-only run, **same** for
`session_drill_details` means only this: in the `api` family, for a stable, confirmed parent,
positions 0 and 1 produced different `players` while the repeated position 0 produced the same
`players` as the first; it does not make row 8 same on `rest_v1`, it names no drill, and it does
not show that position 0 is semantically the first drill — the zero-based meaning rests on the
legacy integration's use. *Legacy-attested* means the owner's working integration uses that path or parameter,
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
| 8 | Values per drill | `team_session/<id>/details/?drill=<n>` | **observed** in the `api` family (never yet **same**); still **unknown** on `rest_v1` | full probe 2026-10-01: no request sent. First drill-only run: a `drills` entry read as `team_session/<entry>/` answered an id other than the entry, so a `drills` entry is not read as a `team_session` id again. Structural evidence (section 1, item 6): the legacy integration reads `api/team_session/<parent id>/details/?drill=<zero-based index>`. Second drill-only run (2026-10-01): on a parent confirmed by its REST read and again by `api/team_session/<parent id>/`, `api/team_session/<parent id>/details/?drill=<first position>` answered 200 with an object whose top-level fields are `drills_count`, `players`, `team` and `teamsession`; `players` is a map of objects carrying numbers and nested values. That confirms the endpoint and its shape only: one read cannot show that the position selects one drill. The REST `?drill=` form stays withdrawn | unavailable (`session_drill_details`); the `api` family is not part of the `server3` profile |
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
(row 8) is **observed** in the `api` family only (its endpoint and shape, second drill-only run),
never yet same, and still unknown on `rest_v1`.** The adapter still implements only the three reads verified on
2026-09-29, two of which the importer does not send at all and one of which is the importer's list
without its date window:
- the credential reads the bound team (`verifyBoundTeam`);
- how many teams the account sees (`countVisibleTeams`);
- the team's sessions can be listed by team and page size, the whole list or a refusal, with the
  header paging the `e03` client already understands (`listSessions`). Like the importer, it
  leaves out a session that another session names in its `drills`. **That filter is a known risk
  on `rest_v1`:** the first drill-only run showed that a `drills` entry is not a `team_session` id
  there, or at least that that path answers a different session, so the filter may leave out real
  sessions whose id happens to equal an entry, and may keep drill rows as sessions. A separate
  adapter fix is mandatory before the F3c2 routes or any import (CURRENT_STATE, Separate tasks).

**Not implemented, so the importer cannot run on `server3` yet:** everything a session bundle is
made of (rows 2–9) and the date window (row 1b) are proven but not written into the adapter,
and the drill read (row 8) is not proven at all. `fetchSessionBundle()` therefore still answers
`source_capability_unavailable`.

Also not proven, and not a matter of paths: that the **values** of `rest_v1` mean what the
importer's mapper assumes for `e03` — naive timestamps in UTC, numbers in SI units, drills as
separate sessions named in their parent's `drills`, `athlete_session.drill` null for the whole
session. Field names look alike; meanings were verified on `e03` only. **The drill model is
not the `e03` one:** on `rest_v1` reading an entry of a session's `drills` list as a
`team_session` id answered a session with an id other than the entry (first drill-only run,
2026-10-01; whether that was the parent itself or a third session the report could not tell), and
a session's own read carries `drill`, `drill_enabled` and `drills_count` without a `drills` list;
what a drill is on `rest_v1` is open.

**What OptiMove keeps of a drill (owner product decision, 2026-10-01).** The legacy
integration's way of **reading** drill results — the parent session id plus `?drill=<zero-based
index>` in the `api` family (section 1, item 6) — is the **candidate** to confirm, by the
drill-only run of section 4; it is not proven until an owner-run answer has been seen. Its way of
**naming** drills is not copied: the Sheet links a drill to a tag by taking all tagged sessions
of that day sorted by time, which is not reliable enough for OptiMove — another tagged session
that day, a changed order or a missing tag silently shifts every name. OptiMove keeps a drill as
**parent session + zero-based drill index**; a drill's name or tag is linked only when the API
gives an explicit link that has been tested; until then the drill carries the neutral name
**Drill N**, and a tag is never guessed. This is a decision for the later import work; neither
the adapter nor the importer does any of it today.

**An observation that does not settle the `rest_v1` drill model.** The second drill-only run
reported `listRowMatchesFirstDrill: true`: on one list page, the chosen parent's first `drills`
entry equals the id of another row of the same page. That is one entry of one parent on one page.
The first drill-only run had read `team_session/<entry>/` for a parent's first entry and received
a different id. What such a row is, and why reading an entry that way answered another id, is
still open; no general rule follows from either, and nothing in the adapter or the importer may
rely on either reading yet (see the
mandatory `listSessions()` fix in CURRENT_STATE, Separate tasks).

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
the drill row had at that time (a non-empty `drills` list on the parent's own read; since
withdrawn) could not be met and no drill request was sent. No id, date, value or field list of the report is copied here.

**Result of the first drill-only run (2026-10-01, `--mode drill` as first built, sanitized by
the owner):** `stoppedBy: drill_id_mismatch`, 4 requests (one exchange, three reads). The list
page: 100 rows, a parent for certain chosen (team 980, non-empty `drills`). The parent's own read:
**same**, the same id, team 980, `drills_count > 0`, `start_timestamp` present, no `drills` list.
The read of `team_session/<first drills entry>/`: 200, team 980, but **an id other than the
entry** (the report could not tell whether it was the parent's own id or a third session's), and
no `teamsession` field (the body has the session shape with `drill`,
`drill_enabled` and `drills_count`). The chain stopped there, as built: no details were read. So
an entry of `drills` is **not a `team_session` id on `rest_v1`** — or at least that path answers
a different session —, and the `e03` drill model (a drill is a separate `team_session` named in
its parent's `drills`) is not confirmed for `rest_v1`. Owner decision (2026-10-01): a `drills`
entry is never read as a `team_session` id again without new evidence. No id, date, value or field
list of the report is copied here.

**Result of the second drill-only run (2026-10-01, head `9c702ff`, sanitized by the owner):**
`stoppedBy: null`, 5 requests (one exchange, four reads). The list page gave a parent with a
non-empty `drills` list; its own REST read was **same** (the same id, team 980, `drills_count > 0`,
no `drills` list); `api/team_session/<parent id>/` was **observed** (the same id, team 980,
`drills_count > 0`); the legacy drill read at the first position was **observed**: 200, an object
with content, top-level fields `drills_count`, `players`, `team` and `teamsession`, `players` a map
whose rows are objects with numbers and nested values, no field named like a metric. The list's
helper facts: `drillsEntryKind: number`, `listRowMatchesFirstDrill: true`, no singular `drill`
field on the list rows. **observed confirms the endpoint and its shape only, never same** (owner,
2026-10-01): one read cannot show that the position selects one drill, and the answer's `team` and
`teamsession` were not checked by that form of the run. No id, date, value or key of the answer is
copied here.

**The drill-only run, third form (`--mode drill`, owner order 2026-10-01, built, not yet run):**
the final check of the legacy drill form. The whole-session `api/team_session/<parent id>/details/`
without a parameter is **not** used as a reference: that form is not confirmed in the legacy
integration. One exchange, then at most six reads, each one only after the previous answer
confirmed the identity it depends on, and the chain stops **without the next request** at the
first identity or team that is not confirmed: (1) the unfiltered REST list of team 980 gives a
parent — a row of team 980 with a readable id and an explicit `drills` list of **at least two**
entries; `drills_count` alone never chooses a parent, because it is not proven that a drill row
cannot carry a positive count (no such row: `no_parent_with_drills_in_list`, nothing else is
read, no legacy request); (2) the parent's own REST read must answer 200 with the **same** `id`,
`team` 980 and `drills_count >= 2` (another id: `parent_id_mismatch`; no readable id, a smaller
count, a non-200 or a list-shaped body: `parent_not_confirmed`; another team:
`team_isolation_failed`; a team in an unreadable shape: `team_unknown_shape`); (3) the same parent
through the legacy family, `api/team_session/<parent id>/`, must answer 200 with the **same** `id`
and `team` 980 again (`legacy_parent_id_mismatch`; `legacy_parent_not_confirmed`; the two team
stops); (4) the legacy drill reads the legacy integration really sends, at the zero-based
positions 0 and 1, in the control sequence **0 → 1 → 0** (owner, 2026-10-01: a source that
changes between reads must not pass for a parameter that is applied): each answer, the repeated
position 0 included, must be an object whose top-level `team` is
980 and whose top-level `teamsession` is the parent id, and must carry a non-empty `players`,
before anything else is read — a non-200 (`drill_not_200`), an unreadable body or a JSON primitive
(`drill_answer_unreadable`), an empty array or object (`drill_answer_empty`), a list body, an
absent `team`, or an absent or unreadable `teamsession` (`drill_answer_identity_unconfirmed`), another parent
(`drill_parent_mismatch`), another team (`team_isolation_failed`), a team in an unreadable shape
(`team_unknown_shape`) or no `players` (`drill_players_missing`) ends the run as `not_observed`
with that reason and no further request; the repeated read is held to the same identity, team,
content, answer-size, timeout and sanitization rules as the first; (5) only the three `players`
contents are compared, whole and in memory, independent of key order — no key or value of any is
printed. The comparison is made on the answers after the importer's drop list of personal fields
(`redactGpexe`), so a difference that lies only in a dropped field reads as identical; that fails
safe. **The two position-0 answers differ → `not_observed` with `source_changed_during_probe`
(`repeatStable: false`), whatever position 1 answered; both position-0 answers identical and
position 1 different → `repeatStable: true`, `parameterApplied: true`, and the capability may be
same; all three identical → `not_observed` with the neutral reason
`parameter_effect_not_distinguishable`; never mapped or missing.** No `drills` entry
is ever used as an id, no read by a drill id, no REST `?drill=` read, no legacy details read
without a position. The legacy family is used by this run only, for exactly those read shapes on
the same host (`LEGACY_API_PATH`: the parent read and the drill reads at positions 0 and 1); it is
not added to the `server3` host profile or to the adapter, and `sourceApiUrl()` and the host
allowlist do not cover it; the token the one exchange issued is sent to it on the same host, as
the legacy integration does. What is recorded: per request the masked path, status, body kind and
the top-level field names (and those of the first row under `results`) — printed only when every
one is an identifier, so a body keyed by ids, by dates or by keys with spaces prints none of its
keys; a single-word key is printed —; per drill answer booleans only (`teamIs980`, `namesParent`,
`playersPresent` and the shape booleans of `describeDrillAnswer`: content, rows at the top level,
a `players` field and whether it is a list or a map, player rows, objects, numbers, nested values,
a metric-named field). The report carries `mode: "drill"`, `session_read` (beside the gate
booleans, `drillsCountAtLeastTwo`), `legacy_api_session_read` and `session_drill_details` (with
`readsMade`, `repeatStable`, `parameterApplied`, `drill0`, `drill1`, `drill0Repeat`), which is set
on every exit of this mode — before the list, at the list, at either parent read, at any drill
read, a team stop, the request cap — as `not_observed` with the stop code as its reason unless the comparison was made.
The list verdict carries the helper facts of the page already received, as types and booleans
only (`drillsEntryKind`, `listRowMatchesFirstDrill` — the parent itself never counts —,
`rowsHaveSingularDrillField` / `rowsWithNonNullSingularDrill`). **The full run no longer reads any
drill** (`drill_read_only_in_drill_mode`). The request cap of this mode is 7 (one exchange and
six reads) whatever is asked
(`DRILL_MODE_MAX_REQUESTS`). Its PowerShell commands are handed over only after the owner's
external review of this form.

The report, per capability: a verdict (`proven` for the list this run starts from; `same`,
`mapped`, `observed`, `not_observed`), the status, counts and booleans such as `parentConfirmed`,
`allRowsInsideWindow`, `filteredCountSmallerThanUnfiltered`,
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
- *The drill.* The full run reads no drill any more (owner, 2026-10-01); the drill-only run
  above chooses its own parent and reads the drills at the zero-based positions 0 and 1, never
  with a `drills` entry used as an id. If no row of the list read is a parent, the drill capability is
  reported **`not_observed`**: no request is sent for it and no index or id is invented.
- *A day the filter can be judged on.* The window is judged on a `<day>` for which the same
  run's unfiltered list holds at least one row **outside** that day. If every row of the list
  read is of one day, the date window is reported `not_observed`.

| Capability | Request to try (for team 980) | What the answer must show |
|---|---|---|
| `session_list_by_date` | `team_session/?team=980&start_timestamp_gte=<day> 00:00:00&start_timestamp_lte=<day> 23:59:59&limit=<n>` | 200. **Proven only when all of these hold:** every returned row's `team` is 980; every returned row's `start_timestamp` lies inside the asked window; and the filtered `X-Total-Count` is **smaller** than the unfiltered count of this same run (so at least one row was really left out). Rows that satisfy the window prove nothing alone: an ignored filter returns the same first rows. Equal counts, or a row outside the window, mean the filter is not applied: reported as not proven, never as **same** |
| `session_read` | `team_session/<id>/` | **same** only when 200, object, `team` is 980, and `drills_count` and a `start_timestamp` are present (what the importer reads from it); nothing after this read runs unless `team` is 980 |
| `session_details` | `team_session/<id>/details/` | status; body shape; field names |
| `session_drill_details` | **Drill-only run only. Precondition, checked first:** the parent is a list row of team 980 with an explicit `drills` list of at least two entries, confirmed twice — its own REST read answered 200 with the same `id`, team 980 and `drills_count >= 2`, and its legacy read `api/team_session/<parent id>/` answered 200 with the same `id` and team 980. Only then three read-only requests in the control sequence 0 → 1 → 0, on the forms the owner's legacy integration on `server3` sends: `api/team_session/<parent id>/details/?drill=0`, then `api/team_session/<parent id>/details/?drill=1`, then position 0 again — the drills at the zero-based positions 0 and 1 on that parent. Each read is sent only after the previous answer named team 980 and the parent and carried a non-empty `players`. No `drills` entry is used as an id; no details read without a position. Approved by the owner on 2026-10-01 | each answer, the repeat included: status, body kind, top-level `team` 980 and `teamsession` = the parent id (otherwise `not_observed` or an isolation stop, and no further request), a non-empty `players`, and the shape booleans. Then only the three `players` contents are compared, in memory, never printed: the two position-0 answers differ → `not_observed` with `source_changed_during_probe`; they are identical and position 1 differs → `parameterApplied: true`, the capability may be **same**; all three identical → `not_observed` with `parameter_effect_not_distinguishable`. Never mapped. Never **missing** |

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
