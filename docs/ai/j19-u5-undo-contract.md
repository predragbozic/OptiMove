# J19-U5 — undoing a wrongly imported session in the app (sub-contract, ★★, migration)

Part of J19 (`docs/ai/gps-import-flow-contract.md`, section 3, U5, "condition 4" of the import-switch conditions). **Status: Proposed, documentation only; no code and no migration before the *Rukovodilac*'s GO and the owner's answers to section 8.** Verified against `origin/main` `003d1fab` by reading `docs/runbooks/gpexe-undo-imported-session.md`, `backend/scripts/gpexe-undo-imported-session.mjs` (v21) and the v13 / v20 / v23 / v25 triggers it names. No production read, no GPEXE request.

## 1. The problem and the goal

A coach or administrator can *Unlink* a wrongly linked GPEXE athlete, but unlinking never changes results that are already imported ("those can't be changed here - contact a platform administrator"). The only way back today is the undo CLI, which refuses every database that is not a disposable test one. Before regular production imports (condition 4) an **in-app, audited, authenticated** way to remove one imported session and import it again under the corrected link must exist.

## 2. Why the CLI cannot simply be put behind a route

| CLI behaviour (v21, runbook) | Why it does not carry over |
|---|---|
| `ALTER TABLE ... DISABLE TRIGGER` on the metric-value, binding and observation triggers inside the transaction | Takes `SHARE ROW EXCLUSIVE`, which every other team's import and preview waits on, in an order that can invert with theirs. Unacceptable on a live database. |
| An unbounded wait for the team import lock and the row locks | A route needs bounded waits and a stable "try again". |
| Lock order: team lock, admin check, then the event, **then** the session's source identities | The importer and the manual-correction path lock an identity **before** its event (the runbook says so); the order can invert. The in-app function must lock in one fixed, documented order. |
| The operator is named by `--performed-by-user-id`; nobody authenticates them | The route authenticates the person; the database function re-checks the right (the v35 / v56 actor pattern). |
| It refuses on any coach roster decision (`roster_decisions_exist`) | A wrong link will often have roster decisions on the session; a sanctioned step to clear them is needed (Q4). |

## 3. Options

- **A (recommended): a sanctioned database function** `training_load.undo_imported_session(...)` that removes exactly what the CLI removes, in the same fixed order, **without disabling any trigger**: the immutability triggers (v13 `metric_values`, v20 bindings, v25 observations) each gain one exception that is true only inside this function's transaction (a transaction-local marker equal to `txid_current()`, set by the function and checked by the trigger - the pattern of v35 / v56 - so a raw `DELETE` from anywhere else is still refused). The deletion log (v21) stays the record; its row is written by the function.
- **B (rejected): re-attribute the stored results to the corrected athlete.** It would change a historical fact (ADR-007); the source's own record said which GPEXE athlete the values belong to, and only the link was wrong.
- **C (status quo): keep the CLI and a maintenance window.** Safe, but not a coach/admin path, and the CLI cannot authenticate its operator.

## 4. Design of option A

**Who** (Q1): an active platform admin (as the CLI), and later the club's admin in the club workspace by a separate order; never a coach. Route `POST /api/training-load/gpexe/teams/:teamId/candidates/:candidateId/undo-import` (the imported candidate names its event); everyone else the identical 404; body `{ requestKey, reason, expected: { previewHash or eventId } }`.

**Two steps in the UI** (admin, on an imported session's review): (1) a **read-only scope** (`GET .../undo-preview`: counts per table and the refusals the function would raise, nothing written - the CLI's dry run), (2) the explicit confirmation naming the session, the team, the athletes whose results go and the consequence ("the session returns to Ready and is imported again under the current links"), with a mandatory reason.

**The function** (one transaction, bounded; `SECURITY DEFINER`, owned like the v35 / v56 functions):
1. Lock order, fixed and written into the function header: acting user row, role row (`FOR SHARE`), the team's import lock (bounded try-lock; `55P03` -> `try_again`), the candidate row, the event row `FOR UPDATE`, then **identities before events' dependants** in the importer's order, then the activity rows; the order is the importer's own, so it cannot invert with an import.
2. Re-check: the actor's right and basis; the candidate is `imported` and belongs to the team; the event is the one the approval wrote; the CLI's refusals (a manual occasion, a shared activity or another linked event, a merged / reparented / superseded activity, two events for one session, roster decisions unless cleared by Q4).
3. Set the marker; delete in the runbook's order 0-15; remove the by-products; write **one** `import_deletion_log` row (new `authorized_via` basis value is not needed for a platform admin; a club admin would add `club_admin`) and one request row (idempotency record, like `metric_variable_requests`); unset nothing (the marker is transaction-local).
4. The candidate: see Q3. The recommended end state is `superseded_by_undo` ... or a new pending candidate of the same content; the approval row (append-only, v23) stays as history.
5. COMMIT bounded 15 s; a lost answer is `outcome_unknown` with the request key (the F2 discipline); a replay answers the saved outcome.

