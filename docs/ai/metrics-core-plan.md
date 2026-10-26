# Plan: Metrics Core and canonical variables, phases 0–10 and R1

Status: **adopted by the owner on 2026-10-26**, in the executor's chat: „ok: plan v2 sa R1, zelena zona, revizori,
prenete odluke za fazu 10 i R1; D1, D3–D5, D8–D12 ostaju preporuke.”

It covers:
- the canonical variables, and renaming and archiving them (R2, phases 2b and 2c);
- the source-field lifecycle;
- the rest of M2 and M4;
- the manual corrections and estimates (phase 10);
- the re-import of a session (R1).

This file is a memory file (`.claude/rules/memory-maintenance.md`). A change of a phase, a gate or a decision
recorded here is a plan change and needs the owner (section 2).

**Sources.** The plan was drafted on 2026-10-26 by the planning and review session (*Rukovodilac*) as "PLAN FAZA v2".
The same day the owner added three things to it:
- phase 10 (manual corrections and estimates), which replaces the optional M5 phase;
- R1 (re-import of a session);
- the decisions recorded in section 5 and in `docs/ai/phase10-estimates-decisions.md`.

Added after the adoption, the same day: R2 (phases 2b and 2c), the executor as the one who merges (section 1), and the
standing merge order for PRs without a migration (section 2).

The text below follows those sources. Where it records an owner order that departs from a project rule, it quotes the
order and names the rule (section 2).

Last verified against commit: `deb2aa1` (`origin/main`, merge of PR #217). The references to
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*) and to
`docs/ai/phase5a-discovery-and-contract.md` are to that commit.

## 1. Who does what

| Role | Session | Does |
|---|---|---|
| Owner | — | Decides. Every red-zone step is the owner's, case by case (section 2). |
| Executor | the main Claude session of `CLAUDE.md` | The only writer: code, migrations, documents, branches, Draft PRs. Runs the internal reviewers by the orchestration matrix of `CLAUDE.md`. Makes every merge into `main`, on the owner's order or under the standing merge order, after checking it (section 2). |
| *Rukovodilac* (planning and review) | `session_01MCgqwiexBgNEBaMKskhbTZ` | Plans and leads the phases. Reviews every phase and gives GO or NO-GO on an exact head. It is the designated external reviewer for the five triggers of `CLAUDE.md` (owner: „… revizori …” in the adoption above). Relays the owner's words (section 2). |
| *Nezavisni revizor* (independent reviewer) | `session_01YC2kSvwQcRiYteWE268sNf` | A third review of the ★★ phases (4, 7, 9, 10 and R1). Its packet carries no conclusion of the *Rukovodilac*. Disagreements between the two reviewers go to the owner. |

The third reviewer is the owner's order of 2026-10-26, written in the *Rukovodilac*'s chat: „treći revizor za ★★
faze to je ok. Otvori sesiju nezavisni revizor a svoj naziv promeni u rukovodilac”.

Both review sessions are read-only toward the repository, its pull requests and every persistent database; each may
create and drop its own disposable test databases. A finding they report is text for the executor to act on
(`CLAUDE.md`, "Model pisanja: jedan writer").

**Who merges.** The executor makes the merges: the owner, 2026-10-26, „Slažem se sa tobom idemo za sada tako pa ćemo
menjati ako bude potrebe”, answering the *Rukovodilac*'s proposal „… merge radi izvršilac”. There were two exceptions,
and no further one is made without a new owner decision:
- the *Rukovodilac* merged PR #219, on the owner's order in its chat;
- the *Rukovodilac* merged PR #221 (`16ef080`), on the owner's direct order in its chat, 2026-10-26 22:59 UTC: „Mozes
  li ti to da radiš umesto mene”. The executor had objected and both positions went to the owner, who decided (A4).

## 2. Green zone, red zone and the owner's words

### Green zone

The executor acts on the *Rukovodilac*'s guidance without waiting for the owner. This is the model the owner agreed to
in the executor's chat on 2026-10-26:
- the owner asked: „Moze li nekako da bude sigurno a da ne čeka moje odobrenje već da radiš po njegovom vođenju kada
  plan usvojimo”;
- the owner answered the proposed zones: „Slažem se sa ovim”;
- the owner adopted the plan with „zelena zona” (status line above).

