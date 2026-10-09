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
8. **The owner-run drill-only probe of 2026-10-02, third form** (head `3f466ed`, section 4):
   `stoppedBy: team_unknown_shape`, 5 requests; the same sanitization and the same rule.
9. **The owner-run diagnostic probe of 2026-10-02** (head `1166cfa`, section 4): the same stop,
   5 requests, now with the shape of the drill answer's `team` described as a kind word and
   booleans; the same sanitization and the same rule.
10. **The owner-run diagnostic probe of 2026-10-02, second** (head `79b2381`, section 4): the same
    stop, 5 requests, with the drill answer's link to the list described as booleans; the same
    sanitization and the same rule.
11. **Two owner-run attempts of the final structural diagnostics on 2026-10-02** (head
    `7c54a7d`, section 4) that did not reach a drill read: the first — exchange 200, then the
    REST session list timed out after 30 s, 2 requests (`session_list_unavailable`); the second —
    the exchange itself answered 400 with the single field `non_field_errors`, 1 request
    (`exchange_failed`). Operational events only, with no conclusion about the drill model, the
    token or the account; no further attempt (owner, 2026-10-02).
12. **The official GPEXE REST handbook** (`gpexe-v.6-api-rest-handbook.pdf`, supplied by the
    owner; pages 31–33 and the Team Session Brief page; written for GPEXE 6, while the server
    reports 9.11.8): the whole session is `GET /api/team_session/<parent id>/details/`; a drill is
    `GET /api/team_session/<parent id>/details/?drill=<zero-based index>`, `drill` starting at
    `0`, no parameter meaning the whole session; `players` carries the athletes' results;
    `drills_count` gives the number of drills; the top-level `team` of a details answer is the
    team's **aggregated parameters**, not an identity field; `GET /api/team_session/<parent id>/brief/`
    answers with `drillTags`. Documentation, not an observed answer; a confirmation by GPEXE
    support is welcome but not a blocker (owner, 2026-10-03).

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
| 1a | Sessions of a team, by team and page size (**the importer's request since 2026-10-08**, option (c): a date window reads this whole list and filters it locally, see row 1b) | not sent without a date window | the resource and its paging are proven: `team_session/?team=&limit=` | probe: 200, array of 1, `X-Total-Count` 308, `Link` header; field names include every field the importer's list reads (`id`, `team`, `category_name`, `start_timestamp`, `updated_on`, `drills`, `drills_count`, `is_stats_valid`) | `listSessions({ limit, maxPages })` — the whole list or a refusal; parents and drills told apart by the list structure, an ambiguous page refused (F3c2c) |
| 1b | Sessions of a team **in a date window** | `…&start_timestamp_gte=&start_timestamp_lte=` | **same** | probe 2026-10-01: the filter is applied under the section-4 rule (every row of team 980 and inside the window, the chosen session among them, the filtered count smaller than the unfiltered count of the same run) | **not used since 2026-10-08 (option (c))**: an owner-run check of 05.10 - 06.10.2026 got rows after the asked window from this filter (`source_filter_ignored`, diagnostic `after_end=5`); `listSessionsByDay({ fromDay, toDay })` now reads the whole team list twice (row 1a, `limit=100`, stable `X-Total-Count`, next links with `limit=100` and the exact `offset` only, at most 2000 rows or `source_list_too_large`; the two complete reads must agree on total, id order and the classification / candidate fields or `source_list_changed`, owner decision 2026-10-09), classifies parents and drills on it, refuses an unreadable start (`source_session_start_unreadable`) and picks the window out locally; the capability is declared `unknown` |
| 2 | One session (its team, `drills_count`, start) | `team_session/<id>/` | **same** | probe 2026-10-01: 200, object, team 980, `drills_count` and `start_timestamp` present; **no `drills` list** on this read (the list rows carry it) | **implemented (F3c2c)**: `getSession({ sessionId })` — the read that confirms a parent (same id, team 980, `drills_count` 0–30) |
| 3 | Athlete rows of a session | `athlete_session/?teamsession=<id>&limit=` | **same** | probe 2026-10-01: 200, every row of the asked session | **implemented (F3c2c)**: `listAthleteSessions({ sessionId })` on a confirmed parent, whole or refused, every row of that session |
| 4 | One athlete row | `athlete_session/<id>/` | **same** | probe 2026-10-01: 200, names the same session | **implemented (F3c2c)**: `getAthleteSession({ sessionId, athleteSessionId })` under a confirmed parent; the detail must name that session |
| 5 | Burst and brake events of an athlete row | `athlete_session/<id>/more/` | **same** | probe 2026-10-01: 200 | **implemented (F3c2c)**: `getAthleteSessionMore({ athleteSessionId })` for a row read under a confirmed parent |
| 6 | Track (time zone, device restarts) | `track/<id>/` | **same** | probe 2026-10-01: 200, id from the confirmed athlete detail | **implemented (F3c2c)**: `getTrack({ trackId })` for a track a confirmed row named |
| 7 | Whole-session values per athlete | `team_session/<id>/details/` | **same** (status only — the probe's verdict was HTTP 200; no metric value shape is recorded) | probe 2026-10-01: 200; first real check 2026-10-05: refused as `source_answer_unexpected` / `metric_shape_unknown` | **implemented (F3c2c)**: `getSessionDetails({ sessionId })` on a confirmed parent; only `players` (canonical athlete ids → metric values) and `drills_count` leave the adapter. The two consumed fields are proven in the documented shape by the owner-run diagnostic of 2026-10-06; the read is **projected** to them (`projectSessionDetails`, see below) — no other metric is read or kept |
| 8 | Values per drill (since 2026-10-09 projected to `tot_burst_events` / `tot_brake_events`, like row 3: the first whole-list check met one unconsumed object metric in drill 0 while both consumed fields were in the documented shape) | `team_session/<id>/details/?drill=<n>` | **observed** in the `api` family (never yet **same**); still **unknown** on `rest_v1` | full probe 2026-10-01: no request sent. First drill-only run: a `drills` entry read as `team_session/<entry>/` answered an id other than the entry, so a `drills` entry is not read as a `team_session` id again. Structural evidence (section 1, item 6): the legacy integration reads `api/team_session/<parent id>/details/?drill=<zero-based index>`. Second drill-only run (2026-10-01): on a parent confirmed by its REST read and again by `api/team_session/<parent id>/`, `api/team_session/<parent id>/details/?drill=<first position>` answered 200 with an object whose top-level fields are `drills_count`, `players`, `team` and `teamsession`; `players` is a map of objects carrying numbers and nested values. That confirms the endpoint and its shape only: one read cannot show that the position selects one drill. The REST `?drill=` form stays withdrawn. Third drill-only run (2026-10-02, control sequence 0 → 1 → 0): the first `?drill=0` answered 200 with the same top-level fields, but its `team` was not a canonical id as a number or a string, so the run stopped as `team_unknown_shape` before `?drill=1`; no conclusion about the parameter. Diagnostic run (2026-10-02): that `team` is an **object without an `id`** (kept opaque), and the answer's `teamsession` is a canonical id that is **not the parent's**. Second diagnostic run (2026-10-02): the answer's `teamsession` is **not the parent's first `drills` entry** either, while that entry is exactly one row of the list page and that row names team 980; so the answer names a third session, which the final form of the probe would resolve against every entry of the parent's `drills`; that form was attempted twice on 2026-10-02 and did not reach a drill read (a list timeout, then a refused exchange; operational events, no conclusion). **F3c2b closed (owner, 2026-10-02): the drill endpoint is in practice **observed**, no further probe, sign-in attempt or rule change.** Final decision (owner, 2026-10-03, on the official handbook, section 1 item 12): the drill read is `api/team_session/<confirmed parent id>/details/?drill=<index>` with a zero-based index from `0` to `drills_count - 1`; drills stay in the future adapter and in the first planned import; `team` in a details answer is an aggregate, not a team id; `drills` entries and the answer's `teamsession` are used neither to build a URL nor as an identity guard; names come from an unambiguous `drillTags` mapping of the parent, fallback `Drill N` | **implemented (F3c2c) through one narrow builder**, `legacyDrillDetailsUrl()`: `getSessionDrillDetails({ sessionId, drillIndex })` and `getSessionDrills({ sessionId })` on a confirmed parent, index 0 to `drills_count - 1`; the answer accepted only as a players map of canonical athlete ids with metric values; the `api` family is still not part of the `server3` profile and `sourceApiUrl()` does not build this URL |
| 9 | Threshold set valid on the session day | `team/<team>/thresholds/?valid_on=` | **same** | probe 2026-10-01: 200 on the confirmed session's day | **implemented (F3c2c)**: `getTeamThresholds({ sessionId })` on the confirmed session's day; null on 404 |
| — | Units | no endpoint (numbers are SI on `e03`, verified in the pilot) | **unknown** | none; that `rest_v1` numbers are SI is not verified (the probe records no value) | unavailable (`units`) |
| — | Session tags | not used by the importer | **observed** (legacy-attested path `team_session_tag/?team=&limit=`) | probe 2026-10-01: 200, asked for team 980; no returned tag named another team (one would have stopped the run); whether `team` is honoured is not shown | **implemented (F3c2c)**: `listSessionTags()` — the bound team's tags as id → name, read for drill names only (`getDrillLabels`) |

Nothing is **mapped** and nothing is **missing**: both words need an answer that was seen and
differs from the importer's form, and no read was refused. **The adapter column moved in F3c2c** (rows 1b–9 and the tag list implemented, `units` unavailable); before it:
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

**How F3c2b closed (owner, 2026-10-02, aligned on 2026-10-03).** The eight confirmed `rest_v1`
reads (rows 1b–7 and 9) stay confirmed and available to the future adapter. The drill endpoint
(row 8) is in practice **observed** in the `api` family: it exists and its shape is known; the
probe never completed a control sequence, so nothing of it is **same** in the probe's sense. How
it is used is settled by the official handbook, not by a further probe: the confirmed parent
session plus a zero-based index from `0` to `drills_count - 1`. **Drills are not dropped from
the future adapter or from the first planned import.** `team` in a details answer is an
aggregate, not a team id; `drills` entries and the answer's `teamsession` are used neither to
build a URL nor as an identity guard; names come from an unambiguous `drillTags` mapping with
the fallback `Drill N`, never from the tagged sessions of a day. There are **no more owner-run
diagnostic probes** before that implementation, no further sign-in attempts and no change to any
probe rule; the owner's Google Sheet integration is neither checked nor changed by OptiMove. The
two last operational events (section 1, item 11; section 4) stay recorded without any
conclusion about drills, the token or the account. The implementation is a separate small
adapter PR after PR #132 is merged, on the owner's order: first the mandatory `listSessions()`
drills-filter fix, then the eight confirmed reads, then one narrow builder for exactly the drill
path on the approved `server3` host (no generic `api/` family), then names through `drillTags`.

**F3c2c, as built (branch `feature/gpexe-server3-adapter-f3c2c`, owner order 2026-10-03; not
merged, not run against the real server).** `backend/src/gpexeRestV1Adapter.js` now implements:
- **the `listSessions()` classification** (B1): a drill is a row named in exactly one other
  row's `drills` that carries no drills of its own; a named row with drills or a positive
  `drills_count`, an entry named by two rows, a row naming itself, or a `drills` list that
  disagrees with `drills_count` makes the page ambiguous — `source_list_ambiguous` with a
  reason, never a thinned list; an entry that names no listed row misclassifies nothing and is
  only counted (`drillReferencesNotListed`); `drills` entries are page-local references, never
  resource ids and never in a URL;
- **the eight proven reads** (B2) through the `server3` / `rest_v1` profile: the date window
  (`listSessionsByDay`, two days, forward, at most 31 days, read from exactly one day earlier so a
  drill's parent of the evening before is seen and the drill row is never listed as a session — the
  `e03` importer's look-back, never widened to two days —, the proved `%20` / `%3A` encoding —
  the one widening of the host path rule, which now admits exactly those two percent sequences
  in a query value and nothing else), the session read (`getSession`, which **confirms** a
  parent: same id, team 980, `drills_count` 0–30), the whole-session details, the athlete rows,
  one athlete row, its `/more/`, its track and the thresholds. Everything but the lists hangs off
  a session this adapter instance has confirmed (`session_not_confirmed`,
  `athlete_row_not_confirmed`, `track_not_confirmed` otherwise); a row of another session, a
  detail of another row or session, events of another row or a track of another id refuse;
- **the narrow drill read** (B3–B4): `legacyDrillDetailsUrl()` builds exactly
  `https://server3.gpexe.com/api/team_session/<confirmed parent id>/details/?drill=<index>` for
  the approved `server3` row and nothing else — a canonical parent id, an integer index from 0 to
  `drills_count - 1`, no other host, family, path, query or fallback; `legacyBriefUrl()` builds
  only `…/brief/`. A drill answer is accepted only as a 200 JSON object whose `players` is a
  map keyed by canonical athlete ids (an empty map is valid — a drill not yet computed, as the
  `e03` pilot fixtures carry; a missing, null, array or other shape fails), each value a plain object of metric values
  (finite numbers, null, short unit strings, or one nested object of such); its top-level `team`
  (aggregated parameters) and `teamsession` are neither read as identity nor returned. One drill
  that cannot be read ends the set there: `getSessionDrills` returns `complete: false` with the
  failed position and its stable code, the drills read so far, and never tries another index,
  host or form; a refused credential or a foreign team ends the whole operation;
- **drill names** (B5): `getDrillLabels` reads `…/brief/`, parses `drillTags` in one of two
  explicit candidate shapes (a positional array of exactly `drills_count` tag ids or nulls; or
  objects `{ drill, tag }` each drill at most once — neither shape has been observed on a
  server yet), translates a tag id through the bound team's tag catalogue (`listSessionTags`,
  every row naming the bound team), and otherwise answers `Drill <index + 1>`; each label
  carries `drillIndex`, `label`, `tagId`, `tagName` and `labelEvidence` (`drill_tags` or
  `index_fallback`). A duplicate tag, a count that disagrees, an unknown `drillTags` shape, a
  foreign or unnamed tag, or a brief that is missing or unreachable fall back; a brief of another
  session, a brief that is not an object or a non-canonical tag id is an error (see the round-2
  note below); the day's other sessions are never read;
- `fetchSessionBundle({ sessionId })` composes them in the e03 bundle shape plus `drillsStatus`
  and `drillLabels`. No route, database table, migration, credential storage, binding or import
  uses it yet; the import policy for an incomplete drill set is decided in the later integration
  PR.
**After the owner's external review of PR #133 (2026-10-03), also built:** (1) **the parent
classification is the precondition of every session read** — `getSession` and `fetchSessionBundle`
accept only an id that a session list of this instance (`listSessions` or `listSessionsByDay`)
classified as a parent (`session_not_listed` otherwise, no request); a row a later list names as a
drill loses that standing and every confirmation under it; (2) **explicit projections** — every read
returns exactly the fields the importer's mapper and the candidate service read (`BUNDLE_FIELDS`:
session, athlete row, `more` with its six event fields and the `power` / `speed` zones' `extremes` /
`distance` / `is_ready`, track, threshold set) and nothing the source adds in any spelling or nesting;
the `e03` drop list still runs first but is no longer what protects the output; (3) **revocation under
refresh** — re-reading a session withdraws its confirmation, its listed rows and every row and track
confirmed under it; re-reading its athlete list withdraws the rows and tracks; each session carries an
epoch, and a list, row or session answer that started before a later refresh is discarded unrecorded
(`session_refreshed`), so a concurrent stale answer can never re-confirm; (4) **drill labels** fall
back to `Drill N` only when the brief is missing (404) or unreachable (`source_unavailable`); a brief
of another session, a brief that is not an object, a non-canonical tag id, a refused credential, a
foreign team or a programming error is an error, never a label; (5) a tag id that is there but not
canonical refuses the drill tags and the tag list (`tag_id_not_canonical`). After the narrow
re-reviews of that round, also (6): a projected value must be a scalar (null, boolean, finite number,
one-line string of at most 64 characters) or, for the two threshold lists and a zone's `extremes`, a
list of finite numbers or nulls — anything else refuses the answer (`field_shape_unknown`), so no
nested object can leave under a projected key; the session projection carries only the eight fields
a consumer reads; only the most recently started session list may record its classification —
an older list is discarded whether it answers before or after the newer one, fail-closed, before any
change to the classification or the confirmations (`session_list_refreshed`); a dependent read (details, drill, `/more/`, track, brief) that lands
after its session was refreshed is discarded (`session_refreshed`); and a row this instance once
classified as a drill cannot come back as a parent through a later list that lacks its parent — that
list is refused (`source_list_ambiguous`, `classification_conflict`). Also recorded: a
drill row inside the window whose parent started the day before is told apart through the one-day
look-back of `listSessionsByDay` (`lookBackDays: 1`). Since 2026-10-08 (option (c)) the whole team
list is classified, so a drill row is told apart whatever day its parent started; a parent of the
look-back day or of any other day is left out of the window.

