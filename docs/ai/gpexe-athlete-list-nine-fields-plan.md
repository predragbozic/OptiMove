# Plan: a read-only check of the nine athlete-row fields in server3's athlete list

Status: **plan; the tool is implemented and tested against a fake server only, and merged and deployed as PR #210
(merge commit `38c2431`, 2026-10-24). No GPEXE request has been sent. The real read is neither approved nor run, so the nine fields are not confirmed
compatible.** Owner orders 2026-10-22 (plan) and 2026-10-23 (prepare the tool and test it against a fake server
only; commit it as a separate Draft PR). The owner-run read happens only on a separate owner order, after the
owner's external review of the tool. The internal `code-reviewer` and `security-reviewer` checked the plan and
the tool on 2026-10-23; their corrections are in this text and in the tool.

Last verified against commit: `12beb86` (`origin/main`). Sources: `backend/src/gpexeRestV1Adapter.js`,
`backend/scripts/gpexe-rest-v1-capability-probe.mjs`, `docs/ai/gpexe-check-request-count-analysis.md`.

## 1. The question

For every athlete row of a session, a check reads `rest/v1/athlete_session/<id>/` although the list
`rest/v1/athlete_session/?teamsession=<id>&limit=100` already returns that row. Both are reduced to the same
projection of nine fields (`BUNDLE_FIELDS.athleteSession`):

`id, athlete, track, teamsession, drill, is_stats_valid, total_time, total_distance, max_v`

In the owner's check of 2026-10-22 at 17:11 those reads were **193 of 455 requests (about 42 %)**.

The saving is safe only if server3's **list row carries all nine fields with the same values as the row's own
read**. Then the stored bundle and its hash stay identical, and no session reads as "changed". This has never
been compared on server3: the probe of 2026-10-01 saw only that the row read answers 200 and names the same
session.

## 2. The tool: `--mode athlete-list` of the capability probe

The same patterns as the `drill` and `identity` runs:
- one exchange in the host's confirmed form (form-encoded `api-token-auth/`);
- then GET only, for Team ID 980, through the approved `server3` profile;
- no redirect followed, no repeat, a timeout per request, answers bounded at 5 MiB;
- no database.

**Order and budget** (`ATHLETE_LIST_MODE_MAX_REQUESTS` = 12, exactly the plan):

| # | Request | Count |
|---|---|---|
| 1 | the exchange | 1 |
| 2 | `team_session/?team=980&limit=100`, first page | 1 |
| 3 | for each of **2** parents: its own read (the same id, team 980, `drills_count` 1–30) | 2 |
| 4 | for each parent: its athlete list (first page) | 2 |
| 5 | for each parent: the own read of **3** rows of that list | 6 |
| | total | 12 |

**Choosing the parents.** From the list page only, never a typed id: the first two rows of team 980 with a
readable id, named in no other row's `drills`, with an explicit `drills` list of at least one entry. So the
athlete list holds drill rows too. No `drills` entry is ever used as an id.

**Choosing the rows**, deterministically from the list that arrived: the first whole-session row, the first drill
row and the last row of the list, then the next ones in order until three are chosen.

**Pace and 429.**
- A pause of 2 s (`ATHLETE_LIST_PAUSE_MS`) before every read; the whole run takes about half a minute.
- The first 429 ends the run at once, with no repeat (`stoppedBy: rate_limited`). That includes a 429 on the
  exchange itself (request 1). The report keeps the request number and `Retry-After` as a kind word with bounded
  seconds (`retryAfterOf`), never the raw text.

**Stops.** Any identity, session or team that is not confirmed stops the run before the next request:

| Code | Cause |
|---|---|
| `team_isolation_failed` | a row of another team, an athlete row of another session, or a row read naming another session |
| `team_unknown_shape` | a team in a shape the probe cannot read |
| `parent_id_mismatch` | the parent's own read answers another id |
| `parent_not_confirmed` | the parent's own read fails, or does not confirm team 980 and a drill count of 1–30 |
| `athlete_list_unavailable` | the athlete list does not answer as a list |
| `athlete_rows_unreadable` | an athlete row is not an object |
| `rows_do_not_name_session` | a row names no session in a readable way |
| `row_identity_unreadable` | a row's id or athlete is not readable |
| `row_ids_repeated` | the list names one row twice |
| `athlete_list_empty` | a parent's athlete list holds no row: never a vacuous "same" |
| `row_detail_unavailable` | a row's own read fails |
| `row_id_mismatch` | a row's own read answers another id |
| `detail_does_not_name_session` | a row's own read names no session in a readable way |
| `session_list_unavailable` | the session list does not answer as a list |
| `no_parent_session` | the list page holds no parent |
| `request_limit` | the run would need more requests than its cap |
| `rate_limited` | the first 429, on any request including the exchange |
| `exchange_failed` | the exchange was refused, timed out, was redirected or issued no token; its request entry keeps the status or the error |
| `unexpected_error` | anything the run did not foresee (no further request) |

## 3. What is compared (in memory) and what is printed

The nine fields of the list row and of the row's own read are compared as canonical JSON. The adapter's
projection only selects these fields and refuses an unknown shape; it never changes a value. So equal values with
equal presence mean the same projected row, and the same bundle.

**Per field** (names only from the closed list of nine):
- `inListAll`, `inDetailAll`: the field is present in every compared row;
- `equalAll`: equal, or absent from both, in every compared row;
- `projectableAll`: every list value is one the adapter's projection accepts (null, a boolean, a finite number,
  a one-line text of at most 64 characters; a track also a canonical id or null);