What the green zone covers:
- a branch from `origin/main`, one branch and one worktree per task;
- implementation and tests on disposable databases only;
- the internal reviewers;
- commits and pushes to that feature branch, staging named files only;
- a Draft PR, and updates to it;
- the review packet, and fixes of in-scope findings;
- the next phase, only after the *Rukovodilac*'s GO and the gate of A2 (section 3).

This standing order departs from two project rules, and only for this plan's feature branches:
- **`.claude/rules/git-safety.md`** asks for the owner's confirmation of every commit and push. Here commits and pushes
  to a feature branch of this plan are confirmed in advance. Not covered:
  - a commit or push to `main`;
  - a merge, including a merge of `main` into a branch;
  - a rebase;
  - a force push;
  - every other hard prohibition of that file.
- **`CLAUDE.md`** ("External-review okidači") says no PR is opened before the external review. Here a **Draft** PR is
  opened as the vehicle of that review. Merge-readiness, a ready-for-review PR and the merge still wait for the
  external review, and for the owner outside the standing merge order (below).

A third owner-ordered departure is the relay of approvals, and a fourth the standing merge order (both below).
Everywhere else, `CLAUDE.md` and `.claude/rules/` apply as written. Where this file and a rule differ outside those
four named points, the rule applies until the owner amends it.

Two protections of the same model:
- after every phase the owner gets a short report (what was done, the PR, the tests, the review outcome);
- the owner's „stop”, at any time, stops all work.

### Red zone

Each step needs the owner's explicit word for that specific case. The list adds to the hard prohibitions of
`.claude/rules/git-safety.md` and `.claude/rules/database-safety.md` and never narrows them.
- **Git and GitHub:**
  - a merge into `main` outside the standing merge order (below);
  - bringing `main` into a branch;
  - any other merge (between branches, or of a PR whose base is not `main`);
  - deleting a branch or a PR;
  - a force push;
  - any write through a GitHub tool other than this plan's branches and Draft PRs.
- **Deploy and hosting:**
  - a deploy, other than the one a merge under the standing merge order starts;
  - a Render or Supabase setting.
- **Databases:**
  - any access to the production database, reads included;
  - a migration on a persistent database;
  - any other write to a persistent database (the local OPTIMOVE, a shared development database, staging,
    `monitoring2`), including `npm run test:backend:shared`;
  - removing a database or another artifact this session did not create.
- **Outside systems:**
  - a GPEXE request;
  - credentials.
- **Rules and plan:**
  - a change of `CLAUDE.md`, `.claude/**` or a setting or permission;
  - a change of scope or of this plan.
- **Decisions and disagreements:**
  - a new product decision;
  - a BLOCKER or HIGH that cannot be fixed within the task;
  - a disagreement between the executor and a reviewer.

### Standing merge order (PRs without a migration)

The owner, in the executor's chat, 2026-10-26: „Trajni nalog: PR bez migracije baze spajaš u main posle GO
Rukovodioca, bez mog posebnog naloga, kad Rukovodilac oceni da je rizik nizak; o neslaganju sa Rukovodiocem obaveštavate
mene. PR sa migracijom uvek traži moj nalog koji imenuje migraciju. Upiši ovo u plan.”

This order departs from two project rules, and only for the PRs it covers:
- **`.claude/rules/git-safety.md`** ("Merge / deploy / migrations"): no merge or deploy without the owner's
  authorization for that specific action in the current session;
- **`CLAUDE.md`** ("Granice dozvoljenih operacija", "Definition of done"): stop before a merge and a deploy.

Every other rule of those files applies as written.