**Open compatibility note:** the handbook is for GPEXE 6 while the server reports 9.11.8; a
confirmation by GPEXE support is welcome, not a blocker. Nothing in F3c2c was run against the
real server; every network test uses a fake fetch.

Also not proven, and not a matter of paths: that the **values** of `rest_v1` mean what the
importer's mapper assumes for `e03` — naive timestamps in UTC, numbers in SI units, drills as
separate sessions named in their parent's `drills`, `athlete_session.drill` null for the whole
session. Field names look alike; meanings were verified on `e03` only. **The drill model is
not the `e03` one:** on `rest_v1` reading an entry of a session's `drills` list as a
`team_session` id answered a session with an id other than the entry (first drill-only run,
2026-10-01; whether that was the parent itself or a third session the report could not tell), and
a session's own read carries `drill`, `drill_enabled` and `drills_count` without a `drills` list;
what a drill is on `rest_v1` is open.

**What OptiMove keeps of a drill (owner product decision, 2026-10-01, made final on 2026-10-03
on the official handbook — section 1, item 12).** A drill is identified as the **confirmed parent
session plus a zero-based index** from `0` to `drills_count - 1`, and read as
`api/team_session/<confirmed parent id>/details/?drill=<index>` — the form the handbook
documents and the legacy integration uses. The entries of a session's `drills` list are **not**
ids needed to build that URL; the `teamsession` and the top-level `team` of a drill answer are
**not** an identity guard of the parent (the handbook documents `team` as the team's aggregated
parameters). Safety rests on the parent confirmed first, a fixed URL builder and the bounded
index. **Drills stay in the future adapter and in the first planned production import.** A
drill's **name** comes first from an unambiguous `drillTags` mapping of the parent session
(`api/team_session/<confirmed parent id>/brief/`, translated through the team's tag catalogue,
only a tag confirmed for the bound team); when the mapping is missing, unreadable, duplicated,
not matching `drills_count` or not explicit, the fallback is **Drill 1, Drill 2, …** (`Drill
<index + 1>`). The Sheet's naming rule — all tagged sessions of the same day, sorted by time,
linked to drill indexes — is **never** copied: another tagged session that day, a changed order
or a missing tag silently shifts every name. Neither the adapter nor the importer does any of
this today; it is the content of the separate adapter PR.