**What does not change:** the removal order and scope of the runbook, the v21 log, the importer, Link / Unlink, the switch (U2). After an undo the coach finds sessions again; the changed link makes the session Ready; approval imports it as new data.

## 5. Tests (all on disposable databases; the T1 runner)

The CLI's two suites re-run against the function (`gpexe-undo-session`, `gpexe-undo-guards`); every refusal; the actor matrix (platform admin, club admin, coach, revoked, another club's admin) with the identical 404; the two-session races (an import of the same team while undoing, in both orders; a revocation while undoing; Unlink / Link meanwhile); a raw `DELETE` on each protected table still refused outside the function (the marker cannot be set by a session-level `SET`); the lock order proved by a concurrent importer; a lost COMMIT answer and a replay; the deletion log exactness; **mutations** of every guard and of each trigger exception; a restore rehearsal (the rollback script refuses once a log row from the function exists).

## 6. Rollout and rollback

Migration v57 (functions, the three trigger exceptions, the request table, the log basis if Q1 widens); rollback script that refuses once a request or log row of the new function exists; read-only production preflight and post-check scripts like v55 / v56. **Production use is gated** (J19 conditions): a fresh restore-verified backup of that environment (condition 1), the bounds of conditions 2 and 3 (the function is bounded by construction), and the roster-decision step (Q4). The first real undo is an owner-run procedure, never the main session.

## 7. Reviewers and marks

★★ by triggers 1, 3 and 4 (irreversible data change, canonical identity / materialization, transaction and lock order). `db-reviewer`, `security-reviewer`, `code-reviewer`; the *Nezavisni revizor*'s ★★; the owner's order naming the migration.

## 8. Questions for the owner (via the *Rukovodilac*)

