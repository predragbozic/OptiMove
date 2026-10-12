# Agent efficiency and review discipline

How the main session spends context and usage: who does what, when reviewers run, how
far tests go, how a task is reported. This rule **optimizes the order and the extent of
the work only**. It does not remove any mandatory review trigger or the external review
of `CLAUDE.md`, does not allow skipping a relevant test, and does not change any
database, security, privacy or production gate. An explicit owner order always wins.

Where a topic already has an owner, this file points to it instead of repeating it:
reviewer choice and the Definition of Done — `CLAUDE.md` ("Orchestration matrica",
"External-review okidači", "Definition of done"); test evidence — `testing-evidence.md`;
the T1 commands — `docs/ai/test-infrastructure-discovery.md` §3.3; git — `git-safety.md`;
databases — `database-safety.md`; brain files — `memory-maintenance.md`.

## 1. The main session owns the task

- It reads the existing project documents, rules and the relevant code itself first.
- It does not hand a subagent work that one narrow read of its own would finish, and no
  subagent repeats a discovery an authoritative document already holds.
- A subagent gets a narrow task: the goal, the exact scope, the files it needs and the
  expected output — not the project's whole history. A reviewer still gets the full packet
  of the "Agent input contract" in `CLAUDE.md`.

## 2. When a subagent is justified

Only when at least one holds: two or more truly independent analyses can run in
parallel; a specialized reviewer is mandatory by a repo rule or a review trigger; the
task needs a separate DB, security, UX / mobile or concurrency review; an isolated test
or proof can be prepared without overlapping the main session's work.

Never for: retelling a report; checking one sentence or one simple diff; re-reading the
same documents; status polling; writing a PR description; a plain git status, diff or
test result; reviewing a domain the change did not touch.

## 3. Review runs on stable code

- No broad reviewer while the implementation is still moving. First finish the
  implementation and its targeted tests, then freeze the HEAD and send the complete
  packet.
- Run in parallel only the review domains that are mandatory and independent of each
  other, chosen by the orchestration matrix — never every reviewer "just in case".
- No database review without a DB, schema or transaction change; no security review for
  a purely visual change without an auth, identity, secret or info-hiding change; no UX /
  mobile review for a backend-only change.

## 4. Feedback loop

- The first review gets the whole relevant diff.
- After a fix, the reviewer gets the delta diff, its earlier finding and the proof of the
  fix — not the whole history again while the scope is unchanged.
- A change of wording in a document or of a test title needs only a narrow re-review of
  the matching domain. A new broad review is needed only when the fix changed
  architecture, authorization, schema, a transaction or a production contract.
- A reviewer does not re-check findings it already closed unless the new change touches
  them directly.

## 5. Limit the review rounds

- Plan at most one full review round and one narrow re-review per domain (the
  Definition of Done in `CLAUDE.md`).
- If a second re-review finds a new HIGH or MEDIUM that the last change did not cause,
  stop and first check whether the packet was incomplete or the scope too large. The
  severity contract of `CLAUDE.md` still applies: stopping is a check before another
  round, never a way to leave a BLOCKER or HIGH unfixed.
- No endless cycle of small commits and new full reviews.
- A LOW or NIT is applied only when it is safe, in scope and worth a new HEAD. An
  optional wording or style change that would itself need a new full review is recorded
  as a follow-up instead; no new commit after the final review for an optional NIT.

## 6. Test tiers (the T1 runner)

- During development: only the directly affected files
  (`node scripts/test-runner.mjs --project <backend|frontend> [--kind <kind>] --file <file>`).
- Before the first review: the targeted regression set of the touched module or family
  (`test:backend:fast`, `test:frontend:fast`, `test:gpexe`, or the module's files).
- Before merge-readiness: the preset that matches the real risk.
- `test:pr` (everything safe by construction; it leaves the `shared` kind out) only when a
  repo rule asks for it, the runner or a manifest changed, the change is broadly
  cross-cutting, or the owner orders it.
- A change to auth, organization, builder, the Tests module or non-GPEXE Training Load
  still needs `test:backend:shared` before a PR (§3.3 of the T1 document); running it
  writes to the local development database, which is a per-session decision
  (`database-safety.md`).
- Within the same session, do not re-run a green test on unchanged code. A result from an
  earlier session is not evidence (`testing-evidence.md`): re-run it before claiming it.
  When only a document, a comment or a test title changed after a run, re-run the affected
  test, or the document check if one exists for that file (none exists for `.claude/`
  today), not unrelated suites, and say in the report which result is from before and
  which from after the last change.
- Mutations: for new security, transactional and fail-closed guards, not for every
  trivial sentence or CSS change; after a small change re-run only the affected
  mutations, unless a shared mechanism changed.

## 7. Discovery and project memory

- Before a new discovery, check the authoritative document and its
  `Last verified against commit` (the pattern of `metrics-core-mapping.md`).
- If the relevant files did not change, use the existing discovery; if they did, check
  only the delta since that commit.
- Write a new result into the existing authoritative document, not into a parallel one
  (`memory-maintenance.md`). Code and migrations win over documents.

## 8. Git and PR

- One worktree and one branch per task (owner order of 2026-10-12; branching from
  `origin/main` and the ban on a force push without an explicit order are `git-safety.md`).
- Before a merge: the exact HEAD, the base, the diff scope and a clean tree.
- If `main` moved, first decide whether it changed a relevant contract; an integration
  merge without a conflict and without a relevant change needs only a targeted check, not
  every check again.

## 9. Reporting

The final report is short and holds: the outcome; HEAD and base; the changed files; the
test results; the review findings; the remaining risks and owner decisions; the exact
next step. It does not retell every tool call, wait, grep or internal attempt, does not
repeat one fact in several sections, and no status message is sent without a new
decision or result.

## 10. Stop and ask

Stop and ask the owner when the task would widen its scope; a production write is
needed; a new owner decision is needed; `main` has a relevant conflict; a review finds a
BLOCKER or HIGH that is not a plain fix inside the task; a persistent database, a
credential, a Render change, a real GPEXE request or the import switch would be needed;
or a cleanup might remove an artifact this session did not create.
