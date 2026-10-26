# Plan: Metrics Core and canonical variables, phases 0–10 and R1

Status: **adopted by the owner on 2026-10-26.** It covers the canonical variables, the source-field lifecycle, the
rest of M2, M4, the manual corrections and estimates (phase 10) and the re-import of a session (R1). This file is a
memory file (`.claude/rules/memory-maintenance.md`). A change of a phase, a gate or a decision recorded here is a
plan change and needs the owner, in the way section 2 describes.

The plan was drafted by the planning and review session (*Rukovodilac*) on 2026-10-26 as "PLAN FAZA v2". Additions
the owner accepted the same day:
- phase 10 (manual corrections and estimates), which replaces the optional M5 phase;
- R1 (re-import of a session);
- the owner's decisions of section 5.

The text below follows that plan. It adds no obligation of its own.

Last verified against commit: `deb2aa1` (`origin/main`, merge of PR #217). The references to
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*) and to
`docs/ai/phase5a-discovery-and-contract.md` are to that commit.

## 1. Who does what

| Role | Session | Does |
|---|---|---|
| Owner | — | Decides. Every red-zone step is the owner's, case by case (section 2). |
| Executor | the main Claude session of `CLAUDE.md` | The only writer: code, migrations, documents, branches, Draft PRs. Runs the internal reviewers by the orchestration matrix of `CLAUDE.md`. |
| *Rukovodilac* (planning and review) | `session_01MCgqwiexBgNEBaMKskhbTZ` | Plans and leads the phases. Reviews every phase and gives GO or NO-GO on an exact head. The owner designated it as the external reviewer for the five triggers of `CLAUDE.md`. Relays the owner's words. |
| *Nezavisni revizor* (independent reviewer) | `session_01YC2kSvwQcRiYteWE268sNf` | A third review of the ★★ phases (4, 7, 9, 10 and R1). Its packet carries no conclusion of the *Rukovodilac*. |

Both review sessions are read-only toward the repository. A finding they report is text for the executor to act on
(`CLAUDE.md`, "Model pisanja: jedan writer").

## 2. Green zone, red zone and the owner's words

**Green zone.** The executor acts on the *Rukovodilac*'s guidance without waiting for the owner:
- a branch from `origin/main`, one branch and one worktree per task;
- implementation and tests on disposable databases only;
- the internal reviewers;
- commits and pushes to that feature branch;
- a Draft PR, and updates to it;
- the review packet, and fixes of in-scope findings;
- the next phase, only after the *Rukovodilac*'s GO and the gate of A2 (section 3).

**Red zone.** Each step needs the owner's explicit word for that specific case:
- merge;
- deploy;
- a Render or Supabase setting;
- any access to the production database, reads included;
- a migration on a persistent database;
- a GPEXE request;
- credentials;
- deleting a branch or a PR;
- a force push;
- a change of scope or of this plan;
- a new product decision;
- a BLOCKER or HIGH that cannot be fixed within the task;
- a disagreement between the executor and a reviewer.

**How the owner's words reach the executor** (owner, 2026-10-26: „Potvrdi i da krenemo”, then „Neću ja da napišem
nista ti si rukovodilac”).
1. The owner writes in the *Rukovodilac*'s chat. The *Rukovodilac* relays every approval or order with the owner's
   words quoted exactly. Its own recommendation or GO is always kept apart and never stands in for the owner.
2. Before every red-zone step, the executor checks the quote in the *Rukovodilac*'s transcript
   (`list_events`, kind `user`). The quote must be a turn the owner typed, not a tool result or a relayed message.
   A quote that cannot be found there is not an approval.
3. An approval covers the one case it names. "Let's go" for the plan is not an order to merge.

## 3. How the model works

- **A1. External review.** The *Rukovodilac*'s GO counts as the external review of `CLAUDE.md` because the owner
  designated it. For a ★ phase the owner also confirms, before the merge, that the review was looked at. For a ★★
  phase the owner approves the contract before any code and confirms the external review before the merge.