**An observation that does not settle the `rest_v1` drill model.** The second drill-only run
reported `listRowMatchesFirstDrill: true`: on one list page, the chosen parent's first `drills`
entry equals the id of another row of the same page. That is one entry of one parent on one page.
The first drill-only run had read `team_session/<entry>/` for a parent's first entry and received
a different id. What such a row is, and why reading an entry that way answered another id, is
still open; no general rule follows from either, and nothing in the adapter or the importer may
rely on either reading yet (see the
mandatory `listSessions()` fix in CURRENT_STATE, Separate tasks).

**The first real check on server3 (owner, 2026-10-05) was refused at row 7.** Code
`source_answer_unexpected`, message "The source answer to the whole-session details carries a metric
value in an unknown shape." What is known, and only that:
- The importer reads two fields of a details answer per athlete, `tot_burst_events` and
  `tot_brake_events`, each `{ unit: "number", value: <finite number> }` (the mapper's
  `detailsNumber`; the real e03 shape kept in the test fixtures).
- (Historical, as of 2026-10-05; the validator was removed on 2026-10-09.) `validatePlayersAnswer()`
  checked every metric of every athlete. A metric must be a finite number,
  null, a boolean, a short unit-like text or a flat object of those with at most 32 keys, and its
  name must match `[A-Za-z_][A-Za-z0-9_]{0,63}` and not be a prototype key. One metric outside that
  refuses the whole answer, before anything of the session is recorded.