- **What it allows.** The executor marks the PR ready for review and merges it into `main`, without a separate order
  from the owner, when all of these hold:
  - **No migration**, checked on the reviewed base and head:
    - (a) `git diff --name-status <base>...<head>` lists no file under `migrations_v2/` or `migrations/` (no add,
      change, delete, rename or mode change);
    - (b) the diff touches none of: `backend/src/migrate.js`; the `start` or `build` script of `package.json` or
      `backend/package.json`; code the server runs by itself at start-up or on a schedule (the start-up block of
      `backend/src/server.js` and the jobs it starts, such as the retention and cleanup runs); `.github/**`;
    - (c) it changes neither the default nor the reading of a switch that gates writes in production (for example
      `GPEXE_IMPORT_APPLY_ENABLED` or `MEDIA_STORAGE_ENABLED`).

    If (b) or (c) is touched, the PR is covered only when its body says what then runs at start-up or on a schedule
    and why it writes nothing to production data, and the GO confirms that. The GO records the result of (a).
  - **The GO.** The *Rukovodilac* gave GO naming the PR, the exact head and the base, and saying „no migration” and
    „risk low”. The executor finds that GO as the *Rukovodilac*'s own turn in the session named in section 1, after
    the frozen head, and records its event id and its words in the PR body before the merge. A GO it cannot find there
    is not a GO.
  - **The base.** `main` is still at the base the GO names, or the *Rukovodilac* confirmed the GO again on the new
    base.
  - **A ★★ phase.** The *Nezavisni revizor* gave its own GO on the same head, on a packet without the *Rukovodilac*'s
    conclusion, found the same way in its session (section 1).
  - **No open finding.** No BLOCKER or HIGH is open, and no reviewer disagrees.
  - **The head.** The merge is made from exactly that head (`expectedHeadSha` / `--match-head-commit`).
- **What follows.** The merge is also the deploy to `optimove-eu` (below). The smoke of section 4 follows, and the
  owner gets the short report of the phase. If the smoke fails, no further merge is made under this order until the
  owner has been told.
- **What it does not allow.**
  - A PR with a migration: it always needs the owner's order that names the migration (below).
  - A PR that changes this file, except one that only adds a "Done" entry or the deploy facts of a finished phase in
    section 5. It needs the owner's word naming the PR, given after the GO on its final head; a new commit voids it.
  - A PR that changes sections 1 to 4 of this file, `approval-channel.md`, `CLAUDE.md`, `.claude/**`, `.github/**`, a
    setting or a permission. The owner's word for it is given only directly in the executor's chat, or the owner merges
    it personally ("Never by relay").
  - An owner's instruction to write such a change authorizes writing it and opening its Draft PR only, never its
    merge.
  - A PR that records an owner decision (section C of the discovery document, `docs/ai/phase10-estimates-decisions.md`)
    is covered only when its body carries the owner's verbatim words and their event id.
  - Bringing `main` into a branch, any other merge, or any other red-zone step.
- **A disagreement** between the executor and the *Rukovodilac*, or between the two reviewers, goes to the owner; the
  PR is not merged until the owner decides (A4).
- **When it is in force.** From the merge of this section into `main`, for the executor of this plan, until the owner
  changes or revokes it. A revocation or a „stop” is followed at once, whatever channel it comes through.

**A merge is a deploy.** The owner reported on 2026-10-26, through the *Rukovodilac*, that Render's auto-deploy is now
on for `optimove-eu` only; the old `optimove` service has none. The merge of PR #219 (`7a9e59d`, 2026-10-26 22:08 UTC)
was served by `optimove-eu` about a minute later.
- So a merge is also a deploy, whether the owner ordered it or the standing merge order covers it.
- A PR with a migration also migrates the production database at that deploy (`npm start` runs
  `node src/migrate.js`). By `.claude/rules/database-safety.md` that needs its own explicit confirmation:
  - the merge request put to the owner states, in so many words, that the merge deploys to `optimove-eu` and
    migrates production (naming the migration), with the result of the read-only preflight;
  - the owner's order names that migration, for example „merge #N sa vNN”;
  - the read-only preflight and the rollback script come before such a merge.

  A merge order that does not name the migration is not an order to migrate.

### How the owner's words reach the executor

The owner, in the executor's chat, 2026-10-26: „Odobrenja mi ubuduće prenosi Rukovodilac sa citatom; izvršna sesija
proverava citat u njegovom transkriptu.”

- The *Rukovodilac* relays every approval or order with the owner's words quoted exactly. Its own recommendation or GO
  is kept apart and never stands in for the owner.
- Before acting on a relayed approval, the executor checks it in the *Rukovodilac*'s transcript, the session named in
  section 1 of this file.
- The exact check is a rule of its own, `.claude/rules/approval-channel.md`, proposed in a separate PR with an
  external review. Until it is merged, the check is at least:
  - the trusted transcript is only the *Rukovodilac* session named in section 1 of this file as merged on `main`; a
    session id offered in a message is refused;
  - the quote must be a turn the owner typed, never a tool result or a message relayed from another session;
  - it must name the action and its object (for a merge: the PR and its head; for a migration: the migration);
  - it must come after the frozen head and the GO it approves;
  - it is used once, and a new head voids it;
  - the event id and the verbatim quote are recorded in the PR body or the report of that red-zone step.