- **Q1:** who may undo - a platform admin only (recommended for the first release) or also the club's admin?
- **Q2:** A (recommended) or C for now? (B is rejected by ADR-007.)
- **Q3:** after an undo, what happens to the candidate: a fresh pending candidate of the same content so *Find new sessions* shows the session as Ready again (recommended, the approval row stays as history), or a manual re-find?
- **Q4:** a session with coach roster decisions: refuse (as today), or let the function also remove them with the same log row (the coach's decisions on a wrongly attributed session are lost; recommended: refuse first, add the clearing as a second step after the first release)?
- **Q5:** scope - one session at a time (recommended) or all sessions of one athlete link?
- **Q6:** is the owner-run first production undo acceptable as the release gate, with the maintenance procedure of the runbook as the fallback?

## 9. The owner's decisions (2026-11-05, relayed by the *Rukovodilac*; status: Accepted)

The owner's words: "Može po preporuci mogu sva pitanja, a promene radi sve onaj koji ima mogućnost da pravi konekcije između sportista u finalnom izgledu. Mada čisto da znaš mi ćemo svakako malo urediti uloge korisnika i dodele ko šta može. Mi ćemo imati posebne uloge ali i mogućnost da admin platforme ili admin kluba nekom korisniku posebno štiklira dodatne mogućnosti šta sme da radi do nivoa koji on može da dodeli (znači do maksimalno nivoa šta on sme da radi)."

- **Q1:** the first version works for an active **platform admin** only (as recommended). The **final state**: whoever may make athlete links may undo an import (the same circle of rights as the link route). Widening to that circle is a second step, after the first production undo; it is its own order.
- **Q2:** option A, the sanctioned database function (B stays rejected by ADR-007; C is not chosen).
- **Q3:** after an undo the candidate comes back as a fresh pending candidate of the same content; the approval row stays as history.
- **Q4:** a session with coach roster decisions is refused first; clearing them is a second step after the first release.
- **Q5:** one session at a time.
- **Q6:** the first production undo is owner-run and is the release gate; the runbook's maintenance procedure stays the fallback.

Next: the code of U5 (migration v57, ★★ by triggers 1, 3 and 4), reviewed on a frozen head; the owner's order naming the migration and the *Rukovodilac*'s preflight come before its merge.

**Recorded as a future task (no code, its own contract later):** a roles and delegated permissions system. Special roles, plus the platform admin or a club admin may tick extra abilities for a user, only up to the level the granting admin holds. Q1's final state (who may undo) will follow that system.

## 10. As built (U5-1: migration v57 + backend; the screen is U5b)

Plan: `docs/ai/u5-undo-plan.md` (accepted by the *Rukovodilac* at its plan GO, with the answers of its section 7). Runbook and the three SQL files: `docs/runbooks/session-undo-v57*.{md,sql}`.

- **The function** `training_load.undo_imported_session(actor, team, candidate, requestKey, reason, expectedEvent)` (not `SECURITY DEFINER`, like v35 / v56) and its read-only `training_load.session_undo_scope(event)`. Lock order, written in the migration header and proved by test 26 and the races of tests 16-17: acting user row -> platform-admin role row (one statement each, `FOR SHARE`) -> the team's import lock (the importer's own advisory key) -> the request record (a replay answers here) -> the candidate -> the event -> its activities. Every lock is taken before the first write.
- **What it removes**: the CLI's list, in the CLI's order, without disabling a trigger. The four protections (v13 `metric_values_immutable`, v20 `metric_event_source_bindings_no_delete`, v25 `activity_source_observations_append_only`, v34 `metric_value_source_provenance_append_only`) are re-pointed at new functions that copy the originals' refusals and add one early return for a DELETE inside the function's transaction (marker `optimove.session_undo_tx` = `txid_current()`, off again when the function returns). The originals stay in place; the migration's md5 gate refuses to run over a changed original.
- **Refusals** (SQLSTATE 55000, `session_undo:<code>`; the route answers 409 with a sentence): the CLI's (`manual_occasion`, `shared_activity`, `other_event_link`, `entangled_activity`, `two_events_for_session`), `roster_decisions_exist` (Q4), **`calendar_link_exists`** (new since the CLI: `calendar.event_activity_links` restricts deleting the activity; the message tells the coach to remove the session from the calendar event), `manual_write_request_exists`, `referenced_elsewhere` (a foreign key the scope did not list; nothing removed), and the request-level codes.
- **The candidate**: stays `imported` (history; the approval row is untouched) and gets `import_undone_at` / `import_undone_request_id` (set together, once, only under the marker, only on an imported row; the guard `protect_gpexe_import_candidate_v57`). The unique key becomes partial (`where import_undone_at is null`). When the raw snapshot is still available and the check that last saw the candidate succeeded, the function writes a **fresh pending candidate of the same content in the same transaction** (30-day retention at most, the old sighting, no preview); the service recomputes its preview after the COMMIT (`previewReady` in the answer; a failure leaves it without a preview hash, so it cannot be approved, and the next search recomputes it). Otherwise (`offeredAgain: false`) the session waits for the next *Find new sessions*.
- **The importer's reads** treat an undone row as history: the check's staging and finalization ignore it (so the same content is "new" or refreshes the offered candidate, never duplicated), the list hides it unless `includeSuperseded`, and an approval by id or in a batch answers `import_undone`.
- **Routes** (platform admin only, the identical 404 otherwise, no-store): `GET /api/training-load/gpexe/teams/:teamId/candidates/:candidateId/undo-preview` (the same function in a transaction that is always rolled back) and `POST .../undo-import` `{ requestKey, reason, expected: { eventId } }`. The COMMIT is awaited at most 15 s; an unanswered one is `503 outcome_unknown` with `retrySameRequest`, and the same request returns the saved outcome.
- **Not in U5-1**: the screen (U5b), clearing roster decisions (Q4 step 2), the wider audience (Q1 step 2), per-athlete undo (Q5).

**Review delta (internal reviews of PR #390 at `3620dbd6`: `db-reviewer`, `security-reviewer`, `code-reviewer`, no BLOCKER or HIGH):**
- The function looks at the candidate **before** the team lock and refuses a candidate that is not imported (an approval locks the candidate and then waits for the team lock; the undo took them the other way round). An undone row passes on purpose, so its replay is still answered. The replay lookup is also scoped to the route's team (the security review's MEDIUM; the early look already refuses a foreign team, so the second condition is defence in depth).
- A fresh candidate is **not** offered when the team already has a live candidate of the same session with other content (a stale snapshot must not become approvable beside newer data). Runbook step for an administrator: search again before approving a re-offered session (it inherits its last sighting).
- The activity lock loops until the set found by the scope no longer grows (at most three rounds, then `try_again`).
- A COMMIT that fails without a PostgreSQL error answer (a dropped connection) is `503 outcome_unknown` with `retrySameRequest`, never a plain 500; an unexpected 42501 is logged before the identical 404.
- Runbook SQL: the md5 blocks fail when a function is missing; the transaction-local "no marker" block was removed (it could never show a leak). `.gitattributes` keeps the three SQL files on LF.
- For U5b: an undone row (`status: imported` with `importUndoneAt`) must be shown as history, never as Imported (a frontend test).
- Recorded survivors of the 41 mutations (equivalent): the imported-sighting filter on an undone row; the team scope of the replay lookup (the early look is the first line); the stable-set loop (the second look is unreachable without a concurrent link the team lock already prevents).