- The probe's row-7 verdict recorded status 200 only. The drill answer was described by booleans
  ("objects with numbers and nested values"; nested includes lists).
- No value shape of a server3 details answer is documented, not even of the two consumed fields.

**So the rule is not widened.** Since branch `fix/gpexe-session-details-metric-shape`, that one
refusal carries a sanitized description after " Diagnostic: " on the check row's message:
- the operation;
- count buckets of athletes, metrics and failing metrics;
- whether a consumed field is among the failing ones;
- booleans for a bad metric name (too long, other characters, prototype key);
- for the failing values: their kinds, depth buckets, text-length, list-length and list-item kinds,
  object key counts and child kinds, and whether a failing object has a `unit` / `value` key;
- for the two consumed fields only: presence (none / some / all), kinds, and whether they match the
  documented shape.

It never carries an athlete id, any other metric name, a value, a text, a date or raw JSON. It sends
no request, and a coach does not see it. A drill answer refused the same way keeps its description
through the drill set: the `drill_set_incomplete` message then carries `drill_index`, `drill_code`
and the description. A parser change follows only for a shape that this
description, from one owner-run check of one known date, proves; that check waits for the external
review of the branch.

**The owner-run diagnostic (2026-10-06, one check of one known date, sanitized):**
`op=session_details`, `consumed_failing=no`. `tot_burst_events` and `tot_brake_events` were present
for every athlete as `{ unit: "number", value: <finite> }` with only those two keys. Exactly one
metric failed: an unconsumed object of depth 1 with 5–16 keys, children null / number / short or
other text, and no `unit` or `value` key.

**So the whole-session read is projected (branch `fix/gpexe-session-details-projection`).**
`projectSessionDetails()` validates the container, the canonical athlete ids, the per-athlete
bounds and every metric NAME (the dangerous keys included) exactly as before. Of the values it reads
only `tot_burst_events` / `tot_brake_events`, validated by the same rule as before, and copies each
into a fresh object; an object keeps only its own `unit` / `value`. The projection never reads,
copies, describes, stores or returns any other metric; the generic JSON parse and `redactGpexe` in
`read()` still walk the whole body in memory, within the 5 MiB read cap, and keep nothing of it. A
malformed consumed field still refuses the answer as `consumed_field_shape_unknown`: the sentence
stays generic, and the field and its kind follow the " Diagnostic: " mark (administrators only). A
refused metric name says only which kind of name (`names=prototype_key / too_long / other_chars`).
A new read's snapshot and its content hash cover the projected answer only; no candidate read
through a bound connection existed before the projection, so none is re-seen as changed. `bundle_hash` is the permanent fingerprint of the answer as it was read (the sha256 of its canonical JSON at that moment) and never changes. After a later projection of the stored snapshot it no longer equals the hash of the stored `raw_bundle`, and nothing compares the two: a check compares the hash of a freshly read answer with the column, and the approval copies the column. A later fresh read of the same data therefore counts as changed once its form differs.