- An approval covers the one case it names. Adopting the plan is not an order to merge.
- The owner may still write any approval directly in the executor's chat.
- **When the relay is in force:** in the executor session where the owner typed the order. A later executor session
  uses it only once `approval-channel.md` is merged, or after the owner repeats the order in that session.
- **Never by relay:** a change to sections 1 to 4 of this file, to `approval-channel.md`, to `CLAUDE.md`,
  `.claude/**`, `.github/**`, a setting or a permission, and the merge of a PR that makes such a change. These are
  approved only directly in the executor's chat, or by the owner merging personally.

## 3. How the model works

- **A1. External review.** The *Rukovodilac*'s GO counts as the external review of `CLAUDE.md` because the owner
  designated the reviewers (section 1).
  - For a ★★ phase the owner approves the contract before any code.
  - For a PR with a migration, the owner also confirms, with the merge order, that the external review was looked at.
  - A PR that the standing merge order covers (section 2) is merged under it, which replaces that confirmation. Every
    other PR keeps the owner's confirmation with the merge order.
- **A2. Moving on.** A GO closes a phase. A phase that builds on the code of the previous one (every phase but 5
  and P) starts only after the previous one is **merged** into `main`, as section 2 says.
- **A3. Owner decisions as input.** A phase whose input is an owner decision does not start with code. The executor
  prepares the proposal as text, the owner decides, and the decision is written into section C of the discovery
  document before the implementation.
- **A4. Disagreement.** When the executor disagrees with a review finding, it does not fix it quietly or work
  around it. Both positions go to the owner.
- **A5. This document.** It is a memory file. Its PR is reviewed as docs-only, and its merge needs the owner's word
  as section 2 says ("What it does not allow"). The standing merge order covers only a PR that adds a "Done" entry or
  the deploy facts of a finished phase.

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
- **The *Rukovodilac*** runs the tests again in its own worktree, on its own disposable databases. The internal
  reviewers have no shell and never claim to have run a test (`CLAUDE.md`, "Agent input contract").
- **A GO or NO-GO** names an exact head. A new commit voids it; after a fix, a narrow re-review of the delta follows.
- **Every merge** is made from exactly the reviewed head (`--match-head-commit`).
- **After a deploy, the smoke:**
  - `/api/health` serves the merge commit three times in a row;
  - the new or changed routes answer 401 without a login.

  The source plan has the owner run it. Since 2026-10-26 the *Rukovodilac* runs it after each deploy and the executor
  may run it in parallel, as both did for PR #219. Whoever runs it keeps to requests without a login, with the zero
  UUID, on the PR's own routes only; it touches no data.

## 5. Phases

In the phases below, a "Red zone: merge" line means a merge outside the standing merge order of section 2. A PR that
order covers is merged under it.

### Phase 0: this document (docs-only)
- **Green zone:** a branch, this document and `docs/ai/phase10-estimates-decisions.md`, a Draft PR, the packet to the
  *Rukovodilac*.
- **Acceptance:** the content matches the adopted plan and its sources (the header lists them). `code-reviewer` for
  the whole diff and `security-reviewer` for section 2, by the docs row of the matrix.
- **Red zone:** the owner adopts the plan (done on 2026-10-26) and merges this PR. This PR creates section 2, so its
  merge is approved only directly in the executor's chat or by the owner merging personally, never by relay.

### Phase 1 ★: PR #219 (C98), no new code
- **Green zone:** nothing new in the code. On the owner's request the *Rukovodilac* can check `a36d3c0`
  independently.
- **Red zone:**
  - (a) right before the merge, a read-only count of `system` / `club` definitions in production
    (`begin transaction read only … rollback`), expected 0;
  - (b) the Render settings of `optimove-eu` and of the old `optimove` service: Auto-Deploy, branch, and the old
    service's database. The old service's database is still open. The *Rukovodilac* recommends that it does not block
    #219, which has no migration, and stays a gate of phase 4. That is a recommendation; the owner decides it with the
    merge order;
  - the merge from head `a36d3c0`, the deploy, then the smoke.
- **Acceptance:**
  - the merge commit's parents are `deb2aa1` and `a36d3c0`;
  - health `ok` three times;
  - the older API's write routes answer 401 without a login;
  - no production write.
