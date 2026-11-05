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