Since 2026-10-09 (PR #149) the drill answers are projected the same way, and every stored snapshot of
a candidate that was never imported is projected too (in the supersede transaction and by each
retention run); `validatePlayersAnswer()` and its whole-answer description were removed. An
architecture test runs the real mapper on a bundle whose whole-session and drill details record
every key access, and fails if any other metric is read.

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

**Result of the third drill-only run (2026-10-02, head `3f466ed`, sanitized by the owner):**
`stoppedBy: team_unknown_shape`, 5 requests (one exchange, four reads). The REST list, the
parent's REST read (**same**: the same id, team 980, `drills_count >= 2`) and the legacy parent
read (**observed**: the same id, team 980) were confirmed as before. The first read at position 0
answered 200 with the expected top-level fields (`drills_count`, `players`, `team`,
`teamsession`), but its top-level `team` was **not a canonical id as a number or a string**, so
the run stopped there, as built: position 1 and the repeated position 0 were not sent, nothing
was compared, and there is no conclusion about the parameter. Row 8 stays **observed**, never yet
same. The form of that `team` value is not known from this run, because the report did not
describe it; the diagnostics below were added for the next run. No id, date, value or key of the
answer is copied here.

**Result of the diagnostic run (2026-10-02, head `1166cfa`, sanitized by the owner):** the same
stop, `team_unknown_shape`, 5 requests, `readsMade: 1`. The first answer at position 0 was
described: `teamValueKind: object`, `teamObjectHasId: false`, `teamObjectIdCanonical: false`,
`teamObjectIdMatchesBoundTeam: null` — the drill answer's `team` is an **object without an `id`**;
it stays opaque (owner, 2026-10-02: no key is printed, no other field is looked for, it is never
evidence of the team). The same entry showed `namesParent: false` with `playersPresent: true`:
the answer's `teamsession` is a canonical id that is **not the parent's**, so under the current
rule the answer would have stopped as `drill_parent_mismatch` even with a readable team. Together
with `listRowMatchesFirstDrill: true`, that suggests the legacy drill answer names the drill row
of the list rather than the parent — a reading the next diagnostics check directly, without
changing any rule. The list's total count grew between runs (new sessions at the source); the
count is a counter only. No id, date, value or key of the answer is copied here.

**Result of the second diagnostic run (2026-10-02, head `79b2381`, sanitized by the owner):**
the same stop, `team_unknown_shape`, 5 requests, `readsMade: 1`. The first answer at position 0:
`teamsessionCanonical: true`, `teamsessionMatchesExpectedDrill: false`,
`expectedDrillHasUniqueListRow: true`, `expectedDrillListRowTeamIs980: true`. So the list side of
the supposed chain holds — the parent's first `drills` entry is exactly one row of the list page
already received (uniqueness on that one page of 100 rows, never globally in the source), and that
row names team 980 — but the answer's `teamsession`, though canonical, is **neither the parent nor
that first entry**: the answer names a third session. Whether it is another entry of the parent's
`drills` (a different order than the zero-based position), or no entry at all, that run could not
tell; the final structural diagnostics below resolve it in one run. Row 8 stays **observed**, never
yet same. No id, date, value or key of the answer is copied here.

**Two attempts of the fourth form (2026-10-02, head `7c54a7d`, sanitized by the owner), neither of
which reached a drill read:** the first run — the exchange answered 200, then the REST session
list (`team_session/?team=<team>&limit=<n>`) did not answer within the 30 s timeout; 2 requests;
`stoppedBy: session_list_unavailable`, the drill verdict `not_observed` with that reason; nothing
else was sent. The second run — the exchange itself answered 400 with the single field
`non_field_errors`; no token was issued and no GET was sent; 1 request;
`stoppedBy: exchange_failed`. Both are **operational events without any conclusion** about the
drill model, the token or the account: a 400 on the exchange does not tell its cause apart, and
the same pair had passed six exchanges before. By the owner's decision there is no third attempt
and no new diagnostic. **F3c2b is closed with the drill endpoint at observed** (section 3, "How
F3c2b closed"); the fourth form stays in the probe, unrun, as built. No id, date, value or key is
copied here.

**The drill-only run, fourth form: the final structural diagnostics (`--mode drill`, owner order
2026-10-02, built; attempted twice without reaching a drill read, see above; not run further):**
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
changes between reads must not pass for a parameter that is applied). **What lets the probe go on
to the next position is the probe-only diagnostic link (owner, 2026-10-02), computed in memory for
every answer, the repeated one included:** the answer's `teamsession` is a canonical id
(`teamsessionCanonical`); it appears in the confirmed parent's `drills` list
(`teamsessionIsAnyParentDrillEntry`, `teamsessionParentDrillMatchCount`) **exactly once**, at the
index reported as `teamsessionMatchedDrillIndex` (an integer only when there is exactly one match,
otherwise null); it is **exactly one row of the list page already received**
(`teamsessionHasUniqueListRow` — uniqueness on that one page of 100 rows, never in the whole
source); that row names team 980 explicitly (`teamsessionListRowTeamIs980`); and the answer
carries a non-empty `players`. All five true → `diagnosticLinkConfirmed: true` and the next read
is sent; anything false → `not_observed` with `drill_link_not_confirmed` and no further request.
**This link is not an identity rule and no permission for the adapter**, which has no drill
implementation; the identity contract of a drill answer is decided by the owner after the result,
not by the probe. The drill answer's top-level `team` is **opaque and never evidence of the team**:
its shape is described (`teamValueKind` — `absent`, `null`, `number`, `string`, `object`, `array`,
`other` — and, for an object only, `teamObjectHasId`, `teamObjectIdCanonical`,
`teamObjectIdMatchesBoundTeam`), no key is printed and no other field is looked for; a canonical
id naming another team still stops the whole run (`team_isolation_failed`); any other shape is
only described. A non-200 (`drill_not_200`), an unreadable body or a JSON primitive
(`drill_answer_unreadable`), an empty array or object (`drill_answer_empty`), a list body
(`drill_answer_identity_unconfirmed`) or no `players` (`drill_players_missing`) ends the run as
`not_observed` with that reason and no further request. The repeated position 0 must map to the
**same** `teamsessionMatchedDrillIndex` as the first (otherwise `drill_repeat_index_changed`, no
comparison) and carry the same canonical `players`; it is held to the same identity, content,
answer-size, timeout and sanitization rules as the first; (5) only the three `players`
contents are compared, whole and in memory, independent of key order — no key or value of any is
printed. The comparison is made on the answers after the importer's drop list of personal fields
(`redactGpexe`), so a difference that lies only in a dropped field reads as identical; that fails
safe. **The two position-0 answers differ → `not_observed` with `source_changed_during_probe`
(`repeatStable: false`), whatever position 1 answered; both position-0 answers identical → the
sequence completed under the diagnostic link and the capability is reported as `observed` — not
same (owner, 2026-10-02: the final identity contract is decided after this result) — with
`repeatStable`, `parameterApplied` (position 1 differs from position 0) and the three matched
indexes `drillIndexes.drill0`, `drill1`, `drill0Repeat` reported separately; never mapped or
missing.** No `drills` entry
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
`readsMade`, `diagnosticLinkConfirmed`, `repeatStable`, `parameterApplied`, `drillIndexes`, `drill0`,
`drill1`, `drill0Repeat`), which is set
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
| `session_drill_details` | **Drill-only run only. Precondition, checked first:** the parent is a list row of team 980 with an explicit `drills` list of at least two entries, confirmed twice — its own REST read answered 200 with the same `id`, team 980 and `drills_count >= 2`, and its legacy read `api/team_session/<parent id>/` answered 200 with the same `id` and team 980. Only then three read-only requests in the control sequence 0 → 1 → 0, on the forms the owner's legacy integration on `server3` sends: `api/team_session/<parent id>/details/?drill=0`, then `api/team_session/<parent id>/details/?drill=1`, then position 0 again — the drills at the zero-based positions 0 and 1 on that parent. Each next read is sent only under the probe-only diagnostic link of the previous answer: its `teamsession` is canonical, appears exactly once in the parent's `drills`, is exactly one row of the list page already received, that row names team 980, and `players` is non-empty (`diagnosticLinkConfirmed`; otherwise `drill_link_not_confirmed`, no further request). The answer's `team` is opaque and never evidence of the team. No `drills` entry is used as an id; no details read without a position. Approved by the owner on 2026-10-02 | each answer, the repeat included: status, body kind, the `team` shape words and booleans, the six link booleans and indexes, a non-empty `players`, and the shape booleans — never an id, value, name, URL or key. The repeated position 0 must map to the same index as the first (`drill_repeat_index_changed` otherwise). Then only the three `players` contents are compared, in memory, never printed: the two position-0 answers differ → `not_observed` with `source_changed_during_probe`; identical → **observed**, with `repeatStable`, `parameterApplied` and the indexes for 0, 1 and the repeated 0 reported separately. The diagnostic link is not an identity rule and no permission for the adapter; the identity contract is decided by the owner after the result. Never mapped. Never **missing** |

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

## 4b. Athlete identity: name and date of birth (discovery 2026-10-06, the identity run)

**Owner order (2026-10-06).** The *Link athletes* screen should identify a GPEXE athlete by
the GPEXE name and date of birth. The internal GPEXE athlete id stays the key OptiMove stores, and
moves to Technical details. Both values must come from a confirmed read-only GPEXE answer for the
bound team 980; the endpoint and the field meaning are not guessed. First step: the exact,
confirmed endpoint and field names. If the repository does not prove them, one owner-run read-only
probe returns field names and booleans only.