- **★:** the owner confirms that the external review (triggers 2 and 4) was looked at.
- **Done, 2026-10-26.**
  - Preflight: (a) the owner counted 0; (b) auto-deploy is on for `optimove-eu` only, and the old service's database
    stays open for phase 4.
  - Reviews: the *Rukovodilac* and the *Nezavisni revizor* each gave GO on `a36d3c0`.
  - Merge: `7a9e59d` (parents `deb2aa1` and `a36d3c0`), about 22:08 UTC, on the owner's order „merge #219 …”. The
    *Rukovodilac* made it (the exception of section 1).
  - Smoke: `/api/health` served `7a9e59d` with `ok: true` three times (from 22:09:09 UTC); without a login the older
    API's write routes answered 401. No migration, no production write.

### Phase 2 ★: PR #218 (the Variables tab), after #219 is merged
- **Green zone:**
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
- **Red zone, before the green-zone work:** bring `main` into the branch with a merge commit (no rebase, no force
  push). It is a merge, so it needs the owner's word (section 2).
- **Acceptance:**
  - unit, label and evidence are rendered as escaped text (J4), with a test;
  - browser QA at 1280 / 390 / 375 / 360 px;
  - the metric-variables, training-load actions and production-build checks are green;
  - the integration QA passes, with its record in the PR.
- **Red zone:** merge, deploy, smoke.
- **★:** trigger 4 (idempotency), external review.

