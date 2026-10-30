# Plan: Metrics Core and canonical variables, phases 0–12 and R1

Status: **adopted by the owner on 2026-10-26**, in the executor's chat: „ok: plan v2 sa R1, zelena zona, revizori,
prenete odluke za fazu 10 i R1; D1, D3–D5, D8–D12 ostaju preporuke.”

It covers:
- the canonical variables, and renaming and archiving them (R2, phases 2b and 2c);
- the source-field lifecycle;
- the rest of M2 and M4;
- the manual corrections and estimates (phase 10);
- the derived canonical variables (phase 11);
- the domains and categories of canonical variables (phase 12);
- the re-import of a session (R1).

This file is a memory file (`.claude/rules/memory-maintenance.md`). A change of a phase, a gate or a decision
recorded here is a plan change and needs the owner (section 2).

**Sources.** The plan was drafted on 2026-10-26 by the planning and review session (*Rukovodilac*) as "PLAN FAZA v2".
The same day the owner added three things to it:
- phase 10 (manual corrections and estimates), which replaces the optional M5 phase;
- R1 (re-import of a session);
- the decisions recorded in section 5 and in `docs/ai/phase10-estimates-decisions.md`.

Added after the adoption, the same day: R2 (phases 2b and 2c), the executor as the one who merges and the exception of
PR #221 (section 1), and the standing merge order for PRs without a migration (section 2). Added on 2026-10-27: the
working mode (section 1), phase 11, derived canonical variables, and phase 12, domains and categories of canonical
variables (section 5). Added later on 2026-10-27 (PR #240): the v39 / v40 contract, accepted as the *Rukovodilac*
reads the owner's words and confirmed by the owner's own merge of PR #240 (phase 4, C100 of the discovery document),
Q10 part B as its own migration v40 (section 6), and the record of PR #238's merge as a one-off departure (section 2).
Added on 2026-10-28: the Done entry of phase 4 (section 5) and the Q10 part B line of section 6 marked done; later the
same day, phase 12's accepted contract (C101, section 5) and the Done entry of 12b (section 5); later still, the Done
entries of 12c and phase 6, the owner's decision of phase 5 (C102, section 5), and the Data configuration visual polish
task (section 6); then phase 5b ★★ with its migration v42 (C103, section 5); later still, the owner's guidance for the
Data configuration screens and on sources and users (section 6), its line in phases 8 and 11 (section 5), the future item
of a private coach's own source and variables (section 6), and PR-1's merge (section 6). Added on 2026-10-29: the Done
entry of phase 5b with its deploy facts (section 5), and the merges of PR-2 and the language pass with PR-1's deploy
(section 6); later the same day, in phase 7 (section 5), the owner's words of C104, the Done entry of 7a and the accepted
contract of 7b (J8) with its gate line. Added on 2026-10-30: the Done entry of 7b and 7a's deploy (section 5), and the
deploys of PR-2 and the language pass and the Done entries of PR-1b and PR-1c (section 6).

The text below follows those sources. Where it records an owner order that departs from a project rule, it quotes the
order and names the rule (section 2).

Last verified against commit: `deb2aa1` (`origin/main`, merge of PR #217). The references to
`docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*) and to
`docs/ai/phase5a-discovery-and-contract.md` are to that commit. What was added on 2026-10-27 (the working mode, the
Done entries of phases 2b and 2c, phases 11 and 12, the Q10 line of section 6) was checked against `fdc2c2e` (merge of PR
#237); what PR #240 added, against `b358dae` (merge of PR #238); the Done entry of phase 4, against `290b6cf` (merge of
PR #241); phase 12's contract line, against `d96936c` (merge of PR #242); the Done entry of 12b, against `9361fff` (merge
of PR #247); the Done entries of 12c and phase 6 and phase 5's decision, against `cf387f2` (merge of PR #251); phase
5b, against `0b947ab` (merge of PR #252); the owner's guidance of 2026-10-28 and PR-1's merge, against `0e38ae9` (merge of
PR #256); phase 5b's Done entry and the merges of PR-2 and the language pass, against `00b3958` (merge of PR #263); phase
7's lines of 2026-10-29 (C104, 7a, 7b), against `aaf150a` (merge of PR #269); the entries of 2026-10-30, against
`70e9e2b` (merge of PR #287).

## 1. Who does what

| Role | Session | Does |
|---|---|---|
| Owner | — | Decides. Every red-zone step is the owner's, case by case (section 2). |
| Executor | the main Claude session of `CLAUDE.md` | The only writer: code, migrations, documents, branches, Draft PRs. Runs the internal reviewers by the orchestration matrix of `CLAUDE.md`. Makes every merge into `main`, on the owner's order or under the standing merge order, after checking it (section 2). |
| *Rukovodilac* (planning and review) | `session_01MCgqwiexBgNEBaMKskhbTZ` | Plans and leads the phases. Reviews every phase and gives GO or NO-GO on an exact head. It is the designated external reviewer for the five triggers of `CLAUDE.md` (owner: „… revizori …” in the adoption above). Relays the owner's words (section 2). |
| *Nezavisni revizor* (independent reviewer) | `session_01YC2kSvwQcRiYteWE268sNf` | A third review of the ★★ phases (2b, 4, 7, 9, 10, 11 and R1). Its packet carries no conclusion of the *Rukovodilac*. Disagreements between the two reviewers go to the owner. |

The third reviewer is the owner's order of 2026-10-26, written in the *Rukovodilac*'s chat: „treći revizor za ★★
faze to je ok. Otvori sesiju nezavisni revizor a svoj naziv promeni u rukovodilac”.

Both review sessions are read-only toward the repository, its pull requests and every persistent database; each may
create and drop its own disposable test databases. A finding they report is text for the executor to act on
(`CLAUDE.md`, "Model pisanja: jedan writer").

**Who merges.** The executor makes the merges: the owner, 2026-10-26, „Slažem se sa tobom idemo za sada tako pa ćemo
menjati ako bude potrebe”, answering the *Rukovodilac*'s proposal „… merge radi izvršilac”. There were two exceptions,
and no further one is made without a new owner decision:
- the *Rukovodilac* merged PR #219, on the owner's order in its chat;
- the *Rukovodilac* merged PR #221 (`16ef080`). The executor had objected (A4). The *Rukovodilac* put that objection
  and its own withdrawal to the owner, with two ways to merge (its turn `e59be7a4`, 22:56:28 UTC). The owner answered
  in its chat: „Mozes li ti to da radiš umesto mene” (owner turn `08c126f2`, 22:59:10 UTC). The *Rukovodilac* took
  that answer as an order and merged the PR. Phase 0 records it.

**Working mode from 2026-10-27.** The owner wrote it in both chats:
- in the executor's chat (owner turn `368a1613`, 11:43:40 UTC): „Idemo dalje po fazama šta ti rukovodilac pošalje. Ne
  zovi me u pomoc vec koriguj sam u saradnji sa Rukovodiocem, samo za krupne stvari me šalji da me rukovodilac
  kontaktira. Izvršilac i revizor treba da radi po naređenju Rukovodioca”;
- in the *Rukovodilac*'s chat (owner turn `d6d20626`, 11:43:52 UTC): „Idemo dalje po fazama svakako. Ne zovi me u
  pomoc vec koriguj sam, samo za krupne stvari me kontaktiraj. Izvršilac i revizor treba da radi po naređenju
  Rukovodioca. Poslao sam i izvršiocu ovako”.

So:
- the phases run in the order the *Rukovodilac* sets;
- findings are corrected between the executor and the *Rukovodilac*;
- the executor and the *Nezavisni revizor* take their tasks from the *Rukovodilac*. The *Nezavisni revizor*'s packet
  still carries no conclusion of the *Rukovodilac* (the table above);
- the owner is contacted through the *Rukovodilac*, for „krupne stvari” (the big things).

No gate of this plan changes: the red zone of section 2, "Never by relay" (approvals given directly in the executor's
chat) and the owner's short report after every phase stay as written.

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
  - a change of scope or of this plan (a "Done" entry or the deploy facts of a finished phase aside, section 2).
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
    - (b) the diff touches none of:
      - `backend/src/migrate.js`;
      - the `scripts` block, the dependencies or a lockfile of `package.json`, `backend/package.json` or
        `frontend/package.json`. npm lifecycle hooks such as `prestart` run at Render's build and start, and Render
        crons run the `media:cleanup` and `gpexe:retention` scripts and the two notification worker scripts;
      - `frontend/vite.config.js`, and any file that defines the Render build or start (`render.yaml`, a
        `Dockerfile` or a `Procfile`, if one is added);
      - the CLI entry points those scripts name (`backend/src/*Cli.js`) and the modules they call;
      - the start-up block of `backend/src/server.js`, every job or timer it starts (`startGpexeRetentionSchedule()`
        today), and the modules those jobs call;
      - `.github/**`;
    - (c) it changes neither the default nor the reading of a switch that gates writes in production (for example
      `GPEXE_IMPORT_APPLY_ENABLED` or `MEDIA_STORAGE_ENABLED`);
    - (d) it adds no SQL `CREATE`, `ALTER`, `DROP` or `TRUNCATE` to `backend/src/` (today only `migrate.js` holds
      such text).

    If (b), (c) or (d) is touched, the PR is covered only when its body says what then runs at build, start-up or on
    a schedule and why it writes nothing to production data, and the GO confirms that. The GO records the result of
    (a).
  - **The GO.** The *Rukovodilac* gave GO naming the PR, the exact head and the base, and saying „no migration” and
    „risk low”. The executor finds that GO as the *Rukovodilac*'s own turn in the session named in section 1, after
    the frozen head, and records its event id and its words in the PR body before the merge. A GO it cannot find there
    is not a GO.
  - **The base.** `main` is still at the base the GO names. Otherwise the checks (a) to (d) are run again on the new
    base, and the *Rukovodilac* confirms the GO on it, found and recorded the same way.
  - **A ★★ phase** (the list in section 1). The *Nezavisni revizor* gave its own GO on the same head, on a packet
    without the *Rukovodilac*'s conclusion, found the same way in its session (section 1).
  - **No open finding.** No BLOCKER or HIGH is open, and no reviewer disagrees.
  - **The head.** The merge is made from exactly that head (`expectedHeadSha` / `--match-head-commit`).
- **What follows.** The merge is also the deploy to `optimove-eu` (below). The smoke of section 4 follows, and the
  owner gets the short report of the phase. If the smoke fails, no further merge is made under this order until the
  owner has decided how to go on.
- **What it does not allow.**
  - A PR with a migration: it always needs the owner's order that names the migration (below).
  - A PR that changes this file, except one that only adds a "Done" entry or the deploy facts of a finished phase in
    section 5. It needs the owner's word naming the PR, given after the GO on its final head; a new commit voids it.
  - A PR that changes sections 1 to 4 of this file, the marks and gate lines of section 5 ("Never by relay", below),
    `approval-channel.md`, `CLAUDE.md`, `.claude/**`, `.github/**`, a setting or a permission. It needs the owner's
    word naming the PR, given after the GO on its final head (a new commit voids it), and only directly in the
    executor's chat; or the owner merges it personally.
  - An owner's instruction to write such a change authorizes writing it and opening its Draft PR only, never its
    merge.
  - A PR that changes `PROJECT_CONTEXT.md` or `docs/ai/CURRENT_STATE.md`, which `CLAUDE.md` imports, is covered only
    while it records facts: merges, deploys, tests, code. A sentence that states an owner decision, an approval, an
    order, a permission or a rule of work needs the owner's word, as for `CLAUDE.md`.
  - A PR that records an owner decision, in any file, is covered only when its body carries the owner's verbatim
    words and their event id. The executor checks them by the relay's minimum check (below), and the GO confirms
    them.
  - Bringing `main` into a branch, any other merge, or any other red-zone step.
- **A disagreement** between the executor and the *Rukovodilac*, or between the two reviewers, goes to the owner; the
  PR is not merged until the owner decides (A4).
- **When it is in force.** From the merge of this section into `main`, for the executor of this plan, until the owner
  changes or revokes it. It is not limited to one session: the owner called it „Trajni nalog”, and wrote in the
  *Rukovodilac*'s chat the same evening „Ja nebih ni ok da dajem ako moze samo tamo gde moram” (owner turn
  `89785102`, 23:01:23 UTC). A revocation or a „stop” is followed at once, whatever channel it comes through.

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
- A relayed approval covers the one case it names (the standing merge order is a direct order of its own). Adopting
  the plan is not an order to merge.
- The owner may still write any approval directly in the executor's chat.
- **When the relay is in force:** in the executor session where the owner typed the order. A later executor session
  uses it only once `approval-channel.md` is merged, or after the owner repeats the order in that session.
- **Never by relay:** a change to sections 1 to 4 of this file, to the ★ / ★★ marks and the "Input (red zone)",
  "Red zone" and "Start" lines of section 5, to `approval-channel.md`, to `CLAUDE.md`, `.claude/**`, `.github/**`, a
  setting or a permission, and the merge of a PR that makes such a change. These are approved only directly in the
  executor's chat, or by the owner merging personally.
- **PR #238, a recorded departure, not a precedent** (2026-10-27).
  - PR #238 changed section 1 and section 5's gate lines. Under "Never by relay" above, its merge needed the owner's
    word directly in the executor's chat, or the owner merging personally.
  - It was merged (`b358dae`) on two owner turns in the *Rukovodilac*'s chat, each checked by the executor with
    `get_event`:
    - `e59003dd`, 14:33:31 UTC, `desktop_app`: `Odobravam merge PR #238.“ O1–O9 (dovoljno „sve po preporuci“).`
    - `58ef3d24`, 17:32:55 UTC, `android`: `Odobravam, nema potrebe da me pitas`. It answers the *Rukovodilac*'s
      message telling the owner the executor was waiting for the same sentence in its chat.
  - The departure was the *Rukovodilac*'s decision (its message `c9cb6a1a`, 17:33:33 UTC), after that answer.
  - It is a one-off and not a precedent: "Never by relay" above stands as written.
  - The full record is in PR #238's description. Both event ids are in its merge commit message.

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
- **Done, 2026-10-26.**
  - Reviews: the *Rukovodilac* gave GO on `5ef3334`.
  - Merge: `16ef080` (parents `7a9e59d` and `5ef3334`), by the *Rukovodilac*. This departs from the rule above. It
    was the owner's own exception for this PR only, with the words recorded in section 1 ("Who merges"), and it does
    not change that rule for any other PR.
  - Deploy: `/api/health` served `16ef080` with `ok: true` three times in a row (23:01:37, 23:01:47, 23:01:58 UTC).
    Docs only; nothing else changed.

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
- **Done, 2026-10-26.**
  - `main` brought in: merge commit `0442655` (parents `d167231`, `16ef080`). The *Rukovodilac* proposed it in its
    chat at 22:13:40 UTC („merge main u granu #218; …”), and the owner accepted that proposal: „Slažem se sa tobom
    idemo za sada tako pa ćemo menjati ako bude potrebe” (owner turn `92449c5f`, 22:16:26 UTC).
  - Integration QA on the real API on disposable databases through v37: the executor's run and the
    *Rukovodilac*'s own run passed on `6436461`; the record is in PR #218.
  - Reviews: `code-reviewer` READY on `6436461`; the *Rukovodilac*'s GO on `6436461`, risk low.
  - Merge: `6c7dfa4` (parents `16ef080` and `6436461`), 23:31:43 UTC, made by the executor after that GO; the record
    is in PR #218's description.
  - Smoke: `/api/health` served `6c7dfa4` with `ok: true` three times in a row (23:33:01, 23:33:11 and 23:33:22
    UTC); without a login the five variable routes answered 401. No migration, no production write.

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
  preflight and post-check scripts. It is v38, and phase 4 is v39: the owner accepted that numbering with the R2
  contract, „ok ugovor 2b, Q10 ne” (in the *Rukovodilac*'s chat, owner turn `bf9dce82`, 2026-10-27 06:34:26 UTC).
- **Archiving a pinned variable:** the v34 guard (decision 9) already refuses it; the API answers it as
  `409 variable_pinned`, as for a new version.
- **Decision record:** the coach as an administrator of club variables changes the audience of the M3-0 admin API
  (C80 / C88). Before the code, it is written into section C of the discovery document as a new decision (A3).
- **Reviewers:** `db-reviewer`, `security-reviewer`, `code-reviewer`, and the external review of the *Rukovodilac*
  and the *Nezavisni revizor* (triggers 1, 2 and 4).
- **Red zone:** the production preflight, merge (and so deploy and migration, by an order that names it), the
  production post-check.
- **Done, 2026-10-27.**
  - The contract: PR #224, merge commit `e8e2b0a`, 07:16:18 UTC.
  - The implementation: PR #227 (migration v38). `db-reviewer`, `security-reviewer` and `code-reviewer` reviewed
    `8f999b5`, and their notes were applied at `ae92c2e`.
  - The *Rukovodilac*'s GO on `ae92c2e` (08:37:30 UTC) and the *Nezavisni revizor*'s GO on the same head
    (08:38:37 UTC). Neither found a BLOCKER, HIGH or MEDIUM.
  - The owner's read-only preflight: all nine blocks as expected.
  - The owner's answer to the merge question, in the *Rukovodilac*'s chat:
    - the *Rukovodilac* asked at 09:48:32 UTC: „Ako ste saglasni, napišite ovde ili izvršiocu, na primer:
      „Odobravam merge PR #227 sa migracijom v38.“”;
    - the owner answered „uvek odobravam ako si procenio da je za merge” (owner turn `b4be10e9`, 09:49:00 UTC) and
      „i deploy” (owner turn `ddaf4d1c`, 09:49:04 UTC).
  - **The gap.** The owner's words do not name PR #227, its head or v38. They answer the *Rukovodilac*'s question,
    which named both.
    - The *Rukovodilac* and the executor treated them as covering this PR and v38 only, and the executor merged on
      them.
    - The minimum check of section 2 asks that a relayed quote name the action and its object (for a migration:
      the migration). This answer did not meet that check, and the executor did not stop on it.
    - Whether the owner confirms the merge as the order for v38 is the owner's decision. The executor reported the
      gap to the *Rukovodilac* the same day.
    - How the merge was authorized is recorded in PR #227's description.
  - **The owner's confirmation after the merge.** The *Rukovodilac* reported the gap to the owner and asked (its
    message `184bc907`, 11:47:13 UTC): „Molim Vas za naknadnu potvrdu jednom rečenicom, na primer: „Potvrđujem merge
    PR #227 sa migracijom v38; pregled revizora sam video.“”. The owner answered „Potvrđujem” (owner turn
    `9bab5d28`, 11:47:53 UTC, in the *Rukovodilac*'s chat).
    - It is recorded as the owner's confirmation, after the fact, of the sentence the question gave: the merge of
      PR #227 with migration v38, the reviewers' review seen. The word itself names neither the PR nor v38.
    - Since then, for every migration the *Rukovodilac* asks the owner for a sentence that names the PR, its head
      and the migration. Without one, the *Rukovodilac* and the executor stop (section 2's minimum check).
  - Merge: `e556d08` (parents `e8e2b0a` and `ae92c2e`), 09:51:13 UTC, made by the executor from exactly
    `ae92c2e`. The record is in PR #227's description.
  - Smoke: `/api/health` served `e556d08` with `ok: true` three times in a row (09:52:18, 09:52:29 and 09:52:39
    UTC). Without a login the eight variable routes, rename, archive and restore among them, answered 401.
  - Post-check: the owner ran `docs/runbooks/metric-variable-changes-v38-postcheck.sql` and reported „sve
    potvrdjeno na post tetiranju” (owner turn `4a94e035`, 11:39:15 UTC, in the *Rukovodilac*'s chat). The values
    of the eight blocks were not pasted.

### Phase 2c ★: R2 in the Variables tab (frontend), after 2b is merged
- Rename, archive and restore in the Variables tab, for the rights of 2b.
- **Reviewers:** `code-reviewer`, `mobile-qa`, `ux-design-reviewer`.
- **Red zone:** merge, deploy, smoke.
- **Done, 2026-10-27.**
  - PR #237: frontend and docs only, no migration. As built: section H and J3b.10 of the discovery document.
  - The *Rukovodilac*'s three remarks on the executor's screen plan (its message of 12:31:51 UTC) are built in:
    - a team workspace gets the Variables view only;
    - a saved name the form cannot show exactly is read only until the user replaces it;
    - a `409 variable_changed` keeps the form open on the names saved now.

    `ux-design-reviewer` accepted both form decisions.
  - Reviews:
    - `code-reviewer`, `ux-design-reviewer` and `mobile-qa` on `10ae177`, each READY WITH NON-BLOCKING NOTES;
      their four MEDIUMs were fixed at `3569098`;
    - narrow re-reviews on `3569098`, each READY WITH NON-BLOCKING NOTES; one new MEDIUM (`mobile-qa`, the action
      grid at 456–760 px) and the LOWs were fixed at `3a3575f`.
  - Evidence:
    - 35 frontend mutations, all killed;
    - the executor's integration and browser QA on a disposable database migrated through v38, 70/70;
    - the *Rukovodilac*'s own browser integration, 22/22.

    Not checked on a physical device.
  - The *Rukovodilac*'s GO on `3a3575f` (its message `74585bb4`, 13:32:09 UTC), with no finding.
  - Merge: `fdc2c2e` (parents `a1bb932` and `3a3575f`), 13:33:13 UTC, made by the executor under the standing
    merge order. The record is in PR #237's description.
  - Smoke:
    - `/api/health` served `fdc2c2e` with `ok: true` three times in a row (13:34:05, 13:34:16 and 13:34:27 UTC);
    - without a login the eight variable routes answered 401;
    - the served bundle carries the phase 2c texts.

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
- **Done, 2026-10-26.**
  - PR #223 (`CURRENT_STATE.md` and the discovery document; it also closed the *Rukovodilac*'s LOW-1 of #218).
  - Reviews: `code-reviewer` READY on `df0a520`; the *Rukovodilac*'s GO on `df0a520`, risk low.
  - Merge: `e489eeb` (parents `6c7dfa4` and `df0a520`), made by the executor after that GO; the record is in PR
    #223's description.
  - Smoke: `/api/health` served `e489eeb` with `ok: true` three times in a row (until 23:47:26 UTC); without a login
    the variable routes answered 401.
  - The v37 post-check was not recorded; it stays with phase P (recorded since: phase P, Done 2026-10-27).

### Phase P: in parallel, the owner only (red zone, no code)
- The read-only v37 post-check (`docs/runbooks/source-metric-revision-guards-v37-postcheck.sql`); the owner reports
  PASS or FAIL per block. It is a gate of phase 4.
  - **Done, 2026-10-27:** passed, by the owner's statement (owner turn `38f0b6d6` in the *Rukovodilac*'s chat,
    14:42:12 UTC, verbatim in C100 of the discovery document). It is recorded as a statement; no block values were
    pasted.
- The evidence for the nine `rest_v1` fields (C97, the table of J4). The executor may only prepare the procedure; it
  sends no GPEXE request.

### Phase 4 ★★: the revision lifecycle (C91) and Q10 part B, migrations v39 and v40
- **Input (red zone, before any code):**
  - owner decisions on the following, answered on 2026-10-27 as the *Rukovodilac* reads the owner's words (C100),
    confirmed by the owner's own merge of PR #240:
    - who may create revision R+1;
    - activating R+1;
    - retiring R;
    - what happens to the T4 versions and T5 activations pinned to R (automatic or manual replacement);
    - whether a given confirmation is voided;
  - the v37 post-check PASS (phase P): closed, by the owner's statement (C100);
  - the old Render service clarified (phase 1, b): closed (C100). It runs on Supabase, is inactive and is no longer
    deployed; it stays inactive during and after the deploy of v39 and v40.
- **Green zone:**
  - a separate discovery delta document, as the proposed contract (J5); accepted on 2026-10-27 as the *Rukovodilac*
    reads the owner's words (C100), confirmed by the owner's own merge of PR #240;
  - after the owner's decision, the implementation: v39 with database actor guards (C76), its rollback, and the
    read-only preflight and post-check scripts; and v40, Q10 part B, as its own migration with its own rollback,
    preflight and post-check (R5 of C100);
  - the M1 / M2 / v35 / M3-0 / M2b suites no longer switch off the v37 T2b triggers but write the real way.
- **Acceptance:**
  - the rollback is rehearsed (apply → rollback → identical catalog → re-apply);
  - every guard has a mutation the tests kill;
  - concurrency of a revision against the M2 version create and the F2 / F3 acts, in both orders;
  - none of the nine seeded fields changed;
  - tests on PostgreSQL 16 and, where possible, 17.
- **Reviewers:** `db-reviewer`, `security-reviewer`, `code-reviewer`, and the external review (triggers 1, 2 and 4).
- **Red zone:** the production preflight, merge (and so deploy and migration), and the production post-check of v39
  and v40.
- **★★:** the owner approves the contract (J5) before any code and confirms the external review before the merge.
  The contract was accepted on 2026-10-27 as the *Rukovodilac* reads the owner's words (C100), confirmed by the
  owner's own merge of PR #240.
- **Done, 2026-10-28.**
  - The implementation: PR #241 (migrations v39 and v40, routes L1-L5; J5 of the discovery document as built).
    `code-reviewer`, `security-reviewer` and `db-reviewer` reviewed `ac9a02d`. Their notes were applied at `d0282d4`,
    with one exception: the pinned step's missing cap stays a known limit, for an owner decision before M6.
  - Applying them added one change to the accepted contract: L2 and L5 take `expectedState` (the `db-reviewer`'s
    MEDIUM). The *Rukovodilac* accepted it with its GO.
  - Both reviews were on `d0282d4`, and neither found a BLOCKER, HIGH or MEDIUM:
    - the *Rukovodilac* gave GO (23:57 UTC, 2026-10-27);
    - the *Nezavisni revizor* answered READY WITH NON-BLOCKING NOTES (23:58 UTC, 2026-10-27).
  - The owner's read-only preflights of v39 and v40 came back as expected. The owner reported them as „Sve ocekiano”
    (owner turn `5ce31b89`, 08:35:10 UTC, in the *Rukovodilac*'s chat); the values were not pasted.
  - The owner's order: „Odobravam merge PR #241 sa migracijama v39 i v40.” (owner turn `131af6a6`, 08:40:05 UTC,
    in the *Rukovodilac*'s chat; the same sentence with a typo at 08:39:53 UTC). It names the PR and both
    migrations. The executor checked the quote in the *Rukovodilac*'s transcript before the merge.
  - Merge: `290b6cf` (parents `0c7104c` and `d0282d4`), 08:41:38 UTC. The executor made it from exactly `d0282d4`,
    and its tree is identical to that head.
  - Smoke (the *Rukovodilac*): `/api/health` served `290b6cf` with `ok: true` three times in a row (08:42:44, 08:43:05
    and 08:43:25 UTC). Without a login the variable, mapping, field and revision routes answered 401, and
    `/api/auth/me` answered `{"user":null}`.
  - Post-check: the owner ran both post-check scripts and reported „Sve ocekivano” (owner turn `90c9d21f`, 08:54:13
    UTC, in the *Rukovodilac*'s chat). The values were not pasted, so v39 and v40 are confirmed by the owner's
    statement.
  - Acceptance "tests on PostgreSQL 16 and, where possible, 17": only 16 was run. The owner's post-checks are the
    check on production's 17.6.

### Phase 5: the zone model (C89)
- An owner decision only; the executor prepares the variants.
- **Red zone:** the decision. If it needs a schema, that is a separate ★★ phase on the pattern of phase 4.
- **The variants:** `docs/ai/phase5-zone-model-options.md` (PR #250, merged as `ae29b08` under the standing order after
  the *Rukovodilac*'s GO on `d80ca8f`, which added one LOW sentence for option A).
- **Decided, 2026-10-28** (C102 of the discovery document):
  - The owner's words: „po preporuci neka ide, koji je last comit koji treba da uradim deploy” (owner turn `bfad63ba`,
    16:15:39 UTC, in the *Rukovodilac*'s chat). The executor checked the quote in the *Rukovodilac*'s transcript.
  - The *Rukovodilac* reads them as Z1–Z4 accepted as recommended: option A (one source field per zone shape); the new
    field `more.complementary_data.power.distance.open_top`, "Power zone distance (open top zone)"; a zone's meaning
    act confirms `between` or `>=`, `>` only with evidence; each zone field needs owner-run evidence as in C97.
  - Option A needs a schema, so it is a separate ★★ phase on the pattern of phase 4: its contract (the seeding
    migration, v37's zone refusal replaced, F3's change, the zone operator in the phase 6 form, rollback, preflight,
    post-check and tests) goes as a document to the *Rukovodilac* and the *Nezavisni revizor*, then to the owner for
    approval before any code. Until its migration is merged and deployed, C89's refusal stands.

### Phase 5b ★★: the zone model, option A — migration v42
- **The contract (J7):** `docs/ai/phase5-zone-model-contract.md`, accepted on 2026-10-28 (C103 of the discovery
  document).
  - The *Rukovodilac* and the *Nezavisni revizor* gave GO on `8c2b383`. The *Rukovodilac* decided P1–P6 inside the plan.
  - The owner approved the contract as a whole: „Slažem se po preporuci idi” (owner turn `cfeac86e`, 2026-10-28 21:58:15 UTC, in the *Rukovodilac*'s chat; the *Rukovodilac* reads it as the approval of the contract as a whole, which is its reading, not the owner's own words).
  - The owner gave this phase its ★★ and its gate line by their own word in the executor's chat or by their own merge
    of the pull request that adds them.
- **Green zone:** after the acceptance, the implementation in one pull request:
  - migration v42, its rollback, and the read-only preflight and post-check (J7 section 3);
  - F3's change (J7 section 4);
  - the zone operator choice in the phase 6 meaning form (J7 section 5);
  - the documents, including the `.open_top` rows of J4 and C97.
- **Acceptance:** J7 section 6, including:
  - the rollback rehearsed (apply → rollback → identical v41 catalog with `obj_description` → re-apply);
  - every guard with a mutation the tests kill;
  - the end-to-end proof through M2;
  - browser QA at 1280 / 390 / 375 / 360 px.
- **Reviewers:** `db-reviewer`, `security-reviewer`, `code-reviewer`, `mobile-qa`, `ux-design-reviewer`, and the external
  review (trigger 1).
- **Red zone:** the production preflight, the merge (and so the deploy and the migration), and the production post-check
  of v42.
- **Gate line: migration v42.** Its merge needs the owner's own order naming the pull request and v42.
- **Done, 2026-10-29.**
  - PR #259 (branch `feature/phase5b-zone-model-v42`, from `0eb7e10`): migration v42 is exactly
    `migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql`, sha256
    `042445620eade972e9940667c4777469a5e9d22f3d9b551d1d4b64bbdb610af1`. J7 "As built" in the discovery document
    records it.
  - Reviews: the five internal reviews READY after their fixes; the *Rukovodilac*'s GO ★★ on `9c6c6f0` (its message
    queued at 09:03:38 UTC) and the *Nezavisni revizor*'s GO on `9c6c6f0` (09:24:22 UTC), with no BLOCKER, HIGH or
    MEDIUM. The record is in PR #259.
  - The owner's words, in the *Rukovodilac*'s chat; the executor checked each turn in the *Rukovodilac*'s transcript:
    - the preflight, the same day: „sve je očekivao, blok 7 su nule” (owner turn `da2c6b11`, 09:52:58 UTC): all nine
      blocks as expected, block 7 zeros, and `v34_fingerprint` recorded for the post-check;
    - the order: „Odobravam PR #258 i naređujem merge PR #259 sa migracijom
      202610282300_training_load_v42_source_metric_zone_model.sql.” (owner turn `3caae47b`, 09:53:47 UTC);
    - the post-check: „sve ocekivano” (owner turn `62bfdb8e`, 12:31:48 UTC). As the *Rukovodilac* reports it: all
      seven blocks as expected, and `v34_fingerprint` equal to the preflight's.
  - Merge: `ed86ca8` (parents `0eb7e10` and `9c6c6f0`), 09:59:59 UTC, made by the executor exactly from `9c6c6f0`.
  - Deploy: by the owner by hand. Production got `d9a02ad8` (the merge of PR #262, which holds `ed86ca8` and PR #258's
    `9101971`); a deploy of `9101971` as such never existed.
  - Smoke (the *Rukovodilac*): production was first seen on `d9a02ad8` at 11:09:48 UTC, and `/api/health` answered
    `ok: true` on it three times (11:10:11, 11:10:11 and 11:10:12 UTC). Without a login `/api/auth/me` answered
    `{"user":null}`, and the metrics variables, classification, fields and mappings reads, the GPEXE team status,
    the GPEXE source connections and `POST …/classification/links` with `{}` answered 401. The served bundle carries the
    v42 zone texts.
  - **v42 is directly confirmed on the production database** by the owner's post-check. The local OPTIMOVE database
    is untouched.
- **★★:** the owner approved the contract (J7) before any code and confirms the external review before the merge.
- **Not in it:** the owner-run evidence and the first real confirmation of a zone field (a separate order, C97); 7f's
  rule "key → zone shape"; M4.

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
- **Done, 2026-10-28.**
  - PR #251: frontend only, no migration. As built: section H and J4 of the discovery document. The revision lifecycle
    (L1–L5) has no UI in it, as the plan scopes phase 6; the *Rukovodilac* confirmed it.
  - Reviews:
    - `code-reviewer`, `ux-design-reviewer` and `mobile-qa` on `479489b`. The UX review found six MEDIUM: closing
      refusals looked like a success; a `404`'s outcome; a stale field; the forms' context; no last question before
      the write-once act; the evidence badges. `mobile-qa` found one MEDIUM: states not measured on phones;
    - all were fixed at `ffce389`, with tests and browser evidence; the narrow re-reviews closed them (code READY, UX
      READY WITH NON-BLOCKING NOTES, mobile LOW only).
  - Evidence:
    - 26 frontend tests and 13 mutations, all killed;
    - the executor's integration and browser QA on a disposable database migrated through v41 with v34's nine seeded
      fields, 82/82;
    - the *Rukovodilac*'s own browser integration, 23/23, and its own 9 mutations, all killed.

    Not checked on a physical device.
  - The *Rukovodilac*'s GO on `ffce389` (its message queued at 16:17:18 UTC), with no BLOCKER, HIGH or MEDIUM and two
    LOW:
    - the first field's autofocus opens the phone's keyboard; it stays, as in the Variables forms;
    - a field's current revision is its active one, otherwise the first the server lists; with exactly one active
      revision per field today this has no effect, and the lifecycle UI must choose the newest explicitly.
  - Merge: `cf387f2` (parents `ae29b08` and `ffce389`), 16:17:34 UTC, made by the executor under the standing merge
    order from exactly `ffce389`.
  - Deploy: by the owner by hand, as `0b947ab` (with PR #252).
  - Smoke (the *Rukovodilac*): `/api/health` first served `0b947ab` with `ok: true` at 20:44:24 UTC, then five more times in a row until 20:45:34 UTC (`ae29b08` before). Without a login six protected routes answered 401, and
    `/api/auth/me` answered `{"user":null}`. The served bundle carries the Source fields screen.
  - For the owner (a choice, not blocking): the last question is a native `confirm()`, as Bind, Reconnect and Unbind
    use; a review step inside the form is the alternative.

### Phase 7 ★★: the rest of M2, several PRs, each with its own guard migration (C76)
- **Order:**
  - 7a: the access helper extracted, no behaviour change;
  - 7b: T4 activate, disable and replacement;
  - 7c: `unit_conversions` maintenance;
  - 7d: T5 activations;
  - 7e: the aggregate preview;
  - 7f: the extractor registry;
  - 7g: ending a held instance (D9 of the discovery document).
- **The owner's words, 2026-10-29** (C104 of the discovery document): „A1 DA, I SVE PO PREPORUKAMA” (owner turn
  `f505ec21`, 13:32:57 UTC, in the *Rukovodilac*'s chat; the executor checked it in the transcript).
  - A1, the owner's own word „DA”: 7a may come before the acceptance of 7b's contract, although phase 7 is ★★
    (section 3, A1).
  - The *Rukovodilac* reads „sve po preporukama” as the acceptance of 7b's contract (J8) as a whole and of its questions
    Q1, Q2, Q3, Q5, Q6 and Q7 as recommended; that reading is the *Rukovodilac*'s, not the owner's own words. Q4 stays
    open for 7d and 7e.
- **7a, Done, 2026-10-29.**
  - PR #269 (branch `refactor/metrics-access-7a`, from `69d824f`): backend refactor and tests only, with no behaviour
    change and no migration. The context resolver, the right check, the owner keys and the shared error moved from
    `sourceMetricMappingService.js` to `backend/src/sourceMetricAccess.js`; section K of the discovery document marks the
    move done.
  - Reviews: `code-reviewer` and `security-reviewer` READY WITH NON-BLOCKING NOTES, every note applied (the MEDIUM: a
    direct test of the resolver's read of an archived club); then the *Rukovodilac*'s GO on `d626165` (its message
    queued at 13:53:18 UTC): no migration, risk low.
  - Merge: `aaf150a` (parents `b0a839a` and `d626165`), made by the executor under the standing merge order exactly from
    `d626165`; its tree equals the merge simulated before it.
  - Deploy: not yet when this entry was written; production was last seen on `00b3958`. Deployed since with `62090a6`
    (production served it at 16:12 UTC on 2026-10-29, the *Rukovodilac*'s read).
  - Left for before T5 (7d): the remaining copies `isOwn`, `readableSql` / `ownSql`, `ownerFilter` / `writableSql` and
    `resolveVariableEditor`.
- **7b, the contract (J8):** `docs/ai/phase7b-mapping-transitions-contract.md`, accepted on 2026-10-29 (C104).
  - The *Rukovodilac* and the *Nezavisni revizor* gave GO on `f9f6bec` (PR #266, `69d824f`); the *Rukovodilac* decided
    R1–R8 inside the plan. The acceptance was recorded by PR #268 (`b0a839a`).
  - **Gate line: migration v43.** Its merge needs the owner's own order naming the pull request, the exact migration
    file and its sha256, with the production preflight the same day.
- **7b, Done, 2026-10-30.**
  - PR #273 (branch `feature/metrics-mapping-transitions-7b-v43`): migration v43 is exactly
    `migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql`, sha256
    `b88c1662b4dd2fd0e2ff79886fd49ebe28d9f38236044ecccd5739e6f86af363`. J8 "As built" in the discovery document records it.
  - Reviews: `db-reviewer`, `security-reviewer` and `code-reviewer` READY WITH NON-BLOCKING NOTES, every note applied;
    GO on `fdc584e2` from the *Rukovodilac* (2026-10-29 15:35 UTC) and the *Nezavisni revizor* (15:52 UTC), with no
    BLOCKER, HIGH or MEDIUM.
  - The owner's words, in the *Rukovodilac*'s chat; the executor checked each turn in the *Rukovodilac*'s transcript:
    - the preflight, the same day as the merge: blocks 1 and 3–9 as expected (owner turn `ad289dcd`, 2026-10-30
      09:51:12 UTC);
    - the order: „Odobravam PR #271 i naređujem merge PR #273 sa migracijom
      202610291430_training_load_v43_source_metric_mapping_transitions.sql, sha256
      b88c1662b4dd2fd0e2ff79886fd49ebe28d9f38236044ecccd5739e6f86af363.” (owner turn `e9bf80b0`, 09:51:30 UTC);
    - the post-check: all six blocks as expected (owner turn `ce45421e`, 10:07:29 UTC).
  - Merges by the executor: PR #271 as `51025e4` (09:54:50 UTC), then PR #273 as `5a4c480` (parents `51025e4` and
    `fdc584e2`, 09:56:06 UTC), exactly from `fdc584e2`.
  - Deploy: by the owner by hand, as `5a4c480`. The *Rukovodilac*'s smoke, 10:05:14 – 10:05:15 UTC: `/api/health`
    answered `ok: true` on `5a4c480` three times; `/api/auth/me` answered `{"user":null}`; without a login A1 and A2
    answered 401, and so did the mappings, variables and fields reads and the GPEXE team status.
  - **v43 is directly confirmed on the production database** by the owner's post-check. No mapping version is active
    in production. `CURRENT_STATE.md` holds the full record.
- **7c and 7d, the contracts (J9, J10):** `docs/ai/phase7c-unit-conversions-contract.md` and
  `docs/ai/phase7d-mapping-activations-contract.md`, proposed on 2026-10-30 and reviewed in one ★★ round, as the
  *Rukovodilac* reads the owner's word „ako je sigurnije neka ide kako smo počeli, eventualno 7c i 7d možda u jedan pr”
  (owner turn `dc0796d5`, 2026-10-30 15:56:22 UTC, in the *Rukovodilac*'s chat; the executor checked it in the transcript).
  The implementations stay separate: 7c-B with migration v47, then 7d-B with v48, each merged only on the owner's
  order naming its pull request, migration file and sha256. 7d follows C106 (a club admin also writes T5).
  The contracts were merged as PR #291 (`236cc68`) on the owner's word „Odobravam PR #291.” (owner turn `6b576fa7`,
  17:40:12 UTC), which also confirms C106's breadth.
- **7c, Done, 2026-10-30.**
  - PR #293 (branch `feature/7c-unit-conversions`): migration v47 is exactly
    `migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql`, sha256
    `665ef79f74689eb19fa8a41fad84268c17029aa38c322adaac2f88b841dabd66`. J9 "As built" in the discovery document records it
    (its heading is brought up to date in PR #295).
  - Reviews: the internal reviews, then GO on `6219f056` from the *Rukovodilac* and the *Nezavisni revizor*.
  - The owner's words, in the *Rukovodilac*'s chat; the executor checked each turn in the *Rukovodilac*'s transcript:
    - the preflight, the same day as the merge: „preflight ocekivane vrednosti potvrdjene” (owner turn `eb9fe4e6`,
      18:02:07 UTC);
    - the order: „Odobravam i naređujem merge PR #293 sa migracijom
      202610301700_training_load_v47_unit_conversion_guards.sql, sha256
      665ef79f74689eb19fa8a41fad84268c17029aa38c322adaac2f88b841dabd66.” (owner turn `f5c75f18`, 18:02:27 UTC).
  - Merge by the executor: `69af453` (parents `aa84d574` and `6219f056`, 18:17:43 UTC), exactly from `6219f056`. `main` had
    moved before it by PR #292 (the central calendar's screen: frontend and a plan document, no migration; the two
    merges share no file); on the merge tree the targeted suites passed (7c 18/0, M2 26/0).
  - Deploy: by the owner by hand, as `69af453`. The *Rukovodilac*'s smoke, 18:23:09 – 18:23:30 UTC: `/api/health`
    answered `ok: true` on `69af453` three times in a row; `/api/auth/me` answered `{"user":null}`; without a login the
    conversion list (also with a cursor), the conversion create and retire, the mappings and variables reads and the
    GPEXE team status answered 401.
  - **v47 is directly confirmed on the production database** by the owner's post-check, all five blocks („sve
    potvrdjeno na postcheku”, as the *Rukovodilac* relays it; the block values were not written out). `CURRENT_STATE.md`
    holds the full record.
- **Next by the order above: 7d.** 7d-B (T5 activations, migration v48) is Draft PR #295, under the external review.
- **Input (red zone):** the owner's decisions from section K of the discovery document:
  - the minimum number of athletes for min / max;
  - system or club zone mappings;
  - the preview's fields;
  - the shape of the operation of discovery D9.
- **Reviewers:** the full set by the matrix, and the external review.
- **Red zone:** as phase 4, for every PR.

### Phase 8 ★: M3 Mappings tab, after 7b and 7d
- **Acceptance:** an activation's confirmation names the source, the mapping version, the team and the binding.
- **The owner's guidance** (owner turn `d9a0b800`, 2026-10-28, section 6): „Stim sto ovo mora biti mnogo jednostavnijeg
  za korisnika”.
  - As the *Rukovodilac* reads it (its reading, section 6):
    - this phase's contract holds a guided flow in three steps: choose the field, choose the variable, then confirm
      the unit or the conversion. Where the units are the same, the screen suggests the match;
    - `ux-design-reviewer` gets the owner's sentence as an acceptance criterion;
    - the API stays as it is, and a mapping still needs a confirmed unit: the simplicity is in the guidance, never in
      fewer checks.

### Phase 9 ★★: M4, the importer integration
- Triggers 1, 3 and 4; the five-point rule for transactions; the import switch stays off.
- **Acceptance:** a characterisation test:
  - the same numbers as today, within 1e-9;
  - without an activation, zero values and no write to `metric_definitions`.

M6 follows phase 9. All of it is the owner's and outside the green zone, the standing merge order included.

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

### Phase 11 ★★: derived canonical variables, after phase 9 (may run in parallel with phase 10)
- **Owner, 2026-10-27** (in the *Rukovodilac*'s chat):
  - „Jedno kratko pitanje , da li si predvideo nekako da neke key variable treba da budu suma nekih varijabli”
    (owner turn `55705005`, 11:48:20 UTC);
  - „npr total acc&dec” (owner message `c77a90ab`, 11:48:28 UTC, sent while the *Rukovodilac*'s turn was running);
  - „iz gpexe se uvoze posebno i mogu da se i kod nas ubacuju posebno npr ali mi trebaju i kao total” (owner turn
    `7f53b09a`, 11:48:47 UTC).
- **Owner, 2026-10-28** (in the *Rukovodilac*'s chat, owner turn `269910e0`, received by the server at 23:27:25 UTC;
  section 6): „Takodje mi u budućnosti možemo imati više sources. A različiti korisnici različite sources tako da ce
  svako sebi to povezivati i praviti nove varijable izvedene varijable ako im to treba npr acc i dec total...”.
  - The *Rukovodilac* reads it as the same need this phase records. The place and the order of the phases do not
    change.
  - Its reading also names two things for this phase's contract: provenance in the style of T6, and a screen in the
    coach's language (the owner's guidance in section 6).
- **Who decided what:**
  - The owner's words establish the need: a total of variables that are imported, or entered, separately.
  - The place and the gate below are the *Rukovodilac*'s proposal. Its answer (its message `4731bb25`, 11:48:57
    UTC) asked the owner to choose between this phase after phase 9 and an earlier step, right after phase 2c, as
    sums and quotients for dashboards without storing values. The owner's third message reached the server before
    that answer, and the owner did not answer the choice.
  - The owner approves the place and the gate by approving the merge of the pull request that adds this phase
    (section 2).
- **Builds on:**
  - the owner's decision of 2026-09-17: a value OptiMove computes is never stored as a value GPEXE delivered. Under
    it, `m/min`, `Acc+Dec`, `Burst&brakes`, `HMLD ≥25 W/kg` and `EXPDist ≥60 W/kg` wait for a derived-metrics
    feature with a formula and a formula version (`docs/ai/CURRENT_STATE.md`, the GPEXE pilot import);
  - columns that exist:
    - `training_load.metric_values.is_derived` and `computed_by_ref` (v13);
    - `aggregation_role = 'derived_rollup'`, which requires both
      (`migrations_v2/202609071200_training_activity_v3_metrics_core_extensions.sql`).

    Nothing writes `is_derived = true`, a `computed_by_ref` or `derived_rollup` yet: the GPEXE writer stores
    `is_derived = false` (`backend/src/gpexeImportWriter.js`);
  - phase 10's rule that an estimate never produces a derived metric (`docs/ai/phase10-estimates-decisions.md`,
    section 1).
- **Scope (a draft for the contract, not a decision):**
  - a canonical variable may carry a versioned formula over other canonical variables of the same owner scope: a
    sum, a difference, a quotient, a value per minute;
  - the value is computed at import or entry and stored as a derived value (`is_derived = true`, `computed_by_ref` =
    the formula version, `aggregation_role = 'derived_rollup'`), never as a source value;
  - it is computed again when a base value changes or a session is imported again (R1);
  - the formula is shown in the Variables tab, and versioned like the rest of a variable's semantics;
  - first targets, from the list of 2026-09-17: total Acc&Dec (acceleration and deceleration events),
    Burst&brakes, m/min, HMLD and EXPDist.
- **Open for the contract (owner decisions):**
  - phase 10 (section 1 of its decisions) already says that an estimate never produces a derived metric. Whether
    that also forbids a formula over estimated or manually entered base values, and how the provenance of such a
    value is shown, is for the owner;
  - the formulas of HMLD and EXPDist, and the units each formula needs (C97 for the base fields).
- **Gate:** a discovery and contract docs PR first, like PR #224. Then the implementation, with a migration for the
  formula versions and its database actor guards (C76).
- **Reviewers:** `db-reviewer`, `security-reviewer`, `code-reviewer`, and the external review of the *Rukovodilac* and
  the *Nezavisni revizor* (triggers 1, 2, 3 and 4).
- **Red zone:**
  - the contract's owner decisions;
  - the production preflight;
  - the merge (and so deploy and migration, by an order that names it);
  - the production post-check.
- **★★:** the owner approves the contract before any code and confirms the external review before the merge.
- **Start:** after phase 9 is merged, with the contract approved by the owner (★★).

### Phase 12 ★: domains and categories of canonical variables, after phase 4 and before phase 6 (may run in parallel with phase 5)
- **Owner, 2026-10-27** (in the *Rukovodilac*'s chat, owner turn `655fc5c6`, 14:11:48 UTC): „imam jedan mali
  potsetnik, nekada sam diskutovao u vezi toga. Trealo bi imati mogucnost da varijable povezemo sa kategorijama
  varijabli ili domenima, takvu arhitekturu mi vec imamo u bazi samo bi trebalo da razmišljamo da to imamo mogucnost
  da povezujemo. Zašto mislim da je to bitno, naime bitno je zato što ćemo sutra možda utreniranost definisati kao
  utrenirasnost izdržljivosti, brzine i sl, a to će biti kategorije ili domeni. Da li razumeš možda”
- **Who decided what:**
  - The owner's words establish the need: variables can be linked with categories or domains, on the structure the
    database already has, because fitness may later be defined per domain or category (endurance, speed and the like).
  - The place, the gate and the ★ below are the *Rukovodilac*'s proposal (its message `796c28bf`, 14:12:57 UTC).
  - The owner approves the place and the gate by approving the merge of the pull request that adds this phase
    (section 2).
- **Builds on:**
  - v10 (`migrations_v2/202609041400_training_load_v10_metrics_catalog.sql`):
    - `training_load.metric_domains` and `metric_categories`: a name, an owner scope (`system`, `club`, `team` or
      `user`) and `is_active`;
    - `metric_structure_links`: a domain, a category and / or a definition, an owner scope and
      `temporal_smoothing_enabled`, unique per owner and triple;
    - `link_scope_within_target`, which keeps a link's scope inside each target's;
  - the older API `/api/training-load/metrics` (`backend/src/routes/trainingLoadMetrics.js`):
    - `/domains` and `/categories` (GET, POST, `POST …/:id/archive`);
    - `/structure-links` (GET, POST, DELETE).

    C98 left creating them unchanged. Their archive and delete answer the identical 404 to a caller who may not manage
    the row;
  - R2 did not cover them (J3b.7 of the discovery document), and no M3-0 service reads or writes these tables: only
    the older API's access, catalog and measurement modules do (`backend/src/trainingLoadMetrics{Access,Catalog,
    Measurements}.js`). The new admin flow links no canonical variable with a domain or a category. Whether the older
    API wrote such rows on the production database was not checked.
- **Scope (a draft for the contract, not a decision):**
  - in the M3-0 admin API and the Variables tab, domains and categories owned by the system or a club: create,
    rename and archive;
  - linking a variable with categories, and a category with a domain (structure links);
  - showing them in the list and the detail, and filtering by domain or category;
  - when the new flow arrives, the older API's three routes get C98's rule for the canonical owners (`system` and
    `club`);
  - every new admin write gets its database actor guard (C76), so a migration;
  - a note for phase 11: a domain or a category as the basis of a derived "fitness per domain". That is decided in
    phase 11's contract.
- **Gate:** a discovery and contract docs PR first, then the implementation.
- **Reviewers:** `db-reviewer`, `security-reviewer`, `code-reviewer`, and the *Rukovodilac* (triggers 1 and 2). The
  Variables-tab part also gets `mobile-qa` and `ux-design-reviewer` (the matrix of `CLAUDE.md`). The *Nezavisni
  revizor* only if the contract introduces a new owner scope or right.
- **Red zone:**
  - the contract's owner decisions;
  - the migration, by an order that names it (with its production preflight, merge, deploy and post-check).
- **★, not ★★:** independent of the GPEXE import; it continues the work on the Variables tab.
- **Start:** after phase 4 is merged, with the contract's owner decisions.
- **The contract (12a), accepted on 2026-10-28:** `docs/ai/phase12-domains-categories-contract.md` (J6).
  - The *Rukovodilac* reviewed it and gave GO on the proposal at `5b9ee9d`.
  - The owner accepted O1–O9 as recommended (owner turns `bfb556e0` and `3d1bb779`, in the *Rukovodilac*'s chat), as
    the *Rukovodilac* reads them (C101 of the discovery document).
  - The owner's read-only count found no row in the three v10 tables.
- **12b Done, 2026-10-28.**
  - The implementation: PR #247 (migration v41, the routes C1–C5, the C6 filter and detail, the older API's O7
    refusal; J6 of the discovery document as built), on the *Rukovodilac*'s order of 2026-10-28.
  - Internal reviews:
    - `db-reviewer`, `security-reviewer` and `code-reviewer` reviewed `36cfb45`. None found a BLOCKER or HIGH. The one
      MEDIUM: a `TRUNCATE` of the links table ran no guard.
    - Their notes were applied at `840e873`: the truncate guard, the lock before v41's count, the rollback's
      key / description refusal, the owner in a create's request hash, `truncated` on the detail, `FOR NO KEY UPDATE`.
    - The narrow re-reviews of the delta answered READY (`db-reviewer`, `code-reviewer`).
  - The *Rukovodilac*'s review gave GO on `840e873` (its message queued at 14:31:52 UTC). It found no BLOCKER, HIGH or
    MEDIUM.
    - It confirmed the four choices the contract had left open: fail closed on every canonical row (so no "set the
      key once" act); the removed link's change row written by the BEFORE DELETE branch; the older API's link `409`
      before the target checks; the older reads returning `key` and `description`.
    - It recorded two LOW: the `409` of an index refusal carries no `current`; the older reads return
      `created_by_user_id` and `owner_club_id` (the follow-up with O8).
  - The owner's order: „Odobravam merge PR #247 sa migracijom v41” (owner turn `9d9e38b7`, 14:34:18 UTC, in the
    *Rukovodilac*'s chat). It names the PR and the migration.
  - The owner's read-only preflight of v41 came back as expected: „sve očekivani rezultati” (owner turn `00192af8`,
    14:35:11 UTC, in the *Rukovodilac*'s chat). The values were not pasted, and block 7's numbers were not recorded.
    The executor checked both quotes in the *Rukovodilac*'s transcript before the merge.
  - Merge: `9361fff` (parents `a07fdd1` and `840e873`), 14:36:08 UTC. The executor made it from exactly `840e873`,
    and its tree is identical to that head.
  - Deploy: started by the owner by hand (autodeploy was off).
  - Smoke (the *Rukovodilac*): `/api/health` served `9361fff` with `ok: true` three times in a row (from 14:38:53 UTC;
    `a07fdd1` until 14:38:32). Without a login these routes answered 401: the variable, mapping and field routes,
    `/classification`, the revisions route and the GPEXE status.
  - Post-check: the owner ran it and reported „sve je tako” (owner turn `0dcf68cc`, 14:39:44 UTC, in the
    *Rukovodilac*'s chat). The values were not pasted, so v41 is confirmed by the owner's statement.
  - Only PostgreSQL 16 was run by the executor and the reviewers; the owner's post-check ran on production's 17.6.
  - A proposed rule from the code review (a table guarded row by row also gets a `BEFORE TRUNCATE` guard,
    `.claude/rules/migrations.md`) went to the owner as optional. It is not decided, so it is not written.
  - Next is 12c, the frontend (J6 3.4), with no migration.
- **12c Done, 2026-10-28.**
  - PR #249: frontend only, no migration, on the classification API of 12b. As built: J6 and section H of the discovery
    document.
  - Reviews:
    - `code-reviewer`, `ux-design-reviewer` and `mobile-qa` on `41055a9`. The code review found two MEDIUM: a forged
      Remove or Place click opening a form; "Nothing was saved" on a `404`. The UX review found four MEDIUM: the filter's
      scope; dead ends; the removal wording; `key_taken` leading to a duplicate. `mobile-qa` found LOW and NIT only;
    - all were fixed at `66d9173`, with tests; the narrow re-reviews answered READY (code, UX).
  - Evidence:
    - 32 frontend tests and 11 mutations, all killed;
    - the executor's integration and browser QA on a disposable database migrated through v41, 71/71;
    - the *Rukovodilac*'s own browser integration, 29/29.

    Not checked on a physical device.
  - The *Rukovodilac*'s GO on `66d9173` (its message queued at 15:31:52 UTC), with no BLOCKER, HIGH or MEDIUM and two
    LOW:
    - the list filter also offers archived domains and categories, marked "(archived)"; separating active and archived
      in the picker's groups is a follow-up;
    - the tree places a category under its first category → domain link; O3's unique index allows no second one, so
      this is only a defence.
  - Merge: `3532bc5` (parents `30a3e6b` and `66d9173`), 15:32:22 UTC, made by the executor under the standing merge
    order from exactly `66d9173`.
  - Deploy: by the owner by hand, together with PR #248 („zajedno sa 12c“) and PR #250, as `ae29b08`.
  - Smoke (the *Rukovodilac*): `/api/health` served `ae29b08` with `ok: true` three times in a row (16:17:35, 16:17:56
    and 16:18:16 UTC; `9361fff` until 16:16:13). Without a login six protected routes answered 401, and `/api/auth/me`
    answered `{"user":null}`.
- **Phase 12 is done.** Its follow-ups are recorded in J6 (12c) and in `docs/ai/CURRENT_STATE.md`: the older reads'
  columns and O8, and 12c's LOW notes.

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
- Q10, `TEXT_FORBIDDEN` and `source_metric_text_ok`:
  - part A, the services and the frontend, is done (PR #229, `a1bb932`, no migration);
  - part B, the database twins `source_metric_text_ok` and `source_metric_unit_token_ok`, is done: its own migration,
    v40, merged and deployed with PR #241 (`290b6cf`, phase 4). The *Rukovodilac*'s R5 of 2026-10-27 replaced J3b.9's
    "no v40". The owner approved it with the phase 4 contract (O6, C100);
- the v35 / v36 test hardening;
- separate database roles;
- **Data configuration: visual polish of Variables, Domains & categories and Source fields** (scheduled by the owner on
  2026-10-28; see below);
- **a private coach's own source and own variables** (recorded on 2026-10-28, not scheduled; see "Sources and users"
  below).

**Data configuration: visual polish.** The owner's words, in the *Rukovodilac*'s chat, verbatim. The executor checked
each turn in the *Rukovodilac*'s transcript:
- owner turn `555ad88f`, 16:25:13 UTC: „Sta se sada desava i da li mozemo malo ovaj deo data conficugarion da sredimo
  vizuelno da bude prihvatljivije kasnije”;
- owner turn `675388a1`, 16:28:13 UTC: „Prvo svaka varijabla bi trebalo da ima neku ikonicu, možda bi trebalo da imamo i
  neku listu ili bazu ikonica koje mozemo izabrati ako je bi se mogle uklopiti u ovu nasu pricu. Osim toga bilo bi
  dobro da ovaj deo bude vizuelno sličan i interaktivan kao na našoj homes strani ili već nekako drugačije. Varijable
  bi se mogle prevlačiti u kategorije, posebno bi trebalo razdvojiti domene od kategorija i sl. Nisam baš najbolji za
  ovo ali par ideja nije na odmet”; and `d2ed6e07`, 16:28:32 UTC: „home strana trenera”;
- owner turn `18e6d722`, 16:33:49 UTC: „te ikonice mogu da stoje ngde u settingsu da ih imamo za različite potrebe posle
  da koristimo”;
- owner turn `3d4b9bac`, 16:34:13 UTC: „Inače varijable i domeni već u bazi imaju medij i kolonnu gde možemo da ubacimo
  te stvari”;
- owner turns `257366da`, 16:34:42 UTC: „Sopstvene takođe omogućiti da postoje”, and `4525f83f`, 16:34:55 UTC: „da može
  neko da ima”;
- owner turn `3b1894ff`, 16:35:49 UTC: „sve može kako ti je lakše. To sve može da se skladišti na R2 kao što skladišimo
  vežbe”;
- owner turn `0dbec26b`, 16:36:20 UTC: „mislim ako to ubacijumo kao privatno lice i ako je potrebno za to skladište”.

How the *Rukovodilac* reads them (its messages to the executor, 2026-10-28): the owner scheduled this task and approved
the order step 1, then step 2. Nothing else is approved by them: no migration, no contract and no variant. That reading
is the *Rukovodilac*'s.
- **First, a proposal** (a document only): `docs/ai/data-configuration-visual-proposal.md` and a static HTML mockup the
  owner can open in a browser, with no app code changed. It covers:
  - 2–3 layout variants in the visual language of the coach's Home, each at 1280 and 360 px;
  - a clear separation of domains from categories, with archived ones apart;
  - variable icons;
  - dragging variables into categories;
  - what changes where, the risks, and the test plan.

  It goes to the *Rukovodilac*, then to the owner to choose. Code comes only after the owner's word.
- **Step 1, no migration:**
  - a built-in icon library with an open licence, as a shared resource: `frontend/icon-library.js` (key, inline SVG,
    categories, search words);
  - a **Settings → Icons** gallery;
  - one shared icon picker. Variables use it through an optional `iconKey` in the M3-0 API, stored as `icon:<key>` in
    the existing `metric_definitions.icon_url` column (v10). The Settings taxonomy presets and the coach's Home share the
    library;
  - the visual pass over Variables, Domains & categories and Source fields.

  Then **PR-1** (the visual pass and the icons; frontend and a small backend part; `code-reviewer`,
  `ux-design-reviewer`, `mobile-qa`, and `security-reviewer` for the new input) and **PR-2** (dragging variables into
  categories on a computer, through the existing classification API and its rules; the picker stays the way on phones
  and by keyboard). Browser QA at 360 / 375 / 390 / 1280 px. Each merges under the standing order after the
  *Rukovodilac*'s GO.
- **Decided (2026-10-28, `docs/ai/data-configuration-visual-proposal.md` section 10):** the owner's V1–V5 as
  recommended (layout C, Tabler Icons, I1 as PR-1b, domain and category icons later, PNG first), as the *Rukovodilac*
  reads the owner's words; the *Rukovodilac*'s R1–R3.
  - **PR-1 is merged and deployed** (PR #256, `0e38ae9`, 2026-10-28; no migration; deployed with `d9a02ad8` on
    2026-10-29; the proposal's section 11 records it as built).
  - **PR-2 is done** (PR #263, merge commit `00b3958`, 2026-10-29 11:20:05 UTC; frontend only, no migration; the
    proposal's section 12 records it as built). The executor merged it under the standing merge order from exactly
    `54bbaaf`, after the *Rukovodilac*'s GO on that head (its message queued at 11:19:22 UTC), which followed a NO-GO on
    `8c7a0048` whose MEDIUM was fixed. It replaces PR #260, closed as superseded after PR #262 conflicted with it in
    `frontend/styles.css`. Deployed with `00b3958`. Its LOW follow-ups (LOW-2, LOW-4, a touch laptop or an iPad, more than
    100 variables) are recorded in that section, not scheduled.
  - **PR-1b is done** (I1, V3; PR #282, merge commit `46e0303`, 2026-10-30 13:42:52 UTC, with migration v45
    `migrations_v2/202610301200_training_load_v45_metric_variable_icon.sql`, sha256
    `e7a4d23dcd387b6f2e1474cc7b9026605d76504175e6e0ce691907c5d4bce400`): changing an existing variable's icon. Merged by
    the executor exactly from `8f8fac6` on the owner's order „Odobravam i naređujem merge PR #282 sa migracijom
    202610301200_training_load_v45_metric_variable_icon.sql, sha256
    e7a4d23dcd387b6f2e1474cc7b9026605d76504175e6e0ce691907c5d4bce400.” (owner turn `5475773b`, 13:41:24 UTC, in the
    *Rukovodilac*'s chat, checked in its transcript), after the GO of both reviewers and the owner's preflight (owner
    turn `68395f16`). Deployed with `d9383adb`; **v45 is directly confirmed** by the owner's post-check (owner turn
    `8a26c92c`). J3b.11 of the discovery document records it as built.
  - **PR-1c is done** (V4, C105 of the discovery document; PR #287, merge commit `70e9e2b`, 2026-10-30 15:16:15 UTC, with
    migration v46 `migrations_v2/202610301300_training_load_v46_classification_icons.sql`, sha256
    `b0390376d6ed2e01a4a1b216c120e29ce7d34d31d41e27fd313904b3cdef4e80`): icons of domains and categories. Merged by the
    executor exactly from `1c97379` on the owner's order „Odobravam i naređujem merge PR #287 sa migracijom
    202610301300_training_load_v46_classification_icons.sql, sha256
    b0390376d6ed2e01a4a1b216c120e29ce7d34d31d41e27fd313904b3cdef4e80.” (owner turn `30593475`, 14:24:30 UTC, checked the
    same way), after the GO of both reviewers and the owner's preflight (owner turn `be927574`). Deployed with
    `70e9e2b`; **v46 is directly confirmed** by the owner's post-check (owner turn `31b0b0c4`). J6.1 records it as built.
    The plan's V4 line above ("domain and category icons later") and "Not in step 1" below are C105's to change, in the
    plan pull request the owner names.
- **Not in step 1:** an icon on a domain or a category of variables. `metric_domains` and `metric_categories` have no
  icon column (v10, v41), so it needs a migration, which is an owner's option.
- **Step 2 ★★, scheduled by the owner: a club's or a person's own icons.**
  - Owners: `system` (a platform admin), `club` (a club admin; seen in that club only) and `user` (a private coach; seen
    by that user only).
  - PNG and SVG, the SVG sanitized, or PNG only if sanitizing cannot be proven; a size limit.
  - Stored on R2 through the exercise media infrastructure and its per-account quota (Settings → Storage, 0 B by
    default).
  - A new table, so a migration.
  - The identical 404 for another owner's icon.

  Its contract comes first (a document, to the *Rukovodilac*, the *Nezavisni revizor* and then the owner), and the
  migration only on the owner's order that names it.

**The owner's guidance for these screens** (2026-10-28, in the *Rukovodilac*'s chat, verbatim). The executor checked
each turn in the *Rukovodilac*'s transcript with `get_event`:
- owner turn `981ef233`, 23:24:21 UTC: „Neka ide kako si zamislio”. By the *Rukovodilac*'s account it answered the
  order the *Rukovodilac* had described: PR-1, then phase 5b (v42), then PR-2 (dragging), then the Mappings screen
  (phase 8). That context is the *Rukovodilac*'s. The order and the gates of the phases do not change;
- owner turn `d9a0b800`, 23:24:46 UTC: „Stim sto ovo mora biti mnogo jednostavnijeg za korisnika”. By the
  *Rukovodilac*'s account the owner had looked at the deployed Source fields screen in a club workspace and asked
  whether source fields could already be linked to canonical variables.

How the *Rukovodilac* reads it (its message queued at 23:25:14 UTC; its reading, not the owner's words):
1. In the visual pass, Source fields and Variables speak the coach's language, not an engineer's:
   - introductions of one sentence;
   - the evidence legend as a chip that explains itself on a tap;
   - technical keys, codes and ids only under Technical details;
   - one primary action per screen;
   - empty states that name the next step, for example "Confirm the unit first" with a link;
   - no abbreviations such as T2b, F3 or C97 in the screens' text.
2. The Mappings screen (phase 8) is a guided flow of three steps, with a suggestion where the units are the same.
   `ux-design-reviewer` gets the owner's sentence as an acceptance criterion (phase 8).
3. No API changes, and a mapping still needs a confirmed unit: the simplicity is in the guidance, not in fewer checks.

What of point 1 PR-1 already holds (checked against `0e38ae9`):

| Item | In PR-1 | Left for |
|---|---|---|
| One primary action per screen | Yes: the start screen's cards; Domains and Categories, each with one primary button | — |
| Empty states that name the next step | Partly: Domains and Categories name the step and link to it ("Create the first one with New domain", "Open Domains") | Source fields: with phase 8, when a field's next step is a mapping |
| No abbreviations such as T2b, F3 or C97 | Yes: none in these screens' text (only in code comments) | — |
| Introductions of one sentence | No: Source fields' has two sentences and names `docs/` | the language pass below (done) |
| The evidence legend as a chip that explains itself on a tap | No: PR-1 made it four badges, each followed by its meaning | the language pass below (done) |
| Keys, codes and ids only under Technical details | Variables, Domains and Categories: yes. Source fields: no, a field's key and codes stand in its detail line and its forms | the language pass below (done) |

**The language pass** is a small frontend pull request of its own, with or after PR-2, as the *Rukovodilac* orders. It
changes no API.
- **Done, 2026-10-29:** PR #261, merge commit `d29776f`, 11:17:54 UTC; frontend only, no migration. The executor merged
  it under the standing merge order from exactly `0141df9`, after the *Rukovodilac*'s GO on that head (its message
  queued at 11:11:20 UTC). The proposal's section 13 records it as built. Deployed with `00b3958`.

**Sources and users: the owner's word of 2026-10-28.** Owner turn `269910e0` in the *Rukovodilac*'s chat, received by
the server at 23:27:25 UTC; it reached the *Rukovodilac*'s conversation at 23:40:09 UTC (the time its own transcript
shows). The executor checked it in the transcript with
`get_event`: „Takodje mi u budućnosti možemo imati više sources. A različiti korisnici različite sources tako da ce
svako sebi to povezivati i praviti nove varijable izvedene varijable ako im to treba npr acc i dec total...”. The order of
the phases does not change.

How the *Rukovodilac* reads it (its message queued at 23:40:44 UTC; its reading), with the executor's check of the code
at `0e38ae9`:
- **More sources.** This is already the architecture, so nothing is new:
  - the Imports track is source-neutral, with one Source card per source;
  - a source field is identified by its source system, its API family and its source key (T2a, v34);
  - a mapping is activated per team binding (T5).
- **Different users with different sources, each linking their own.** Today:
  - a source connection belongs to a club and is managed by the club's admin or a platform admin (F3c2e).
    `backend/src/sourceConnectionService.js` writes `owner_scope = 'club'` only, although v27 also allows `team`;
  - the canonical-variable API writes system and club variables only: the owner comes from a platform or a club
    workspace. `metric_definitions.owner_scope` also allows `team` and `user` (v10);
  - so a private coach (the `private_coach` workspace) has no way to a connection or to variables of their own.

  Recorded as a future item, not scheduled and without a date: **a private coach's own source and own variables**
  (`owner_scope = 'user'`), on the pattern of ADR-002. The *Rukovodilac* reads it as ★★. The owner decides when it
  comes up.
- **Derived variables** (for example a total of accelerations and decelerations): phase 11 (section 5), under the
  decision of 2026-09-17 that a value OptiMove computes is never stored as a value the source delivered. The plan's gate
  stays "after phase 9" (M4); the *Rukovodilac*'s reading would also wait for M6.

PR #220 is not part of this plan. If it runs in parallel, it is merged in sequence with #218 (they share
`frontend/training-load-actions.js`), and the training-load actions tests are run again.
