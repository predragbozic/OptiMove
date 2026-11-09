# J20 — Session review: one table for the whole decision about one GPEXE session

Status: **Proposed** (docs only; no code, no migration). Written on the *Rukovodilac*'s order of 2026-11-09 after the owner accepted
the direction of the "Session Review Table" sketch (https://claude.ai/artifact/LxSceTeB6kxiRtXLJkprP5; the flow sketch
https://claude.ai/artifact/V1DNskt8hNpNGPKGzXcpT7). Base: `origin/main` `bbd5b450`. Parts: **J20-A** (A1 the recompute route, A2 the screen),
**J20-B** the subset import (★★), **J20-C** the roster states in the same flow. The open owner questions are in section 11.

## 0. In short

Today a coach reviews a session in a modal that lists values, then approves the whole session; athletes who need a person are handled
elsewhere (*Link athletes* for the whole team, the Roster tab for attendance after the import). J20 puts the whole decision for one
session on one screen, one row per team athlete:

1. what GPEXE recorded for the athlete (the values the import would write, GPEXE value beside OptiMove value);
2. what is in the way (not linked, no data, conflict) and the one action that removes it, on the row;
3. what the coach decides for the athlete: import, leave out, or state attendance for an athlete with no device data;
4. one primary action at the bottom: **Import N athletes**.

Rows that need a person are on top; rows that are fine are folded. Nothing new is written until the coach presses the primary action.

## 1. Inputs and decisions already taken

* Owner: the preview (v3) already carries every value per athlete; the screen is a re-arrangement plus three row actions.
* *Rukovodilac*'s additions: rows that need action always on top with filter chips (not linked, no data, conflict); "all fine" rows collapsed;
  one screen does everything (linking from the row, attendance states, importing a subset); on a phone cards replace the table and
  one primary action stays sticky; coach language, codes only in an administrator's Technical details.
* "Estimated" values (phase 5b: a copy or an average) are **not** part of J20 (section 7).
* J20 must agree with **U6a** (the daily screen, PR #408): its attention groups open this review (section 8).

## 2. What exists today (verified on `bbd5b450`)

| Fact | Where |
|---|---|
| The preview is a rolled-back run of the real import under the team lock; it lists per GPEXE athlete: participation, GPS status, `results[]` with values (version 3: variable label, unit, value, source field and source value), `skippedValues[]`, `notImported` (`athlete_not_linked`, `athlete_not_in_team`, `session_blocked`, a blocking kind), and `teamAthletesWithoutGpexeRecord` | `backend/src/gpexeImportPreview.js` (the `entry.notImported` branch near line 476) |
| `approveCandidate` imports the **whole candidate** exactly as its preview showed it; refused unless `previewHash` equals the hash of the preview recomputed in the same transaction | `gpexeImportService.js` `approveCandidate`, v23 trigger |
| A GPEXE athlete that is not linked or not in the team is left out of the import automatically (the session stays importable) | preview `notImported` |
| A link writes only `gpexe_athlete_links`. `getCandidate` returns the **stored** preview and hash, so after a link the review stays as it was and the screen marks it stale (`reviewMadeBeforeLinkChange`) until a check that started after the link has seen the session. Nothing recomputes it on demand today (a refused approval stores a fresh one via `storeRefreshedPreview`; a check publishes through the v33 finalization) | `gpexeImportService.js` `getCandidate`, `linkAthlete`; `frontend/gpexe-import-data.js` |
| Roster decisions (*Participated · no device data*, *Did not participate* with a reason) are written by the 5a2 routes, one athlete or a bulk of up to 60, idempotent by `requestKey`, on an activity that already exists | `docs/ai/phase5a-discovery-and-contract.md`, `activity-roster-*` |
| The in-app undo of an imported session (v57, U5) refuses a session with any roster decision (`roster_decisions_exist`) | `docs/ai/j19-u5-undo-contract.md` Q4 |
| Linking one GPEXE athlete: `POST …/athlete-links` `{ gpexeAthleteId, athleteId }`; U3 suggests pairs and U3's *Confirm all* links several | existing routes |

## 3. The screen (J20-A2, frontend, ★)

**Header:** the session (type, date and time), the team, one summary sentence ("15 of 22 athletes have data · 4 need a person"), the
state of the import switch in the coach's words. **Filter chips:** *Needs a person* (default when any), *Not linked*, *No data*,
*Conflict*, *All*. Counts on the chips.

**Rows (one per team athlete plus one per GPEXE athlete that is not yet matched).** Columns: athlete (OptiMove name; a not-linked
GPEXE athlete is shown **by audience** as section 4 says: an administrator by the stored GPEXE name and date of birth, a coach as
"GPEXE athlete N" with the helper values), the values (Duration,
Total distance, Maximal running speed — the variables the team's mappings fill — each with the GPEXE value in small type), and a status
chip. Order: needs-a-person rows first (not linked, then conflict, then no data), then the rows that are fine, which are folded under
"N athletes are fine" and open on a tap.

The row kinds are derived from the preview's **real** codes (`ATHLETE_ANOMALY`, `notImported`, `BLOCK_MESSAGES`, `skippedValues` in
`gpexeImportPreview.js`), not invented ones; a test enumerates them from the source so a new code cannot be unrepresented.

| Row kind (preview fact) | What the row shows | The action on the row |
|---|---|---|
| Importable (no `notImported`), including the *Participation only* sub-kind below | values, chip "Will be imported" | *Leave out* (J20-B; *Importable* rows, the participation-only sub-kind included, are the only ones that can be excluded) |
| *Participation only* (a sub-kind of Importable: `allValuesLeftOut`, kept with every mapped value left out) | note "no values could be imported" | *Leave out*; counts in N (his participation is written) |
| Imported with some values left out (`skippedValues`) | values plus a note per left-out value and its reason | none (the athlete is still imported) |
| Not linked (`notImported: athlete_not_linked`) | identification by audience (section 4), values, chip "Not linked" | *Link to…* (chooser of the team's active athletes not yet linked; same-name athletes cannot be chosen; nothing preselected; U3's suggestion first). Already left out by the importer: no *Leave out* |
| Not in the team (`athlete_not_in_team`) | chip "Not in this team" | none |
| Needs review / invalid data (`multiple_tracks`, `stats_invalid`, `whole_session_row_count`) | one sentence of what is wrong | none (a GPEXE data matter; already left out by the importer) |
| No device data (a team athlete in `teamAthletesWithoutGpexeRecord`) | no values, chip "No data from the device" | *Participated · no device data* or *Did not participate* (+ reason list): **states**, written after the import (5.2). `teamAthletesWithoutGpexeRecord` also lists the team athlete behind a *Not linked* GPEXE row, so while any *Not linked* row exists the state actions are disabled with "Link or leave out the unmatched GPEXE athletes first" |
| Session blocked (`session_blocked`, a `BLOCK_MESSAGES` kind) | no rows; the block's sentence and the step that lifts it | none; the primary action stays off |

`excludedAthleteIds` (J20-B) accepts only athletes whose preview entry is *Importable*; an id that is unknown to the candidate answers `400 invalid_excluded_athlete`, an id that is not *Importable* in the stored preview `400 invalid_exclusion`; any change found under the lock is `409 preview_changed` (never a 400)
(5.1). The "Needs a person" chip counts Not linked, Needs review and No data rows.

**Primary action** at the bottom (sticky on a phone): **Import N athletes** — N counts the rows with "Import" on and values.
Below it, when states were chosen: "and save M attendance states". One confirmation names the counts, not every athlete (the list is on
the screen). A session in which nobody can be imported keeps the button off and says why.

**Phones (360–390 px):** cards instead of a table; chips scroll horizontally; the folded "fine" group is one card; one sticky primary action;
every control 44 px, every input 16 px; the roster's bottom-sheet pattern for the state choice. **Language:** coach words; ids, codes and
fingerprints only in an administrator's Technical details.

## 4. Linking from a row (J20-A1 + A2)

The row's *Link to…* uses the existing link route for one pair. The right to link is "manages the team in the active workspace" (any
coach of the team, as in `routes/gpexeImport.js`): **broader than the import right**, so the screen never assumes that a coach who can
link can also import, and offers *Import* only when the status read says so. A link does **not** change the stored preview (section 2), so J20-A needs a server route that recomputes it (**J20-A1**, 5.0). After a link the
screen calls it **once**, replaces the review with its answer (the new preview and hash), keeps the coach's other row choices keyed by GPEXE
athlete id, and shows the row in its new kind. Without A1 the only way is a full *Find new sessions* check (minutes, GPEXE requests, 429
exposure), which is why A1 is part of J20-A. The primary action always sends the hash of the screen's latest read. A lost link answer is
*Result not confirmed* with *Check result* (same key), as everywhere else in Imports.

**What a row shows about an unlinked GPEXE athlete, by audience.** An administrator (identity basis of `gpexeAthleteIdentityService.js`:
a platform admin in the platform or the team's club workspace, a club admin in that club's workspace; never a team workspace) sees the
stored GPEXE name and date of birth, as in *Link athletes*. A coach in the team workspace sees "GPEXE athlete N" and the helper values
only; J20 adds no name or date of birth to a coach's row. **Recorded fact, not a decision of J20:** U3's `athlete-pair-suggestions`
already returns `gpexeName` and `birthDate` to the team's own coach (`pairSuggestionBasis`); J20 uses U3's suggestions exactly as
they are and does not widen them. The production-use gate for names and dates of birth was set aside by the owner on 2026-11-01
(J17 section 12.3, O10; the owner's own assessment, not a legal confirmation).

## 5. The server side

### 5.0 The recompute route (J20-A1, ★★ trigger 4, no migration)

`POST …/candidates/:id/preview` `{}` recomputes the preview and `previewHash` of the **whole candidate** now and **stores them with the existing
compare-and-set** of a refused approval (`storeRefreshedPreview`: `where id = $1 and preview_hash = <expected> and status in ('pending','blocked')`),
then returns them. This is required: `approveCandidate` compares the client's hash with the **stored** `preview_hash` first
(`gpexeImportService.js` near line 2400) and the approval trigger (v23, redefined in v33) requires the approval's hash to equal the candidate's
stored one, so a hash that was returned but not stored could never be approved (after a link every import would answer `409 preview_changed` until a
full check). The route writes **no durable row except the candidate's own derived columns** (preview, hash, computed-at) by compare-and-set; a lost
compare-and-set answers `409 preview_changed` with the current stored one. Sequence values are consumed by the rolled-back import. The list, U6a's batch
hash and other coaches see the new hash (a batch then gets `preview_changed`, which is safe).

**Sequence and lock order: the approval's, exactly (candidate row, then team).** `approveCandidate` locks the candidate `FOR UPDATE` first and the
team import lock second, so this route does the same; the compare-and-set `UPDATE` of the candidate would otherwise take the row lock while the team
lock is held (team → candidate), the inverse of an approval, and the two would deadlock (`40P01`). Read the candidate unlocked for authorization only →
`BEGIN` (READ COMMITTED) → `setImportTransactionBounds` (`lock_timeout` 5 s, `statement_timeout` 10 s, `idle_in_transaction_session_timeout` 10 s) →
**candidate `FOR UPDATE`** (status pending/blocked, actionable, snapshot state, bundle) → team import lock → `lockApprovalTeam` → binding from
`last_seen_check_id` as approval step 3 (a missing binding yields the blocked `mapping_not_usable` preview) → mapping registry locks → the preview
(rolled-back real import, in a savepoint) → the compare-and-set `UPDATE` of the candidate, **in the same transaction** → `COMMIT`. There is no window
in which the stored preview is older than what the route returned. It does **not** take the approver-rights lock (6b): the right is checked unlocked
and nothing but derived columns is written. A recompute waits behind an approval up to its `lock_timeout` and answers `409 try_again`. `409 try_again` /
`check_preview_busy` when a lock is not free. **Total budget:** the route has a wall-clock
bound like the approval (client-side bound with the connection released with an error on timeout), because the per-statement bounds do not bound the
whole transaction; it holds the team lock for the length of the preview (seconds for a session with drills), during which a check start, a link write,
a roster command and an approval wait up to their own lock bounds. The screen does not call it while a check of the team is running.

**Rate limit.** No durable storage exists for an interval, so it is **per instance, in memory** (limit stated: after a deploy or across instances there
can be more rounds, still bounded by the team lock). It applies only to **repeated calls on the same candidate with the same stored hash**; a call after
a link change is a deliberate step and is not throttled by it. The screen on `429`/`try_again` keeps the stale marker and offers *Update the review* again.

**Audience (whole-candidate recompute): the team managers**, the same as the link right and `GET candidate` (a coach who can link must see the result
of the link). The answer uses the `GET candidate` projection, including D10 (a blocked preview's hash only to a platform admin) and
`namesClubVariables`; only an approver's screen offers *Import*. A viewer without the import right sees the row in its new kind and no import button.
The identical 404; `Cache-Control: no-store`. The subset variant (5.1) is **not** this: it never stores anything.

Tests: link then call → the new preview shows the athlete, the hash differs, the stored hash equals the returned one; then `POST …/approve` with
that hash imports (200); a second user linking between the recompute and the approval → `409 preview_changed` and the stored hash equals the
recomputed one; a recorded-SQL-order test (rule of `.claude/rules/migrations.md`) and an approval-against-recompute concurrency test; a call while a
check holds the team lock → bounded `try_again` with the stored columns unchanged; a coach's body carries no admin-only code.

### 5.1 Importing a subset (J20-B, ★★: triggers 1, 3 and 4; **needs a migration**; the approval gate and the v23 trigger both change)

* **Inputs.** The approval and the preview take an optional `excludedAthleteIds` (GPEXE athlete ids). Canonical form: validated as
  canonical GPEXE ids, de-duplicated and sorted before anything is hashed, at most 60. An id that is not one of the candidate's own athletes
  is `400 invalid_excluded_athlete` (never ignored: garbage must not change a hash); an id the preview already leaves out
  (`notImported`) is **rejected** with `400 invalid_exclusion` (it is already left out, and a client sending it has the wrong screen); only an
  importable athlete may be excluded. Excluding everyone is `no_importable_athlete` (existing). The approval **re-validates the set
  against the athletes of the candidate recomputed under the lock**, not against what the client saw: an id that disappeared answers
  `409 preview_changed`, not a validation error. An excluded athlete is a `notImported` entry with the code `left_out_by_coach` and
  nothing of it is written.
* **Why a migration (found by `db-reviewer`).** The v23 trigger on `gpexe_import_approvals` requires the approval's `preview_hash` to equal the
  candidate's stored `preview_hash` (the whole candidate), and `approveCandidate` compares the caller's hash with the stored one first. A hash
  that covers an exclusion set is a different hash, so a subset approval would fail the trigger. J20-B therefore changes the approvals table
  and the trigger: the approval keeps `preview_hash` (the candidate, as today) and gains `excluded_athlete_ids` (ids only, no names) and
  `subset_hash`; the trigger (a `CREATE OR REPLACE` of the **v33** body of `validate_gpexe_import_approval`, with the LO-2 md5 precondition; v56 and later checked for a
  redefinition) checks the full-candidate hash against the candidate, that `excluded_athlete_ids` is `'{}'` NOT NULL (no backfill), canonical, sorted,
  unique and at most 60, that `subset_hash` is NULL exactly when the set is empty, its format, and that both are write-once. **A trigger cannot
  recompute a preview**: the subset hash and the exclusion set are verified by `approveCandidate` step 12 under the locks, against the preview
  recomputed in the same transaction (tested); a raw writer is outside that guarantee (the v35 pattern). The rollback refuses once any approval has a
  non-empty set. A migration test: a raw INSERT with exclusions and no subset hash is refused (`23514`); one with a well-formed wrong hash succeeds,
  pinned as the documented limit. **Which hash the client sends:** `previewHash` = the candidate's stored full hash (kept fresh by 5.0) and, for a
  subset, additionally `subsetHash` and `excludedAthleteIds`. That also **records who was left out**, so "why is athlete X missing from this session" stays answerable. It is a ★★
  migration: the owner's order naming it, the *Rukovodilac*'s preflight (standing order), both ★★ reviews, trigger 1 external review.
* **The stored preview is never overwritten by a subset.** On a hash mismatch the full path refreshes the candidate's stored preview
  (`storeRefreshedPreview`); the subset path **never calls it**. It answers `409 preview_changed` with the recomputed subset preview in the body
  only, because the list, U6a's batch (which holds the full preview's hash) and other coaches rely on the stored full preview. A test proves
  that a refused subset approval leaves the candidate's stored preview and hash byte for byte as they were.
* **The subset preview** is a separate variant of the same route with `excludedAthleteIds` that **stores nothing at all** (no compare-and-set; the stored full preview and hash stay byte for byte). It is **not cheap and not free of locks**: it runs under the team's import lock with the 9-0 bounds (`lock_timeout` 5 s,
  `statement_timeout` 10 s, `idle_in_transaction_session_timeout` 10 s), answers `409 try_again` / `check_preview_busy` when the lock is not
  free, and has a per-user and per-team minimum interval. Its **audience is the approval's** (O4), not the whole team's: reading the existing
  full preview stays a team-manager read (`GET candidate`), but a subset preview exists only to be approved. The screen asks for it once, on a
  deliberate *Review* step, never on a checkbox toggle, one at a time. It goes through `teamAccess` (the identical 404 for a missing team, a
  wrong workspace, an archived team or club, a malformed id and another team's candidate), applies the same audience projection and
  `namesClubVariables` as `GET candidate` (`left_out_by_coach` is a neutral code for a coach), and answers `Cache-Control: no-store`. A refused
  set carries no id in its message.
* **Not in the batch.** `POST …/imports` (U6a) does not accept `excludedAthleteIds`; an unknown body field there is a 400, so the batch can never
  import a subset behind a hash that does not cover it.
* **What a left-out athlete means afterwards.** The candidate becomes `imported` as a whole. A later check of unchanged GPEXE content finds
  the imported candidate and yields `no_changes`: **a left-out athlete is not importable until GPEXE's content for the session changes**
  (`supplemented` only adds values to results that already exist). J20 does not add an "import the rest" path. A retry with a **different** exclusion set after a lost answer is indistinguishable from a replay (there is no request key), so the screen compares the recorded `excluded_athlete_ids` (`getApproval`, same audience as the approval) with what the user chose and says so. A second approval of the same
  candidate is `409 already_imported` (not an idempotent replay); the retry path after a lost answer is `already_imported` plus `getApproval`,
  which returns the recorded `excluded_athlete_ids`, so the screen can show what was left out. A test approves with an exclusion, repeats the
  request, expects `409 already_imported`, and reads the same exclusion from `getApproval`. If the content changes, the new candidate's review offers the stored exclusion set as the
  default, and an athlete imported earlier cannot be excluded (the existing rule).
* **Roster observations.** An athlete left out by the coach with a real GPEXE record gets **no** "No usable device record" observation (that is
  for a record the importer cannot use). On the roster such an athlete is "recorded by source" without values; J20-C's states are **not offered**
  for them (the bulk absence refuses an athlete with a source record, 5a3b), and the J20 *No data* row covers only
  `teamAthletesWithoutGpexeRecord`. **Discovery proof required before O3 is asked:** a disposable-database test that imports with
  `excluded=[a3]`, runs a new check of the unchanged bundle, and shows no pending candidate offering a3 and the roster state of a3; the owner is
  told the result with the question.
* **Recompute and rollback.** The subset approval has no request key of its own; a lost COMMIT is resolved by the existing bounded COMMIT and
  `resolveUncertainCommit`, which is **extended to return the recorded `excluded_athlete_ids` and `subset_hash`**; a test through the real route proves a lost COMMIT of a subset approval never answers "nothing was imported". The answer after an error never says "nothing was imported" once the COMMIT was sent.
* **Determinism.** The subset hash is computed over the canonical sorted set; a test proves that the same set gives the same hash across runs
  and that two different sets give different hashes and each approval imports exactly its set.
* Reviews: `db-reviewer`, `security-reviewer`, `code-reviewer`; external review (trigger 1 migration, 3, 4).

### 5.2 Attendance states in the same flow (J20-C) — options

Roster states are decisions on an **activity**, which exists only after the import. Two ways to make "import and states" one action:

| | **A. Two steps behind one button** (recommended) | **B. One transaction** |
|---|---|---|
| How | The screen imports (5.1), then sends the roster commands for the chosen states (the existing bulk route, up to 60 athletes, one `requestKey` per group), each idempotent; the result panel says "Imported 15 · 5 states saved" | The approval takes a list of states and writes them in the import's transaction |
| Pros | No new write path; the roster's own checks, locks, concurrency and idempotency stay the only place the rules live; the import (the expensive, irreversible part) is never held up by a state; small, reviewable change | Atomic: nothing half done; one request |
| Cons | Not atomic: the import can succeed and the states fail or be unconfirmed ("Imported 15 · states not saved yet · *Save them again*"); two result stories to explain | A new cross-subsystem write (import lock, then the roster decider locks, v26; `SET CONSTRAINTS ALL IMMEDIATE` would fire the decider's deferred work), a new hash input, no request record to bind the states to a retry after a lost COMMIT (it would need one), and a harder undo story (5.3); ★★ with a larger surface |
| Failure story | The import stands; the states are retried from the same screen (or later in the Roster tab); never lost silently | All or nothing |

**Rules of option A (found by the reviews).**
* **Each step is authorized on its own, by the server, at the time of that request.** The import right is the approval basis (a grant, club
  admin / team coach while the team's switch is on in mode `team`, or a platform admin); the roster right is the roster rights on the active
  workspace path (team coach + club admin + platform admin). The two sets differ (for example a grant-holding coach in the club workspace, or a
  club admin while the switch is in mode `platform`). The screen offers states only if the roster read grants them; a refused step is shown as
  that step failing, never as an import failure; no right from the first step is reused for the second.
* **The states step waits for the activity.** After `import_outcome_unknown` or `verified_after_commit_error` the activity id may be unknown; the
  step stays off until the verified approval names it. The approval has no request key of its own: its replay protection is the candidate's
  status plus `resolveUncertainCommit`, and J20 adds no new idempotency record for it.
* **The states step is N sequential calls**, because the roster bulk takes one kind, reason and note for all its athletes (`validateBulk`): one call per kind+reason group, each with its own `requestKey` generated before the import and kept across a reload, its own *Saved / Nothing saved / Result not confirmed* and its own *Check result*; no call is made until the import's outcome is confirmed (the activity id comes only from the import answer or `getApproval`); a states failure never rolls the import back; a test for "second call lost". **Each call has its own `requestKey`, kept across a reload** (as 5a3b does), and *Save them again* reuses it. The chosen but unsaved
  states survive a reload (kept in the browser for the session); "never lost silently" depends on that.

**Recommendation: A.** The states are small, reversible, and already have a correct write path; the import is the only irreversible act
and should not wait for them. If the first months show friction, B is a later change, not a rework. **Decision for the owner: section 11, O2.**

### 5.3 The undo (U5) and roster decisions — the open question

U5 refuses a session that has any coach roster decision (`roster_decisions_exist`). With J20, every session in which the coach saves states will carry
decisions the flow itself wrote, so a **platform administrator's** undo of a wrongly linked athlete's session would be refused at once. (A coach
never had an in-app undo: U5 is for an active platform admin only, J19-U5; the screen tells a coach "ask a platform administrator".) Options:

| | What | For | Against |
|---|---|---|---|
| **a. Keep the refusal** | undo stays refused | simplest; a decision is a human judgment, never deleted silently | the administrator has no in-app way out; contradicts U5's purpose |
| **b. Undo clears what J20's flow wrote** | the flow's states carry an **origin that the server derives, never a field the client sends**; undo removes exactly those, listing them in the confirmation ("5 attendance states set at import will be removed") and in the deletion log; later Roster-tab decisions still refuse | removes the dead end for the common case; keeps later human judgments safe | a ★★ migration of real size (below) |
| **c. Undo clears every roster decision of the session** | with the list and the log | no dead end at all | deletes judgments a coach made after seeing the session |

**What b really needs (found by `db-reviewer` and `security-reviewer`).**
* The v57 refusal counts four things: decisions, requests, completions and the completion log. All four tables are append-only with their own
  triggers and TRUNCATE guards (v25), and v57 added delete exceptions only for the tables it names. b needs delete exceptions for the four, an
  **origin column on the request record** (the idempotency record is `activity_roster_requests`, which has none; the decision cannot carry it
  alone) and a rule for the completion and log rows that every roster input writes (they are removed with the activity and recorded in the
  deletion log).
* A later **Change** in the Roster tab creates a new decision **without** the tag (5a2 supersedes with new ids), so undo refuses again for that
  athlete: a human judgment is never removable by the flow's tag. A test: J20 saves a state, the coach changes it in the Roster tab, undo →
  `roster_decisions_exist`.
* The origin is set **only server-side** by the J20 states route (a closed-set CHECK, default `'roster'`; the generic roster routes cannot send it), so a coach cannot tag their own decisions to make them removable. Undo and roster commands take the same team import lock, so undo-against-Change serialises; a concurrency test.
* The rule becomes: refuse if any decision, request, completion or log row exists whose request origin is not `session_review`, or whose decision
  supersedes or is superseded by one that is not (a later Roster-tab decision supersedes through the current pointer, so removing the tagged one
  would break the chain).
* **The origin is written only by a dedicated command bound to the approval of that activity by the same user**; the plain roster route ignores or
  refuses an origin in its body. A test proves that a tagged request through the plain route is refused or untagged, because otherwise any coach could make a
  deliberate decision undoable by a platform admin. The migration's actor guard names who may write the tag.
* b changes **nothing about who may undo** (an active platform admin, J19-U5). Option c, or a wider audience, are separate rights decisions.

**Recommendation: b**, as its own ★★ migration PR, after O1. Not implemented in J20-A/B/C. Until it exists, J20-C's confirmation says plainly:
"Saving attendance states means this session can no longer be undone from here." (true today for anyone who uses the Roster tab) and J20-C is **not
released before O1 is decided**.

## 6. The old screens

* The review **modal** is replaced by this screen when J20-A ships (the modal's code stays one release behind a switch, then is removed).
* The **Roster tab** stays: it is where states are changed after the fact, where the five states and the history live, and where a
  session imported by an earlier flow is handled. An imported row in Imports links to it ("Open roster").
* *Link athletes* (the whole-team screen) stays for bulk linking; U6a's group button *Link athletes* keeps pointing to it.

## 7. "Estimated" values (not built)

Phase 5b (a copy of the athlete's previous value or the team average, stored as an estimate with provenance) is a separate phase with its
own contract. J20 reserves the **row kind** and the column in this contract only; **no control is drawn** (a visible control with no effect
would read as broken, `.claude/rules/frontend.md`). When 5b is accepted, the "No device data" row gains a third action.

## 8. Agreement with U6a

* U6a's attention groups (`Athletes not linked`, `Needs a manual review`, `Problem in the GPEXE data`, `Needs a new search`) each have a button
  that opens the first session of the group; after J20-A that opens this screen instead of the modal. The group, not the screen, decides
  which session is "first".
* U6a's batch import (several clean *Ready* sessions at once, with progress and *Stop after this step*) stays: a clean session needs no
  per-athlete decision. Opening a ready session from U6a's list opens this screen for the one session.
* Before J20-A2 merges, the author confirms against U6a's head that the group buttons open the first session, the batch uses `previewHashes` for whole sessions only, and the modal's removal does not break the group button (not verified by the J20 review, which had no access to PR #408).
* "Next session" in this screen steps through the same group; a refused or unconfirmed import is shown here with the same *Result not
  confirmed · Check result* pattern.

## 9. Order, marks and gates

1. **J20-A1** (★★, trigger 4; backend, no migration): the recompute route of 5.0. Reviews: code, security; the *Nezavisni revizor*.
   **J20-A2** (★, frontend): the table, the filter chips, the folded group, linking from a row, the phone cards, the audience-dependent
   identification; the primary button still imports the **whole** session ("Leave out" is not offered yet). Reviews: code, ux, mobile,
   **security** (the screen surfaces identity data). Browser QA at 1280 / 390 / 375 / 360. A frontend test renders the row for a viewer without
   `identityAdmin` and expects no GPEXE name or date of birth in the HTML.
2. **J20-B** (★★, **with a migration**, trigger 1, 3 and 4) after O3 and its discovery proof: the approvals' new columns and trigger rule, `excludedAthleteIds` in the preview route and the approval; the screen's *Leave out* turned on. The owner's order naming the migration and the *Rukovodilac*'s preflight apply.
3. **J20-C** (★★, trigger 4: a retried second write after an irreversible import) after O1 and O2: the states step. Packet checklist: a route-level test "import succeeds, the bulk-states answer is lost, *Check result* with the same `requestKey` writes once". If O1 needs the undo change, it is a separate ★★ migration before J20-C ships.
4. U6b (the club-connection wizard) is independent and may go in any order.

Every part: the packet of `CLAUDE.md` (goal, acceptance, diff, tests with real counts); a part that touches a migration, the approval or
a roster write also needs the owner's order naming the migration and the *Rukovodilac*'s preflight (standing order).

## 10. Not in J20

Estimated values (5b); per-athlete undo (U5 Q5); editing a value; merging two tracks of one athlete (a GPEXE data matter); the club-connection
wizard (U6b); any change of what the import writes (mappings, units, variables).

## 11. Questions for the owner (one block, each with a recommendation)

* **O1 — Undo and roster decisions** (5.3): a, **b (recommended)**, or c. Needed before J20-C ships.
* **O2 — States in the same transaction or after it** (5.2): **A (recommended)** or B.
* **O3 — May the coach leave an athlete out of an import?** (5.1) Today a session is imported whole. Recommended yes; the left-out ids
  (no names) are stored on the approval record so the absence stays explainable (this is a decision, not a default: if the owner declines the
  record, it is a recorded choice). A left-out athlete is not importable until GPEXE's content changes. If the answer is no, J20-B disappears
  and the table only explains.
* **O4 — Who may import a subset:** the same people who may approve today (a platform admin, a team approver grant, and a club admin or team
  coach only while the team's switch is on in mode `team`, U2). The subset preview has the same audience. Recommended unchanged.