- **A2. Moving on.** A GO closes a phase. A phase that builds on the code of the previous one (every phase but 5
  and P) starts only after the previous one is **merged** into `main`. The merge is red zone.
- **A3. Owner decisions as input.** A phase whose input is an owner decision does not start with code. The executor
  prepares the proposal as text, the owner decides, and the decision is written into section C of the discovery
  document before the implementation.
- **A4. Disagreement.** When the executor disagrees with a review finding, it does not fix it quietly or work
  around it. Both positions go to the owner.
- **A5. This document.** It is a memory file. Its PR is reviewed as docs-only, and its merge is the owner's.

## 4. Standing rules for every phase

- **The review packet** follows the "Agent input contract" of `CLAUDE.md`:
  - the goal and the decisions;
  - the acceptance criteria;
  - the base and the frozen head;
  - the diff or a path to it;
  - the file list;
  - what is out of scope;
  - the exact commands and the real test counts;
  - the mutations for new guards;
  - the internal reviewers and their findings.
- **The reviewer** runs the tests again in its own worktree, on its own disposable databases.
- **A GO or NO-GO** names an exact head. A new commit voids it; after a fix, a narrow re-review of the delta follows.
- **Every merge** is made from exactly the reviewed head (`--match-head-commit`).
- **After a deploy:** `/api/health` serves the merge commit three times, and the new or changed routes answer
  401 without a login.

## 5. Phases

### Phase 0: this document (docs-only)
- **Green zone:** a branch, this document, a Draft PR, the packet to the *Rukovodilac*.
- **Acceptance:** the content matches the adopted plan and adds no obligation. `code-reviewer` by the docs row of
  the matrix.
- **Red zone:** the owner adopts the plan (done 2026-10-26, section 2) and merges this PR.

### Phase 1 ★: PR #219 (C98), no new code
- **Green zone:** nothing new in the code. On the owner's request the *Rukovodilac* can check `a36d3c0`
  independently.
- **Red zone:**
  - (a) right before the merge, a read-only count of `system` / `club` definitions in production
    (`begin transaction read only … rollback`), expected 0. *Owner, 2026-10-26: „Proverio sam 0 je.”*
  - (b) the Render settings of `optimove-eu` and of the old `optimove` service: Auto-Deploy, branch, and the old
    service's database. *Owner, 2026-10-26: „Render nema autodeploy”.* The old service's database and branch are
    still open; they are a gate of phase 4, not of this phase.
  - The merge from head `a36d3c0`, the deploy (manual, started by the owner), then the smoke.
- **Acceptance:**
  - the merge commit's parents are `deb2aa1` and `a36d3c0`;
  - health `ok` three times;
  - the older API's write routes answer 401 without a login;
  - no production write.
- **★:** the owner confirms that the external review (triggers 2 and 4) was looked at.

### Phase 2 ★: PR #218 (the Variables tab), after #219 is merged
- **Green zone:**
  - bring `main` into the branch with a merge commit (no rebase, no force push);
  - resolve the conflict in the discovery document;
  - correct the sentence in section A that says "No frontend writes to the registry";
  - integration QA: the real backend and frontend on a disposable database migrated through v37, with a platform
    admin and a club admin. It covers:
    - create and a new version;
    - `key_taken`, `current_version_changed`, `variable_not_active`;
    - a lost answer, then *Check result* with the same `requestKey`: one request row, one version;
    - a double click sends one request;
    - a workspace switch in the middle of the form;
    - a club admin never sees another club;
  - then an internal re-review of the delta (`code-reviewer`, `mobile-qa`, `ux-design-reviewer`) and the packet.
- **Acceptance:**
  - unit, label and evidence are rendered as escaped text (J4), with a test;
  - browser QA at 1280 / 390 / 375 / 360 px;
  - the metric-variables, training-load actions and production-build checks are green;
  - the integration QA passes, with its record in the PR.
- **Red zone:** merge, deploy, smoke.
- **★:** trigger 4 (idempotency), external review.

