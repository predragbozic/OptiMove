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
- Baseline failures seen in the same runs, reproduced identically on a clean main (frontend code of `0022f579`): `gpexe-client` and `gpexe-rest-v1-adapter-reads` (backend) and, in the frontend `frontend-fast` preset, `builder-performance-fixes` (2), `exercise-editor-thumbnail` (4), `exercise-media-thumbnail` (8), `exercise-ownership` (1), `exercise-personalization` (1), `training-load.actions` (2, the known X5a/X5b hang). Recorded in `CURRENT_STATE.md`, "Known baseline/environment test issues".
- Deploy (the *Rukovodilac*, Render API, commit `76af5f52`, HTTP 201): `/api/health` briefly served the old commit during the swap, then `76af5f52` with `ok: true` four times in a row (to 13:07:59 UTC); without a login `/api/auth/me` 200 and the GPEXE team status (zero UUID) 401.