**Discovery result: not proven.** Nothing in the repository names a confirmed endpoint or field
for an athlete's name or date of birth on `server3` / `rest_v1`:
- **The adapter has no athlete resource.** Neither `REST_V1_CAPABILITIES` nor `BUNDLE_FIELDS`
  has one. The athlete rows and tracks keep only the canonical GPEXE athlete id (`athlete`), and
  the importer keys a link on it.
- **The importer's drop list is a hint, not proof.** `redactGpexe` in `backend/src/gpexeClient.js`
  removes `athlete_name` and `birthdate` (with weight, picture, e-mail, notes and others) before
  anything is stored. The in-app import runbook says names appeared "on tracks". That list was
  written in F1 for `e03` / `api`. It does not record which resource carried which field, in which
  format, or what the field means, and it says nothing about `server3`.
- **Earlier probes could not see these fields.** Every earlier probe run described an answer only
  after that drop list (section 4), so no report could name them, and none did.
- **The handbook is not available here.** The GPEXE handbook the owner holds
  (`gpexe-v.6-api-rest-handbook.pdf`) is not in the repository, so no page of it can be cited for
  these fields.
- **Not used:** the owner's legacy integration holds credentials and is never opened. A private
  table or a sheet is not a production source (owner).

**The identity run** (`--mode identity`, `backend/scripts/gpexe-rest-v1-capability-probe.mjs`,
owner-run only, same terminal rules as section 4) answers where those fields appear. It sends one
exchange in the host's confirmed form and then at most eight GET requests for Team ID 980. The
order is fixed, and each request runs only when the previous answer confirms what it needs:

| # | Request | Sent only when | A stop |
|---|---|---|---|
| 1 | `team/980/` (proven read of the bound team) | always | the answer's `id` names another team: `team_isolation_failed` |
| 2 | `rest/v1/` (the API's own index of its resources; **not a proven read**) | always | none; not a 200 JSON object: no athlete read |
| 3 | `team_session/?team=980&limit=100` (proven) | always | a row of another team stops the run |
| 4 | `team_session/<id>/` (proven); `<id>` chosen as in the full run | the list gave a safe id | not team 980: `session_not_confirmed`, nothing below |
| 5 | `athlete_session/?teamsession=<id>&limit=100` (proven) | 4 confirmed team 980 | a row of another session stops the run; rows that do not all name the session: nothing below |
| 6 | `athlete_session/<row id>/` (proven) | 5 gave a row with a canonical athlete id | another session stops the run |
| 7 | `track/<track id>/` (proven); the id from 6 only | 6 confirmed the session | none |
| 8 | `athlete/<athlete id>/` (**not a proven read**) | **all of:** the index (2) lists `athlete` on this host at the family's own path `/rest/v1/athlete/` (a proxy's `http` link counts; another host, path or query does not); the athlete id is canonical and the same in the list row (5) and in that row's own detail (6); and that detail did **not** already show both a name-like and a birth-like key (then `already_observed`: one athlete's whole record is not read for nothing) | none; the last request |

The numbers in the table count the reads after the exchange (the script's comments count the
exchange as step 1). There is no athlete list, no athlete filter, no other team, no drill read and
no legacy family. **Two reads are not proven reads: the index (2) and the athlete record (8).** The
index names no team and no person. The athlete record is read through the probe's own URL from the
application's catalog, never through the index's link. It is read only when the index names that
resource on this host, and only for an athlete GPEXE itself named twice inside a confirmed session
of team 980. It is one record, read in memory only and never stored.