- `kindsList`, `kindsDetail`: kind words — `absent`, `null`, `number`, `string`, `boolean`, `object`, `array`.

**Per row:** `rowKind` (`whole` or `drill`), `projectedEqual`, and `differingFields` (names from the closed list).

**Per session:**
- `drillsCount`, `listTotal` (only a whole number of at most nine digits, else null), `rowsOnPage`, `pageComplete`;
- `wholeRows`, `drillRows`, `distinctAthletes`, `listRowsHaveTrackField`;
- `rowsMatchOnePerAthleteAndDrill`: the analysis's formula, judged only on a complete page.

**Overall:**
- `verdict`:
  - `same` only for a run that ended as built, with both planned parents compared, every compared row equal and
    every list value projectable;
  - `differs` when the run ended as built and any compared row differs, also when the page held one parent (a
    difference is already the answer);
  - `not_observed` otherwise, with the reason: the stop code, `nothing_compared`, `fewer_parents_than_planned`
    (the page held one parent and every compared row was equal; its facts are still printed) or
    `value_shape_not_projectable`;
- `sessionsCompared`, `rowsCompared`, `allProjectedEqual`, `stoppedBy`, the request count.

**Request entries.** Each keeps the probe's shared description of the answer (status, kind, header names and
the few header values the other runs print). Of an answer's own key names it prints only the closed list
(`ATHLETE_LIST_PRINTABLE_KEYS`: the session fields the importer reads, the nine row fields and `drills`). Every
other key is only counted (`otherFieldCount`). A count from the answer is printed only when it is a bounded whole
number.

**Never printed:** an id, a name, a date, a value, a URL, a text of an answer, or an answer key outside the closed
list. The probe's existing final guard (no secret, no issued token in the report) applies unchanged.

**Preparation (2026-10-23).** The mode and fake-fetch contract tests (AL1–AL15, beside the probe's other tests in
`backend/tests/gpexe-rest-v1-capability-probe.test.mjs`) were written and run against a fake server only, with
mutation evidence for its guards. They cover:
- the exact order and the pauses;
- `same`, `differs`, a field missing from the list, and a field missing from both;
- the 429 stop for each `Retry-After` form;
- every stop above, with no request after it;
- the parent and row choice;
- the cap;
- a failed exchange, and a 429 on the exchange;
- the key-name filter;
- an empty athlete list;
- a value the adapter would not accept;
- an unreadable total, on a read and on the exchange;
- a difference with one parent.

They came with PR #210 (`feature/gpexe-athlete-list-probe`, merged as `38c2431`), with section 4c of
`docs/ai/gpexe-rest-v1-compatibility.md`. What they confirm is the tool's own behaviour
against a fake server. They confirm nothing about server3's answers.

## 4. Order of work (each step on the owner's order)

1. **The tool's PR:** done as PR #210, merged after #209 (2026-10-24) (the mode, the tests and section 4c of
   `docs/ai/gpexe-rest-v1-compatibility.md`). No change to the adapter, routes, database or screens.
2. **Reviews:** `code-reviewer` and `security-reviewer` are done (READY WITH NON-BLOCKING NOTES). The owner's
   external review is open.
   - **Recommended integration order:** this plan's PR #209 first, then #210, and #210 checked against `main`
     after #209 merges.
   - **The dependency is documentation only:** #210 needs no code from #209; only its reference to this plan
     resolves once #209 is merged.
3. **The PowerShell commands are handed over only after that review.** Before the run:
   - no check, identity load, Connect, Reconnect, Test or Bind is running;
   - the last 429 was at least 60 minutes earlier, or its `Retry-After` has passed;
   - the environment variables are removed after the run.
4. **The owner runs it once** and returns only the printed JSON.
5. Only the verdicts are recorded, in the compatibility document and in the request-count analysis.

**About the exchange.** Only one earlier probe ran after the first Connect (2026-10-05): the identity probe of
2026-10-06. The stored connection went on working after it (the identity load of 2026-10-07 and the checks from
2026-10-09 on). That is consistent with GPEXE returning the same token, but **not proven**. The owner's Apps
Script integration is another consumer of the same account, and what an exchange does to its token is unknown.
If an exchange did rotate the token:
- the next check would get 401, and the connection would move to *Needs reconnect* through the existing
  auto-invalidate path;
- nothing would be imported wrongly.

## 5. The decision after the result

- **GO for the reduction** only on the verdict `same`: both planned parents compared, every compared row
  `projectedEqual`, every list value projectable, and every list row naming its session with a readable id and
  athlete. Then a separate implementation PR follows:
  - the rows and the track's confirmation come from the list;
  - a check no longer calls `getAthleteSession`;
  - recommended: a **canary of one row read per session**, compared with its list row, that stops the check
    fail-closed on a difference. That costs 1 request per session instead of A.

  It also updates the tests that section 4 of the analysis lists, and it needs an external review.
- **NO-GO** when any field differs or is missing from the list: the report names the field. The option is dropped
  or changed, and the analysis records it.
- **The limit of the evidence.** Six rows of two sessions do not prove every row. That is why the canary is part
  of the proposed implementation, not an option.

## 6. What this plan does not do

It changes no check, adapter, PR #209 rule, database or screen, and it sends no request before the owner's
approval. It does not check units or meanings; that is the separate M2b evidence (C97). The two owner-run reads
could later be joined, for fewer runs.