### Phase 2b ★★: R2, renaming and archiving canonical variables (backend), after #218 is merged
- **Owner, 2026-10-26** (in the *Rukovodilac*'s chat):
  - the request: „Stavio sam ali bilo bi dobro da mogu preimomenovati kanonsku varijablu i arhivirati”;
  - „Zašto trener ne moze imati opciju da moze da menja.”;
  - to the *Rukovodilac*'s option 2: „Slažem se sa tobom idemo za sada tako pa ćemo menjati ako bude potrebe”.
- **Scope (option 2):**
  - rename (label, short label, description) and archive a canonical variable through the M3-0 admin API;
  - an archived variable can be restored (unarchive);
  - the key never changes;
  - who: a coach of a team of the club may rename, archive and restore that **club's** variables; **system**
    variables stay the platform admin's;
  - every change is audited: who, when, the old and the new value.
- **Facts at `7a9e59d`:**
  - `backend/src/routes/sourceMetrics.js` has, for variables, only the reads, `POST /variables` and
    `POST /variables/:variableId/versions`;
  - the v36 request record allows only the operations `variable_create` and `variable_version_create` (its CHECK and
    its insert guard).

  So R2 needs a migration: new operations, their database actor guards (C76), a rollback, and the read-only
  preflight and post-check scripts. It is v38 or v39, depending on its order with phase 4.
- **Archiving a pinned variable:** the v34 guard (decision 9) already refuses it; the API answers it as
  `409 variable_pinned`, as for a new version.
- **Decision record:** the coach as an administrator of club variables changes the audience of the M3-0 admin API
  (C80 / C88). Before the code, it is written into section C of the discovery document as a new decision (A3).
- **Reviewers:** `db-reviewer`, `security-reviewer`, `code-reviewer`, and the external review of the *Rukovodilac*
  and the *Nezavisni revizor* (triggers 1, 2 and 4).
- **Red zone:** the production preflight, merge (and so deploy and migration, by an order that names it), the
  production post-check.

### Phase 2c ★: R2 in the Variables tab (frontend), after 2b is merged
- Rename, archive and restore in the Variables tab, for the rights of 2b.
- **Reviewers:** `code-reviewer`, `mobile-qa`, `ux-design-reviewer`.
- **Red zone:** merge, deploy, smoke.

### Phase 3: docs sync, after #218 is deployed
- **Green zone:**
  - `docs/ai/CURRENT_STATE.md`: the "Last reviewed" line; M2b merged; #218 and #219 with their deploy facts; the v37
    post-check, if done;
  - the discovery document:
    - in section K, the note that maps the two `metric_definitions` / scope-capability guard refusals (`23514`) to a
      409; C98 makes it unnecessary;
    - `Last verified against commit`.
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
  - the old Render service clarified: which database it uses (phase 1, b).
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
- **Red zone:** the production preflight, merge (and so deploy and migration), and the production post-check of v38.
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
- **Red zone:** merge and deploy. The first real production confirmation of a field is a separate order, and only with
  the C97 evidence.

### Phase 7 ★★: the rest of M2, several PRs, each with its own guard migration (C76)
- **Order:**
  - 7a: the access helper extracted, no behaviour change;
  - 7b: T4 activate, disable and replacement;
  - 7c: `unit_conversions` maintenance;
  - 7d: T5 activations;
  - 7e: the aggregate preview;
  - 7f: the extractor registry;
  - 7g: ending a held instance (D9 of the discovery document).
- **Input (red zone):** the owner's decisions from section K of the discovery document:
  - the minimum number of athletes for min / max;
  - system or club zone mappings;
  - the preview's fields;
  - the shape of the operation of discovery D9.
- **Reviewers:** the full set by the matrix, and the external review.
- **Red zone:** as phase 4, for every PR.

### Phase 8 ★: M3 Mappings tab, after 7b and 7d
- **Acceptance:** an activation's confirmation names the source, the mapping version, the team and the binding.

### Phase 9 ★★: M4, the importer integration
- Triggers 1, 3 and 4; the five-point rule for transactions; the import switch stays off.
- **Acceptance:** a characterisation test:
  - the same numbers as today, within 1e-9;
  - without an activation, zero values and no write to `metric_definitions`.

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
- **Recording:** every such value is an estimate or a manual entry, never a measurement. It records:
  - the method and its version;
  - the references (athletes, activities, occasions);
  - the minutes;
  - the produced and refused metrics;
  - who confirmed it, and when.

  All of it follows §3.7 (`entry_method 'estimated'`, `metric_estimations`, deferred triggers in both directions).
  The GPEXE event is never changed.
- **Decisions:** `docs/ai/phase10-estimates-decisions.md`.
  - The owner decided D2, D6, D7, D7a, D13 and Q1–Q5.
  - D1, D3–D5 and D8–D12 stay recommendations until the phase 10 contract.
  - Before the implementation, both are written into section C of the discovery document (A3).
- **Start:** after phase 9 is merged, with the contract approved by the owner (★★).

### R1 ★★: "Overwrite with a new import" (re-import of a session)
- **Owner, 2026-10-26** (in the *Rukovodilac*'s chat):
  - „Jednostavno mogu biti drugačije obradjeni podaci u gpexe aplikaciji pa želim novi uvoz koji prekopira stari”;
  - „Trener tima ako hoće moze neograničeno da uvozi seaijunsve dok ne bude zadovoljan i da prekopira”;
  - on the two recommendations under "Owner decisions" below: „ok preporuke”.
- **What it is:**
  - for one session, a new check that shows the difference between the old and the new data;
  - one explicit step makes the new GPEXE data current, also where the writer today answers `needs_review`. That
    covers the same or a missing `source_reported_at`, and a changed metric set (`backend/src/gpexeImportWriter.js`,
    the comment on the re-import rules and its decision block);
  - no limit on repeats;
  - the old data stay in the history (superseded, never deleted);
  - an audit row records who, when and why.
- **Owner decisions:**
  - **Who may make new data current:** exactly who may approve an import today. That is what
    `canApproveGpexeImport` (`backend/src/gpexeImportAccess.js`) and `training_load.lock_gpexe_import_approver` (v23)
    accept, checked again inside the transaction, on a retry too:
    - an active platform admin; or
    - an active user with an unrevoked approver grant for that team, who still holds an active team-coach role there.

    Not every team coach. Starting a check keeps today's right.
  - **What is overwritten:** only imported values. Manual corrections and phase 10 estimates in that session stay.
- **Notes for the contract** (agreed by the executor and the *Rukovodilac*; not owner decisions):
  - R1 is a new decision inside the existing approval flow (preview → `changesToImported` → approve), not a separate
    flow;
  - "no limit" means no business limit. These still apply:
    - the 429 / rate-limit rules;
    - one running check per team;
    - `docs/ai/gpexe-connection-cooldown-plan.md`;
  - a session is read only after a list of the same adapter instance classified it as a parent
    (`session_not_listed`). So the re-import:
    - reads the list for that session's day, with the look-back day and `WINDOW_FILTER_MARGIN_DAYS`, twice and
      classified as today;
    - then reads that one session.

    No safety rule changes.
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