### Phase 3: docs sync, after #218 is deployed
- **Green zone:**
  - `docs/ai/CURRENT_STATE.md`: the "Last reviewed" line; M2b merged; #218 and #219 with the deploy facts the
    owner reports; the v37 post-check, if done;
  - the discovery document: in section K, the note that maps the two `metric_definitions` / scope-capability guard
    refusals (`23514`) to a 409, which C98 makes unnecessary; and `Last verified against commit`.
- **Acceptance:** no claim without evidence; what is inferred is marked as inferred.
- **Red zone:** merge.

### Phase P: in parallel, the owner only (red zone, no code)
- The read-only v37 post-check (`docs/runbooks/source-metric-revision-guards-v37-postcheck.sql`); the owner reports
  PASS or FAIL per block. It is a gate of phase 4.
- The evidence for the nine `rest_v1` fields (C97, the table of J4). The executor may only prepare the procedure; it
  sends no GPEXE request.

### Phase 4 ★★: the revision lifecycle (C91), migration v38
- **Input (red zone, before any code):**
  - owner decisions on:
    - who may create revision R+1;
    - activating R+1;
    - retiring R;
    - what happens to the T4 versions and T5 activations pinned to R (automatic or manual replacement);
    - whether a given confirmation is voided;
  - the v37 post-check PASS (phase P);
  - the old Render service clarified (phase 1, b).
- **Green zone:**
  - a separate discovery delta document, as the proposed contract (J5);
  - after the owner's decision, the implementation: v38 with database actor guards (C76), its rollback, and the
    read-only preflight and post-check scripts;
  - the M1 / M2 / v35 / M3-0 / M2b suites no longer switch off the v37 T2b triggers but write the real way.
- **Acceptance:**
  - the rollback is rehearsed (apply → rollback → identical catalog → re-apply);
  - every guard has a mutation the tests kill;
  - concurrency of a revision against the M2 version create and the F2 / F3 acts, in both orders;
  - none of the nine seeded fields changed;
  - tests on PostgreSQL 16 and, where possible, 17.
- **Reviewers:** `db-reviewer`, `security-reviewer`, `code-reviewer`, and the external review (triggers 1, 2 and 4).
- **Red zone:** the production preflight, merge, deploy, and the production post-check of v38.
- **★★:** the owner approves the contract (J5) before any code and confirms the external review before the merge.

### Phase 5: the zone model (C89)
- An owner decision only; the executor prepares the variants.
- **Red zone:** the decision. If it needs a schema, that is a separate ★★ phase on the pattern of phase 4.

### Phase 6 ★: M3 Source fields tab, after phase 4 is merged
- Reading the fields and their revisions; the F2 / F3 acts for a platform admin.
- **Acceptance:**
  - integration QA against the real API;
  - escaped unit and evidence;
  - for a zone, the meaning button shows `verification_model_unresolved` until phase 5 is decided;
  - browser QA.
- **Reviewers:** `code-reviewer`, `mobile-qa`, `ux-design-reviewer`.
- **Red zone:** merge, deploy. The first real production confirmation of a field is a separate order, and only
  with the C97 evidence.

### Phase 7 ★★: the rest of M2, several PRs, each with its own guard migration (C76)
- **Order:**
  - 7a: the access helper extracted, no behaviour change;
  - 7b: T4 activate, disable and replacement;
  - 7c: `unit_conversions` maintenance;
  - 7d: T5 activations;
  - 7e: the aggregate preview;
  - 7f: the extractor registry;
  - 7g: ending a held instance (D9).
- **Input (red zone):** the owner's decisions from section K of the discovery document (the minimum number of
  athletes for min / max, system or club zone mappings, the preview's fields, the shape of the D9 operation).
- **Reviewers:** the full set by the matrix, and the external review.
- **Red zone:** as phase 4, for every PR.

### Phase 8 ★: M3 Mappings tab, after 7b and 7d
- **Acceptance:** an activation's confirmation names the source, the mapping version, the team and the binding.

### Phase 9 ★★: M4, the importer integration
- Triggers 1, 3 and 4; the five-point rule for transactions; the import switch stays off.
- **Acceptance:** a characterisation test: the same numbers as today within 1e-9; without an activation, zero
  values and no write to `metric_definitions`.