**Only closed lists of source keys are printed** (owner's external review of PR #143, 2026-10-06).
A key the source chooses could be a person, whatever its form, so this run never prints one that is
not on a fixed list. Every other key is masked or only counted. The full and drill runs keep their
own rules.

**What it prints per request.** The full run's entry, with the source's key names limited as follows:
- **Field names** (top level, or under `results`): only names of the closed schema list
  (`IDENTITY_SCHEMA_FIELDS`). That list holds the fields the importer reads, a few structural
  keys, and the name and date-of-birth fields below. Every other key is only counted
  (`otherFieldCount`, `otherResultFieldCount`).
- **Header names:** only usual HTTP headers (`IDENTITY_HEADER_NAMES`); others are counted
  (`otherHeaderCount`).
- **Header values and the scheme word:** printed only from closed sets, otherwise
  `<unprintable>`:
  - `allow`: a list of HTTP methods;
  - `contentType`: `application` / `text` with `json`, `html`, `plain` or `xml`, optionally
    UTF-8;
  - `gpexeVersion`: a dotted version of at most four groups of one to three digits;
  - `totalCount` and a paginated answer's `count`: a whole count.

  The authentication scheme word is printed only as `Token`, `Bearer`, `Basic` or `Digest`,
  otherwise `<other>`. The version and the counts are bounded number forms, not finite sets: a
  server would have to put a number derived from a person there for it to print. The final guard
  still refuses a recognised name or date value printed in those forms.
- **The index read** (`rest/v1/`) prints none of its keys: `fieldNames` is `<omitted>`, with
  their number.

**What it prints per confirmed answer:** the keys that may hold a name or a date of birth.
- **Which keys:** a candidate is found by a wide rule. For a name, a key ending in `name`, or
  `first` / `last` / `given` / `family` / `middle`. For a date of birth, `birth`, or the
  words `dob` / `bday` / `bdate` / `yob` / `born`. The children of a small object under such a
  key are candidates too.
- **Its name is printed only from a closed list:**
  - `IDENTITY_NAME_FIELDS`: `name`, `first_name`, `last_name`, `full_name`, `username`,
    `athlete_name`, `category_name`, their camelCase forms, and a few more;
  - `IDENTITY_BIRTH_FIELDS`: `birthdate`, `birth_date`, `date_of_birth`, `dob`, `birthday`,
    `birth_year`, `yob`, `born`, … ;
  - for a child, `IDENTITY_CHILD_KEYS`: `first`, `last`, `given`, `family`, `middle`,
    `full`, `display`, `short`, `year`, `month`, `day`, `date`, `value`, `text`.

  Any other candidate is `<name_key>` / `<birth_key>` and is still described, so the owner learns
  that something name-like exists without its key.
- **Path:** the key path runs through the structural containers of a fixed list (`athletes`,
  `players`, `profile`, …). Any other key on the way is `<key>`, and a map keyed by ids is
  `<id>`. So a path holds only closed names and placeholders, for example `athletes[].birthdate`,
  `[].athlete_name`, `players.<key>.first_name` or `athlete_name.<name_key>`.
- **Counts and kinds:** how often the key is present, out of how many objects, and its value
  kinds.
- **For a name:** whether every value is non-empty text with a letter, whether any value has two
  words, and whether the values are distinct.
- **For a date of birth:** how many are null and, over the rest, whether every value is
  `YYYY-MM-DD`, starts like `YYYY-MM-DDT`, is a real calendar date, and has a year from 1900 to
  the current year.

**The index read** adds booleans only, about its `athlete` link: listed, exactly the expected URL,
a URL at all, `https`, the same host, the same path. No resource name is printed; the index's
request entry gives only their number (`otherFieldCount`).

**The athlete read** adds whether its `id` is the one asked for, and the kinds and booleans of
its `team` / `teams` fields against team 980 (never another team's id).

**The summary, `identity_fields`,** gives the number of reads described, and the reads where a
name-like or a birth-like key was seen. It is `not_read` when no answer was described.
**"observed" means only that a key of that kind was seen. Which key is the athlete's name or date
of birth, and whether it is reliable, is the owner's decision after the result.**

**What it never prints:** a value, a part of a value, an id, a URL, a source key outside the
closed lists, or a header value outside its shape. The values are read in memory only. This is
the one place the probe looks at an answer before the drop list.

**The second guard.** Besides the existing secret guard, a second final guard refuses to print a
report that would carry any value seen under an identity key (`identity_value_in_report`; the run
then prints nothing).
- **Matching:** a value is matched quoted, or from four characters as a bare word. A word is
  letters, digits and `_`, as in an identifier, so a value is never found inside `team_session`.
- **The report's own vocabulary is skipped:** the probe's keys, codes, verdicts and kinds, its
  masked request paths, and source key names that are on the closed lists. A source key outside
  them never joins the vocabulary, however often it recurs. A session called *rest day* or *team
  training* therefore never refuses the run: the probe prints `rest` and `team` in its own paths
  whatever the source sends.
- **Still checked:** header values (content type, allow, the GPEXE version), so a source that
  echoes a name into a printed header is refused.
- **On a refusal,** standard error shows the code and the masked path of the read that first
  carried the value, never the value itself.

Contract tests with made-up markers only, against a fake server
(`backend/tests/gpexe-rest-v1-capability-probe.test.mjs`, tests 15–25). Mutation evidence: each
of the guards above, when removed, fails the suite.

**Result of the owner-run identity run** (2026-10-06, at `1cf2430`, after the owner's external
review READY). The owner ran it once and returned the sanitized report. Only its verdicts are
recorded here: no name, date, id or report.
- **The run completed** (`stoppedBy: null`): one exchange and eight reads, each answered 200. Team
  980 was confirmed by the team read and by the session's own read.
- **The athlete resource is confirmed.** The API's index lists `athlete` at exactly
  `rest/v1/athlete/`. `rest/v1/athlete/<id>/` answered with the same `id`, for the athlete of a row
  confirmed twice under a session of team 980. The record carries no `team` / `teams` field, so
  the athlete's membership of the bound team comes from the confirmed session, not from the record.
- **Name fields on the athlete record** (forms as observed on the one athlete read; a name of
  several words stays valid under the whitespace rule below):
  - `first_name` and `last_name`: each non-empty text of one word;
  - `name`: non-empty text of more than one word;
  - `short_name`: one word.

  The record has four more fields outside the probe's closed lists; they were not named.
- **Date of birth:** the athlete record has the field `birthdate`, but its value was null for the
  one athlete read. **Its format is therefore not proven**, nor whether GPEXE fills it for other
  athletes.
- **Not a source of identity:**
  - the team read: no name-like or birth-like key besides the team's own `name` (its other keys
    were not named, so whether it carries a list of athlete ids is not known);
  - the athlete rows and their own reads: only the numeric `athlete` id;
  - the session list: its `name` and `category_name` are session fields;
  - the track: it carries an `athlete_name` (text of more than one word), which is not used.
- **Not read:** the athlete list (`athlete/?team=…`), because its filter is not proven.
- **Not printed:** the GPEXE version header did not fit the probe's closed version form and was
  printed as `<unprintable>`.

**Owner decisions after the result (2026-10-06):**
- **Source:** `rest/v1/athlete/<id>/` is the confirmed identity source. There is no further
  owner-run probe.
- **Name:** `first_name` + `last_name`, each trimmed, with runs of whitespace collapsed to one. If
  the two are not both usable, the fallback is `name`. `short_name` and the track's
  `athlete_name` are not used.
- **Date of birth (option A):**
  - accepted: only a valid `YYYY-MM-DD`, or a valid ISO date-time, whose calendar date is taken
    from its first ten characters without any time-zone shift;
  - shown as "Date of birth not provided": `null`, empty, or any other form;
  - an administrator may see only the number of values in an unrecognised form, never a value.

**Boundaries of the implementation PR.** It is a separate PR, only after this PR is merged.
- **Reads:**
  - one athlete GET (`rest/v1/athlete/<id>/`, never a list or a filter), only for a canonical GPEXE
    athlete id already seen through a confirmed session of the bound team, read through that team's
    active binding (never the environment token); the client never sends an athlete id that the
    backend then reads;
  - at most 50 distinct identities per check, at most 3 requests in parallel;
  - no retry, no redirect, no other host.
- **The identity snapshot:**
  - it lasts 14 days, and a later check reuses it while it is valid;
  - it holds only the source connection / team provenance, the source athlete id, the sanitized
    name, the normalized date of birth or null, `observed_at` and `expires_at`;
  - it never holds the raw answer, `short_name`, the track's `athlete_name` or the four unnamed
    fields;
  - an expired snapshot must be deletable;
  - an Unbind stops any new read and any display through the ended binding.
- **The name:** Unicode text, whitespace trimmed and collapsed, a bounded length, and control,
  bidi and invisible characters refused. The UI always escapes it.
- **Visibility:** the name and the date of birth are visible only to a platform admin and the
  active club admin of the owning club. A coach and another club get no identity.
- ***Link athletes*** shows, to those two roles only, "First Last" (or the `name` fallback), with
  "Born DD.MM.YYYY" or "Date of birth not provided" under it. The internal GPEXE id moves to
  Technical details.
- **No automatic link:** no preselection, and no link by name or date alone. Duplicate names and a
  conflicting date carry a clear warning.
- **Not changed in it:** the importer, the metric / variable mapping and the import switch.
- **Never recorded or sent elsewhere:** the name and the date never go into a log, an audit row, a
  URL, an error code, a diagnostic, a fixture with real data, a PR or chat.
- **Before its merge:** a separate security / privacy review and a database review.

**The implementation, as built** (owner order 2026-10-06, branch `feature/gpexe-athlete-identity`, not
merged; contract `docs/ai/source-connections-f3c2-contract.md` section 2.10):
- **Capability:** the adapter's capability table carries `athlete_read` (proven by the identity run).
- **The read:** `readAthleteIdentity()` is the one read whose provenance is the caller's. The athlete
  record names no team. The identity service takes the id only from the stored, succeeded checks of the
  team's current binding, and the resolver's `identityReaderFor()` refuses any other id.
- **The projection:** the answer is projected through `identityFromAnswer()`
  (`backend/src/gpexeAthleteIdentity.js`) before anything else sees it. Exactly the keys `id`,
  `first_name`, `last_name`, `name` and `birthdate` are read, as own properties only.
- **One owner rule tightened:** "at most 50 per check" became **at most 50 per explicit administrator
  load**. A check never reads an athlete record (owner order of 2026-10-06 for the implementation).
- **Date of birth, the one concretisation of option A:** a date before 1900-01-01 or after today (UTC)
  counts as "an impossible date". It is shown as not provided and counted as unrecognised.

## 5. Rules the adapter keeps, whatever is added later

- Selected by `(source_system, apiFamily)`; a family without an adapter is
  `adapter_not_available`. No adapter is made from another by rewriting paths.
- Every `rest_v1` URL comes from `sourceApiUrl()` with the key's own approved catalog row. The
  only other URLs are the two the legacy builders make — `legacyDrillDetailsUrl()` and
  `legacyBriefUrl()`, `api/team_session/<confirmed parent id>/details/?drill=<index>` and
  `…/brief/` on the approved `server3` host only — behind the same catalog gate; they are not a
  generic `api/` family, take no path, URL, host or extra query, and are used by the drill reads
  only. The host path rule admits exactly two percent sequences in a query value, `%20` and
  `%3A`, for the proved date-window form.
- The bound source team id is fixed when the adapter is created. No operation accepts a team; an
  option that names one in any spelling is refused; a query never carries `team` twice.
- An answer, a row or a next-page link that names another team is refused
  (`source_team_mismatch`), and a team in an unknown shape is refused
  (`source_answer_unexpected`). Nothing of a refused answer is returned.
- Resources without a team parameter (details, drills, athlete rows, `/more/`, tracks, the
  brief) are reachable only from a session this adapter instance first read and found to belong
  to the bound team (`getSession`): `session_not_confirmed` / `athlete_row_not_confirmed` /
  `track_not_confirmed` otherwise. The top-level `team` of a details answer is an aggregate, not
  an identity; `drills` entries and a drill answer's `teamsession` are neither a URL source nor an
  identity guard.
- The session list is told apart into parents and drills by the confirmed list structure only
  (a drill is named in exactly one other row's `drills` and carries none itself); an ambiguous
  page is refused (`source_list_ambiguous`), never thinned.
- A `players` answer is accepted only as a map of canonical athlete ids to metric values (an empty
  map is valid; a missing, null, array or other shape is refused); only `players` and
  `drills_count` leave the adapter. A session is read only when a session list of this instance
  classified it as a parent (`session_not_listed` otherwise, no request); an athlete row only when
  the confirmed session's own list named it (`athlete_row_not_listed`). Every read returns only
  the projected fields (`BUNDLE_FIELDS`). A refresh of a session or of its athlete list withdraws
  every row and track confirmed under it, and an answer that started before the refresh is
  discarded (`session_refreshed`). No retry by default. One failed drill never makes an
  incomplete set look complete (`getSessionDrills`: `complete: false`, the failed index and code).
- Drill names come from an unambiguous `drillTags` mapping of the parent's brief and the bound
  team's tag catalogue, otherwise `Drill N`; never from the day's other sessions.
- GET only; one closure talks to the network; no generic request helper exists.
- Stable codes, OptiMove's own sentences, never the source's text; the credential only in the
  `Authorization` header. `401` is `source_auth_rejected`, `403` is `source_access_refused` (on
  the bound team's own read both `403` and `404` are `source_team_not_visible`; what `rest_v1`
  really answers for a team the account cannot see is part of the next probe).
- No retry by default: one attempt per read; a caller may ask for at most three, and `429`, `401`, `403`, `404` and a redirect are never repeated. Timeout and retry delay are bounded. An answer is at
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
`countVisibleTeams`, `listSessions`, `listSessionsByDay`, `getSession`, `getSessionDetails`,
`getSessionDrillDetails`, `getSessionDrills`, `listAthleteSessions`, `getAthleteSession`,
`getAthleteSessionMore`, `getTrack`, `getTeamThresholds`, `listSessionTags`, `getDrillLabels` and
`fetchSessionBundle` (the contract's `testConnection` and `listTeams` are built from the first
two). Its codes and what a route makes of them:

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
| `source_list_ambiguous` | the session list cannot be told apart into parents and drills (`reason`: `named_row_has_drills`, `entry_named_twice`, `self_reference`, `drills_count_disagrees`, `classification_conflict`) | `source_answer_unexpected` |
| `source_answer_unexpected` with `reason: field_shape_unknown` | a projected field carries a value of a shape no consumer reads (an object, a long text, a nested list) | `source_answer_unexpected` |
| `session_list_refreshed` | a newer session list was started while this one was in flight; its classification was discarded unrecorded, whichever answered first | `internal_error` (the caller repeats the list) |
| `source_list_too_large` | the whole session list announces more than 2000 rows (refused at its first page) | `source_answer_unexpected` |
| `source_session_start_unreadable` | a row of the whole session list has a start that is not a real date and time | `source_answer_unexpected` |
| `session_not_listed`, `session_not_confirmed`, `athlete_row_not_listed`, `athlete_row_not_confirmed`, `track_not_confirmed` | a read asked before its session was classified as a parent, confirmed, or its row listed, by this adapter — a caller's ordering mistake | `internal_error` |
| `session_refreshed` | the session or its athlete list was refreshed while this answer was in flight; the answer was discarded unrecorded | `internal_error` (the caller repeats the read) |
| `invalid_drill_index`, `drills_count_out_of_range`, `invalid_id` | an index outside 0 to `drills_count - 1`, more than 30 drills, or a non-canonical id | `internal_error`, except `drills_count_out_of_range` from the source's own `drills_count`, which is `source_answer_unexpected` |
| `team_param_not_allowed`, `duplicate_param`, `path_not_allowed`, `invalid_options`, `invalid_bound_team`, `credential_missing` | a caller's mistake inside OptiMove, never a user's input | `internal_error` (logged with the code, never with a value) |

The routes create one adapter per request, from the catalog row read in that request, so a key
retired between two requests fails the second one (contract condition 7).
