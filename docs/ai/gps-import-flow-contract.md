# J19 — the GPS import flow: from "Find new sessions" to a normal weekly routine (parts U1–U5)

| | |
|---|---|
| Status | **Proposed** by the executor on 2026-11-04, on the *Rukovodilac*'s order of that day (documentation only). Code for U1 starts only after the *Rukovodilac*'s GO on this contract. |
| Verified against | `origin/main` at the time of writing, which carries PR #359 (v54) and PR #360; PR #361 (O7, v55) is open and changes none of the files this document cites. The production database was not read. Facts about production are quoted from `docs/ai/CURRENT_STATE.md`. |
| Mark | **★★ as a whole**; each part below has its own mark. The triggers of `CLAUDE.md` that apply are 1 (migration), 2 (auth and roles), 3 (links and identity) and 4 (transactions and idempotency). |
| Decides | The owner decided the plan and D2–D6 on 2026-11-04 (section 1). The *Rukovodilac* decides R1–R5 (section 6). The *Nezavisni revizor* reviews every ★★ part. |
| Related | Phase 9 (J17, the importer reads mappings), J18 (mapping by drag and drop, **later**), J14 (a club admin's own mappings), `docs/runbooks/gpexe-in-app-import.md`, `docs/ai/CURRENT_STATE.md` "In-app GPEXE import — conditions before the switch is turned on". |

---

## 0. In short

The import works end to end for an administrator who knows the steps (connect, bind, check, link, approve), one batch of at most 10 sessions at a time, with the apply switch off in every environment. J19 turns it into a routine a club admin and a team coach can run alone: one daily screen, an import switch per team with an honest list of conditions, suggested athlete pairs, a five-step guide, and a way to correct a wrongly linked athlete inside the app.

Order: **U1 → U2 → U3 → U4 → U5**. Later, outside this contract: sets, the nightly check and J18.

The import switch (`GPEXE_IMPORT_APPLY_ENABLED`) stays off, and no check or import is run, until the owner orders the pilot. Every part below is code and documents; none of them sends a GPEXE request by itself.

---

## 1. The owner's decisions (2026-11-04)

The words were relayed by the *Rukovodilac* and are recorded here as written.

> „Slažemo se sa planom u1-u5. Admin kluba bi trebao da odobrava par „OptiMove tim ↔ GPEXE tim" za timove koje vidi njegov klub. Posle pilota uvoz radi i admin kluba ali i trener tima jer trener tima će raditi sa tim sportistima. 5. može po preporuci. 6. Po preporuci"

| # | Decision | Effect |
|---|---|---|
| **D2** | The pair "OptiMove team ↔ GPEXE team" is approved by the **club admin**, for the teams the GPEXE account of **their club** can see. Today only a platform admin does (`PUT …/settings`, `routes/gpexeImport.js:134`). | Touches authorization and workspace: `security-reviewer` is mandatory. Part U2. |
| **D3** | **During the pilot** the platform admin turns the import on. **After the pilot** the club admin and the team coach import. The *Rukovodilac*'s reading, until the owner says otherwise: the per-team switch is still turned on by the club admin, and the coach imports (approves sessions) for their own team. | Part U2 (R1). |
| **D5** | Up to **50 sessions** with one confirmation (today `BATCH_APPROVE_MAX` is 10). | Part U1; the time budget is part of its tests (section 3). |
| **D6** | The evidence for regular imports is the **Supabase daily backup, shown as a date**, plus a **restore probe once a month**. | Part U2 (R3). |
| **Gate** | The legal basis for names and dates of birth (and for minors) was open before U3. **Closed by C123** (section 5): "nemamo maloletnih i ne brini o dozvolama". If a minor athlete is ever added, the question opens again. | Part U3 may start. |

---

## 2. What exists today (verified in code)

| Fact | Where |
|---|---|
| The GPEXE routes of a team: `status`, `settings` (PUT, platform admin only), `settings/history`, `checks` (POST) and `checks/:id`, `candidates` and `candidates/:id`, `candidates/:id/approve`, `imports` (batch), `approvals/:id`, `source-athletes`, `athlete-identities` (GET, POST `loads`), `athlete-links` (GET, POST, `…/unlink`), `approvers` (GET, POST, revoke), `retention`. | `backend/src/routes/gpexeImport.js:113-363` |
| Who may review and check: the team's coach, its club admin, a platform admin, in a workspace that contains the team; anything else is the same 404. | `gpexeImportAccess.js` (`resolveGpexeTeamAccess`) |
| Who may approve an import: an active platform admin, or a team coach holding an **explicit approver grant** that a platform admin gave. The approval re-checks it in its transaction (v23). | `gpexeImportAccess.js:39-55`, v22 `gpexe_import_approvers`, v23 |
| The import switch is the environment variable; `409 import_switch_off` before any write. A check never reads it. | `gpexeImportService.js:46, :2292` |
| A batch approves up to `BATCH_APPROVE_MAX` candidates one after another, each in its own transaction (several atomic approvals, not all-or-nothing). The client's lost-answer path is "Result not confirmed" + *Check result*. | `gpexeImportService.js:2537-2575` |
| Imports shows buckets *Needs attention*, *Ready to import*, *Stays out*, *Imported*; a check shows only "running" while it runs. | `frontend/gpexe-import-view.js`, PR #115 |
| `pollGpexeCheck`: one failed poll sets `gx.check = null` and `lastCheck = null`, so the screen forgets a check that is still running. | `frontend/gpexe-import-data.js:267-290` |
| GPEXE names and dates of birth: an administrator-only 14-day snapshot (v32), loaded explicitly; a coach sees none. Link athletes shows the name and the id masking of PR #145. | `gpexeAthleteIdentityService.js`, PR #144/#145 |
| A wrongly linked athlete: *Unlink* ends the link and never changes imported results; the only path is the CLI undo, limited to disposable databases. | `docs/runbooks/gpexe-undo-imported-session.md` |
| The pair "OptiMove team ↔ GPEXE Team ID" is the `gpexe_team_settings` row; v30 makes it final while a binding is active; a bind may only bind that exact approved pair. | v24, v30, `sourceConnectionService.js` |
| Source connection routes (Connect, Test, Bind, Unbind) work for a platform admin and the owning club's admin; Test returns the club admin's intersection of visible GPEXE teams with approved pairs. | `routes/sourceConnections.js`, F3c2e |

---

## 3. The parts

### U1 — the daily screen (★, no migration)

**Goal.** A coach or admin opens Imports and sees what to do in one glance: a progress bar while a check runs, two counts (*Ready* and *Needs you*), and one button *Import N ready*.

| | |
|---|---|
| Existing routes | `status`, `checks` (POST, GET), `candidates`, `imports` (batch). |
| New | (a) A progress bar for a running check from the check row's own report (phase, sessions done); if `GET …/checks/:id` does not expose it today, an **additive field** on that read, with no table or migration. (b) *Ready / Needs you* in place of four buckets on the first view; the buckets stay one click away. (c) *Import N ready* = the existing batch, with `BATCH_APPROVE_MAX` raised from 10 to **50** (D5). (d) **The poll fix:** one failed poll keeps the last known check and retries a bounded number of times with a visible "could not refresh" note; it never clears a running check. |
| D5 risk | Fifty sequential approvals take longer than ten. The tests measure a 50-session batch on a disposable database and the P0 timing line, and the response path must stay below the client's bound; a batch that cannot finish in time answers with the sessions done so far and the rest left pending (never a hidden partial). Decided in U1's own plan before code. |
| Migration | No. |
| Reviewers | `code-reviewer`; `mobile-qa` and `ux-design-reviewer` (screen); `security-reviewer` only if the route's field list changes the audience. |
| ★★ | No, unless the batch path changes a transaction or lock (then trigger 4 applies and it becomes ★★). |
| Tests | Frontend actions through the real handlers (poll failure, progress, batch of 50, lost answer); backend batch limit and a 50-candidate integration on a disposable database. |

### U2 — the import switch per team, the conditions list, the club admin's pair (★★, migration)

**Goal.** The environment switch becomes the global master; each team gets its own switch with a visible list of conditions that must hold; the pair is approved by the club admin (D2); after the pilot the team coach may approve sessions of their team (D3).

| | |
|---|---|
| Existing routes | `status`, `settings` (PUT), `settings/history`, `approvers`, `imports`, `candidates/:id/approve`, source-connection `Test` (the club's visible teams). |
| New | (a) **Pair approval by the club admin (D2),** as U2a: `PUT …/settings` also accepts the active admin of the team's club, in that club's workspace, only for a team of the club and only for a GPEXE team in the club connection's server-side intersection (`sourceTeams`); the audit row names the basis. (b) **A per-team switch** (new table, append-only history, who/when/why): approval requires the environment switch **and** the team's switch. Turning on is refused with the failing condition named. (c) **The conditions list,** each shown with its state and, where it is a fact the app cannot read, who recorded it: 1 backup evidence (D6, R3); 2 bounded lock waits before COMMIT; 3 the undo takes the team lock; 4 the wrong-link procedure (U5); 5 an archived team's running check (built into U2, see below); 6 and 7 are built and deployed (PR #153). (d) **Who approves:** during the pilot a platform admin; after it the club admin and the team coach (D3, R1). The coach's right becomes a default of the team's switch, replacing the explicit per-coach grant; the grant stays as an additional path. The approval trigger of v23 re-checks the new basis. |
| Condition 5 | A check already running when its team is archived still completes and writes candidates (`CURRENT_STATE` condition 5). U2 re-resolves the team and club before each source operation of the run (the resolver already re-validates the binding) and stops the run as `team_not_available`. |
| Migration | **Yes** (v56 or the next free number at merge): the switch table and its history, the conditions record for facts entered by an admin, the approval trigger's new basis. Rollback, preflight, post-check, runbook. |
| Reviewers | `db-reviewer`, `security-reviewer`, `code-reviewer`. |
| ★★ | **Yes** (triggers 1, 2, 4): both GOs, the owner's order naming the migration, the preflight, the owner's deploy. U2a (the pair by the club admin, no migration) may ship first as its own ★★ PR (trigger 2). |
| Lock order | Team import lock → team row → club row FOR SHARE, as in the approval (J17 step 2a, R16); the switch write takes the team lock; no new order. Written out in U2's plan before code. |
| Tests | Role matrix (platform admin, club admin of the club, of another club, coach, athlete, revoked role, archived team/club) for the pair, the switch and the approval; cross-club info-hiding; the conditions list refuses with the right condition; a run stopped by an archive; mutations on every guard. |

### U3 — suggested athlete pairs, "Confirm all" (★★, no migration)

**Goal.** Link athletes proposes pairs by name and date of birth and links them in one confirmation.

| | |
|---|---|
| Existing routes | `source-athletes`, `athlete-identities` (GET and the explicit load), `athlete-links` (GET, POST, unlink). |
| New | The server computes the suggestions: an unlinked GPEXE athlete with a stored identity and one OptiMove team athlete with the same normalized name and the same date of birth (both present, a single match). A duplicate name or a date conflict is shown, never auto-linked. *Confirm all* sends the pairs through the existing link route one by one under one confirmation with one result per pair (the Phase 3b pattern); nothing is preselected for an unclear pair. |
| Who sees the data | Today identity data is for the platform admin and the club admin. After the pilot a coach works with these athletes (D3). Decided (R2, amended by the owner on 2026-11-04, see section 5): the coach sees the **pair, the GPEXE name and the date of birth**, because the date helps pairing; the explicit identity load stays an administrator's act. The v32 audience for the load and the 14-day snapshot are unchanged; U3 adds a read of the stored snapshot for the coach of the team, which makes it ★★ (trigger 2). |
| Migration | No (v32 is reused). |
| Reviewers | `code-reviewer`; `security-reviewer` (identity audience, trigger 2/3); `ux-design-reviewer`. |
| Gate | Closed by C123 (section 5). |

### U4 — the five-step guide and "Use OptiMove variables" (★, no migration)

**Goal.** A first-time admin follows five steps: connect the account, approve and bind the pair, find sessions, link athletes, import. A button **Use OptiMove variables** switches on the system mappings for the team's binding.

| | |
|---|---|
| Existing routes | The source-connection routes; `checks`; `athlete-links`; the mapping activation routes of phase 7d/7h (`POST /api/training-load/sources/metrics/…activations`), the Mappings screen (phase 8). |
| New | A step list over existing screens with each step's state read from existing reads. The button runs the existing activation for the system mappings, in order, each with its own request key, and stops at the first refusal with its sentence. J18's board (C121's one-click switch-on) is a later, better version of the same button; U4 does not wait for it. |
| Migration | No. |
| Reviewers | `code-reviewer`, `ux-design-reviewer`, `mobile-qa`. |
| Note | If J18 is built later its T9 gate changes who may activate a field without parameters (J18 section 5.5, C124); U4's button is re-pointed to the board then. |

### U5 — correcting a wrongly linked athlete in the app (★★, migration) — condition 4

**Goal.** The coach or admin who linked the wrong GPEXE athlete can correct it without a database operator.

| | |
|---|---|
| Existing | *Unlink* ends the link only; the undo CLI (`gpexe-undo-imported-session.mjs`, v21 deletion log) removes one imported session on disposable databases. |
| New | An in-app, audited correction of **one imported session** (or of the sessions of one athlete link), by a sanctioned database function with a reason, a deletion log row, the team import lock, and the same refusals as the CLI (manual correction, shared or merged activity, two events for one session). Afterwards the session returns to *Ready* and is imported again under the corrected link. |
| Why a sub-contract | It deletes imported results, an irreversible operation. Its shape (undo and re-import versus re-attribute) is chosen in a sub-contract, **J19-U5**, before any code. Recommendation: undo and re-import through the CLI's sanctioned path, because re-attributing a stored result would change a historical fact (ADR-007). |
| Migration | **Yes** (the function, its actor guard, the log's new basis). |
| Reviewers | `db-reviewer`, `security-reviewer`, `code-reviewer`. |
| ★★ | **Yes** (triggers 1, 3, 4). External review packet required. |

---

## 4. Order, marks and gates

| Part | Mark | Migration | Needs before code |
|---|---|---|---|
| **U1** | ★ (★★ if it changes the batch transaction) | no | The *Rukovodilac*'s GO on this contract |
| **U2a** (pair by the club admin) | ★★ | no | U1 may run in parallel; security review |
| **U2** | ★★ | yes | The owner's order naming the migration at merge; R1, R3 decided |
| **U3** | ★★ (trigger 2: a coach reads the identity snapshot) | no | R2 decided (done) |
| **U4** | ★ | no | U2 deployed (the switch must be settable) |
| **U5** | ★★ | yes | J19-U5 accepted |

The standing orders apply: a PR without a migration is merged after the *Rukovodilac*'s GO; a PR with a migration needs the owner's order naming it. No part runs a check or an import; the pilot is a separate order.

---

## 5. Decision records written with this contract

C113–C125 (the owner's answers to J18's Q1–Q14, 2026-11-04) are recorded in section C of `docs/ai/gpexe-metric-variable-mapping-discovery.md`. Two of them touch J19:

- **C123:** names, dates of birth and the evidence values need no legal basis, minors are not in the product, and the gate before U3 is closed. The condition is recorded: adding a minor athlete reopens it. The owner repeated it on 2026-11-04: „ne treba pravni osnov, oni su članovi kluba i već se znaju njihovi podaci, a trenutno mi nikoga maloletnog nemamo”.
- **C121 and the new request:** the admin makes the mapping and may change it while no value is written under it (the J18 delta in the discovery document). It is J18's, not J19's, and is decided before J18 code.

---

## 6. For the *Rukovodilac*

- **R1.** D3 as read in section 1: the per-team switch is turned on by the club admin (the platform admin during the pilot) and the coach approves sessions. If the owner means the coach also turns the switch on, U2's rights change.
- **R2 (amended 2026-11-04).** The coach of the team sees a suggested pair, the GPEXE name **and the date of birth**; the identity load stays an administrator's act.
- **R3.** D6's evidence. The app cannot read the Supabase backup, so "shown as a date" means an administrator records the date of the last daily backup and the date of the last restore probe, with who recorded it, in an append-only table; the switch refuses when the backup date is older than N days (recommendation: 2) or the restore probe is older than 35 days. N is a decision.
- **R4.** U5's shape (section 3): undo and re-import, through its own sub-contract.
- **R5.** D5's 50: confirm a response that returns the sessions done so far when the time bound is reached, instead of a hard failure.

---

## 7. As built

### U1 — the daily screen (PR #364, merge `76af5f52`, 2026-11-04, deployed by the *Rukovodilac*; no migration, the import switch untouched)

- As designed in section 3, with these decisions on the way: the bar is indeterminate (the check row carries only counts; the total is unknown until the end); a failed poll retries 3 more times, then stops without clearing the check, shows a note and a **Refresh status** button that reads the status again and never starts a search; the retry allowance is reset on every start of the poll loop; the daily line counts the whole list and says "(all dates)" under a day filter; a ready session that cannot be chosen is named under the button; review-only shows its reason under the counts.
- **D5 / R5 numbers:** `BATCH_APPROVE_MAX` 50; server time budget **45 s** (checked before each candidate except the first; the rest are `not_attempted` with code `batch_time_budget`); one approval's COMMIT wait 15 s; client bound **90 s** (new `AbortSignal` on the batch POST; an abort is "Result not confirmed"); hosting proxy 100 s. A test asserts 45 + 15 < 90 < 100. A real 50-session batch was **not** timed.
- Reviews: `code-reviewer` READY WITH NON-BLOCKING NOTES, `ux-design-reviewer` READY, `mobile-qa` no finding above LOW. Not done: "Needs you" as a link.
- Tests on the PR: backend `gpexe-batch-approve` 17/17; frontend `gpexe-import.actions` 80, `gpexe-imports-batch.actions` 30, `gpexe-imports-id-masking.actions` 17, `gpexe-imports-v33.actions` 11, `source-connections.actions` 26; frontend build; `gpexe` preset 52 of 54 files.
- Baseline failures seen in the same runs, reproduced identically on a clean main (frontend code of `0022f579`): `gpexe-client` and `gpexe-rest-v1-adapter-reads` (backend) and, in the frontend `frontend-fast` preset, `builder-performance-fixes` (2), `exercise-editor-thumbnail` (4), `exercise-media-thumbnail` (8), `exercise-ownership` (1), `exercise-personalization` (1), `training-load.actions` (2, the known X5a/X5b hang), with the counts and the commit in `CURRENT_STATE.md`. Recorded in `CURRENT_STATE.md`, "Known baseline/environment test issues".
- Deploy (the *Rukovodilac*, Render API, commit `76af5f52`, HTTP 201): `/api/health` briefly served the old commit during the swap, then `76af5f52` with `ok: true` four times in a row (to 13:07:59 UTC); without a login `/api/auth/me` 200 and the GPEXE team status (zero UUID) 401.

### U6a-3 — the batch series (the pull request that adds this section; frontend only, no route or migration; ★★-lite, trigger 4: a client retry)

- **What changes for the person:** one click on *Import N ready* may now send several `POST …/imports` requests in a row. After the server's 45 s budget (`not_attempted` / `batch_time_budget`), the screen sends the next round itself with **exactly** the sessions the server did not try, with the hashes they were chosen with. A progress block with *Stop after this step* stays in sight.
- **When the series ends:**
  - every session is decided;
  - a refusal needs a person (anything but `try_again` / `internal_error`);
  - a result is not confirmed (`import_outcome_unknown`, or a lost answer: "Import result not confirmed", the existing *Check again*);
  - a round decides nothing;
  - *Stop*;
  - the person is no longer on this team's Imports screen: another Training Load section, another part of the app, another
    team or workspace. This is read from the state itself, after every answer and again before every further request. A
    leave question answered yes, after which the person stays, does not stop the import;
  - `BATCH_MAX_ROUNDS` (30) requests.

  What is left stays ticked and says why it was not imported: the person stopped the import, left Imports, the 30-round
  limit, or time ran out. A team change is refused while the import runs.
- **What never happens:**
  - a session with a final answer (imported, `already_imported`, refused) is never in a later round;
  - an answer for a session the request did not send counts for nothing;
  - a whole request refused after earlier rounds wrote says "nothing was imported": the dialog says the import stopped
    before the rest, and which sessions are in OptiMove;
  - `already_imported` counts as imported and does not stop the series;
  - the summary is counted from each session's final result.
- **Server unchanged:** every round is the existing batch route, each approval idempotent by its candidate (`already_imported`), the 90 s client bound per request.
- **The screen:**
  - while the import runs: "Importing sessions", the rows not reached yet "Waiting: it will be imported automatically.",
    Done off;
  - the progress block ("N of M sessions handled - K imported so far", *Stop after the current sessions*) sits between
    the dialog's head and its scrolling list;
  - after a lost answer, the sessions answered earlier stay listed.
- **Source:** item 8 of PR #408.
- **Tests:**
  - `frontend/tests/gpexe-batch-series-u6a3.actions.test.mjs`;
  - e2e scenario 13 (`e2e/tests/imports-batch-series.test.mjs`): the real route with the server's budget set to 0 in
    the e2e server process (`E2E_BATCH_BUDGET_MS`, `e2e/lib/fake-source-preload.mjs`), three Ready sessions in three
    rounds, three approvals.

### U6a-2 — the daily screen closer to the proposal (the pull request that adds this section; frontend only, no route or migration)

The *Rukovodilac* accepted the alignment table of the "GPS Import Flow" proposal against main `05c08284` on 2026-11-11. U6a-2 takes the rows of that table that need no server change: D2–D8, with D5 without its counts. The rows that need a backend (D1, the D3 total "of M", the D5 counts, S2, S3) and the setup stepper (U6b) are separate pull requests.

- **The sessions that need a person, grouped** (`frontend/gpexe-attention-groups.js`, after PR #408), under the heading *Needs you (N)*. The groups cover the whole list, like the state bar's counts; with a day picked in the calendar, a line says so. The order is:
  - *Result not confirmed*;
  - *Athletes not linked*;
  - *Review out of date*;
  - *Needs a new search*;
  - *Needs a look*;
  - *Problem in the GPEXE data*.

  Each group has one sentence (for one session or several), a count and ONE button with the same label whatever the count. A group with several sessions keeps them folded; a group of one shows its session.
- **The group buttons.**
  - *Needs a new search* names the dates the search will use (the pre-filled ones, clipped to the latest 31 days) and sends exactly those.
  - Every other group's button opens its first session. So does any of its rows.
  - With nothing ready to import, the first group's button is the screen's one main action when it is *Result not confirmed*, *Athletes not linked* or *Review out of date*, and *Find new sessions* becomes a plain button. Otherwise the state bar's button stays the main one.
- **Stepping through a group** (J20 section 8). A review opened from a group says *Session i of n in "…"* and offers *Next session*.
  - The group is the list of sessions it held when it was opened, because a link made in one session moves the others to *Review out of date*.
  - *Next session* opens the next of those that still needs a person, never back to the start. After the last one: "That was the last session in "…"." with *Back to Imports*.
  - It is off, and refused by the handler, while something of the review must still be seen: an approval or its check, an update, a link, an undo in flight or not confirmed, or attendance states being saved or not confirmed (J20-C).
- **A review made before a link change** is its own group, *Review out of date*.
  - Its review updates itself with J20-A1's recompute (*Update the review*), so no new search and no dates are asked for it.
  - The row says "open it and update the review"; the dates are no longer pre-filled for it.
- **Rows that list an athlete as not linked** say "open it and link them from their rows" (J20-A2), no longer "under Link athletes (below), then find new sessions".
- **D2:** *Find new sessions* keeps its name, by the *Rukovodilac*'s decision: the button must not promise an import it does not do. The line "Finding sessions does not import anything; you choose what to import." moves up, right under the state bar.
- **D3:** while a search runs: "You can leave this page. The search goes on in OptiMove, and the sessions are here when you come back." It is true because the screen resumes polling a running check when it is opened again.
- **D4:** the state bar counts *Ready: N* and *Needs you: N* from the whole list; a day picked in the calendar does not change them.
- **D5 (without counts):** a row reads "Tue 03.11. · <the GPEXE name>", with the time beside it, on the local clock. The athlete and drill counts need a backend change and are not here.
- **D7:**
  - The confirmation is one question: "Import N sessions into <team>? Their values appear in Training Load at once." It is followed by one note.
  - After an import that only imported, the result reads "Imported N sessions." with "You can see them in Training Load → Activities." and *Open Activities*.
  - A mixed result keeps the counts line.
- **D8:** *mixed_timezones* is a data problem in plain words for everyone: "GPEXE reports this session's GPS devices in more than one time zone…", with "Nothing to do for now". The group's button is *See why*. Such a session still counts in *Needs you* until policy (b); whether it should is open with the *Rukovodilac*. The code and the server's text stay in an administrator's Technical details. Policy (b) is its own ★★ pull request.
- **Guide step 4** is no longer *done* while a session still lists an athlete as not linked (after PR #408). It then points to the *Athletes not linked* group, not to a search.
- **Tests:** `frontend/tests/gpexe-attention-u6a2.actions.test.mjs` (16 tests); the existing Imports suites follow the texts; the J20-C suite gains test 25, the Nezavisni revizor's INFO 2: leaving between two groups does not send the next one.

### U2a — the club admin approves the pair (PR #366, merge `db7ebd55`, 2026-11-04; no migration; **merged and deployed** with PR #361 on 2026-11-04)

- As designed in `docs/ai/u2a-club-admin-pair-plan.md` (section 8 records what was built and the decisions): the PUT of a team's settings accepts the active admin of the team's club in that club's workspace; the service re-checks the user, role, club, team and the club's `verified` connection inside its transaction; a club admin writes a first pair only; a GPEXE team already paired anywhere is the neutral `409 pair_not_available` for a club admin; Connect / Test return the whole annotated list to a club admin; *Approve pair* on the Source connections screen (the GPEXE team's name is the main text, an unnamed team cannot be approved).
- Reviews: `security-reviewer` (no BLOCKER or HIGH; the MEDIUMs became the neutral code and the recorded risk), `ux-design-reviewer` (HIGH fixed: the name), `code-reviewer` (NOT READY on two committed `node_modules` symlinks, removed before the push; other findings fixed); both ★★ GOs (*Rukovodilac*, *Nezavisni revizor*) on exactly `f2168f96`.
- Tests: backend `source-connections-f3c2e` 32/32 (29-32 new), `f3c2d` 26/26, `f3c2f` 12/12; frontend `source-connections.actions` 28/28; `gpexe` preset 52 of 54 files (the two baseline files).
- **Owner decision (2026-11-04, verbatim): „prihvatam oba za pilot ali kasnije admin kluba vidi samo timove svog kluba. Inace dva kluba ne mogu da imaju isti nalog."** Points 3 (the club admin sees the whole annotated list of the shared account) and 4 (the squatting risk) are **accepted for the pilot**. U2a may be deployed as built.
- **Release conditions before a second club (owner, 2026-11-04; the *Rukovodilac* holds them):** (1) the club admin sees **only the teams of their own club** again - the F3c2e intersection rule returns (a small change, its own PR); (2) the rule **one GPEXE account = one club**: two clubs cannot hold the same account (to be enforced, at connect time or by a unique rule on the credential's account, decided in its own PR); (3) a pair can be approved **only for visible ids** - the visible GPEXE team ids of the last Test stored per connection (a migration, ★★). Until all three are done only the pilot club uses U2a.
- **Open LOW (the *Nezavisni revizor*):** no test proves a club admin acting in a team or another club's workspace gets 403 on the PUT; to be added.

### U2 — the import switch per team (PR #369, merge `73193fe2`, 2026-11-04; migration v56, ★★; **merged and deployed**, v56 directly confirmed on production)

Plan: `docs/ai/u2-per-team-import-switch-plan.md` (the *Rukovodilac*'s GO 2026-11-04, R-U2-1…5 accepted as recommended). Runbook: `docs/runbooks/team-import-switch-v56.md`.

- **Both switches.** An import is approved only when the environment's `GPEXE_IMPORT_APPLY_ENABLED` AND the team's own row (`training_load.gpexe_team_import_switch`, absent = off) are on. Mode `pilot` (default): a platform admin or an explicit approver grant; mode `team`: also the club admin of the team's club (`club_admin`) and the team's coaches (`team_coach`). The grants stay in both modes (R-U2-5).
- **Who turns it.** A platform admin: on, off, the mode, the recorded dates. The club admin (club workspace): off always; on only for a team already in `team` mode; never the mode (R-U2-1, R-U2-2). Only a platform admin records the backup / restore-probe dates and the two attestations (R-U2-3). Everyone else: the same 404; a coach reads the state and mode.
- **The conditions are read inside the database** (`set_team_import_switch`): a backup dated within 2 days and a restore probe within 35 days in both modes (R-U2-4); for `team` mode also *wrong-link procedure available* (U5) and *archived team stops a running search*. Turning off has no condition. A refusal names the condition (`409 team_import_condition_unmet`) and writes nothing.
- **Switch-off is effective at once.** `lock_gpexe_import_approver` (v23 → v54 → v56) reads the switch row `FOR SHARE` in the approval's transaction, after the role rows; an off that has committed is seen by every approval not yet past that point, and a waiting approval is refused (`409 team_import_switch_off`). A batch stops at the candidate where the switch turned off.
- **Condition 5** (a running check when its team is archived) is proven by a real-flow test (archive the team while the check is between two source reads → the check fails `team_not_available`, no candidate, no staged row); nothing had to be built.
- **UI.** *Imports for this team* on the Imports screen: a one-sentence state for everyone; the panel (conditions with dates, reason, confirmation, history, record-a-date for a platform admin) for the two administrator roles. New sentences for the refusal `team_import_switch_off`.
- **Tests.** `backend/tests/team-import-switch-u2.test.mjs` (13: the gate at 2/35 days, team mode, role matrix, records, both switches, bases, switch-off race both orders, batch stop, condition 5, direct-SQL guards, preflight / post-check / rollback rehearsal) with 16 mutations (15 killed; the one survivor is the route's `canApprove` check on the records route, defence in depth behind the database function); `frontend/tests/team-import-switch.actions.test.mjs` (8). Existing approving suites enable the team switch in their setup (`backend/tests/support/team-import-switch.mjs`).
- **Deployed (2026-11-04):** `/api/health` `73193fe2` ok x3; post-check 5 blocks PASS, 0 rows in the three tables; **no team has a switch row, so no import can be approved until a platform admin records the dates and turns a team on.** Owner accepted the Nezavisni's I2 (an off may answer 409 `try_again` for up to 3 s behind a running approval; the environment switch is the general stop) and I3 (attestations global, no expiry, conditions checked at turn-on only); **before a second club:** check the backup's age at every approval, or switch a team off automatically when the backup goes stale.
- **Known limits.** The write guards are not a defence against whoever holds the database credentials (the v35 limit). The dated conditions are checked when a team is turned on, not at every approval.

### U3 — suggested athlete pairs and Review all (PR #377, merge `b341aa23`, 2026-11-05; no migration, ★★; **merged and deployed**)

- As built in `docs/ai/u3-suggested-pairs-plan.md` section 7: `GET /api/training-load/gpexe/teams/:teamId/athlete-pair-suggestions` for a platform admin, the club's admin and, new, the team's own coach in that team's workspace (identical 404 for everyone else, no-store; the right re-read under `FOR SHARE` in the read transaction); three lists only (`exact`, `ambiguous`, `dateConflicts`); a conflict is a flag pair and OptiMove's date of birth is never returned; the matching rule is a set of normalized name tokens plus an equal, present date of birth, one-to-one. *Review all N suggested pairs* only stages the exact pairs (at most 60) into the ordinary review; the links are made by the unchanged link route, one pair at a time. The identity load stays an administrator's act; recorded as open: after the pilot a coach may also start it (D3).
- Reviews: `code-reviewer`, `security-reviewer`, `ux-design-reviewer`, `mobile-qa` READY WITH NON-BLOCKING NOTES (their delta is in the PR); both ★★ GOs on `b3b4b414` (the *Rukovodilac*; the *Nezavisni revizor*, READY WITH NON-BLOCKING NOTES). Tests: backend `gpexe-pair-suggestions-u3`, `gpexe-athlete-identity` 26/26; frontend `gpexe-pair-suggestions.actions` 9/9 and the neighbouring Imports suites.
- Deploy (the *Rukovodilac*, Render API, commit `b341aa23`, HTTP 201): `/api/health` served `b341aa23` with `ok: true` three times in a row (to 08:23:44 UTC); without a login `/api/auth/me` 200 and the suggestions route (zero UUID) 401. No migration since v56.
- Follow-ups from the reviews: a former team member is offered in none of the lists (test, PR #379, merge `7f6232bc`); **open, a small separate PR after U4:** the `rightHolds` lock takes the users row and then the role row in two statements for every identity basis (today one `for share of u, r` statement, like the existing bases; the *Rukovodilac*'s LOW). Recorded, not changed: a coach who can rename athletes of their own team can probe the team's GPEXE roster by name (inside the accepted R2 audience); `no_identities_loaded` also covers "every loaded GPEXE athlete is already linked".

### U4 — the five-step guide and Use OptiMove variables (PR #383, merge `003d1fab`, 2026-11-05; frontend only, no migration, ★; **merged and deployed**)

- As built in `docs/ai/u4-guide-plan.md` with the *Rukovodilac*'s answers Q1-Q5: a "Set up GPEXE imports" panel at the top of Imports (five steps with states read from facts the screen already holds; a failed read is never "done"; folds when everything is done, *Show setup* reopens it); for an administrator the variables row after step 2: **Use OptiMove variables** reads the club's connections and the system mappings (active, family `rest_v1`, not hidden by the club, not already on for the binding, not refused earlier in the session), shows one in-page review, then sends the existing `POST /api/training-load/sources/metrics/activations` once per variable with its own request key, as Required, in mapping-id order, and stops at the first clear refusal (the server's sentence; a busy `try_again` or a gateway 4xx without a server code is not remembered as a refusal); a lost answer is *Result not confirmed* and *Check result* repeats the same key; the team select and leaving the screen are guarded while it runs or is unconfirmed. A coach sees steps 1-2 as one sentence, step 3 without a button, step 4 with its button, and makes none of the administrator reads.
- Reviews: `code-reviewer` (NOT READY at the first head - HIGH: the review card stayed after success; fixed - then READY WITH NON-BLOCKING NOTES), `ux-design-reviewer` and `mobile-qa` READY WITH NON-BLOCKING NOTES. The *Rukovodilac*'s ★ GO on `7cc192db`. Tests: frontend `gpexe-guide.actions` 19/19 and the neighbouring Imports suites; Chromium at 360-1280 px.
- Deploy (the *Rukovodilac*, Render API, commit `003d1fab`): `/api/health` served it with `ok: true` three times in a row (to 08:50:01 UTC); without a login `/api/auth/me` 200 and the GPEXE status 401.

### Follow-ups after U3 and U4 (2026-11-05)

- **`rightHolds` lock order (PR #384, merge `d543254d`, from `3778928a`; backend, no migration, ★★):** the identity service locks the users row, then the role row, then the club in separate statements for every basis (platform admin, club admin, team coach); test 9 proves a revocation holding the users row never deadlocks with the read. Both ★★ GOs (the *Nezavisni revizor* without findings above INFO).
- **Discovery - what is source-neutral (PR #385, merge `02b29e99`):** `docs/ai/source-neutrality-discovery.md`; the owner's questions Q1-Q3 (generalise the import tables or build a second pipeline; which source first; per-team or per-source switch) are with the owner.
- **J19-U5 sub-contract (PR #386, merge `c17f910c`, status Proposed):** `docs/ai/j19-u5-undo-contract.md`; no code or migration before the owner's answers to its Q1-Q6.
- Deploy of `c17f910c` (the *Rukovodilac*): `/api/health` served it with `ok: true` three times in a row (to 08:55:21 UTC); without a login `/api/auth/me` 200 and `athlete-identities` (zero UUID) 401; no migration since v56.