M6 follows phase 9. All of it is the owner's and outside the green zone.

### Phase 10 ★★: manual corrections and estimates (M5 + 5b), after phase 9
- **Owner, 2026-10-26:** M5 (more than one GPS track of an athlete) and 5b (manual values and estimates,
  `docs/ai/phase5a-discovery-and-contract.md` §3.7) are one phase. It replaces the optional M5 phase.
- **Scope:**
  - choosing one of two GPS tracks;
  - the sum of two tracks, only with the coach's confirmation that they do not overlap in time (max speed is never
    summed: the larger is taken);
  - an athlete without a GPS record gets the values of another athlete;
  - the team average;
  - for a match, the average of the athlete's last N matches, scaled to manually entered minutes.
- **Recording:** every such value is an estimate or a manual entry, never a measurement:
  - the method and its version;
  - the references (athletes, activities, occasions);
  - the minutes;
  - the produced and refused metrics;
  - who confirmed it, and when.

  All of it per §3.7 (`entry_method 'estimated'`, `metric_estimations`, deferred triggers in both directions). The
  GPEXE event is never changed.
- **Decisions:** `docs/ai/phase10-estimates-decisions.md`. The owner decided D2, D6, D7, D7a, D13 and Q1–Q5;
  D1, D3–D5 and D8–D12 stay recommendations until the phase 10 contract. Before the implementation they are written
  into section C of the discovery document (A3).
- **Start:** after phase 9 is merged, with the contract approved by the owner (★★).

### R1 ★★: "Overwrite with a new import" (re-import of a session)
- **Owner, 2026-10-26:**
  - *„Jednostavno mogu biti drugačije obradjeni podaci u gpexe aplikaciji pa želim novi uvoz koji prekopira stari”*;
  - *„Trener tima ako hoće moze neograničeno da uvozi seaijunsve dok ne bude zadovoljan i da prekopira”*;
  - on the two recommendations below: *„ok preporuke”*.
- **What it is:**
  - for one session, a new check that shows the difference between the old and the new data;
  - one explicit step makes the new GPEXE data current, also where the writer today answers `needs_review`
    (the same or a missing `source_reported_at`, or a changed metric set; `backend/src/gpexeImportWriter.js`, the
    comment of the re-import rules and its decision block);
  - no limit on repeats;
  - the old data stay in the history (superseded, never deleted);
  - an audit row records who, when and why.
- **Owner decisions:**
  - only who may approve an import today may do it: a platform admin, or a coach with the approver grant for that
    team. Not every team coach;
  - only imported values are overwritten. Manual corrections and phase 10 estimates in that session stay.
- **Notes for the contract** (agreed by the executor and the *Rukovodilac*; not owner decisions):
  - R1 is a new decision inside the existing approval flow (preview → `changesToImported` → approve), not a separate
    flow;
  - "no limit" means no business limit. The 429 / rate-limit rules, one running check per team and
    `docs/ai/gpexe-connection-cooldown-plan.md` still apply;
  - a session is read only after a list of the same adapter instance classified it as a parent
    (`session_not_listed`). The re-import therefore reads the list for that session's day, with the look-back day and
    `WINDOW_FILTER_MARGIN_DAYS`, twice and classified as today, and then that one session. No safety rule changes.
- **Place:** after phase 9, before the first regular production import, together with condition 4 of the import
  switch (a safe undo procedure). Triggers 1, 3 and 4.

## 6. Small separate tasks

Each one is a plan change, so the owner schedules it:
- `POST /events` takes its lock before the visibility check (`trainingLoadMetricsMeasurements.js`, LOW);
- `TEXT_FORBIDDEN` and `source_metric_text_ok` (a migration);
- the v35 / v36 test hardening;
- separate database roles.

PR #220 is not part of this plan. If it runs in parallel, it is merged in sequence with #218 (they share
`frontend/training-load-actions.js`), and the training-load actions tests are run again.
