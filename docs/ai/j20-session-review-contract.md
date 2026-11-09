# J20 — Session review: one table for the whole decision about one GPEXE session

Status: **Proposed** (docs only; no code, no migration). Written on the *Rukovodilac*'s order of 2026-11-09 after the owner accepted
the direction of the "Session Review Table" sketch (https://claude.ai/artifact/LxSceTeB6kxiRtXLJkprP5; the flow sketch
https://claude.ai/artifact/V1DNskt8hNpNGPKGzXcpT7). Base: `origin/main` `bbd5b450`. Parts: **J20-A** the screen over what exists,
**J20-B** the subset import (★★), **J20-C** the roster states in the same flow. The open owner questions are in section 9.

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
| A link change changes the preview and its hash; the screen already treats a review made before a link change as stale (`reviewMadeBeforeLinkChange`) | `frontend/gpexe-import-data.js` |
| Roster decisions (*Participated · no device data*, *Did not participate* with a reason) are written by the 5a2 routes, one athlete or a bulk of up to 60, idempotent by `requestKey`, on an activity that already exists | `docs/ai/phase5a-discovery-and-contract.md`, `activity-roster-*` |
| The in-app undo of an imported session (v57, U5) refuses a session with any roster decision (`roster_decisions_exist`) | `docs/ai/j19-u5-undo-contract.md` Q4 |
| Linking one GPEXE athlete: `POST …/athlete-links` `{ gpexeAthleteId, athleteId }`; U3 suggests pairs and U3's *Confirm all* links several | existing routes |

## 3. The screen (J20-A, frontend only, ★)

**Header:** the session (type, date and time), the team, one summary sentence ("15 of 22 athletes have data · 4 need a person"), the
state of the import switch in the coach's words. **Filter chips:** *Needs a person* (default when any), *Not linked*, *No data*,
*Conflict*, *All*. Counts on the chips.

**Rows (one per team athlete plus one per GPEXE athlete that is not yet matched).** Columns: athlete (OptiMove name; a not-linked
GPEXE athlete is shown by its GPEXE name and, for an administrator, its date of birth, as in *Link athletes*), the values (Duration,
Total distance, Maximal running speed — the variables the team's mappings fill — each with the GPEXE value in small type), and a status
chip. Order: needs-a-person rows first (not linked, then conflict, then no data), then the rows that are fine, which are folded under
"N athletes are fine" and open on a tap.

| Row kind | What the row shows | The one action on the row |
|---|---|---|
| Fine | values, chip "Will be imported" | *Leave out* (checkbox "Import" off) |
| Not linked (a GPEXE athlete) | GPEXE name, values, chip "Not linked" | *Link to…*: a chooser of the team's active athletes not yet linked (existing rules: same-name athletes cannot be chosen, nothing preselected, U3's suggestion first); *Leave out* |
| No device data (a team athlete GPEXE did not record) | no values, chip "No data from the device" | *Participated · no device data* or *Did not participate* (+ reason list) — these are **states**, written after the import (section 5) |
| Conflict (more than one track, mixed time zones for one athlete, a value the mapping refuses) | what is wrong in one sentence | *Leave out* only (the cause is GPEXE data; the coach cannot fix it here) |

**Primary action** at the bottom (sticky on a phone): **Import N athletes** — N counts the rows with "Import" on and values.
Below it, when states were chosen: "and save M attendance states". One confirmation names the counts, not every athlete (the list is on
the screen). A session in which nobody can be imported keeps the button off and says why.

**Phones (360–390 px):** cards instead of a table; chips scroll horizontally; the folded "fine" group is one card; one sticky primary action;
every control 44 px, every input 16 px; the roster's bottom-sheet pattern for the state choice. **Language:** coach words; ids, codes and
fingerprints only in an administrator's Technical details.

## 4. Linking from a row (J20-A)

The row's *Link to…* uses the existing link route for one pair. A link changes the preview, so after it the screen **re-reads the
candidate** (the server recomputes preview and hash), keeps the coach's other row choices keyed by GPEXE athlete id, and shows the row in
its new kind. The row's choices are never carried across a hash they were not made against: the primary action always sends the hash of
the screen's latest read. A lost link answer is *Result not confirmed* with *Check result* (same key), as everywhere else in Imports.

## 5. The server side

### 5.1 Importing a subset (J20-B, ★★: triggers 3 and 4; no migration expected, to be confirmed by the discovery)

* The preview and the approval take an optional `excludedAthleteIds` (GPEXE athlete ids, canonical, at most the candidate's own athletes, at most 60).
  An excluded athlete is treated as `notImported` with the code `left_out_by_coach`; nothing of it is written.
* **The hash covers the exclusions.** Because the approval requires the hash of the preview the coach reviewed, the screen needs the
  preview *for its chosen set*: a read-only route `POST …/candidates/:id/preview` `{ excludedAthleteIds }` runs the same rolled-back
  preview as the check does and returns the preview and its hash (nothing stored, no write). `approveCandidate` takes the same set and
  the hash, recomputes with the set in the same transaction and refuses with `409 preview_changed` when the hashes differ. A request with
  the same set and the same hash is idempotent by the existing rules. Excluding everyone is refused (`no_importable_athlete`, existing).
* **What stays true:** the candidate becomes `imported` as a whole; the left-out athletes are simply not in the written results. Whether the
  left-out athletes can be imported later through a new candidate version is to be **verified in the discovery** against the writer's
  athlete-level identities and `supplemented` path (an "athlete imported earlier and now left out blocks the session" rule exists for
  the opposite case); J20 does not assume it.
* Reviews: `db-reviewer`, `security-reviewer`, `code-reviewer`; external review (triggers 3 and 4); the packet includes a test that the same
  candidate with two different exclusion sets produces two different hashes and that each approval imports exactly its set.

### 5.2 Attendance states in the same flow (J20-C) — options

Roster states are decisions on an **activity**, which exists only after the import. Two ways to make "import and states" one action:

| | **A. Two steps behind one button** (recommended) | **B. One transaction** |
|---|---|---|
| How | The screen imports (5.1), then sends the roster commands for the chosen states (the existing bulk route, up to 60 athletes, one `requestKey` per group), each idempotent; the result panel says "Imported 15 · 5 states saved" | The approval takes a list of states and writes them in the import's transaction |
| Pros | No new write path; the roster's own checks, locks, concurrency and idempotency stay the only place the rules live; the import (the expensive, irreversible part) is never held up by a state; small, reviewable change | Atomic: nothing half done; one request |
| Cons | Not atomic: the import can succeed and the states fail or be unconfirmed ("Imported 15 · states not saved yet · *Save them again*"); two result stories to explain | A new cross-subsystem write (import lock, then the roster decider locks, v26), a new hash input, a migration or a wider function, and a harder undo story (5.3); ★★ with a larger surface |
| Failure story | The import stands; the states are retried from the same screen (or later in the Roster tab); never lost silently | All or nothing |

**Recommendation: A.** The states are small, reversible, and already have a correct write path; the import is the only irreversible act
and should not wait for them. If the first months show friction (states often failing), B is a later change, not a rework. **Decision
for the owner: section 9, O2.**

### 5.3 The undo (U5) and roster decisions — the open question

U5 refuses a session that has any coach roster decision (`roster_decisions_exist`). With J20 almost every freshly imported session will
carry decisions the flow itself wrote, so the undo of a wrongly linked athlete's session would be refused at once and the coach would
be stuck. Options:

| | What | For | Against |
|---|---|---|---|
| **a. Keep the refusal** | undo stays refused | simplest; a decision is a human judgment, never deleted silently | the coach has no in-app way out; contradicts U5's purpose |
| **b. Undo clears the decisions that J20's flow wrote** | decisions are tagged with their origin (the request's source `session_review`); undo removes exactly those, listing them in the confirmation ("5 attendance states set at import will be removed") and in the deletion log; decisions made later in the Roster tab still refuse | removes the dead end for the common case; keeps later human judgments safe; the log shows what was removed | a small migration (origin tag, the function's rule, the log's columns), ★★ |
| **c. Undo clears every roster decision of the session** | with the list and the log | no dead end at all | deletes judgments a coach made after seeing the session |

**Recommendation: b.** It fixes the dead end J20 itself creates and leaves later, deliberate decisions protected; c can follow if b proves too narrow.
Not implemented in J20-A/B/C; it needs the owner's choice (O1) and its own ★★ migration. Until it exists, J20-C's confirmation says
plainly: "Saving attendance states means this session can no longer be undone from here." — and J20-C is **not released before O1 is decided**.

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
* "Next session" in this screen steps through the same group; a refused or unconfirmed import is shown here with the same *Result not
  confirmed · Check result* pattern.

## 9. Open questions for the owner

* **O1 — Undo and roster decisions** (5.3): a, **b (recommended)**, or c. Needed before J20-C ships.
* **O2 — States in the same transaction or after it** (5.2): **A (recommended)** or B.
* **O3 — May the coach leave an athlete out of an import?** (5.1) Today a session is imported whole. Recommended yes, with a one-line reason
  shown in the confirmation (not stored beyond the approval record's counts). If the answer is no, J20-B disappears and the table only
  explains.
* **O4 — Who may import a subset:** the same people who may approve today (platform admin, team approver grant, club admin / team coach
  where U2 allows it). Recommended unchanged.

## 10. Order, marks and gates

1. **J20-A** (frontend only, ★): the table, the filter chips, the folded group, linking from a row, the phone cards, over the existing
   routes; the primary button still imports the **whole** session (rows are shown, "Leave out" is not offered yet). Reviews: code,
   ux, mobile. Browser QA at 1280 / 390 / 375 / 360.
2. **J20-B** (★★) after O3: `excludedAthleteIds` in the preview route and the approval; the screen's *Leave out* turned on.
3. **J20-C** (★) after O1 and O2: the states step. If O1 needs the undo change, it is a separate ★★ migration before J20-C ships.
4. U6b (the club-connection wizard) is independent and may go in any order.

Every part: the packet of `CLAUDE.md` (goal, acceptance, diff, tests with real counts); a part that touches a migration, the approval or
a roster write also needs the owner's order naming the migration and the *Rukovodilac*'s preflight (standing order).

## 11. Not in J20

Estimated values (5b); per-athlete undo (U5 Q5); editing a value; merging two tracks of one athlete (a GPEXE data matter); the club-connection
wizard (U6b); any change of what the import writes (mappings, units, variables).