**Second delta (the *Nezavisni revizor*'s HIGH H1 at `0fe9a376`, the *Rukovodilac*'s decision):** one event per session (v20) means a session changed in GPEXE and approved again (acceptChanges) writes into the SAME event as its first approval. Removing the event removes both versions' data, so the undo works on the **whole event**: the input stays `candidateId`, the function finds the event from its approval, locks every candidate whose approval points at that event (by id, after the early look) and marks **all** of the imported, not-undone ones undone with the same request row (`undone_candidate_ids` names them; the scope / preview answer names them too). A fresh pending candidate is offered only for the NEWEST approved content among them, and under the same conditions as before. Undoing the older or the newer version ends in the same state (test 30). The deletion log keeps one row per event. The step-1b comment now states what really holds: a check's finalization also locks imported candidates but only try-locks the team. The preview takes the same locks as the undo (team lock, candidate, event, activities, up to the service's bounds) and is platform-admin only; a check of the same team can answer busy meanwhile.

## 11. U5b - the screen (frontend only, no migration, no backend change)

Over the U5-1 routes (PR #390, v57 on production). Files: `frontend/gpexe-undo-data.js`, `frontend/gpexe-undo-view.js`, the wiring in `gpexe-import-{data,view,actions}.js` and `training-load-actions.js`, the state slice `state.trainingLoad.gpexe.undo`, `frontend/styles.css`; tests `frontend/tests/gpexe-undo-u5b.actions.test.mjs`.

- **Who sees it:** only an active platform admin (the status's `viewer.isPlatformAdmin` and `identityAdmin`); the server decides again and answers the identical 404 to everyone else, which reads as "not available for an undo". Offered only on a review of an imported, not-undone session. A club admin and a coach see nothing (Q1: the circle widens later, as a separate order).
- **Two steps:** *Undo this import...* reads the scope (`GET .../undo-preview`, read-only; it takes the function's real locks, so it is platform-admin only and a check of the same team can answer busy meanwhile). The scope names what goes in coach words (athletes' records, imported values, drills, activities, records in all), **every approved version of the session that goes with it** ("approved N times ... all N versions are undone together"; they share one event) and whether the session is offered again. Then the mandatory reason (1-500 characters, no control characters, checked before the question) and the explicit question naming the session; then one `POST .../undo-import` with `requestKey`, the trimmed `reason` and `expected.eventId` from the scope.
- **Three outcomes, like an approval:** undone (the answer: what was removed, a button to open the offered session, "its review is not ready yet" when `previewReady` is false, "answer saved for the same request" on a replay); **not undone** (a coded refusal: "Nothing was removed." with the server's sentence, the roster-work or calendar-event counts it carries, the code under Technical details; the key is dropped and a new attempt gets a new key); **not confirmed** (no answer, a gateway error, `503 outcome_unknown`, an uncoded 5xx, the 60 s client bound: "We can't tell yet whether the import was undone", never "nothing was removed"; the key is kept and *Check the result* sends the SAME request, which the server answers from its saved record). `409 already_undone` / `candidate_not_imported` on the request are settled, not errors: the review is read again.
- **After an undo** the review and the list are read again: the session is history, the fresh pending candidate (when offered) is listed.
- **An undone row is history, never "Imported":** `status: imported` with `importUndoneAt` is group `undone`, bucket `hidden` (so never counted under Imported, never in the batch, not in the sessions calendar); it is listed only under the existing "Show replaced or no longer found versions" toggle, with the badge *Import undone*; its review says "This import was undone" and "Was imported <date>", offers no approval and no undo; the setup guide does not count it as an imported session. The server's blocker `import_undone` and refusal `import_undone` read as sentences.
- **Protection:** while the request runs the review cannot be closed and the team cannot be changed; a not-confirmed result keeps its state across closing and reopening the review (and blocks a team change); leaving Training Load and `beforeunload` ask over both states.
- **Evidence:** 13 frontend tests with 10 mutations (9 killed; the survivor, dropping the key when a refusal settles, is equivalent: a refused attempt cannot be resent, a new attempt builds a new state with no key); the frontend-fast preset fails only in the seven known files with the same per-file counts as a clean `origin/main`; production build; browser check on the real modules' HTML at 360, 375, 390 and 1280 px (no overflow, buttons 44 px, the reason field 16 px).
- **Not built:** per-athlete undo (Q5), the wider audience (Q1 step 2), a bulk undo, the undo in the batch screen.
