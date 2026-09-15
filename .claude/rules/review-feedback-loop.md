# Review feedback loop

How a review finding becomes a permanent rule — this file governs the main session's
own behavior after a reviewer reports back, not the reviewer's own output format (that
lives in `.claude/agents/code-reviewer.md`, which proposes a **candidate** learning rule
per finding, always as text for the main session to act on — never something it writes
to disk itself).

## The core rule

Only a **confirmed and repeatable** oversight becomes a permanent rule. "Confirmed" means
the main session independently verified the finding is real (not just trusted the
reviewer's claim). "Repeatable" means it's a class of mistake that could plausibly
recur elsewhere in the codebase — not a one-off typo or a mistake specific to exactly
one line that will never be touched the same way again.

A reviewer's own candidate-rule text is a proposal, not a decision. The main session
decides whether it actually clears this bar — see `.claude/rules/memory-maintenance.md`
for the parallel rule that review agents never write memory/rules themselves; this file
is the process the *main session* follows when it does.

## Where a new rule goes

- The **narrowest relevant existing rules file** — `frontend.md` for a frontend-only
  class of mistake, `backend-security.md` for an authz/response-contract one,
  `migrations.md` for a schema/lock-order one, and so on. Don't invent a new rules file
  for one rule when an existing one already owns that topic.
- If no existing file fits, that's a signal to ask whether this is really a repeatable
  class of mistake worth a standing rule, before creating a new file for it.

## What a new rule needs before it's added

- **A regression test, or another executable proof, that actually exercises it.** A rule
  with no test backing it is a sentence nobody will notice breaking. If the finding that
  produced the rule already came with a fail-fast test (the reviewer's contract requires
  one), that test — or an equivalent one in the real test suite — is the proof; link or
  describe it in the rule text.
- **At most 1–2 new rules per corrective finding.** A single finding does not justify a
  paragraph of new policy. If a finding suggests more than two rules are needed, that's
  a sign the finding itself is really several distinct issues — split it, don't bundle
  an oversized rule addition under one finding.

## Keeping the rule set itself healthy

- **Merge duplicates.** Before adding a new rule, check whether an existing rule in the
  target file already says the same thing (even in different words) — extend/clarify the
  existing one instead of adding a near-duplicate next to it.
- **Remove stale rules.** A rule that no longer applies (the code pattern it guarded
  against was refactored away entirely, the contract it enforced was deliberately
  superseded — see `docs/decisions/` for architecture-level supersession) gets removed,
  not left to rot alongside rules that still matter. Removing a rule is itself a main-session
  decision with a reason, same bar as adding one.
- **A one-off bug stays in its test, never becomes a global rule.** If a finding isn't a
  repeatable class of mistake, the correct outcome is exactly what
  `.claude/agents/code-reviewer.md`'s candidate-rule format says for that case: `Ne
  dodavati trajno pravilo — dovoljan je regresioni test.` A regression test for that one
  spot is sufficient; don't manufacture a rule to justify writing one.

## What this explicitly prevents

An agent — reviewer or otherwise — adopting its own unconfirmed conclusion as permanent
memory. A candidate rule is exactly that: a candidate. It becomes a rule only after the
main session has independently verified the finding, confirmed it's a repeatable class
(not a one-off), placed it in the narrowest correct file, and attached real executable
proof — the same discipline `memory-maintenance.md` requires for every other kind of
memory write in this project.
